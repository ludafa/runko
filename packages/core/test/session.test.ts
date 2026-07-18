/**
 * P13-5-2（docs/tech/single-ledger.md）迁移：`session.stream()`/
 * `session.send()` 产出/消费 `NimboChunk`/`NimboUIMessage` 而不是退役的
 * `SessionEvent`/`SessionItem`；"emits session.started only on the very
 * first stream()/send() call" 一节随 `session.started`/`turn.started` 事件
 * 整体退役直接删除（`session.ts` 文件头：两者不再有对应 chunk，没有"重发
 * 抑制"这回事——同 `serialize.test.ts` 的"hasStarted"一节）。
 */
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { defineAgent } from "../src/agent.js";
import { createSession, NimboSessionError } from "../src/session.js";
import type { Session, SessionOptions } from "../src/session.js";
import type { AgentDefinition } from "../src/agent.js";
import type { Tool } from "../src/types.js";
import { allToolParts, drainTurn, fingerprintMessage } from "./helpers/nimbo-chunks.js";

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

describe("createSession", () => {
  it("send()/stream() consistency: draining stream() by hand produces the exact same ledger shape as an independent, equivalent send()", async () => {
    const session = createSession(baseAgent(toolCallThenStopModel("update-plan", { items: [{ text: "a", completed: false }] }, "done")));

    const { result: streamResult } = await drainTurn(session.stream("plan it"));
    const streamLedger = session.toJSON().messages;

    // an independent session's send() over an equivalent turn lands on the same shape (modulo
    // the random per-message ids, which aren't part of the consistency contract) — send() is
    // implemented as draining stream() internally (session.ts's `send`), so this is the
    // black-box confirmation that the two call styles are observably equivalent.
    const sendSession = createSession(baseAgent(toolCallThenStopModel("update-plan", { items: [{ text: "a", completed: false }] }, "done")));
    const sendResult = await sendSession.send("plan it");
    const sendLedger = sendSession.toJSON().messages;

    expect(sendLedger.map(fingerprintMessage)).toEqual(streamLedger.map(fingerprintMessage));
    expect(sendResult.finalResponse).toBe(streamResult.finalResponse);
    expect(sendResult.usage).toEqual(streamResult.usage);
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

  describe("update-plan builtin wiring", () => {
    it("is present by default (builtinTools unset)", async () => {
      const session = createSession(baseAgent(toolCallThenStopModel("update-plan", { items: [] }, "done")));
      await drainTurn(session.stream("plan"));
      const settled = allToolParts(session.toJSON().messages);
      expect(settled[0]).toMatchObject({ state: "output-available" });
    });

    it("is absent when builtinTools: false", async () => {
      const agent = baseAgent(toolCallThenStopModel("update-plan", { items: [] }, "done"), { builtinTools: false });
      const session = createSession(agent);
      await drainTurn(session.stream("plan"));
      const settled = allToolParts(session.toJSON().messages);
      expect(settled[0]).toMatchObject({ state: "output-error" });
      expect(settled[0]?.errorText).toContain("update-plan");
    });

    it("is absent when builtinTools is a curated list without it", async () => {
      const agent = baseAgent(toolCallThenStopModel("update-plan", { items: [] }, "done"), { builtinTools: ["read-file"] });
      const session = createSession(agent);
      await drainTurn(session.stream("plan"));
      const settled = allToolParts(session.toJSON().messages);
      expect(settled[0]).toMatchObject({ state: "output-error" });
    });

    it("a host-provided tools.update-plan overrides the builtin implementation", async () => {
      const hostTool: Tool = {
        description: "custom",
        inputSchema: z.object({ items: z.array(z.object({ text: z.string(), completed: z.boolean() })) }),
        execute: () => "custom plan handled",
      };
      const agent = baseAgent(toolCallThenStopModel("update-plan", { items: [] }, "done"), { tools: { "update-plan": hostTool } });
      const session = createSession(agent);
      await drainTurn(session.stream("plan"));
      const settled = allToolParts(session.toJSON().messages);
      expect(settled[0]).toMatchObject({ state: "output-available", output: "custom plan handled" });
    });
  });

  it("composes agent.instructions + SessionOptions.instructions.append into the system prompt sent to the model", async () => {
    const model = stopModel("ok");
    const agent = baseAgent(model, { instructions: "Be terse." });
    const opts: SessionOptions = { instructions: { append: "Always answer in English." } };
    const session = createSession(agent, opts);

    await drainTurn(session.stream("hi"));

    expect(model.doStreamCalls[0]?.prompt[0]).toMatchObject({ role: "system", content: "Be terse.\n\nAlways answer in English." });
  });

  it("system prompt falls back to just agent.instructions when instructions.append isn't set", async () => {
    const model = stopModel("ok");
    const session = createSession(baseAgent(model, { instructions: "Be terse." }));
    await drainTurn(session.stream("hi"));
    expect(model.doStreamCalls[0]?.prompt[0]).toMatchObject({ role: "system", content: "Be terse." });
  });

  it("system prompt falls back to just instructions.append when agent.instructions isn't set", async () => {
    const model = stopModel("ok");
    const session = createSession(baseAgent(model), { instructions: { append: "Always answer in English." } });
    await drainTurn(session.stream("hi"));
    expect(model.doStreamCalls[0]?.prompt[0]).toMatchObject({ role: "system", content: "Always answer in English." });
  });

  it("no system prompt at all when neither agent.instructions nor instructions.append is set", async () => {
    const model = stopModel("ok");
    const session = createSession(baseAgent(model));
    await drainTurn(session.stream("hi"));
    expect(model.doStreamCalls[0]?.prompt[0]).not.toMatchObject({ role: "system" });
  });

  it("accepts InputBlock[] input (text + image) and converts it to a user ModelMessage content array", async () => {
    const model = stopModel("ok");
    const session = createSession(baseAgent(model));
    await drainTurn(session.stream([{ type: "text", text: "what's in this image?" }, { type: "image", data: "base64data", mediaType: "image/png" }]));

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
