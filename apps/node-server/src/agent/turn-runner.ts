/**
 * Turn execution/connection decoupling (docs/tech/chat-webapp.md §2.2b,
 * the P12-4 fix for "SSE 断开后进行中 turn 的后续输出不再到达页面"): a chat
 * turn is driven entirely in-process, independent of any HTTP request —
 * `POST .../messages` (`routes/chat.ts`) only *starts* it (`startTurn`),
 * `GET .../stream` only *observes* it (`subscribeTurn`/`isTurnActive`). A
 * client disconnecting (page refresh, HMR, network blip) never interrupts
 * the turn: every *durable* chunk (docs/tech/single-ledger.md §5
 * 单-3's durable/ephemeral split, `isDurableChunk` below) is persisted
 * (`conversation_events`, monotonic `seq`) before it's ever handed to a subscriber,
 * so a fresh `GET .../stream?after=<seq>` on reconnect replays whatever was
 * missed and then keeps forwarding live chunks until the turn ends.
 *
 * `TurnDrivenSession` is the one seam onto `@nimbo/sdk`'s `Session` — the
 * same "structural interface, not the concrete class" discipline as
 * `sandbox-manager.ts`'s `SandboxProvider` — so `startTurn` can be driven by a
 * fake `stream()`/`toJSON()` pair in tests, no real model/sandbox involved
 * (see test/agent/turn-runner.test.ts).
 *
 * Process-restart caveat (docs/tech/chat-webapp.md §2.2b "边界"): `activeTurns` is in-memory
 * only — a server restart mid-turn silently drops it (the sandbox may still
 * be running, but nothing drives `session.stream()` forward anymore). Rows
 * already persisted stay put; the next `GET .../stream` finds no active
 * turn and just replays up to the crash point (docs/tech/single-ledger.md §5 单-3: this turn's
 * `kind = 'chunk'` rows never got GC'd, since `finalizeTurnPersistence`
 * never ran — accepted residue, see schema.ts's own doc comment). This is
 * v1's documented trade-off, not a bug to fix here.
 *
 * ---- UIMessage 单账本 migration (docs/tech/single-ledger.md §5 单-3, P13-5-3) ----
 *
 * This module used to speak `@nimbo/core`'s retired `SessionEvent` union and
 * maintain a handful of server-invented wire-only sentinels/events on top of
 * it (`user.message`, `turn.result`/`turn.failed`, `approval.requested`/
 * `approval.resolved`, `question.asked`/`question.answered` — see
 * `schemas/chat.ts`'s file header for the full retirement list). It now
 * speaks `NimboChunk` (ai's `UIMessageChunk` vocabulary) directly, one-to-one
 * with what `session.stream()` yields, plus exactly one synthetic
 * `message-metadata` chunk for the genuinely-unexpected-throw case (see
 * `driveTurn`'s `catch` branch) and exactly one synthetic `MessageFrame` per
 * turn — the turn-start user message (see `driveTurn`'s own comment; this is
 * this ticket's fix for docs/tech/single-ledger.md §5 引言's "用户消息乱序/叠在一起" bug, closing
 * the gap `schemas/chat.ts`'s file header used to describe) — no other
 * server-invented wire shapes left.
 *
 * Two responsibilities that used to be entangled in "persist + broadcast +
 * emit a bridge event" are now separate:
 *
 * 1. **Persistence** (`createTurnEmitter`/`finalizeTurnPersistence`): every
 *    durable chunk, plus the turn-start user message, gets a `seq` and a row
 *    (`kind = 'chunk'`/`'message'` respectively) as it arrives; once the turn
 *    finishes gracefully, its remaining newly-appended `NimboUIMessage`s
 *    (assistant steps, steer-injected user messages) get `kind = 'message'`
 *    rows too and the turn's now-superseded `kind = 'chunk'` rows are deleted
 *    (`store.ts`'s `deleteChunkEventsAfter`) — docs/tech/single-ledger.md §5 单-3's "写入时序".
 * 2. **审批/ask-user bridges** (`requestReview`/`resolveReview`,
 *    `requestUserAnswer`/`resolveUserAnswer`): pure in-memory promise
 *    routing now, with **no `emit` calls at all**. Visibility of a
 *    pending approval is `@nimbo/core`'s own `tool-approval-request` chunk
 *    (docs/tech/single-ledger.md §6.1 — the loop yields it *before* `await`ing `onReview`, so
 *    it's already on the wire the instant a human's needed); visibility of
 *    its resolution is the matching `tool-approval-response` chunk the loop
 *    yields once `onReview` resolves. Both flow through `session.stream()`
 *    like any other chunk — this module doesn't need to (and must not)
 *    re-announce them. Same story for `ask-user`: its pending/answered state
 *    is just the `tool-ask-user` part's own `input-available`/
 *    `output-available` states, a normal tool call as far as the loop is
 *    concerned.
 *
 * 除这两件事外，本模块还有两个**纯通知点**，都不改变任何 chunk 流转/持久化行为：
 * `onTurnSettled`（这一轮彻底结束了）与 `onMilestone`（这一轮的第一个 chunk /
 * 第一个可见 chunk 抵达了，docs/tech/telemetry.md §2.4）。两者的共同姿态是「本模块
 * 只报告生命周期事件，要不要因此起下一轮、要不要落一行遥测，是注入方的事」——所以
 * 这里既不认识「队列」，也不认识「遥测」。
 *
 * ---- 停止本轮（docs/tech/turn-abort.md） ----
 *
 * 每一轮自带一个 `AbortController`（`ActiveTurn.abortController`），signal 经
 * `session.stream(text, { signal })` 交给 `@nimbo/core`；`abortTurn()` 触发它。
 * 被[停止](../../../../docs/terms.md)的一轮走的是 core 的**优雅收尾**路径
 * （`status: 'interrupted'` 的 `message-metadata` + 正常 `return TurnResult`），所以
 * 这里的落盘/GC/`onTurnSettled` 全部按既有路径跑完——本模块因此不需要为「停止」
 * 新增任何 wire 形状或账本条目类型。唯一的额外动作在 `abortTurn` 里：把挂起的
 * 人审/ask-user 就地结掉（core 正 `await` 那些 promise，abort 信号对它们无效）。
 */
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import type {
  HumanDecision,
  JsonValue,
  NimboChunk,
  NimboMessageMetadata,
  NimboUIMessage,
  SessionState,
  TurnResult,
} from '@nimbo/core';

import type { LogFields, Logger } from '../logger.js';
import { logger as defaultLogger, truncate } from '../logger.js';
import type {
  ChatReplayFrame,
  ChunkEnvelope,
  MessageFrame,
  QueuedMessage,
  QueueFrame,
} from '../schemas/chat.js';
import { grantSessionApproval } from './session-grants.js';
import type { Db } from './store.js';
import {
  appendConversationEvent,
  deleteChunkEventsAfter,
  getMaxEventSeq,
  updateConversation,
} from './store.js';

/**
 * 本文件所有日志的固定 scope（打点覆盖设计定案：turn/step/tool
 * call 级别可观测性）——纯旁路 tap，不改变 chunk 流转/持久化行为，见下方
 * `driveTurn`/`finalizeTurnPersistence`。
 */
const LOG_SCOPE = 'turn-runner';

/** `driveTurn` 记 `turn 开始` 时 `text` 预览的字符数上限。 */
const TEXT_PREVIEW_LENGTH = 120;

/** `tool-input-available` 记 `input` 预览的字符数上限。 */
const TOOL_INPUT_PREVIEW_LENGTH = 200;

/**
 * 工具 `input`/`output` 在 ai 的 `UIMessageChunk` 词汇表里就是 `unknown`
 * （`@nimbo/core`'s `state.ts` 头注释记录过的同一个"受控例外"——nimbo 的
 * 工具集编译期完全动态，没有字面量联合可收窄）；这里只把它安全转成一行
 * 预览文本，不假设其具体形状。
 */
function previewUnknown(value: unknown, maxLength: number): string {
  if (typeof value === 'string') return truncate(value, maxLength);
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return truncate(json, maxLength);
  } catch {
    // 循环引用/不可序列化——退化到 String()。
  }
  return truncate(String(value), maxLength);
}

/** `tool-output-available` 的"输出大小"——JSON 序列化后的字符数，量级足够日志判断用途，不追求精确字节数。 */
function measureOutputSize(value: unknown): number {
  if (typeof value === 'string') return value.length;
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json.length;
  } catch {
    // 循环引用/不可序列化——退化到 String()。
  }
  return String(value).length;
}

/**
 * 一次工具调用的结算日志，攒到对应的 `data-tool-timing`（`completedAt`）
 * chunk 抵达才真正落一行——耗时必须从这个 chunk 读（"保持单一来源"：
 * `@nimbo/core`'s loop 是唯一产出起止时间戳的地方，见工单设计定案），
 * 不能自己在这里另打一份 `Date.now()` 时钟去凑耗时。
 */
interface PendingToolSettlement {
  level: 'info' | 'warn';
  message: string;
  fields: LogFields;
}

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
  /**
   * `opts` 是 `@nimbo/core` 的 `TurnOptions` 里本模块唯一用到的那一项
   * （docs/tech/turn-abort.md §3.1）：每一轮自己的 `AbortController.signal`，
   * [停止](../../../../docs/terms.md)靠它落地。声明成可选 + 只含 `signal`，所以
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

/**
 * One turn's persist-then-broadcast surface (see `createTurnEmitter`) —
 * threaded through `driveTurn` only; the 审批/ask-user bridges below no
 * longer touch this at all (see file header). `emitMessage` and `emitChunk`
 * share one underlying monotonic `seq` counter (`createTurnEmitter`'s own
 * closure) — `driveTurn` calls `emitMessage` exactly once, for the turn-start
 * synthesized user message, strictly before it ever calls `emitChunk` for
 * that same turn, so the message frame always lands at the lowest `seq` in
 * the turn's range.
 */
interface TurnEmitter {
  emitMessage: (message: NimboUIMessage) => void;
  emitChunk: (chunk: NimboChunk) => void;
}

/**
 * docs/tech/single-ledger.md §5 单-3's durable/ephemeral split
 * (P13-1's "过程帧只直播不落盘" carried over verbatim onto the new chunk
 * vocabulary): `text-delta`/`reasoning-delta` (the actual streamed
 * increments) and any chunk explicitly marked `transient: true` (today just
 * `data-tool-progress`, `@nimbo/core`'s `loop.ts`) are ephemeral —
 * broadcast-only, never persisted, never consume a `seq`. Every other chunk
 * `@nimbo/core`'s loop can produce — tool state (incl.
 * `tool-approval-request`/`tool-approval-response`), non-transient data
 * parts, step markers, message `start`/`finish`/`message-metadata` — is
 * durable.
 *
 * Written as a blanket "everything but these three is durable" rule (rather
 * than an explicit allowlist of durable types) so it stays correct for any
 * chunk type `@nimbo/core` might start producing later without this file
 * needing to grow a matching case for it.
 */
function isDurableChunk(chunk: NimboChunk): boolean {
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
    return false;
  }
  return !('transient' in chunk && chunk.transient === true);
}

/**
 * One pending `requestReview`/`requestUserAnswer` call, parked until
 * `resolveReview`/`resolveUserAnswer` (a human decision/answer, or the
 * timeout) settles it — the one piece genuinely identical between the two
 * bridges, see `takePending`.
 */
interface PendingEntry<T> {
  resolve: (value: T) => void;
  timer: NodeJS.Timeout;
}

/**
 * A pending review carries the call's `toolName`/`input` alongside the usual
 * resolve/timer — so `resolveReview` can record a 会话级授权 (`session-grants.ts`)
 * for *this exact call* when the human picks 「会话内都允许」, without the route
 * (which only knows `callId`) having to look the tool call up itself.
 */
interface ReviewPendingEntry extends PendingEntry<HumanDecision> {
  toolName: string;
  input: JsonValue;
}

/**
 * 一轮的两个「首次」时刻（docs/tech/telemetry.md §2.4）——本模块只**报告**它们，
 * 拼遥测载荷、写库都在 `turn-launcher.ts`（与 `onTurnSettled` 同款姿态：turn-runner
 * 不认识队列，也不认识遥测）。
 *
 * - `'first-chunk'`：这一轮的第一个 chunk 抵达。core 的 loop 在**发出模型请求之前**
 *   就 yield `start`/`start-step`，所以这个时刻量的是「起轮到 `session.stream()` 真
 *   正开跑」，**不含**模型首 token。
 * - `'first-output'`：第一个**用户看得见**的 chunk 抵达（见 `isVisibleChunk`）。它减
 *   去上一个就是模型首 token 的等待。
 *
 * 各触发**至多一次**，且 `'first-chunk'` 必然不晚于 `'first-output'`。
 */
export type TurnMilestone = 'first-chunk' | 'first-output';

export interface TurnMilestoneInfo {
  /** nimbo 会话 id（`session.toJSON().id`）——遥测的关联键前半段。 */
  sessionId: string;
  /** 本轮轮号（`session.toJSON().turn`，`session.stream()` 已在开跑时 `+1`）——关联键后半段。 */
  turn: number;
  /** 从 `driveTurn` 入口（≈`startTurn` 调用时刻）到这个时刻的毫秒数。 */
  sinceStartMs: number;
}

/**
 * 「用户在界面上看得见东西了」——第一段文字、第一段推理、或第一张工具调用卡片。
 * 刻意不含 `start`/`start-step`（空气泡，界面上还是一片空白）与
 * `data-*`/`tool-approval-request`（它们只可能出现在某个工具调用之后，永远抢不到
 * 第一）。
 */
function isVisibleChunk(chunk: NimboChunk): boolean {
  return (
    chunk.type === 'text-start' ||
    chunk.type === 'reasoning-start' ||
    chunk.type === 'tool-input-available'
  );
}

/** The outcome of one `ask-user` call (docs/tech/chat-webapp.md §2.2c（审批链）) — `'timeout'` never carries an `answer`, same as `HumanDecision`'s `deny` branch not requiring a `message`. */
export type AskUserOutcome =
  { outcome: 'answered'; answer: string } | { outcome: 'timeout' };

/**
 * 一轮在 `activeTurns` 里的两个阶段（docs/tech/turn-abort.md §3.3）。
 *
 * `preparing` = [起轮占位](../../../../docs/terms.md)：`turn-launcher.ts` 的
 * `launchTurn` 一进门就占下这个位子，此后整段[起轮装配](../../../../docs/terms.md)
 * （取沙盒、续期、扫 skill、建 session）期间这一轮就算**存在**——所以它可以被
 * [停止](../../../../docs/terms.md)，同会话后来的消息也会走[排队](../../../../docs/terms.md)。
 * 装配跑完由 `startTurn` **原地**升级成 `running`（同一个 `ActiveTurn` 对象、同一个
 * `emitter`、同一个 `abortController`——不是「删占位再登记」，那中间又是一个新空窗）。
 */
type TurnPhase = 'preparing' | 'running';

interface ActiveTurn {
  phase: TurnPhase;
  emitter: EventEmitter;
  done: boolean;
  /**
   * 这一轮的中止闸门（docs/tech/turn-abort.md §3）——`startTurn` 建、
   * `session.stream(text, { signal })` 消费、`abortTurn` 触发。
   */
  abortController: AbortController;
  /**
   * 已请求[停止](../../../../docs/terms.md)。两个用途：`abortTurn` 的幂等判定，以及
   * `requestReview`/`requestUserAnswer` 的「别再挂新的」闸门——停止之后 core 若还为
   * 同一步里其它并行工具调用请求[人审](../../../../docs/terms.md)（`loop.ts` 的
   * `mergeSettleStreams` 让一步内多个工具调用并发结算），那些请求必须立即被拒，
   * 否则它们会各自挂到自己的超时（默认 240 秒），把「停止」拖成「四分钟后停止」。
   */
  aborted: boolean;
  /**
   * Bound to this turn's own `session.steer` at registration time (STEER-3B) — see `steerTurn`.
   *
   * `preparing` 阶段是 `undefined`：那时还没有 `session` 可绑，[插话](../../../../docs/terms.md)
   * 也就无处可插（路由据此把这条消息转成排队，见 `isTurnPreparing`）。
   */
  steer: ((input: string) => boolean) | undefined;
  /** Keyed by `callId` (`@nimbo/core`'s `ApprovalContext.callId`, docs/tech/single-ledger.md §6.4) — see `requestReview`/`resolveReview`. Carries `toolName`/`input` (`ReviewPendingEntry`) so `resolveReview` can grant a 会话级授权 for the exact call. */
  pendingReviews: Map<string, ReviewPendingEntry>;
  /** Keyed by `callId` (docs/tech/chat-webapp.md §2.2c（审批链）) — see `requestUserAnswer`/`resolveUserAnswer`. Independent of `pendingReviews`: same shape, different `Map`. */
  pendingQuestions: Map<string, PendingEntry<AskUserOutcome>>;
}

const activeTurns = new Map<string, ActiveTurn>();

export function isTurnActive(conversationId: string): boolean {
  return activeTurns.has(conversationId);
}

/**
 * 这个会话有没有一轮**卡在[起轮装配](../../../../docs/terms.md)里**
 * （docs/tech/turn-abort.md §3.3）——`routes/chat.ts` 用它给[插话](../../../../docs/terms.md)
 * 分流：装配中的轮没有 `session` 可插，那条消息该转成[排队](../../../../docs/terms.md)，
 * 而不是像「这一轮刚好结束」那个窄竞态一样回落去起新一轮（会被自己的占位挡成 409）。
 */
export function isTurnPreparing(conversationId: string): boolean {
  return activeTurns.get(conversationId)?.phase === 'preparing';
}

// ---------------------------------------------------------------------------
// 优雅关闭（docs/tech/graceful-shutdown.md §3）
// ---------------------------------------------------------------------------

/**
 * [优雅关闭](../../../../docs/terms.md)闸门。置真后 `reserveTurn` 一律拒绝——关闭期间
 * 绝不接新的轮，否则 `shutdownTurns` 会永远等不完（每一轮收尾都可能触发
 * [自动出队](../../../../docs/terms.md)起下一轮）。
 *
 * 模块级、单向、不可复位：一个进程只关闭一次。
 */
let shuttingDown = false;

/** 进程是否正在[优雅关闭](../../../../docs/terms.md)——`index.ts` 用它做重复信号的幂等判据，路由用它转 503。 */
export function isShuttingDown(): boolean {
  return shuttingDown;
}

/**
 * **仅供测试**：把关闭闸门复位。
 *
 * 生产里一个进程只关闭一次，所以 `shuttingDown` 是单向的、没有复位入口。但
 * `activeTurns`/`shuttingDown` 都是**模块级**状态、跨用例存活——测过一次
 * `shutdownTurns` 之后若不复位，同一个文件里后面所有用例的 `reserveTurn` 都会被拒，
 * 连锁失败。名字刻意难看（`__` 前缀）就是为了让它在业务代码里显得格格不入。
 */
export function __resetShutdownForTests(): void {
  shuttingDown = false;
}

export interface ShutdownResult {
  /** 这次关闭中止了几个轮（含还在[起轮装配](../../../../docs/terms.md)里的）。 */
  aborted: number;
  /** 是否全部收尾完毕。`false` = 撞了超时上限，还有轮没等到。 */
  settled: boolean;
  /** 撞超时时还剩几个没收尾（`settled` 为真时恒为 0）。 */
  pending: number;
}

/**
 * 关闭前把所有进行中的轮停下来并等它们收尾（docs/tech/graceful-shutdown.md §3.1）。
 *
 * 四步的顺序都是硬要求：
 *
 * 1. **先置关闭闸门**。否则收尾期间[自动出队](../../../../docs/terms.md)会起新一轮
 *    （每个 `onTurnSettled` 都可能起一轮），这个函数就永远等不完。
 * 2. **快照当前全部活跃轮**，并为每个备好一个「收尾了」的 promise。监听它自己 emitter
 *    的 `done`；已经 `done` 的直接算完成——`emit('done')` 与 `done = true` 在
 *    `startTurn` 的 `finally` 里是同一个同步块，所以不存在「emit 已过、once 收不到、
 *    done 还是 false」的漏窗。
 * 3. **逐个 `abortTurn(id, reason)`**：reason 就是 `ABORT_REASON_SHUTDOWN`，经 core 透传
 *    进收尾 metadata，界面据此显示「服务重启，这一轮已中断」。
 * 4. **等齐或撞超时**。撞超时不抛错也不强制清理登记：那些轮成了
 *    [孤儿轮](../../../../docs/terms.md)，交给下次启动的 `crash-recovery.ts` 补收尾
 *    （两道防线在这里接上，docs/tech/graceful-shutdown.md §7.1）。
 *
 * 刻意**不碰 `process.exit`**：本模块只负责让轮停下来，退不退进程是 `index.ts` 的事
 * ——与 `onTurnSettled`「本模块只报告生命周期事件」的既有纪律同一姿态。
 */
export async function shutdownTurns(opts: {
  timeoutMs: number;
  /** 缺省即 `ABORT_REASON_SHUTDOWN`；测试可传自己的以断言透传。 */
  reason?: string;
  logger?: Logger;
}): Promise<ShutdownResult> {
  const log = opts.logger ?? defaultLogger;
  shuttingDown = true;

  const snapshot = [...activeTurns.entries()];
  if (snapshot.length === 0) {
    // 空闲时关闭：秒退，不产生任何收尾帧、不打噪音日志（产品文档 §4 成功标准 8）。
    log.debug(LOG_SCOPE, 'shutdown: no active turns', {});
    return { aborted: 0, settled: true, pending: 0 };
  }

  log.info(LOG_SCOPE, 'shutdown: aborting active turns', {
    count: snapshot.length,
    timeoutMs: opts.timeoutMs,
  });

  const settledPromises = snapshot.map(
    ([, activeTurn]) =>
      new Promise<void>((resolve) => {
        if (activeTurn.done) {
          resolve();
          return;
        }
        activeTurn.emitter.once('done', () => {
          resolve();
        });
      }),
  );

  for (const [conversationId] of snapshot) {
    abortTurn(conversationId, opts.reason ?? ABORT_REASON_SHUTDOWN, log);
  }

  let timer: NodeJS.Timeout | undefined;
  const timedOut = await Promise.race([
    Promise.all(settledPromises).then(() => false),
    new Promise<true>((resolve) => {
      timer = setTimeout(() => {
        resolve(true);
      }, opts.timeoutMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);

  const pending = activeTurns.size;
  if (timedOut) {
    // 如实报告，别假装干净收尾了：这些轮会以孤儿轮的形态留在账本里。
    log.error(LOG_SCOPE, 'shutdown: timed out waiting for turns to settle', {
      aborted: snapshot.length,
      pending,
    });
    return { aborted: snapshot.length, settled: false, pending };
  }

  log.info(LOG_SCOPE, 'shutdown: all turns settled', {
    aborted: snapshot.length,
  });
  return { aborted: snapshot.length, settled: true, pending: 0 };
}

/**
 * `POST .../messages` (routes/chat.ts) calls this first: if `conversationId` has
 * a turn in progress, forward `text` into it via the session's own
 * `steer()` instead of starting a new turn — returns whatever `steer()`
 * reported (`true` = queued, injected at the next step checkpoint;
 * `false` = the turn's `steer` doesn't support it, or (rare race) the turn
 * finished between this call landing and `steer()` checking its own
 * in-flight state). No active turn at all also returns `false`. Either way,
 * a `false` here is the route's cue to fall back to `startTurn` instead.
 */
export function steerTurn(conversationId: string, text: string): boolean {
  const activeTurn = activeTurns.get(conversationId);
  if (activeTurn === undefined) return false;
  // `undefined` = 这一轮还在[起轮装配](../../../../docs/terms.md)里（`preparing`，还没有
  // session）——同样报 `false`，但路由要按 `isTurnPreparing` 区分这两种 `false`
  // （docs/tech/turn-abort.md §3.3）。
  return activeTurn.steer?.(text) ?? false;
}

/** 停止时给挂起的[审批卡片](../../../../docs/terms.md)回填的拒绝理由——会进模型上下文，故写成一句模型读得懂的话。 */
const ABORT_DENY_MESSAGE =
  'The user stopped this turn, so this tool call was not approved.';

/** 用户按下停止键时的中止理由——经 core 透传成收尾 `NimboError.message`（见 `abortTurn` 的 `reason` 参数）。 */
const ABORT_REASON_USER = 'Turn stopped by the user.';

/**
 * [优雅关闭](../../../../docs/terms.md)时的中止理由（docs/tech/graceful-shutdown.md §4）。
 *
 * **这是一个跨三处的文案契约**，改它要同时改三处，否则界面会把「服务重启」显示成
 * 「用户按了停止」：
 *
 * 1. 这里——`shutdownTurns` 用它 abort，经 core 的 `abortMessage` 透传进收尾
 *    `NimboError.message`；
 * 2. `crash-recovery.ts`——[孤儿轮](../../../../docs/terms.md)补的那条收尾 metadata；
 * 3. `apps/web` 的 `turn-marker.tsx`——命中它才显示「服务重启，这一轮已中断」。
 *
 * 之所以用文案而不是给 `NimboError.code` 加一个值：「服务要关闭了」是宿主的运维概念，
 * 不该塞进 SDK 的类型联合（理由详见 docs/tech/graceful-shutdown.md §2）。
 */
export const ABORT_REASON_SHUTDOWN =
  'The server shut down while this turn was running.';

/**
 * [停止](../../../../docs/terms.md)这个会话进行中的那一轮（docs/tech/turn-abort.md §3.1）
 * ——`routes/chat.ts` 的 `POST .../abort` 调它。返回 `false` = 没有进行中的一轮可停
 * （路由转 409）；`true` = 停止已请求（**不代表已经停住**，真正停下的时刻见
 * docs/features/turn-abort.md §2.3）。
 *
 * 四步的顺序都是硬要求：
 *
 * 1. **幂等**：已经请求过就直接 `true` 返回，连点停止键不会重复走下面的收尾。
 * 2. **先置 `aborted` 标志**，再做后面两步——它同时是 `requestReview`/
 *    `requestUserAnswer` 的闸门（见 `ActiveTurn.aborted` 注释）。
 * 3. **结掉已经挂起的人审/提问**：core 正 `await` 这些 promise 时，abort 信号对它
 *    毫无作用（`loop.ts` 的 `settleToolCall` 只是在等一个普通 promise）——这是整个
 *    功能里唯一一处「光有 abort 信号不够」的地方。快照 key 再遍历：`resolveReview`/
 *    `settleQuestion` 会就地删 Map 条目，不能边删边迭代。
 * 4. **最后 abort**：信号一放出去，这一轮随时可能收尾（`driveTurn` 的 `finally` 会
 *    把它从 `activeTurns` 删掉），此后再碰 `activeTurn` 的状态就没有意义了。
 */
export function abortTurn(
  conversationId: string,
  /**
   * 中止理由——core 会把它透传成收尾 `NimboError.message`（`loop.ts` 的 `abortMessage`），
   * 界面据此区分「已停止」与「服务重启，这一轮已中断」。缺省即用户按了停止键。
   */
  reason: string = ABORT_REASON_USER,
  logger?: Logger,
): boolean {
  const log = logger ?? defaultLogger;
  const activeTurn = activeTurns.get(conversationId);
  if (activeTurn === undefined) return false;
  if (activeTurn.aborted) return true;

  activeTurn.aborted = true;

  const pendingReviewIds = [...activeTurn.pendingReviews.keys()];
  const pendingQuestionIds = [...activeTurn.pendingQuestions.keys()];
  log.info(LOG_SCOPE, 'turn abort requested', {
    conversationId,
    // `preparing` = 停在[起轮装配](../../../../docs/terms.md)窗口里（docs/tech/turn-abort.md §3.3）：
    // 这一轮还没启动，收尾由 `releaseTurn` 补，不走 core 的 loop。
    phase: activeTurn.phase,
    pendingReviews: pendingReviewIds.length,
    pendingQuestions: pendingQuestionIds.length,
  });

  for (const callId of pendingReviewIds) {
    resolveReview(conversationId, callId, {
      behavior: 'deny',
      message: ABORT_DENY_MESSAGE,
    });
  }
  for (const callId of pendingQuestionIds) {
    settleQuestion(conversationId, callId, { outcome: 'timeout' });
  }

  activeTurn.abortController.abort(new Error(reason));
  return true;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The turn's one seq-counting, persist-then-broadcast closure — lifted out
 * of `driveTurn` so `startTurn` can hang it off `ActiveTurn.emit`. `startSeq`
 * is `getMaxEventSeq(db, conversationId)` taken once, synchronously, at
 * `startTurn`-time — the same reading `finalizeTurnPersistence`'s GC
 * threshold (`turnStartSeq`) uses, so the two agree on exactly which `seq`
 * range belongs to this turn (docs/tech/single-ledger.md §5 单-3).
 *
 * `emitMessage` (the turn-start synthesized user message, `driveTurn` calls
 * it exactly once, first) and `emitChunk` (every subsequent `NimboChunk`)
 * share the same `seq` closure — durable frames of either kind consume the
 * next `seq`; ephemeral chunks (`isDurableChunk` false) skip both `seq += 1`
 * and `appendConversationEvent` entirely — straight broadcast, envelope carries no
 * `seq` at all (see `schemas/chat.ts`'s `chunkEnvelopeSchema` doc comment).
 * This is the load-bearing invariant `finalizeTurnPersistence`'s GC leans on:
 * because ephemeral chunks never consume a seq number, every `seq` strictly
 * greater than `startSeq` by the time the turn finishes is either a durable
 * frame (message or chunk) row from *this* turn or (after
 * `finalizeTurnPersistence` appends them) a `kind = 'message'` row from this
 * same turn — nothing else could have landed in that range (a session only
 * ever has one turn driving it, see `startTurn`'s `activeTurns.has` guard).
 */
function createTurnEmitter(
  db: Db,
  conversationId: string,
  emitter: EventEmitter,
  startSeq: number,
): TurnEmitter {
  let seq = startSeq;
  return {
    emitMessage(message: NimboUIMessage): void {
      seq += 1;
      appendConversationEvent(db, {
        conversationId,
        seq,
        kind: 'message',
        payloadJson: JSON.stringify(message),
      });
      const frame: MessageFrame = { seq, message };
      emitter.emit('event', frame);
    },
    emitChunk(chunk: NimboChunk): void {
      if (!isDurableChunk(chunk)) {
        emitter.emit('event', { chunk } satisfies ChunkEnvelope);
        return;
      }
      seq += 1;
      appendConversationEvent(db, {
        conversationId,
        seq,
        kind: 'chunk',
        payloadJson: JSON.stringify(chunk),
      });
      const envelope: ChunkEnvelope = { seq, chunk };
      emitter.emit('event', envelope);
    },
  };
}

/**
 * Turn-finalization persistence (docs/tech/single-ledger.md §5 单-3's "写入时序", called from
 * `driveTurn`'s graceful-finish path only — never from the `catch` branch,
 * see its own comment): slices out this turn's newly-appended messages
 * *past its own turn-start user message* (`state.messages` past
 * `priorMessageCount + 1` — `priorMessageCount` is where `@nimbo/core`'s own
 * turn-start user `NimboUIMessage` landed, `session.ts`'s `stream()` pushing
 * it synchronously before ever yielding anything; `driveTurn` already
 * persisted+broadcast a structurally-identical (different `id`) copy of that
 * exact message *before* it started consuming the stream at all — see that
 * function's own comment — so this function must not persist core's copy a
 * second time under a second id), appends one `kind = 'message'` row per
 * *remaining* message (assistant step messages, plus any steer-injected user
 * messages `loop.ts`'s `drainSteerMessages` spliced in mid-turn — those
 * already reached the wire live via their own chunk sequence and are
 * persisted here exactly as before, untouched by the `+ 1`) — byte-for-byte
 * what `Session.toJSON()` produced for them (the "message 条目必须与
 * `session.toJSON().messages` 字节一致" invariant, now scoped to everything
 * after the turn-start user message), GCs this turn's now-superseded
 * `kind = 'chunk'` rows (`store.ts`'s `deleteChunkEventsAfter`), and updates
 * `conversations`'s scalar header + activity bookkeeping. Order matters:
 * messages are appended *before* the GC delete — a crash between the two
 * just leaves some not-yet-GC'd chunk rows around (harmless, extra data),
 * whereas the reverse order could lose this turn's content entirely if a
 * crash landed between them.
 */
function finalizeTurnPersistence(
  db: Db,
  conversationId: string,
  state: SessionState,
  priorMessageCount: number,
  turnStartSeq: number,
  log: Logger,
): void {
  const newMessages = state.messages.slice(priorMessageCount + 1);
  let seq = getMaxEventSeq(db, conversationId);
  for (const message of newMessages) {
    seq += 1;
    appendConversationEvent(db, {
      conversationId,
      seq,
      kind: 'message',
      payloadJson: JSON.stringify(message),
    });
  }
  deleteChunkEventsAfter(db, conversationId, turnStartSeq);
  updateConversation(db, conversationId, {
    status: 'active',
    lastActiveAt: new Date(),
    agentSessionHeader: {
      conversationId: state.id,
      createdAt: new Date(state.createdAt),
      turn: state.turn,
    },
  });
  log.debug(LOG_SCOPE, 'turn persistence finalized', {
    conversationId,
    messageCount: newMessages.length,
  });
}

/** Best-effort `turn` number for the synthetic failure chunk `driveTurn`'s `catch` branch emits — `session.toJSON()` itself throwing (defensive; not expected) just means "unknown", not a second unhandled throw. */
function bestEffortTurn(session: TurnDrivenSession): number | undefined {
  try {
    return session.toJSON().turn;
  } catch {
    return undefined;
  }
}

/**
 * Chunk-level log tap — called once per chunk `driveTurn`'s while loop
 * consumes, strictly *before* `emit.emitChunk` (read-only, never mutates or
 * withholds a chunk — see file header "纯旁路 tap"). Mutates the three maps
 * threaded in from `driveTurn`'s own locals: `pendingApprovalRequests`
 * (`approvalId` → the `Date.now()` this tap observed the request) and
 * `pendingSettlements` (`toolCallId` → the not-yet-logged settlement line,
 * parked until its `data-tool-timing` `completedAt` update arrives — "保持
 * 单一来源": duration is always read off that chunk, never a second
 * `Date.now()` pair kept here) — both are `driveTurn`-local, one turn each,
 * so nothing survives across turns to leak. Returns the possibly-bumped step
 * counter (`start-step`/`finish-step` share one running count) since a
 * plain number can't be mutated through a reference the way the two `Map`s
 * are.
 */
function logChunk(
  log: Logger,
  conversationId: string,
  chunk: NimboChunk,
  stepIndex: number,
  pendingApprovalRequests: Map<string, number>,
  pendingSettlements: Map<string, PendingToolSettlement>,
): number {
  switch (chunk.type) {
    case 'start-step': {
      const next = stepIndex + 1;
      log.info(LOG_SCOPE, 'step started', { conversationId, step: next });
      return next;
    }
    case 'finish-step': {
      log.info(LOG_SCOPE, 'step finished', { conversationId, step: stepIndex });
      return stepIndex;
    }
    case 'tool-input-available': {
      log.info(LOG_SCOPE, 'tool call started', {
        conversationId,
        toolName: chunk.toolName,
        callId: chunk.toolCallId,
        input: previewUnknown(chunk.input, TOOL_INPUT_PREVIEW_LENGTH),
      });
      return stepIndex;
    }
    case 'tool-output-available': {
      pendingSettlements.set(chunk.toolCallId, {
        level: 'info',
        message: 'tool call completed',
        fields: {
          conversationId,
          callId: chunk.toolCallId,
          outputSize: measureOutputSize(chunk.output),
        },
      });
      return stepIndex;
    }
    case 'tool-output-error': {
      pendingSettlements.set(chunk.toolCallId, {
        level: 'warn',
        message: 'tool call errored',
        fields: {
          conversationId,
          callId: chunk.toolCallId,
          errorText: chunk.errorText,
        },
      });
      return stepIndex;
    }
    case 'tool-output-denied': {
      pendingSettlements.set(chunk.toolCallId, {
        level: 'warn',
        message: 'tool call denied',
        fields: { conversationId, callId: chunk.toolCallId },
      });
      return stepIndex;
    }
    case 'tool-approval-request': {
      pendingApprovalRequests.set(chunk.approvalId, Date.now());
      log.info(LOG_SCOPE, 'tool approval requested', {
        conversationId,
        approvalId: chunk.approvalId,
        callId: chunk.toolCallId,
        automatic: chunk.isAutomatic,
      });
      return stepIndex;
    }
    case 'tool-approval-response': {
      const requestedAt = pendingApprovalRequests.get(chunk.approvalId);
      pendingApprovalRequests.delete(chunk.approvalId);
      log.info(LOG_SCOPE, 'tool approval resolved', {
        conversationId,
        approvalId: chunk.approvalId,
        approved: chunk.approved,
        waitMs:
          requestedAt === undefined ? undefined : Date.now() - requestedAt,
      });
      return stepIndex;
    }
    case 'data-tool-timing': {
      // 同一调用最多三次更新（`@nimbo/core` 的 startToolTiming /
      // markToolExecutionStart / completeToolTiming，三段生命周期见 state.ts）：
      // 纯 `startedAt` 那次早由上面的 `tool-input-available` 分支记过"tool call
      // started"，跳过；补上 `executionStartedAt` 那次记一行 debug（排队/审批
      // 结束、真正开始执行——queueMs 即等了多久）；补上 `completedAt` 那次放出
      // 攒着的结算行，durationMs 是**真实执行耗时**（2026-07-16 定案），排队
      // 等待落在 queueMs 里，两者相加才是用户在界面上看到的全程等待。
      const { toolCallId, startedAt, executionStartedAt, completedAt } =
        chunk.data;
      if (completedAt === undefined) {
        if (executionStartedAt !== undefined) {
          log.debug(LOG_SCOPE, 'tool call executing', {
            conversationId,
            callId: toolCallId,
            queueMs: executionStartedAt - startedAt,
          });
        }
        return stepIndex;
      }
      const pending = pendingSettlements.get(toolCallId);
      pendingSettlements.delete(toolCallId);
      if (pending !== undefined) {
        log[pending.level](LOG_SCOPE, pending.message, {
          ...pending.fields,
          // deny 路径从未执行（恒无 executionStartedAt）——此时全程只有
          // 排队/审批等待，durationMs 退化为全程时长，queueMs 缺席。
          durationMs: completedAt - (executionStartedAt ?? startedAt),
          ...(executionStartedAt !== undefined ?
            { queueMs: executionStartedAt - startedAt }
          : {}),
        });
      }
      return stepIndex;
    }
    default:
      return stepIndex;
  }
}

/**
 * 报告一个[起轮装配](../../../../docs/terms.md)里程碑（docs/tech/telemetry.md §2.4）。
 * 两道防护，理由与「遥测永不影响 turn」同源：`session.toJSON()` 抛错（防御性，不
 * 预期）就跳过这次报告而不是让整轮崩掉；回调自己抛错就地吞掉记一行——它是注入方
 * 的事，不该污染这一轮。
 */
function reportMilestone(
  session: TurnDrivenSession,
  onMilestone:
    ((milestone: TurnMilestone, info: TurnMilestoneInfo) => void) | undefined,
  milestone: TurnMilestone,
  sinceStartMs: number,
  conversationId: string,
  log: Logger,
): void {
  if (onMilestone === undefined) return;
  try {
    const state = session.toJSON();
    onMilestone(milestone, {
      sessionId: state.id,
      turn: state.turn,
      sinceStartMs,
    });
  } catch (error) {
    log.error(LOG_SCOPE, 'onMilestone threw', {
      conversationId,
      milestone,
      error: describeError(error),
    });
  }
}

async function driveTurn(
  db: Db,
  conversationId: string,
  session: TurnDrivenSession,
  /** 用户原话——合成给界面看的 `NimboUIMessage` 用的就是它（见 `StartTurnParams.text`）。 */
  text: string,
  /** 喂给模型的文本，可能比 `text` 多一行系统提示（见 `StartTurnParams.modelText`）。 */
  modelText: string,
  priorMessageCount: number,
  turnStartSeq: number,
  emit: TurnEmitter,
  log: Logger,
  signal: AbortSignal,
  onMilestone?: (milestone: TurnMilestone, info: TurnMilestoneInfo) => void,
  // 返回「这一轮怎么结束的」而不是 void：它**从不 reject**（下面的 catch 兜住了
  // 所有抛出），所以 `startTurn` 的 `finally` 里可以直接拿到这个值交给
  // `onTurnSettled`，不必再在外层维护一个可变量来接。
): Promise<TurnSettledInfo> {
  const turnStartedAt = Date.now();
  log.info(LOG_SCOPE, 'turn started', {
    conversationId,
    text: truncate(text, TEXT_PREVIEW_LENGTH),
  });

  try {
    // The turn-start user message (this ticket's fix — see `schemas/chat.ts`'s
    // file header): synthesized and put on the wire *before* this function
    // ever starts consuming `session.stream()`, so it always arrives ahead
    // of anything else this turn produces — chat input is always plain text
    // (`routes/chat.ts`'s `PostChatMessageInputSchema`), hence the single
    // `text` part. `@nimbo/core`'s own `Session.stream()` separately pushes a
    // structurally-identical copy (different `id`) onto its internal ledger
    // the moment it actually starts running (`session.ts`'s own `stream()`)
    // — `finalizeTurnPersistence` below knows to skip over that copy so it's
    // never persisted twice.
    const userMessage: NimboUIMessage = {
      id: randomUUID(),
      role: 'user',
      parts: [{ type: 'text', text }],
    };
    emit.emitMessage(userMessage);

    // `signal` = 这一轮自己的 `AbortController.signal`（docs/tech/turn-abort.md §3.1）
    // ——[停止](../../../../docs/terms.md)后 core 的 loop 在下一个 step 边界优雅收尾
    // （`status: 'interrupted'`），走的是下面那条**正常收尾**的路，不是 `catch` 分支。
    // 这里用 `modelText` 而不是 `text`：上面那条合成的 `NimboUIMessage`（进账本、
    // 进直播流）拿的是用户原话，模型这条路可以多带一行系统提示——两条路分开正是
    // [skill 提及](../../../../docs/terms.md)「软提示」能生效又不脏账本的关键
    // （docs/tech/composer-skill-mention.md §2.2）。没有提及时两者是同一个字符串。
    const gen = session.stream(modelText, { signal });
    let step = await gen.next();
    let stepIndex = 0;
    let lastMessageMetadata: NimboMessageMetadata | undefined;
    const pendingApprovalRequests = new Map<string, number>();
    const pendingSettlements = new Map<string, PendingToolSettlement>();
    // 两个「首次」的一次性闸门（docs/tech/telemetry.md §2.4）——时刻在 chunk 抵达的
    // 那一刻取，报告放在 `emitChunk` 之后：观测绝不插在 chunk 送达用户的前面。
    let firstChunkReported = false;
    let firstOutputReported = false;
    while (!step.done) {
      const chunk = step.value;
      const arrivedAt = Date.now();
      stepIndex = logChunk(
        log,
        conversationId,
        chunk,
        stepIndex,
        pendingApprovalRequests,
        pendingSettlements,
      );
      if (chunk.type === 'message-metadata') {
        lastMessageMetadata = chunk.messageMetadata;
      }
      emit.emitChunk(chunk);
      if (!firstChunkReported) {
        firstChunkReported = true;
        reportMilestone(
          session,
          onMilestone,
          'first-chunk',
          arrivedAt - turnStartedAt,
          conversationId,
          log,
        );
      }
      if (!firstOutputReported && isVisibleChunk(chunk)) {
        firstOutputReported = true;
        reportMilestone(
          session,
          onMilestone,
          'first-output',
          arrivedAt - turnStartedAt,
          conversationId,
          log,
        );
      }
      step = await gen.next();
    }

    // Graceful finish — `session.stream()` returned a `TurnResult` instead
    // of throwing. Covers both a genuinely successful turn *and* a graceful
    // mid-stream degrade (`@nimbo/core`'s `loop.ts` still `return`s a
    // `TurnResult`, with `status: 'failed'`/`'interrupted'` on the last
    // `message-metadata` chunk, after yielding it) — both cases already
    // pushed whatever messages they're going to push onto the ledger, so
    // both persist here identically.
    finalizeTurnPersistence(
      db,
      conversationId,
      session.toJSON(),
      priorMessageCount,
      turnStartSeq,
      log,
    );

    log.info(LOG_SCOPE, 'turn finished', {
      conversationId,
      status: lastMessageMetadata?.status,
      durationMs: Date.now() - turnStartedAt,
    });
    // 缺 metadata 也算正常收尾——见 `TurnSettledInfo.status` 的注释。
    return { status: lastMessageMetadata?.status ?? 'completed' };
  } catch (error) {
    // The generator itself threw — a genuinely unexpected failure (distinct
    // from `session.stream()`'s own graceful degrade, handled above), with
    // no `TurnResult` to report and no ledger `NimboUIMessage` this module
    // could attach failure `metadata` to the way `loop.ts`'s own
    // `finalizeTurn` would. Reuses the exact `message-metadata` chunk shape
    // core itself produces for a graceful failure (same `status: 'failed'`
    // field) so client-side handling code needs no separate case for this —
    // a standalone informational chunk on the wire, not attached to (or
    // superseding) any ledger row. `finalizeTurnPersistence` never runs on
    // this path, so this turn's `kind = 'chunk'` rows are never GC'd — the
    // same accepted crash-residue trade-off `schema.ts`'s doc comment
    // describes for an actual process crash, just triggered by a bug
    // surfacing as a thrown error instead.
    log.error(LOG_SCOPE, 'turn threw unexpectedly', {
      conversationId,
      error: describeError(error),
      durationMs: Date.now() - turnStartedAt,
    });
    emit.emitChunk({
      type: 'message-metadata',
      messageMetadata: {
        turn: bestEffortTurn(session),
        usage: {},
        status: 'failed',
        error: { code: 'provider_error', message: describeError(error) },
      },
    });
    // 线上给客户端的是 `failed`（形状与 core 的优雅失败同源，界面不必多一个分支），
    // 但报给注入方的是 `crashed`——两者排查方向完全不同，见 `TurnSettledInfo`。
    return { status: 'crashed' };
  }
}

/**
 * 「这一轮是怎么结束的」——`onTurnSettled` 的唯一参数。
 *
 * 本模块只**报告**它，不解读：注入方（`turn-launcher.ts`）拿它去决定要不要发通知
 * （docs/tech/push-notification.md §3.3）。这与 `onMilestone` 是同一姿态——运行内核
 * 不认识推送，只多交出一个已经算好的事实。
 */
export interface TurnSettledInfo {
  /**
   * 前三值来自本轮最后一个 `message-metadata` chunk（core 的
   * `status: 'completed' | 'failed' | 'interrupted'`，`interrupted` = 被
   * [停止](../../../../docs/terms.md)）；**一个 metadata 都没见到也算 `completed`**
   * ——正常收尾就是正常收尾，缺 metadata 是 core 侧的可选字段问题，不该被报成失败。
   *
   * `crashed` 是 `driveTurn` 的 `catch` 分支：`session.stream()` 直接抛了，压根没
   * 产出收尾 metadata（那条 `status: 'failed'` 的合成 chunk 是本模块补的，不是 core
   * 给的）。与 `failed` 分开是因为两者的排查方向完全不同——一个是模型/工具失败，
   * 一个是我们自己的 bug。
   */
  status: 'completed' | 'failed' | 'interrupted' | 'crashed';
}

export interface StartTurnParams {
  db: Db;
  conversationId: string;
  session: TurnDrivenSession;
  /**
   * 用户**原话**——进[账本](../../../../docs/terms.md)、进[直播流](../../../../docs/terms.md)，
   * 也就是界面上显示的那条用户消息。
   */
  text: string;
  /**
   * 实际喂给模型的文本，缺省即 `text`（docs/tech/composer-skill-mention.md §2.2）。
   *
   * 两者分开，是为了让服务端能在**不污染账本**的前提下给模型追加话术——目前唯一的
   * 用途是[skill 提及](../../../../docs/terms.md)的那行系统提示（`turn-launcher.ts`
   * 里由 `buildModelText` 拼）：用户看到的仍是自己打的 `/frontend-design 改排版`，
   * 模型收到的多一句「请先 load-skill 加载它」。
   *
   * 提示行刻意**不进账本**：界面上显示一段本该隐形的系统话术很丑，而且它对后续轮
   * 没有价值（skill 那轮已经加载过了），留在账本里只是持续占 token。
   */
  modelText?: string;
  /**
   * Count of `kind = 'message'` rows already persisted for this session
   * *before* this turn starts (`routes/chat.ts` computes this off the same
   * `SessionState` it resumed the session from — `store.ts`'s
   * `loadResumeState`; `0` for a brand-new session that has never completed
   * a turn). `state.messages[priorMessageCount]` is where `@nimbo/core`'s own
   * turn-start user `NimboUIMessage` lands (`session.ts`'s `stream()` pushes
   * it synchronously, before ever yielding); `finalizeTurnPersistence` slices
   * `session.toJSON().messages` at `priorMessageCount + 1` — skipping over
   * that one message, since `driveTurn` already persisted+broadcast its own
   * copy of it at turn start (see that function's own comment) — to find
   * exactly the *remaining* messages this turn appended. The ledger only
   * ever grows by appending (`@nimbo/core`'s `session.ts` never reorders or
   * removes an existing message), so this index stays valid for the entire
   * turn regardless of how many steps/steers it goes through.
   */
  priorMessageCount: number;
  /**
   * Step/tool-call level observability tap (this ticket) — defaults to
   * `../logger.js`'s stdout singleton so existing callers that don't pass
   * one keep working unchanged. Tests inject their own (`createLogger({
   * sink })`) to assert on emitted lines without touching `process.stdout`.
   */
  logger?: Logger;
  /**
   * 「这一轮彻底结束了」的通知点（docs/tech/steer-and-queue.md §3）——在 `finally` 的
   * 收尾**全部**做完、`activeTurns` 里这一轮已被删除之后调用。
   *
   * 「在 delete 之后」是硬要求而非风格问题：`turn-launcher.ts` 用它来起下一轮
   * （自动[出队](../../../../docs/terms.md)），而 `startTurn` 开头就有「已有进行中的
   * 一轮就拒绝」的守卫——delete 之前调，下一轮必然被自己这一轮挡掉。
   *
   * 本模块刻意**不认识**「队列」这个概念：它只报告一个生命周期事件，要不要因此起下
   * 一轮是注入方的事（依赖方向见 `turn-launcher.ts` 文件头）。回调抛错只记日志，不
   * 影响这一轮已经完成的收尾。
   *
   * 参数 `info` 带上「这一轮是怎么结束的」（见 `TurnSettledInfo`）——同样只是报告，
   * 本模块不认识「通知」，用不用它是注入方的事。
   */
  onTurnSettled?: (info: TurnSettledInfo) => void;
  /**
   * 这一轮的两个「首次」时刻（docs/tech/telemetry.md §2.4）——见 `TurnMilestone`。
   * 与 `onTurnSettled` 同款：本模块只报告事件，落库/拼载荷是注入方
   * （`turn-launcher.ts`）的事；回调抛错只记日志，不影响这一轮。
   */
  onMilestone?: (milestone: TurnMilestone, info: TurnMilestoneInfo) => void;
  /**
   * 这一轮的[起轮占位](../../../../docs/terms.md)句柄（docs/tech/turn-abort.md §3.3）
   * ——`turn-launcher.ts` 装配前从 `reserveTurn` 拿到、装配完连同 session 一起交进来，
   * 由 `startTurn` 把它就地升级成真正在跑的那一轮。
   *
   * 缺省（不传）= 老路径：当场新建登记。既有调用方与 `turn-runner.test.ts` 里直接调
   * `startTurn` 的用例因此一行不用改。
   */
  reservation?: TurnReservation;
}

export interface StartTurnResult {
  started: boolean;
}

// ---------------------------------------------------------------------------
// 起轮占位（docs/tech/turn-abort.md §3.3）
// ---------------------------------------------------------------------------

/**
 * 一次[起轮占位](../../../../docs/terms.md)的句柄——`turn-launcher.ts` 的 `launchTurn`
 * 从 `reserveTurn` 拿到它，装配期间用它查「是不是已经被叫停了」，最后要么交给
 * `startTurn`（升级成真正在跑的那一轮），要么交给 `releaseTurn`（撤销）。
 *
 * 刻意是个**不透明句柄**：内部那个 `ActiveTurn` 通过下面的 `reservationRegistry`
 * 关联，不挂在这个接口上——`activeTurns` 的形状是本模块的私事，调用方不该拿到。
 */
export interface TurnReservation {
  readonly conversationId: string;
  /**
   * 这一轮唯一的那个中止信号：占位的那一刻就绪，装配跑完由 `startTurn` 原样交给
   * core（`session.stream(text, { signal })`）。装配期间被[停止](../../../../docs/terms.md)
   * 时它也会 abort，所以未来若把它透进 `sandbox-manager`，那几个远程调用也能被掐断
   * （目前不接受 signal，见 docs/tech/turn-abort.md §6.5）。
   */
  readonly signal: AbortSignal;
  /** 装配期间是否已被请求停止——`launchTurn` 在它的两个检查点读这个。 */
  readonly wasAborted: () => boolean;
}

/**
 * 句柄 → 它占的那个 `ActiveTurn`。`WeakMap` 而不是句柄上的一个字段：这样
 * `TurnReservation` 能保持不透明（见上），也不必把 `ActiveTurn` 这个内部类型导出。
 *
 * 条目在**交棒或撤销时立刻删除**，于是 `releaseTurn` 天然幂等：`startTurn` 升级成功后
 * `launchTurn` 的 `finally` 即便再调一次 `releaseTurn` 也是无操作（不会把一轮正在跑的
 * 轮从 `activeTurns` 里抹掉）。
 */
const reservationRegistry = new WeakMap<TurnReservation, ActiveTurn>();

/**
 * `reserveTurn` 的结果——拒绝时**分两种原因**，因为它们的 HTTP 语义不同
 * （docs/tech/graceful-shutdown.md §3.3）：
 *
 * - `'busy'`：这个会话已经有一轮了（装配中的也算）→ 路由转 **409**。
 * - `'shutting_down'`：进程正在[优雅关闭](../../../../docs/terms.md)→ 路由转 **503**
 *   （「稍后重试」，一个明确的、可恢复的拒绝，而不是「你已经有一轮在跑」这种误导）。
 */
export type ReserveTurnResult =
  | { ok: true; reservation: TurnReservation }
  | { ok: false; reason: 'busy' | 'shutting_down' };

/**
 * 占下这个会话的[起轮占位](../../../../docs/terms.md)（docs/tech/turn-abort.md §3.3）：
 * 从这一刻起 `isTurnActive` 为真、`GET .../stream` 能订阅到这一轮、`POST .../abort`
 * 停得住它。
 *
 * 与 `startTurn` 的分工：本函数只登记「这一轮存在」，不驱动任何东西；真正开始跑是
 * `startTurn` 的事（它把这个占位就地升级）。
 */
export function reserveTurn(
  conversationId: string,
  logger?: Logger,
): ReserveTurnResult {
  const log = logger ?? defaultLogger;
  // 关闭期间绝不接新的轮（docs/tech/graceful-shutdown.md §3.3）——两种拒绝要分开报，
  // 它们的 HTTP 语义不同：`busy` → 409（已有轮），`shutting_down` → 503（稍后重试）。
  if (shuttingDown) return { ok: false, reason: 'shutting_down' };
  if (activeTurns.has(conversationId)) return { ok: false, reason: 'busy' };

  const emitter = new EventEmitter();
  // Every open `GET .../stream` tail (multiple tabs, reconnect churn) adds a
  // listener pair to the same turn's emitter for its lifetime — that's
  // expected fan-out, not a leak, so the default-10 warning is disabled.
  emitter.setMaxListeners(0);
  const activeTurn: ActiveTurn = {
    phase: 'preparing',
    emitter,
    done: false,
    abortController: new AbortController(),
    aborted: false,
    steer: undefined, // 还没有 session 可绑——见 `ActiveTurn.steer` 的注释
    pendingReviews: new Map(),
    pendingQuestions: new Map(),
  };
  activeTurns.set(conversationId, activeTurn);

  const reservation: TurnReservation = {
    conversationId,
    signal: activeTurn.abortController.signal,
    wasAborted: () => activeTurn.aborted,
  };
  reservationRegistry.set(reservation, activeTurn);
  log.debug(LOG_SCOPE, 'turn reserved', { conversationId });
  return { ok: true, reservation };
}

/** 起轮装配窗口里被停止时，给挂在时间线末尾那条「已停止」标记的固定文案（进账本，故与 core 的口径一致）。 */
const ABORT_BEFORE_START_MESSAGE =
  'The user stopped this turn before it started running.';

/**
 * 撤销一个[起轮占位](../../../../docs/terms.md)（docs/tech/turn-abort.md §3.3）——
 * `launchTurn` 的 `finally` 调它，覆盖装配的**每一条**没能交棒给 `startTurn` 的退出路径
 * （凭据缺失、沙盒起不来、`buildSession` 抛错、期间被停止）。
 *
 * 漏掉任何一条 = 把这个会话**永久锁死**（`isTurnActive` 恒真，此后所有消息只会排队、
 * 再也起不了轮），所以调用方用 `try/finally` 兜，而不是在每个 `return` 前手写一遍。
 *
 * 两件必做的事：
 *
 * 1. **被停止过就补一次收尾**：一条合成的用户消息 + 一条独立的 `interrupted`
 *    `message-metadata`（形状与 `driveTurn` 的两处同源，不新增任何 wire 形状）。
 *    这是「装配窗口里按停止」在界面上留下「你发的那条消息 + 已停止」的唯一来源——
 *    这一轮从没启动，core 的 loop 不会为它产出任何东西。
 * 2. **一定 `emit('done')`**：占位期这一轮已经能被 tail 订阅（`isTurnActive` 为真），
 *    不发就把那条连接挂到超时。
 *
 * 幂等：句柄已交棒（`startTurn` 升级过）或已撤销过 → 无操作。
 */
export function releaseTurn(
  db: Db,
  reservation: TurnReservation,
  /** 用户原话——被停止时用它合成那条落账本的用户消息（与 `StartTurnParams.text` 同义）。 */
  text: string,
  logger?: Logger,
): void {
  const log = logger ?? defaultLogger;
  const activeTurn = reservationRegistry.get(reservation);
  if (activeTurn === undefined) return; // 已交棒或已撤销
  reservationRegistry.delete(reservation);

  const { conversationId } = reservation;
  if (activeTurns.get(conversationId) !== activeTurn) return; // 防御：登记里已经不是它了

  if (activeTurn.aborted) {
    log.info(LOG_SCOPE, 'turn stopped before it started', { conversationId });
    // `seq` 现取：占位期不写任何 event 行，所以这就是这一轮的起点。
    const emit = createTurnEmitter(
      db,
      conversationId,
      activeTurn.emitter,
      getMaxEventSeq(db, conversationId),
    );
    emit.emitMessage({
      id: randomUUID(),
      role: 'user',
      parts: [{ type: 'text', text }],
    });
    // `turn` 省略：装配可能在 `buildSession` 之前就退出，此刻根本没有 session 可问
    // 轮号（`bestEffortTurn` 问不出来时也是 `undefined`，一致）。
    emit.emitChunk({
      type: 'message-metadata',
      messageMetadata: {
        usage: {},
        status: 'interrupted',
        error: { code: 'aborted', message: ABORT_BEFORE_START_MESSAGE },
      },
    });
  }

  activeTurn.emitter.emit('done');
  activeTurn.done = true;
  activeTurns.delete(conversationId);
}

/**
 * Rejects (`{ started: false }`) if this session already has a turn running
 * — `routes/chat.ts` turns that into a 409. Otherwise registers the
 * `ActiveTurn` synchronously (so `isTurnActive`/`subscribeTurn` see it
 * immediately) and spawns the background driver — deliberately not
 * `await`ed, not bound to any request's lifetime.
 *
 * 带 `reservation`（`turn-launcher.ts` 的正常路径）时不新建登记，而是把那个
 * [起轮占位](../../../../docs/terms.md)**就地升级**成 `running`：同一个 `ActiveTurn`、
 * 同一个 `emitter`（占位期连上的 tail 因此无缝接住这一轮）、同一个 `abortController`
 * （装配期间按下的停止对升级后的这一轮依然有效）。不带 `reservation` 的老路径照旧
 * 当场新建——既有调用方与测试一行不改。
 */
export function startTurn(params: StartTurnParams): StartTurnResult {
  const { db, conversationId, session, text, priorMessageCount } = params;
  const log = params.logger ?? defaultLogger;
  const { reservation } = params;
  const reserved =
    reservation === undefined ? undefined : (
      reservationRegistry.get(reservation)
    );
  if (reserved === undefined) {
    if (activeTurns.has(conversationId)) return { started: false };
  } else if (activeTurns.get(conversationId) !== reserved) {
    return { started: false }; // 占位已被撤销（或已被别的轮取代）——不该再启动
  }
  // 交棒：此后 `releaseTurn` 对这个句柄是无操作，删登记归下面 `driveTurn` 的 `finally`。
  if (reservation !== undefined) reservationRegistry.delete(reservation);

  const turnStartSeq = getMaxEventSeq(db, conversationId);
  const emitter = reserved?.emitter ?? new EventEmitter();
  // Every open `GET .../stream` tail (multiple tabs, reconnect churn) adds a
  // listener pair to the same turn's emitter for its lifetime — that's
  // expected fan-out, not a leak, so the default-10 warning is disabled.
  // （占位来的那个 emitter 在 `reserveTurn` 里已经设过。）
  if (reserved === undefined) emitter.setMaxListeners(0);
  const emit = createTurnEmitter(db, conversationId, emitter, turnStartSeq);
  // Captured once, bound to *this* turn's `session` — `steerTurn` never
  // sees `session` directly, only this closure (STEER-3B).
  const steer = (input: string): boolean => session.steer?.(input) ?? false;
  const activeTurn: ActiveTurn = reserved ?? {
    phase: 'running',
    emitter,
    done: false,
    abortController: new AbortController(),
    aborted: false,
    steer,
    pendingReviews: new Map(),
    pendingQuestions: new Map(),
  };
  if (reserved !== undefined) {
    // 就地升级（见函数注释）——`aborted`/`abortController` 一律保留占位期的那份。
    reserved.phase = 'running';
    reserved.steer = steer;
  } else {
    activeTurns.set(conversationId, activeTurn);
  }

  void driveTurn(
    db,
    conversationId,
    session,
    text,
    params.modelText ?? text,
    priorMessageCount,
    turnStartSeq,
    emit,
    log,
    activeTurn.abortController.signal,
    params.onMilestone,
  )
    .catch((error: unknown): TurnSettledInfo => {
      // `driveTurn` 自己已经兜住了所有抛出，走到这里意味着**连它的 catch 分支也抛了**
      // （例如那条合成 chunk 落盘时数据库出错）。仍然必须把下面的收尾跑完——否则
      // `activeTurns` 里这一轮永不删除，这个会话就被永久锁死（此后所有消息只会排队、
      // 再也起不了轮）。原先这里是 `.finally`，天然有这个保证；改成拿返回值之后要
      // 靠这一段把它补回来。
      log.error(LOG_SCOPE, 'driveTurn rejected unexpectedly', {
        conversationId,
        error: describeError(error),
      });
      return { status: 'crashed' };
    })
    .then((settled) => {
      // Defensive cleanup only — in the normal case both maps are already
      // empty by the time `driveTurn` settles, because the `@nimbo/core` loop
      // is itself `await`ing whatever `requestReview`/`requestUserAnswer`
      // promise is pending (it's the tool call's own `onReview`/`ask-user`
      // result), so the generator simply cannot reach its `return`/`throw`
      // while one is still outstanding. Anything still here is a genuine leak
      // (e.g. a bug upstream) being caught before it dangles forever. Neither
      // bridge emits anything for these (unlike the pre-migration version):
      // the wire has nothing bridge-event-shaped left to emit after a turn
      // ends (see file header) — a stuck client is left to its own
      // `requestReview`/`requestUserAnswer` timeout, which fires from the very
      // same code path this `finally` is defensively duplicating.
      for (const pending of activeTurn.pendingReviews.values()) {
        clearTimeout(pending.timer);
        pending.resolve({
          behavior: 'deny',
          message:
            'The turn this approval request belonged to has already ended.',
        });
      }
      activeTurn.pendingReviews.clear();

      for (const pending of activeTurn.pendingQuestions.values()) {
        clearTimeout(pending.timer);
        pending.resolve({ outcome: 'timeout' });
      }
      activeTurn.pendingQuestions.clear();

      emitter.emit('done');
      activeTurn.done = true;
      activeTurns.delete(conversationId);

      // 严格在 `activeTurns.delete` 之后——见 `StartTurnParams.onTurnSettled` 的注释
      // （下一轮的 `startTurn` 守卫依赖这个顺序）。回调是注入方的事，它抛错不该污染
      // 这一轮已经完成的收尾，故就地吞掉并记一行。
      try {
        params.onTurnSettled?.(settled);
      } catch (error) {
        log.error(LOG_SCOPE, 'onTurnSettled threw', {
          conversationId,
          error: describeError(error),
        });
      }
    });

  return { started: true };
}

/**
 * 把一份[待发队列](../../../../docs/terms.md)快照广播给这个会话进行中那一轮的所有订阅者
 * （多标签同步，docs/tech/steer-and-queue.md §4.3 的「时机 2」）。
 *
 * 没有进行中的一轮就是**无操作**且不是错误：队列只可能在一轮进行中被改动（没有进行中
 * 的一轮时发消息直接起轮，不入队），而[出队](../../../../docs/terms.md)恰好发生在这一轮
 * emitter 即将关闭的时刻——那一次的同步不靠广播，靠下一轮的 tail 连上时那帧权威快照
 * （§4.3 的「时机 1」）。
 *
 * `QueueFrame` 没有 `seq`：它是[transient](../../../../docs/terms.md)档的状态快照，不落库、
 * 不占 seq、不参与 `after=` 续传，因此这里绕过 `TurnEmitter` 直接 `emit`，不走
 * `createTurnEmitter` 的持久化路径。
 */
export function broadcastQueue(
  conversationId: string,
  queue: QueuedMessage[],
): void {
  const activeTurn = activeTurns.get(conversationId);
  if (activeTurn === undefined) return;
  activeTurn.emitter.emit('event', { queue } satisfies QueueFrame);
}

/**
 * Attaches to the session's in-progress turn, if any — a no-op unsubscribe
 * when there isn't one (`routes/chat.ts`'s `GET .../stream` checks
 * `isTurnActive` itself to tell the two cases apart, since `onDone` will
 * never fire for a turn that was never active). Subscribing is synchronous
 * and side-effect-free until the turn actually emits, so calling this
 * *before* replaying persisted history (docs/tech/chat-webapp.md §2.2b) is what prevents
 * losing an event that lands in the gap between the replay query and this
 * call. `onEvent` receives a `ChatReplayFrame` — almost always a
 * `ChunkEnvelope`, except for the turn's very first delivery, which is the
 * one `MessageFrame` `driveTurn` emits for the turn-start user message (see
 * `createTurnEmitter`).
 */
export function subscribeTurn(
  conversationId: string,
  onEvent: (envelope: ChatReplayFrame) => void,
  onDone: () => void,
): () => void {
  const activeTurn = activeTurns.get(conversationId);
  if (activeTurn === undefined) return () => {};

  activeTurn.emitter.on('event', onEvent);
  activeTurn.emitter.once('done', onDone);
  return () => {
    activeTurn.emitter.off('event', onEvent);
    activeTurn.emitter.off('done', onDone);
  };
}

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
// 审批链 / 人审通道 (docs/tech/single-ledger.md §6.4): `requestReview`
// is what `routes/chat.ts` wires up as the session's `onReview`
// (`ApprovalReviewer`) — `@nimbo/core`'s loop calls it only *after* it has
// already yielded a `tool-approval-request` chunk for a call the session's
// 审批分类器 (`onApproval`, `approval-policy.ts`'s `classifyApproval`)
// resolved to `'review'`; the resulting promise is exactly what the loop is
// `await`ing, so the turn's own execution is genuinely suspended (not
// polling) until `resolveReview` settles it. Neither function touches
// `emit`/`TurnEmitter` — see file header for why.
// ---------------------------------------------------------------------------

/**
 * `CHAT_APPROVAL_TIMEOUT_MS`，默认 240000ms——纯产品决策：人多久不理算放弃。
 *
 * 这个值原本还背着「赶在沙盒空闲超时之前把无人应答的审批拒掉」的保命职责，所以取
 * 沙盒空闲超时的 80%。[保活](../../../../docs/terms.md)接管之后那层耦合没了（等人期间
 * 由适配器按[审批保活预算](../../../../docs/terms.md)续期，见 docs/tech/sandbox-keepalive.md），
 * 数值本身不动。
 */
const DEFAULT_APPROVAL_TIMEOUT_MS = 240_000;

/**
 * 导出给 `turn-launcher.ts`：审批通知的存活时长（TTL）必须与这个超时**在同一处**
 * 取值（docs/tech/push-notification.md §6.3/§8）——送不到人手上就已经自动拒绝了的
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

  // 这一轮已被[停止](../../../../docs/terms.md)：立刻拒绝，不注册挂起项——否则这个
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
 * itself, see file header).
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
// ask-user bridge (docs/tech/chat-webapp.md §2.2c（审批链）) — structurally the sibling of the
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
 * the review bridge's `resolveReview`. Not exported: `resolveUserAnswer`
 * below is the public surface for the "answered" case; the timeout case
 * only ever originates from inside `requestUserAnswer` itself.
 */
function settleQuestion(
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
