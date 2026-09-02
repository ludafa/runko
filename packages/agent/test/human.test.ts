/**
 * [人在回路桥](../src/runtime/human.ts)与内置 `ask-user` 工具的用例——两条通道的
 * 挂起、结清、超时、以及「一轮结束时把还挂着的就地结掉」。
 */
import type { AgentDefinition, Tool, ToolContext } from "@runko/core";
import { MemoryFS } from "@runko/virtual-fs";
import { describe, expect, it, vi } from "vitest";

import { ASK_USER_TIMEOUT_MESSAGE, createAgentRuntime, defaultSessionFactory, memoryPersistence } from "../src/index.js";
import { assistantMessage, createFakeSessionFactory, endTurnChunk } from "./helpers/fake-session.js";

const agent: AgentDefinition = { model: "test/model" };

/** 一个只够 `ask-user` 用的假 `ToolContext`。 */
function toolContext(callId: string): ToolContext {
  return {
    fs: new MemoryFS(),
    abortSignal: new AbortController().signal,
    callId,
    session: { id: "s", turn: 1 },
    getSkill: () => {
      throw new Error("not used");
    },
    update: () => undefined,
  };
}

/** 从这一轮装配出来的工具表里取出内置 `ask-user`。 */
function setupWithAskUser(overrides: Partial<Parameters<typeof createAgentRuntime>[0]> = {}) {
  const sessions = createFakeSessionFactory();
  let tools: Record<string, Tool> = {};
  const runtime = createAgentRuntime({
    agent,
    prepareTurn: () => ({}),
    sessionFactory: (agentDef, options) => {
      tools = agentDef.tools ?? {};
      return sessions.factory(agentDef, options);
    },
    ...overrides,
  });
  return { runtime, sessions, askUser: (): Tool | undefined => tools["ask-user"] };
}

describe("内置 ask-user 工具", () => {
  it("恒注册（它是产品能力，不是安全闸），不设 approval", async () => {
    const { runtime, sessions, askUser } = setupWithAskUser();
    await runtime.enqueue("c1", { text: "hi" });
    await (await sessions.next()).started;
    const tool = askUser();
    expect(tool).toBeDefined();
    expect(tool?.approval).toBeUndefined();
  });

  it("`human.askUser: false` 时不注册——模型看不见它", async () => {
    const { runtime, sessions, askUser } = setupWithAskUser({ human: { askUser: false } });
    await runtime.enqueue("c2", { text: "hi" });
    await (await sessions.next()).started;
    expect(askUser()).toBeUndefined();
  });

  it("提问 → 回答：答复原样交回模型", async () => {
    const { runtime, sessions, askUser } = setupWithAskUser();
    await runtime.enqueue("c3", { text: "hi" });
    const session = await sessions.next();
    await session.started;

    const pending = askUser()?.execute({ question: "红的还是蓝的？", options: ["红", "蓝"] }, toolContext("call-1"));
    await vi.waitFor(async () => {
      expect(await runtime.submitAnswer("c3", "call-1", "蓝")).toBe(true);
    });
    await expect(pending).resolves.toBe("蓝");

    session.emit(endTurnChunk(1));
    session.finish();
  });

  it("超时不是错误——交回一段提示文案，模型自己决定接下来怎么办", async () => {
    const { runtime, sessions, askUser } = setupWithAskUser({ human: { askUserTimeoutMs: 20 } });
    await runtime.enqueue("c4", { text: "hi" });
    const session = await sessions.next();
    await session.started;

    await expect(askUser()?.execute({ question: "在吗" }, toolContext("call-2"))).resolves.toBe(ASK_USER_TIMEOUT_MESSAGE);
    // 超时与人工回答走同一条结清路径——重连的客户端分辨不出两者。
    expect(await runtime.submitAnswer("c4", "call-2", "迟到的回答")).toBe(false);

    session.emit(endTurnChunk(1));
    session.finish();
  });

  it("这一轮已被停止时，新的提问立刻超时——不挂起，否则「停止」会被拖成「四分钟后停止」", async () => {
    const { runtime, sessions, askUser } = setupWithAskUser();
    await runtime.enqueue("c5", { text: "hi" });
    const session = await sessions.next();
    await session.started;
    await runtime.abort("c5");

    await expect(askUser()?.execute({ question: "还在吗" }, toolContext("call-3"))).resolves.toBe(ASK_USER_TIMEOUT_MESSAGE);
    session.emit(endTurnChunk(1, "interrupted"));
    session.finish();
  });
});

describe("人审通道", () => {
  it("审批超时按拒绝结掉，并带上超时说明", async () => {
    const sessions = createFakeSessionFactory();
    let reviewer: ((callId: string) => Promise<{ behavior: string; message?: string }>) | undefined;
    const runtime = createAgentRuntime({
      agent,
      human: { approvalTimeoutMs: 20 },
      prepareTurn: () => ({}),
      sessionFactory: (agentDef, options) => {
        const onReview = options.onReview;
        if (onReview !== undefined) {
          reviewer = (callId) =>
            onReview({ toolName: "bash", input: "ls", ctx: { callId, toolName: "bash", session: { id: "s", turn: 1 } } });
        }
        return sessions.factory(agentDef, options);
      },
    });

    await runtime.enqueue("c6", { text: "hi" });
    const session = await sessions.next();
    await session.started;

    const decision = await reviewer?.("call-4");
    expect(decision?.behavior).toBe("deny");
    expect(decision?.message).toContain("timed out");

    session.emit(endTurnChunk(1));
    session.finish();
  });

  it("裁决落库带上 scope 与决策人（`conversation` 是范围，框架只记不执行）", async () => {
    const persistence = memoryPersistence();
    const sessions = createFakeSessionFactory();
    let reviewer: ((callId: string) => Promise<{ behavior: string }>) | undefined;
    const runtime = createAgentRuntime({
      agent,
      persistence,
      prepareTurn: () => ({}),
      sessionFactory: (agentDef, options) => {
        const onReview = options.onReview;
        if (onReview !== undefined) {
          reviewer = (callId) =>
            onReview({ toolName: "bash", input: "ls", ctx: { callId, toolName: "bash", session: { id: "s", turn: 1 } } });
        }
        return sessions.factory(agentDef, options);
      },
    });

    await runtime.enqueue("c7", { text: "hi" });
    const session = await sessions.next();
    await session.started;
    const pending = reviewer?.("call-5");
    await vi.waitFor(async () => {
      expect(await persistence.decisions.listPending("c7")).toHaveLength(1);
    });

    await runtime.submitDecision("c7", "call-5", { outcome: "deny", message: "太危险", decidedBy: "u9" });
    await expect(pending).resolves.toMatchObject({ behavior: "deny", message: "太危险" });

    session.emit(endTurnChunk(1));
    session.finish();
  });

  it("会话不存在 / callId 不存在都报 false（接入层转 404）", async () => {
    const { runtime } = setupWithAskUser();
    expect(await runtime.submitDecision("ghost", "call", { outcome: "allow" })).toBe(false);
    expect(await runtime.submitAnswer("ghost", "call", "x")).toBe(false);
  });

  it("裁决表写失败不吞掉人的答复——那会让这一轮永远挂着", async () => {
    const persistence = memoryPersistence();
    persistence.decisions = {
      record: () => Promise.reject(new Error("db down")),
      settle: () => Promise.reject(new Error("db down")),
      listPending: () => Promise.resolve([]),
    };
    const sessions = createFakeSessionFactory();
    let reviewer: ((callId: string) => Promise<{ behavior: string }>) | undefined;
    const runtime = createAgentRuntime({
      agent,
      persistence,
      prepareTurn: () => ({}),
      sessionFactory: (agentDef, options) => {
        const onReview = options.onReview;
        if (onReview !== undefined) {
          reviewer = (callId) =>
            onReview({ toolName: "bash", input: "ls", ctx: { callId, toolName: "bash", session: { id: "s", turn: 1 } } });
        }
        return sessions.factory(agentDef, options);
      },
    });

    await runtime.enqueue("c8", { text: "hi" });
    const session = await sessions.next();
    await session.started;
    const pending = reviewer?.("call-6");
    expect(await runtime.submitDecision("c8", "call-6", { outcome: "allow" })).toBe(true);
    await expect(pending).resolves.toEqual({ behavior: "allow" });

    session.emit(endTurnChunk(1));
    session.finish();
  });
});

describe("默认 session 工厂", () => {
  it("默认把文件工具八件套装上（与 `@runko/sdk` 的门面版同款装配）", async () => {
    const session = await defaultSessionFactory({ model: "test/model" }, { fs: new MemoryFS() });
    expect(session.toJSON().turn).toBe(0);
  });

  it("`builtinTools: false` 全关；数组按白名单交集", async () => {
    const off = await defaultSessionFactory({ model: "test/model", builtinTools: false }, { fs: new MemoryFS() });
    const some = await defaultSessionFactory(
      { model: "test/model", builtinTools: ["read-file", "grep"] },
      { fs: new MemoryFS() },
    );
    expect(off.toJSON().messages).toEqual([]);
    expect(some.toJSON().messages).toEqual([]);
  });

  it("resume 一份账本时轮号与消息都接得上", async () => {
    const resumed = await defaultSessionFactory(
      { model: "test/model" },
      {
        fs: new MemoryFS(),
        resume: { id: "conv", turn: 3, messages: [assistantMessage("earlier", { turn: 3 })], createdAt: 1 },
      },
    );
    const state = resumed.toJSON();
    expect(state.id).toBe("conv");
    expect(state.turn).toBe(3);
    expect(state.messages).toHaveLength(1);
  });
});
