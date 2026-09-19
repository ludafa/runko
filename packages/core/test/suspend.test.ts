/**
 * 挂起（docs/logic/orchestration/tech/suspend-resume.md）在 core 这一层的行为。
 *
 * 两个入口，一个共同性质：**挂起时 loop 什么都不写**。
 *
 * | 入口 | 谁触发 | 那条工具部件停在 |
 * |---|---|---|
 * | 人审通道答 `{ behavior: "suspend" }` | 人在回路桥等不到人 | `approval-requested` |
 * | 工具自己调 `ctx.suspend()` | `ask-user` 这类等人的工具 | `input-available` |
 *
 * 两条路都必须留下「一次带着完整入参、还没有结果的调用」——恢复那一轮要照着它原封不动地执行
 * （§5.2 的安全性质）。所以这里的断言大多是**否定式**的：没有响应 chunk、没有 output 部件、
 * 没进第二步。
 */
import { describe, expect, it, vi } from "vitest";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { runTurn } from "../src/loop.js";
import type { RunTurnOptions } from "../src/loop.js";
import { createOnceApprovalMemory } from "../src/approval.js";
import { createDerivedDataCollector } from "../src/runtime.js";
import { SuspendSignal, isSuspendSignal, pendingCallIds } from "../src/suspend.js";
import type { ApprovalPolicy, ApprovalReviewer, HumanDecision, RunkoFS, Tool } from "../src/types.js";
import type { RunkoChunk, RunkoMessageMetadata, RunkoUIMessage } from "../src/state.js";
import { allToolParts, chunksOfType, drainTurn, fileChangeParts, lastAssistantMessage, toolTimingPartFor, userTextMessage } from "./helpers/runko-chunks.js";

function mockModel(buildOptions: () => ConstructorParameters<typeof MockLanguageModelV4>[0]): MockLanguageModelV4 {
  return new MockLanguageModelV4(buildOptions());
}

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
} as const;

function fakeFs(): RunkoFS {
  return {
    readFile: async () => new Uint8Array(),
    writeFile: async () => {},
    rm: async () => {},
    mkdir: async () => {},
    readdir: async () => [],
    stat: async () => ({ type: "file" }),
    glob: async () => [],
  };
}

function turnOptions(model: MockLanguageModelV4, overrides: Partial<RunTurnOptions> = {}): RunTurnOptions {
  return {
    model,
    system: undefined,
    messages: [],
    tools: {},
    maxTurnsPerRun: 40,
    maxContextTokens: undefined,
    maxOutputTokens: undefined,
    fs: fakeFs(),
    session: { id: "sess_1", turn: 1 },
    signal: undefined,
    onApproval: undefined,
    onReview: undefined,
    onceMemory: createOnceApprovalMemory(),
    derivedData: createDerivedDataCollector(),
    ...overrides,
  };
}

/** 一个 tool-call 步 + 一个纯文本步。**第二步存在是刻意的**：挂起时它绝不该被跑到。 */
function twoStepModel(calls: { toolCallId: string; toolName: string; input: string }[]): MockLanguageModelV4 {
  return mockModel(() => ({
    doStream: [
      {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            ...calls.map((call) => ({ type: "tool-call" as const, ...call })),
            { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      },
      {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "这一步不该被跑到" },
            { type: "text-end", id: "t1" },
            { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      },
    ],
  }));
}

/** 本轮的收尾 metadata（`finalizeTurn` 产出的那条 `message-metadata`）。 */
function settleMetadata(chunks: RunkoChunk[]): RunkoMessageMetadata | undefined {
  const metadataChunks = chunksOfType(chunks, "message-metadata");
  return metadataChunks[metadataChunks.length - 1]?.messageMetadata;
}

/** 本轮一个 output 类 chunk 都不该有——挂起的调用没有结果。 */
function expectNoOutputChunks(chunks: RunkoChunk[]): void {
  expect(chunksOfType(chunks, "tool-output-available")).toHaveLength(0);
  expect(chunksOfType(chunks, "tool-output-error")).toHaveLength(0);
  expect(chunksOfType(chunks, "tool-output-denied")).toHaveLength(0);
}

describe("SuspendSignal", () => {
  it("刻意不继承 Error——`catch (e) { if (e instanceof Error) … }` 这类写法会自然放过它", () => {
    const signal = new SuspendSignal("timeout");
    expect(signal instanceof Error).toBe(false);
    expect(isSuspendSignal(signal)).toBe(true);
    expect(signal.reason).toBe("timeout");
  });

  it("isSuspendSignal 不把普通 Error 当成挂起", () => {
    expect(isSuspendSignal(new Error("boom"))).toBe(false);
    expect(isSuspendSignal("timeout")).toBe(false);
    expect(isSuspendSignal(undefined)).toBe(false);
  });
});

describe("人审通道答 suspend", () => {
  function reviewScenario(tool: Tool, onReview: ApprovalReviewer) {
    const onApproval: ApprovalPolicy = () => "review";
    const model = twoStepModel([{ toolCallId: "call_1", toolName: "danger", input: "{}" }]);
    const messages: RunkoUIMessage[] = [userTextMessage("u1", "把 build 目录清掉")];
    return { messages, model, turnOpts: turnOptions(model, { messages, tools: { danger: tool }, onApproval, onReview }) };
  }

  it("那次调用原封不动留在账本里：部件仍是 approval-requested，带着完整入参", async () => {
    const execute = vi.fn(() => "不该执行");
    const tool: Tool = { description: "d", inputSchema: z.object({}), approval: "review", execute };
    const onReview = vi.fn(async (): Promise<HumanDecision> => ({ behavior: "suspend", reason: "timeout" }));
    const { messages, turnOpts } = reviewScenario(tool, onReview);

    const { chunks } = await drainTurn(runTurn(turnOpts));

    expect(onReview).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();

    const parts = allToolParts(messages);
    expect(parts).toHaveLength(1);
    expect(parts[0]?.state).toBe("approval-requested");
    expect(parts[0]?.input).toEqual({});

    // 请求 chunk 已经发过（界面要据它弹卡片），但**没有**响应——没人答过。
    expect(chunksOfType(chunks, "tool-approval-request")).toHaveLength(1);
    expect(chunksOfType(chunks, "tool-approval-response")).toHaveLength(0);
    expectNoOutputChunks(chunks);
  });

  it("这一轮以 suspended 收尾，metadata 带上悬着的 callId 与宿主给的理由", async () => {
    const tool: Tool = { description: "d", inputSchema: z.object({}), approval: "review", execute: () => "x" };
    const onReview = async (): Promise<HumanDecision> => ({ behavior: "suspend", reason: "timeout" });
    const { messages, turnOpts } = reviewScenario(tool, onReview);

    const { chunks } = await drainTurn(runTurn(turnOpts));

    const metadata = settleMetadata(chunks);
    expect(metadata?.status).toBe("suspended");
    expect(metadata?.suspended).toEqual({ callIds: ["call_1"], reason: "timeout" });
    expect(metadata?.error).toBeUndefined();
    // 收尾 metadata 落在账本最后一条 assistant 消息上（`finalizeTurn` 的不变量）。
    expect(lastAssistantMessage(messages)?.metadata?.status).toBe("suspended");
  });

  it("绝不进下一步：模型只被调用一次", async () => {
    const tool: Tool = { description: "d", inputSchema: z.object({}), approval: "review", execute: () => "x" };
    const onReview = async (): Promise<HumanDecision> => ({ behavior: "suspend" });
    const { messages, model, turnOpts } = reviewScenario(tool, onReview);

    await drainTurn(runTurn(turnOpts));

    expect(model.doStreamCalls).toHaveLength(1);
    // 第二步那句文本从未出现在账本里。
    expect(JSON.stringify(messages)).not.toContain("这一步不该被跑到");
  });

  it("reason 可以省——core 只透传，不自己编一个", async () => {
    const tool: Tool = { description: "d", inputSchema: z.object({}), approval: "review", execute: () => "x" };
    const onReview = async (): Promise<HumanDecision> => ({ behavior: "suspend" });
    const { turnOpts } = reviewScenario(tool, onReview);

    const { chunks } = await drainTurn(runTurn(turnOpts));

    expect(settleMetadata(chunks)?.suspended).toEqual({ callIds: ["call_1"] });
  });

  it("不动 once 记忆：挂起不是批准，人回来仍然要答", async () => {
    const onceMemory = createOnceApprovalMemory();
    const tool: Tool = { description: "d", inputSchema: z.object({}), approval: "review-once", execute: () => "x" };
    const onReview = async (): Promise<HumanDecision> => ({ behavior: "suspend" });
    const onApproval: ApprovalPolicy = () => "review";
    const model = twoStepModel([{ toolCallId: "call_1", toolName: "danger", input: "{}" }]);
    const messages: RunkoUIMessage[] = [userTextMessage("u1", "go")];

    await drainTurn(runTurn(turnOptions(model, { messages, tools: { danger: tool }, onApproval, onReview, onceMemory })));

    expect(onceMemory.hasApproved("danger")).toBe(false);
  });

  it("那条 timing 部件没有 completedAt——这次调用从未执行", async () => {
    const tool: Tool = { description: "d", inputSchema: z.object({}), approval: "review", execute: () => "x" };
    const onReview = async (): Promise<HumanDecision> => ({ behavior: "suspend" });
    const { messages, turnOpts } = reviewScenario(tool, onReview);

    await drainTurn(runTurn(turnOpts));

    const timing = toolTimingPartFor(messages, "call_1");
    expect(timing?.executionStartedAt).toBeUndefined();
    expect(timing?.completedAt).toBeUndefined();
  });
});

describe("工具自己调 ctx.suspend()", () => {
  it("部件停在 input-available（带着完整入参），本轮以 suspended 收尾", async () => {
    const tool: Tool = {
      description: "问用户",
      inputSchema: z.object({ question: z.string() }),
      execute: (_input, ctx) => ctx.suspend("timeout"),
    };
    const model = twoStepModel([{ toolCallId: "call_1", toolName: "ask", input: JSON.stringify({ question: "选哪个？" }) }]);
    const messages: RunkoUIMessage[] = [userTextMessage("u1", "帮我决定")];

    const { chunks } = await drainTurn(runTurn(turnOptions(model, { messages, tools: { ask: tool } })));

    const parts = allToolParts(messages);
    expect(parts).toHaveLength(1);
    expect(parts[0]?.state).toBe("input-available");
    expect(parts[0]?.input).toEqual({ question: "选哪个？" });

    expectNoOutputChunks(chunks);
    expect(settleMetadata(chunks)?.status).toBe("suspended");
    expect(settleMetadata(chunks)?.suspended).toEqual({ callIds: ["call_1"], reason: "timeout" });
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it("双保险：工具用 try/catch 把 SuspendSignal 吞掉、还返回了个值，本轮照样挂起且那个值不进账本", async () => {
    const tool: Tool = {
      description: "问用户",
      inputSchema: z.object({ question: z.string() }),
      execute: (_input, ctx) => {
        try {
          return ctx.suspend("timeout");
        } catch {
          // 工具作者很自然会写的兜底——它把控制流的信号吃掉了。
          return "问不到，先跳过";
        }
      },
    };
    const model = twoStepModel([{ toolCallId: "call_1", toolName: "ask", input: JSON.stringify({ question: "选哪个？" }) }]);
    const messages: RunkoUIMessage[] = [userTextMessage("u1", "帮我决定")];

    const { chunks } = await drainTurn(runTurn(turnOptions(model, { messages, tools: { ask: tool } })));

    // 判据是 ctx 上那个标记，不是有没有接到异常。
    expect(settleMetadata(chunks)?.status).toBe("suspended");
    expect(settleMetadata(chunks)?.suspended).toEqual({ callIds: ["call_1"], reason: "timeout" });
    expect(allToolParts(messages)[0]?.state).toBe("input-available");
    expectNoOutputChunks(chunks);
    // 那个垫场返回值一个字都不该落地。
    expect(JSON.stringify(messages)).not.toContain("问不到");
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it("outputSchema 不校验挂起——垫场返回值连校验都不该走到", async () => {
    const tool: Tool = {
      description: "问用户",
      inputSchema: z.object({ question: z.string() }),
      outputSchema: z.string(),
      execute: (_input, ctx) => {
        try {
          return ctx.suspend();
        } catch {
          return 42 as unknown as string; // 违反 outputSchema：若走了校验会变成 failed
        }
      },
    };
    const model = twoStepModel([{ toolCallId: "call_1", toolName: "ask", input: JSON.stringify({ question: "q" }) }]);
    const messages: RunkoUIMessage[] = [userTextMessage("u1", "go")];

    const { chunks } = await drainTurn(runTurn(turnOptions(model, { messages, tools: { ask: tool } })));

    expect(settleMetadata(chunks)?.status).toBe("suspended");
    expectNoOutputChunks(chunks);
  });

  it("一个工具真抛错（不是挂起）时仍然按 failed 处理，不被误当成挂起", async () => {
    const tool: Tool = {
      description: "会炸",
      inputSchema: z.object({}),
      execute: () => {
        throw new Error("disk on fire");
      },
    };
    const model = twoStepModel([{ toolCallId: "call_1", toolName: "boom", input: "{}" }]);
    const messages: RunkoUIMessage[] = [userTextMessage("u1", "go")];

    const { chunks } = await drainTurn(runTurn(turnOptions(model, { messages, tools: { boom: tool } })));

    expect(chunksOfType(chunks, "tool-output-error")).toHaveLength(1);
    expect(settleMetadata(chunks)?.status).not.toBe("suspended");
  });

  it("挂起之前工具已经改过的文件照常进账本——已发生的事实不回滚", async () => {
    const derivedData = createDerivedDataCollector();
    const tool: Tool = {
      description: "先改文件再等人",
      inputSchema: z.object({}),
      execute: (_input, ctx) => {
        derivedData.recordFileChange({ path: "/a.txt", kind: "update" });
        return ctx.suspend();
      },
    };
    const model = twoStepModel([{ toolCallId: "call_1", toolName: "edit", input: "{}" }]);
    const messages: RunkoUIMessage[] = [userTextMessage("u1", "go")];

    const { chunks } = await drainTurn(runTurn(turnOptions(model, { messages, tools: { edit: tool }, derivedData })));

    expect(settleMetadata(chunks)?.status).toBe("suspended");
    expect(chunksOfType(chunks, "data-file-change")).toHaveLength(1);
    const last = lastAssistantMessage(messages);
    expect(last === undefined ? [] : fileChangeParts(last)).toHaveLength(1);
  });
});

describe("一步里多个调用", () => {
  it("串行批：前一个执行完、后一个挂起——执行完那条的结果留在账本", async () => {
    const done: Tool = { description: "会跑完", inputSchema: z.object({}), execute: () => "第一个的结果" };
    const waiting: Tool = { description: "等人", inputSchema: z.object({}), execute: (_i, ctx) => ctx.suspend("timeout") };
    const model = twoStepModel([
      { toolCallId: "call_1", toolName: "done", input: "{}" },
      { toolCallId: "call_2", toolName: "waiting", input: "{}" },
    ]);
    const messages: RunkoUIMessage[] = [userTextMessage("u1", "go")];

    const { chunks } = await drainTurn(runTurn(turnOptions(model, { messages, tools: { done, waiting } })));

    // 第一个的结果照常落地。
    expect(chunksOfType(chunks, "tool-output-available")).toHaveLength(1);
    const parts = allToolParts(messages);
    expect(parts.find((part) => part.toolCallId === "call_1")?.state).toBe("output-available");
    // 第二个原样留着。
    expect(parts.find((part) => part.toolCallId === "call_2")?.state).toBe("input-available");
    expect(settleMetadata(chunks)?.suspended).toEqual({ callIds: ["call_2"], reason: "timeout" });
  });

  it("串行批：前一个挂起之后，后面的一个都不执行——否则人批准时，被批准的那个反而最后才跑", async () => {
    const executed = vi.fn(() => "第二个的结果");
    const waiting: Tool = { description: "等人", inputSchema: z.object({}), execute: (_i, ctx) => ctx.suspend() };
    const after: Tool = { description: "在它后面", inputSchema: z.object({}), execute: executed };
    const model = twoStepModel([
      { toolCallId: "call_1", toolName: "waiting", input: "{}" },
      { toolCallId: "call_2", toolName: "after", input: "{}" },
    ]);
    const messages: RunkoUIMessage[] = [userTextMessage("u1", "go")];

    const { chunks } = await drainTurn(runTurn(turnOptions(model, { messages, tools: { waiting, after } })));

    expect(executed).not.toHaveBeenCalled();
    // 不留成悬空调用：它有一个「没有执行」的结果，模型恢复之后看得到、需要的话再发一次。
    const skipped = allToolParts(messages).find((part) => part.toolCallId === "call_2");
    expect(skipped?.state).toBe("output-error");
    expect(skipped?.state === "output-error" ? skipped.errorText : "").toContain("Not run");
    expect(pendingCallIds(messages)).toEqual(["call_1"]);
    expect(settleMetadata(chunks)?.suspended).toEqual({ callIds: ["call_1"] });
  });

  it("两个都挂起（并行批，全只读）：callIds 按模型发出调用的顺序，两条都留着", async () => {
    const a: Tool = { description: "等人 a", inputSchema: z.object({}), readOnly: true, execute: (_i, ctx) => ctx.suspend("timeout") };
    const b: Tool = { description: "等人 b", inputSchema: z.object({}), readOnly: true, execute: (_i, ctx) => ctx.suspend("timeout") };
    const model = twoStepModel([
      { toolCallId: "call_1", toolName: "a", input: "{}" },
      { toolCallId: "call_2", toolName: "b", input: "{}" },
    ]);
    const messages: RunkoUIMessage[] = [userTextMessage("u1", "go")];

    const { chunks } = await drainTurn(runTurn(turnOptions(model, { messages, tools: { a, b } })));

    expect(settleMetadata(chunks)?.suspended).toEqual({ callIds: ["call_1", "call_2"], reason: "timeout" });
    const parts = allToolParts(messages);
    expect(parts.every((part) => part.state === "input-available")).toBe(true);
  });

  it("并行批（全只读）：callIds 仍按调用顺序，不随完成顺序飘", async () => {
    // b 先返回、a 后返回——若按完成顺序收集，callIds 会是 ["call_2", "call_1"]。
    const a: Tool = {
      description: "慢一点",
      inputSchema: z.object({}),
      readOnly: true,
      execute: async (_i, ctx) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return ctx.suspend("timeout");
      },
    };
    const b: Tool = { description: "快", inputSchema: z.object({}), readOnly: true, execute: (_i, ctx) => ctx.suspend("timeout") };
    const model = twoStepModel([
      { toolCallId: "call_1", toolName: "a", input: "{}" },
      { toolCallId: "call_2", toolName: "b", input: "{}" },
    ]);
    const messages: RunkoUIMessage[] = [userTextMessage("u1", "go")];

    const { chunks } = await drainTurn(runTurn(turnOptions(model, { messages, tools: { a, b } })));

    expect(settleMetadata(chunks)?.suspended).toEqual({ callIds: ["call_1", "call_2"], reason: "timeout" });
  });
});

describe("挂起与待发队列", () => {
  it("收尾路径不 drain steer 队列——排队的消息留给下一轮，与「停止」清空队列刻意不同", async () => {
    // 开步前（Checkpoint A）队列是空的；**等人期间**用户插了一句。挂起的收尾路径若也 drain，
    // 这条消息就被「取出来」了——而挂起那一轮不会再喂给模型，等于把它吞掉。
    const drainSteers = vi.fn<() => RunkoUIMessage[]>(() => []);
    const tool: Tool = {
      description: "等人",
      inputSchema: z.object({}),
      execute: (_i, ctx) => {
        drainSteers.mockReturnValue([userTextMessage("s1", "插一句")]);
        return ctx.suspend();
      },
    };
    const model = twoStepModel([{ toolCallId: "call_1", toolName: "ask", input: "{}" }]);
    const messages: RunkoUIMessage[] = [userTextMessage("u1", "go")];

    const { chunks } = await drainTurn(runTurn(turnOptions(model, { messages, tools: { ask: tool }, drainSteers })));

    expect(settleMetadata(chunks)?.status).toBe("suspended");
    // 只有开步前那一次；收尾路径上不再 drain。
    expect(drainSteers).toHaveBeenCalledTimes(1);
    // 那条插话还在队列里等下一轮，没被取进这一轮的账本。
    expect(JSON.stringify(messages)).not.toContain("插一句");
  });
});

describe("一步半路失败：没轮到执行的调用不能留成悬空", () => {
  // 模型已经吐出了一个 tool-call，流随后断掉。那次调用没执行、也不会再执行；留成悬空的话，
  // 下一轮会被当成「挂起、在等人」，而根本没有人能答它。
  it("流在 tool-call 之后断掉：那次调用得到「没有执行」的错误结果，账本里没有悬空调用", async () => {
    const executed = vi.fn(() => "不该执行");
    const danger: Tool = { description: "危险操作", inputSchema: z.object({}), execute: executed };
    const model = mockModel(() => ({
      doStream: () =>
        Promise.resolve({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({ type: "tool-call", toolCallId: "call_1", toolName: "danger", input: "{}" });
              // 隔一拍再断：SDK 解析 tool-call 是异步的，同一拍断掉的话错误会抢在它前面。
              setTimeout(() => {
                controller.error(new Error("connection reset"));
              }, 10);
            },
          }),
        }),
    }));
    const messages: RunkoUIMessage[] = [userTextMessage("u1", "go")];

    const { chunks } = await drainTurn(runTurn(turnOptions(model, { messages, tools: { danger } })));

    expect(settleMetadata(chunks)?.status).toBe("failed");
    expect(executed).not.toHaveBeenCalled();
    expect(pendingCallIds(messages)).toEqual([]);
    const part = allToolParts(messages).find((candidate) => candidate.toolCallId === "call_1");
    expect(part?.state).toBe("output-error");
    expect(chunksOfType(chunks, "tool-output-error").map((chunk) => chunk.toolCallId)).toEqual(["call_1"]);
  });
});
