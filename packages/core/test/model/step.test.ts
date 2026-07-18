import { describe, expect, it, vi } from "vitest";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { runStep } from "../../src/model/step.js";
import type { StepEvent, StepResult } from "../../src/model/step.js";
import type { Tool as NimboTool } from "../../src/types.js";

/**
 * `LanguageModelV4StreamPart` (the chunk shape `simulateReadableStream` needs
 * here) lives in `@ai-sdk/provider`, a transitive dependency of `ai` that
 * `@nimbo/core` does not declare directly — pnpm's strict linking correctly
 * keeps it unresolvable by name from this package. Deriving the options type
 * via `ConstructorParameters<typeof MockLanguageModelV4>` instead of
 * importing it lets each call site's inline options literal keep full
 * contextual typing (discriminated `type` literals stay narrow, e.g.
 * `"text-delta"` instead of widening to `string`) without reaching for an
 * undeclared module. Every test therefore builds its model via
 * `mockModel(() => ({ doStream: async () => ({ stream: simulateReadableStream({ chunks: [...] }) }) }))`
 * rather than a `mockModel(chunks)` helper — passing the whole options
 * object inline (via a callback, so it is constructed at the call site) is
 * what keeps the chunk literals narrow; routing them through an
 * intermediate `chunks` parameter would widen `type` to `string` and fail
 * to structurally match the discriminated union.
 */
function mockModel(buildOptions: () => ConstructorParameters<typeof MockLanguageModelV4>[0]): MockLanguageModelV4 {
  return new MockLanguageModelV4(buildOptions());
}

async function drain(
  gen: AsyncGenerator<StepEvent, StepResult>,
): Promise<{ events: StepEvent[]; result: StepResult }> {
  const events: StepEvent[] = [];
  let next = await gen.next();
  while (!next.done) {
    events.push(next.value);
    next = await gen.next();
  }
  return { events, result: next.value };
}

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
} as const;

describe("runStep", () => {
  it("maps a text-only stream to a StepEvent sequence (text-delta only, boundary markers dropped)", async () => {
    const model = mockModel(() => ({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "Hello, " },
            { type: "text-delta", id: "t1", delta: "world!" },
            { type: "text-end", id: "t1" },
            { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      }),
    }));

    const { events, result } = await drain(runStep({ model, messages: [{ role: "user", content: "hi" }] }));

    expect(events).toEqual<StepEvent[]>([
      { type: "text-delta", id: "t1", text: "Hello, " },
      { type: "text-delta", id: "t1", text: "world!" },
    ]);
    expect(result.finishReason).toBe("stop");
    expect(result.toolCalls).toEqual([]);
  });

  it("maps a reasoning-only stream to a StepEvent sequence (reasoning-delta only)", async () => {
    const model = mockModel(() => ({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "reasoning-start", id: "r1" },
            { type: "reasoning-delta", id: "r1", delta: "Let me think" },
            { type: "reasoning-delta", id: "r1", delta: " step by step." },
            { type: "reasoning-end", id: "r1" },
            { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      }),
    }));

    const { events, result } = await drain(runStep({ model, messages: [{ role: "user", content: "hi" }] }));

    expect(events).toEqual<StepEvent[]>([
      { type: "reasoning-delta", id: "r1", text: "Let me think" },
      { type: "reasoning-delta", id: "r1", text: " step by step." },
    ]);
    expect(result.finishReason).toBe("stop");
  });

  it("maps a tool-call stream: tool-input-delta chunks stream-aggregate into a fully parsed tool-call StepEvent", async () => {
    const readFile: NimboTool = {
      description: "reads a file",
      inputSchema: z.object({ path: z.string() }),
      execute: vi.fn(() => {
        throw new Error("must not be called — AI SDK must not auto-execute an execute-less tool");
      }),
    };

    const model = mockModel(() => ({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "tool-input-start", id: "call_1", toolName: "read-file" },
            { type: "tool-input-delta", id: "call_1", delta: '{"pa' },
            { type: "tool-input-delta", id: "call_1", delta: 'th":"a.' },
            { type: "tool-input-delta", id: "call_1", delta: 'txt"}' },
            { type: "tool-input-end", id: "call_1" },
            { type: "tool-call", toolCallId: "call_1", toolName: "read-file", input: '{"path":"a.txt"}' },
            { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      }),
    }));

    const { events, result } = await drain(
      runStep({ model, messages: [{ role: "user", content: "read a.txt" }], tools: { "read-file": readFile } }),
    );

    expect(events).toEqual<StepEvent[]>([
      { type: "tool-input-delta", id: "call_1", delta: '{"pa' },
      { type: "tool-input-delta", id: "call_1", delta: 'th":"a.' },
      { type: "tool-input-delta", id: "call_1", delta: 'txt"}' },
      { type: "tool-call", id: "call_1", toolName: "read-file", input: { path: "a.txt" } },
    ]);

    expect(result.finishReason).toBe("tool-calls");
    expect(result.toolCalls).toEqual([{ id: "call_1", toolName: "read-file", input: { path: "a.txt" } }]);
    expect(readFile.execute).not.toHaveBeenCalled();
  });

  it("omits execute from the converted tool passed to streamText (so the SDK cannot auto-execute)", async () => {
    const readFile: NimboTool = {
      description: "reads a file",
      inputSchema: z.object({ path: z.string() }),
      execute: () => "unused",
    };
    const model = mockModel(() => ({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      }),
    }));

    await drain(runStep({ model, messages: [{ role: "user", content: "hi" }], tools: { "read-file": readFile } }));

    const toolsSentToModel = model.doStreamCalls[0]?.tools;
    const readFileToolSent = toolsSentToModel?.find((t) => t.type === "function" && t.name === "read-file");
    expect(readFileToolSent).toBeDefined();
  });

  it("resolves finishReason: 'stop' with no tool calls when the model stops without calling a tool", async () => {
    const model = mockModel(() => ({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "done" },
            { type: "text-end", id: "t1" },
            { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      }),
    }));

    const { result } = await drain(runStep({ model, messages: [{ role: "user", content: "hi" }] }));

    expect(result.finishReason).toBe("stop");
    expect(result.toolCalls).toEqual([]);
  });

  it("resolves finishReason: 'tool-calls' with the tool call returned unexecuted", async () => {
    const searchTool: NimboTool = {
      description: "search",
      inputSchema: z.object({ query: z.string() }),
      execute: vi.fn(() => "unused"),
    };
    const model = mockModel(() => ({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "tool-call", toolCallId: "call_9", toolName: "search", input: '{"query":"nimbo"}' },
            { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      }),
    }));

    const { result } = await drain(
      runStep({ model, messages: [{ role: "user", content: "hi" }], tools: { search: searchTool } }),
    );

    expect(result.finishReason).toBe("tool-calls");
    expect(result.toolCalls).toEqual([{ id: "call_9", toolName: "search", input: { query: "nimbo" } }]);
    expect(searchTool.execute).not.toHaveBeenCalled();
  });

  it("extracts usage token counts reported by the model into StepResult.usage", async () => {
    const model = mockModel(() => ({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "hi" },
            { type: "text-end", id: "t1" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: undefined },
              usage: {
                inputTokens: { total: 42, noCache: 42, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: 7, text: 7, reasoning: undefined },
              },
            },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      }),
    }));

    const { result } = await drain(runStep({ model, messages: [{ role: "user", content: "hi" }] }));

    expect(result.usage.inputTokens).toBe(42);
    expect(result.usage.outputTokens).toBe(7);
  });

  it("propagates abort: an already-aborted signal rejects the step instead of yielding a StepResult", async () => {
    const model = mockModel(() => ({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "hi" },
            { type: "text-end", id: "t1" },
            { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      }),
    }));
    const controller = new AbortController();
    const abortReason = new Error("boom");
    controller.abort(abortReason);

    await expect(
      drain(runStep({ model, messages: [{ role: "user", content: "hi" }], abortSignal: controller.signal })),
    ).rejects.toThrow("boom");
  });

  it("passes system/maxOutputTokens through to the underlying model call", async () => {
    const model = mockModel(() => ({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      }),
    }));

    await drain(
      runStep({
        model,
        system: "be helpful",
        messages: [{ role: "user", content: "hi" }],
        maxOutputTokens: 123,
      }),
    );

    expect(model.doStreamCalls[0]?.maxOutputTokens).toBe(123);
    expect(model.doStreamCalls[0]?.prompt[0]).toMatchObject({ role: "system", content: "be helpful" });
  });

  it("runs with no tools configured (tools omitted entirely)", async () => {
    const model = mockModel(() => ({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      }),
    }));

    const { events, result } = await drain(runStep({ model, messages: [{ role: "user", content: "hi" }] }));

    expect(events).toEqual([]);
    expect(result.finishReason).toBe("stop");
    expect(model.doStreamCalls[0]?.tools).toBeUndefined();
  });
});
