/**
 * 挂起本轮的出口——[挂起](../../../docs/terms.md)在 core 这一侧的全部机制。
 *
 * 工具在 `execute` 里调 `ctx.suspend()`，意思是「这次调用停在一个干净边界上等外部输入，
 * 本轮到此为止」。典型的调用者是 `ask-user`：内存窗口内拿到答案就正常返回，等不到就走这里。
 *
 * 它做两件事：在**这一次调用**的上下文里打一个标记，然后抛 `SuspendSignal` 断开控制流。
 *
 * ## 判据是标记，不是这个异常
 *
 * 工具里一句 `try { ... } catch { return "先跳过" }` 就能把异常吃掉。标记还在，
 * `executeToolCall` 照样返回挂起，那个垫场返回值被丢掉。异常只负责让 `execute` 立刻停下。
 *
 * ## 为什么不继承 `Error`
 *
 * `catch (e) { if (e instanceof Error) ... }` 这类写法会自然放过它；日志与错误上报也不会
 * 把它当成一次故障。
 *
 * ## 为什么是抛异常，不是返回一个哨兵值
 *
 * 哨兵值会被工具自己的包装层吃掉——`const raw = await ask(); return format(raw);` 一写，
 * 哨兵就被 `format` 加工成垃圾了。挂起不是「这次调用的一种结果」，是「不产生结果、整轮停下」，
 * 不该经过中间层加工。完整取舍见
 * [挂起与恢复 · 技术方案](../../../docs/logic/orchestration/tech/suspend-resume.md) §3.4。
 */

import { isStaticToolUIPart } from "ai";
import type { ToolUIPart, UITools } from "ai";
import type { RunkoUIMessage } from "./state.js";
import type { ToolReturn } from "./types.js";

/** `ctx.suspend()` 抛出的东西。**刻意不继承 `Error`**，理由见本文件头。 */
export class SuspendSignal {
  /**
   * 宿主给的理由（`"timeout"` / `"handover"` 这类）。
   *
   * **core 只透传，不认识它的含义**——「为什么挂起」是宿主的概念，同 `abortMessage`
   * 对待中止理由的姿态一致。它最终落进收尾 metadata 的 `suspended.reason`。
   */
  readonly reason: string | undefined;

  constructor(reason?: string) {
    this.reason = reason;
  }
}

export function isSuspendSignal(value: unknown): value is SuspendSignal {
  return value instanceof SuspendSignal;
}

/**
 * 一次工具调用的挂起标记。
 *
 * `executeToolCall` 每次调用现场造一个，只交给那一次的 `ctx`——所以同一个工具在同一步里的
 * 两次调用互不影响。
 */
export interface SuspendRequest {
  requested: boolean;
  reason: string | undefined;
}

export function createSuspendRequest(): SuspendRequest {
  return { requested: false, reason: undefined };
}

/** `ToolContext.suspend` 的实现：先打标记，再抛。两步的顺序是硬要求——反了标记就不会被写上。 */
export function requestSuspend(request: SuspendRequest, reason?: string): never {
  request.requested = true;
  request.reason = reason;
  throw new SuspendSignal(reason);
}

// ============================================================================
// 恢复（settleAndRun）用的类型与判定——设计见
// [挂起与恢复 · 技术方案](../../../docs/logic/orchestration/tech/suspend-resume.md) §5。
// ============================================================================

/**
 * 恢复一次悬空调用时给的东西。它要跟那条部件的状态对得上（技术方案 §5.2 的表）：
 *
 * | 部件停在 | 接受 |
 * |---|---|
 * | `approval-requested`（人审通道答了 suspend） | `approval` |
 * | `input-available`（工具调了 `ctx.suspend()`，或交权时还在跑） | `output` / `error` |
 * | `approval-responded`（审批通过后执行时又挂起，或交权时还在跑） | `output` / `error` |
 *
 * **叫 `output` 不叫 `answer`**：`ctx.suspend()` 谁都能调，它等的是「这次调用的输出」，
 * `ask-user` 的答案只是其中一种。
 */
export type Settlement =
  | { kind: "approval"; behavior: "allow" }
  | { kind: "approval"; behavior: "deny"; message?: string }
  | { kind: "output"; output: ToolReturn }
  /**
   * 这次调用**执行过但失败了**，`errorText` 交给模型。部件写成 `output-error`。
   *
   * 它来自[工具收尾](../../../docs/terms.md)：工具在交权之后留在旧节点上跑完，结果可能是失败
   * （或者旧节点没按时写回，只能记成「结果未知」）。接受它的部件状态与 `output` 相同。
   */
  | { kind: "error"; errorText: string };

/** 一次调用在别处跑完之后带回来的结果——`Settlement` 里「执行过」的那两种。 */
export type CallOutcome = Extract<Settlement, { kind: "output" | "error" }>;

export type RunkoResumeErrorCode =
  /** `stream()` 时最后一条消息里还有悬空调用——这时只能 `settleAndRun`。 */
  | "pending_calls"
  /** `settleAndRun` 的 callId 不在最后一条消息里。 */
  | "call_not_found"
  /** 找到了，但它已经有结果了（重复恢复）。 */
  | "not_pending"
  /** 部件状态与 `Settlement` 的种类对不上。 */
  | "settlement_mismatch";

/**
 * 开恢复轮（或在有悬空调用时开普通轮）用错了。
 *
 * 这是**调用方的 bug**，不是这一轮「失败」：抛出时不 `turn += 1`、不产出任何 chunk，
 * 同 `SessionOptions.resume` 非法时同步抛的姿态。**它继承 `Error`**——与 `SuspendSignal`
 * 相反，这是真故障，就该被当成故障。
 */
export class RunkoResumeError extends Error {
  readonly code: RunkoResumeErrorCode;

  constructor(code: RunkoResumeErrorCode, message: string) {
    super(message);
    this.name = "RunkoResumeError";
    this.code = code;
  }
}

type RunkoToolPart = ToolUIPart<UITools>;

/**
 * 一个工具部件是不是**悬空**的：调用发出去了、还没有结果。
 *
 * `approval-responded` 只有**批准了**才算：批准之后才挂起的调用（比如执行时又等人）还要执行。
 * 被拒的那种不会再执行，它只是改写成 `output-denied` 之前的中间态，不能算悬空——算了的话既开不了
 * 普通轮、`resolveResumeTarget` 又不认它，会话就卡死了。
 */
function isPendingState(part: RunkoToolPart): boolean {
  if (part.state === "approval-responded") {return part.approval.approved;}
  return part.state === "approval-requested" || part.state === "input-available";
}

/**
 * 最后一条消息里悬着的 callId，按部件顺序（= 模型发出调用的顺序）。
 *
 * 只看最后一条，因为悬空调用**只能**在那里：它后面再接任何消息，provider 都会 400
 * （技术方案 §5.3 的实测）。宿主可以拿它判断「这个会话现在能不能开普通轮」。
 */
export function pendingCallIds(messages: RunkoUIMessage[]): string[] {
  const last = messages[messages.length - 1];
  if (last === undefined) {return [];}
  const ids: string[] = [];
  for (const part of last.parts) {
    if (isStaticToolUIPart(part) && isPendingState(part)) {ids.push(part.toolCallId);}
  }
  return ids;
}

/** `stream()` 开场前的守卫：有悬空调用就拒绝开普通轮。 */
export function assertNoPendingCalls(messages: RunkoUIMessage[]): void {
  const pending = pendingCallIds(messages);
  if (pending.length === 0) {return;}
  throw new RunkoResumeError(
    "pending_calls",
    `Cannot start a new turn: the last message still has ${String(pending.length)} tool call(s) waiting for a result ` +
      `(${pending.join(", ")}). Settle them first with settleAndRun(). A tool call without a result followed by a new ` +
      "message is rejected by model providers.",
  );
}

/** 恢复要改写的那个部件：在哪条消息、第几个、长什么样。 */
export interface ResumeTarget {
  message: RunkoUIMessage;
  partIndex: number;
  part: RunkoToolPart;
}

function findToolPart(message: RunkoUIMessage, callId: string): { partIndex: number; part: RunkoToolPart } | undefined {
  for (const [partIndex, part] of message.parts.entries()) {
    if (isStaticToolUIPart(part) && part.toolCallId === callId) {return { partIndex, part };}
  }
  return undefined;
}

/**
 * 找到 `settleAndRun` 要结清的那个部件，并确认它能被这个 `Settlement` 结清。任何一条不满足都抛
 * `RunkoResumeError`——它在**开轮之前**调用，抛了就不算一轮。
 */
export function resolveResumeTarget(messages: RunkoUIMessage[], callId: string, settlement: Settlement): ResumeTarget {
  const last = messages[messages.length - 1];
  const found = last?.role === "assistant" ? findToolPart(last, callId) : undefined;

  if (last === undefined || found === undefined) {
    // 不在最后一条里。区分一下：在更早的消息里 → 早就有结果了（悬空调用只能在最后一条）。
    const earlier = messages.some((message) => findToolPart(message, callId) !== undefined);
    if (earlier) {
      throw new RunkoResumeError("not_pending", `Tool call ${callId} already has a result; there is nothing to resume.`);
    }
    throw new RunkoResumeError("call_not_found", `Tool call ${callId} is not in the last message of this session.`);
  }

  const { partIndex, part } = found;
  const mismatch = (expected: Settlement["kind"]): RunkoResumeError =>
    new RunkoResumeError(
      "settlement_mismatch",
      `Tool call ${callId} is waiting in state "${part.state}", which must be settled with kind "${expected}", ` +
        `not "${settlement.kind}".`,
    );

  switch (part.state) {
    case "approval-requested":
      if (settlement.kind !== "approval") {throw mismatch("approval");}
      break;
    case "input-available":
      if (settlement.kind !== "output" && settlement.kind !== "error") {throw mismatch("output");}
      break;
    case "approval-responded":
      // 审批通过之后、执行时工具又调了 `ctx.suspend()`。被拒绝的不会停在这里（deny 分支紧接着就写 output-denied）。
      if (part.approval.approved !== true) {
        throw new RunkoResumeError("not_pending", `Tool call ${callId} was denied; there is nothing to resume.`);
      }
      if (settlement.kind !== "output" && settlement.kind !== "error") {throw mismatch("output");}
      break;
    default:
      throw new RunkoResumeError("not_pending", `Tool call ${callId} already has a result (state "${part.state}").`);
  }
  return { message: last, partIndex, part };
}
