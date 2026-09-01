/**
 * 把 driver → persistence → runtime → HTTP 串起来。**整个装配就这么长**——这就是
 * 这个 demo 想让人看到的：接一个官方持久化包，成本是「装包 + 给它一个驱动实例」。
 *
 * 抽成一个函数（而不是写在 `index.ts` 里）是为了让 e2e 能不起真端口就把它装起来，
 * 直接对 `app.request()` 打——这是 Hono 的原生能力，比起真监听端口快且没有端口冲突。
 */
import type { AgentRuntime } from "@nimbo/agent";
import { createAgentRuntime } from "@nimbo/agent";
import type { LanguageModel } from "ai";
import type { Hono } from "hono";

import { createWorkspaces, demoAgent } from "./agent.js";
import type { OpenDriverOptions } from "./driver.js";
import { openDriver } from "./driver.js";
import { createServer } from "./server.js";

export interface DemoApp {
  app: Hono;
  runtime: AgentRuntime;
  /** 方言名，e2e 用它断言「两种方言行为一致」。 */
  kind: "sqlite" | "postgres" | "mysql" | "mongo";
  close(): Promise<void>;
}

export interface CreateDemoAppOptions extends OpenDriverOptions {
  /** 每轮拿一个模型。不传就用真模型的装配（需要 API key）；e2e 传脚本化的假模型。 */
  createModel: () => LanguageModel;
  /** 队列上限，缺省 10。e2e 调小它来测「满了怎么办」。 */
  queueMax?: number;
}

export async function createDemoApp(opts: CreateDemoAppOptions): Promise<DemoApp> {
  const opened = await openDriver(opts);
  // 拿到连接之后的每一步都可能抛（建表、装配、启动扫描）。**抛出去之前必须把连接还
  // 回去**：pg.Pool / MongoClient 上的活动句柄会让整个进程挂着不退——e2e 里一次装配
  // 失败就能把 vitest 卡死。
  try {
    return await assemble(opts, opened);
  } catch (error) {
    await opened.close();
    throw error;
  }
}

async function assemble(
  opts: CreateDemoAppOptions,
  opened: Awaited<ReturnType<typeof openDriver>>,
): Promise<DemoApp> {
  const store = opened.makeStore();
  await store.migrate();

  const workspaceFor = createWorkspaces();
  const runtime = createAgentRuntime({
    agent: demoAgent({ createModel: opts.createModel }),
    // 每轮交出这一轮要用的东西。这个 demo 只给执行面——真实宿主还会在这里给
    // skill、instructions、审批分类器等等。
    prepareTurn: ({ conversationId }) => {
      const { fs, exec } = workspaceFor(conversationId);
      return { fs, exec, model: opts.createModel() };
    },
    // **本 demo 的全部意义所在**：持久化换成官方包，其余一个字不改。
    persistence: opened.persistence,
    queue: { max: opts.queueMax ?? 10 },
  });

  // 启动扫描：给崩溃残留的[孤儿轮](../../../docs/terms.md)补「已停止」收尾。
  // 必须在开始服务**之前**跑——否则前端会看到一个永远转圈的会话。
  await runtime.recover();

  return {
    app: createServer({ runtime, store }),
    runtime,
    kind: opened.kind,
    close: async () => {
      await runtime.shutdown();
      await opened.close();
    },
  };
}
