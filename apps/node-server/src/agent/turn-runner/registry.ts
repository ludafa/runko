/**
 * 「进行中的轮」登记表——本目录的**内存核心**：`activeTurns` 这张 `Map` 就是「这个
 * 会话此刻有没有一轮在跑」的唯一事实来源，其余模块（起轮占位、驱动、停止、关闭、
 * 人审通道）全部围着它转。
 *
 * 本文件只放**登记表本身**与几个直接读它的小查询/订阅函数；任何会改变一轮命运的
 * 动作（起、停、收尾）都在各自的模块里。
 *
 * 进程重启的边界（docs/tech/chat-webapp.md §2.2b「边界」）：`activeTurns` 只在内存里
 * ——进程重启会无声丢掉进行中的轮（沙盒可能还活着，但没人再驱动 `session.stream()`
 * 往前走了）。已落盘的行原样留着，下一次 `GET .../stream` 找不到活跃轮，就只回放到
 * 崩溃点为止，剩下的交给 `crash-recovery.ts` 补收尾。
 */
import { EventEmitter } from 'node:events';

import type { HumanDecision, JsonValue } from '@nimbo/core';

import type {
  ChatReplayFrame,
  QueuedMessage,
  QueueFrame,
} from '../../schemas/chat.js';

/** The outcome of one `ask-user` call (docs/tech/chat-webapp.md §2.2c（审批链）) — `'timeout'` never carries an `answer`, same as `HumanDecision`'s `deny` branch not requiring a `message`. */
export type AskUserOutcome =
  { outcome: 'answered'; answer: string } | { outcome: 'timeout' };

/**
 * One pending `requestReview`/`requestUserAnswer` call, parked until
 * `resolveReview`/`resolveUserAnswer` (a human decision/answer, or the
 * timeout) settles it — the one piece genuinely identical between the two
 * bridges, see `human-bridge.ts`'s `takePending`.
 */
export interface PendingEntry<T> {
  resolve: (value: T) => void;
  timer: NodeJS.Timeout;
}

/**
 * A pending review carries the call's `toolName`/`input` alongside the usual
 * resolve/timer — so `resolveReview` can record a 会话级授权 (`session-grants.ts`)
 * for *this exact call* when the human picks 「会话内都允许」, without the route
 * (which only knows `callId`) having to look the tool call up itself.
 */
export interface ReviewPendingEntry extends PendingEntry<HumanDecision> {
  toolName: string;
  input: JsonValue;
}

/**
 * 一轮在 `activeTurns` 里的两个阶段（docs/tech/turn-abort.md §3.3）。
 *
 * `preparing` = [起轮占位](../../../../../docs/terms.md)：`turn-launcher.ts` 的
 * `launchTurn` 一进门就占下这个位子，此后整段[起轮装配](../../../../../docs/terms.md)
 * （取沙盒、续期、扫 skill、建 session）期间这一轮就算**存在**——所以它可以被
 * [停止](../../../../../docs/terms.md)，同会话后来的消息也会走[排队](../../../../../docs/terms.md)。
 * 装配跑完由 `start.ts` 的 `startTurn` **原地**升级成 `running`（同一个 `ActiveTurn`
 * 对象、同一个 `emitter`、同一个 `abortController`——不是「删占位再登记」，那中间又是
 * 一个新空窗）。
 */
export type TurnPhase = 'preparing' | 'running';

export interface ActiveTurn {
  phase: TurnPhase;
  emitter: EventEmitter;
  done: boolean;
  /**
   * 这一轮的中止闸门（docs/tech/turn-abort.md §3）——`reserveTurn`/`startTurn` 建、
   * `session.stream(text, { signal })` 消费、`abortTurn` 触发。
   */
  abortController: AbortController;
  /**
   * 已请求[停止](../../../../../docs/terms.md)。两个用途：`abortTurn` 的幂等判定，以及
   * `requestReview`/`requestUserAnswer` 的「别再挂新的」闸门——停止之后 core 若还为
   * 同一步里其它并行工具调用请求[人审](../../../../../docs/terms.md)（`loop.ts` 的
   * `mergeSettleStreams` 让一步内多个工具调用并发结算），那些请求必须立即被拒，
   * 否则它们会各自挂到自己的超时（默认 240 秒），把「停止」拖成「四分钟后停止」。
   */
  aborted: boolean;
  /**
   * Bound to this turn's own `session.steer` at registration time (STEER-3B) — see `steerTurn`.
   *
   * `preparing` 阶段是 `undefined`：那时还没有 `session` 可绑，[插话](../../../../../docs/terms.md)
   * 也就无处可插（路由据此把这条消息转成排队，见 `isTurnPreparing`）。
   */
  steer: ((input: string) => boolean) | undefined;
  /** Keyed by `callId` (`@nimbo/core`'s `ApprovalContext.callId`, docs/tech/single-ledger.md §6.4) — see `human-bridge.ts`'s `requestReview`/`resolveReview`. Carries `toolName`/`input` (`ReviewPendingEntry`) so `resolveReview` can grant a 会话级授权 for the exact call. */
  pendingReviews: Map<string, ReviewPendingEntry>;
  /** Keyed by `callId` (docs/tech/chat-webapp.md §2.2c（审批链）) — see `human-bridge.ts`'s `requestUserAnswer`/`resolveUserAnswer`. Independent of `pendingReviews`: same shape, different `Map`. */
  pendingQuestions: Map<string, PendingEntry<AskUserOutcome>>;
}

/**
 * `conversationId` → 它此刻进行中的那一轮。**模块级**、进程内唯一——一个会话同时
 * 最多一轮（`reserveTurn`/`startTurn` 的守卫保证），所以这里既是「忙不忙」的判据，
 * 也是所有跨请求路由（订阅、停止、审批答复）找到那一轮的入口。
 */
export const activeTurns = new Map<string, ActiveTurn>();

export function isTurnActive(conversationId: string): boolean {
  return activeTurns.has(conversationId);
}

/**
 * 这个会话有没有一轮**卡在[起轮装配](../../../../../docs/terms.md)里**
 * （docs/tech/turn-abort.md §3.3）——`routes/chat.ts` 用它给[插话](../../../../../docs/terms.md)
 * 分流：装配中的轮没有 `session` 可插，那条消息该转成[排队](../../../../../docs/terms.md)，
 * 而不是像「这一轮刚好结束」那个窄竞态一样回落去起新一轮（会被自己的占位挡成 409）。
 */
export function isTurnPreparing(conversationId: string): boolean {
  return activeTurns.get(conversationId)?.phase === 'preparing';
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
  // `undefined` = 这一轮还在[起轮装配](../../../../../docs/terms.md)里（`preparing`，还没有
  // session）——同样报 `false`，但路由要按 `isTurnPreparing` 区分这两种 `false`
  // （docs/tech/turn-abort.md §3.3）。
  return activeTurn.steer?.(text) ?? false;
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
 * one `MessageFrame` `drive.ts`'s `driveTurn` emits for the turn-start user
 * message (see `persistence.ts`'s `createTurnEmitter`).
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
 * 把一份[待发队列](../../../../../docs/terms.md)快照广播给这个会话进行中那一轮的所有订阅者
 * （多标签同步，docs/tech/steer-and-queue.md §4.3 的「时机 2」）。
 *
 * 没有进行中的一轮就是**无操作**且不是错误：队列只可能在一轮进行中被改动（没有进行中
 * 的一轮时发消息直接起轮，不入队），而[出队](../../../../../docs/terms.md)恰好发生在这一轮
 * emitter 即将关闭的时刻——那一次的同步不靠广播，靠下一轮的 tail 连上时那帧权威快照
 * （§4.3 的「时机 1」）。
 *
 * `QueueFrame` 没有 `seq`：它是[transient](../../../../../docs/terms.md)档的状态快照，不落库、
 * 不占 seq、不参与 `after=` 续传，因此这里绕过 `TurnEmitter` 直接 `emit`，不走
 * `persistence.ts` 的 `createTurnEmitter` 的持久化路径。
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
 * 新建一个这一轮专用的 `EventEmitter`——`reserveTurn`（占位那一刻）与 `startTurn`
 * （没有占位的老路径）各建一次，形状必须一致，故收在这里。
 *
 * Every open `GET .../stream` tail (multiple tabs, reconnect churn) adds a
 * listener pair to the same turn's emitter for its lifetime — that's
 * expected fan-out, not a leak, so the default-10 warning is disabled.
 */
export function createTurnEventEmitter(): EventEmitter {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  return emitter;
}
