/**
 * Turn execution/connection decoupling (docs/tech/chat-webapp.md §2.2b,
 * the P12-4 fix for "SSE 断开后进行中 turn 的后续输出不再到达页面"): a chat
 * turn is driven entirely in-process, independent of any HTTP request —
 * `POST .../messages` (`routes/chat.ts`) only *starts* it (`startTurn`),
 * `GET .../stream` only *observes* it (`subscribeTurn`/`isTurnActive`). A
 * client disconnecting (page refresh, HMR, network blip) never interrupts
 * the turn: every *durable* chunk (docs/tech/single-ledger.md §5
 * 单-3's durable/ephemeral split, `isDurableChunk` below) is persisted
 * (`conversation_events`, monotonic `seq`) before it's ever handed to a subscriber,
 * so a fresh `GET .../stream?after=<seq>` on reconnect replays whatever was
 * missed and then keeps forwarding live chunks until the turn ends.
 *
 * `TurnDrivenSession` is the one seam onto `@nimbo/sdk`'s `Session` — the
 * same "structural interface, not the concrete class" discipline as
 * `sandbox-manager.ts`'s `SandboxClient` — so `startTurn` can be driven by a
 * fake `stream()`/`toJSON()` pair in tests, no real model/sandbox involved
 * (see test/agent/turn-runner.test.ts).
 *
 * Process-restart caveat (docs/tech/chat-webapp.md §2.2b "边界"): `activeTurns` is in-memory
 * only — a server restart mid-turn silently drops it (the sandbox may still
 * be running, but nothing drives `session.stream()` forward anymore). Rows
 * already persisted stay put; the next `GET .../stream` finds no active
 * turn and just replays up to the crash point (docs/tech/single-ledger.md §5 单-3: this turn's
 * `kind = 'chunk'` rows never got GC'd, since `finalizeTurnPersistence`
 * never ran — accepted residue, see schema.ts's own doc comment). This is
 * v1's documented trade-off, not a bug to fix here.
 *
 * ---- UIMessage 单账本 migration (docs/tech/single-ledger.md §5 单-3, P13-5-3) ----
 *
 * This module used to speak `@nimbo/core`'s retired `SessionEvent` union and
 * maintain a handful of server-invented wire-only sentinels/events on top of
 * it (`user.message`, `turn.result`/`turn.failed`, `approval.requested`/
 * `approval.resolved`, `question.asked`/`question.answered` — see
 * `schemas/chat.ts`'s file header for the full retirement list). It now
 * speaks `NimboChunk` (ai's `UIMessageChunk` vocabulary) directly, one-to-one
 * with what `session.stream()` yields, plus exactly one synthetic
 * `message-metadata` chunk for the genuinely-unexpected-throw case (see
 * `driveTurn`'s `catch` branch) and exactly one synthetic `MessageFrame` per
 * turn — the turn-start user message (see `driveTurn`'s own comment; this is
 * this ticket's fix for docs/tech/single-ledger.md §5 引言's "用户消息乱序/叠在一起" bug, closing
 * the gap `schemas/chat.ts`'s file header used to describe) — no other
 * server-invented wire shapes left.
 *
 * Two responsibilities that used to be entangled in "persist + broadcast +
 * emit a bridge event" are now separate:
 *
 * 1. **Persistence** (`createTurnEmitter`/`finalizeTurnPersistence`): every
 *    durable chunk, plus the turn-start user message, gets a `seq` and a row
 *    (`kind = 'chunk'`/`'message'` respectively) as it arrives; once the turn
 *    finishes gracefully, its remaining newly-appended `NimboUIMessage`s
 *    (assistant steps, steer-injected user messages) get `kind = 'message'`
 *    rows too and the turn's now-superseded `kind = 'chunk'` rows are deleted
 *    (`store.ts`'s `deleteChunkEventsAfter`) — docs/tech/single-ledger.md §5 单-3's "写入时序".
 * 2. **审批/ask-user bridges** (`requestReview`/`resolveReview`,
 *    `requestUserAnswer`/`resolveUserAnswer`): pure in-memory promise
 *    routing now, with **no `emit` calls at all**. Visibility of a
 *    pending approval is `@nimbo/core`'s own `tool-approval-request` chunk
 *    (docs/tech/single-ledger.md §6.1 — the loop yields it *before* `await`ing `onReview`, so
 *    it's already on the wire the instant a human's needed); visibility of
 *    its resolution is the matching `tool-approval-response` chunk the loop
 *    yields once `onReview` resolves. Both flow through `session.stream()`
 *    like any other chunk — this module doesn't need to (and must not)
 *    re-announce them. Same story for `ask-user`: its pending/answered state
 *    is just the `tool-ask-user` part's own `input-available`/
 *    `output-available` states, a normal tool call as far as the loop is
 *    concerned.
 */
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import type {
  HumanDecision,
  JsonValue,
  NimboChunk,
  NimboMessageMetadata,
  NimboUIMessage,
  SessionState,
  TurnResult,
} from '@nimbo/core';

import type { LogFields, Logger } from '../logger.js';
import { logger as defaultLogger, truncate } from '../logger.js';
import type {
  ChatReplayFrame,
  ChunkEnvelope,
  MessageFrame,
} from '../schemas/chat.js';
import { grantSessionApproval } from './session-grants.js';
import type { Db } from './store.js';
import {
  appendConversationEvent,
  deleteChunkEventsAfter,
  getMaxEventSeq,
  updateConversation,
} from './store.js';

/**
 * 本文件所有日志的固定 scope（打点覆盖设计定案：turn/step/tool
 * call 级别可观测性）——纯旁路 tap，不改变 chunk 流转/持久化行为，见下方
 * `driveTurn`/`finalizeTurnPersistence`。
 */
const LOG_SCOPE = 'turn-runner';

/** `driveTurn` 记 `turn 开始` 时 `text` 预览的字符数上限。 */
const TEXT_PREVIEW_LENGTH = 120;

/** `tool-input-available` 记 `input` 预览的字符数上限。 */
const TOOL_INPUT_PREVIEW_LENGTH = 200;

/**
 * 工具 `input`/`output` 在 ai 的 `UIMessageChunk` 词汇表里就是 `unknown`
 * （`@nimbo/core`'s `state.ts` 头注释记录过的同一个"受控例外"——nimbo 的
 * 工具集编译期完全动态，没有字面量联合可收窄）；这里只把它安全转成一行
 * 预览文本，不假设其具体形状。
 */
function previewUnknown(value: unknown, maxLength: number): string {
  if (typeof value === 'string') return truncate(value, maxLength);
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return truncate(json, maxLength);
  } catch {
    // 循环引用/不可序列化——退化到 String()。
  }
  return truncate(String(value), maxLength);
}

/** `tool-output-available` 的"输出大小"——JSON 序列化后的字符数，量级足够日志判断用途，不追求精确字节数。 */
function measureOutputSize(value: unknown): number {
  if (typeof value === 'string') return value.length;
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json.length;
  } catch {
    // 循环引用/不可序列化——退化到 String()。
  }
  return String(value).length;
}

/**
 * 一次工具调用的结算日志，攒到对应的 `data-tool-timing`（`completedAt`）
 * chunk 抵达才真正落一行——耗时必须从这个 chunk 读（"保持单一来源"：
 * `@nimbo/core`'s loop 是唯一产出起止时间戳的地方，见工单设计定案），
 * 不能自己在这里另打一份 `Date.now()` 时钟去凑耗时。
 */
interface PendingToolSettlement {
  level: 'info' | 'warn';
  message: string;
  fields: LogFields;
}

/**
 * The one thing `startTurn` needs from a `@nimbo/sdk` `Session<F>` — deliberately
 * narrower than the real type (no `id`/`fs`/`send`/etc.) so tests can hand in a
 * bare fake instead of assembling a real session.
 *
 * `steer` is **optional** here even though every real `@nimbo/sdk` `Session`
 * always has one (STEER-1) — narrowed the same way `stream`/`toJSON` already
 * are, so a test fake that only cares about the base turn-driving contract
 * (`test/helpers/controllable-session.ts`) doesn't also have to implement
 * steering just to satisfy this interface. `steerTurn` below treats a missing
 * `steer` as "this session can't be steered", i.e. `false` — never a runtime
 * error — via `ActiveTurn.steer`'s capture in `startTurn`.
 */
export interface TurnDrivenSession {
  stream(input: string): AsyncGenerator<NimboChunk, TurnResult>;
  toJSON(): SessionState;
  steer?(input: string): boolean;
}

/**
 * One turn's persist-then-broadcast surface (see `createTurnEmitter`) —
 * threaded through `driveTurn` only; the 审批/ask-user bridges below no
 * longer touch this at all (see file header). `emitMessage` and `emitChunk`
 * share one underlying monotonic `seq` counter (`createTurnEmitter`'s own
 * closure) — `driveTurn` calls `emitMessage` exactly once, for the turn-start
 * synthesized user message, strictly before it ever calls `emitChunk` for
 * that same turn, so the message frame always lands at the lowest `seq` in
 * the turn's range.
 */
interface TurnEmitter {
  emitMessage: (message: NimboUIMessage) => void;
  emitChunk: (chunk: NimboChunk) => void;
}

/**
 * docs/tech/single-ledger.md §5 单-3's durable/ephemeral split
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
 * One pending `requestReview`/`requestUserAnswer` call, parked until
 * `resolveReview`/`resolveUserAnswer` (a human decision/answer, or the
 * timeout) settles it — the one piece genuinely identical between the two
 * bridges, see `takePending`.
 */
interface PendingEntry<T> {
  resolve: (value: T) => void;
  timer: NodeJS.Timeout;
}

/**
 * A pending review carries the call's `toolName`/`input` alongside the usual
 * resolve/timer — so `resolveReview` can record a 会话级授权 (`session-grants.ts`)
 * for *this exact call* when the human picks 「会话内都允许」, without the route
 * (which only knows `callId`) having to look the tool call up itself.
 */
interface ReviewPendingEntry extends PendingEntry<HumanDecision> {
  toolName: string;
  input: JsonValue;
}

/** The outcome of one `ask-user` call (docs/tech/chat-webapp.md §2.2c（审批链）) — `'timeout'` never carries an `answer`, same as `HumanDecision`'s `deny` branch not requiring a `message`. */
export type AskUserOutcome =
  { outcome: 'answered'; answer: string } | { outcome: 'timeout' };

interface ActiveTurn {
  emitter: EventEmitter;
  done: boolean;
  /** Bound to this turn's own `session.steer` at registration time (STEER-3B) — see `steerTurn`. */
  steer: (input: string) => boolean;
  emit: TurnEmitter;
  /** Keyed by `callId` (`@nimbo/core`'s `ApprovalContext.callId`, docs/tech/single-ledger.md §6.4) — see `requestReview`/`resolveReview`. Carries `toolName`/`input` (`ReviewPendingEntry`) so `resolveReview` can grant a 会话级授权 for the exact call. */
  pendingReviews: Map<string, ReviewPendingEntry>;
  /** Keyed by `callId` (docs/tech/chat-webapp.md §2.2c（审批链）) — see `requestUserAnswer`/`resolveUserAnswer`. Independent of `pendingReviews`: same shape, different `Map`. */
  pendingQuestions: Map<string, PendingEntry<AskUserOutcome>>;
}

const activeTurns = new Map<string, ActiveTurn>();

export function isTurnActive(conversationId: string): boolean {
  return activeTurns.has(conversationId);
}

/**
 * `POST .../messages` (routes/chat.ts) calls this first: if `conversationId` has
 * a turn in progress, forward `text` into it via the session's own
 * `steer()` instead of starting a new turn — returns whatever `steer()`
 * reported (`true` = queued, injected at the next step checkpoint;
 * `false` = the turn's `steer` doesn't support it, or (rare race) the turn
 * finished between this call landing and `steer()` checking its own
 * in-flight state). No active turn at all also returns `false`. Either way,
 * a `false` here is the route's cue to fall back to `startTurn` instead.
 */
export function steerTurn(conversationId: string, text: string): boolean {
  const activeTurn = activeTurns.get(conversationId);
  if (activeTurn === undefined) return false;
  return activeTurn.steer(text);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The turn's one seq-counting, persist-then-broadcast closure — lifted out
 * of `driveTurn` so `startTurn` can hang it off `ActiveTurn.emit`. `startSeq`
 * is `getMaxEventSeq(db, conversationId)` taken once, synchronously, at
 * `startTurn`-time — the same reading `finalizeTurnPersistence`'s GC
 * threshold (`turnStartSeq`) uses, so the two agree on exactly which `seq`
 * range belongs to this turn (docs/tech/single-ledger.md §5 单-3).
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
function createTurnEmitter(
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
 * Turn-finalization persistence (docs/tech/single-ledger.md §5 单-3's "写入时序", called from
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
function finalizeTurnPersistence(
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

/** Best-effort `turn` number for the synthetic failure chunk `driveTurn`'s `catch` branch emits — `session.toJSON()` itself throwing (defensive; not expected) just means "unknown", not a second unhandled throw. */
function bestEffortTurn(session: TurnDrivenSession): number | undefined {
  try {
    return session.toJSON().turn;
  } catch {
    return undefined;
  }
}

/**
 * Chunk-level log tap — called once per chunk `driveTurn`'s while loop
 * consumes, strictly *before* `emit.emitChunk` (read-only, never mutates or
 * withholds a chunk — see file header "纯旁路 tap"). Mutates the three maps
 * threaded in from `driveTurn`'s own locals: `pendingApprovalRequests`
 * (`approvalId` → the `Date.now()` this tap observed the request) and
 * `pendingSettlements` (`toolCallId` → the not-yet-logged settlement line,
 * parked until its `data-tool-timing` `completedAt` update arrives — "保持
 * 单一来源": duration is always read off that chunk, never a second
 * `Date.now()` pair kept here) — both are `driveTurn`-local, one turn each,
 * so nothing survives across turns to leak. Returns the possibly-bumped step
 * counter (`start-step`/`finish-step` share one running count) since a
 * plain number can't be mutated through a reference the way the two `Map`s
 * are.
 */
function logChunk(
  log: Logger,
  conversationId: string,
  chunk: NimboChunk,
  stepIndex: number,
  pendingApprovalRequests: Map<string, number>,
  pendingSettlements: Map<string, PendingToolSettlement>,
): number {
  switch (chunk.type) {
    case 'start-step': {
      const next = stepIndex + 1;
      log.info(LOG_SCOPE, 'step started', { conversationId, step: next });
      return next;
    }
    case 'finish-step': {
      log.info(LOG_SCOPE, 'step finished', { conversationId, step: stepIndex });
      return stepIndex;
    }
    case 'tool-input-available': {
      log.info(LOG_SCOPE, 'tool call started', {
        conversationId,
        toolName: chunk.toolName,
        callId: chunk.toolCallId,
        input: previewUnknown(chunk.input, TOOL_INPUT_PREVIEW_LENGTH),
      });
      return stepIndex;
    }
    case 'tool-output-available': {
      pendingSettlements.set(chunk.toolCallId, {
        level: 'info',
        message: 'tool call completed',
        fields: {
          conversationId,
          callId: chunk.toolCallId,
          outputSize: measureOutputSize(chunk.output),
        },
      });
      return stepIndex;
    }
    case 'tool-output-error': {
      pendingSettlements.set(chunk.toolCallId, {
        level: 'warn',
        message: 'tool call errored',
        fields: {
          conversationId,
          callId: chunk.toolCallId,
          errorText: chunk.errorText,
        },
      });
      return stepIndex;
    }
    case 'tool-output-denied': {
      pendingSettlements.set(chunk.toolCallId, {
        level: 'warn',
        message: 'tool call denied',
        fields: { conversationId, callId: chunk.toolCallId },
      });
      return stepIndex;
    }
    case 'tool-approval-request': {
      pendingApprovalRequests.set(chunk.approvalId, Date.now());
      log.info(LOG_SCOPE, 'tool approval requested', {
        conversationId,
        approvalId: chunk.approvalId,
        callId: chunk.toolCallId,
        automatic: chunk.isAutomatic,
      });
      return stepIndex;
    }
    case 'tool-approval-response': {
      const requestedAt = pendingApprovalRequests.get(chunk.approvalId);
      pendingApprovalRequests.delete(chunk.approvalId);
      log.info(LOG_SCOPE, 'tool approval resolved', {
        conversationId,
        approvalId: chunk.approvalId,
        approved: chunk.approved,
        waitMs:
          requestedAt === undefined ? undefined : Date.now() - requestedAt,
      });
      return stepIndex;
    }
    case 'data-tool-timing': {
      // 同一调用最多三次更新（`@nimbo/core` 的 startToolTiming /
      // markToolExecutionStart / completeToolTiming，三段生命周期见 state.ts）：
      // 纯 `startedAt` 那次早由上面的 `tool-input-available` 分支记过"tool call
      // started"，跳过；补上 `executionStartedAt` 那次记一行 debug（排队/审批
      // 结束、真正开始执行——queueMs 即等了多久）；补上 `completedAt` 那次放出
      // 攒着的结算行，durationMs 是**真实执行耗时**（2026-07-16 定案），排队
      // 等待落在 queueMs 里，两者相加才是用户在界面上看到的全程等待。
      const { toolCallId, startedAt, executionStartedAt, completedAt } =
        chunk.data;
      if (completedAt === undefined) {
        if (executionStartedAt !== undefined) {
          log.debug(LOG_SCOPE, 'tool call executing', {
            conversationId,
            callId: toolCallId,
            queueMs: executionStartedAt - startedAt,
          });
        }
        return stepIndex;
      }
      const pending = pendingSettlements.get(toolCallId);
      pendingSettlements.delete(toolCallId);
      if (pending !== undefined) {
        log[pending.level](LOG_SCOPE, pending.message, {
          ...pending.fields,
          // deny 路径从未执行（恒无 executionStartedAt）——此时全程只有
          // 排队/审批等待，durationMs 退化为全程时长，queueMs 缺席。
          durationMs: completedAt - (executionStartedAt ?? startedAt),
          ...(executionStartedAt !== undefined ?
            { queueMs: executionStartedAt - startedAt }
          : {}),
        });
      }
      return stepIndex;
    }
    default:
      return stepIndex;
  }
}

async function driveTurn(
  db: Db,
  conversationId: string,
  session: TurnDrivenSession,
  text: string,
  priorMessageCount: number,
  turnStartSeq: number,
  emit: TurnEmitter,
  log: Logger,
): Promise<void> {
  const turnStartedAt = Date.now();
  log.info(LOG_SCOPE, 'turn started', {
    conversationId,
    text: truncate(text, TEXT_PREVIEW_LENGTH),
  });

  try {
    // The turn-start user message (this ticket's fix — see `schemas/chat.ts`'s
    // file header): synthesized and put on the wire *before* this function
    // ever starts consuming `session.stream()`, so it always arrives ahead
    // of anything else this turn produces — chat input is always plain text
    // (`routes/chat.ts`'s `PostChatMessageInputSchema`), hence the single
    // `text` part. `@nimbo/core`'s own `Session.stream()` separately pushes a
    // structurally-identical copy (different `id`) onto its internal ledger
    // the moment it actually starts running (`session.ts`'s own `stream()`)
    // — `finalizeTurnPersistence` below knows to skip over that copy so it's
    // never persisted twice.
    const userMessage: NimboUIMessage = {
      id: randomUUID(),
      role: 'user',
      parts: [{ type: 'text', text }],
    };
    emit.emitMessage(userMessage);

    const gen = session.stream(text);
    let step = await gen.next();
    let stepIndex = 0;
    let lastMessageMetadata: NimboMessageMetadata | undefined;
    const pendingApprovalRequests = new Map<string, number>();
    const pendingSettlements = new Map<string, PendingToolSettlement>();
    while (!step.done) {
      const chunk = step.value;
      stepIndex = logChunk(
        log,
        conversationId,
        chunk,
        stepIndex,
        pendingApprovalRequests,
        pendingSettlements,
      );
      if (chunk.type === 'message-metadata') {
        lastMessageMetadata = chunk.messageMetadata;
      }
      emit.emitChunk(chunk);
      step = await gen.next();
    }

    // Graceful finish — `session.stream()` returned a `TurnResult` instead
    // of throwing. Covers both a genuinely successful turn *and* a graceful
    // mid-stream degrade (`@nimbo/core`'s `loop.ts` still `return`s a
    // `TurnResult`, with `status: 'failed'`/`'interrupted'` on the last
    // `message-metadata` chunk, after yielding it) — both cases already
    // pushed whatever messages they're going to push onto the ledger, so
    // both persist here identically.
    finalizeTurnPersistence(
      db,
      conversationId,
      session.toJSON(),
      priorMessageCount,
      turnStartSeq,
      log,
    );

    log.info(LOG_SCOPE, 'turn finished', {
      conversationId,
      status: lastMessageMetadata?.status,
      durationMs: Date.now() - turnStartedAt,
    });
  } catch (error) {
    // The generator itself threw — a genuinely unexpected failure (distinct
    // from `session.stream()`'s own graceful degrade, handled above), with
    // no `TurnResult` to report and no ledger `NimboUIMessage` this module
    // could attach failure `metadata` to the way `loop.ts`'s own
    // `finalizeTurn` would. Reuses the exact `message-metadata` chunk shape
    // core itself produces for a graceful failure (same `status: 'failed'`
    // field) so client-side handling code needs no separate case for this —
    // a standalone informational chunk on the wire, not attached to (or
    // superseding) any ledger row. `finalizeTurnPersistence` never runs on
    // this path, so this turn's `kind = 'chunk'` rows are never GC'd — the
    // same accepted crash-residue trade-off `schema.ts`'s doc comment
    // describes for an actual process crash, just triggered by a bug
    // surfacing as a thrown error instead.
    log.error(LOG_SCOPE, 'turn threw unexpectedly', {
      conversationId,
      error: describeError(error),
      durationMs: Date.now() - turnStartedAt,
    });
    emit.emitChunk({
      type: 'message-metadata',
      messageMetadata: {
        turn: bestEffortTurn(session),
        usage: {},
        status: 'failed',
        error: { code: 'provider_error', message: describeError(error) },
      },
    });
  }
}

export interface StartTurnParams {
  db: Db;
  conversationId: string;
  session: TurnDrivenSession;
  text: string;
  /**
   * Count of `kind = 'message'` rows already persisted for this session
   * *before* this turn starts (`routes/chat.ts` computes this off the same
   * `SessionState` it resumed the session from — `store.ts`'s
   * `loadResumeState`; `0` for a brand-new session that has never completed
   * a turn). `state.messages[priorMessageCount]` is where `@nimbo/core`'s own
   * turn-start user `NimboUIMessage` lands (`session.ts`'s `stream()` pushes
   * it synchronously, before ever yielding); `finalizeTurnPersistence` slices
   * `session.toJSON().messages` at `priorMessageCount + 1` — skipping over
   * that one message, since `driveTurn` already persisted+broadcast its own
   * copy of it at turn start (see that function's own comment) — to find
   * exactly the *remaining* messages this turn appended. The ledger only
   * ever grows by appending (`@nimbo/core`'s `session.ts` never reorders or
   * removes an existing message), so this index stays valid for the entire
   * turn regardless of how many steps/steers it goes through.
   */
  priorMessageCount: number;
  /**
   * Step/tool-call level observability tap (this ticket) — defaults to
   * `../logger.js`'s stdout singleton so existing callers that don't pass
   * one keep working unchanged. Tests inject their own (`createLogger({
   * sink })`) to assert on emitted lines without touching `process.stdout`.
   */
  logger?: Logger;
}

export interface StartTurnResult {
  started: boolean;
}

/**
 * Rejects (`{ started: false }`) if this session already has a turn running
 * — `routes/chat.ts` turns that into a 409. Otherwise registers the
 * `ActiveTurn` synchronously (so `isTurnActive`/`subscribeTurn` see it
 * immediately) and spawns the background driver — deliberately not
 * `await`ed, not bound to any request's lifetime.
 */
export function startTurn(params: StartTurnParams): StartTurnResult {
  const { db, conversationId, session, text, priorMessageCount } = params;
  const log = params.logger ?? defaultLogger;
  if (activeTurns.has(conversationId)) return { started: false };

  const turnStartSeq = getMaxEventSeq(db, conversationId);
  const emitter = new EventEmitter();
  // Every open `GET .../stream` tail (multiple tabs, reconnect churn) adds a
  // listener pair to the same turn's emitter for its lifetime — that's
  // expected fan-out, not a leak, so the default-10 warning is disabled.
  emitter.setMaxListeners(0);
  const activeTurn: ActiveTurn = {
    emitter,
    done: false,
    // Captured once, bound to *this* turn's `session` — `steerTurn` never
    // sees `session` directly, only this closure (STEER-3B).
    steer: (input) => session.steer?.(input) ?? false,
    emit: createTurnEmitter(db, conversationId, emitter, turnStartSeq),
    pendingReviews: new Map(),
    pendingQuestions: new Map(),
  };
  activeTurns.set(conversationId, activeTurn);

  void driveTurn(
    db,
    conversationId,
    session,
    text,
    priorMessageCount,
    turnStartSeq,
    activeTurn.emit,
    log,
  ).finally(() => {
    // Defensive cleanup only — in the normal case both maps are already
    // empty by the time `driveTurn` settles, because the `@nimbo/core` loop
    // is itself `await`ing whatever `requestReview`/`requestUserAnswer`
    // promise is pending (it's the tool call's own `onReview`/`ask-user`
    // result), so the generator simply cannot reach its `return`/`throw`
    // while one is still outstanding. Anything still here is a genuine leak
    // (e.g. a bug upstream) being caught before it dangles forever. Neither
    // bridge emits anything for these (unlike the pre-migration version):
    // the wire has nothing bridge-event-shaped left to emit after a turn
    // ends (see file header) — a stuck client is left to its own
    // `requestReview`/`requestUserAnswer` timeout, which fires from the very
    // same code path this `finally` is defensively duplicating.
    for (const pending of activeTurn.pendingReviews.values()) {
      clearTimeout(pending.timer);
      pending.resolve({
        behavior: 'deny',
        message:
          'The turn this approval request belonged to has already ended.',
      });
    }
    activeTurn.pendingReviews.clear();

    for (const pending of activeTurn.pendingQuestions.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ outcome: 'timeout' });
    }
    activeTurn.pendingQuestions.clear();

    emitter.emit('done');
    activeTurn.done = true;
    activeTurns.delete(conversationId);
  });

  return { started: true };
}

/**
 * Attaches to the session's in-progress turn, if any — a no-op unsubscribe
 * when there isn't one (`routes/chat.ts`'s `GET .../stream` checks
 * `isTurnActive` itself to tell the two cases apart, since `onDone` will
 * never fire for a turn that was never active). Subscribing is synchronous
 * and side-effect-free until the turn actually emits, so calling this
 * *before* replaying persisted history (docs/tech/chat-webapp.md §2.2b) is what prevents
 * losing an event that lands in the gap between the replay query and this
 * call. `onEvent` receives a `ChatReplayFrame` — almost always a
 * `ChunkEnvelope`, except for the turn's very first delivery, which is the
 * one `MessageFrame` `driveTurn` emits for the turn-start user message (see
 * `createTurnEmitter`).
 */
export function subscribeTurn(
  conversationId: string,
  onEvent: (envelope: ChatReplayFrame) => void,
  onDone: () => void,
): () => void {
  const activeTurn = activeTurns.get(conversationId);
  if (activeTurn === undefined) return () => {};

  activeTurn.emitter.on('event', onEvent);
  activeTurn.emitter.once('done', onDone);
  return () => {
    activeTurn.emitter.off('event', onEvent);
    activeTurn.emitter.off('done', onDone);
  };
}

/**
 * The one step genuinely identical between the review and ask-user bridges:
 * cancel `callId`'s timeout and remove it from `pending`, handing back the
 * removed entry (or `undefined` if there wasn't one) so the caller can
 * settle its promise — those two differ by bridge (different
 * `HumanDecision`/`AskUserOutcome` payloads), so settling stays in
 * `resolveReview`/`settleQuestion` rather than being folded into this helper
 * too.
 */
function takePending<T>(
  pending: Map<string, PendingEntry<T>>,
  callId: string,
): PendingEntry<T> | undefined {
  const entry = pending.get(callId);
  if (entry === undefined) return undefined;
  clearTimeout(entry.timer);
  pending.delete(callId);
  return entry;
}

// ---------------------------------------------------------------------------
// 审批链 / 人审通道 (docs/tech/single-ledger.md §6.4): `requestReview`
// is what `routes/chat.ts` wires up as the session's `onReview`
// (`ApprovalReviewer`) — `@nimbo/core`'s loop calls it only *after* it has
// already yielded a `tool-approval-request` chunk for a call the session's
// 审批分类器 (`onApproval`, `approval-policy.ts`'s `classifyApproval`)
// resolved to `'review'`; the resulting promise is exactly what the loop is
// `await`ing, so the turn's own execution is genuinely suspended (not
// polling) until `resolveReview` settles it. Neither function touches
// `emit`/`TurnEmitter` — see file header for why.
// ---------------------------------------------------------------------------

/** `CHAT_APPROVAL_TIMEOUT_MS`, defaulting to 240000ms — 80% of the sandbox's own idle timeout (`sandbox-manager.ts`'s `DEFAULT_SANDBOX_IDLE_TIMEOUT_MS`, 300000ms), so an unattended approval request times out (and denies) well before the sandbox itself would go idle out from under the turn. */
const DEFAULT_APPROVAL_TIMEOUT_MS = 240_000;

function resolveApprovalTimeoutMs(): number {
  const raw = process.env.CHAT_APPROVAL_TIMEOUT_MS?.trim();
  if (raw === undefined || raw.length === 0) return DEFAULT_APPROVAL_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ?
      parsed
    : DEFAULT_APPROVAL_TIMEOUT_MS;
}

export interface RequestReviewInput {
  callId: string;
  toolName: string;
  input: JsonValue;
}

export interface RequestReviewOptions {
  /** Overrides `CHAT_APPROVAL_TIMEOUT_MS` — mainly for tests; production callers leave this unset. */
  timeoutMs?: number;
}

/**
 * Registers a pending review for `conversationId`'s active turn — the returned
 * promise settles once `resolveReview(conversationId, req.callId, ...)` is
 * called (a human's decision) or the timeout elapses (auto-deny), whichever
 * comes first, either way via the exact same `resolveReview` call (see its
 * own doc comment) so a reconnecting client can't tell a timeout apart from
 * a manual decision.
 *
 * No active turn for `conversationId` at all (defensive branch — `routes/chat.ts`
 * only ever calls this from inside a running turn's own `onReview`
 * callback, so this shouldn't normally be reachable) denies immediately
 * without registering anything: there is nowhere to route the request to.
 */
export function requestReview(
  conversationId: string,
  req: RequestReviewInput,
  opts?: RequestReviewOptions,
): Promise<HumanDecision> {
  const activeTurn = activeTurns.get(conversationId);
  if (activeTurn === undefined) {
    return Promise.resolve({
      behavior: 'deny',
      message: 'No active turn to route this approval request to.',
    });
  }

  const timeoutMs = opts?.timeoutMs ?? resolveApprovalTimeoutMs();

  return new Promise<HumanDecision>((resolve) => {
    const timer = setTimeout(() => {
      resolveReview(conversationId, req.callId, {
        behavior: 'deny',
        message: `Approval request timed out after ${String(timeoutMs)}ms with no response.`,
      });
    }, timeoutMs);
    activeTurn.pendingReviews.set(req.callId, {
      resolve,
      timer,
      toolName: req.toolName,
      input: req.input,
    });
  });
}

/**
 * The human (or timeout) side of the bridge: `routes/chat.ts`'s
 * `POST .../approvals/:callId` calls this with the person's decision.
 * Returns `false` (no-op) when there is no such pending review to resolve
 * — either `conversationId` has no active turn at all, or it does but `callId`
 * isn't (or isn't anymore, e.g. already resolved/timed out) one of its
 * pending requests; the route turns a `false` here into a 404.
 *
 * On a hit: cancels the timeout, removes the pending entry, and settles the
 * `requestReview` promise with the decision — which is what actually
 * unblocks the suspended `@nimbo/core` loop, which then yields its own
 * `tool-approval-response` chunk on the wire (this function emits nothing
 * itself, see file header).
 *
 * `opts.grantSession = { db, userId }` (the human picked 「会话内都允许」): before
 * resolving, persist a 会话级授权 (`session-grants.ts`, `conversation_grants` 表)
 * for **this exact call** (the pending entry's own `toolName`/`input`) under the
 * approving `userId`, so the session classifier auto-allows an identical future
 * call by that user. The `decision` itself is still a plain `{ behavior: 'allow' }`
 * — the grant is a chat-layer concept the core loop neither needs nor sees.
 */
export function resolveReview(
  conversationId: string,
  callId: string,
  decision: HumanDecision,
  opts?: { grantSession?: { db: Db; userId: string } },
): boolean {
  const activeTurn = activeTurns.get(conversationId);
  if (activeTurn === undefined) return false;

  const pending = activeTurn.pendingReviews.get(callId);
  if (pending === undefined) return false;

  if (opts?.grantSession !== undefined) {
    grantSessionApproval(
      opts.grantSession.db,
      conversationId,
      opts.grantSession.userId,
      pending.toolName,
      pending.input,
    );
  }

  clearTimeout(pending.timer);
  activeTurn.pendingReviews.delete(callId);
  pending.resolve(decision);
  return true;
}

// ---------------------------------------------------------------------------
// ask-user bridge (docs/tech/chat-webapp.md §2.2c（审批链）) — structurally the sibling of the
// review bridge above; `chat-agent.ts`'s `ask-user` tool calls
// `requestUserAnswer` on every invocation (no auto-allow branch — asking the
// user is always exactly that), suspending the turn until a human answers
// via `POST .../questions/:callId` or the timeout elapses.
// ---------------------------------------------------------------------------

/** `CHAT_ASK_USER_TIMEOUT_MS`, defaulting to 240000ms — same rationale/default as `DEFAULT_APPROVAL_TIMEOUT_MS` above (80% of the sandbox's own idle timeout), kept as its own env var since a host may reasonably want to give a human longer to *answer a question* than to *approve a command*. */
const DEFAULT_ASK_USER_TIMEOUT_MS = 240_000;

function resolveAskUserTimeoutMs(): number {
  const raw = process.env.CHAT_ASK_USER_TIMEOUT_MS?.trim();
  if (raw === undefined || raw.length === 0) return DEFAULT_ASK_USER_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ?
      parsed
    : DEFAULT_ASK_USER_TIMEOUT_MS;
}

export interface RequestUserAnswerInput {
  callId: string;
  question: string;
  options?: string[];
}

export interface RequestUserAnswerOptions {
  /** Overrides `CHAT_ASK_USER_TIMEOUT_MS` — mainly for tests; production callers leave this unset. */
  timeoutMs?: number;
}

/**
 * Shared settle step for a pending question: both `resolveUserAnswer` (a
 * human's answer) and `requestUserAnswer`'s own timeout call this — same
 * "single settle path, timeout indistinguishable from a manual answer" as
 * the review bridge's `resolveReview`. Not exported: `resolveUserAnswer`
 * below is the public surface for the "answered" case; the timeout case
 * only ever originates from inside `requestUserAnswer` itself.
 */
function settleQuestion(
  conversationId: string,
  callId: string,
  outcome: AskUserOutcome,
): boolean {
  const activeTurn = activeTurns.get(conversationId);
  if (activeTurn === undefined) return false;

  const pending = takePending(activeTurn.pendingQuestions, callId);
  if (pending === undefined) return false;

  pending.resolve(outcome);
  return true;
}

/**
 * Registers a pending question for `conversationId`'s active turn — the returned
 * promise settles once `resolveUserAnswer(conversationId, req.callId, ...)` is
 * called (a human's answer) or the timeout elapses (`{ outcome: 'timeout' }`),
 * whichever comes first, either way via `settleQuestion` so a reconnecting
 * client can't tell a timeout apart from a manual answer (mirrors
 * `requestReview`'s own doc comment).
 *
 * No active turn for `conversationId` at all (defensive branch — `chat-agent.ts`'s
 * `ask-user` tool only ever calls this from inside a running turn, so this
 * shouldn't normally be reachable) resolves `{ outcome: 'timeout' }`
 * immediately without registering anything: there is nowhere to route the
 * question to.
 */
export function requestUserAnswer(
  conversationId: string,
  req: RequestUserAnswerInput,
  opts?: RequestUserAnswerOptions,
): Promise<AskUserOutcome> {
  const activeTurn = activeTurns.get(conversationId);
  if (activeTurn === undefined) {
    return Promise.resolve({ outcome: 'timeout' });
  }

  const timeoutMs = opts?.timeoutMs ?? resolveAskUserTimeoutMs();

  return new Promise<AskUserOutcome>((resolve) => {
    const timer = setTimeout(() => {
      settleQuestion(conversationId, req.callId, { outcome: 'timeout' });
    }, timeoutMs);
    activeTurn.pendingQuestions.set(req.callId, { resolve, timer });
  });
}

/**
 * The human (or timeout) side of the ask-user bridge: `routes/chat.ts`'s
 * `POST .../questions/:callId` calls this with the person's free-text
 * `answer`. Returns `false` (no-op) when there is no such pending question to
 * resolve — either `conversationId` has no active turn at all, or it does but
 * `callId` isn't (or isn't anymore, e.g. already answered/timed out) one of
 * its pending questions; the route turns a `false` here into a 404.
 */
export function resolveUserAnswer(
  conversationId: string,
  callId: string,
  answer: string,
): boolean {
  return settleQuestion(conversationId, callId, {
    outcome: 'answered',
    answer,
  });
}
