/**
 * 进程入口。`start` 跑的是编译产物，先 `pnpm --filter "@runko-demo/persist-demo..." build`；
 * 改代码时用 `dev`，它直接跑这份源码。
 *
 * 环境变量：
 *
 * | 变量 | 缺省 | 说明 |
 * |---|---|---|
 * | `PORT` | `3910` | 监听端口（避开 chat 应用的 3900） |
 * | `DEMO_DB` | `sqlite` | `sqlite` / `memory` / `postgres` / `mysql` / `mongo`（认不出来的值回落成 `sqlite`） |
 * | `DEMO_DB_PATH` | `demo.db` | SQLite 库文件 |
 * | `DATABASE_URL` | — | `postgres` / `mysql` / `mongo` 时的连接串 |
 * | `RUNKO_NODE_URL` | — | **多副本**：本副本的可达地址。给了才换租约版归属仲裁 + 开转发 |
 * | `RUNKO_PEER_TOKEN` | — | 副本之间的内部令牌；不配就不校验（本机联调用） |
 * | `RUNKO_HEARTBEAT_MS` / `RUNKO_TAKEOVER_MS` | 5000 / 60000 | 租约的两个时间参数；e2e 用它把时间轴压扁 |
 * | `RUNKO_FORWARD_TIMEOUT_MS` | 10000 | 转发给持有者时等它开口的上限；等不到回 503 |
 * | `RUNKO_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` / `silent`；框架的起轮收尾、转发与每个 HTTP 请求都会记 |
 * | `RUNKO_LOG_NAME` | `RUNKO_NODE_URL` 的主机名，再缺省 `demo` | 日志里「谁打的」那一列 |
 * | `DEMO_MODEL_DELAY_MS` | `0` | 回声模型答话前先睡多久；e2e 用它让「这一轮还在跑」成为确定事实 |
 *
 * **模型固定是回声模型**（不联网，说什么答什么）——这个 demo 展示的是持久化，
 * 不该拿 API key 当门槛。真要接 provider 看 `apps/node-server/src/agent/model.ts`。
 */
import { serve } from "@hono/node-server";

import { createDemoApp } from "./app.js";
import { createTextLogger, parseLogLevel } from "./logger.js";
import { echoModel, slowModel } from "./model.js";

const port = Number(process.env["PORT"] ?? 3910);

/**
 * 多副本只靠一个环境变量开：`RUNKO_NODE_URL` 是本副本的**可达地址**，原样进 `holder`。
 * 不配就是单副本跑法，行为与以前一字不差。
 */
const nodeUrl = process.env["RUNKO_NODE_URL"]?.trim();
const peerToken = process.env["RUNKO_PEER_TOKEN"]?.trim();
/**
 * 读一个数字环境变量。**空串要当成「没配」**——`Number("")` 是 0，而 k8s / compose 里
 * 「声明了但没给值」很常见：那会把心跳配成 0（每毫秒两条查询），或者把接管阈值配成 0
 * 让构造直接抛，报错还指着一个用户根本没设过的数字。
 */
const num = (name: string): number | undefined => {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") {return undefined;}
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
};
const modelDelayMs = num("DEMO_MODEL_DELAY_MS") ?? 0;
const heartbeatMs = num("RUNKO_HEARTBEAT_MS");
const takeoverMs = num("RUNKO_TAKEOVER_MS");
const forwardTimeoutMs = num("RUNKO_FORWARD_TIMEOUT_MS");

/** 日志里「谁打的」：多副本时取可达地址的主机名（`replica-a`），单副本就叫 `demo`。 */
const nodeName = ((): string => {
  const explicit = process.env["RUNKO_LOG_NAME"]?.trim();
  if (explicit !== undefined && explicit !== "") {return explicit;}
  if (nodeUrl === undefined || nodeUrl === "") {return "demo";}
  try {
    return new URL(nodeUrl).hostname;
  } catch {
    return nodeUrl;
  }
})();
const logLevel = parseLogLevel(process.env["RUNKO_LOG_LEVEL"]) ?? "info";
const logger = createTextLogger({ node: nodeName, level: logLevel });

const demo = await createDemoApp({
  createModel: () =>
    modelDelayMs > 0 ? slowModel("（慢回声：这一轮故意跑久一点。）", modelDelayMs) : echoModel(),
  logger,
  ...(nodeUrl !== undefined && nodeUrl !== ""
    ? {
        node: {
          url: nodeUrl,
          ...(peerToken !== undefined && peerToken !== "" ? { peerToken } : {}),
          ...(heartbeatMs !== undefined ? { heartbeatMs } : {}),
          ...(takeoverMs !== undefined ? { takeoverMs } : {}),
          ...(forwardTimeoutMs !== undefined ? { forwardTimeoutMs } : {}),
        },
      }
    : {}),
});

const server = serve({ fetch: demo.app.fetch, port }, (info) => {
  // 进程入口，这是唯一该往 stdout 写的地方。日志全静音时也要让人知道服务起来了。
  const mode = nodeUrl === undefined || nodeUrl === "" ? "单副本" : `多副本 holder=${nodeUrl}`;
  if (logLevel === "silent") {
    console.log(`persist-demo 起来了：http://localhost:${String(info.port)}（${demo.kind} · ${mode}）`);
    return;
  }
  logger.info("server", "listening", { url: `http://localhost:${String(info.port)}`, db: demo.kind, mode, logLevel });
});

/** 收到信号先[交权](../../../docs/terms.md)再退——别把正在跑的轮硬切断。 */
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void (async () => {
      await demo.close();
      server.close();
      process.exit(0);
    })();
  });
}
