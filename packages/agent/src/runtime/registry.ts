/**
 * 「进行中的轮」登记表——本目录的**内存核心**：这张 `Map` 就是「这个会话此刻有没有
 * 一轮在跑」在**本进程**里的事实来源，其余模块（驱动、停止、关闭、人在回路桥）全部
 * 围着它转。
 *
 * 跨进程的那份事实来源是[归属仲裁机制](../../../../docs/terms.md)的[起轮标记](../../../../docs/terms.md)
 * ——两者的分工：标记回答「有没有人在跑」（进程崩了标记还在，所以启动扫描认得出
 * [孤儿轮](../../../../docs/terms.md)），这张表回答「是不是**我**在跑、怎么找到它」。
 *
 * **实例级、不是模块级**：一个进程里可以有多个 `AgentRuntime`（多租户、测试并跑），
 * 模块级的 Map 会让它们互相踩。
 */
import type { RunkoChunk } from "@runko/core";
import type { HumanDecision, JsonValue } from "@runko/core";

import type { Grant } from "../arbitration.js";
import type { TurnInput, TurnPhase } from "../types.js";

/** 一次 `ask-user` 的结局——`timeout` 永不带 `answer`，同 `HumanDecision` 的 deny 分支不要求 `message`。 */
export type AskUserOutcome = { outcome: "answered"; answer: string } | { outcome: "timeout" };

/** 一个挂起中的人审/提问：一个 resolve + 一个超时定时器。 */
export interface PendingEntry<T> {
  resolve: (value: T) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 人审多带一次调用的 `toolName`/`input`——结清时要连同它们一起落进裁决表留底。 */
export interface ReviewPendingEntry extends PendingEntry<HumanDecision> {
  toolName: string;
  input: JsonValue;
}

export interface QuestionPendingEntry extends PendingEntry<AskUserOutcome> {
  question: string;
}

export interface ActiveTurn {
  conversationId: string;
  /**
   * `preparing` = [起轮占位](../../../../docs/terms.md)：从装配的第一行代码起这一轮就算
   * **存在**，于是它可以被[停止](../../../../docs/terms.md)、同会话后来的消息也会走
   * [排队](../../../../docs/terms.md)。装配跑完**原地**升级成 `running`（同一个对象、同一个
   * `abortController`——不是「删占位再登记」，那中间又是一个新空窗）。
   */
  phase: TurnPhase;
  /** 这次租期的句柄。收尾时 `release()`，[起轮标记](../../../../docs/terms.md)随之抹掉。 */
  grant: Grant;
  /** 这一轮的中止闸门——起轮那一刻就绪，装配跑完原样交给 core。 */
  abortController: AbortController;
  /**
   * 已请求[停止](../../../../docs/terms.md)。两个用途：`abort` 的幂等判定，以及
   * 「别再挂新的人审」的闸门——停止之后 core 若还为同一步里其它并行工具调用请求人审，
   * 那些请求必须立即被拒，否则它们会各自挂到自己的超时，把「停止」拖成「四分钟后停止」。
   */
  aborted: boolean;
  /**
   * 中止理由。存成字符串而不是去读 `signal.reason`——后者在类型上是 `any`，读它等于
   * 在业务代码里开一个 `any` 的口子（本仓 TS 规范明令避免）。
   */
  abortReason: string | undefined;
  /** [进行中草稿](../../../../docs/terms.md)：本轮至今的全部耐久 chunk，按到达顺序。这一轮结束时随它一起丢掉。 */
  draft: RunkoChunk[];
  /** 绑到这一轮自己的 `session.steer`；`preparing` 阶段是 `undefined`（还没有 session 可绑）。 */
  steer: ((input: string) => boolean) | undefined;
  pendingReviews: Map<string, ReviewPendingEntry>;
  pendingQuestions: Map<string, QuestionPendingEntry>;
  /** 这一轮的输入（收尾通知要用）。 */
  input: TurnInput;
  turnNumber: number;
  done: boolean;
  /** 收尾完成——[优雅关闭](../../../../docs/terms.md)等的就是它。 */
  settled: Promise<void>;
  markSettled: () => void;
}

export class TurnRegistry {
  private readonly turns = new Map<string, ActiveTurn>();

  get(conversationId: string): ActiveTurn | undefined {
    return this.turns.get(conversationId);
  }

  has(conversationId: string): boolean {
    return this.turns.has(conversationId);
  }

  set(turn: ActiveTurn): void {
    this.turns.set(turn.conversationId, turn);
  }

  /** 只有登记的还是**这一个**对象时才删——防止误删已经被下一轮取代的位子。 */
  delete(turn: ActiveTurn): void {
    if (this.turns.get(turn.conversationId) === turn) {this.turns.delete(turn.conversationId);}
  }

  snapshot(): ActiveTurn[] {
    return [...this.turns.values()];
  }

  get size(): number {
    return this.turns.size;
  }
}

/** 建一个还没开始装配的[起轮占位](../../../../docs/terms.md)。 */
export function createActiveTurn(opts: {
  conversationId: string;
  grant: Grant;
  input: TurnInput;
  turnNumber: number;
}): ActiveTurn {
  const abortController = new AbortController();
  let markSettled = (): void => undefined;
  const settled = new Promise<void>((resolve) => {
    markSettled = resolve;
  });
  return {
    conversationId: opts.conversationId,
    phase: "preparing",
    grant: opts.grant,
    abortController,
    aborted: false,
    abortReason: undefined,
    draft: [],
    steer: undefined,
    pendingReviews: new Map(),
    pendingQuestions: new Map(),
    input: opts.input,
    turnNumber: opts.turnNumber,
    done: false,
    settled,
    markSettled,
  };
}
