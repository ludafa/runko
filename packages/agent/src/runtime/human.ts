/**
 * 两条**人在回路**的通道——[人审](../../../../docs/terms.md)（审批链）与 `ask-user`
 * （反问用户）。结构上是一对孪生兄弟：都在这一轮的 `ActiveTurn` 上挂一个 pending 项，
 * 让 core 的 loop `await` 住，等一个人（或超时）来结掉它。
 *
 * **一个直播帧都不发**：挂起中这件事的可见性是 core 自己的 `tool-approval-request`
 * chunk（loop 是**先 yield 它、再 `await onReview`**，所以人一被需要那一刻它已经在线上
 * 了），结果的可见性是随后的 `tool-approval-response`。两者都随 `session.stream()` 正常
 * 流转，本文件不需要（也绝不该）再宣告一遍——多发一遍就是两份互相打架的状态。
 * `ask-user` 同理：它挂起/已答的状态就是 `tool-ask-user` 部件自己的
 * `input-available`/`output-available`，在 loop 眼里就是一次普通工具调用。
 *
 * 它比 chat 应用原先那版多做一件事：**裁决落[裁决表](../../../../docs/terms.md)留底**
 * （请求时记一条待定、结清时补上结局）。当前是纯审计表——人的答复走的是下面这条内存
 * promise 路由，不是读库；落库是为了留底与将来的[挂起](../../../../docs/terms.md)恢复。
 */
import type { HumanDecision, JsonValue } from "@nimbo/core";

import type { Logger } from "../logger.js";
import { describeError } from "../logger.js";
import type { DecisionStore } from "../persistence.js";
import type { AskUserOutcome, ActiveTurn, PendingEntry, TurnRegistry } from "./registry.js";
import { ABORT_DENY_MESSAGE } from "./reasons.js";

const LOG_SCOPE = "agent:human";

export interface HumanBridgeOptions {
  registry: TurnRegistry;
  decisions: DecisionStore;
  approvalTimeoutMs: number;
  askUserTimeoutMs: number;
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
  timeoutMs: number;
}

export interface QuestionPendingEvent {
  conversationId: string;
  callId: string;
  question: string;
  options?: string[];
  userId?: string;
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

/** 结清一条挂起项：取消超时、从 Map 移除，把它交回给调用方去 settle。 */
function takePending<T>(pending: Map<string, PendingEntry<T>>, callId: string): PendingEntry<T> | undefined {
  const entry = pending.get(callId);
  if (entry === undefined) {return undefined;}
  clearTimeout(entry.timer);
  pending.delete(callId);
  return entry;
}

export class HumanBridge {
  private readonly opts: HumanBridgeOptions;

  constructor(opts: HumanBridgeOptions) {
    this.opts = opts;
  }

  /**
   * core 的 loop 解析出 `review` 后调它——返回的 promise 正是 loop 在 `await` 的那个，
   * 所以这一轮的执行是真的挂起了（不是轮询）。
   *
   * 两条**立即拒绝、不注册挂起项**的路：没有活跃轮（防御性，正常走不到），以及这一轮
   * 已被停止——后者要紧：不拦的话这个请求会挂到自己的超时（默认 240 秒）才动，把
   * 「停止」拖成「四分钟后停止」。
   */
  requestReview(conversationId: string, req: { callId: string; toolName: string; input: JsonValue }): Promise<HumanDecision> {
    const turn = this.opts.registry.get(conversationId);
    if (turn === undefined) {
      return Promise.resolve({ behavior: "deny", message: "No active turn to route this approval request to." });
    }
    if (turn.aborted) {
      return Promise.resolve({ behavior: "deny", message: ABORT_DENY_MESSAGE });
    }

    const timeoutMs = this.opts.approvalTimeoutMs;
    const requestedAt = Date.now();
    // 留底先行、但**不 await**：落库慢或失败都不该拖住（更不该阻断）人审这条主路。
    void this.opts.decisions
      .record({
        conversationId,
        toolCallId: req.callId,
        kind: "approval",
        toolName: req.toolName,
        payload: req.input,
        requestedAt,
      })
      .catch((error: unknown) => {
        this.opts.logger.warn(LOG_SCOPE, "failed to record pending decision", {
          conversationId,
          callId: req.callId,
          error: describeError(error),
        });
      });

    const promise = new Promise<HumanDecision>((resolve) => {
      const timer = setTimeout(() => {
        void this.settleReview(conversationId, req.callId, {
          outcome: "deny",
          message: `Approval request timed out after ${String(timeoutMs)}ms with no response.`,
        });
      }, timeoutMs);
      turn.pendingReviews.set(req.callId, { resolve, timer, toolName: req.toolName, input: req.input });
    });

    this.notify(() => {
      this.opts.onApprovalPending?.({
        conversationId,
        callId: req.callId,
        toolName: req.toolName,
        input: req.input,
        ...(turn.input.userId !== undefined ? { userId: turn.input.userId } : {}),
        timeoutMs,
      });
    });

    return promise;
  }

  /** 同 `requestReview`，`ask-user` 那一侧。 */
  requestAnswer(conversationId: string, req: { callId: string; question: string; options?: string[] }): Promise<AskUserOutcome> {
    const turn = this.opts.registry.get(conversationId);
    if (turn === undefined || turn.aborted) {return Promise.resolve({ outcome: "timeout" });}

    const timeoutMs = this.opts.askUserTimeoutMs;
    const requestedAt = Date.now();
    void this.opts.decisions
      .record({
        conversationId,
        toolCallId: req.callId,
        kind: "question",
        payload: req.question,
        requestedAt,
      })
      .catch((error: unknown) => {
        this.opts.logger.warn(LOG_SCOPE, "failed to record pending question", {
          conversationId,
          callId: req.callId,
          error: describeError(error),
        });
      });

    const promise = new Promise<AskUserOutcome>((resolve) => {
      const timer = setTimeout(() => {
        void this.settleQuestion(conversationId, req.callId, { outcome: "timeout" });
      }, timeoutMs);
      turn.pendingQuestions.set(req.callId, { resolve, timer, question: req.question });
    });

    this.notify(() => {
      this.opts.onQuestionPending?.({
        conversationId,
        callId: req.callId,
        question: req.question,
        ...(req.options !== undefined ? { options: req.options } : {}),
        ...(turn.input.userId !== undefined ? { userId: turn.input.userId } : {}),
        timeoutMs,
      });
    });

    return promise;
  }

  /**
   * 人（或超时）那一侧：`false` = 没有这条挂起项可结（已结、已超时、从未存在）——
   * [接入层](../../../../docs/terms.md)据此转 404。
   *
   * **超时与人工裁决走的是同一个方法**，所以重连的客户端分辨不出两者——这是刻意的。
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

  async settleQuestion(conversationId: string, callId: string, outcome: AskUserOutcome): Promise<boolean> {
    const turn = this.opts.registry.get(conversationId);
    if (turn === undefined) {return false;}
    return await this.settleQuestionOn(turn, callId, outcome);
  }

  /** 同上，但直接对着给定的那一轮结清。 */
  private async settleQuestionOn(turn: ActiveTurn, callId: string, outcome: AskUserOutcome): Promise<boolean> {
    const conversationId = turn.conversationId;
    const pending = takePending(turn.pendingQuestions, callId);
    if (pending === undefined) {return false;}

    await this.recordSettlement(conversationId, callId, {
      outcome: outcome.outcome === "answered" ? "answered" : "timeout",
      ...(outcome.outcome === "answered" ? { message: outcome.answer } : {}),
      decidedAt: Date.now(),
    });

    pending.resolve(outcome);
    return true;
  }

  /**
   * 一轮被[停止](../../../../docs/terms.md)或收尾时，把还挂着的都就地结掉。
   *
   * 这是整个功能里**唯一一处「光有 abort 信号不够」**的地方：core 正 `await` 的是一个
   * 普通 promise，abort 信号对它毫无作用。快照 key 再遍历——`settle*` 会就地删 Map 条目，
   * 不能边删边迭代。
   *
   * **对着形参那一轮结清，不按 conversationId 回查登记表**：两者可能已经不是同一个对象
   * （这一轮刚收尾、位子被下一轮顶替），那样会去拒掉**另一轮**的挂起项，而传进来这一轮
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
