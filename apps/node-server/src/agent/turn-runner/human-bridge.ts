/**
 * 两条**人在环上**的通道——[人审](../../../../../docs/terms.md)（审批链）与 ask-user
 * （反问用户）。结构上是一对孪生兄弟：都在这一轮的 `ActiveTurn` 上挂一个 pending 项，
 * 让 core 的 loop `await` 住，等一个人（或超时）来结掉它。
 *
 * 纯**内存里的 promise 路由**，**一个 `emit` 都不发**（见 `index.ts` 头注释）：
 * 挂起中这件事的可见性是 `@nimbo/core` 自己的 `tool-approval-request` chunk
 * （docs/agent/single-ledger/tech.md §6.1——loop 是先 yield 它、再 `await onReview`，所以人
 * 一被需要那一刻它已经在线上了），结果的可见性则是 loop 随后 yield 的
 * `tool-approval-response`。两者都随 `session.stream()` 正常流转，本文件不需要
 * （也绝不该）再宣告一遍。ask-user 同理：它挂起/已答的状态就是 `tool-ask-user`
 * 部件自己的 `input-available`/`output-available`，在 loop 眼里就是一次普通工具调用。
 */
import type { HumanDecision, JsonValue } from '@nimbo/core';

import { grantSessionApproval } from '../session-grants.js';
import type { Db } from '../store.js';
import { ABORT_DENY_MESSAGE } from './abort-reasons.js';
import type { AskUserOutcome, PendingEntry } from './registry.js';
import { activeTurns } from './registry.js';

/**
 * The one step genuinely identical between the review and ask-user bridges:
 * cancel `callId`'s timeout and remove it from `pending`, handing back the
 * removed entry (or `undefined` if there wasn't one) so the caller can
 * settle its promise — those two differ by bridge (different
 * `HumanDecision`/`AskUserOutcome` payloads), so settling stays in
 * `resolveReview`/`settleQuestion` rather than being folded into this helper
 * too.
 */
function takePending<T>(
  pending: Map<string, PendingEntry<T>>,
  callId: string,
): PendingEntry<T> | undefined {
  const entry = pending.get(callId);
  if (entry === undefined) return undefined;
  clearTimeout(entry.timer);
  pending.delete(callId);
  return entry;
}

// ---------------------------------------------------------------------------
// 审批链 / 人审通道 (docs/agent/single-ledger/tech.md §6.4): `requestReview`
// is what `routes/chat.ts` wires up as the session's `onReview`
// (`ApprovalReviewer`) — `@nimbo/core`'s loop calls it only *after* it has
// already yielded a `tool-approval-request` chunk for a call the session's
// 审批分类器 (`onApproval`, `approval-policy.ts`'s `classifyApproval`)
// resolved to `'review'`; the resulting promise is exactly what the loop is
// `await`ing, so the turn's own execution is genuinely suspended (not
// polling) until `resolveReview` settles it. Neither function touches
// `emit`/`TurnEmitter` — see this file's header for why.
// ---------------------------------------------------------------------------

/**
 * `CHAT_APPROVAL_TIMEOUT_MS`，默认 240000ms——纯产品决策：人多久不理算放弃。
 *
 * 这个值原本还背着「赶在沙盒空闲超时之前把无人应答的审批拒掉」的保命职责，所以取
 * 沙盒空闲超时的 80%。[保活](../../../../../docs/terms.md)接管之后那层耦合没了（等人期间
 * 由适配器按[审批保活预算](../../../../../docs/terms.md)续期，见 docs/host/sandbox-keepalive/tech.md），
 * 数值本身不动。
 */
const DEFAULT_APPROVAL_TIMEOUT_MS = 240_000;

/**
 * 导出给 `turn-launcher.ts`：审批通知的存活时长（TTL）必须与这个超时**在同一处**
 * 取值（docs/app/push-notification/tech.md §6.3/§8）——送不到人手上就已经自动拒绝了的
 * 通知，不如别送。两边各读一遍环境变量迟早会悄悄对不上。
 */
export function resolveApprovalTimeoutMs(): number {
  const raw = process.env.CHAT_APPROVAL_TIMEOUT_MS?.trim();
  if (raw === undefined || raw.length === 0) return DEFAULT_APPROVAL_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ?
      parsed
    : DEFAULT_APPROVAL_TIMEOUT_MS;
}

export interface RequestReviewInput {
  callId: string;
  toolName: string;
  input: JsonValue;
}

export interface RequestReviewOptions {
  /** Overrides `CHAT_APPROVAL_TIMEOUT_MS` — mainly for tests; production callers leave this unset. */
  timeoutMs?: number;
}

/**
 * Registers a pending review for `conversationId`'s active turn — the returned
 * promise settles once `resolveReview(conversationId, req.callId, ...)` is
 * called (a human's decision) or the timeout elapses (auto-deny), whichever
 * comes first, either way via the exact same `resolveReview` call (see its
 * own doc comment) so a reconnecting client can't tell a timeout apart from
 * a manual decision.
 *
 * No active turn for `conversationId` at all (defensive branch — `routes/chat.ts`
 * only ever calls this from inside a running turn's own `onReview`
 * callback, so this shouldn't normally be reachable) denies immediately
 * without registering anything: there is nowhere to route the request to.
 */
export function requestReview(
  conversationId: string,
  req: RequestReviewInput,
  opts?: RequestReviewOptions,
): Promise<HumanDecision> {
  const activeTurn = activeTurns.get(conversationId);
  if (activeTurn === undefined) {
    return Promise.resolve({
      behavior: 'deny',
      message: 'No active turn to route this approval request to.',
    });
  }

  // 这一轮已被[停止](../../../../../docs/terms.md)：立刻拒绝，不注册挂起项——否则这个
  // 请求会挂到自己的超时（默认 240 秒）才动，把停止拖成「四分钟后停止」。发生在
  // 停止的那一步里还有其它并行工具调用要审批时（`ActiveTurn.aborted` 注释）。
  if (activeTurn.aborted) {
    return Promise.resolve({ behavior: 'deny', message: ABORT_DENY_MESSAGE });
  }

  const timeoutMs = opts?.timeoutMs ?? resolveApprovalTimeoutMs();

  return new Promise<HumanDecision>((resolve) => {
    const timer = setTimeout(() => {
      resolveReview(conversationId, req.callId, {
        behavior: 'deny',
        message: `Approval request timed out after ${String(timeoutMs)}ms with no response.`,
      });
    }, timeoutMs);
    activeTurn.pendingReviews.set(req.callId, {
      resolve,
      timer,
      toolName: req.toolName,
      input: req.input,
    });
  });
}

/**
 * The human (or timeout) side of the bridge: `routes/chat.ts`'s
 * `POST .../approvals/:callId` calls this with the person's decision.
 * Returns `false` (no-op) when there is no such pending review to resolve
 * — either `conversationId` has no active turn at all, or it does but `callId`
 * isn't (or isn't anymore, e.g. already resolved/timed out) one of its
 * pending requests; the route turns a `false` here into a 404.
 *
 * On a hit: cancels the timeout, removes the pending entry, and settles the
 * `requestReview` promise with the decision — which is what actually
 * unblocks the suspended `@nimbo/core` loop, which then yields its own
 * `tool-approval-response` chunk on the wire (this function emits nothing
 * itself, see this file's header).
 *
 * `opts.grantSession = { db, userId }` (the human picked 「会话内都允许」): before
 * resolving, persist a 会话级授权 (`session-grants.ts`, `conversation_grants` 表)
 * for **this exact call** (the pending entry's own `toolName`/`input`) under the
 * approving `userId`, so the session classifier auto-allows an identical future
 * call by that user. The `decision` itself is still a plain `{ behavior: 'allow' }`
 * — the grant is a chat-layer concept the core loop neither needs nor sees.
 */
export function resolveReview(
  conversationId: string,
  callId: string,
  decision: HumanDecision,
  opts?: { grantSession?: { db: Db; userId: string } },
): boolean {
  const activeTurn = activeTurns.get(conversationId);
  if (activeTurn === undefined) return false;

  const pending = activeTurn.pendingReviews.get(callId);
  if (pending === undefined) return false;

  if (opts?.grantSession !== undefined) {
    grantSessionApproval(
      opts.grantSession.db,
      conversationId,
      opts.grantSession.userId,
      pending.toolName,
      pending.input,
    );
  }

  clearTimeout(pending.timer);
  activeTurn.pendingReviews.delete(callId);
  pending.resolve(decision);
  return true;
}

// ---------------------------------------------------------------------------
// ask-user bridge (docs/app/chat-webapp/tech.md §2.2c（审批链）) — structurally the sibling of the
// review bridge above; `chat-agent.ts`'s `ask-user` tool calls
// `requestUserAnswer` on every invocation (no auto-allow branch — asking the
// user is always exactly that), suspending the turn until a human answers
// via `POST .../questions/:callId` or the timeout elapses.
// ---------------------------------------------------------------------------

/** `CHAT_ASK_USER_TIMEOUT_MS`, defaulting to 240000ms — same rationale/default as `DEFAULT_APPROVAL_TIMEOUT_MS` above (80% of the sandbox's own idle timeout), kept as its own env var since a host may reasonably want to give a human longer to *answer a question* than to *approve a command*. */
const DEFAULT_ASK_USER_TIMEOUT_MS = 240_000;

/** 导出的理由同 `resolveApprovalTimeoutMs`。 */
export function resolveAskUserTimeoutMs(): number {
  const raw = process.env.CHAT_ASK_USER_TIMEOUT_MS?.trim();
  if (raw === undefined || raw.length === 0) return DEFAULT_ASK_USER_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ?
      parsed
    : DEFAULT_ASK_USER_TIMEOUT_MS;
}

export interface RequestUserAnswerInput {
  callId: string;
  question: string;
  options?: string[];
}

export interface RequestUserAnswerOptions {
  /** Overrides `CHAT_ASK_USER_TIMEOUT_MS` — mainly for tests; production callers leave this unset. */
  timeoutMs?: number;
}

/**
 * Shared settle step for a pending question: both `resolveUserAnswer` (a
 * human's answer) and `requestUserAnswer`'s own timeout call this — same
 * "single settle path, timeout indistinguishable from a manual answer" as
 * the review bridge's `resolveReview`. Not part of the public surface
 * (`index.ts` doesn't re-export it): `resolveUserAnswer` below is the public
 * face of the "answered" case, the timeout case only ever originates from
 * inside `requestUserAnswer` itself — `abort.ts` is the one other caller,
 * settling whatever is still pending when a turn is stopped.
 */
export function settleQuestion(
  conversationId: string,
  callId: string,
  outcome: AskUserOutcome,
): boolean {
  const activeTurn = activeTurns.get(conversationId);
  if (activeTurn === undefined) return false;

  const pending = takePending(activeTurn.pendingQuestions, callId);
  if (pending === undefined) return false;

  pending.resolve(outcome);
  return true;
}

/**
 * Registers a pending question for `conversationId`'s active turn — the returned
 * promise settles once `resolveUserAnswer(conversationId, req.callId, ...)` is
 * called (a human's answer) or the timeout elapses (`{ outcome: 'timeout' }`),
 * whichever comes first, either way via `settleQuestion` so a reconnecting
 * client can't tell a timeout apart from a manual answer (mirrors
 * `requestReview`'s own doc comment).
 *
 * No active turn for `conversationId` at all (defensive branch — `chat-agent.ts`'s
 * `ask-user` tool only ever calls this from inside a running turn, so this
 * shouldn't normally be reachable) resolves `{ outcome: 'timeout' }`
 * immediately without registering anything: there is nowhere to route the
 * question to.
 */
export function requestUserAnswer(
  conversationId: string,
  req: RequestUserAnswerInput,
  opts?: RequestUserAnswerOptions,
): Promise<AskUserOutcome> {
  const activeTurn = activeTurns.get(conversationId);
  if (activeTurn === undefined) {
    return Promise.resolve({ outcome: 'timeout' });
  }

  // 同 `requestReview` 的停止闸门：轮已停止就不再挂起等人回答。
  if (activeTurn.aborted) {
    return Promise.resolve({ outcome: 'timeout' });
  }

  const timeoutMs = opts?.timeoutMs ?? resolveAskUserTimeoutMs();

  return new Promise<AskUserOutcome>((resolve) => {
    const timer = setTimeout(() => {
      settleQuestion(conversationId, req.callId, { outcome: 'timeout' });
    }, timeoutMs);
    activeTurn.pendingQuestions.set(req.callId, { resolve, timer });
  });
}

/**
 * The human (or timeout) side of the ask-user bridge: `routes/chat.ts`'s
 * `POST .../questions/:callId` calls this with the person's free-text
 * `answer`. Returns `false` (no-op) when there is no such pending question to
 * resolve — either `conversationId` has no active turn at all, or it does but
 * `callId` isn't (or isn't anymore, e.g. already answered/timed out) one of
 * its pending questions; the route turns a `false` here into a 404.
 */
export function resolveUserAnswer(
  conversationId: string,
  callId: string,
  answer: string,
): boolean {
  return settleQuestion(conversationId, callId, {
    outcome: 'answered',
    answer,
  });
}
