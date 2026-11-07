/**
 * 测试用 Worker，导出两个 Durable Object 类：
 *
 * - `BareObject`：空对象，只用它的存储。一致性套件、方言、仲裁与大部分运行时用例在它里面现造要测的东西。
 * - `AgentObject`：照 README 的写法装好运行时（构造函数 → `createDurableObjectRuntime`，`alarm()` 转调，
 *   RPC 方法用 `framesToStream` 传直播帧）。alarm、真回收、跨 RPC 那几条用它。
 */
import type { Frame } from "@runko/agent";
import type { AgentDefinition } from "@runko/core";
import { DurableObject } from "cloudflare:workers";

import type { DurableObjectRuntime } from "../src/index.js";
import { createDurableObjectRuntime, framesToStream } from "../src/index.js";
import type { FakeSessions } from "./helpers/fake-session.js";
import { createFakeSessionFactory } from "./helpers/fake-session.js";

/** 模型字段永远不会被假 session 用到——只是 `AgentDefinition` 要求它有个值。 */
export const TEST_AGENT: AgentDefinition = { model: "test/model" };

export class BareObject extends DurableObject {}

export class AgentObject extends DurableObject {
  readonly sessions: FakeSessions = createFakeSessionFactory();
  readonly agent: DurableObjectRuntime;
  /** 每次 `live()` 交给帧源的 signal，测试据此确认 cancel 传回来了。 */
  readonly liveSignals: AbortSignal[] = [];

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.agent = createDurableObjectRuntime(ctx, {
      agent: TEST_AGENT,
      prepareTurn: () => ({}),
      sessionFactory: this.sessions.factory,
    });
  }

  async alarm(): Promise<void> {
    await this.agent.alarm();
  }

  async send(conversationId: string, text: string): Promise<string> {
    await this.agent.ready;
    const result = await this.agent.runtime.enqueue(conversationId, { text });
    return result.mode;
  }

  /** 保活空行在测试里调到 50ms，cancel 那条用例不必等 10 秒。 */
  live(conversationId: string, follow: "turn" | "forever" = "turn"): ReadableStream<Uint8Array> {
    return framesToStream(
      (signal): AsyncIterable<Frame> => {
        this.liveSignals.push(signal);
        return this.agent.runtime.subscribe(conversationId, { signal, follow });
      },
      { keepAlive: "50ms" },
    );
  }
}

export default {
  fetch(): Response {
    return new Response("runko durable-object test worker");
  },
};
