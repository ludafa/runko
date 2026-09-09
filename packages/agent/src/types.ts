/**
 * 本包的共享值类型——[轮编排](../../../docs/terms.md)对外说话时用的词汇：一条输入、
 * 一条排队条目、直播流上的一帧、一个会话此刻的状况。
 *
 * 四种宿主能力各自的接口不在这里（见 `persistence.ts` / `stream.ts` /
 * `arbitration.ts` / `prepare.ts`），这里只放它们都要用到的公共词汇。
 */
import type { JsonValue, RunkoChunk, RunkoUIMessage } from "@runko/core";

/**
 * 一条要交给 agent 的输入。
 *
 * `text` 是**用户原话**——它进[账本](../../../docs/terms.md)、进[直播流](../../../docs/terms.md)，
 * 也就是界面上显示的那条用户消息。真正喂给模型的文本可以由宿主在
 * `prepareTurn` 里另给（`TurnPreparation.modelText`），两条分开正是「服务端能在
 * 不污染账本的前提下给模型追加话术」的关键。
 */
export interface TurnInput {
  text: string;
  /**
   * 这条输入的**发起者**（不透明字符串，框架不解释）。框架只做两件事：存进队列
   * 条目里，以及原样交给 `prepareTurn`——宿主拿它去匹配自己的授权/配额等。
   */
  userId?: string;
  /** 宿主自定义的随行数据，原样存进队列、原样回传给 `prepareTurn`。 */
  meta?: JsonValue;
}

/** [待发队列](../../../docs/terms.md)里的一条。`seq` 是入队顺序，不与账本 seq 共享空间。 */
export interface QueuedInput {
  id: string;
  conversationId: string;
  seq: number;
  input: TurnInput;
  createdAt: number;
}

/**
 * [直播流](../../../docs/terms.md)上的一帧。**框架不碰 HTTP**——怎么序列化成 SSE /
 * WebSocket 是[接入层](../../../docs/terms.md)的事。
 *
 * 只有 `message` 帧带 `seq`（它是账本里的一行，断线续传靠它）；其余三种都是
 * **状态快照 / 过程数据**，不落库、不占 seq、不参与 `after=` 续传。
 */
export type Frame =
  /** 账本里的一条成品消息——回放历史与每一轮新落盘的消息走的都是它。 */
  | { kind: "message"; seq: number; message: RunkoUIMessage }
  /** 直播的 [chunk](../../../docs/terms.md)。一律不落盘（[进行中草稿](../../../docs/terms.md)放内存）。 */
  | { kind: "chunk"; chunk: RunkoChunk }
  /** [待发队列](../../../docs/terms.md)快照。每条订阅必发一帧，之后变一次发一次。 */
  | { kind: "queue"; queue: QueuedInput[] }
  /** [轮状态快照](../../../docs/terms.md)：这个会话此刻有没有轮在跑，**服务端的权威答案**。 */
  | { kind: "activity"; active: boolean; holder?: string };

/** 一轮在框架内部的两个阶段（同 chat 应用原先的 `TurnPhase`）。 */
export type TurnPhase = "preparing" | "running";

/** `getActivity` 的答案——多节点时[接入层](../../../docs/terms.md)据 `holder` 决定要不要转发。 */
export interface ConversationActivity {
  /** 这个会话此刻有没有轮在跑（本进程或别处）。 */
  active: boolean;
  /** 只有本进程在跑时才有值；别的进程持有时是 `undefined`。 */
  phase?: TurnPhase;
  /** 持有者的不透明字符串（框架原样透传，不解释）。 */
  holder?: string;
  /** 这一轮由本进程驱动吗——为 `false` 且 `active` 为真时该转发给 `holder`。 */
  local: boolean;
}

/**
 * 一轮是怎么结束的。前四值原样来自 core 的收尾 metadata（`RunkoMessageMetadata.status`）；
 * `crashed` 是本层加的——驱动器自己抛了，压根没有 `TurnResult` 可报。
 *
 * `suspended` = [挂起](../../../docs/architecture/tech/agent-kernel.md)：停在「正在等人」
 * 这个干净边界上主动收尾、释放归属，人回来之后由**新的一轮**接着跑。它与 `interrupted`
 * 的区别是**主动且可恢复**——宿主别把它当成失败处理（别重试、别标红）。
 *
 * **目前没有产出方**：core 的 `finalizeTurn` 至今只产出前三值，K3 落地才会真写出来。
 * 先进联合是为了让宿主提前把分支占好，见 core `state.ts` 上的同款说明。
 */
export type TurnStatus = "completed" | "failed" | "interrupted" | "suspended" | "crashed";

/** `enqueue` 的结果——四种去向，`rejected` 带原因。 */
export type EnqueueResult =
  | { mode: "started" }
  | { mode: "queued"; queued: QueuedInput; queue: QueuedInput[] }
  | { mode: "steered" }
  | {
      mode: "rejected";
      reason: EnqueueRejection;
      message: string;
      /**
       * 归属此刻在谁手上——**只有 `held_by_other` 才有值**，其余四种拒绝原因不带。
       *
       * 它跟 `message` 里那句话是同一个事实，但**接入层要的是这一个**：转发是照着地址走的，
       * 从一句给人看的英文里抠 holder 是把文案当协议用，改一次文案就断一次转发。
       */
      holder?: string;
    };

/**
 * 拒绝的四种原因，**处置各不相同**，所以必须分开报（[归属仲裁机制 §5](../../../docs/logic/arbitration/tech/arbitration-impl.md)）：
 *
 * - `queue_full`：队列满了 → 409，绝不静默丢弃。
 * - `busy`：已有轮在跑，而这个 runtime 关掉了排队 → 409。
 * - `shutting_down`：进程正在[优雅关闭](../../../docs/terms.md) → 503，可重试。
 * - `held_by_other`：归属在别的节点手上 → **转给 `holder`**，不是报错。
 * - `error`：装配失败（凭据、沙盒、建 session）→ 500。
 */
export type EnqueueRejection = "queue_full" | "busy" | "shutting_down" | "held_by_other" | "error";

/** `abort` 的结果。`false` = 没有进行中的一轮可停（[接入层](../../../docs/terms.md)转 409）。 */
export type AbortResult = boolean;
