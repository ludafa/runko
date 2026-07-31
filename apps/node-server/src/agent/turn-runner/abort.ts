/**
 * [停止](../../../../../docs/terms.md)进行中的那一轮（docs/tech/turn-abort.md §3）。
 *
 * 每一轮自带一个 `AbortController`（`ActiveTurn.abortController`），signal 经
 * `session.stream(text, { signal })` 交给 `@nimbo/core`；本文件的 `abortTurn` 触发它。
 * 被停止的一轮走的是 core 的**优雅收尾**路径（`status: 'interrupted'` 的
 * `message-metadata` + 正常 `return TurnResult`），所以落盘/GC/`onTurnSettled` 全部按
 * 既有路径跑完——「停止」不需要任何新的 wire 形状或账本条目类型。唯一的额外动作就在
 * 这里：把挂起的人审/ask-user 就地结掉（core 正 `await` 那些 promise，abort 信号对
 * 它们无效）。
 */
import type { Logger } from '../../logger.js';
import { logger as defaultLogger } from '../../logger.js';
import { ABORT_DENY_MESSAGE, ABORT_REASON_USER } from './abort-reasons.js';
import { resolveReview, settleQuestion } from './human-bridge.js';
import { LOG_SCOPE } from './log.js';
import { activeTurns } from './registry.js';

/**
 * [停止](../../../../../docs/terms.md)这个会话进行中的那一轮（docs/tech/turn-abort.md §3.1）
 * ——`routes/chat.ts` 的 `POST .../abort` 调它。返回 `false` = 没有进行中的一轮可停
 * （路由转 409）；`true` = 停止已请求（**不代表已经停住**，真正停下的时刻见
 * docs/features/turn-abort.md §2.3）。
 *
 * 四步的顺序都是硬要求：
 *
 * 1. **幂等**：已经请求过就直接 `true` 返回，连点停止键不会重复走下面的收尾。
 * 2. **先置 `aborted` 标志**，再做后面两步——它同时是 `requestReview`/
 *    `requestUserAnswer` 的闸门（见 `ActiveTurn.aborted` 注释）。
 * 3. **结掉已经挂起的人审/提问**：core 正 `await` 这些 promise 时，abort 信号对它
 *    毫无作用（`loop.ts` 的 `settleToolCall` 只是在等一个普通 promise）——这是整个
 *    功能里唯一一处「光有 abort 信号不够」的地方。快照 key 再遍历：`resolveReview`/
 *    `settleQuestion` 会就地删 Map 条目，不能边删边迭代。
 * 4. **最后 abort**：信号一放出去，这一轮随时可能收尾（`drive.ts` 的 `driveTurn` 收尾
 *    后 `start.ts` 会把它从 `activeTurns` 删掉），此后再碰 `activeTurn` 的状态就没有
 *    意义了。
 */
export function abortTurn(
  conversationId: string,
  /**
   * 中止理由——core 会把它透传成收尾 `NimboError.message`（`loop.ts` 的 `abortMessage`），
   * 界面据此区分「已停止」与「服务重启，这一轮已中断」。缺省即用户按了停止键。
   */
  reason: string = ABORT_REASON_USER,
  logger?: Logger,
): boolean {
  const log = logger ?? defaultLogger;
  const activeTurn = activeTurns.get(conversationId);
  if (activeTurn === undefined) return false;
  if (activeTurn.aborted) return true;

  activeTurn.aborted = true;

  const pendingReviewIds = [...activeTurn.pendingReviews.keys()];
  const pendingQuestionIds = [...activeTurn.pendingQuestions.keys()];
  log.info(LOG_SCOPE, 'turn abort requested', {
    conversationId,
    // `preparing` = 停在[起轮装配](../../../../../docs/terms.md)窗口里（docs/tech/turn-abort.md §3.3）：
    // 这一轮还没启动，收尾由 `releaseTurn` 补，不走 core 的 loop。
    phase: activeTurn.phase,
    pendingReviews: pendingReviewIds.length,
    pendingQuestions: pendingQuestionIds.length,
  });

  for (const callId of pendingReviewIds) {
    resolveReview(conversationId, callId, {
      behavior: 'deny',
      message: ABORT_DENY_MESSAGE,
    });
  }
  for (const callId of pendingQuestionIds) {
    settleQuestion(conversationId, callId, { outcome: 'timeout' });
  }

  activeTurn.abortController.abort(new Error(reason));
  return true;
}
