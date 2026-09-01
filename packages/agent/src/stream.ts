/**
 * 宿主能力之一：**[流分发](../../../docs/terms.md)**（[契约](../../../docs/host/contract/tech/stream-fanout.md)）。
 *
 * 两条硬约束照抄契约文档：
 *
 * **① 接口必须是「发布/订阅」，不能是「存/取」。** 写成「存/取」会诱导实现去做保留
 * 策略、做游标管理，跟账本的职责重叠，最后变成两份互相打架的历史。历史的事实来源
 * **永远是账本**；流分发只管把正在产生的东西送出去。
 *
 * **② 「拿快照 + 挂订阅」必须是一个动作。** 这里的落地形式是：**`subscribe` 是同步的**
 * ——它返回时订阅已经挂上了。只有这样，调用方才写得出「先挂订阅、再取
 * [进行中草稿](../../../docs/terms.md)快照，中间不出现任何 `await`」这段零空隙代码
 * （Node 单线程，同步段内没有别的东西能插进来）。反过来写的话，中间到达的 chunk
 * 既不在快照里、也没被订阅到——那才是真丢。
 */
import type { Frame } from "./types.js";

export interface StreamFanout {
  /** 发布一帧给这个会话当前所有订阅者。**不保证送达**——没人订阅时内容照样进账本，掉了靠回放补。 */
  publish(conversationId: string, frame: Frame): void;
  /** 同步挂上订阅（理由见文件头约束 ②），返回退订函数。 */
  subscribe(conversationId: string, listener: (frame: Frame) => void): () => void;
}
