/**
 * 「这一轮为什么停了」的四句固定文案。
 *
 * 单独成文件而不是各自散在用它的模块里，是因为它们**跨模块**：`abort.ts` 停一轮时
 * 用、`human-bridge.ts` 回填挂起的人审时用、`shutdown.ts` 关闭时用、`reservation.ts`
 * 撤销占位时用。把它们凑在一起，同时也断开了「abort ↔ 人审通道」的循环引用
 * （abort 要调人审去结掉挂起项，人审又要用 abort 的拒绝文案）。
 *
 * 这些文案**都会被人或模型读到**（进模型上下文 / 进[账本](../../../../../docs/terms.md)
 * / 进界面文案匹配），所以改动前先看每一条自己的注释。
 */

/** 停止时给挂起的[审批卡片](../../../../../docs/terms.md)回填的拒绝理由——会进模型上下文，故写成一句模型读得懂的话。 */
export const ABORT_DENY_MESSAGE =
  'The user stopped this turn, so this tool call was not approved.';

/** 用户按下停止键时的中止理由——经 core 透传成收尾 `NimboError.message`（见 `abort.ts` 的 `abortTurn` 的 `reason` 参数）。 */
export const ABORT_REASON_USER = 'Turn stopped by the user.';

/**
 * [优雅关闭](../../../../../docs/terms.md)时的中止理由（docs/tech/graceful-shutdown.md §4）。
 *
 * **这是一个跨三处的文案契约**，改它要同时改三处，否则界面会把「服务重启」显示成
 * 「用户按了停止」：
 *
 * 1. 这里——`shutdown.ts` 的 `shutdownTurns` 用它 abort，经 core 的 `abortMessage`
 *    透传进收尾 `NimboError.message`；
 * 2. `crash-recovery.ts`——[孤儿轮](../../../../../docs/terms.md)补的那条收尾 metadata；
 * 3. `apps/web` 的 `turn-marker.tsx`——命中它才显示「服务重启，这一轮已中断」。
 *
 * 之所以用文案而不是给 `NimboError.code` 加一个值：「服务要关闭了」是宿主的运维概念，
 * 不该塞进 SDK 的类型联合（理由详见 docs/tech/graceful-shutdown.md §2）。
 */
export const ABORT_REASON_SHUTDOWN =
  'The server shut down while this turn was running.';

/** 起轮装配窗口里被停止时，给挂在时间线末尾那条「已停止」标记的固定文案（进账本，故与 core 的口径一致）。 */
export const ABORT_BEFORE_START_MESSAGE =
  'The user stopped this turn before it started running.';
