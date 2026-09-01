import { serve } from '@hono/node-server';

import { app } from './app.js';
import { generateOpenAPISpec } from './generate-spec.js';
import { logger } from './logger.js';
import { logPushStartup } from './push/vapid.js';
import { chatRuntime } from './routes/chat.js';

const LOG_SCOPE = 'server';

// Generate openapi.yml on dev server start
generateOpenAPISpec(app);

// 推送通知（docs/tech/push-notification.md §6.5）：把「开没开、开了哪几类」摊在
// 启动日志里，且**只在这里**说一遍——`isPushEnabled()` 在每一轮里会被问很多次，
// 那些地方一行日志都不该打。
logPushStartup(logger);

// [崩溃恢复](../../../docs/terms.md)（docs/logic/orchestration/tech/agent-runtime.md §4.3）：
// 上次进程若是被强杀的（`kill -9`/OOM/断电），那些[孤儿轮](../../../docs/terms.md)在账本里
// 从没收尾。判据是[起轮标记](../../../docs/terms.md)——库里还留着标记 = 那一轮没人管了。
//
// 放在 `serve()` **之前**：这样第一个请求进来时账本已经一致，不会有人看到一个还没补上
// 收尾的半截历史；而且那一刻本进程不可能有任何轮在跑，所以扫描没有竞态。
// **必须 await**：注释里那句「第一个请求进来时账本已经一致」全靠它。`void` 的写法只是
// 因为当前这一档持久化恰好全同步才没出事；任何一处变成真异步（换库、加一次远程调用），
// 请求就会和扫描赛跑——`acquire` 撞上没清掉的陈旧标记 → `held_by_other` → 路由回 500
// 且消息不入队（直接丢）；更糟的是扫描里那个 grant 的 holder 是进程级的 `pid:N`，
// 会把刚起来那一轮的标记也一并抹掉。
// 扫描失败不阻断启动：记一行继续，服务照常起（顶多是某些会话的界面转圈，等下次重启再扫）。
try {
  await chatRuntime.recover();
} catch (error) {
  logger.error(LOG_SCOPE, 'startup recovery sweep failed, continuing', {
    error: error instanceof Error ? error.message : String(error),
  });
}

const port = Number(process.env.SERVER_PORT ?? 3000);

/**
 * [优雅关闭](../../../docs/terms.md)等收尾的上限（docs/tech/graceful-shutdown.md §7.1）。
 *
 * 默认 15 秒：K8s 的 `terminationGracePeriodSeconds` 默认 30 秒，留一半余量给连接关闭与
 * 进程退出。`node --watch` 侧是**无限期**等我们的（实测，见 tech 附录 A），所以这个值在
 * dev 环境纯粹是我们自己的保险——没有它，一个卡住的收尾会让热重载再也起不来。
 */
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 15_000);

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Server running at http://localhost:${info.port}`);
  console.log(`Swagger UI at http://localhost:${info.port}/reference`);
  console.log(`OpenAPI spec at http://localhost:${info.port}/doc`);
});

/**
 * 关闭顺序是硬要求（docs/tech/graceful-shutdown.md §3.2）：
 *
 * **先让轮收尾，再关 server。** 反过来的话，被中止那一轮的收尾帧根本发不到浏览器
 * ——它要经 `GET .../stream` 送出去，而 `server.close()` 会断掉那条 SSE 连接；更糟的是
 * `close()` 本身会等现有连接结束，SSE 是长连接，等于自己把自己锁住。
 *
 * 正着来则天然顺：轮一收尾，`emit('done')` 让 tail 正常关闭，`close()` 立刻就能完成。
 */
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (chatRuntime.isShuttingDown()) {
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

  const result = await chatRuntime.shutdown({
    graceMs: SHUTDOWN_TIMEOUT_MS,
  });

  server.close(() => {
    logger.info(LOG_SCOPE, 'shutdown complete', {
      signal,
      abortedTurns: result.aborted,
      // `false` = 撞了宽限期上限，那几个轮成了孤儿轮，下次启动由 `runtime.recover()` 补收尾。
      allTurnsSettled: result.settled,
      pendingTurns: result.pending,
    });
    process.exit(0);
  });
}

// SIGTERM = `node --watch` 热重载（实测，docs/tech/graceful-shutdown.md 附录 A）、
// `kill`、K8s pod 迁移；SIGINT = Ctrl-C。若有人把 dev 脚本的 `--watch-kill-signal`
// 改成别的信号，这里要同步加监听（§7.5）。
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}
