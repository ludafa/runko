/**
 * Turn execution/connection decoupling (docs/app/chat-webapp/tech.md §2.2b,
 * the P12-4 fix for "SSE 断开后进行中 turn 的后续输出不再到达页面"): a chat
 * turn is driven entirely in-process, independent of any HTTP request —
 * `POST .../messages` (`routes/chat.ts`) only *starts* it (`startTurn`),
 * `GET .../stream` only *observes* it (`subscribeTurn`/`isTurnActive`). A
 * client disconnecting (page refresh, HMR, network blip) never interrupts
 * the turn: every *durable* chunk (docs/agent/single-ledger/tech.md §5
 * 单-3's durable/ephemeral split, `persistence.ts`'s `isDurableChunk`) is persisted
 * (`conversation_events`, monotonic `seq`) before it's ever handed to a subscriber,
 * so a fresh `GET .../stream?after=<seq>` on reconnect replays whatever was
 * missed and then keeps forwarding live chunks until the turn ends.
 *
 * `TurnDrivenSession` (`session.ts`) is the one seam onto `@nimbo/sdk`'s
 * `Session` — the same "structural interface, not the concrete class"
 * discipline as `sandbox-manager.ts`'s `SandboxProvider` — so `startTurn` can be
 * driven by a fake `stream()`/`toJSON()` pair in tests, no real model/sandbox
 * involved (see test/agent/turn-runner.test.ts).
 *
 * ---- 本目录的模块划分 ----
 *
 * 本文件是**门面**：只做 re-export，不放任何实现。一轮的生命周期按时间顺序读下去
 * 就是这几个文件：
 *
 * | 文件                | 管什么                                                                 |
 * | ------------------- | ---------------------------------------------------------------------- |
 * | `registry.ts`       | 「进行中的轮」登记表（`activeTurns`）+ 查询/订阅/广播/插话             |
 * | `reservation.ts`    | [起轮占位](../../../../../docs/terms.md)：`reserveTurn` / `releaseTurn` |
 * | `start.ts`          | `startTurn`——登记（或升级占位）、放出后台驱动、收尾与 `onTurnSettled` |
 * | `drive.ts`          | 一轮的主循环 `driveTurn` + 两个「首次」里程碑                          |
 * | `persistence.ts`    | 落盘：`createTurnEmitter`（过程中）/ `finalizeTurnPersistence`（收尾）  |
 * | `human-bridge.ts`   | 人审（审批链）与 ask-user 两条人在环上的通道                           |
 * | `abort.ts`          | [停止](../../../../../docs/terms.md)本轮                               |
 * | `shutdown.ts`       | [优雅关闭](../../../../../docs/terms.md)：停下全部并等收尾             |
 * | `abort-reasons.ts`  | 「为什么停了」的四句固定文案（跨上面几个模块共用）                      |
 * | `session.ts`        | `TurnDrivenSession`——对接 `@nimbo/sdk` 的那道结构化接缝               |
 * | `log.ts`            | 日志旁路：`LOG_SCOPE` + 每个 chunk 记一行的 `logChunk`                 |
 *
 * Process-restart caveat (docs/app/chat-webapp/tech.md §2.2b "边界"): `activeTurns` is in-memory
 * only — a server restart mid-turn silently drops it (the sandbox may still
 * be running, but nothing drives `session.stream()` forward anymore). Rows
 * already persisted stay put; the next `GET .../stream` finds no active
 * turn and just replays up to the crash point (docs/agent/single-ledger/tech.md §5 单-3: this turn's
 * `kind = 'chunk'` rows never got GC'd, since `finalizeTurnPersistence`
 * never ran — accepted residue, see schema.ts's own doc comment). This is
 * v1's documented trade-off, not a bug to fix here.
 *
 * ---- UIMessage 单账本 migration (docs/agent/single-ledger/tech.md §5 单-3, P13-5-3) ----
 *
 * This module used to speak `@nimbo/core`'s retired `SessionEvent` union and
 * maintain a handful of server-invented wire-only sentinels/events on top of
 * it (`user.message`, `turn.result`/`turn.failed`, `approval.requested`/
 * `approval.resolved`, `question.asked`/`question.answered` — see
 * `schemas/chat.ts`'s file header for the full retirement list). It now
 * speaks `NimboChunk` (ai's `UIMessageChunk` vocabulary) directly, one-to-one
 * with what `session.stream()` yields, plus exactly one synthetic
 * `message-metadata` chunk for the genuinely-unexpected-throw case (see
 * `drive.ts`'s `driveTurn`'s `catch` branch) and exactly one synthetic
 * `MessageFrame` per turn — the turn-start user message (see `driveTurn`'s own
 * comment; this is this ticket's fix for docs/agent/single-ledger/tech.md §5 引言's
 * "用户消息乱序/叠在一起" bug, closing the gap `schemas/chat.ts`'s file header
 * used to describe) — no other server-invented wire shapes left.
 *
 * Two responsibilities that used to be entangled in "persist + broadcast +
 * emit a bridge event" are now separate — and, since the split, live in two
 * different files:
 *
 * 1. **Persistence** (`persistence.ts`): every durable chunk, plus the
 *    turn-start user message, gets a `seq` and a row
 *    (`kind = 'chunk'`/`'message'` respectively) as it arrives; once the turn
 *    finishes gracefully, its remaining newly-appended `NimboUIMessage`s
 *    (assistant steps, steer-injected user messages) get `kind = 'message'`
 *    rows too and the turn's now-superseded `kind = 'chunk'` rows are deleted
 *    (`store.ts`'s `deleteChunkEventsAfter`) — docs/agent/single-ledger/tech.md §5 单-3's "写入时序".
 * 2. **审批/ask-user bridges** (`human-bridge.ts`): pure in-memory promise
 *    routing now, with **no `emit` calls at all**. Visibility of a
 *    pending approval is `@nimbo/core`'s own `tool-approval-request` chunk
 *    (docs/agent/single-ledger/tech.md §6.1 — the loop yields it *before* `await`ing `onReview`, so
 *    it's already on the wire the instant a human's needed); visibility of
 *    its resolution is the matching `tool-approval-response` chunk the loop
 *    yields once `onReview` resolves. Both flow through `session.stream()`
 *    like any other chunk — this module doesn't need to (and must not)
 *    re-announce them. Same story for `ask-user`: its pending/answered state
 *    is just the `tool-ask-user` part's own `input-available`/
 *    `output-available` states, a normal tool call as far as the loop is
 *    concerned.
 *
 * 除这两件事外，本目录还有两个**纯通知点**，都不改变任何 chunk 流转/持久化行为：
 * `onTurnSettled`（这一轮彻底结束了，`start.ts`）与 `onMilestone`（这一轮的第一个
 * chunk / 第一个可见 chunk 抵达了，`drive.ts`，docs/app/telemetry/tech.md §2.4）。两者的
 * 共同姿态是「本目录只报告生命周期事件，要不要因此起下一轮、要不要落一行遥测，是
 * 注入方的事」——所以这里既不认识「队列」，也不认识「遥测」。
 *
 * ---- 停止本轮（docs/agent/turn-abort/tech.md） ----
 *
 * 每一轮自带一个 `AbortController`（`ActiveTurn.abortController`），signal 经
 * `session.stream(text, { signal })` 交给 `@nimbo/core`；`abortTurn()` 触发它。
 * 被[停止](../../../../../docs/terms.md)的一轮走的是 core 的**优雅收尾**路径
 * （`status: 'interrupted'` 的 `message-metadata` + 正常 `return TurnResult`），所以
 * 落盘/GC/`onTurnSettled` 全部按既有路径跑完——本目录因此不需要为「停止」新增任何
 * wire 形状或账本条目类型。唯一的额外动作在 `abort.ts` 里：把挂起的人审/ask-user
 * 就地结掉（core 正 `await` 那些 promise，abort 信号对它们无效）。
 */
export { abortTurn } from './abort.js';
export { ABORT_REASON_SHUTDOWN } from './abort-reasons.js';
export type {
  TurnMilestone,
  TurnMilestoneInfo,
  TurnSettledInfo,
} from './drive.js';
export type {
  RequestReviewInput,
  RequestReviewOptions,
  RequestUserAnswerInput,
  RequestUserAnswerOptions,
} from './human-bridge.js';
export {
  requestReview,
  requestUserAnswer,
  resolveApprovalTimeoutMs,
  resolveAskUserTimeoutMs,
  resolveReview,
  resolveUserAnswer,
} from './human-bridge.js';
export type { AskUserOutcome } from './registry.js';
export {
  broadcastQueue,
  isTurnActive,
  isTurnPreparing,
  steerTurn,
  subscribeTurn,
} from './registry.js';
export type { ReserveTurnResult, TurnReservation } from './reservation.js';
export { releaseTurn, reserveTurn } from './reservation.js';
export type { TurnDrivenSession } from './session.js';
export type { ShutdownResult } from './shutdown.js';
export {
  __resetShutdownForTests,
  isShuttingDown,
  shutdownTurns,
} from './shutdown.js';
export type { StartTurnParams, StartTurnResult } from './start.js';
export { startTurn } from './start.js';
