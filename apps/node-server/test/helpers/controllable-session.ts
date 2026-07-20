/**
 * A hand-driven fake `TurnDrivenSession` (turn-runner.ts's structural seam
 * onto `@nimbo/sdk`'s `Session`) — no model, no sandbox, just an
 * `AsyncGenerator<NimboChunk, TurnResult>` this test file's caller advances by
 * hand (`pushChunk`), pausing between chunks until told to `finish`/`fail`.
 * This is what lets `turn-runner.test.ts`/`routes/chat.test.ts` observe
 * `startTurn`'s in-progress state (`isTurnActive`, `subscribeTurn`'s live
 * forwarding) instead of only ever seeing a turn that's already fully
 * drained.
 *
 * ---- UIMessage 单账本 migration (docs/tech/single-ledger.md §5
 * 单-3, P13-5-3) ----
 *
 * `stream()` now yields `NimboChunk` (ai's `UIMessageChunk` vocabulary)
 * instead of the retired `SessionEvent`, and `finish()`/`fail()` settle it
 * with a `TurnResult` (`{ finalResponse, usage }`, no `items` field anymore —
 * "this turn 发生了什么" is read off the ledger's `NimboUIMessage`s, not a
 * parallel item list). `setState` is new: `finalizeTurnPersistence`
 * (turn-runner.ts) reads `session.toJSON().messages` at turn end to find
 * *this turn's* newly-appended messages (sliced past
 * `StartTurnParams.priorMessageCount`) — tests that exercise that path call
 * `setState` before `finish()` to control exactly what that slice contains,
 * instead of `toJSON()` always echoing a single constant snapshot.
 */
import type { NimboChunk, SessionState, TurnResult } from '@nimbo/core';

export interface ControllableSession {
  toJSONCalls: SessionState[];
  pushChunk(chunk: NimboChunk): void;
  finish(result: TurnResult): void;
  fail(error: unknown): void;
  /** Replaces the `SessionState` `toJSON()` returns from now on — see file header. Does not itself emit/persist anything; only affects future `toJSON()` calls. */
  setState(state: SessionState): void;
  stream(input: string): AsyncGenerator<NimboChunk, TurnResult>;
  toJSON(): SessionState;
}

const DEFAULT_STATE: SessionState = {
  id: 'fake-session',
  turn: 1,
  messages: [],
  createdAt: 0,
};

/** One turn's worth of hand-driven control — call `session.stream(text)` at most once per instance, same as `turn-runner.ts` does. */
export function createControllableSession(
  initialState: SessionState = DEFAULT_STATE,
): ControllableSession {
  const queue: NimboChunk[] = [];
  let state = initialState;
  let outcome:
    | { kind: 'result'; result: TurnResult }
    | { kind: 'error'; error: unknown }
    | undefined;
  let wake: (() => void) | undefined;
  const toJSONCalls: SessionState[] = [];

  function scheduleWake(): void {
    const resolve = wake;
    wake = undefined;
    resolve?.();
  }

  async function* stream(): AsyncGenerator<NimboChunk, TurnResult> {
    for (;;) {
      const next = queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (outcome !== undefined) {
        if (outcome.kind === 'error') throw outcome.error;
        return outcome.result;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }

  return {
    toJSONCalls,
    pushChunk(chunk: NimboChunk): void {
      queue.push(chunk);
      scheduleWake();
    },
    finish(result: TurnResult): void {
      outcome = { kind: 'result', result };
      scheduleWake();
    },
    fail(error: unknown): void {
      outcome = { kind: 'error', error };
      scheduleWake();
    },
    setState(next: SessionState): void {
      state = next;
    },
    stream,
    toJSON(): SessionState {
      toJSONCalls.push(state);
      return state;
    },
  };
}

/**
 * `createControllableSession()` deliberately has no `steer` method at all —
 * that's what covers `turn-runner.ts`'s "session can't be steered" case
 * (`TurnDrivenSession.steer` is optional; `steerTurn` treats a missing one
 * as `false`, same as a `false` return). This variant is for the other two
 * `steerTurn` cases that need an actual `steer()` to control: `steerCalls`
 * records every `input` it was invoked with (call-order assertions), and
 * `setSteerResult` controls what the *next* call returns — default `true`
 * ("queued"), settable to `false` to simulate the narrow race
 * `turn-runner.ts`'s own header comment documents (the turn finished between
 * `steerTurn` finding it in `activeTurns` and `session.steer()` itself
 * checking its in-flight state).
 */
export interface SteerableControllableSession extends ControllableSession {
  steer(input: string): boolean;
  readonly steerCalls: string[];
  setSteerResult(result: boolean): void;
}

export function createSteerableControllableSession(
  initialState: SessionState = DEFAULT_STATE,
): SteerableControllableSession {
  const base = createControllableSession(initialState);
  const steerCalls: string[] = [];
  let steerResult = true;

  return {
    ...base,
    steerCalls,
    setSteerResult(result: boolean): void {
      steerResult = result;
    },
    steer(input: string): boolean {
      steerCalls.push(input);
      return steerResult;
    },
  };
}
