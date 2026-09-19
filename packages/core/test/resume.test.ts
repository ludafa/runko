/**
 * 恢复（`Session.settleAndRun`）——设计见
 * docs/logic/orchestration/tech/suspend-resume.md §5。
 *
 * 每条用例都是**两个 session**：第一个跑到挂起、`toJSON()` 出来；第二个拿这份状态
 * `resume`，再 `settleAndRun`。这正是生产上的样子——挂起那一轮的进程早就退了，恢复发生在
 * 另一个进程（甚至另一台机器）上，中间只隔着一份账本。
 *
 * 最要紧的那条性质是 §5.2 的「用账本里原封不动的参数执行」，所以断言大多盯着两件事：
 * 工具**被怎么调用**、模型**看到了什么**。
 */
import { describe, expect, it, vi } from "vitest";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { fromMemory } from "@runko/virtual-fs";
import { defineAgent } from "../src/agent.js";
import { createSession } from "../src/session.js";
import type { SessionOptions } from "../src/session.js";
import { RunkoResumeError, pendingCallIds } from "../src/suspend.js";
import type { Settlement } from "../src/suspend.js";
import type { HumanDecision, Tool } from "../src/types.js";
import type { RunkoChunk, RunkoMessageMetadata, RunkoUIMessage, SessionState } from "../src/state.js";
import { allToolParts, chunksOfType, drainTurn } from "./helpers/runko-chunks.js";

function mockModel(buildOptions: () => ConstructorParameters<typeof MockLanguageModelV4>[0]): MockLanguageModelV4 {
  return new MockLanguageModelV4(buildOptions());
}

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
} as const;

function toolCallsStream(calls: { toolCallId: string; toolName: string; input: unknown }[]) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        ...calls.map((call) => ({ type: "tool-call" as const, toolCallId: call.toolCallId, toolName: call.toolName, input: JSON.stringify(call.input) })),
        { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: undefined }, usage },
      ],
      initialDelayInMs: null,
      chunkDelayInMs: null,
    }),
  };
}

function textStream(text: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "text-start" as const, id: "t1" },
        { type: "text-delta" as const, id: "t1", delta: text },
        { type: "text-end" as const, id: "t1" },
        { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage },
      ],
      initialDelayInMs: null,
      chunkDelayInMs: null,
    }),
  };
}

function settleMetadata(chunks: RunkoChunk[]): RunkoMessageMetadata | undefined {
  const metadataChunks = chunksOfType(chunks, "message-metadata");
  return metadataChunks[metadataChunks.length - 1]?.messageMetadata;
}

/** 模型第一次被调用时收到的对话，压成「角色:部件」的短串，方便看 tool_use 与 tool_result 是否配对。 */
function promptShape(model: MockLanguageModelV4): string[] {
  const prompt = model.doStreamCalls[0]?.prompt ?? [];
  return prompt
    .filter((message) => message.role !== "system")
    .map((message) => {
      if (typeof message.content === "string") {return `${message.role}:text`;}
      const parts = message.content.map((part) => ("toolCallId" in part ? `${part.type}(${part.toolCallId})` : part.type));
      return `${message.role}:${parts.join(",")}`;
    });
}

const suspendReviewer = async (): Promise<HumanDecision> => ({ behavior: "suspend", reason: "timeout" });

/** 第一个 session：模型发出这些调用，然后在等人处挂起。返回它的 `toJSON()`。 */
async function suspendedState(
  tools: Record<string, Tool>,
  calls: { toolCallId: string; toolName: string; input: unknown }[],
  opts: SessionOptions = {},
): Promise<SessionState> {
  const model = mockModel(() => ({ doStream: [toolCallsStream(calls), textStream("第一个 session 不该走到这一步")] }));
  const session = createSession(defineAgent({ model, tools }), { fs: fromMemory(), ...opts });
  const { chunks } = await drainTurn(session.stream("帮我清理构建产物"));
  expect(settleMetadata(chunks)?.status).toBe("suspended");
  return session.toJSON();
}

function approvalTool(execute: Tool["execute"], overrides: Partial<Tool> = {}): Tool {
  return { description: "危险操作", inputSchema: z.object({ cmd: z.string() }), approval: "review", execute, ...overrides };
}

const reviewOpts: SessionOptions = { onApproval: () => "review", onReview: suspendReviewer };

describe("approval / allow：用账本里原封不动的参数执行", () => {
  it("工具收到的就是挂起那一刻的入参；模型看到 tool_use 紧跟 tool_result", async () => {
    const execute = vi.fn<Tool["execute"]>(() => "删掉了 234MB");
    const state = await suspendedState({ danger: approvalTool(execute) }, [{ toolCallId: "call_1", toolName: "danger", input: { cmd: "rm -rf build" } }], reviewOpts);

    const model = mockModel(() => ({ doStream: [textStream("清理完了")] }));
    const session = createSession(defineAgent({ model, tools: { danger: approvalTool(execute) } }), { fs: fromMemory(), resume: state });
    const { chunks, result } = await drainTurn(session.settleAndRun("call_1", { kind: "approval", behavior: "allow" }));

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toEqual({ cmd: "rm -rf build" });
    expect(promptShape(model)).toEqual(["user:text", "assistant:tool-call(call_1)", "tool:tool-result(call_1)"]);
    expect(chunksOfType(chunks, "tool-approval-response")).toEqual([{ type: "tool-approval-response", approvalId: "call_1", approved: true }]);
    expect(chunksOfType(chunks, "tool-output-available")).toHaveLength(1);
    expect(settleMetadata(chunks)?.status).toBe("completed");
    expect(result.finalResponse).toBe("清理完了");
  });

  it("对抗：模型在恢复轮里想换个参数也换不了——执行发生在模型上场之前", async () => {
    const execute = vi.fn<Tool["execute"]>(() => "ok");
    const state = await suspendedState({ danger: approvalTool(execute) }, [{ toolCallId: "call_1", toolName: "danger", input: { cmd: "rm -rf build" } }], reviewOpts);

    // 恢复轮的模型一上来就想发一条更狠的命令。
    const order: string[] = [];
    execute.mockImplementation(() => {
      order.push("execute");
      return "ok";
    });
    const model = mockModel(() => ({
      doStream: async () => {
        order.push("model");
        return toolCallsStream([{ toolCallId: "call_2", toolName: "danger", input: { cmd: "rm -rf /" } }]);
      },
    }));
    // 恢复轮的新调用会重新走审批——这里不配人审通道，它就按无仲裁者拒绝。
    const session = createSession(defineAgent({ model, maxTurnsPerRun: 1, tools: { danger: approvalTool(execute) } }), {
      fs: fromMemory(),
      resume: state,
      onApproval: () => "review",
    });
    await drainTurn(session.settleAndRun("call_1", { kind: "approval", behavior: "allow" }));

    expect(order[0]).toBe("execute");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toEqual({ cmd: "rm -rf build" });
    expect(execute.mock.calls.some((call) => JSON.stringify(call[0]).includes("rm -rf /\""))).toBe(false);
  });

  it("不再走审批链——分类器在恢复轮里一次都不被问到", async () => {
    const execute = vi.fn<Tool["execute"]>(() => "ok");
    const state = await suspendedState({ danger: approvalTool(execute) }, [{ toolCallId: "call_1", toolName: "danger", input: { cmd: "rm -rf build" } }], reviewOpts);

    const onApproval = vi.fn(() => "review" as const);
    const onReview = vi.fn(suspendReviewer);
    const model = mockModel(() => ({ doStream: [textStream("done")] }));
    const session = createSession(defineAgent({ model, tools: { danger: approvalTool(execute) } }), { fs: fromMemory(), resume: state, onApproval, onReview });
    await drainTurn(session.settleAndRun("call_1", { kind: "approval", behavior: "allow" }));

    expect(onApproval).not.toHaveBeenCalled();
    expect(onReview).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("但会重新过 inputSchema：工具换了版本、不再接受旧参数时，记 output-error 而不是硬执行", async () => {
    const execute = vi.fn<Tool["execute"]>(() => "ok");
    const state = await suspendedState({ danger: approvalTool(execute) }, [{ toolCallId: "call_1", toolName: "danger", input: { cmd: "rm -rf build" } }], reviewOpts);

    // 新版工具要求多一个字段。
    const stricter = approvalTool(execute, { inputSchema: z.object({ cmd: z.string(), confirm: z.literal(true) }) });
    const model = mockModel(() => ({ doStream: [textStream("好的")] }));
    const session = createSession(defineAgent({ model, tools: { danger: stricter } }), { fs: fromMemory(), resume: state });
    const { chunks } = await drainTurn(session.settleAndRun("call_1", { kind: "approval", behavior: "allow" }));

    expect(execute).not.toHaveBeenCalled();
    expect(chunksOfType(chunks, "tool-output-error")).toHaveLength(1);
    const part = allToolParts(session.toJSON().messages).find((p) => p.toolCallId === "call_1");
    expect(part?.state).toBe("output-error");
  });

  it("工具已经不在工具表里：记 output-error，本轮照常往下走", async () => {
    const state = await suspendedState({ danger: approvalTool(() => "ok") }, [{ toolCallId: "call_1", toolName: "danger", input: { cmd: "x" } }], reviewOpts);

    const model = mockModel(() => ({ doStream: [textStream("那就算了")] }));
    const session = createSession(defineAgent({ model, tools: {} }), { fs: fromMemory(), resume: state });
    const { chunks } = await drainTurn(session.settleAndRun("call_1", { kind: "approval", behavior: "allow" }));

    expect(chunksOfType(chunks, "tool-output-error")).toHaveLength(1);
    expect(settleMetadata(chunks)?.status).toBe("completed");
  });

  it("执行时工具又挂起了：本轮直接以 suspended 收尾，不调模型", async () => {
    const state = await suspendedState({ danger: approvalTool(() => "x") }, [{ toolCallId: "call_1", toolName: "danger", input: { cmd: "x" } }], reviewOpts);

    const model = mockModel(() => ({ doStream: [textStream("不该走到")] }));
    const resuspending = approvalTool((_input, ctx) => ctx.suspend("needs-more-input"));
    const session = createSession(defineAgent({ model, tools: { danger: resuspending } }), { fs: fromMemory(), resume: state });
    const { chunks } = await drainTurn(session.settleAndRun("call_1", { kind: "approval", behavior: "allow" }));

    expect(model.doStreamCalls).toHaveLength(0);
    expect(settleMetadata(chunks)?.status).toBe("suspended");
    expect(settleMetadata(chunks)?.suspended).toEqual({ callIds: ["call_1"], reason: "needs-more-input" });
    // 审批已经通过、执行时又停下——部件停在 approval-responded，这正是第三种悬空状态。
    expect(allToolParts(session.toJSON().messages)[0]?.state).toBe("approval-responded");
  });
});

describe("approval / deny", () => {
  it("不执行，部件变成 output-denied，理由回填给模型", async () => {
    const execute = vi.fn<Tool["execute"]>(() => "不该执行");
    const state = await suspendedState({ danger: approvalTool(execute) }, [{ toolCallId: "call_1", toolName: "danger", input: { cmd: "rm -rf build" } }], reviewOpts);

    const model = mockModel(() => ({ doStream: [textStream("好的，不删了")] }));
    const session = createSession(defineAgent({ model, tools: { danger: approvalTool(execute) } }), { fs: fromMemory(), resume: state });
    const { chunks } = await drainTurn(session.settleAndRun("call_1", { kind: "approval", behavior: "deny", message: "别动 build，里面有我要的东西" }));

    expect(execute).not.toHaveBeenCalled();
    expect(chunksOfType(chunks, "tool-approval-response")).toEqual([
      { type: "tool-approval-response", approvalId: "call_1", approved: false, reason: "别动 build，里面有我要的东西" },
    ]);
    expect(chunksOfType(chunks, "tool-output-denied")).toHaveLength(1);
    expect(allToolParts(session.toJSON().messages)[0]?.state).toBe("output-denied");
    // 拒绝也算配对：模型看到的是一个完整的 tool_use → tool_result。
    expect(promptShape(model)).toEqual(["user:text", "assistant:tool-call(call_1)", "tool:tool-result(call_1)"]);
  });
});

describe("output：ctx.suspend() 挂起的调用，外部给的值就是它的输出", () => {
  const askTool = (overrides: Partial<Tool> = {}): Tool => ({
    description: "问用户",
    inputSchema: z.object({ question: z.string() }),
    execute: (_input, ctx) => ctx.suspend("timeout"),
    ...overrides,
  });

  it("部件变成 output-available，输出就是给的值；模型看到它", async () => {
    const state = await suspendedState({ ask: askTool() }, [{ toolCallId: "call_1", toolName: "ask", input: { question: "A 还是 B？" } }]);

    const model = mockModel(() => ({ doStream: [textStream("那就 B")] }));
    const session = createSession(defineAgent({ model, tools: { ask: askTool() } }), { fs: fromMemory(), resume: state });
    const { chunks } = await drainTurn(session.settleAndRun("call_1", { kind: "output", output: "选 B" }));

    expect(chunksOfType(chunks, "tool-output-available")).toEqual([{ type: "tool-output-available", toolCallId: "call_1", output: "选 B" }]);
    const part = allToolParts(session.toJSON().messages)[0];
    expect(part?.state).toBe("output-available");
    expect(part?.state === "output-available" ? part.output : undefined).toBe("选 B");
    expect(promptShape(model)).toEqual(["user:text", "assistant:tool-call(call_1)", "tool:tool-result(call_1)"]);
  });

  it("恢复时不重新执行工具——重新执行只会再问一遍", async () => {
    const execute = vi.fn<Tool["execute"]>((_input, ctx) => ctx.suspend());
    const state = await suspendedState({ ask: askTool({ execute }) }, [{ toolCallId: "call_1", toolName: "ask", input: { question: "q" } }]);
    execute.mockClear();

    const model = mockModel(() => ({ doStream: [textStream("ok")] }));
    const session = createSession(defineAgent({ model, tools: { ask: askTool({ execute }) } }), { fs: fromMemory(), resume: state });
    await drainTurn(session.settleAndRun("call_1", { kind: "output", output: "答案" }));

    expect(execute).not.toHaveBeenCalled();
  });

  it("声明了 outputSchema 就校验：给的值不合法记 output-error", async () => {
    const state = await suspendedState({ ask: askTool({ outputSchema: z.string() }) }, [{ toolCallId: "call_1", toolName: "ask", input: { question: "q" } }]);

    const model = mockModel(() => ({ doStream: [textStream("ok")] }));
    const session = createSession(defineAgent({ model, tools: { ask: askTool({ outputSchema: z.string() }) } }), { fs: fromMemory(), resume: state });
    const { chunks } = await drainTurn(session.settleAndRun("call_1", { kind: "output", output: 42 }));

    expect(chunksOfType(chunks, "tool-output-error")).toHaveLength(1);
    expect(allToolParts(session.toJSON().messages)[0]?.state).toBe("output-error");
  });

  it("审批通过之后才挂起的（approval-responded）：用 output 结清，并保留审批痕迹", async () => {
    // 第一个 session：人当场批准，执行时工具又要问人。
    const needsBoth = approvalTool((_input, ctx) => ctx.suspend("timeout"));
    const state = await suspendedState({ danger: needsBoth }, [{ toolCallId: "call_1", toolName: "danger", input: { cmd: "deploy" } }], {
      onApproval: () => "review",
      onReview: async () => ({ behavior: "allow" }),
    });
    expect(allToolParts(state.messages)[0]?.state).toBe("approval-responded");

    const model = mockModel(() => ({ doStream: [textStream("部署完了")] }));
    const session = createSession(defineAgent({ model, tools: { danger: needsBoth } }), { fs: fromMemory(), resume: state });
    await drainTurn(session.settleAndRun("call_1", { kind: "output", output: "确认部署到 prod" }));

    const part = allToolParts(session.toJSON().messages)[0];
    expect(part?.state).toBe("output-available");
    expect(part?.approval).toMatchObject({ id: "call_1", approved: true });
  });
});

describe("用错了就抛，不算一轮", () => {
  async function expectRejected(run: AsyncGenerator<RunkoChunk, unknown>, code: string): Promise<void> {
    const chunks: RunkoChunk[] = [];
    let caught: unknown;
    try {
      for await (const chunk of run) {chunks.push(chunk);}
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RunkoResumeError);
    expect(caught instanceof RunkoResumeError ? caught.code : undefined).toBe(code);
    expect(chunks).toHaveLength(0);
  }

  it("stream() 遇到悬空调用：拒绝开轮，模型一次都没被调用，轮号不动", async () => {
    const state = await suspendedState({ danger: approvalTool(() => "x") }, [{ toolCallId: "call_1", toolName: "danger", input: { cmd: "x" } }], reviewOpts);

    const model = mockModel(() => ({ doStream: [textStream("不该走到")] }));
    const session = createSession(defineAgent({ model, tools: { danger: approvalTool(() => "x") } }), { fs: fromMemory(), resume: state });
    await expectRejected(session.stream("顺便看看 README"), "pending_calls");

    expect(model.doStreamCalls).toHaveLength(0);
    expect(session.toJSON().turn).toBe(state.turn);
    expect(session.toJSON().messages).toHaveLength(state.messages.length);
  });

  it("callId 不存在：call_not_found", async () => {
    const state = await suspendedState({ danger: approvalTool(() => "x") }, [{ toolCallId: "call_1", toolName: "danger", input: { cmd: "x" } }], reviewOpts);
    const session = createSession(defineAgent({ model: mockModel(() => ({ doStream: [] })), tools: {} }), { fs: fromMemory(), resume: state });

    await expectRejected(session.settleAndRun("call_nope", { kind: "approval", behavior: "allow" }), "call_not_found");
    expect(session.toJSON().turn).toBe(state.turn);
  });

  it("重复恢复：第二次拿到 not_pending", async () => {
    const execute = vi.fn<Tool["execute"]>(() => "ok");
    const state = await suspendedState({ danger: approvalTool(execute) }, [{ toolCallId: "call_1", toolName: "danger", input: { cmd: "x" } }], reviewOpts);
    const model = mockModel(() => ({ doStream: [textStream("done")] }));
    const session = createSession(defineAgent({ model, tools: { danger: approvalTool(execute) } }), { fs: fromMemory(), resume: state });

    await drainTurn(session.settleAndRun("call_1", { kind: "approval", behavior: "allow" }));
    await expectRejected(session.settleAndRun("call_1", { kind: "approval", behavior: "allow" }), "not_pending");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each<[string, Settlement]>([
    ["审批挂起的给了 output", { kind: "output", output: "x" }],
  ])("种类对不上（%s）：settlement_mismatch", async (_label, settlement) => {
    const state = await suspendedState({ danger: approvalTool(() => "x") }, [{ toolCallId: "call_1", toolName: "danger", input: { cmd: "x" } }], reviewOpts);
    const session = createSession(defineAgent({ model: mockModel(() => ({ doStream: [] })), tools: {} }), { fs: fromMemory(), resume: state });
    await expectRejected(session.settleAndRun("call_1", settlement), "settlement_mismatch");
  });

  it("种类对不上（ctx.suspend 挂起的给了 approval）：settlement_mismatch", async () => {
    const ask: Tool = { description: "问", inputSchema: z.object({}), execute: (_i, ctx) => ctx.suspend() };
    const state = await suspendedState({ ask }, [{ toolCallId: "call_1", toolName: "ask", input: {} }]);
    const session = createSession(defineAgent({ model: mockModel(() => ({ doStream: [] })), tools: {} }), { fs: fromMemory(), resume: state });
    await expectRejected(session.settleAndRun("call_1", { kind: "approval", behavior: "allow" }), "settlement_mismatch");
  });
});

describe("同一条消息里有多个悬空调用", () => {
  // 只读：两个调用同时在等人，只有并行批里才会出现（串行批里第一个挂起之后，后面的不执行）。
  const ask: Tool = { description: "问", inputSchema: z.object({ q: z.string() }), readOnly: true, execute: (_i, ctx) => ctx.suspend("timeout") };

  it("恢复一个之后还有剩的：不调模型，suspended.callIds 只剩另一个；再恢复另一个才调模型", async () => {
    const state = await suspendedState({ ask }, [
      { toolCallId: "call_1", toolName: "ask", input: { q: "一" } },
      { toolCallId: "call_2", toolName: "ask", input: { q: "二" } },
    ]);
    expect(pendingCallIds(state.messages)).toEqual(["call_1", "call_2"]);

    const model = mockModel(() => ({ doStream: [textStream("两个都答了")] }));
    const session = createSession(defineAgent({ model, tools: { ask } }), { fs: fromMemory(), resume: state });

    const first = await drainTurn(session.settleAndRun("call_1", { kind: "output", output: "答一" }));
    expect(model.doStreamCalls).toHaveLength(0);
    expect(settleMetadata(first.chunks)?.status).toBe("suspended");
    // 理由沿用上一轮挂起时记下的。
    expect(settleMetadata(first.chunks)?.suspended).toEqual({ callIds: ["call_2"], reason: "timeout" });
    expect(pendingCallIds(session.toJSON().messages)).toEqual(["call_2"]);

    const second = await drainTurn(session.settleAndRun("call_2", { kind: "output", output: "答二" }));
    expect(model.doStreamCalls).toHaveLength(1);
    expect(settleMetadata(second.chunks)?.status).toBe("completed");
    expect(promptShape(model)).toEqual(["user:text", "assistant:tool-call(call_1),tool-call(call_2)", "tool:tool-result(call_1),tool-result(call_2)"]);
  });
});

describe("落账本的契约：原地改写开轮时的最后一条", () => {
  it("被改写的那条 id 不变、仍在原位置；本轮新增的消息跟在它后面", async () => {
    const state = await suspendedState({ danger: approvalTool(() => "ok") }, [{ toolCallId: "call_1", toolName: "danger", input: { cmd: "x" } }], reviewOpts);
    const suspendedMessage = state.messages[state.messages.length - 1];

    const model = mockModel(() => ({ doStream: [textStream("done")] }));
    const session = createSession(defineAgent({ model, tools: { danger: approvalTool(() => "ok") } }), { fs: fromMemory(), resume: state });
    await drainTurn(session.settleAndRun("call_1", { kind: "approval", behavior: "allow" }));

    const after = session.toJSON();
    const revised = after.messages[state.messages.length - 1];
    expect(revised?.id).toBe(suspendedMessage?.id);
    expect(allToolParts(revised === undefined ? [] : [revised])[0]?.state).toBe("output-available");
    // 恢复轮新增了一条模型的回复。
    expect(after.messages).toHaveLength(state.messages.length + 1);
    expect(after.turn).toBe(state.turn + 1);
  });

  it("挂起那一轮的 metadata 留在原消息上，恢复轮的收尾写在新消息上——界面上是两条轮记录", async () => {
    const state = await suspendedState({ danger: approvalTool(() => "ok") }, [{ toolCallId: "call_1", toolName: "danger", input: { cmd: "x" } }], reviewOpts);

    const model = mockModel(() => ({ doStream: [textStream("done")] }));
    const session = createSession(defineAgent({ model, tools: { danger: approvalTool(() => "ok") } }), { fs: fromMemory(), resume: state });
    await drainTurn(session.settleAndRun("call_1", { kind: "approval", behavior: "allow" }));

    const messages = session.toJSON().messages;
    expect(messages[messages.length - 2]?.metadata).toMatchObject({ status: "suspended", turn: state.turn });
    expect(messages[messages.length - 1]?.metadata).toMatchObject({ status: "completed", turn: state.turn + 1 });
  });
});

describe("轮统计不骗人", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("durationMs 不含等人的时间；toolDurationMs 只含恢复时执行的那一段", async () => {
    const state = await suspendedState({ danger: approvalTool(() => "x") }, [{ toolCallId: "call_1", toolName: "danger", input: { cmd: "x" } }], reviewOpts);
    await sleep(120); // 人去开了个会

    const slow = approvalTool(async () => {
      await sleep(30);
      return "ok";
    });
    const model = mockModel(() => ({ doStream: [textStream("done")] }));
    const session = createSession(defineAgent({ model, tools: { danger: slow } }), { fs: fromMemory(), resume: state });
    const { chunks } = await drainTurn(session.settleAndRun("call_1", { kind: "approval", behavior: "allow" }));

    const metadata = settleMetadata(chunks);
    expect(metadata?.durationMs).toBeLessThan(120);
    expect(metadata?.toolDurationMs).toBeGreaterThanOrEqual(25);
  });

  it("ctx.suspend() 挂起的调用：等人的时间哪一轮都不算执行时长", async () => {
    const ask: Tool = { description: "问", inputSchema: z.object({}), execute: (_i, ctx) => ctx.suspend() };
    const state = await suspendedState({ ask }, [{ toolCallId: "call_1", toolName: "ask", input: {} }]);
    await sleep(60);

    const model = mockModel(() => ({ doStream: [textStream("ok")] }));
    const session = createSession(defineAgent({ model, tools: { ask } }), { fs: fromMemory(), resume: state });
    const { chunks } = await drainTurn(session.settleAndRun("call_1", { kind: "output", output: "答案" }));

    expect(settleMetadata(chunks)?.toolDurationMs).toBe(0);
  });
});

describe("send()：挂起的一轮要说得出口", () => {
  const ask: Tool = { description: "问", inputSchema: z.object({}), execute: (_i, ctx) => ctx.suspend("timeout") };

  it("不带 outputSchema：返回值带着 suspended，调用方知道这一轮没做完", async () => {
    const model = mockModel(() => ({ doStream: [toolCallsStream([{ toolCallId: "call_1", toolName: "ask", input: {} }])] }));
    const session = createSession(defineAgent({ model, tools: { ask } }), { fs: fromMemory() });
    const result = await session.send("go");
    expect(result.suspended).toEqual({ callIds: ["call_1"], reason: "timeout" });
  });

  it("带 outputSchema：不拿悬空的历史去调模型，直接抛 pending_calls", async () => {
    const model = mockModel(() => ({ doStream: [toolCallsStream([{ toolCallId: "call_1", toolName: "ask", input: {} }])] }));
    const session = createSession(defineAgent({ model, tools: { ask } }), { fs: fromMemory() });
    await expect(session.send("go", { outputSchema: z.object({ answer: z.string() }) })).rejects.toMatchObject({
      name: "RunkoResumeError",
      code: "pending_calls",
    });
    // 只调过一次模型（那一步 tool-call）；结构化输出那次没发出去。
    expect(model.doStreamCalls).toHaveLength(1);
  });
});

describe("恢复轮在调模型之前就收尾：上一轮的 suspended 不能留下", () => {
  it("结清之后在检查点 0 被停止：收尾是 interrupted，metadata 里没有自相矛盾的 suspended", async () => {
    const state = await suspendedState({ danger: approvalTool(() => "ok") }, [{ toolCallId: "call_1", toolName: "danger", input: { cmd: "x" } }], reviewOpts);
    const model = mockModel(() => ({ doStream: [textStream("不该走到")] }));
    const session = createSession(defineAgent({ model, tools: { danger: approvalTool(() => "ok") } }), { fs: fromMemory(), resume: state });
    const controller = new AbortController();
    controller.abort();

    await drainTurn(session.settleAndRun("call_1", { kind: "approval", behavior: "deny" }, { signal: controller.signal }));

    const last = session.toJSON().messages.at(-1);
    expect(last?.metadata?.status).toBe("interrupted");
    expect(last?.metadata !== undefined && "suspended" in last.metadata).toBe(false);
    expect(model.doStreamCalls).toHaveLength(0);
  });
});

describe("pendingCallIds：被拒的中间态不算悬空", () => {
  it("approval-responded 只有批准了才算——被拒的不会再执行，算了会让会话卡死", () => {
    const message = (approved: boolean): RunkoUIMessage => ({
      id: "a1",
      role: "assistant",
      parts: [{ type: "tool-bash", toolCallId: "call_1", state: "approval-responded", input: {}, approval: { id: "call_1", approved } }],
    });
    expect(pendingCallIds([message(true)])).toEqual(["call_1"]);
    expect(pendingCallIds([message(false)])).toEqual([]);
  });
});
