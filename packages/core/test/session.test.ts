import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { defineAgent } from "../src/agent.js";
import { createSession, NimboSessionError } from "../src/session.js";
import type { Session, SessionOptions } from "../src/session.js";
import type { AgentDefinition } from "../src/agent.js";
import type { SessionEvent, SessionItem } from "../src/events.js";
import type { Tool } from "../src/types.js";

/** Same shape as `loop.test.ts`/`model/step.test.ts` — see those files for why the callback form. */
function mockModel(buildOptions: () => ConstructorParameters<typeof MockLanguageModelV4>[0]): MockLanguageModelV4 {
  return new MockLanguageModelV4(buildOptions());
}

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
} as const;

function stopModel(text: string): MockLanguageModelV4 {
  return mockModel(() => ({
    doStream: {
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: text },
          { type: "text-end", id: "t1" },
          { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
        ],
        initialDelayInMs: null,
        chunkDelayInMs: null,
      }),
    },
  }));
}

function toolCallThenStopModel(toolName: string, input: unknown, stopText: string): MockLanguageModelV4 {
  return mockModel(() => ({
    doStream: [
      {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "tool-call", toolCallId: "call_1", toolName, input: JSON.stringify(input) },
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
            { type: "text-delta", id: "t1", delta: stopText },
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

/**
 * `doStream` as a function (not a static object) so each call gets a *fresh*
 * `simulateReadableStream` — a `ReadableStream` can only be consumed once, and a static
 * object would silently hand the second call an already-drained stream (surfaces as AI
 * SDK's "No output generated" rather than the tool-calls response the test expects).
 */
function alwaysToolCallsModel(toolName: string): MockLanguageModelV4 {
  return mockModel(() => ({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "tool-call", toolCallId: "call_1", toolName, input: "{}" },
          { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
        ],
        initialDelayInMs: null,
        chunkDelayInMs: null,
      }),
    }),
  }));
}

function baseAgent(model: MockLanguageModelV4, overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return defineAgent({ model, ...overrides });
}

async function drainStream(gen: AsyncGenerator<SessionEvent, unknown>): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  let next = await gen.next();
  while (!next.done) {
    events.push(next.value);
    next = await gen.next();
  }
  return events;
}

function isItemCompleted(event: SessionEvent): event is { type: "item.completed"; item: SessionItem } {
  return event.type === "item.completed";
}
function isToolCallItem(item: SessionItem): item is Extract<SessionItem, { type: "tool_call" }> {
  return item.type === "tool_call";
}

describe("createSession", () => {
  it("emits session.started only on the very first stream()/send() call, not on later ones", async () => {
    const session = createSession(baseAgent(stopModel("first")));

    const firstEvents = await drainStream(session.stream("hello"));
    expect(firstEvents[0]).toEqual({ type: "session.started", sessionId: session.id });
    expect(firstEvents[1]).toEqual({ type: "turn.started", turn: 1 });

    // second call needs its own doStream response — build a fresh session sharing config instead of
    // reusing the same one-shot mock, since MockLanguageModelV4's array cycles by call count already
    // used up in the first stream(); wire a second-call response by re-creating the mock inline here.
    const secondModel = mockModel(() => ({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [{ type: "stream-start", warnings: [] }, { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage }],
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
    const twoTurnSession = createSession(baseAgent(secondModel));
    const firstTurnEvents = await drainStream(twoTurnSession.stream("one"));
    const secondTurnEvents = await drainStream(twoTurnSession.stream("two"));

    expect(firstTurnEvents[0]).toEqual({ type: "session.started", sessionId: twoTurnSession.id });
    expect(secondTurnEvents.some((e) => e.type === "session.started")).toBe(false);
    expect(secondTurnEvents[0]).toEqual({ type: "turn.started", turn: 2 });
  });

  it("send()/stream() consistency: a stream()'s own TurnResult.items equals its buffered item.completed items (send() is just this return value)", async () => {
    const session = createSession(baseAgent(toolCallThenStopModel("update_plan", { items: [{ text: "a", completed: false }] }, "done")));

    const gen = session.stream("plan it");
    const events: SessionEvent[] = [];
    let next = await gen.next();
    while (!next.done) {
      events.push(next.value);
      next = await gen.next();
    }
    const turnResult = next.value;
    const bufferedItems = events.filter(isItemCompleted).map((e) => e.item);

    expect(turnResult.items).toEqual(bufferedItems);

    // an independent session's send() over an equivalent turn lands on the same shape
    // (module the random per-turn item ids, which aren't part of the consistency contract).
    const sendSession = createSession(baseAgent(toolCallThenStopModel("update_plan", { items: [{ text: "a", completed: false }] }, "done")));
    const sendResult = await sendSession.send("plan it");
    expect(sendResult.items.map((item) => item.type)).toEqual(turnResult.items.map((item) => item.type));
    expect(sendResult.finalResponse).toBe(turnResult.finalResponse);
  });

  it("turn.failed causes send() to throw NimboSessionError carrying the same code", async () => {
    const tool: Tool = { description: "d", inputSchema: z.object({}), execute: () => "ok" };
    const agent = baseAgent(alwaysToolCallsModel("loop_tool"), { tools: { loop_tool: tool }, maxTurnsPerRun: 1 });
    const session = createSession(agent);

    let caught: unknown;
    try {
      await session.send("go");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NimboSessionError);
    expect(caught instanceof NimboSessionError ? caught.code : undefined).toBe("max_turns");
  });

  it("TurnOptions.signal abort propagates through send() as an 'aborted' NimboSessionError", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    const session = createSession(baseAgent(stopModel("hi")));

    await expect(session.send("hi", { signal: controller.signal })).rejects.toMatchObject({ code: "aborted" });
  });

  describe("update_plan builtin wiring", () => {
    it("is present by default (builtinTools unset)", async () => {
      const session = createSession(baseAgent(toolCallThenStopModel("update_plan", { items: [] }, "done")));
      const events = await drainStream(session.stream("plan"));
      const completed = events.filter(isItemCompleted).map((e) => e.item).filter(isToolCallItem);
      expect(completed[0]?.status).toBe("completed");
    });

    it("is absent when builtinTools: false", async () => {
      const agent = baseAgent(toolCallThenStopModel("update_plan", { items: [] }, "done"), { builtinTools: false });
      const events = await drainStream(createSession(agent).stream("plan"));
      const completed = events.filter(isItemCompleted).map((e) => e.item).filter(isToolCallItem);
      expect(completed[0]?.status).toBe("failed");
      expect(typeof completed[0]?.output === "string" ? completed[0]?.output : "").toContain("Unknown tool");
    });

    it("is absent when builtinTools is a curated list without it", async () => {
      const agent = baseAgent(toolCallThenStopModel("update_plan", { items: [] }, "done"), { builtinTools: ["read_file"] });
      const events = await drainStream(createSession(agent).stream("plan"));
      const completed = events.filter(isItemCompleted).map((e) => e.item).filter(isToolCallItem);
      expect(completed[0]?.status).toBe("failed");
    });

    it("a host-provided tools.update_plan overrides the builtin implementation", async () => {
      const hostTool: Tool = {
        description: "custom",
        inputSchema: z.object({ items: z.array(z.object({ text: z.string(), completed: z.boolean() })) }),
        execute: () => "custom plan handled",
      };
      const agent = baseAgent(toolCallThenStopModel("update_plan", { items: [] }, "done"), { tools: { update_plan: hostTool } });
      const events = await drainStream(createSession(agent).stream("plan"));
      const completed = events.filter(isItemCompleted).map((e) => e.item).filter(isToolCallItem);
      expect(completed[0]?.output).toBe("custom plan handled");
    });
  });

  it("composes agent.instructions + SessionOptions.instructions.append into the system prompt sent to the model", async () => {
    const model = stopModel("ok");
    const agent = baseAgent(model, { instructions: "Be terse." });
    const opts: SessionOptions = { instructions: { append: "Always answer in English." } };
    const session = createSession(agent, opts);

    await drainStream(session.stream("hi"));

    expect(model.doStreamCalls[0]?.prompt[0]).toMatchObject({ role: "system", content: "Be terse.\n\nAlways answer in English." });
  });

  it("system prompt falls back to just agent.instructions when instructions.append isn't set", async () => {
    const model = stopModel("ok");
    const session = createSession(baseAgent(model, { instructions: "Be terse." }));
    await drainStream(session.stream("hi"));
    expect(model.doStreamCalls[0]?.prompt[0]).toMatchObject({ role: "system", content: "Be terse." });
  });

  it("system prompt falls back to just instructions.append when agent.instructions isn't set", async () => {
    const model = stopModel("ok");
    const session = createSession(baseAgent(model), { instructions: { append: "Always answer in English." } });
    await drainStream(session.stream("hi"));
    expect(model.doStreamCalls[0]?.prompt[0]).toMatchObject({ role: "system", content: "Always answer in English." });
  });

  it("no system prompt at all when neither agent.instructions nor instructions.append is set", async () => {
    const model = stopModel("ok");
    const session = createSession(baseAgent(model));
    await drainStream(session.stream("hi"));
    expect(model.doStreamCalls[0]?.prompt[0]).not.toMatchObject({ role: "system" });
  });

  it("accepts InputBlock[] input (text + image) and converts it to a user ModelMessage content array", async () => {
    const model = stopModel("ok");
    const session = createSession(baseAgent(model));
    await drainStream(session.stream([{ type: "text", text: "what's in this image?" }, { type: "image", data: "base64data", mediaType: "image/png" }]));

    expect(model.doStreamCalls[0]?.prompt).toContainEqual(
      expect.objectContaining({
        role: "user",
        content: [
          { type: "text", text: "what's in this image?" },
          expect.objectContaining({ type: "file", mediaType: "image/png" }),
        ],
      }),
    );
  });

  it("readState.get/set behaves like a Map<path, mtime>", () => {
    const session: Session = createSession(baseAgent(stopModel("x")));
    expect(session.readState.get("/a.txt")).toBeUndefined();
    session.readState.set("/a.txt", 42);
    expect(session.readState.get("/a.txt")).toBe(42);
  });

  it("derivedData exposes recordFileChange/recordPlanUpdate for externally-constructed tools", () => {
    const session = createSession(baseAgent(stopModel("x")));
    expect(typeof session.derivedData.recordFileChange).toBe("function");
    expect(typeof session.derivedData.recordPlanUpdate).toBe("function");
    // `drain` is absent from the *static* type (SessionDerivedDataRecorder narrows
    // DerivedDataCollector) — that's a compile-time property, not a runtime deletion (the
    // same underlying collector object still has it), so assert it at the type level.
    expectTypeOf(session.derivedData).not.toHaveProperty("drain");
  });

  describe("fs left unconfigured", () => {
    it("every NimboFS method rejects with guidance pointing at { fs } or @nimbo/sdk", async () => {
      const session = createSession(baseAgent(stopModel("x")));
      await expect(session.fs.readFile("/a.txt")).rejects.toThrow(/@nimbo\/sdk/);
      await expect(session.fs.writeFile("/a.txt", "x")).rejects.toThrow(/fs/);
      await expect(session.fs.rm("/a.txt")).rejects.toThrow(/@nimbo\/sdk/);
      await expect(session.fs.mkdir("/a")).rejects.toThrow(/@nimbo\/sdk/);
      await expect(session.fs.readdir("/a")).rejects.toThrow(/@nimbo\/sdk/);
      await expect(session.fs.stat("/a.txt")).rejects.toThrow(/@nimbo\/sdk/);
      await expect(session.fs.glob("**/*")).rejects.toThrow(/@nimbo\/sdk/);
    });
  });

  it("uses the injected NimboFS when SessionOptions.fs is provided", async () => {
    const fs = {
      readFile: vi.fn(async () => new Uint8Array()),
      writeFile: vi.fn(async () => {}),
      rm: vi.fn(async () => {}),
      mkdir: vi.fn(async () => {}),
      readdir: vi.fn(async () => []),
      stat: vi.fn(async () => ({ type: "file" as const })),
      glob: vi.fn(async () => []),
    };
    const session = createSession(baseAgent(stopModel("x")), { fs });
    expect(session.fs).toBe(fs);
  });
});
