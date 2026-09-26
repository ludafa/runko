/**
 * [交权](../../../docs/terms.md)在 core 这一层的行为（docs/logic/orchestration/tech/handover.md §6）。
 *
 * | 交权那一刻 | 这一轮怎么收尾 | 接手的一方怎么接 |
 * |---|---|---|
 * | 模型正在输出 | 掐断、这半步整个扔掉 | `continueTurn()` 从账本接着调模型 |
 * | 工具正在跑 | 工具**不停**，带着悬空调用收尾 | 拿到结果后 `settleAndRun(callId, outcome)` |
 * | 两步之间 | 直接收尾 | `continueTurn()` |
 *
 * 另有两条与交权配套的：结清「执行过但失败了」的结果（`Settlement.kind === "error"`），以及工具最长执行时间。
 */
import { describe, expect, it, vi } from "vitest";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { fromMemory } from "@runko/virtual-fs";
import { defineAgent } from "../src/agent.js";
import { createSession } from "../src/session.js";
import { RunkoResumeError, pendingCallIds } from "../src/suspend.js";
import type { Tool } from "../src/types.js";
import type { RunkoChunk, RunkoMessageMetadata } from "../src/state.js";
import { allToolParts, chunksOfType, drainTurn } from "./helpers/runko-chunks.js";

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

function textStream(text: string, chunkDelayInMs: number | null = null) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "text-start" as const, id: "t1" },
        ...[...text].map((ch) => ({ type: "text-delta" as const, id: "t1", delta: ch })),
        { type: "text-end" as const, id: "t1" },
        { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage },
      ],
      initialDelayInMs: null,
      chunkDelayInMs,
    }),
  };
}

function settleMetadata(chunks: RunkoChunk[]): RunkoMessageMetadata | undefined {
  const metadataChunks = chunksOfType(chunks, "message-metadata");
  return metadataChunks[metadataChunks.length - 1]?.messageMetadata;
}

/** 一个可以从外面控制何时结束的工具——模拟「交权那一刻它还在跑」。 */
function controllableTool() {
  let finish: (output: string) => void = () => undefined;
  const execute = vi.fn<Tool["execute"]>();
  const started = new Promise<void>((markStarted) => {
    execute.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
          markStarted();
        }),
    );
  });
  const tool: Tool = { description: "慢命令", inputSchema: z.object({ cmd: z.string() }), execute };
  return { tool, execute, started, finish: (output: string) => finish(output) };
}

describe("工具段交权：工具不停，这一轮带着悬空调用收尾", () => {
  it("收尾状态是 handed-over，调用停在 input-available，第二步没被跑到，工具的结果交给调用方", async () => {
    const slow = controllableTool();
    const model = new MockLanguageModelV4({
      doStream: [toolCallsStream([{ toolCallId: "call_1", toolName: "bash", input: { cmd: "sleep 90" } }]), textStream("不该跑到")],
    });
    const session = createSession(defineAgent({ model, tools: { bash: slow.tool } }), { fs: fromMemory() });
    const handover = new AbortController();

    const turn = drainTurn(session.stream("跑那条命令", { handover: handover.signal }));
    await slow.started;
    handover.abort();
    const { chunks, result } = await turn;

    expect(settleMetadata(chunks)).toMatchObject({ status: "handed-over", handedOver: { callIds: ["call_1"] } });
    expect(model.doStreamCalls).toHaveLength(1);
    expect(pendingCallIds(session.toJSON().messages)).toEqual(["call_1"]);
    expect(allToolParts(session.toJSON().messages).map((part) => part.state)).toEqual(["input-available"]);
    expect(chunksOfType(chunks, "tool-output-available")).toHaveLength(0);

    // 工具还在跑：跑完的结果由调用方拿走，不进这一轮。
    expect(result.handedOver?.callIds).toEqual(["call_1"]);
    const running = result.handedOver?.running[0];
    expect(running?.toolName).toBe("bash");
    slow.finish("done after handover");
    await expect(running?.outcome).resolves.toEqual({ kind: "output", output: "done after handover" });
  });

  it("接手的一方用结果 settleAndRun，就像恢复一样接着跑", async () => {
    const slow = controllableTool();
    const first = new MockLanguageModelV4({
      doStream: [toolCallsStream([{ toolCallId: "call_1", toolName: "bash", input: { cmd: "make" } }])],
    });
    const oldNode = createSession(defineAgent({ model: first, tools: { bash: slow.tool } }), { fs: fromMemory() });
    const handover = new AbortController();
    const turn = drainTurn(oldNode.stream("构建一下", { handover: handover.signal }));
    await slow.started;
    handover.abort();
    const { result } = await turn;
    slow.finish("build ok");
    const outcome = await result.handedOver?.running[0]?.outcome;
    if (outcome === undefined) {throw new Error("expected a running call");}

    const second = new MockLanguageModelV4({ doStream: [textStream("构建完成")] });
    const newNode = createSession(defineAgent({ model: second, tools: { bash: slow.tool } }), { fs: fromMemory(), resume: oldNode.toJSON() });
    const { chunks } = await drainTurn(newNode.settleAndRun("call_1", outcome));

    expect(settleMetadata(chunks)?.status).toBe("completed");
    expect(allToolParts(newNode.toJSON().messages).map((part) => part.state)).toEqual(["output-available"]);
    expect(slow.execute).toHaveBeenCalledTimes(1); // 新节点没有再执行一次
  });

  it("串行批里排在它后面的调用不执行，给模型一个说明", async () => {
    const slow = controllableTool();
    const after = vi.fn<Tool["execute"]>(() => "不该执行");
    const model = new MockLanguageModelV4({
      doStream: [
        toolCallsStream([
          { toolCallId: "call_1", toolName: "bash", input: { cmd: "a" } },
          { toolCallId: "call_2", toolName: "write", input: {} },
        ]),
      ],
    });
    const session = createSession(
      defineAgent({ model, tools: { bash: slow.tool, write: { description: "w", inputSchema: z.object({}), execute: after } } }),
      { fs: fromMemory() },
    );
    const handover = new AbortController();
    const turn = drainTurn(session.stream("两件事", { handover: handover.signal }));
    await slow.started;
    handover.abort();
    const { chunks } = await turn;

    expect(after).not.toHaveBeenCalled();
    expect(pendingCallIds(session.toJSON().messages)).toEqual(["call_1"]);
    const errors = chunksOfType(chunks, "tool-output-error");
    expect(errors.map((chunk) => chunk.toolCallId)).toEqual(["call_2"]);
    expect(errors[0]?.errorText).toContain("still running when this conversation moved to another server");
  });
});

describe("模型输出段交权：掐断、这半步整个扔掉", () => {
  it("账本回到这一步开始之前，接手的一方 continueTurn 从同一份历史重新生成", async () => {
    const model = new MockLanguageModelV4({ doStream: [textStream("一段会被掐断的很长很长的回答", 30)] });
    const session = createSession(defineAgent({ model }), { fs: fromMemory() });
    const handover = new AbortController();
    const chunks: RunkoChunk[] = [];
    const gen = session.stream("讲个故事", { handover: handover.signal });
    let step = await gen.next();
    while (!step.done) {
      chunks.push(step.value);
      // 第一个字出来就交权。
      if (step.value.type === "text-delta") {handover.abort();}
      step = await gen.next();
    }

    expect(settleMetadata(chunks)).toMatchObject({ status: "handed-over", handedOver: { callIds: [] } });
    expect(step.value.handedOver).toEqual({ callIds: [], running: [] });
    // 账本：用户消息 + 一条只带收尾 metadata 的占位（没有任何文字）。
    const messages = session.toJSON().messages;
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.parts).toEqual([{ type: "step-start" }]);

    const next = new MockLanguageModelV4({ doStream: [textStream("完整的故事")] });
    const taker = createSession(defineAgent({ model: next }), { fs: fromMemory(), resume: session.toJSON() });
    const resumed = await drainTurn(taker.continueTurn());
    expect(settleMetadata(resumed.chunks)?.status).toBe("completed");
    // 模型看到的历史里没有半截输出：只有那条用户消息。
    const prompt = next.doStreamCalls[0]?.prompt.filter((message) => message.role !== "system") ?? [];
    expect(prompt.map((message) => message.role)).toEqual(["user"]);
  });
});

describe("两步之间交权", () => {
  it("一开轮信号就已经到了：一次模型都不调，直接以 handed-over 收尾", async () => {
    const model = new MockLanguageModelV4({ doStream: [textStream("不该跑到")] });
    const session = createSession(defineAgent({ model }), { fs: fromMemory() });
    const handover = new AbortController();
    handover.abort();
    const { chunks, result } = await drainTurn(session.stream("你好", { handover: handover.signal }));
    expect(model.doStreamCalls).toHaveLength(0);
    expect(settleMetadata(chunks)?.status).toBe("handed-over");
    expect(result.handedOver?.running).toEqual([]);
  });

  it("continueTurn 在有悬空调用时拒绝开轮", async () => {
    const slow = controllableTool();
    const model = new MockLanguageModelV4({ doStream: [toolCallsStream([{ toolCallId: "call_1", toolName: "bash", input: { cmd: "x" } }])] });
    const session = createSession(defineAgent({ model, tools: { bash: slow.tool } }), { fs: fromMemory() });
    const handover = new AbortController();
    const turn = drainTurn(session.stream("x", { handover: handover.signal }));
    await slow.started;
    handover.abort();
    await turn;
    await expect(session.continueTurn().next()).rejects.toBeInstanceOf(RunkoResumeError);
  });
});

describe("Settlement.kind === \"error\"：执行过但失败了", () => {
  it("结清成 output-error，错误文本交给模型", async () => {
    const slow = controllableTool();
    const model = new MockLanguageModelV4({ doStream: [toolCallsStream([{ toolCallId: "call_1", toolName: "bash", input: { cmd: "x" } }])] });
    const session = createSession(defineAgent({ model, tools: { bash: slow.tool } }), { fs: fromMemory() });
    const handover = new AbortController();
    const turn = drainTurn(session.stream("x", { handover: handover.signal }));
    await slow.started;
    handover.abort();
    await turn;

    const next = new MockLanguageModelV4({ doStream: [textStream("知道了")] });
    const taker = createSession(defineAgent({ model: next, tools: { bash: slow.tool } }), { fs: fromMemory(), resume: session.toJSON() });
    const { chunks } = await drainTurn(taker.settleAndRun("call_1", { kind: "error", errorText: "the node running this tool went offline; result unknown" }));
    expect(chunksOfType(chunks, "tool-output-error")[0]?.errorText).toBe("the node running this tool went offline; result unknown");
    expect(settleMetadata(chunks)?.status).toBe("completed");
  });
});

describe("工具最长执行时间", () => {
  it("到点 abort 工具；工具据此失败收手时，结果说清是超时", async () => {
    const execute = vi.fn<Tool["execute"]>(
      (_input, ctx) =>
        new Promise<string>((_resolve, reject) => {
          ctx.abortSignal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    );
    const model = new MockLanguageModelV4({
      doStream: [toolCallsStream([{ toolCallId: "call_1", toolName: "bash", input: { cmd: "sleep 999" } }]), textStream("好")],
    });
    const session = createSession(defineAgent({ model, tools: { bash: { description: "b", inputSchema: z.object({ cmd: z.string() }), execute } } }), {
      fs: fromMemory(),
      toolTimeoutMs: 50,
    });
    const { chunks } = await drainTurn(session.stream("跑"));
    const error = chunksOfType(chunks, "tool-output-error")[0];
    expect(error?.errorText).toContain("exceeded the maximum execution time (50ms)");
    expect(settleMetadata(chunks)?.status).toBe("completed");
  });

  it("工具不理 abort 时，宽限期到了就不等了", async () => {
    const execute = vi.fn<Tool["execute"]>(() => new Promise<string>(() => undefined));
    const model = new MockLanguageModelV4({
      doStream: [toolCallsStream([{ toolCallId: "call_1", toolName: "bash", input: { cmd: "hang" } }]), textStream("好")],
    });
    const session = createSession(defineAgent({ model, tools: { bash: { description: "b", inputSchema: z.object({ cmd: z.string() }), execute } } }), {
      fs: fromMemory(),
      toolTimeoutMs: 20,
    });
    const startedAt = Date.now();
    const { chunks } = await drainTurn(session.stream("跑"));
    expect(chunksOfType(chunks, "tool-output-error")[0]?.errorText).toContain("exceeded the maximum execution time");
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
});

describe("代码审查返工：交权与工具时限的边角", () => {
  it("等人的工具（waitsForPerson）不受工具最长执行时间约束", async () => {
    const execute = vi.fn<Tool["execute"]>(() => new Promise<string>((resolve) => setTimeout(() => resolve("答案来了"), 80)));
    const model = new MockLanguageModelV4({
      doStream: [toolCallsStream([{ toolCallId: "q1", toolName: "ask", input: {} }]), textStream("好")],
    });
    const ask: Tool = { description: "问人", inputSchema: z.object({}), waitsForPerson: true, execute };
    const session = createSession(defineAgent({ model, tools: { ask } }), { fs: fromMemory(), toolTimeoutMs: 20 });
    const { chunks } = await drainTurn(session.stream("问一下"));
    expect(chunksOfType(chunks, "tool-output-error")).toHaveLength(0);
    expect(chunksOfType(chunks, "tool-output-available")[0]?.output).toBe("答案来了");
  });

  it("等人的工具在交权时不被交出去：等它（由宿主让它挂起）", async () => {
    let answer: (value: string) => void = () => undefined;
    const ask: Tool = {
      description: "问人",
      inputSchema: z.object({}),
      waitsForPerson: true,
      execute: () => new Promise<string>((resolve) => { answer = resolve; }),
    };
    const model = new MockLanguageModelV4({ doStream: [toolCallsStream([{ toolCallId: "q1", toolName: "ask", input: {} }]), textStream("好")] });
    const session = createSession(defineAgent({ model, tools: { ask } }), { fs: fromMemory() });
    const handover = new AbortController();
    const turn = drainTurn(session.stream("问一下", { handover: handover.signal }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    handover.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    answer("已答");
    const { chunks, result } = await turn;
    // 工具没被交出去：等到人答了、正常结清，到下一步的边界上才交权（没有还在跑的调用）。
    expect(result.handedOver?.running).toEqual([]);
    expect(chunksOfType(chunks, "tool-output-available")[0]?.output).toBe("已答");
  });

  it("插话之后再交权：交权标记落在账本最后一条上（另起占位），不并到上一步那条", async () => {
    const slow = controllableTool();
    const model = new MockLanguageModelV4({
      doStream: [toolCallsStream([{ toolCallId: "call_1", toolName: "bash", input: { cmd: "x" } }]), textStream("第二步很长很长的输出", 30)],
    });
    const session = createSession(defineAgent({ model, tools: { bash: slow.tool } }), { fs: fromMemory() });
    const handover = new AbortController();
    const gen = session.stream("开始", { handover: handover.signal });
    const turn = (async () => {
      let step = await gen.next();
      while (!step.done) {
        if (step.value.type === "text-delta") {handover.abort();}
        step = await gen.next();
      }
    })();
    await slow.started;
    expect(session.steer("顺便说一句")).toBe(true);
    slow.finish("ok");
    await turn;
    const messages = session.toJSON().messages;
    expect(messages.at(-2)?.role).toBe("user");
    expect(messages.at(-1)).toMatchObject({ role: "assistant", parts: [{ type: "step-start" }], metadata: { status: "handed-over" } });
  });

  it("超时 abort 之后工具在宽限期里真跑完了：用真结果，不改写成「已终止」", async () => {
    const execute = vi.fn<Tool["execute"]>(
      (_input, ctx) =>
        new Promise<string>((resolve) => {
          ctx.abortSignal?.addEventListener("abort", () => {
            setTimeout(() => resolve("真的做完了"), 10);
          });
        }),
    );
    const model = new MockLanguageModelV4({ doStream: [toolCallsStream([{ toolCallId: "c1", toolName: "bash", input: { cmd: "x" } }]), textStream("好")] });
    const session = createSession(defineAgent({ model, tools: { bash: { description: "b", inputSchema: z.object({ cmd: z.string() }), execute } } }), {
      fs: fromMemory(),
      toolTimeoutMs: 20,
    });
    const { chunks } = await drainTurn(session.stream("跑"));
    expect(chunksOfType(chunks, "tool-output-available")[0]?.output).toBe("真的做完了");
  });

  it("用户已经按了停止（中止信号在前）：正在跑的工具不交出去，照停止收尾", async () => {
    const slow = controllableTool();
    const model = new MockLanguageModelV4({ doStream: [toolCallsStream([{ toolCallId: "c1", toolName: "bash", input: { cmd: "x" } }])] });
    const session = createSession(defineAgent({ model, tools: { bash: slow.tool } }), { fs: fromMemory() });
    const abort = new AbortController();
    const handover = new AbortController();
    const turn = drainTurn(session.stream("跑", { signal: abort.signal, handover: handover.signal }));
    await slow.started;
    abort.abort(new Error("stopped"));
    handover.abort();
    slow.finish("killed");
    const { chunks, result } = await turn;
    expect(result.handedOver).toBeUndefined();
    expect(settleMetadata(chunks)?.status).toBe("interrupted");
  });

  it("并行的几个工具收尾一起结清：settleAndRun 带 alsoSettle，一轮里全部结清再调模型", async () => {
    const a = controllableTool();
    const b = controllableTool();
    a.tool.readOnly = true;
    b.tool.readOnly = true;
    const model = new MockLanguageModelV4({
      doStream: [toolCallsStream([{ toolCallId: "k1", toolName: "a", input: { cmd: "1" } }, { toolCallId: "k2", toolName: "b", input: { cmd: "2" } }])],
    });
    const oldNode = createSession(defineAgent({ model, tools: { a: a.tool, b: b.tool } }), { fs: fromMemory() });
    const handover = new AbortController();
    const turn = drainTurn(oldNode.stream("并行", { handover: handover.signal }));
    await Promise.all([a.started, b.started]);
    handover.abort();
    const { result } = await turn;
    expect(result.handedOver?.callIds.sort()).toEqual(["k1", "k2"]);

    const next = new MockLanguageModelV4({ doStream: [textStream("都好了")] });
    const taker = createSession(defineAgent({ model: next, tools: { a: a.tool, b: b.tool } }), { fs: fromMemory(), resume: oldNode.toJSON() });
    const { chunks } = await drainTurn(
      taker.settleAndRun("k1", { kind: "output", output: "one" }, { alsoSettle: [{ callId: "k2", outcome: { kind: "output", output: "two" } }] }),
    );
    expect(settleMetadata(chunks)?.status).toBe("completed");
    expect(next.doStreamCalls).toHaveLength(1);
    expect(pendingCallIds(taker.toJSON().messages)).toEqual([]);
  });
});
