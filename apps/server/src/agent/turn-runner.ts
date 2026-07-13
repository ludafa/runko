/**
 * Turn execution/connection decoupling (docs/08-chat-agent-webapp.md §2.2b,
 * the P12-4 fix for "SSE 断开后进行中 turn 的后续输出不再到达页面"): a chat
 * turn is driven entirely in-process, independent of any HTTP request —
 * `POST .../messages` (`routes/chat.ts`) only *starts* it (`startTurn`),
 * `GET .../stream` only *observes* it (`subscribeTurn`/`isTurnActive`). A
 * client disconnecting (page refresh, HMR, network blip) never interrupts
 * the turn: every event is persisted (`agent_events`, monotonic `seq`)
 * before it's ever handed to a subscriber, so a fresh
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
 */
import { EventEmitter } from 'node:events';

import type { SessionEvent, SessionState, TurnResult } from '@nimbo/core';

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

interface ActiveTurn {
  emitter: EventEmitter;
  done: boolean;
  /** Bound to this turn's own `session.steer` at registration time (STEER-3B) — see `steerTurn`. */
  steer: (input: string) => boolean;
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

async function driveTurn(
  db: Db,
  sessionId: string,
  session: TurnDrivenSession,
  text: string,
  emitter: EventEmitter,
): Promise<void> {
  let seq = getMaxEventSeq(db, sessionId);

  function emit(event: ChatStreamEvent): void {
    seq += 1;
    appendAgentEvent(db, {
      sessionId,
      seq,
      type: event.type,
      payloadJson: JSON.stringify(event),
    });
    const envelope: ChatEventEnvelope = { seq, event };
    emitter.emit('event', envelope);
  }

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
  };
  activeTurns.set(sessionId, activeTurn);

  void driveTurn(db, sessionId, session, text, emitter).finally(() => {
    emitter.emit('done');
    activeTurn.done = true;
    activeTurns.delete(sessionId);
  });

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
