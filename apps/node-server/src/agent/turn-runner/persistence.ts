/**
 * 一轮的**落盘**（docs/agent/single-ledger/tech.md §5 单-3 的「写入时序」）——本目录里
 * 唯一写 `conversation_events` / `conversations` 的地方。
 *
 * 两段职责，对应一轮的两个时刻：
 *
 * 1. **过程中**（`createTurnEmitter`）：每个[耐久](../../../../../docs/terms.md)chunk、以及
 *    那条起轮合成的用户消息，一到就拿一个 `seq` 落一行（`kind = 'chunk'`/`'message'`），
 *    然后才交给订阅者——先落盘后广播，断线重连才补得回来。
 * 2. **收尾时**（`finalizeTurnPersistence`）：这一轮新追加的 `NimboUIMessage` 补成
 *    `kind = 'message'` 行，再把本轮那些已被取代的 `kind = 'chunk'` 行删掉。
 */
import type { EventEmitter } from 'node:events';

import type { NimboChunk, NimboUIMessage, SessionState } from '@nimbo/core';

import type { Logger } from '../../logger.js';
import type { ChunkEnvelope, MessageFrame } from '../../schemas/chat.js';
import type { Db } from '../store.js';
import {
  appendConversationEvent,
  deleteChunkEventsAfter,
  getMaxEventSeq,
  updateConversation,
} from '../store.js';
import { LOG_SCOPE } from './log.js';

/**
 * One turn's persist-then-broadcast surface (see `createTurnEmitter`) —
 * threaded through `driveTurn` only; the 审批/ask-user bridges
 * (`human-bridge.ts`) no longer touch this at all (see `index.ts`'s header).
 * `emitMessage` and `emitChunk` share one underlying monotonic `seq` counter
 * (`createTurnEmitter`'s own closure) — `driveTurn` calls `emitMessage`
 * exactly once, for the turn-start synthesized user message, strictly before
 * it ever calls `emitChunk` for that same turn, so the message frame always
 * lands at the lowest `seq` in the turn's range.
 */
export interface TurnEmitter {
  emitMessage: (message: NimboUIMessage) => void;
  emitChunk: (chunk: NimboChunk) => void;
}

/**
 * docs/agent/single-ledger/tech.md §5 单-3's durable/ephemeral split
 * (P13-1's "过程帧只直播不落盘" carried over verbatim onto the new chunk
 * vocabulary): `text-delta`/`reasoning-delta` (the actual streamed
 * increments) and any chunk explicitly marked `transient: true` (today just
 * `data-tool-progress`, `@nimbo/core`'s `loop.ts`) are ephemeral —
 * broadcast-only, never persisted, never consume a `seq`. Every other chunk
 * `@nimbo/core`'s loop can produce — tool state (incl.
 * `tool-approval-request`/`tool-approval-response`), non-transient data
 * parts, step markers, message `start`/`finish`/`message-metadata` — is
 * durable.
 *
 * Written as a blanket "everything but these three is durable" rule (rather
 * than an explicit allowlist of durable types) so it stays correct for any
 * chunk type `@nimbo/core` might start producing later without this file
 * needing to grow a matching case for it.
 */
function isDurableChunk(chunk: NimboChunk): boolean {
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
    return false;
  }
  return !('transient' in chunk && chunk.transient === true);
}

/**
 * The turn's one seq-counting, persist-then-broadcast closure — used by
 * `start.ts`'s `startTurn` (hung off the turn's `emitter`) and by
 * `reservation.ts`'s `releaseTurn` (the 装配窗口内被停止那条补收尾路径).
 * `startSeq` is `getMaxEventSeq(db, conversationId)` taken once,
 * synchronously, at `startTurn`-time — the same reading
 * `finalizeTurnPersistence`'s GC threshold (`turnStartSeq`) uses, so the two
 * agree on exactly which `seq` range belongs to this turn
 * (docs/agent/single-ledger/tech.md §5 单-3).
 *
 * `emitMessage` (the turn-start synthesized user message, `driveTurn` calls
 * it exactly once, first) and `emitChunk` (every subsequent `NimboChunk`)
 * share the same `seq` closure — durable frames of either kind consume the
 * next `seq`; ephemeral chunks (`isDurableChunk` false) skip both `seq += 1`
 * and `appendConversationEvent` entirely — straight broadcast, envelope carries no
 * `seq` at all (see `schemas/chat.ts`'s `chunkEnvelopeSchema` doc comment).
 * This is the load-bearing invariant `finalizeTurnPersistence`'s GC leans on:
 * because ephemeral chunks never consume a seq number, every `seq` strictly
 * greater than `startSeq` by the time the turn finishes is either a durable
 * frame (message or chunk) row from *this* turn or (after
 * `finalizeTurnPersistence` appends them) a `kind = 'message'` row from this
 * same turn — nothing else could have landed in that range (a session only
 * ever has one turn driving it, see `startTurn`'s `activeTurns.has` guard).
 */
export function createTurnEmitter(
  db: Db,
  conversationId: string,
  emitter: EventEmitter,
  startSeq: number,
): TurnEmitter {
  let seq = startSeq;
  return {
    emitMessage(message: NimboUIMessage): void {
      seq += 1;
      appendConversationEvent(db, {
        conversationId,
        seq,
        kind: 'message',
        payloadJson: JSON.stringify(message),
      });
      const frame: MessageFrame = { seq, message };
      emitter.emit('event', frame);
    },
    emitChunk(chunk: NimboChunk): void {
      if (!isDurableChunk(chunk)) {
        emitter.emit('event', { chunk } satisfies ChunkEnvelope);
        return;
      }
      seq += 1;
      appendConversationEvent(db, {
        conversationId,
        seq,
        kind: 'chunk',
        payloadJson: JSON.stringify(chunk),
      });
      const envelope: ChunkEnvelope = { seq, chunk };
      emitter.emit('event', envelope);
    },
  };
}

/**
 * Turn-finalization persistence (docs/agent/single-ledger/tech.md §5 单-3's "写入时序", called from
 * `driveTurn`'s graceful-finish path only — never from the `catch` branch,
 * see its own comment): slices out this turn's newly-appended messages
 * *past its own turn-start user message* (`state.messages` past
 * `priorMessageCount + 1` — `priorMessageCount` is where `@nimbo/core`'s own
 * turn-start user `NimboUIMessage` landed, `session.ts`'s `stream()` pushing
 * it synchronously before ever yielding anything; `driveTurn` already
 * persisted+broadcast a structurally-identical (different `id`) copy of that
 * exact message *before* it started consuming the stream at all — see that
 * function's own comment — so this function must not persist core's copy a
 * second time under a second id), appends one `kind = 'message'` row per
 * *remaining* message (assistant step messages, plus any steer-injected user
 * messages `loop.ts`'s `drainSteerMessages` spliced in mid-turn — those
 * already reached the wire live via their own chunk sequence and are
 * persisted here exactly as before, untouched by the `+ 1`) — byte-for-byte
 * what `Session.toJSON()` produced for them (the "message 条目必须与
 * `session.toJSON().messages` 字节一致" invariant, now scoped to everything
 * after the turn-start user message), GCs this turn's now-superseded
 * `kind = 'chunk'` rows (`store.ts`'s `deleteChunkEventsAfter`), and updates
 * `conversations`'s scalar header + activity bookkeeping. Order matters:
 * messages are appended *before* the GC delete — a crash between the two
 * just leaves some not-yet-GC'd chunk rows around (harmless, extra data),
 * whereas the reverse order could lose this turn's content entirely if a
 * crash landed between them.
 */
export function finalizeTurnPersistence(
  db: Db,
  conversationId: string,
  state: SessionState,
  priorMessageCount: number,
  turnStartSeq: number,
  log: Logger,
): void {
  const newMessages = state.messages.slice(priorMessageCount + 1);
  let seq = getMaxEventSeq(db, conversationId);
  for (const message of newMessages) {
    seq += 1;
    appendConversationEvent(db, {
      conversationId,
      seq,
      kind: 'message',
      payloadJson: JSON.stringify(message),
    });
  }
  deleteChunkEventsAfter(db, conversationId, turnStartSeq);
  updateConversation(db, conversationId, {
    status: 'active',
    lastActiveAt: new Date(),
    agentSessionHeader: {
      conversationId: state.id,
      createdAt: new Date(state.createdAt),
      turn: state.turn,
    },
  });
  log.debug(LOG_SCOPE, 'turn persistence finalized', {
    conversationId,
    messageCount: newMessages.length,
  });
}
