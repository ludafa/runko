/**
 * 一轮的**主循环**：把 `session.stream()` 吐出的每一个 chunk 依次「记一行日志 →
 * 落盘并广播 → 报里程碑」，跑完再落一次收尾（`persistence.ts` 的
 * `finalizeTurnPersistence`）。
 *
 * `driveTurn` **从不 reject**（下面的 `catch` 兜住了所有抛出），它返回「这一轮怎么
 * 结束的」（`TurnSettledInfo`）——`start.ts` 拿着这个值去做收尾与通知。
 */
import { randomUUID } from 'node:crypto';

import type {
  NimboChunk,
  NimboMessageMetadata,
  NimboUIMessage,
} from '@nimbo/core';

import type { Logger } from '../../logger.js';
import { truncate } from '../../logger.js';
import type { Db } from '../store.js';
import type { PendingToolSettlement } from './log.js';
import {
  describeError,
  LOG_SCOPE,
  logChunk,
  TEXT_PREVIEW_LENGTH,
} from './log.js';
import type { TurnEmitter } from './persistence.js';
import { finalizeTurnPersistence } from './persistence.js';
import type { TurnDrivenSession } from './session.js';

/**
 * 一轮的两个「首次」时刻（docs/tech/telemetry.md §2.4）——本目录只**报告**它们，
 * 拼遥测载荷、写库都在 `turn-launcher.ts`（与 `onTurnSettled` 同款姿态：turn-runner
 * 不认识队列，也不认识遥测）。
 *
 * - `'first-chunk'`：这一轮的第一个 chunk 抵达。core 的 loop 在**发出模型请求之前**
 *   就 yield `start`/`start-step`，所以这个时刻量的是「起轮到 `session.stream()` 真
 *   正开跑」，**不含**模型首 token。
 * - `'first-output'`：第一个**用户看得见**的 chunk 抵达（见 `isVisibleChunk`）。它减
 *   去上一个就是模型首 token 的等待。
 *
 * 各触发**至多一次**，且 `'first-chunk'` 必然不晚于 `'first-output'`。
 */
export type TurnMilestone = 'first-chunk' | 'first-output';

export interface TurnMilestoneInfo {
  /** nimbo 会话 id（`session.toJSON().id`）——遥测的关联键前半段。 */
  sessionId: string;
  /** 本轮轮号（`session.toJSON().turn`，`session.stream()` 已在开跑时 `+1`）——关联键后半段。 */
  turn: number;
  /** 从 `driveTurn` 入口（≈`startTurn` 调用时刻）到这个时刻的毫秒数。 */
  sinceStartMs: number;
}

/**
 * 「这一轮是怎么结束的」——`onTurnSettled` 的唯一参数。
 *
 * 本目录只**报告**它，不解读：注入方（`turn-launcher.ts`）拿它去决定要不要发通知
 * （docs/tech/push-notification.md §3.3）。这与 `onMilestone` 是同一姿态——运行内核
 * 不认识推送，只多交出一个已经算好的事实。
 */
export interface TurnSettledInfo {
  /**
   * 前三值来自本轮最后一个 `message-metadata` chunk（core 的
   * `status: 'completed' | 'failed' | 'interrupted'`，`interrupted` = 被
   * [停止](../../../../../docs/terms.md)）；**一个 metadata 都没见到也算 `completed`**
   * ——正常收尾就是正常收尾，缺 metadata 是 core 侧的可选字段问题，不该被报成失败。
   *
   * `crashed` 是 `driveTurn` 的 `catch` 分支：`session.stream()` 直接抛了，压根没
   * 产出收尾 metadata（那条 `status: 'failed'` 的合成 chunk 是本目录补的，不是 core
   * 给的）。与 `failed` 分开是因为两者的排查方向完全不同——一个是模型/工具失败，
   * 一个是我们自己的 bug。
   */
  status: 'completed' | 'failed' | 'interrupted' | 'crashed';
}

/**
 * 「用户在界面上看得见东西了」——第一段文字、第一段推理、或第一张工具调用卡片。
 * 刻意不含 `start`/`start-step`（空气泡，界面上还是一片空白）与
 * `data-*`/`tool-approval-request`（它们只可能出现在某个工具调用之后，永远抢不到
 * 第一）。
 */
function isVisibleChunk(chunk: NimboChunk): boolean {
  return (
    chunk.type === 'text-start' ||
    chunk.type === 'reasoning-start' ||
    chunk.type === 'tool-input-available'
  );
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
 * 报告一个[起轮装配](../../../../../docs/terms.md)里程碑（docs/tech/telemetry.md §2.4）。
 * 两道防护，理由与「遥测永不影响 turn」同源：`session.toJSON()` 抛错（防御性，不
 * 预期）就跳过这次报告而不是让整轮崩掉；回调自己抛错就地吞掉记一行——它是注入方
 * 的事，不该污染这一轮。
 */
function reportMilestone(
  session: TurnDrivenSession,
  onMilestone:
    ((milestone: TurnMilestone, info: TurnMilestoneInfo) => void) | undefined,
  milestone: TurnMilestone,
  sinceStartMs: number,
  conversationId: string,
  log: Logger,
): void {
  if (onMilestone === undefined) return;
  try {
    const state = session.toJSON();
    onMilestone(milestone, {
      sessionId: state.id,
      turn: state.turn,
      sinceStartMs,
    });
  } catch (error) {
    log.error(LOG_SCOPE, 'onMilestone threw', {
      conversationId,
      milestone,
      error: describeError(error),
    });
  }
}

export async function driveTurn(
  db: Db,
  conversationId: string,
  session: TurnDrivenSession,
  /** 用户原话——合成给界面看的 `NimboUIMessage` 用的就是它（见 `StartTurnParams.text`）。 */
  text: string,
  /** 喂给模型的文本，可能比 `text` 多一行系统提示（见 `StartTurnParams.modelText`）。 */
  modelText: string,
  priorMessageCount: number,
  turnStartSeq: number,
  emit: TurnEmitter,
  log: Logger,
  signal: AbortSignal,
  onMilestone?: (milestone: TurnMilestone, info: TurnMilestoneInfo) => void,
  // 返回「这一轮怎么结束的」而不是 void：它**从不 reject**（下面的 catch 兜住了
  // 所有抛出），所以 `startTurn` 的收尾里可以直接拿到这个值交给
  // `onTurnSettled`，不必再在外层维护一个可变量来接。
): Promise<TurnSettledInfo> {
  const turnStartedAt = Date.now();
  log.info(LOG_SCOPE, 'turn started', {
    conversationId,
    text: truncate(text, TEXT_PREVIEW_LENGTH),
  });

  try {
    // The turn-start user message (see `index.ts`'s header and
    // `schemas/chat.ts`'s file header): synthesized and put on the wire
    // *before* this function ever starts consuming `session.stream()`, so it
    // always arrives ahead of anything else this turn produces — chat input
    // is always plain text (`routes/chat.ts`'s `PostChatMessageInputSchema`),
    // hence the single `text` part. `@nimbo/core`'s own `Session.stream()`
    // separately pushes a structurally-identical copy (different `id`) onto
    // its internal ledger the moment it actually starts running
    // (`session.ts`'s own `stream()`) — `finalizeTurnPersistence` knows to
    // skip over that copy so it's never persisted twice.
    const userMessage: NimboUIMessage = {
      id: randomUUID(),
      role: 'user',
      parts: [{ type: 'text', text }],
    };
    emit.emitMessage(userMessage);

    // `signal` = 这一轮自己的 `AbortController.signal`（docs/tech/turn-abort.md §3.1）
    // ——[停止](../../../../../docs/terms.md)后 core 的 loop 在下一个 step 边界优雅收尾
    // （`status: 'interrupted'`），走的是下面那条**正常收尾**的路，不是 `catch` 分支。
    // 这里用 `modelText` 而不是 `text`：上面那条合成的 `NimboUIMessage`（进账本、
    // 进直播流）拿的是用户原话，模型这条路可以多带一行系统提示——两条路分开正是
    // [skill 提及](../../../../../docs/terms.md)「软提示」能生效又不脏账本的关键
    // （docs/tech/composer-skill-mention.md §2.2）。没有提及时两者是同一个字符串。
    const gen = session.stream(modelText, { signal });
    let step = await gen.next();
    let stepIndex = 0;
    let lastMessageMetadata: NimboMessageMetadata | undefined;
    const pendingApprovalRequests = new Map<string, number>();
    const pendingSettlements = new Map<string, PendingToolSettlement>();
    // 两个「首次」的一次性闸门（docs/tech/telemetry.md §2.4）——时刻在 chunk 抵达的
    // 那一刻取，报告放在 `emitChunk` 之后：观测绝不插在 chunk 送达用户的前面。
    let firstChunkReported = false;
    let firstOutputReported = false;
    while (!step.done) {
      const chunk = step.value;
      const arrivedAt = Date.now();
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
      if (!firstChunkReported) {
        firstChunkReported = true;
        reportMilestone(
          session,
          onMilestone,
          'first-chunk',
          arrivedAt - turnStartedAt,
          conversationId,
          log,
        );
      }
      if (!firstOutputReported && isVisibleChunk(chunk)) {
        firstOutputReported = true;
        reportMilestone(
          session,
          onMilestone,
          'first-output',
          arrivedAt - turnStartedAt,
          conversationId,
          log,
        );
      }
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
    // 缺 metadata 也算正常收尾——见 `TurnSettledInfo.status` 的注释。
    return { status: lastMessageMetadata?.status ?? 'completed' };
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
    // 线上给客户端的是 `failed`（形状与 core 的优雅失败同源，界面不必多一个分支），
    // 但报给注入方的是 `crashed`——两者排查方向完全不同，见 `TurnSettledInfo`。
    return { status: 'crashed' };
  }
}
