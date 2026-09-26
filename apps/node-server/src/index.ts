import { serve } from '@hono/node-server';

import { app, injectWebSocket } from './app.js';
import { db, flavor } from './db/instance.js';
import { migrateDatabase } from './db/migrate.js';
import { logger } from './logger.js';
import { logPushStartup } from './push/vapid.js';
import { chatRuntime, chatStream, nodeOffline } from './routes/chat.js';

const LOG_SCOPE = 'server';

// SQLite 那一档**启动时自己把表建好**：零配置——clone 下来直接起，不用先记得跑一条建表命令。
// 单进程，不会有两个人同时建表。Postgres 不在这里建（多副本会撞在一起），要显式跑 `db:migrate`。
if (flavor === 'sqlite') {
  await migrateDatabase(db, flavor, logger);
}

// 推送通知（docs/ingress/tech/push-notification.md §6.5）：把「开没开、开了哪几类」摊在
// 启动日志里，且**只在这里**说一遍——`isPushEnabled()` 在每一轮里会被问很多次，
// 那些地方一行日志都不该打。
logPushStartup(logger);

// 启动时扫[孤儿轮](../../../docs/terms.md)（docs/logic/orchestration/tech/graceful-shutdown.md §5）：
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
 * [交权](../../../docs/terms.md)时等各轮收尾的上限。交权本身几百毫秒就完成（模型输出掐断、工具留在本节点上
 * 跑），这个上限只防装配卡住之类的意外。`node --watch` 侧是无限期等我们的，这是我们自己的保险。
 */
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 15_000);

/**
 * `server.close()` 之后最多再等多久才硬退。这段时间留给 SIGTERM 之前就接下、还在处理的请求——比如建一个云沙盒要
 * 十几秒到一分钟，中途断掉的话 nginx 会把这个 POST 重发给别的副本、再建一个沙盒。到点还没退（多半是替别的节点
 * 转发的长连接）就硬断、退出（docs/host/node/tech/cluster-console.md §4）。
 */
const FORCE_EXIT_AFTER_MS = 60_000;

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Server running at http://localhost:${info.port}`);
  console.log(`Swagger UI at http://localhost:${info.port}/reference`);
  console.log(`OpenAPI spec at http://localhost:${info.port}/doc`);
  // **先监听、再登记并扫待接手**：浏览器的重连要尽快成功，别让它等一次全表扫描。
  void chatRuntime.start().catch((error: unknown) => {
    logger.error(LOG_SCOPE, 'failed to start the runtime background work', {
      error: error instanceof Error ? error.message : String(error),
    });
  });
});

// WebSocket 的升级要挂在 HTTP 服务器上，所以只能在 `serve()` 之后。
injectWebSocket(server);

/**
 * 收到 SIGTERM：[节点下线](../../../docs/terms.md)，顺序是硬要求（docs/host/node/tech/cluster-console.md §4）：
 *
 * 1. **先关闸门**：浏览器来的一律 503，转发来的放到交接完成为止（真集群里是负载均衡 / mesh 在做这件事，见 `offline.ts`）。
 * 2. **交权**（`chatRuntime.shutdown()`）：每份对话几百毫秒内交给别的副本；本节点上的直播收到请重连帧后收线；
 *    还在跑的工具留在本节点上跑完、结果写库。它返回时本节点已经没活了。
 * 3. **交接完成**（`finishHandover()`）：闸门改成转发来的也挡。
 * 4. 收 Redis 连接（最后几帧要广播出去）。先断空闲连接，再 `server.close()`。
 *    还没断的连接最多再等 60 秒，到点硬断、退出。
 *
 * 再收到一次信号就立刻 `exit(1)`。
 */
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (chatRuntime.isShuttingDown()) {
    // 第二次信号：人不想等了（开发时 Ctrl-C 两下、热重载赶上一条长命令）。立刻退，
    // 还在本节点上跑的工具收尾记不上结果，接手的一方到点会把它记成「结果未知」。
    logger.warn(LOG_SCOPE, 'second signal during shutdown, exiting now', {
      signal,
    });
    process.exit(1);
  }

  logger.info(LOG_SCOPE, 'shutdown requested', {
    signal,
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
  });

  nodeOffline.goOffline();

  const result = await chatRuntime.shutdown({ graceMs: SHUTDOWN_TIMEOUT_MS });
  nodeOffline.finishHandover();

  await chatStream.close().catch((error: unknown) => {
    logger.warn(LOG_SCOPE, 'failed to close the redis connections', {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  // `serve()` 的返回类型也覆盖 HTTP/2 服务器，那一种没有这两个方法；本应用跑的是 HTTP/1.1。
  if ('closeIdleConnections' in server) {
    server.closeIdleConnections();
  }
  setTimeout(() => {
    logger.warn(LOG_SCOPE, 'connections still open; forcing exit', {
      afterMs: FORCE_EXIT_AFTER_MS,
    });
    if ('closeAllConnections' in server) {
      server.closeAllConnections();
    }
    process.exit(0);
  }, FORCE_EXIT_AFTER_MS);
  server.close(() => {
    logger.info(LOG_SCOPE, 'shutdown complete', {
      signal,
      handedOverTurns: result.handedOver,
      suspendedTurns: result.suspended,
      abortedTurns: result.aborted,
      target: result.target ?? 'none',
      transferred: result.transferred,
      delegated: result.delegated,
      toolTails: result.tails,
      // `false` = 退回中止之后仍没收尾，那几个轮成了孤儿轮。多副本时由别的节点接管后补收尾；
      // 单进程时下次启动由 `runtime.recover()` 补。
      allTurnsSettled: result.settled,
      pendingTurns: result.pending,
    });
    process.exit(0);
  });
}

// SIGTERM = `node --watch` 热重载（实测，docs/logic/orchestration/tech/graceful-shutdown.md 附录 A）、
// `kill`、K8s pod 迁移；SIGINT = Ctrl-C。若有人把 dev 脚本的 `--watch-kill-signal`
// 改成别的信号，这里要同步加监听（§7.5）。
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}
