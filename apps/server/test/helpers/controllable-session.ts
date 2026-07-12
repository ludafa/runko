/**
 * A hand-driven fake `TurnDrivenSession` (turn-runner.ts's structural seam
 * onto `@nimbo/sdk`'s `Session`) — no model, no sandbox, just an
 * `AsyncGenerator` this test file's caller advances by hand (`pushEvent`),
 * pausing between events until told to `finish`/`fail`. This is what lets
 * `turn-runner.test.ts`/`routes/chat.test.ts` observe `startTurn`'s
 * in-progress state (`isTurnActive`, `subscribeTurn`'s live forwarding)
 * instead of only ever seeing a turn that's already fully drained.
 */
import type { SessionEvent, SessionState, TurnResult } from '@nimbo/core';

export interface ControllableSession {
  toJSONCalls: SessionState[];
  pushEvent(event: SessionEvent): void;
  finish(result: TurnResult): void;
  fail(error: unknown): void;
  stream(input: string): AsyncGenerator<SessionEvent, TurnResult>;
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
  state: SessionState = DEFAULT_STATE,
): ControllableSession {
  const queue: SessionEvent[] = [];
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

  async function* stream(): AsyncGenerator<SessionEvent, TurnResult> {
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
    pushEvent(event: SessionEvent): void {
      queue.push(event);
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
    stream,
    toJSON(): SessionState {
      toJSONCalls.push(state);
      return state;
    },
  };
}
