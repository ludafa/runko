/**
 * 把 driver → persistence → runtime → HTTP 串起来。**整个装配就这么长**——这就是
 * 这个 demo 想让人看到的：接一个官方持久化包，成本是「装包 + 给它一个驱动实例」。
 *
 * 抽成一个函数（而不是写在 `index.ts` 里）是为了让 e2e 能不起真端口就把它装起来，
 * 直接对 `app.request()` 打——这是 Hono 的原生能力，比起真监听端口快且没有端口冲突。
 */
import type { AgentRuntime } from "@runko/agent";
import { createAgentRuntime } from "@runko/agent";
import type { LanguageModel } from "ai";
import type { Hono } from "hono";

import { createWorkspaces, demoAgent } from "./agent.js";
import type { OpenDriverOptions } from "./driver.js";
import { openDriver } from "./driver.js";
import type { NodeIdentity } from "./forward.js";
import { createForwarder } from "./forward.js";
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
  /**
   * 多副本：本副本的可达地址与副本间令牌。**给了才换租约版[归属仲裁机制](../../../docs/terms.md)**，
   * 不给就用框架内置的内存版（单副本跑法，一行代码不用改）。
   *
   * 当前档次拿不出租约版实现时（Mongo）**直接抛**，不静默回落——理由见下面装配处。
   * `DEMO_DB=memory` 也照样换，只是每个进程各有一份私有内存库、租约互相看不见，
   * 那种配法本来就不成立。
   */
  node?: NodeIdentity & { heartbeatMs?: number; takeoverMs?: number };
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
  // 多副本：租约版仲裁 + 应用层转发，**两样一起给才成立**。
  //
  // 半套配法是这里最危险的一件事，而且两个方向都错得很安静：只换仲裁不开转发，请求会
  // 落在没有归属的副本上、用户看到一条永远没内容的流；只开转发不换仲裁更糟——每个副本
  // 各有一份内存归属表，两边 `acquire` 都成功、都起轮、都往同一个账本写，而
  // `getActivity` 永远说 `local`，转发形同虚设。所以拿不出租约版实现时**直接抛**。
  if (opts.node !== undefined && opened.makeArbitration === undefined) {
    throw new Error(
      `multi-replica requested (holder ${opts.node.url}) but the ${opened.kind} driver has no lease arbitration yet. ` +
        "Running multiple replicas on in-memory arbitration lets two of them drive the same conversation at once.",
    );
  }
  const arbitration =
    opts.node !== undefined && opened.makeArbitration !== undefined
      ? opened.makeArbitration({
          holder: opts.node.url,
          ...(opts.node.heartbeatMs !== undefined ? { heartbeatMs: opts.node.heartbeatMs } : {}),
          ...(opts.node.takeoverMs !== undefined ? { takeoverMs: opts.node.takeoverMs } : {}),
        })
      : undefined;
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
    ...(arbitration !== undefined ? { arbitration } : {}),
    queue: { max: opts.queueMax ?? 10 },
  });

  // 启动扫描：给崩溃残留的[孤儿轮](../../../docs/terms.md)补「已停止」收尾。
  // 必须在开始服务**之前**跑——否则前端会看到一个永远转圈的会话。
  await runtime.recover();

  return {
    app: createServer({ runtime, store, forwarder: createForwarder(opts.node) }),
    runtime,
    kind: opened.kind,
    close: async () => {
      await runtime.shutdown();
      await opened.close();
    },
  };
}
