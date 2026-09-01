/**
 * 进程入口。`pnpm --filter @nimbo-demo/persist-demo start`。
 *
 * 环境变量：
 *
 * | 变量 | 缺省 | 说明 |
 * |---|---|---|
 * | `PORT` | `3910` | 监听端口（避开 chat 应用的 3900） |
 * | `DEMO_DB` | `sqlite` | `sqlite` / `memory` / `postgres` / `mysql` / `mongo`（认不出来的值回落成 `sqlite`） |
 * | `DEMO_DB_PATH` | `demo.db` | SQLite 库文件 |
 * | `DATABASE_URL` | — | `postgres` / `mysql` / `mongo` 时的连接串 |
 *
 * **模型固定是回声模型**（不联网，说什么答什么）——这个 demo 展示的是持久化，
 * 不该拿 API key 当门槛。真要接 provider 看 `apps/node-server/src/agent/model.ts`。
 */
import { serve } from "@hono/node-server";

import { createDemoApp } from "./app.js";
import { echoModel } from "./model.js";

const port = Number(process.env["PORT"] ?? 3910);

const demo = await createDemoApp({
  createModel: () => echoModel(),
});

const server = serve({ fetch: demo.app.fetch, port }, (info) => {
  // 进程入口，这是唯一该往 stdout 写的地方。
  console.log(`persist-demo 起来了：http://localhost:${String(info.port)}（${demo.kind}）`);
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
