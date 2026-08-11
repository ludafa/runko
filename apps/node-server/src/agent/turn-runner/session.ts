/**
 * 本目录唯一对接 `@nimbo/sdk` `Session` 的那道**结构化接缝**——与
 * `sandbox-manager.ts` 的 `SandboxProvider` 同一条纪律：「按结构声明接口，不认具体类」，
 * 于是 `drive.ts` 的 `driveTurn` 可以由一对假的 `stream()`/`toJSON()` 驱动，测试里
 * 不必牵进真模型/真沙盒（见 test/agent/turn-runner.test.ts 与
 * test/helpers/controllable-session.ts）。
 */
import type { NimboChunk, SessionState, TurnResult } from '@nimbo/core';

/**
 * The one thing `startTurn` needs from a `@nimbo/sdk` `Session<F>` — deliberately
 * narrower than the real type (no `id`/`fs`/`send`/etc.) so tests can hand in a
 * bare fake instead of assembling a real session.
 *
 * `steer` is **optional** here even though every real `@nimbo/sdk` `Session`
 * always has one (STEER-1) — narrowed the same way `stream`/`toJSON` already
 * are, so a test fake that only cares about the base turn-driving contract
 * (`test/helpers/controllable-session.ts`) doesn't also have to implement
 * steering just to satisfy this interface. `registry.ts`'s `steerTurn` treats a
 * missing `steer` as "this session can't be steered", i.e. `false` — never a
 * runtime error — via `ActiveTurn.steer`'s capture in `start.ts`'s `startTurn`.
 */
export interface TurnDrivenSession {
  /**
   * `opts` 是 `@nimbo/core` 的 `TurnOptions` 里本目录唯一用到的那一项
   * （docs/agent/turn-abort/tech.md §3.1）：每一轮自己的 `AbortController.signal`，
   * [停止](../../../../../docs/terms.md)靠它落地。声明成可选 + 只含 `signal`，所以
   * 一个只实现了 `stream(input)` 的测试 fake 仍然满足这个接口（多余的实参在
   * 运行期被忽略）——与 `steer` 同样的「比真类型更窄」姿态。
   */
  stream(
    input: string,
    opts?: { signal?: AbortSignal },
  ): AsyncGenerator<NimboChunk, TurnResult>;
  toJSON(): SessionState;
  steer?(input: string): boolean;
}
