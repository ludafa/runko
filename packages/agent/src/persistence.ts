/**
 * 宿主能力之一：**持久化**（[契约](../../../docs/host/contract/tech/persistence.md)）。
 *
 * 四条准则照抄契约文档，这里只落成签名：
 *
 * 1. **暴露「agent 运行需要什么」，不暴露「表长什么样」**——账本是「按会话追加消息 /
 *    从某点之后读」，不是「一张 seq 做主键的表」。
 * 2. **runko 不拥有用户实体**——只认不透明 `userId`，不做外键。
 * 3. **迁移不是契约的一部分**——这里没有任何 `migrate()`。
 * 4. **不假设事务能跨接口**——需要原子的地方（出队）收进**一个**方法里。
 *
 * 外加两条从别处推来的硬约束：**seq 由[归属仲裁](../../../docs/terms.md)分配**
 * （所以 `append` 吃一个现成的 `seq`），**写入可能被拒绝而且这是正常路径**
 * （所以 `append` 返回 `WriteResult` 而不是抛错，理由见 `WriteResult`）。
 */
import type { JsonValue, RunkoUIMessage } from "@runko/core";

import type { QueuedInput, TurnInput } from "./types.js";

/**
 * 一次写入的结果。
 *
 * **为什么是结果类型而不是抛错**：租约版[归属仲裁机制](../../../docs/terms.md)下，
 * [轮编排](../../../docs/terms.md)的每一次写入都可能因为[租期标识](../../../docs/terms.md)
 * 对不上而被拒——**这是正常路径，不是异常**。异常通道会诱导调用方 `try/catch` 成
 * 「出错了」并报 500，而正确处置是按中断收尾；更要命的是 TypeScript 不检查异常，
 * 单进程版下这一支不写也能编译过，换成租约版就是静默数据损坏。
 *
 * 真正的**基础设施故障**（连不上库、磁盘满）仍然抛——那不是「条件不匹配」，
 * 调用方也确实无能为力。
 */
export type WriteResult =
  | { ok: true }
  | { ok: false; reason: "rejected" };

/** [账本](../../../docs/terms.md)里的一行。`kind` 只有 `message`——[进行中草稿](../../../docs/terms.md)不落库。 */
export interface LedgerEntry {
  conversationId: string;
  /** 每会话递增，由归属仲裁分配。**允许有空洞**（占了号但插入失败），三个用途都不要求连续。 */
  seq: number;
  message: RunkoUIMessage;
  /** 落盘时刻（毫秒时间戳）。 */
  ts: number;
}

export interface LedgerStore {
  /** 追加一条成品消息。同 `(conversationId, seq)` 重复写入应当幂等或被拒绝，不得写出两行。 */
  append(entry: LedgerEntry): Promise<WriteResult>;
  /** 从某点之后读（断线续传游标，`afterSeq` 不含自身）；不传读全部。必须按 seq 升序。 */
  read(conversationId: string, opts?: { afterSeq?: number }): Promise<LedgerEntry[]>;
  /** 当前最大 seq；`0` = 这个会话还没有任何记录。 */
  maxSeq(conversationId: string): Promise<number>;
}

/** 一条[人工裁决](../../../docs/terms.md)的留底。`decidedAt` 缺席即「尚未 settle」。 */
export interface DecisionRecord {
  conversationId: string;
  /** 对应账本里那次工具调用（core 的 `ApprovalContext.callId`）。 */
  toolCallId: string;
  /** 审批还是 `ask-user` 提问——两条通道形状相同、语义不同，用它分开。 */
  kind: "approval" | "question";
  toolName?: string;
  /** 这次调用的入参（审批）或问题正文（提问）。 */
  payload?: JsonValue;
  /** 待定时缺席。`allow`/`deny` 属审批，`answered`/`timeout` 属提问。 */
  outcome?: "allow" | "deny" | "answered" | "timeout";
  /**
   * 这次裁决管多远：`once` = 只这一次；`conversation` = 这个会话内都算数。
   *
   * **框架只记，不执行**——它不会在后续轮里查这张表替宿主自动放行。记账粒度
   * （按整条调用的入参指纹？按[命令段](../../../docs/terms.md)拆？按用户分账？）
   * 是宿主的产品决策，框架不该替它定。宿主自己的实现见
   * `apps/node-server/src/agent/conversation-grants.ts`。
   */
  scope?: "once" | "conversation";
  /** 谁批的（不透明字符串）。 */
  decidedBy?: string;
  /** 拒绝理由 / 回答正文。 */
  message?: string;
  requestedAt: number;
  decidedAt?: number;
}

export interface DecisionStore {
  /** 登记一条待定裁决（loop 刚请求人审时）。 */
  record(entry: DecisionRecord): Promise<WriteResult>;
  /** 结清它。`false` = 没有这条待定裁决（已结清、已超时、或从未存在）。 */
  settle(
    conversationId: string,
    toolCallId: string,
    settlement: Pick<DecisionRecord, "outcome" | "scope" | "decidedBy" | "message"> & { decidedAt: number },
  ): Promise<boolean>;
  /** 这个会话还没结清的裁决。当前只服务于观测与将来的[挂起](../../../docs/terms.md)恢复。 */
  listPending(conversationId: string): Promise<DecisionRecord[]>;
}

export type EnqueueOutcome =
  | { ok: true; queued: QueuedInput; queue: QueuedInput[] }
  | { ok: false; reason: "full"; queue: QueuedInput[] };

export interface QueueStore {
  /** 入队到队尾（先到先发）。已满则原样返回当前队列，**不截断、不覆盖**。 */
  enqueue(conversationId: string, input: TurnInput, opts: { max: number; onFull: "reject" | "dropOldest" }): Promise<EnqueueOutcome>;
  /**
   * [出队](../../../docs/terms.md)：取队首并**立即**移除，**一个方法内原子完成**。
   *
   * 「取出即移除」是刻意的：起轮失败时调用方会 `requeueFront` 放回去，先移除保证
   * 任何中途异常都不会让同一条消息被起两轮。
   */
  dequeue(conversationId: string): Promise<{ item: QueuedInput | undefined; queue: QueuedInput[] }>;
  list(conversationId: string): Promise<QueuedInput[]>;
  /** `removed: false` = 这个 id 不在队列里（已发出/已删/从未存在）。 */
  remove(conversationId: string, id: string): Promise<{ removed: boolean; queue: QueuedInput[] }>;
  clear(conversationId: string): Promise<QueuedInput[]>;
  /**
   * 起轮失败时把出队的那条放**回队首**，保住它原有的顺序位置。
   * 刻意**不受 `max` 约束**：这是回滚一次已发生的出队，不是新的入队请求。
   */
  requeueFront(conversationId: string, item: QueuedInput): Promise<QueuedInput[]>;
}

/** 三个 Store 合起来就是「持久化」这一样宿主能力。 */
export interface Persistence {
  ledger: LedgerStore;
  decisions: DecisionStore;
  queue: QueueStore;
}
