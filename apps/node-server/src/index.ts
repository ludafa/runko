import { serve } from '@hono/node-server';

import { recoverOrphanedTurns } from './agent/crash-recovery.js';
import { isShuttingDown, shutdownTurns } from './agent/turn-runner/index.js';
import { app } from './app.js';
import { db } from './db/instance.js';
import { generateOpenAPISpec } from './generate-spec.js';
import { logger } from './logger.js';
import { logPushStartup } from './push/vapid.js';

const LOG_SCOPE = 'server';

// Generate openapi.yml on dev server start
generateOpenAPISpec(app);

// 推送通知（docs/app/push-notification/tech.md §6.5）：把「开没开、开了哪几类」摊在
// 启动日志里，且**只在这里**说一遍——`isPushEnabled()` 在每一轮里会被问很多次，
// 那些地方一行日志都不该打。
logPushStartup(logger);

// [崩溃恢复](../../../docs/terms.md)（docs/agent/graceful-shutdown/tech.md §5）：上次进程若是
// 被强杀的（`kill -9`/OOM/断电），那些[孤儿轮](../../../docs/terms.md)在账本里从没收尾。
// 放在 `serve()` **之前**——这样第一个请求进来时账本已经一致，不会有人看到一个还没补上
// 收尾的半截历史。
recoverOrphanedTurns(db, logger);

const port = Number(process.env.SERVER_PORT ?? 3000);

/**
 * [优雅关闭](../../../docs/terms.md)等收尾的上限（docs/agent/graceful-shutdown/tech.md §7.1）。
 *
 * 默认 15 秒：K8s 的 `terminationGracePeriodSeconds` 默认 30 秒，留一半余量给连接关闭与
 * 进程退出。`node --watch` 侧是**无限期**等我们的（实测，见 tech 附录 A），所以这个值在
 * dev 环境纯粹是我们自己的保险——没有它，一个卡住的收尾会让热重载再也起不来。
 */
const SHUTDOWN_TIMEOUT_MS = Number(
  process.env.SHUTDOWN_TIMEOUT_MS ?? 15_000,
);

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Server running at http://localhost:${info.port}`);
  console.log(`Swagger UI at http://localhost:${info.port}/reference`);
  console.log(`OpenAPI spec at http://localhost:${info.port}/doc`);
});

/**
 * 关闭顺序是硬要求（docs/agent/graceful-shutdown/tech.md §3.2）：
 *
 * **先让轮收尾，再关 server。** 反过来的话，被中止那一轮的收尾帧根本发不到浏览器
 * ——它要经 `GET .../stream` 送出去，而 `server.close()` 会断掉那条 SSE 连接；更糟的是
 * `close()` 本身会等现有连接结束，SSE 是长连接，等于自己把自己锁住。
 *
 * 正着来则天然顺：轮一收尾，`emit('done')` 让 tail 正常关闭，`close()` 立刻就能完成。
 */
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (isShuttingDown()) {
    // 连按 Ctrl-C / 重复信号：不重跑一遍流程，只记一行。
    logger.info(LOG_SCOPE, 'shutdown already in progress, ignoring signal', {
      signal,
    });
    return;
  }

  logger.info(LOG_SCOPE, 'shutdown requested', {
    signal,
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
  });

  const result = await shutdownTurns({
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
    logger,
  });

  server.close(() => {
    logger.info(LOG_SCOPE, 'shutdown complete', {
      signal,
      abortedTurns: result.aborted,
      // `false` = 撞了超时上限，那几个轮成了孤儿轮，下次启动由 `recoverOrphanedTurns` 补收尾。
      allTurnsSettled: result.settled,
      pendingTurns: result.pending,
    });
    process.exit(0);
  });
}

// SIGTERM = `node --watch` 热重载（实测，docs/agent/graceful-shutdown/tech.md 附录 A）、
// `kill`、K8s pod 迁移；SIGINT = Ctrl-C。若有人把 dev 脚本的 `--watch-kill-signal`
// 改成别的信号，这里要同步加监听（§7.5）。
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}
