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

/**
 * 登记裁决表那一行失败时，这次审批不能[挂起](../../../../docs/terms.md)——挂起之后人回来答的就是那一行，
 * 没有它就永远没人能答。所以窗口到点按拒绝结掉，理由交给模型。
 */
export const UNRECORDED_DENY_MESSAGE =
  "This approval could not be saved, so it could not wait for a person to come back; it was denied. Try again if it is still needed.";

/** 一轮被停止时，挂着的人审就地按拒绝结掉（abort 信号对一个普通的 `await` 无效）。 */
export const ABORT_DENY_MESSAGE = "The turn was stopped before this approval was decided.";

/**
 * 新持有者接手时，替**上一个**持有者那一轮补的「已停止」理由（租约版才可能走到）。
 * 上一个持有者崩了或卡住了，它自己写不了收尾。
 */
export const ABORT_REASON_HOLDER_LOST = "The node running this turn stopped responding; another node took over.";

/** 归属被别人接管（租约版才可能走到）——按中断收尾，不是故障。 */
export const OWNERSHIP_LOST_MESSAGE = "This conversation is now owned by another node; this turn was interrupted.";

/**
 * [挂起](../../../../docs/terms.md)的理由——写进收尾 metadata 的 `suspended.reason`。
 *
 * **它们是本包的词，不是 core 的**：core 只把宿主给的字符串原样透传（「为什么挂起」是宿主的
 * 概念），所以枚举放在这里。
 *
 * - `timeout`：[内存窗口](../../../../docs/terms.md)走完了，没人答。
 * - `handover`：[交权](../../../../docs/terms.md)（滚动发布、缩容、`SIGTERM`）时这一轮正在等人。
 * - `immediate`：`suspend.memoryWindow` 配成 `0`，一等人就挂，根本没在内存里等。
 */
export type SuspendReason = "timeout" | "handover" | "immediate";
