/**
 * 收拾[裁决表](../../../../docs/terms.md)里的**孤儿行**：一轮在内存里等人时进程崩了（或被接管），
 * 那一行登记了、却再也不会有人来结清。
 *
 * 为什么非收拾不可：「这一行还悬着」是[恢复](../../../../docs/terms.md)的判据。一条孤儿行会被当成
 * 可以恢复的挂起，会话列表也会一直显示「在等你」。
 *
 * ## 判据：还悬着，**且**不在账本末尾的悬空调用里
 *
 * 两类悬着的行长得一模一样，只能靠账本分：
 *
 * | 那次调用在账本里 | 是什么 | 怎么办 |
 * |---|---|---|
 * | 在末尾那条消息里，悬空着 | 正经挂起，等人回来 | **不动** |
 * | 不在（进行中的消息崩溃时不落盘） | 孤儿 | 结清成 `timeout` |
 *
 * 调用方都在**抢到归属之后**调它——这时没有别人在写。设计见
 * [挂起与恢复 · 技术方案](../../../../docs/logic/orchestration/tech/suspend-resume.md) §11.1。
 */
import type { Logger } from "../logger.js";
import { describeError } from "../logger.js";
import type { Persistence } from "../persistence.js";
import { pendingCallIdsAtLedgerEnd } from "./interrupted-marker.js";

const LOG_SCOPE = "agent:orphaned-decisions";

/** 结清时写进 `message` 的说明——给看裁决表审计的人，不给模型。 */
export const ORPHANED_DECISION_MESSAGE = "The turn waiting for this decision ended without it (process crashed or was taken over).";

/** 返回结清了几行。 */
export async function settleOrphanedDecisions(persistence: Persistence, conversationId: string): Promise<number> {
  const pending = await persistence.decisions.listPending(conversationId);
  if (pending.length === 0) {return 0;}
  const stillWaiting = new Set(await pendingCallIdsAtLedgerEnd(persistence, conversationId));
  let settled = 0;
  for (const row of pending) {
    if (stillWaiting.has(row.toolCallId)) {continue;}
    const ok = await persistence.decisions.settle(conversationId, row.toolCallId, {
      outcome: "timeout",
      message: ORPHANED_DECISION_MESSAGE,
      decidedAt: Date.now(),
    });
    if (ok) {settled += 1;}
  }
  return settled;
}

/**
 * 同上，但**不抛**：失败只记一行，返回 0。
 *
 * 调用方接下来还有更要紧的事——补「已停止」标记、放手。裁决表出一次故障不该连累它们：标记没补上，
 * 那一轮在界面上就永远悬着；而孤儿行留着的代价只是它还悬着，下一次接管或启动扫描会再收拾。
 */
export async function settleOrphanedDecisionsSafely(persistence: Persistence, logger: Logger, conversationId: string): Promise<number> {
  try {
    const settled = await settleOrphanedDecisions(persistence, conversationId);
    if (settled > 0) {logger.warn(LOG_SCOPE, "settled orphaned decisions", { conversationId, count: settled });}
    return settled;
  } catch (error) {
    logger.error(LOG_SCOPE, "failed to settle orphaned decisions; the next takeover or startup sweep will retry", {
      conversationId,
      error: describeError(error),
    });
    return 0;
  }
}
