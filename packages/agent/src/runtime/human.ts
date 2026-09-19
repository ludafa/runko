/**
 * 两条**人在回路**的通道——[人审](../../../../docs/terms.md)（审批链）与 `ask-user`（反问用户）。
 * 结构上是一对孪生兄弟：都在这一轮的 `ActiveTurn` 上挂一个[等人项](../../../../docs/terms.md)，
 * 让 core 的 loop `await` 住，等人来答，或等满[内存窗口](../../../../docs/terms.md)后
 * [挂起](../../../../docs/terms.md)。
 *
 * **一个直播帧都不发**：等人这件事的可见性是 core 自己的 `tool-approval-request`
 * chunk（loop 是**先 yield 它、再 `await onReview`**，所以人一被需要那一刻它已经在线上
 * 了），结果的可见性是随后的 `tool-approval-response`。两者都随 `session.stream()` 正常
 * 流转，本文件不需要（也绝不该）再宣告一遍——多发一遍就是两份互相打架的状态。
 * `ask-user` 同理：它等人/已答的状态就是 `tool-ask-user` 部件自己的
 * `input-available`/`output-available`，在 loop 眼里就是一次普通工具调用。
 *
 * 每一项都登记进[裁决表](../../../../docs/terms.md)：请求时记一条待定、结清时补上结局。内存窗口里，
 * 人的答复走下面这条内存 promise 路由，不读库；挂起之后，答案写进那一行，由恢复轮读回。
 */
import type { HumanDecision, JsonValue } from "@runko/core";

import type { Logger } from "../logger.js";
import { describeError } from "../logger.js";
import type { DecisionStore } from "../persistence.js";
import type { AskUserOutcome, ActiveTurn, PendingEntry, TurnRegistry } from "./registry.js";
import { ABORT_DENY_MESSAGE, UNRECORDED_DENY_MESSAGE } from "./reasons.js";
import type { SuspendReason } from "./reasons.js";

const LOG_SCOPE = "agent:human";

export interface HumanBridgeOptions {
  registry: TurnRegistry;
  decisions: DecisionStore;
  /** 审批这一路的[内存窗口](../../../../docs/terms.md)（毫秒）。`0` = 一等人就挂起，不起定时器。 */
  approvalWindowMs: number;
  /** `ask-user` 这一路的内存窗口。两路分开，只是为了让旧的两个超时参数能各自等价映射过来。 */
  questionWindowMs: number;
  logger: Logger;
  onApprovalPending?: (event: ApprovalPendingEvent) => void;
  onQuestionPending?: (event: QuestionPendingEvent) => void;
}

export interface ApprovalPendingEvent {
  conversationId: string;
  callId: string;
  toolName: string;
  input: JsonValue;
  userId?: string;
  /** 这次在内存里会等多久才[挂起](../../../../docs/terms.md)（毫秒）；`0` = 已经立刻挂起了。 */
  timeoutMs: number;
}

export interface QuestionPendingEvent {
  conversationId: string;
  callId: string;
  question: string;
  options?: string[];
  userId?: string;
  /** 同 `ApprovalPendingEvent.timeoutMs`。 */
  timeoutMs: number;
}

/**
 * 人给的答复。
 *
 * `scope: 'conversation'` 说的是**范围**（这个会话内都算数）；宿主 wire 上那个
 * `behavior: 'allow-session'` 说的是**用户点了哪个按钮**（[会话级授权](../../../../docs/terms.md)，
 * 一个产品动作）。两个词分属两层，各自都对——框架只把范围记进裁决表，**不执行**它，
 * 放行与否由宿主自己的授权表决定。
 */
export interface SubmittedDecision {
  outcome: "allow" | "deny";
  scope?: "once" | "conversation";
  decidedBy?: string;
  message?: string;
}

/** 结清一条等人项：取消超时、从 Map 移除，把它交回给调用方去 settle。 */
function takePending<T>(pending: Map<string, PendingEntry<T>>, callId: string): PendingEntry<T> | undefined {
  const entry = pending.get(callId);
  if (entry === undefined) {return undefined;}
  clearTimeout(entry.timer);
  pending.delete(callId);
  return entry;
}

/**
 * ## 等人项有四种解法
 *
 * | 谁解开 | 解成什么 | 写不写裁决表 |
 * |---|---|---|
 * | 人答了 | allow / deny / 答案 | 写——结清那一行 |
 * | 这一轮被停止 | deny / timeout | 写 |
 * | [内存窗口](../../../../docs/terms.md)到点 | **挂起** | **不写**——那一行留着，人回来还要答 |
 * | [交权](../../../../docs/terms.md) | **挂起** | **不写** |
 *
 * 后两种走 `suspendTurn`：它**整轮**挂起，而不是只挂一个——这一轮已经决定收尾了，别的
 * 等人项再各自等一个窗口没有意义。见[挂起与恢复 · 技术方案](../../../../docs/logic/orchestration/tech/suspend-resume.md) §4.2。
 *
 * 例外：那一行**没登记上**时不挂起（`suspendIfRecorded`），退回拒绝 / 「没人回应」。
 */
export class HumanBridge {
  private readonly opts: HumanBridgeOptions;

  constructor(opts: HumanBridgeOptions) {
    this.opts = opts;
  }

  /**
   * core 的 loop 解析出 `review` 后调它——返回的 promise 正是 loop 在 `await` 的那个，
   * 所以这一轮的执行是真的停在这里等人（不是轮询）。
   *
   * 两条**立即拒绝、不注册等人项**的路：没有活跃轮（防御性，正常走不到），以及这一轮
   * 已被停止——后者要紧：不拦的话这个请求会挂满一整个内存窗口才动，把「停止」拖成
   * 「五分钟后停止」。
   *
   * 一条**立即挂起**的路：这一轮已经决定挂起了（`turn.suspending`）。裁决表那一行**照记**
   * ——这次调用会留在账本里等人，人回来答的就是它。
   */
  requestReview(conversationId: string, req: { callId: string; toolName: string; input: JsonValue }): Promise<HumanDecision> {
    const turn = this.opts.registry.get(conversationId);
    if (turn === undefined) {
      return Promise.resolve({ behavior: "deny", message: "No active turn to route this approval request to." });
    }
    if (turn.aborted) {
      return Promise.resolve({ behavior: "deny", message: ABORT_DENY_MESSAGE });
    }

    const windowMs = this.opts.approvalWindowMs;
    // 留底先行、但**不在这里 await**：落库慢或失败都不该拖住弹卡片。结清之前与释放归属之前
    // 才等它（见 `PendingEntry.recorded`）——人要答几秒到几分钟，正常路径上它早就落地了。
    const recorded = this.recordPending(turn, {
      conversationId,
      toolCallId: req.callId,
      kind: "approval",
      toolName: req.toolName,
      payload: req.input,
      requestedAt: Date.now(),
    });

    // 窗口是 0：一等人就挂，不起定时器。走整轮挂起那条路，同一步里后到的等人请求也跟着挂。
    if (windowMs === 0) {this.suspendTurn(turn, "immediate");}
    // 这一轮已经决定挂起：不开新窗口，立刻挂。
    const suspending = turn.suspending;
    const promise =
      suspending !== undefined
        ? this.suspendIfRecorded(recorded, { behavior: "suspend", reason: suspending }, req.callId)
        : new Promise<HumanDecision>((resolve) => {
            const timer = this.startWindow(turn, windowMs);
            turn.pendingReviews.set(req.callId, { resolve, timer, recorded, toolName: req.toolName, input: req.input });
          });

    // 立刻挂起的也要通知：人得知道有一张卡片等着他答（推送就靠这个）。
    this.notify(() => {
      this.opts.onApprovalPending?.({
        conversationId,
        callId: req.callId,
        toolName: req.toolName,
        input: req.input,
        ...(turn.input.userId !== undefined ? { userId: turn.input.userId } : {}),
        timeoutMs: suspending !== undefined ? 0 : windowMs,
      });
    });

    return promise;
  }

  /** 同 `requestReview`，`ask-user` 那一侧。 */
  requestAnswer(conversationId: string, req: { callId: string; question: string; options?: string[] }): Promise<AskUserOutcome> {
    const turn = this.opts.registry.get(conversationId);
    if (turn === undefined || turn.aborted) {return Promise.resolve({ outcome: "timeout" });}

    const windowMs = this.opts.questionWindowMs;
    const recorded = this.recordPending(turn, {
      conversationId,
      toolCallId: req.callId,
      kind: "question",
      payload: req.question,
      requestedAt: Date.now(),
    });

    if (windowMs === 0) {this.suspendTurn(turn, "immediate");}
    const suspending = turn.suspending;
    const promise =
      suspending !== undefined
        ? this.suspendIfRecorded(recorded, { outcome: "suspended", reason: suspending }, req.callId)
        : new Promise<AskUserOutcome>((resolve) => {
            const timer = this.startWindow(turn, windowMs);
            turn.pendingQuestions.set(req.callId, { resolve, timer, recorded, question: req.question });
          });

    this.notify(() => {
      this.opts.onQuestionPending?.({
        conversationId,
        callId: req.callId,
        question: req.question,
        ...(req.options !== undefined ? { options: req.options } : {}),
        ...(turn.input.userId !== undefined ? { userId: turn.input.userId } : {}),
        timeoutMs: suspending !== undefined ? 0 : windowMs,
      });
    });

    return promise;
  }

  /**
   * [在场](../../../../docs/terms.md)续期：把这一轮每个等人项的定时器重置成「从现在起一个完整窗口」。
   *
   * 同步、不落库——调用频率是每个在场用户每 20 秒一次，走一次 IO 是白花钱。没有轮在跑、或这一轮
   * 不在等人（包括已经决定挂起、已被停止）时什么都不做：调用方是个定时心跳，没法判断这些。
   */
  reportPresence(conversationId: string): void {
    const turn = this.opts.registry.get(conversationId);
    if (turn === undefined || turn.aborted || turn.suspending !== undefined) {return;}
    for (const entry of turn.pendingReviews.values()) {
      clearTimeout(entry.timer);
      entry.timer = this.startWindow(turn, this.opts.approvalWindowMs);
    }
    for (const entry of turn.pendingQuestions.values()) {
      clearTimeout(entry.timer);
      entry.timer = this.startWindow(turn, this.opts.questionWindowMs);
    }
  }

  /** 开一个内存窗口。到点**整轮挂起**，不是只结这一条——见文件头那张表。 */
  private startWindow(turn: ActiveTurn, windowMs: number): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      this.suspendTurn(turn, "timeout");
    }, windowMs);
  }

  /**
   * 人那一侧：`false` = 本进程内存里没有这条等人项可结（已结、已挂起、从未存在）——
   * [接入层](../../../../docs/terms.md)据此转 404。
   *
   * 窗口到点**不走这里**（那条路是挂起，不结裁决表），所以这个方法只由人的答复和停止触发。
   */
  async settleReview(conversationId: string, callId: string, decision: SubmittedDecision): Promise<boolean> {
    const turn = this.opts.registry.get(conversationId);
    if (turn === undefined) {return false;}
    return await this.settleReviewOn(turn, callId, decision);
  }

  /** 同上，但**直接对着给定的那一轮**结清，不再按 conversationId 回查登记表。 */
  private async settleReviewOn(turn: ActiveTurn, callId: string, decision: SubmittedDecision): Promise<boolean> {
    const conversationId = turn.conversationId;
    const pending = takePending(turn.pendingReviews, callId);
    if (pending === undefined) {return false;}

    await pending.recorded;
    await this.recordSettlement(conversationId, callId, {
      outcome: decision.outcome,
      ...(decision.scope !== undefined ? { scope: decision.scope } : {}),
      ...(decision.decidedBy !== undefined ? { decidedBy: decision.decidedBy } : {}),
      ...(decision.message !== undefined ? { message: decision.message } : {}),
      decidedAt: Date.now(),
    });

    pending.resolve(
      decision.outcome === "allow"
        ? { behavior: "allow" }
        : { behavior: "deny", ...(decision.message !== undefined ? { message: decision.message } : {}) },
    );
    return true;
  }

  async settleQuestion(conversationId: string, callId: string, outcome: AskUserOutcome, decidedBy?: string): Promise<boolean> {
    const turn = this.opts.registry.get(conversationId);
    if (turn === undefined) {return false;}
    return await this.settleQuestionOn(turn, callId, outcome, decidedBy);
  }

  /** 同上，但直接对着给定的那一轮结清。 */
  private async settleQuestionOn(turn: ActiveTurn, callId: string, outcome: AskUserOutcome, decidedBy?: string): Promise<boolean> {
    const conversationId = turn.conversationId;
    const pending = takePending(turn.pendingQuestions, callId);
    if (pending === undefined) {return false;}

    await pending.recorded;
    await this.recordSettlement(conversationId, callId, {
      outcome: outcome.outcome === "answered" ? "answered" : "timeout",
      ...(outcome.outcome === "answered" ? { message: outcome.answer } : {}),
      ...(decidedBy !== undefined ? { decidedBy } : {}),
      decidedAt: Date.now(),
    });

    pending.resolve(outcome);
    return true;
  }

  /**
   * 这一轮[挂起](../../../../docs/terms.md)：把还挂着的等人项**全部**解成「挂起」，并关上闸门——
   * 此后同一轮里再来的等人请求立刻挂起（`turn.suspending`）。
   *
   * **一个字都不写裁决表。** 那几行保持未结清（`decidedAt` 为空），这正是人回来时「这条还
   * 悬着」的判据。写了就等于替人答了——这是本方法与 `settleAllPending` 唯一、也是全部的区别。
   *
   * 同步、幂等：理由以第一次为准（窗口到点之后又碰上交权，这一轮仍记 `timeout`）。
   */
  suspendTurn(turn: ActiveTurn, reason: SuspendReason): void {
    turn.suspending ??= reason;
    const settled = turn.suspending;
    for (const callId of [...turn.pendingReviews.keys()]) {
      const entry = takePending(turn.pendingReviews, callId);
      if (entry !== undefined) {void this.suspendIfRecorded(entry.recorded, { behavior: "suspend", reason: settled }, callId).then(entry.resolve);}
    }
    for (const callId of [...turn.pendingQuestions.keys()]) {
      const entry = takePending(turn.pendingQuestions, callId);
      if (entry !== undefined) {void this.suspendIfRecorded(entry.recorded, { outcome: "suspended", reason: settled }, callId).then(entry.resolve);}
    }
  }

  /**
   * 挂起的前提是**裁决表那一行已经登记上**：人回来答的就是那一行，没有它就永远没人能答，这个会话
   * 也再开不了普通轮。登记失败时退回窗口到点的老结局——审批按拒绝、提问按「没人回应」——让这一轮
   * 照常往下走。
   */
  private async suspendIfRecorded(recorded: Promise<boolean>, suspend: HumanDecision, callId: string): Promise<HumanDecision>;
  private async suspendIfRecorded(recorded: Promise<boolean>, suspend: AskUserOutcome, callId: string): Promise<AskUserOutcome>;
  private async suspendIfRecorded(
    recorded: Promise<boolean>,
    suspend: HumanDecision | AskUserOutcome,
    callId: string,
  ): Promise<HumanDecision | AskUserOutcome> {
    if (await recorded) {return suspend;}
    this.opts.logger.warn(LOG_SCOPE, "pending decision was not recorded, so this call cannot be suspended; ending the wait instead", { callId });
    return "behavior" in suspend ? { behavior: "deny", message: UNRECORDED_DENY_MESSAGE } : { outcome: "timeout" };
  }

  /**
   * 一轮被[停止](../../../../docs/terms.md)或收尾时，把还挂着的都就地结掉。
   *
   * 这是整个功能里**唯一一处「光有 abort 信号不够」**的地方：core 正 `await` 的是一个
   * 普通 promise，abort 信号对它毫无作用。快照 key 再遍历——`settle*` 会就地删 Map 条目，
   * 不能边删边迭代。
   *
   * **对着形参那一轮结清，不按 conversationId 回查登记表**：两者可能已经不是同一个对象
   * （这一轮刚收尾、位子被下一轮顶替），那样会去拒掉**另一轮**的等人项，而传进来这一轮
   * 的反倒留着——正是这个方法要防的那件事。
   */
  async settleAllPending(turn: ActiveTurn, reason: string): Promise<void> {
    const reviewIds = [...turn.pendingReviews.keys()];
    const questionIds = [...turn.pendingQuestions.keys()];
    for (const callId of reviewIds) {
      await this.settleReviewOn(turn, callId, { outcome: "deny", message: reason });
    }
    for (const callId of questionIds) {
      await this.settleQuestionOn(turn, callId, { outcome: "timeout" });
    }
  }

  /**
   * 登记一条待定裁决，返回写没写成（从不 reject），并挂到这一轮的 `decisionWrites` 上。
   * 失败只记一行：落库失败不该阻断人审这条主路——但这次调用从此不能挂起（`suspendIfRecorded`）。
   */
  private recordPending(turn: ActiveTurn, entry: Parameters<DecisionStore["record"]>[0]): Promise<boolean> {
    const write = this.opts.decisions.record(entry).then(
      () => true,
      (error: unknown) => {
        this.opts.logger.warn(LOG_SCOPE, "failed to record pending decision", {
          conversationId: entry.conversationId,
          callId: entry.toolCallId,
          kind: entry.kind,
          error: describeError(error),
        });
        return false;
      },
    );
    turn.decisionWrites.push(write.then(() => undefined));
    return write;
  }

  private async recordSettlement(
    conversationId: string,
    callId: string,
    settlement: Parameters<DecisionStore["settle"]>[2],
  ): Promise<void> {
    try {
      await this.opts.decisions.settle(conversationId, callId, settlement);
    } catch (error) {
      // 留底失败绝不能吞掉人的答复——那会让这一轮永远挂着。记一行，继续。
      this.opts.logger.warn(LOG_SCOPE, "failed to settle decision record", {
        conversationId,
        callId,
        error: describeError(error),
      });
    }
  }

  /** 宿主钩子（推送通知等）抛错不该污染这一轮——就地吞掉并记一行。 */
  private notify(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.opts.logger.error(LOG_SCOPE, "human bridge hook threw", { error: describeError(error) });
    }
  }
}
