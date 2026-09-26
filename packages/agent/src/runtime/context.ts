/**
 * 运行时内部各模块共用的那一份依赖包（起轮、驱动、停止、关闭、恢复都要用到它）。
 * 单独一个文件只为一件事：让 `turn.ts` / `queue.ts` 不必反向 import `runtime.ts`
 * （那会成环）。
 */
import type { Arbitration } from "../arbitration.js";
import type { Logger } from "../logger.js";
import type { Persistence } from "../persistence.js";
import type { TurnPreparer } from "../prepare.js";
import type { StreamFanout } from "../stream.js";
import type { TurnInput, TurnStatus } from "../types.js";
import type { AgentDefinition } from "@runko/core";

import type { HandoverContext } from "./handover.js";
import type { ApprovalPendingEvent, HumanBridge, QuestionPendingEvent } from "./human.js";
import type { TurnRegistry } from "./registry.js";
import type { SessionFactory } from "./session-factory.js";

/**
 * 宿主的观测/通知挂钩。**全部可选、全部只报告不影响这一轮**：抛错就地吞掉记一行。
 *
 * 为什么这些不做成框架能力：遥测与推送是**可选外围**，运行内核不该长出对它们的
 * 认识——同 chat 应用原先 `onTurnSettled`/`onMilestone` 的分工，只是搬进了框架。
 */
export interface RuntimeHooks {
  onTurnStart?: (event: { conversationId: string; turn: number; input: TurnInput }) => void;
  onTurnSettled?: (event: { conversationId: string; turn: number; status: TurnStatus; input: TurnInput }) => void;
  /** 这一轮的**第一个** chunk 抵达——量的是「起轮到 `session.stream()` 真正开跑」，**不含**模型首 token。 */
  onFirstChunk?: (event: { conversationId: string; sessionId: string; turn: number; sinceStartMs: number }) => void;
  /** 第一个**用户看得见**的 chunk 抵达——它减去上一个就是模型首 token 的等待。 */
  onFirstOutput?: (event: { conversationId: string; sessionId: string; turn: number; sinceStartMs: number }) => void;
  /**
   * agent 需要一个人来批（推送通知的触发点之一）。**发生在等人项登记好之后**——
   * 审批卡片走直播那条路，通知是可选支路，绝不能排在它前面拖慢或拖挂它。
   */
  onApprovalPending?: (event: ApprovalPendingEvent) => void;
  /** agent 问了用户一个问题。同上。 */
  onQuestionPending?: (event: QuestionPendingEvent) => void;
  /**
   * 一条[工具收尾](../../../../docs/terms.md)在本节点上跑完了，**结果写库之前**调它（会等它返回，最多等几秒）。
   * 宿主在这里把工具改过的东西存下来——比如进程内的沙盒要存一份快照，否则接手节点恢复时看不到那条命令的改动。
   * 抛错或超时只记日志，结果照样写。
   */
  onToolTailFinished?: (event: { conversationId: string; callId: string; toolName: string }) => void | Promise<void>;
  /**
   * 一轮以[已交权](../../../../docs/terms.md)收尾、**放手之前**调它（会等它返回，最多等几秒）。宿主在这里把接手节点
   * 要用的东西存下来——比如进程内的沙盒存一份快照；放手之后接手节点随时可能开始读。抛错或超时只记日志，照常放手。
   */
  onHandOff?: (event: { conversationId: string }) => void | Promise<void>;
}

/**
 * [插话](../../../../docs/terms.md)策略：有轮在跑时，新来的这条是插进这一轮还是排队。
 *
 * - `never` —— 一律排队。
 * - `always` —— 有轮在跑就插话。
 * - `onRequest` —— 看调用方 `enqueue` 时传的 `intent`（缺省档）。适合「用户在界面上
 *   自己选插话还是排队」这种由客户端显式表态的宿主。
 * - **回调** —— 由宿主按这条输入自己判断。适合「没有显式表态，但想按内容自动分流」
 *   的宿主，比如识别出「停一下 / 等等」这类指令就插队，其余排队。
 *
 * 回调拿到的是整条 `TurnInput`（不只是 `text`）——`userId` 与 `meta` 一并给出，
 * 于是「只有发起者本人能插话」「带某个 meta 标记的才插话」这类策略也表达得了。
 * 回调**不该抛错**；抛了当作 `false`（排队）处理，理由见 `queue.ts` 的 `wantsSteer`。
 */
export type SteerPolicy = "never" | "always" | "onRequest" | ((input: TurnInput) => boolean);

export interface QueueConfig {
  enabled: boolean;
  max: number;
  onFull: "reject" | "dropOldest";
  /** 见 `SteerPolicy`。 */
  steer: SteerPolicy;
}

export interface RuntimeContext {
  agent: AgentDefinition;
  prepareTurn: TurnPreparer;
  persistence: Persistence;
  stream: StreamFanout;
  arbitration: Arbitration;
  registry: TurnRegistry;
  human: HumanBridge;
  sessionFactory: SessionFactory;
  logger: Logger;
  hooks: RuntimeHooks;
  queue: QueueConfig;
  /** 注册内置 `ask-user` 工具。 */
  askUser: boolean;
  isShuttingDown: () => boolean;
  /** 单次工具执行的上限（毫秒），交给 core。 */
  toolTimeoutMs: number | undefined;
  /** [交权](../../../../docs/terms.md)的配置与这次下线的状态。 */
  handover: HandoverContext;
}
