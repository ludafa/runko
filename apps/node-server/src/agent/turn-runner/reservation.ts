/**
 * [起轮占位](../../../../../docs/terms.md)（docs/tech/turn-abort.md §3.3）——把「这一轮
 * 存在」这件事**提前**到[起轮装配](../../../../../docs/terms.md)开始的那一刻，而不是等
 * 装配跑完才登记。
 *
 * 为什么要提前：装配（取沙盒、续期、扫 skill、建 session）可能要好几秒。这段窗口里若
 * 登记表是空的，用户按停止会被当成「没有轮可停」（409），同会话后来的消息会被当成
 * 「可以起新轮」——两个都是错的。占位之后这两件事都对了：能停，且后来的消息走排队。
 *
 * 一次占位有且只有两个去向：交给 `start.ts` 的 `startTurn`（原地升级成真正在跑的
 * 那一轮），或交给本文件的 `releaseTurn`（撤销）。
 */
import { randomUUID } from 'node:crypto';

import type { Logger } from '../../logger.js';
import { logger as defaultLogger } from '../../logger.js';
import type { Db } from '../store.js';
import { getMaxEventSeq } from '../store.js';
import { ABORT_BEFORE_START_MESSAGE } from './abort-reasons.js';
import { LOG_SCOPE } from './log.js';
import { createTurnEmitter } from './persistence.js';
import type { ActiveTurn } from './registry.js';
import { activeTurns, createTurnEventEmitter } from './registry.js';
import { isShuttingDown } from './shutdown.js';

/**
 * 一次[起轮占位](../../../../../docs/terms.md)的句柄——`turn-launcher.ts` 的 `launchTurn`
 * 从 `reserveTurn` 拿到它，装配期间用它查「是不是已经被叫停了」，最后要么交给
 * `startTurn`（升级成真正在跑的那一轮），要么交给 `releaseTurn`（撤销）。
 *
 * 刻意是个**不透明句柄**：内部那个 `ActiveTurn` 通过下面的 `reservationRegistry`
 * 关联，不挂在这个接口上——`activeTurns` 的形状是本目录的私事，调用方不该拿到。
 */
export interface TurnReservation {
  readonly conversationId: string;
  /**
   * 这一轮唯一的那个中止信号：占位的那一刻就绪，装配跑完由 `startTurn` 原样交给
   * core（`session.stream(text, { signal })`）。装配期间被[停止](../../../../../docs/terms.md)
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
export const reservationRegistry = new WeakMap<TurnReservation, ActiveTurn>();

/**
 * `reserveTurn` 的结果——拒绝时**分两种原因**，因为它们的 HTTP 语义不同
 * （docs/tech/graceful-shutdown.md §3.3）：
 *
 * - `'busy'`：这个会话已经有一轮了（装配中的也算）→ 路由转 **409**。
 * - `'shutting_down'`：进程正在[优雅关闭](../../../../../docs/terms.md)→ 路由转 **503**
 *   （「稍后重试」，一个明确的、可恢复的拒绝，而不是「你已经有一轮在跑」这种误导）。
 */
export type ReserveTurnResult =
  | { ok: true; reservation: TurnReservation }
  | { ok: false; reason: 'busy' | 'shutting_down' };

/**
 * 占下这个会话的[起轮占位](../../../../../docs/terms.md)（docs/tech/turn-abort.md §3.3）：
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
  if (isShuttingDown()) return { ok: false, reason: 'shutting_down' };
  if (activeTurns.has(conversationId)) return { ok: false, reason: 'busy' };

  const activeTurn: ActiveTurn = {
    phase: 'preparing',
    emitter: createTurnEventEmitter(),
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

/**
 * 撤销一个[起轮占位](../../../../../docs/terms.md)（docs/tech/turn-abort.md §3.3）——
 * `launchTurn` 的 `finally` 调它，覆盖装配的**每一条**没能交棒给 `startTurn` 的退出路径
 * （凭据缺失、沙盒起不来、`buildSession` 抛错、期间被停止）。
 *
 * 漏掉任何一条 = 把这个会话**永久锁死**（`isTurnActive` 恒真，此后所有消息只会排队、
 * 再也起不了轮），所以调用方用 `try/finally` 兜，而不是在每个 `return` 前手写一遍。
 *
 * 两件必做的事：
 *
 * 1. **被停止过就补一次收尾**：一条合成的用户消息 + 一条独立的 `interrupted`
 *    `message-metadata`（形状与 `drive.ts` 的两处同源，不新增任何 wire 形状）。
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
