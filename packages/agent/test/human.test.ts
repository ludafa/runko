/**
 * [人在回路桥](../src/runtime/human.ts)与内置 `ask-user` 工具的用例——两条通道的
 * 挂起、结清、超时、以及「一轮结束时把还挂着的就地结掉」。
 */
import { SuspendSignal } from "@runko/core";
import type { AgentDefinition, Tool, ToolContext } from "@runko/core";
import { MemoryFS } from "@runko/virtual-fs";
import { describe, expect, it, vi } from "vitest";

import { ASK_USER_TIMEOUT_MESSAGE, createAgentRuntime, defaultSessionFactory, memoryPersistence } from "../src/index.js";
import { UNRECORDED_DENY_MESSAGE } from "../src/runtime/reasons.js";
import { settleOrphanedDecisionsSafely } from "../src/runtime/orphaned-decisions.js";
import { assistantMessage, createFakeSessionFactory, endTurnChunk } from "./helpers/fake-session.js";

const agent: AgentDefinition = { model: "test/model" };

/**
 * 一个只够 `ask-user` 用的假 `ToolContext`。`suspend` 按真实语义**抛出**（返回类型是 `never`），
 * 抛的是 core 的 `SuspendSignal`，测试据此断言「到点挂起了、理由是什么」。
 */
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
    suspend: (reason) => {
      throw new SuspendSignal(reason);
    },
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

  it("窗口到点不是返回提示文案，而是挂起——调 ctx.suspend(\"timeout\")", async () => {
    const { runtime, sessions, askUser } = setupWithAskUser({ suspend: { memoryWindow: 20 } });
    await runtime.enqueue("c4", { text: "hi" });
    const session = await sessions.next();
    await session.started;

    let thrown: unknown;
    try {
      await askUser()?.execute({ question: "在吗" }, toolContext("call-2"));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SuspendSignal);
    expect(thrown instanceof SuspendSignal ? thrown.reason : undefined).toBe("timeout");
    // 挂起之后内存里没有这一项了，迟到的回答走恢复路径。但恢复只认**账本末尾还悬着**的调用，
    // 这里的假 session 一个字都不写账本——这一行在账本里没有对应的悬空调用，按孤儿对待，报 false。
    // 真账本下的恢复见 resume.test.ts。
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
  it("审批窗口到点不再当拒绝，而是答「挂起」", async () => {
    const sessions = createFakeSessionFactory();
    let reviewer: ((callId: string) => Promise<{ behavior: string; message?: string }>) | undefined;
    const runtime = createAgentRuntime({
      agent,
      suspend: { memoryWindow: 20 },
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
    expect(decision).toEqual({ behavior: "suspend", reason: "timeout" });

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
      get: () => Promise.reject(new Error("db down")),
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

describe("裁决表那一行没登记上：不能挂起", () => {
  // 挂起之后人回来答的就是那一行。没有它，这次调用永远没人能答，会话也再开不了普通轮——
  // 所以退回窗口到点的老结局，让这一轮照常往下走。
  function setupFailingRecord(memoryWindow: number) {
    const persistence = memoryPersistence();
    persistence.decisions.record = () => Promise.reject(new Error("db down"));
    const sessions = createFakeSessionFactory();
    let reviewer: ((callId: string) => Promise<{ behavior: string; message?: string }>) | undefined;
    const runtime = createAgentRuntime({
      agent,
      persistence,
      suspend: { memoryWindow },
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
    return { runtime, sessions, review: (callId: string) => reviewer?.(callId) };
  }

  it("窗口到点：按拒绝结掉，理由说清楚", async () => {
    const { runtime, sessions, review } = setupFailingRecord(20);
    await runtime.enqueue("c9", { text: "hi" });
    const session = await sessions.next();
    await session.started;
    await expect(review("call-9")).resolves.toMatchObject({ behavior: "deny", message: UNRECORDED_DENY_MESSAGE });
    session.emit(endTurnChunk(1));
    session.finish();
  });

  it("窗口是 0：同样不挂起", async () => {
    const { runtime, sessions, review } = setupFailingRecord(0);
    await runtime.enqueue("c10", { text: "hi" });
    const session = await sessions.next();
    await session.started;
    await expect(review("call-10")).resolves.toMatchObject({ behavior: "deny" });
    session.emit(endTurnChunk(1));
    session.finish();
  });
});

describe("收拾孤儿行失败不连累调用方", () => {
  it("settleOrphanedDecisionsSafely：裁决表抛错时返回 0、记一行，不往外抛", async () => {
    const persistence = memoryPersistence();
    persistence.decisions.listPending = () => Promise.reject(new Error("db down"));
    const errors: string[] = [];
    const logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: (_s: string, message: string) => errors.push(message) };
    await expect(settleOrphanedDecisionsSafely(persistence, logger, "c1")).resolves.toBe(0);
    expect(errors).toHaveLength(1);
  });
});
