/**
 * 中止理由与拒绝文案的**单一出处**。
 *
 * 它们不是给日志看的装饰——理由字符串经 core 透传成收尾 `RunkoError.message`，界面
 * 据此区分「已停止」（用户按的）与「服务重启，这一轮已中断」（运维动作）。两处各写
 * 一份字面量迟早对不上。
 */

/** 用户按了停止键。 */
export const ABORT_REASON_USER = "Turn stopped by the user.";

/** 进程正在[优雅关闭](../../../../docs/terms.md)。 */
export const ABORT_REASON_SHUTDOWN = "Server is shutting down; this turn was interrupted.";

/** 一轮被停止时，挂着的人审就地按拒绝结掉（abort 信号对一个普通的 `await` 无效）。 */
export const ABORT_DENY_MESSAGE = "The turn was stopped before this approval was decided.";

/** 归属被别人接管（租约版才可能走到）——按中断收尾，不是故障。 */
export const OWNERSHIP_LOST_MESSAGE = "This conversation is now owned by another node; this turn was interrupted.";
