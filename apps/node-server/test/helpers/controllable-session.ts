/**
 * A hand-driven fake `TurnDrivenSession` (turn-runner/session.ts's structural seam
 * onto `@nimbo/sdk`'s `Session`) — no model, no sandbox, just an
 * `AsyncGenerator<NimboChunk, TurnResult>` this test file's caller advances by
 * hand (`pushChunk`), pausing between chunks until told to `finish`/`fail`.
 * This is what lets `turn-runner.test.ts`/`routes/chat.test.ts` observe
 * `startTurn`'s in-progress state (`isTurnActive`, `subscribeTurn`'s live
 * forwarding) instead of only ever seeing a turn that's already fully
 * drained.
 *
 * ---- UIMessage 单账本 migration (docs/agent/single-ledger/tech.md §5
 * 单-3, P13-5-3) ----
 *
 * `stream()` now yields `NimboChunk` (ai's `UIMessageChunk` vocabulary)
 * instead of the retired `SessionEvent`, and `finish()`/`fail()` settle it
 * with a `TurnResult` (`{ finalResponse, usage }`, no `items` field anymore —
 * "this turn 发生了什么" is read off the ledger's `NimboUIMessage`s, not a
 * parallel item list). `setState` is new: `finalizeTurnPersistence`
 * (turn-runner/persistence.ts) reads `session.toJSON().messages` at turn end to find
 * *this turn's* newly-appended messages (sliced past
 * `StartTurnParams.priorMessageCount`) — tests that exercise that path call
 * `setState` before `finish()` to control exactly what that slice contains,
 * instead of `toJSON()` always echoing a single constant snapshot.
 */
import type { NimboChunk, SessionState, TurnResult } from '@nimbo/core';

export interface ControllableSession {
  toJSONCalls: SessionState[];
  /**
   * `turn-runner/` 传进来的那个 [停止](../../../../docs/terms.md)信号
   * （`ActiveTurn.abortController.signal`，docs/agent/turn-abort/tech.md §3.1）——`stream()`
   * 被调用后才有值。测试用它断言「signal 确实透传给了 core」，以及模拟 core 收到
   * abort 后的优雅收尾（真 loop 在 step 边界收尾，这里由测试手动 `pushChunk` +
   * `finish` 扮演同一件事）。
   */
  turnSignal: AbortSignal | undefined;
  /**
   * 每次 `stream(input)` 收到的文本，按调用顺序。用来断言**模型实际看到的那份**
   * ——它可能与落[账本](../../../../docs/terms.md)的用户原话不同
   * （[skill 提及](../../../../docs/terms.md)会追加一行系统提示，
   * docs/app/composer-skill-mention/tech.md §2.2）。
   */
  streamInputs: string[];
  pushChunk(chunk: NimboChunk): void;
  finish(result: TurnResult): void;
  fail(error: unknown): void;
  /** Replaces the `SessionState` `toJSON()` returns from now on — see file header. Does not itself emit/persist anything; only affects future `toJSON()` calls. */
  setState(state: SessionState): void;
  stream(
    input: string,
    opts?: { signal?: AbortSignal },
  ): AsyncGenerator<NimboChunk, TurnResult>;
  toJSON(): SessionState;
}

const DEFAULT_STATE: SessionState = {
  id: 'fake-session',
  turn: 1,
  messages: [],
  createdAt: 0,
};

/** One turn's worth of hand-driven control — call `session.stream(text)` at most once per instance, same as `turn-runner/drive.ts` does. */
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
  let turnSignal: AbortSignal | undefined;
  const toJSONCalls: SessionState[] = [];
  const streamInputs: string[] = [];

  function scheduleWake(): void {
    const resolve = wake;
    wake = undefined;
    resolve?.();
  }

  async function* stream(
    input: string,
    opts?: { signal?: AbortSignal },
  ): AsyncGenerator<NimboChunk, TurnResult> {
    streamInputs.push(input);
    turnSignal = opts?.signal;
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
    streamInputs,
    get turnSignal(): AbortSignal | undefined {
      return turnSignal;
    },
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
 * that's what covers `turn-runner/registry.ts`'s "session can't be steered" case
 * (`TurnDrivenSession.steer` is optional; `steerTurn` treats a missing one
 * as `false`, same as a `false` return). This variant is for the other two
 * `steerTurn` cases that need an actual `steer()` to control: `steerCalls`
 * records every `input` it was invoked with (call-order assertions), and
 * `setSteerResult` controls what the *next* call returns — default `true`
 * ("queued"), settable to `false` to simulate the narrow race
 * `turn-runner/index.ts`'s own header comment documents (the turn finished between
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
