/**
 * 挂起的配置面：`suspend.memoryWindow`、`suspend.onPresence`、`reportPresence`，
 * 以及旧的两个超时参数怎么映射过来。设计见 docs/logic/orchestration/tech/suspend-resume.md §8。
 *
 * 这一组只关心「窗口怎么计时」，用假 session 直接调人审通道，不跑真模型。
 */
import { SuspendSignal } from "@runko/core";
import type { AgentDefinition, HumanDecision, Tool, ToolContext } from "@runko/core";
import { MemoryFS } from "@runko/virtual-fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAgentRuntime } from "../src/index.js";
import type { Logger } from "../src/index.js";
import { createFakeSessionFactory, endTurnChunk } from "./helpers/fake-session.js";

type RuntimeOptions = Parameters<typeof createAgentRuntime>[0];
type ApprovalPendingEvent = Parameters<NonNullable<NonNullable<RuntimeOptions["hooks"]>["onApprovalPending"]>>[0];

const agent: AgentDefinition = { model: "test/model" };

function recordingLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    debug: () => undefined,
    info: () => undefined,
    warn: (_scope, message) => {
      warnings.push(message);
    },
    error: () => undefined,
  };
}

/** 起一轮，交出这一轮的人审通道与内置 `ask-user`。 */
async function startTurn(overrides: Partial<RuntimeOptions> = {}, conversationId = "c1") {
  const sessions = createFakeSessionFactory();
  const approvals: ApprovalPendingEvent[] = [];
  let reviewer: ((callId: string) => Promise<HumanDecision>) | undefined;
  let tools: Record<string, Tool> = {};
  const runtime = createAgentRuntime({
    agent,
    prepareTurn: () => ({}),
    hooks: { onApprovalPending: (event) => approvals.push(event) },
    sessionFactory: (agentDef, options) => {
      tools = agentDef.tools ?? {};
      const onReview = options.onReview;
      if (onReview !== undefined) {
        reviewer = (callId) =>
          onReview({ toolName: "bash", input: "ls", ctx: { callId, toolName: "bash", session: { id: "s", turn: 1 } } });
      }
      return sessions.factory(agentDef, options);
    },
    ...overrides,
  });
  await runtime.enqueue(conversationId, { text: "hi" });
  const session = await sessions.next();
  await session.started;
  const review = (callId: string): Promise<HumanDecision> => {
    if (reviewer === undefined) {throw new Error("no reviewer wired");}
    return reviewer(callId);
  };
  const finish = () => {
    session.emit(endTurnChunk(1));
    session.finish();
  };
  return { runtime, approvals, review, askUser: (): Tool | undefined => tools["ask-user"], finish };
}

/** 跟踪一个 promise 有没有落定，不 await 它。 */
function track<T>(promise: Promise<T>): { value: () => T | undefined } {
  let value: T | undefined;
  void promise.then((resolved) => {
    value = resolved;
  });
  return { value: () => value };
}

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

afterEach(() => {
  vi.useRealTimers();
});

describe("suspend.memoryWindow", () => {
  it("缺省 5 分钟：等人事件报的窗口是 300000 毫秒", async () => {
    const { approvals, review, finish } = await startTurn();
    void review("call-1");
    expect(approvals[0]?.timeoutMs).toBe(300_000);
    finish();
  });

  it("写成带单位的字符串：\"2s\" 就是 2000 毫秒，到点才挂起", async () => {
    const { review, finish } = await startTurn({ suspend: { memoryWindow: "2s" } });
    vi.useFakeTimers();
    const decision = track(review("call-1"));

    await vi.advanceTimersByTimeAsync(1_999);
    expect(decision.value()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(decision.value()).toEqual({ behavior: "suspend", reason: "timeout" });
    vi.useRealTimers();
    finish();
  });

  it("0：审批一来就挂起，理由是 immediate，而且不起定时器", async () => {
    const { approvals, review, finish } = await startTurn({ suspend: { memoryWindow: 0 } });
    vi.useFakeTimers();
    const before = vi.getTimerCount();

    await expect(review("call-1")).resolves.toEqual({ behavior: "suspend", reason: "immediate" });
    expect(vi.getTimerCount()).toBe(before);
    // 推送照发：人得知道有一张卡片在等他，只是已经不在内存里等了。
    expect(approvals[0]?.timeoutMs).toBe(0);
    vi.useRealTimers();
    finish();
  });

  it("0：ask-user 同样立刻挂起", async () => {
    const { askUser, finish } = await startTurn({ suspend: { memoryWindow: 0 } });
    let thrown: unknown;
    try {
      await askUser()?.execute({ question: "A 还是 B？" }, toolContext("call-q"));
    } catch (error) {
      thrown = error;
    }
    expect(thrown instanceof SuspendSignal ? thrown.reason : undefined).toBe("immediate");
    finish();
  });

  it.each([
    ["负数", -1],
    ["NaN", Number.NaN],
    ["科学计数法", "1e3s" as const],
    ["超过定时器上限（Node 会改成 1 毫秒）", "720h" as const],
  ])("写错了（%s）构造时就抛，不悄悄按默认跑", (_label, memoryWindow) => {
    expect(() => createAgentRuntime({ agent, prepareTurn: () => ({}), suspend: { memoryWindow } })).toThrow(RangeError);
  });
});

describe("旧的两个超时参数（废弃别名）", () => {
  it("只配 approvalTimeoutMs：审批按它等，提问用新默认；记一行 deprecated", async () => {
    const logger = recordingLogger();
    const { approvals, review, finish } = await startTurn({ human: { approvalTimeoutMs: 1_234 }, logger });
    void review("call-1");
    expect(approvals[0]?.timeoutMs).toBe(1_234);
    expect(logger.warnings.some((message) => message.includes("approvalTimeoutMs is deprecated"))).toBe(true);
    finish();
  });

  it("新旧都配：新的赢，旧的记一行说被忽略了", async () => {
    const logger = recordingLogger();
    const { approvals, review, finish } = await startTurn({
      human: { approvalTimeoutMs: 1_234 },
      suspend: { memoryWindow: "3s" },
      logger,
    });
    void review("call-1");
    expect(approvals[0]?.timeoutMs).toBe(3_000);
    expect(logger.warnings.some((message) => message.includes("ignored"))).toBe(true);
    finish();
  });

  it("都不配：一行 warn 都没有", async () => {
    const logger = recordingLogger();
    const { finish } = await startTurn({ logger });
    expect(logger.warnings.filter((message) => message.includes("deprecated"))).toEqual([]);
    finish();
  });
});

describe("reportPresence", () => {
  it("extend（缺省）：上报一次，窗口从那一刻起重新计时", async () => {
    const { runtime, review, finish } = await startTurn({ suspend: { memoryWindow: 1_000 } });
    vi.useFakeTimers();
    const decision = track(review("call-1"));

    await vi.advanceTimersByTimeAsync(800);
    runtime.reportPresence("c1");
    // 从起点算已经 1600 毫秒，超过一个窗口——但从上报算才 800，还在等。
    await vi.advanceTimersByTimeAsync(800);
    expect(decision.value()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(200);
    expect(decision.value()).toEqual({ behavior: "suspend", reason: "timeout" });
    vi.useRealTimers();
    finish();
  });

  it("ignore：上报不影响计时", async () => {
    const { runtime, review, finish } = await startTurn({ suspend: { memoryWindow: 1_000, onPresence: "ignore" } });
    vi.useFakeTimers();
    const decision = track(review("call-1"));

    await vi.advanceTimersByTimeAsync(800);
    runtime.reportPresence("c1");
    await vi.advanceTimersByTimeAsync(200);
    expect(decision.value()).toEqual({ behavior: "suspend", reason: "timeout" });
    vi.useRealTimers();
    finish();
  });

  it("续期对 ask-user 同样有效", async () => {
    const { runtime, askUser, finish } = await startTurn({ suspend: { memoryWindow: 1_000 } });
    vi.useFakeTimers();
    let thrown: unknown;
    const pending = (async () => {
      try {
        await askUser()?.execute({ question: "在吗" }, toolContext("call-q"));
      } catch (error) {
        thrown = error;
      }
    })();

    await vi.advanceTimersByTimeAsync(800);
    runtime.reportPresence("c1");
    await vi.advanceTimersByTimeAsync(800);
    expect(thrown).toBeUndefined();
    await vi.advanceTimersByTimeAsync(200);
    await pending;
    expect(thrown).toBeInstanceOf(SuspendSignal);
    vi.useRealTimers();
    finish();
  });

  it("没有轮、或这一轮没在等人：静默忽略，不抛", async () => {
    const { runtime, finish } = await startTurn();
    expect(() => {
      runtime.reportPresence("no-such-conversation");
      runtime.reportPresence("c1");
    }).not.toThrow();
    finish();
  });
});
