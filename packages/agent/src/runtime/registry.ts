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
import type { HumanDecision, JsonValue, Settlement } from "@runko/core";

import type { Grant, Takeover } from "../arbitration.js";
import type { TurnInput, TurnPhase, TurnStatus } from "../types.js";
import type { SuspendReason } from "./reasons.js";

/**
 * 一次 `ask-user` 的结局。
 *
 * - `answered`：人答了。
 * - `suspended`：等不到人，这一轮要[挂起](../../../../docs/terms.md)——`ask-user` 据此调 `ctx.suspend()`。
 * - `timeout`：不会再有人答了——这一轮已经被停止、根本没有在跑的轮，或者裁决表那一行没登记上
 *   （不能挂起）。等人等太久**不走**这一支，那走 `suspended`。
 */
export type AskUserOutcome =
  | { outcome: "answered"; answer: string }
  | { outcome: "suspended"; reason: SuspendReason }
  | { outcome: "timeout" };

/** 一个[等人项](../../../../docs/terms.md)：一个 resolve + 内存窗口的定时器 + 它那一行裁决表的登记。 */
export interface PendingEntry<T> {
  resolve: (value: T) => void;
  /** 内存窗口的定时器，到点整轮挂起。[在场](../../../../docs/terms.md)上报会把它换成一个新的。 */
  timer: ReturnType<typeof setTimeout>;
  /**
   * 登记那一行的写入（从不 reject——失败在里面记日志）。**结清之前必须先等它**：连接池下登记的
   * INSERT 与结清的 UPDATE 可能走不同连接、到达顺序不保证，UPDATE 先到就匹配 0 行，INSERT 随后
   * 落地，留下一条永远待定的行（技术方案 §11.2）。
   */
  recorded: Promise<boolean>;
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
  /**
   * 这一轮接下的全部插话，按到达顺序。core 按先进先出注入，所以前 `steersDelivered` 条已经进了
   * 账本，其余的只活在这一轮的内存里——这一轮以[挂起](../../../../docs/terms.md)收尾时要把它们转进
   * 待发队列，否则用户被告知「插进去了」的话就这么没了。
   */
  steered: TurnInput[];
  /** 已经注入账本的插话条数，落盘时（`finalize`）数出来。 */
  steersDelivered: number;
  pendingReviews: Map<string, ReviewPendingEntry>;
  pendingQuestions: Map<string, QuestionPendingEntry>;
  /**
   * 这一轮已决定[挂起](../../../../docs/terms.md)（及理由）。一旦设上就不再撤：
   *
   * - 设它的那一刻，所有还挂着的等人项被一起解成「挂起」（`HumanBridge.suspendTurn`）；
   * - 之后**同一轮里再来的**等人请求也立刻解成挂起，不再等一个新窗口——串行的下一个审批不该
   *   让已经决定收尾的这一轮再多等五分钟。
   *
   * 与 `aborted` 是两道不同的闸：停止把等人项解成**拒绝**并写进裁决表；挂起解成**挂起**、
   * 裁决表那一行**留着不结**——人回来还要答。
   */
  suspending: SuspendReason | undefined;
  /**
   * 这一轮发出去的全部裁决表登记（从不 reject）。收尾时**释放归属之前**等齐：挂起之后别的副本
   * 随时可能来恢复，它要读的那几行必须已经在库里。
   */
  decisionWrites: Promise<void>[];
  /** 这一轮的输入（收尾通知要用）。 */
  input: TurnInput;
  /**
   * 起轮时顶掉了一个过期持有者（`AcquireResult.takeover`）。有它，驱动之前要先替**上一轮**补一条
   * 「已停止」——上一个持有者崩了或卡住了，自己写不了收尾。可选：测试夹具与不报它的仲裁都不用改。
   */
  takeover?: Takeover;
  /**
   * 这是一轮[恢复](../../../../docs/terms.md)：结清哪次悬空调用、用什么结清（答案从裁决表读来）。
   * 没有它就是普通轮。恢复轮不追加用户消息、调的是 `session.settleAndRun`、收尾从被改写的那条
   * 开始落盘——见[挂起与恢复 · 技术方案](../../../../docs/logic/orchestration/tech/suspend-resume.md) §5.8。
   */
  resume?: { callId: string; settlement: Settlement };
  turnNumber: number;
  done: boolean;
  /** 这一轮是怎么结束的；`done` 置上的同时写入。交权据此只把 `completed` 算作「自然跑完」。 */
  endStatus?: TurnStatus;
  /** 收尾完成——[优雅关闭](../../../../docs/terms.md)等的就是它。 */
  settled: Promise<void>;
  markSettled: () => void;
}

export class TurnRegistry {
  private readonly turns = new Map<string, ActiveTurn>();

  /**
   * 本进程最近一次抢到[归属](../../../../docs/terms.md)时用的 `holder` 字符串。
   *
   * `subscribe` 拿它把两件长得一样的事分开：**「我自己那一轮正在收尾」**（收尾是先删
   * 登记表、再释放归属，中间那一小段登记表已经查不到、归属却还在）与**「归属真在别的
   * 副本上」**。不分开的话，收尾窗口里的订阅者会拿到一帧「还在跑」然后流立刻断掉——
   * 那正是它用来关掉转圈动画的那一帧。释放失败时这段窗口会一直拖到租约过期。
   *
   * 放在登记表上而不是另开一个字段：它讲的就是「本进程的轮」这件事，而且**这样测试
   * 夹具不用改**——它们本来就在造这个对象。
   */
  lastHolder: string | undefined;

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
  takeover?: Takeover;
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
    steered: [],
    steersDelivered: 0,
    pendingReviews: new Map(),
    pendingQuestions: new Map(),
    suspending: undefined,
    decisionWrites: [],
    input: opts.input,
    ...(opts.takeover !== undefined ? { takeover: opts.takeover } : {}),
    turnNumber: opts.turnNumber,
    done: false,
    settled,
    markSettled,
  };
}
