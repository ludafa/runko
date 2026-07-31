/**
 * [优雅关闭](../../../../../docs/terms.md)（docs/tech/graceful-shutdown.md §3）——进程要退
 * 之前，把进行中的轮主动停下来并等它们收尾，而不是让它们无声消失。
 *
 * 本文件刻意**不碰 `process.exit`**：只负责让轮停下来，退不退进程是 `index.ts` 的事
 * ——与 `onTurnSettled`「本目录只报告生命周期事件」的既有纪律同一姿态。
 */
import type { Logger } from '../../logger.js';
import { logger as defaultLogger } from '../../logger.js';
import { abortTurn } from './abort.js';
import { ABORT_REASON_SHUTDOWN } from './abort-reasons.js';
import { LOG_SCOPE } from './log.js';
import { activeTurns } from './registry.js';

/**
 * [优雅关闭](../../../../../docs/terms.md)闸门。置真后 `reserveTurn` 一律拒绝——关闭期间
 * 绝不接新的轮，否则 `shutdownTurns` 会永远等不完（每一轮收尾都可能触发
 * [自动出队](../../../../../docs/terms.md)起下一轮）。
 *
 * 模块级、单向、不可复位：一个进程只关闭一次。
 */
let shuttingDown = false;

/** 进程是否正在[优雅关闭](../../../../../docs/terms.md)——`index.ts` 用它做重复信号的幂等判据，路由用它转 503，`reservation.ts` 的 `reserveTurn` 用它拒新轮。 */
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
  /** 这次关闭中止了几个轮（含还在[起轮装配](../../../../../docs/terms.md)里的）。 */
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
 * 1. **先置关闭闸门**。否则收尾期间[自动出队](../../../../../docs/terms.md)会起新一轮
 *    （每个 `onTurnSettled` 都可能起一轮），这个函数就永远等不完。
 * 2. **快照当前全部活跃轮**，并为每个备好一个「收尾了」的 promise。监听它自己 emitter
 *    的 `done`；已经 `done` 的直接算完成——`emit('done')` 与 `done = true` 在
 *    `start.ts` 的收尾块里是同一个同步块，所以不存在「emit 已过、once 收不到、
 *    done 还是 false」的漏窗。
 * 3. **逐个 `abortTurn(id, reason)`**：reason 就是 `ABORT_REASON_SHUTDOWN`，经 core 透传
 *    进收尾 metadata，界面据此显示「服务重启，这一轮已中断」。
 * 4. **等齐或撞超时**。撞超时不抛错也不强制清理登记：那些轮成了
 *    [孤儿轮](../../../../../docs/terms.md)，交给下次启动的 `crash-recovery.ts` 补收尾
 *    （两道防线在这里接上，docs/tech/graceful-shutdown.md §7.1）。
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
