import { describe, expect, it, vi } from "vitest";
import { simulateReadableStream } from "ai";
import type { ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { runTurn } from "../src/loop.js";
import type { RunTurnOptions } from "../src/loop.js";
import { createOnceApprovalMemory } from "../src/approval.js";
import { createDerivedDataCollector } from "../src/runtime.js";
import { createPlanStore, createUpdatePlanTool } from "../src/tools/builtin/update-plan.js";
import type { ApprovalPolicy, NimboFS, Tool } from "../src/types.js";
import type { NimboError, SessionEvent, SessionItem } from "../src/events.js";
import type { TurnResult } from "../src/session.js";

/**
 * Same helper shape as `model/step.test.ts` (see that file's header comment for why
 * `mockModel` takes a callback rather than a `chunks` array parameter — the callback
 * form keeps each chunk literal's discriminated `type` field narrow).
 */
function mockModel(buildOptions: () => ConstructorParameters<typeof MockLanguageModelV4>[0]): MockLanguageModelV4 {
  return new MockLanguageModelV4(buildOptions());
}

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
} as const;

function fakeFs(): NimboFS {
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
    onceMemory: createOnceApprovalMemory(),
    derivedData: createDerivedDataCollector(),
    ...overrides,
  };
}

async function drainTurn(gen: AsyncGenerator<SessionEvent, TurnResult>): Promise<{ events: SessionEvent[]; result: TurnResult }> {
  const events: SessionEvent[] = [];
  let next = await gen.next();
  while (!next.done) {
    events.push(next.value);
    next = await gen.next();
  }
  return { events, result: next.value };
}

// ---- narrow, assertion-free event/item extraction helpers ----

function isItemStarted(event: SessionEvent): event is { type: "item.started"; item: SessionItem } {
  return event.type === "item.started";
}
function isItemCompleted(event: SessionEvent): event is { type: "item.completed"; item: SessionItem } {
  return event.type === "item.completed";
}
function isTurnFailed(event: SessionEvent): event is { type: "turn.failed"; error: NimboError } {
  return event.type === "turn.failed";
}
function isTurnCompleted(event: SessionEvent): event is { type: "turn.completed"; usage: TurnResult["usage"] } {
  return event.type === "turn.completed";
}
function isToolCallItem(item: SessionItem): item is Extract<SessionItem, { type: "tool_call" }> {
  return item.type === "tool_call";
}
function isAgentMessageItem(item: SessionItem): item is Extract<SessionItem, { type: "agent_message" }> {
  return item.type === "agent_message";
}
function isReasoningItem(item: SessionItem): item is Extract<SessionItem, { type: "reasoning" }> {
  return item.type === "reasoning";
}
function isPlanUpdateItem(item: SessionItem): item is Extract<SessionItem, { type: "plan_update" }> {
  return item.type === "plan_update";
}

function completedItemsOf<T extends SessionItem>(events: SessionEvent[], guard: (item: SessionItem) => item is T): T[] {
  return events.filter(isItemCompleted).map((e) => e.item).filter(guard);
}
function startedItemsOf<T extends SessionItem>(events: SessionEvent[], guard: (item: SessionItem) => item is T): T[] {
  return events.filter(isItemStarted).map((e) => e.item).filter(guard);
}

function toolResultMessage(messages: ModelMessage[]): Extract<ModelMessage, { role: "tool" }> | undefined {
  return messages.find((m): m is Extract<ModelMessage, { role: "tool" }> => m.role === "tool");
}

describe("runTurn", () => {
  it("multi-step tool-use: step 1 tool-calls (update_plan) executed & backfilled as role:tool, step 2 stop", async () => {
    const store = createPlanStore();
    const derivedData = createDerivedDataCollector();
    const tool = createUpdatePlanTool({ store, onPlanUpdate: (items) => derivedData.recordPlanUpdate(items) });

    const model = mockModel(() => ({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              {
                type: "tool-call",
                toolCallId: "call_1",
                toolName: "update_plan",
                input: JSON.stringify({ items: [{ text: "write tests", completed: false }] }),
              },
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
              { type: "text-delta", id: "t1", delta: "done" },
              { type: "text-end", id: "t1" },
              { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
            ],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        },
      ],
    }));

    const messages: ModelMessage[] = [{ role: "user", content: "please plan" }];
    const { events, result } = await drainTurn(
      runTurn(turnOptions(model, { messages, tools: { update_plan: tool }, derivedData })),
    );

    const startedToolCalls = startedItemsOf(events, isToolCallItem);
    expect(startedToolCalls).toEqual([
      { id: startedToolCalls[0]?.id, type: "tool_call", toolName: "update_plan", input: { items: [{ text: "write tests", completed: false }] }, status: "in_progress" },
    ]);

    const completedToolCalls = completedItemsOf(events, isToolCallItem);
    expect(completedToolCalls).toHaveLength(1);
    expect(completedToolCalls[0]?.status).toBe("completed");
    expect(completedToolCalls[0]?.id).toBe(startedToolCalls[0]?.id);

    const planItems = completedItemsOf(events, isPlanUpdateItem);
    expect(planItems).toEqual([{ id: planItems[0]?.id, type: "plan_update", items: [{ text: "write tests", completed: false }] }]);

    expect(result.finalResponse).toBe("done");
    expect(store.getItems()).toEqual([{ text: "write tests", completed: false }]);

    const toolMessage = toolResultMessage(messages);
    expect(toolMessage).toBeDefined();
    expect(toolMessage?.content).toEqual([
      {
        type: "tool-result",
        toolCallId: "call_1",
        toolName: "update_plan",
        output: { type: "text", value: expect.stringContaining("Plan updated") },
      },
    ]);

    expect(events.some(isTurnCompleted)).toBe(true);
    expect(model.doStreamCalls).toHaveLength(2);
  });

  it("agent_message increments: item.started on the first chunk, item.updated per chunk, item.completed with the full text", async () => {
    const model = mockModel(() => ({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "Hello, " },
            { type: "text-delta", id: "t1", delta: "world" },
            { type: "text-delta", id: "t1", delta: "!" },
            { type: "text-end", id: "t1" },
            { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      },
    }));

    const messages: ModelMessage[] = [{ role: "user", content: "hi" }];
    const { events } = await drainTurn(runTurn(turnOptions(model, { messages })));

    const agentMessageEvents = events.filter(
      (e): e is { type: "item.started" | "item.updated" | "item.completed"; item: SessionItem } =>
        (e.type === "item.started" || e.type === "item.updated" || e.type === "item.completed") &&
        isAgentMessageItem(e.item),
    );
    const texts = agentMessageEvents.map((e) => (isAgentMessageItem(e.item) ? e.item.text : ""));
    expect(texts).toEqual(["Hello, ", "Hello, world", "Hello, world!", "Hello, world!"]);
    expect(agentMessageEvents.map((e) => e.type)).toEqual(["item.started", "item.updated", "item.updated", "item.completed"]);
  });

  it("reasoning-delta accumulates the same way as text-delta, under a distinct item type", async () => {
    const model = mockModel(() => ({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "reasoning-start", id: "r1" },
            { type: "reasoning-delta", id: "r1", delta: "step 1. " },
            { type: "reasoning-delta", id: "r1", delta: "step 2." },
            { type: "reasoning-end", id: "r1" },
            { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      },
    }));

    const messages: ModelMessage[] = [{ role: "user", content: "hi" }];
    const { events, result } = await drainTurn(runTurn(turnOptions(model, { messages })));

    const completedReasoning = completedItemsOf(events, isReasoningItem);
    expect(completedReasoning).toEqual([{ id: completedReasoning[0]?.id, type: "reasoning", text: "step 1. step 2." }]);
    // reasoning text doesn't count toward finalResponse (that's agent_message-only)
    expect(result.finalResponse).toBe("");
  });

  it("denied tool call ('always' + session onApproval deny): item is denied and the model sees the rejection reason", async () => {
    const execute = vi.fn(() => "should not run");
    const tool: Tool = { description: "d", inputSchema: z.object({}), approval: "always", execute };
    const onApproval: ApprovalPolicy = () => ({ behavior: "deny", message: "not allowed in prod" });

    const model = mockModel(() => ({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "tool-call", toolCallId: "call_1", toolName: "danger", input: "{}" },
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
              { type: "text-delta", id: "t1", delta: "ok, skipping" },
              { type: "text-end", id: "t1" },
              { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
            ],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        },
      ],
    }));

    const messages: ModelMessage[] = [{ role: "user", content: "do the dangerous thing" }];
    const { events } = await drainTurn(runTurn(turnOptions(model, { messages, tools: { danger: tool }, onApproval })));

    const completed = completedItemsOf(events, isToolCallItem);
    expect(completed).toEqual([{ id: completed[0]?.id, type: "tool_call", toolName: "danger", input: {}, output: "not allowed in prod", status: "denied" }]);
    expect(execute).not.toHaveBeenCalled();

    const toolMessage = toolResultMessage(messages);
    expect(toolMessage?.content).toEqual([
      { type: "tool-result", toolCallId: "call_1", toolName: "danger", output: { type: "execution-denied", reason: "not allowed in prod" } },
    ]);
  });

  it("allows via the default 'never' policy without consulting onApproval", async () => {
    const execute = vi.fn(() => "ok");
    const tool: Tool = { description: "d", inputSchema: z.object({}), execute };
    const onApproval = vi.fn();

    const model = mockModel(() => ({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "tool-call", toolCallId: "call_1", toolName: "safe", input: "{}" },
              { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
            ],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [{ type: "stream-start", warnings: [] }, { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage }],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        },
      ],
    }));

    const messages: ModelMessage[] = [{ role: "user", content: "go" }];
    const { events } = await drainTurn(runTurn(turnOptions(model, { messages, tools: { safe: tool }, onApproval })));

    expect(completedItemsOf(events, isToolCallItem)[0]?.status).toBe("completed");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(onApproval).not.toHaveBeenCalled();
  });

  it("'once' approval memory persists across steps within the same turn (onApproval asked only once)", async () => {
    const execute = vi.fn(() => "ok");
    const tool: Tool = { description: "d", inputSchema: z.object({}), approval: "once", execute };
    const onApproval = vi.fn(() => ({ behavior: "allow" as const }));

    const model = mockModel(() => ({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "tool-call", toolCallId: "call_1", toolName: "gated", input: "{}" },
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
              { type: "tool-call", toolCallId: "call_2", toolName: "gated", input: "{}" },
              { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
            ],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [{ type: "stream-start", warnings: [] }, { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage }],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        },
      ],
    }));

    const messages: ModelMessage[] = [{ role: "user", content: "go" }];
    const { events } = await drainTurn(runTurn(turnOptions(model, { messages, tools: { gated: tool }, onApproval })));

    expect(completedItemsOf(events, isToolCallItem).map((item) => item.status)).toEqual(["completed", "completed"]);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(onApproval).toHaveBeenCalledTimes(1);
  });

  it("unknown tool name (hallucinated call): fails gracefully with a guidance message, doesn't crash the loop", async () => {
    const model = mockModel(() => ({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "tool-call", toolCallId: "call_1", toolName: "does_not_exist", input: "{}" },
              { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
            ],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [{ type: "stream-start", warnings: [] }, { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage }],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        },
      ],
    }));

    const messages: ModelMessage[] = [{ role: "user", content: "go" }];
    const { events, result } = await drainTurn(runTurn(turnOptions(model, { messages, tools: {} })));

    const completed = completedItemsOf(events, isToolCallItem);
    expect(completed[0]?.status).toBe("failed");
    expect(typeof completed[0]?.output === "string" ? completed[0]?.output : "").toContain("does_not_exist");
    expect(events.some(isTurnCompleted)).toBe(true);
    expect(result.items).toContainEqual(completed[0]);
  });

  it("abort: an already-aborted signal ends the turn with turn.failed/aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop now"));

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

    const messages: ModelMessage[] = [{ role: "user", content: "hi" }];
    const { events } = await drainTurn(runTurn(turnOptions(model, { messages, signal: controller.signal })));

    const failed = events.find(isTurnFailed);
    expect(failed?.error.code).toBe("aborted");
  });

  it("provider error (not abort-related): turn.failed/provider_error carries the underlying message", async () => {
    const model = mockModel(() => ({
      doStream: async () => {
        throw new Error("network exploded");
      },
    }));

    const messages: ModelMessage[] = [{ role: "user", content: "hi" }];
    const { events } = await drainTurn(runTurn(turnOptions(model, { messages })));

    const failed = events.find(isTurnFailed);
    expect(failed?.error.code).toBe("provider_error");
    // AI SDK's retry layer re-wraps a synchronous doStream throw (its own message doesn't
    // necessarily survive verbatim) — assert the failure surfaced as a non-empty message
    // rather than pin to `ai`'s internal wording, which isn't nimbo's contract to test.
    expect(typeof failed?.error.message).toBe("string");
    expect(failed?.error.message.length).toBeGreaterThan(0);
  });

  it("maxTurnsPerRun: the last allowed step's tool calls still execute to completion, then turn.failed/max_turns", async () => {
    const tool: Tool = { description: "d", inputSchema: z.object({}), execute: () => "ok" };

    const model = mockModel(() => ({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "tool-call", toolCallId: "call_1", toolName: "loop_tool", input: "{}" },
              { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
            ],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        },
      ],
    }));

    const messages: ModelMessage[] = [{ role: "user", content: "go forever" }];
    const { events } = await drainTurn(runTurn(turnOptions(model, { messages, tools: { loop_tool: tool }, maxTurnsPerRun: 1 })));

    expect(completedItemsOf(events, isToolCallItem)[0]?.status).toBe("completed");
    const failed = events.find(isTurnFailed);
    expect(failed?.error.code).toBe("max_turns");
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it("context_overflow: fails before ever calling the model when the estimate already exceeds maxContextTokens", async () => {
    const doStream = vi.fn(() => {
      throw new Error("must not be called — context already exceeds maxContextTokens");
    });
    const model = mockModel(() => ({ doStream }));

    const messages: ModelMessage[] = [{ role: "user", content: "x".repeat(1000) }];
    const { events } = await drainTurn(runTurn(turnOptions(model, { messages, maxContextTokens: 1 })));

    const failed = events.find(isTurnFailed);
    expect(failed?.error.code).toBe("context_overflow");
    expect(doStream).not.toHaveBeenCalled();
  });

  it("does not check context when maxContextTokens is left undefined (opt-in)", async () => {
    const model = mockModel(() => ({
      doStream: {
        stream: simulateReadableStream({
          chunks: [{ type: "stream-start", warnings: [] }, { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage }],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      },
    }));

    const messages: ModelMessage[] = [{ role: "user", content: "x".repeat(1000) }];
    const { events } = await drainTurn(runTurn(turnOptions(model, { messages, maxContextTokens: undefined })));

    expect(events.some(isTurnFailed)).toBe(false);
    expect(events.some(isTurnCompleted)).toBe(true);
  });

  it("maxTurnsPerRun <= 0 leaves no steps to run: turn.failed/max_turns without ever calling the model", async () => {
    const model = mockModel(() => ({
      doStream: vi.fn(() => {
        throw new Error("must not be called — zero step budget");
      }),
    }));

    const messages: ModelMessage[] = [{ role: "user", content: "go" }];
    const { events } = await drainTurn(runTurn(turnOptions(model, { messages, maxTurnsPerRun: 0 })));

    const failed = events.find(isTurnFailed);
    expect(failed?.error.code).toBe("max_turns");
    expect(model.doStreamCalls).toHaveLength(0);
  });

  it("context estimate stays within budget across steps: calibration from step 1's usage doesn't false-positive on step 2", async () => {
    const tool: Tool = { description: "d", inputSchema: z.object({}), execute: () => "ok" };

    const model = mockModel(() => ({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "tool-call", toolCallId: "call_1", toolName: "t", input: "{}" },
              { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
            ],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [{ type: "stream-start", warnings: [] }, { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage }],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        },
      ],
    }));

    const messages: ModelMessage[] = [{ role: "user", content: "go" }];
    const { events } = await drainTurn(runTurn(turnOptions(model, { messages, tools: { t: tool }, maxContextTokens: 100_000 })));

    expect(events.some(isTurnFailed)).toBe(false);
    expect(events.some(isTurnCompleted)).toBe(true);
    expect(model.doStreamCalls).toHaveLength(2);
  });

  it("ctx.update() progress ticks replay as accumulating item.updated events before the final item.completed", async () => {
    const tool: Tool = {
      description: "d",
      inputSchema: z.object({}),
      execute: async (_input, ctx) => {
        ctx.update("step 1... ");
        ctx.update("step 2... ");
        ctx.update("done.");
        return "final result";
      },
    };

    const model = mockModel(() => ({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "tool-call", toolCallId: "call_1", toolName: "slow_tool", input: "{}" },
              { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
            ],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [{ type: "stream-start", warnings: [] }, { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage }],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        },
      ],
    }));

    const messages: ModelMessage[] = [{ role: "user", content: "go slowly" }];
    const { events } = await drainTurn(runTurn(turnOptions(model, { messages, tools: { slow_tool: tool } })));

    const toolCallUpdates = events.filter(
      (e): e is { type: "item.updated"; item: SessionItem } => e.type === "item.updated" && isToolCallItem(e.item),
    );
    expect(toolCallUpdates.map((e) => (isToolCallItem(e.item) ? e.item.output : undefined))).toEqual([
      "step 1... ",
      "step 1... step 2... ",
      "step 1... step 2... done.",
    ]);
    expect(toolCallUpdates.every((e) => isToolCallItem(e.item) && e.item.status === "in_progress")).toBe(true);

    const completed = completedItemsOf(events, isToolCallItem);
    expect(completed[0]?.output).toBe("final result");
    expect(completed[0]?.status).toBe("completed");
  });

  it("StepEvent 'tool-input-delta' chunks are consumed without independently driving item events (see file header)", async () => {
    const model = mockModel(() => ({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "tool-input-start", id: "call_1", toolName: "search" },
            { type: "tool-input-delta", id: "call_1", delta: '{"q":' },
            { type: "tool-input-delta", id: "call_1", delta: '"nimbo"}' },
            { type: "tool-input-end", id: "call_1" },
            { type: "tool-call", toolCallId: "call_1", toolName: "search", input: '{"q":"nimbo"}' },
            { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      },
    }));

    const tool: Tool = { description: "d", inputSchema: z.object({ q: z.string() }), execute: () => "ok" };
    const messages: ModelMessage[] = [{ role: "user", content: "search" }];
    const { events } = await drainTurn(runTurn(turnOptions(model, { messages, tools: { search: tool }, maxTurnsPerRun: 1 })));

    // exactly one item.started for the tool_call (the deltas produced none), with the fully
    // parsed input from the terminal tool-call event.
    const started = startedItemsOf(events, isToolCallItem);
    expect(started).toHaveLength(1);
    expect(started[0]?.input).toEqual({ q: "nimbo" });
  });

  it("aggregates usage across steps into TurnResult.usage / turn.completed", async () => {
    const tool: Tool = { description: "d", inputSchema: z.object({}), execute: () => "ok" };

    const model = mockModel(() => ({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "tool-call", toolCallId: "call_1", toolName: "t", input: "{}" },
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: undefined },
                usage: { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } },
              },
            ],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: undefined },
                usage: { inputTokens: { total: 20, noCache: 20, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 3, text: 3, reasoning: undefined } },
              },
            ],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        },
      ],
    }));

    const messages: ModelMessage[] = [{ role: "user", content: "go" }];
    const { events, result } = await drainTurn(runTurn(turnOptions(model, { messages, tools: { t: tool } })));

    // `LanguageModelUsage.totalTokens` is computed by the AI SDK per step (input+output for
    // that step) even though the raw mock usage chunks here only supply input/output — the two
    // per-step totals (15 and 23) sum to 38, which `mergeUsage` then aggregates like the other fields.
    expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 8, totalTokens: 38 });
    const completedTurn = events.find(isTurnCompleted);
    expect(completedTurn?.usage).toEqual(result.usage);
  });
});
