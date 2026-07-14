/**
 * Turn execution/connection decoupling (docs/08-chat-agent-webapp.md §2.2b,
 * the P12-4 fix for "SSE 断开后进行中 turn 的后续输出不再到达页面"): a chat
 * turn is driven entirely in-process, independent of any HTTP request —
 * `POST .../messages` (`routes/chat.ts`) only *starts* it (`startTurn`),
 * `GET .../stream` only *observes* it (`subscribeTurn`/`isTurnActive`). A
 * client disconnecting (page refresh, HMR, network blip) never interrupts
 * the turn: every event — except `item.updated`'s ephemeral typewriter ticks
 * (docs/08 §2.2d, see `createEmitWire`) — is persisted (`agent_events`,
 * monotonic `seq`) before it's ever handed to a subscriber, so a fresh
 * `GET .../stream?after=<seq>` on reconnect replays whatever was missed and
 * then keeps forwarding live events until the turn ends.
 *
 * `TurnDrivenSession` is the one seam onto `@nimbo/sdk`'s `Session` — the
 * same "structural interface, not the concrete class" discipline as
 * `sandbox-manager.ts`'s `SandboxClient` — so `startTurn` can be driven by a
 * fake `stream()`/`toJSON()` pair in tests, no real model/sandbox involved
 * (see test/agent/turn-runner.test.ts).
 *
 * Process-restart caveat (docs/08 §2.2b "边界"): `activeTurns` is in-memory
 * only — a server restart mid-turn silently drops it (the sandbox may still
 * be running, but nothing drives `session.stream()` forward anymore). Rows
 * already persisted stay put; the next `GET .../stream` finds no active
 * turn and just replays up to the crash point. This is v1's documented
 * trade-off, not a bug to fix here.
 *
 * Approval bridge (docs/08 §2.2c（审批链）): `requestApproval`/`resolveApproval`
 * are this module's other half of that bridge — `routes/chat.ts` wires a
 * session-level `ApprovalPolicy` (built from `approval-policy.ts`'s pure
 * `shouldAutoAllow`) that calls `requestApproval` for anything not
 * auto-allowed, suspending the turn's own `@nimbo/core` loop (it's `await`ing
 * that very promise) until a human resolves it via
 * `POST .../approvals/:callId` (or it times out). Both events
 * (`approval.requested`/`approval.resolved`) go out through the same
 * `emitWire` closure as every other event on this turn, so they persist and
 * replay exactly like `session.stream()`'s own events do.
 *
 * ask_user bridge (docs/08 §2.2c（审批链）): `requestUserAnswer`/
 * `resolveUserAnswer` are the structurally-identical sibling of the approval
 * bridge above (same register → emit → suspend → settle shape, same
 * `PendingEntry`/`takePending` plumbing) — `chat-agent.ts`'s `ask_user` tool
 * calls `requestUserAnswer` every time it's invoked (there is no per-call
 * "auto-allow" branch the way approvals have `shouldAutoAllow`: asking the
 * user is always exactly that, a question for the user), suspending the turn
 * until a human answers via `POST .../questions/:callId` (or it times out).
 */
import { EventEmitter } from 'node:events';

import type {
  ApprovalDecision,
  JsonValue,
  SessionEvent,
  SessionState,
  TurnResult,
} from '@nimbo/core';

import type { ChatEventEnvelope, ChatStreamEvent } from '../schemas/chat.js';
import type { Db } from './store.js';
import {
  appendAgentEvent,
  getMaxEventSeq,
  updateChatSession,
} from './store.js';

/**
 * The one thing `startTurn` needs from a `@nimbo/sdk` `Session<F>` — deliberately
 * narrower than the real type (no `id`/`fs`/`send`/etc.) so tests can hand in a
 * bare fake instead of assembling a real session.
 *
 * `steer` is **optional** here even though every real `@nimbo/sdk` `Session`
 * always has one (STEER-1) — narrowed the same way `stream`/`toJSON` already
 * are, so a test fake that only cares about the base turn-driving contract
 * (`test/helpers/controllable-session.ts`) doesn't also have to implement
 * steering just to satisfy this interface. `steerTurn` below treats a missing
 * `steer` as "this session can't be steered", i.e. `false` — never a runtime
 * error — via `ActiveTurn.steer`'s capture in `startTurn`.
 */
export interface TurnDrivenSession {
  stream(input: string): AsyncGenerator<SessionEvent, TurnResult>;
  toJSON(): SessionState;
  steer?(input: string): boolean;
}

/** One turn's persist-then-broadcast step (see `createEmitWire`), threaded through `driveTurn` and the approval/ask_user bridges below so every wire event — `session.stream()`'s own, the terminal sentinels, and the approval/question pairs — goes through the exact same seq/persist/emit path. */
type EmitWire = (event: ChatStreamEvent) => void;

/**
 * One pending `requestApproval`/`requestUserAnswer` call, parked until
 * `resolveApproval`/`resolveUserAnswer` (a human decision/answer, or the
 * timeout) settles it — the one piece genuinely identical between the
 * approval and ask_user bridges (docs/08 §2.2c（审批链）), see `takePending`.
 */
interface PendingEntry<T> {
  resolve: (value: T) => void;
  timer: NodeJS.Timeout;
}

/** The outcome of one `ask_user` call (docs/08 §2.2c（审批链）) — `'timeout'` never carries an `answer`, same as `ApprovalDecision`'s `deny` branch not requiring a `message`. */
export type AskUserOutcome =
  { outcome: 'answered'; answer: string } | { outcome: 'timeout' };

interface ActiveTurn {
  emitter: EventEmitter;
  done: boolean;
  /** Bound to this turn's own `session.steer` at registration time (STEER-3B) — see `steerTurn`. */
  steer: (input: string) => boolean;
  emitWire: EmitWire;
  /** Keyed by `callId` (docs/08 §2.2c（审批链）) — see `requestApproval`/`resolveApproval`. */
  pendingApprovals: Map<string, PendingEntry<ApprovalDecision>>;
  /** Keyed by `callId` (docs/08 §2.2c（审批链）) — see `requestUserAnswer`/`resolveUserAnswer`. Independent of `pendingApprovals`: same shape, different `Map`, different wire events. */
  pendingQuestions: Map<string, PendingEntry<AskUserOutcome>>;
}

const activeTurns = new Map<string, ActiveTurn>();

export function isTurnActive(sessionId: string): boolean {
  return activeTurns.has(sessionId);
}

/**
 * `POST .../messages` (routes/chat.ts) calls this first: if `sessionId` has
 * a turn in progress, forward `text` into it via the session's own
 * `steer()` instead of starting a new turn — returns whatever `steer()`
 * reported (`true` = queued, injected at the next step checkpoint;
 * `false` = the turn's `steer` doesn't support it, or (rare race) the turn
 * finished between this call landing and `steer()` checking its own
 * in-flight state). No active turn at all also returns `false`. Either way,
 * a `false` here is the route's cue to fall back to `startTurn` instead.
 */
export function steerTurn(sessionId: string, text: string): boolean {
  const activeTurn = activeTurns.get(sessionId);
  if (activeTurn === undefined) return false;
  return activeTurn.steer(text);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The turn's one seq-counting, persist-then-broadcast closure — lifted out of
 * `driveTurn` (it used to own this) so `startTurn` can hang the same closure
 * off `ActiveTurn.emitWire` and let `requestApproval`/`resolveApproval` emit
 * through it too (docs/08 §2.2c（审批链）), keeping every wire event on this
 * turn — `session.stream()`'s own, the terminal sentinels, and the approval
 * pair — on one single monotonic `seq`. `getMaxEventSeq` runs synchronously
 * here at `startTurn`-time, same as it always did at the top of `driveTurn`.
 *
 * Durable/ephemeral split (docs/08 §2.2d, P13-1): `item.updated` is the one
 * event type this closure treats differently. `loop.ts` re-yields it once per
 * appended delta with the item's *entire accumulated text so far*, so
 * persisting every tick the way every other event is persisted makes storage
 * grow quadratically with message length (measured: one real turn produced
 * 9861 events, 9682 of them — 98% — `item.updated` ticks). `item.completed`
 * already carries the authoritative final text and *is* persisted, so a
 * replay never needs the intermediate ticks to reconstruct the final
 * timeline (`buildTimeline` on the web side folds `item.*` by id anyway).
 * `item.updated` therefore skips both `seq += 1` and `appendAgentEvent` —
 * straight broadcast, envelope carries no `seq` at all (see
 * `chatEventEnvelopeSchema`'s doc comment). This is the load-bearing
 * invariant the rest of the split leans on: because ephemeral frames never
 * consume a seq number, the persisted stream has no gaps and a process
 * restart's `getMaxEventSeq`-continuation never has to account for skipped
 * numbers — `seq` monotonicity among *persisted* events is exactly as simple
 * as it was before this split.
 */
function createEmitWire(
  db: Db,
  sessionId: string,
  emitter: EventEmitter,
): EmitWire {
  let seq = getMaxEventSeq(db, sessionId);
  return function emit(event: ChatStreamEvent): void {
    if (event.type === 'item.updated') {
      emitter.emit('event', { event } satisfies ChatEventEnvelope);
      return;
    }
    seq += 1;
    appendAgentEvent(db, {
      sessionId,
      seq,
      type: event.type,
      payloadJson: JSON.stringify(event),
    });
    const envelope: ChatEventEnvelope = { seq, event };
    emitter.emit('event', envelope);
  };
}

async function driveTurn(
  db: Db,
  sessionId: string,
  session: TurnDrivenSession,
  text: string,
  emit: EmitWire,
): Promise<void> {
  try {
    // Wire-only member, first event of every turn (docs/08 §2.2 "契约细化"
    // #1) — `session.stream()` only ever yields the *agent's* own events, so
    // without this a replay can't reconstruct what the user actually typed.
    emit({ type: 'user.message', text });

    const gen = session.stream(text);
    let step = await gen.next();
    while (!step.done) {
      emit(step.value);
      step = await gen.next();
    }
    const turnResult = step.value;

    updateChatSession(db, sessionId, {
      status: 'active',
      lastActiveAt: new Date(),
      nimboStateJson: JSON.stringify(session.toJSON()),
    });

    emit({
      type: 'turn.result',
      finalResponse: turnResult.finalResponse,
      usage: turnResult.usage,
    });
  } catch (error) {
    // `session.stream()` yielding a normal `SessionEvent` of type
    // `turn.failed` is *not* this branch — that's a graceful degrade
    // (packages/core/src/loop.ts still `return`s a `TurnResult` after
    // yielding it), handled by the `emit`/`turn.result` path above like any
    // other event. This `catch` only ever sees a genuinely unexpected throw
    // out of the generator itself, with no `TurnResult` to report — hence a
    // different terminal sentinel instead of `turn.result` (see
    // schemas/chat.ts's `turnFailedSentinelSchema`). `nimboStateJson` is
    // deliberately left untouched here: the turn never reached a well-defined
    // `TurnResult`, so there is nothing trustworthy to persist as the new
    // resume state — the next turn resumes from the last *known-good* state.
    emit({
      type: 'turn.failed',
      code: 'internal_error',
      message: describeError(error),
    });
  }
}

export interface StartTurnParams {
  db: Db;
  sessionId: string;
  session: TurnDrivenSession;
  text: string;
}

export interface StartTurnResult {
  started: boolean;
}

/**
 * Rejects (`{ started: false }`) if this session already has a turn running
 * — `routes/chat.ts` turns that into a 409. Otherwise registers the
 * `ActiveTurn` synchronously (so `isTurnActive`/`subscribeTurn` see it
 * immediately) and spawns the background driver — deliberately not
 * `await`ed, not bound to any request's lifetime.
 */
export function startTurn(params: StartTurnParams): StartTurnResult {
  const { db, sessionId, session, text } = params;
  if (activeTurns.has(sessionId)) return { started: false };

  const emitter = new EventEmitter();
  // Every open `GET .../stream` tail (multiple tabs, reconnect churn) adds a
  // listener pair to the same turn's emitter for its lifetime — that's
  // expected fan-out, not a leak, so the default-10 warning is disabled.
  emitter.setMaxListeners(0);
  const activeTurn: ActiveTurn = {
    emitter,
    done: false,
    // Captured once, bound to *this* turn's `session` — `steerTurn` never
    // sees `session` directly, only this closure (STEER-3B).
    steer: (input) => session.steer?.(input) ?? false,
    emitWire: createEmitWire(db, sessionId, emitter),
    pendingApprovals: new Map(),
    pendingQuestions: new Map(),
  };
  activeTurns.set(sessionId, activeTurn);

  void driveTurn(db, sessionId, session, text, activeTurn.emitWire).finally(
    () => {
      // Defensive cleanup only (docs/08 §2.2c（审批链）) — in the normal
      // case both maps are already empty by the time `driveTurn` settles,
      // because the `@nimbo/core` loop is itself `await`ing whatever
      // `requestApproval`/`requestUserAnswer` promise is pending (it's the
      // tool call's own `onApproval`/`ask_user` result), so the generator
      // simply cannot reach its `return`/`throw` while one is still
      // outstanding. Anything still here is a genuine leak (e.g. a bug
      // upstream) being caught before it dangles forever. No
      // `approval.resolved`/`question.answered` is emitted for these: the
      // turn's wire stream already ended (`turn.result`/`turn.failed` is its
      // terminal sentinel) — appending anything after that would break every
      // consumer's "stream ends at the terminal sentinel" assumption
      // (`GET .../stream`'s replay, `GET .../events`).
      for (const pending of activeTurn.pendingApprovals.values()) {
        clearTimeout(pending.timer);
        pending.resolve({
          behavior: 'deny',
          message:
            'The turn this approval request belonged to has already ended.',
        });
      }
      activeTurn.pendingApprovals.clear();

      for (const pending of activeTurn.pendingQuestions.values()) {
        clearTimeout(pending.timer);
        pending.resolve({ outcome: 'timeout' });
      }
      activeTurn.pendingQuestions.clear();

      emitter.emit('done');
      activeTurn.done = true;
      activeTurns.delete(sessionId);
    },
  );

  return { started: true };
}

/**
 * Attaches to the session's in-progress turn, if any — a no-op unsubscribe
 * when there isn't one (`routes/chat.ts`'s `GET .../stream` checks
 * `isTurnActive` itself to tell the two cases apart, since `onDone` will
 * never fire for a turn that was never active). Subscribing is synchronous
 * and side-effect-free until the turn actually emits, so calling this
 * *before* replaying persisted history (docs/08 §2.2b) is what prevents
 * losing an event that lands in the gap between the replay query and this
 * call.
 */
export function subscribeTurn(
  sessionId: string,
  onEvent: (envelope: ChatEventEnvelope) => void,
  onDone: () => void,
): () => void {
  const activeTurn = activeTurns.get(sessionId);
  if (activeTurn === undefined) return () => {};

  activeTurn.emitter.on('event', onEvent);
  activeTurn.emitter.once('done', onDone);
  return () => {
    activeTurn.emitter.off('event', onEvent);
    activeTurn.emitter.off('done', onDone);
  };
}

/**
 * The one step genuinely identical between the approval and ask_user bridges
 * (docs/08 §2.2c（审批链）): cancel `callId`'s timeout and remove it from
 * `pending`, handing back the removed entry (or `undefined` if there wasn't
 * one) so the caller can settle its promise and emit its own wire event —
 * those two differ by bridge (different `ApprovalDecision`/`AskUserOutcome`
 * payloads, different event types), so they stay in `resolveApproval`/
 * `settleQuestion` rather than being folded into this helper too.
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
// Approval bridge (docs/08 §2.2c（审批链）) — see this file's header comment
// for the end-to-end flow. `routes/chat.ts`'s session-level `ApprovalPolicy`
// calls `requestApproval` for anything `approval-policy.ts`'s
// `shouldAutoAllow` didn't clear; the resulting promise is exactly what
// `packages/core/src/approval.ts`'s `evaluateApproval` is `await`ing, so the
// turn's own loop is genuinely suspended (not polling) until
// `resolveApproval` settles it.
// ---------------------------------------------------------------------------

/** `CHAT_APPROVAL_TIMEOUT_MS`, defaulting to 240000ms — 80% of the sandbox's own idle timeout (`sandbox-manager.ts`'s `DEFAULT_SANDBOX_IDLE_TIMEOUT_MS`, 300000ms), so an unattended approval request times out (and denies) well before the sandbox itself would go idle out from under the turn. */
const DEFAULT_APPROVAL_TIMEOUT_MS = 240_000;

function resolveApprovalTimeoutMs(): number {
  const raw = process.env.CHAT_APPROVAL_TIMEOUT_MS?.trim();
  if (raw === undefined || raw.length === 0) return DEFAULT_APPROVAL_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ?
      parsed
    : DEFAULT_APPROVAL_TIMEOUT_MS;
}

export interface RequestApprovalInput {
  callId: string;
  toolName: string;
  input: JsonValue;
}

export interface RequestApprovalOptions {
  /** Overrides `CHAT_APPROVAL_TIMEOUT_MS` — mainly for tests; production callers leave this unset. */
  timeoutMs?: number;
}

/**
 * Registers a pending approval for `sessionId`'s active turn and emits
 * `approval.requested` — the returned promise settles once
 * `resolveApproval(sessionId, req.callId, ...)` is called (a human's
 * decision) or the timeout elapses (auto-deny), whichever comes first,
 * either way via the exact same `resolveApproval` call (see its own doc
 * comment) so a reconnecting client can't tell a timeout apart from a manual
 * decision on the wire.
 *
 * No active turn for `sessionId` at all (defensive branch — `routes/chat.ts`
 * only ever calls this from inside a running turn's own `onApproval`
 * callback, so this shouldn't normally be reachable) denies immediately
 * without registering or emitting anything: there is nowhere to route the
 * request to.
 *
 * Registration happens *before* the emit below (same "subscribe before
 * replay" discipline as `subscribeTurn`'s own doc comment) — otherwise a
 * `resolveApproval` call racing in between the emit and the registration
 * would find nothing pending yet and be silently dropped.
 */
export function requestApproval(
  sessionId: string,
  req: RequestApprovalInput,
  opts?: RequestApprovalOptions,
): Promise<ApprovalDecision> {
  const activeTurn = activeTurns.get(sessionId);
  if (activeTurn === undefined) {
    return Promise.resolve({
      behavior: 'deny',
      message: 'No active turn to route this approval request to.',
    });
  }

  const timeoutMs = opts?.timeoutMs ?? resolveApprovalTimeoutMs();

  return new Promise<ApprovalDecision>((resolve) => {
    const timer = setTimeout(() => {
      resolveApproval(sessionId, req.callId, {
        behavior: 'deny',
        message: `Approval request timed out after ${String(timeoutMs)}ms with no response.`,
      });
    }, timeoutMs);
    activeTurn.pendingApprovals.set(req.callId, { resolve, timer });
    activeTurn.emitWire({
      type: 'approval.requested',
      callId: req.callId,
      toolName: req.toolName,
      input: req.input,
    });
  });
}

/**
 * The human (or timeout) side of the bridge: `routes/chat.ts`'s
 * `POST .../approvals/:callId` calls this with the person's decision.
 * Returns `false` (no-op) when there is no such pending approval to resolve
 * — either `sessionId` has no active turn at all, or it does but `callId`
 * isn't (or isn't anymore, e.g. already resolved/timed out) one of its
 * pending requests; the route turns a `false` here into a 404.
 *
 * On a hit: cancels the timeout, removes the pending entry, emits
 * `approval.resolved` (only carrying `message` when the decision is a
 * `deny` that actually supplied one — an `allow` never has one), then
 * settles the `requestApproval` promise with the decision, which is what
 * actually unblocks the suspended `@nimbo/core` loop.
 */
export function resolveApproval(
  sessionId: string,
  callId: string,
  decision: ApprovalDecision & { behavior: 'allow' | 'deny' },
): boolean {
  const activeTurn = activeTurns.get(sessionId);
  if (activeTurn === undefined) return false;

  const pending = takePending(activeTurn.pendingApprovals, callId);
  if (pending === undefined) return false;

  activeTurn.emitWire({
    type: 'approval.resolved',
    callId,
    behavior: decision.behavior,
    ...(decision.behavior === 'deny' && decision.message !== undefined ?
      { message: decision.message }
    : {}),
  });
  pending.resolve(decision);
  return true;
}

// ---------------------------------------------------------------------------
// ask_user bridge (docs/08 §2.2c（审批链）) — structurally the sibling of the
// approval bridge above (see this file's header comment); `chat-agent.ts`'s
// `ask_user` tool calls `requestUserAnswer` on every invocation (no
// auto-allow branch — asking the user is always exactly that), suspending
// the turn until a human answers via `POST .../questions/:callId` or the
// timeout elapses.
// ---------------------------------------------------------------------------

/** `CHAT_ASK_USER_TIMEOUT_MS`, defaulting to 240000ms — same rationale/default as `DEFAULT_APPROVAL_TIMEOUT_MS` above (80% of the sandbox's own idle timeout), kept as its own env var since a host may reasonably want to give a human longer to *answer a question* than to *approve a command*. */
const DEFAULT_ASK_USER_TIMEOUT_MS = 240_000;

function resolveAskUserTimeoutMs(): number {
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
 * Shared settle step for a pending question (docs/08 §2.2c（审批链）): both
 * `resolveUserAnswer` (a human's answer) and `requestUserAnswer`'s own
 * timeout call this — same "single settle path, timeout indistinguishable
 * from a manual answer on the wire" discipline as the approval bridge's
 * `resolveApproval`. Not exported: `resolveUserAnswer` below is the public
 * surface for the "answered" case; the timeout case only ever originates
 * from inside `requestUserAnswer` itself.
 */
function settleQuestion(
  sessionId: string,
  callId: string,
  outcome: AskUserOutcome,
): boolean {
  const activeTurn = activeTurns.get(sessionId);
  if (activeTurn === undefined) return false;

  const pending = takePending(activeTurn.pendingQuestions, callId);
  if (pending === undefined) return false;

  activeTurn.emitWire({
    type: 'question.answered',
    callId,
    outcome: outcome.outcome,
    ...(outcome.outcome === 'answered' ? { answer: outcome.answer } : {}),
  });
  pending.resolve(outcome);
  return true;
}

/**
 * Registers a pending question for `sessionId`'s active turn and emits
 * `question.asked` — the returned promise settles once
 * `resolveUserAnswer(sessionId, req.callId, ...)` is called (a human's
 * answer) or the timeout elapses (`{ outcome: 'timeout' }`), whichever comes
 * first, either way via `settleQuestion` so a reconnecting client can't tell
 * a timeout apart from a manual answer on the wire (mirrors
 * `requestApproval`'s own doc comment).
 *
 * No active turn for `sessionId` at all (defensive branch — `chat-agent.ts`'s
 * `ask_user` tool only ever calls this from inside a running turn, so this
 * shouldn't normally be reachable) resolves `{ outcome: 'timeout' }`
 * immediately without registering or emitting anything: there is nowhere to
 * route the question to.
 *
 * Registration happens *before* the emit below, same "subscribe before
 * replay" discipline as `requestApproval`'s own doc comment explains.
 */
export function requestUserAnswer(
  sessionId: string,
  req: RequestUserAnswerInput,
  opts?: RequestUserAnswerOptions,
): Promise<AskUserOutcome> {
  const activeTurn = activeTurns.get(sessionId);
  if (activeTurn === undefined) {
    return Promise.resolve({ outcome: 'timeout' });
  }

  const timeoutMs = opts?.timeoutMs ?? resolveAskUserTimeoutMs();

  return new Promise<AskUserOutcome>((resolve) => {
    const timer = setTimeout(() => {
      settleQuestion(sessionId, req.callId, { outcome: 'timeout' });
    }, timeoutMs);
    activeTurn.pendingQuestions.set(req.callId, { resolve, timer });
    activeTurn.emitWire({
      type: 'question.asked',
      callId: req.callId,
      question: req.question,
      ...(req.options !== undefined ? { options: req.options } : {}),
    });
  });
}

/**
 * The human (or timeout) side of the ask_user bridge: `routes/chat.ts`'s
 * `POST .../questions/:callId` calls this with the person's free-text
 * `answer`. Returns `false` (no-op) when there is no such pending question to
 * resolve — either `sessionId` has no active turn at all, or it does but
 * `callId` isn't (or isn't anymore, e.g. already answered/timed out) one of
 * its pending questions; the route turns a `false` here into a 404.
 */
export function resolveUserAnswer(
  sessionId: string,
  callId: string,
  answer: string,
): boolean {
  return settleQuestion(sessionId, callId, { outcome: 'answered', answer });
}
