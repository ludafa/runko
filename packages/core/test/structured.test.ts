/**
 * P7-2: `generateStructuredOutput`（unit）+ `Session.send<T>` wiring
 * (integration) — tech-spec §4.8 "结构化输出" / §4.2 `send<T>` 重载.
 * See `src/structured.ts` header for the design rationale (generateText+Output
 * over generateObject, native-vs-fallback collapsing into one retry loop,
 * throw over a new turn.failed code).
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import type { ModelMessage } from "ai";
import { defineAgent } from "../src/agent.js";
import { createSession } from "../src/session.js";
import type { AgentDefinition, Input, TurnResult } from "../src/index.js";
import { generateStructuredOutput, NimboStructuredOutputError } from "../src/structured.js";

function mockModel(buildOptions: () => ConstructorParameters<typeof MockLanguageModelV4>[0]): MockLanguageModelV4 {
  return new MockLanguageModelV4(buildOptions());
}

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
} as const;

function generateTextResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    finishReason: { unified: "stop" as const, raw: undefined },
    usage,
    warnings: [],
  };
}

/** A `doStream` fixture for a plain "the model just answers, no tools" turn. */
function stopStream(text: string) {
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

const summarySchema = z.object({ summary: z.string(), score: z.number() });
type Summary = z.infer<typeof summarySchema>;

const baseMessages: ModelMessage[] = [{ role: "user", content: "summarize: the quick brown fox" }];

describe("generateStructuredOutput", () => {
  it("happy path: valid JSON on the first attempt returns the parsed+validated object", async () => {
    const model = mockModel(() => ({ doGenerate: generateTextResult(JSON.stringify({ summary: "a fox story", score: 0.9 })) }));

    const result = await generateStructuredOutput({
      model,
      system: undefined,
      messages: baseMessages,
      outputSchema: summarySchema,
    });

    expect(result).toEqual({ summary: "a fox story", score: 0.9 });
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("falls back to a corrective retry when the first attempt isn't valid JSON, and succeeds on the second", async () => {
    const model = mockModel(() => ({
      doGenerate: [generateTextResult("not json at all"), generateTextResult(JSON.stringify({ summary: "fixed", score: 0.5 }))],
    }));

    const result = await generateStructuredOutput({
      model,
      system: undefined,
      messages: baseMessages,
      outputSchema: summarySchema,
    });

    expect(result).toEqual({ summary: "fixed", score: 0.5 });
    expect(model.doGenerateCalls).toHaveLength(2);
    // the retry's corrective conversation carries the first attempt's raw (invalid) output forward
    expect(model.doGenerateCalls[1]?.prompt.some((m) => m.role === "assistant")).toBe(true);
  });

  it("throws NimboStructuredOutputError after exhausting the retry budget (still invalid on every attempt)", async () => {
    const model = mockModel(() => ({
      doGenerate: [generateTextResult("nope"), generateTextResult("still nope"), generateTextResult("nope again")],
    }));

    await expect(
      generateStructuredOutput({ model, system: undefined, messages: baseMessages, outputSchema: summarySchema }),
    ).rejects.toBeInstanceOf(NimboStructuredOutputError);
    // initial attempt + MAX_RETRIES(2) retries = 3 total calls, then it gives up.
    expect(model.doGenerateCalls).toHaveLength(3);
  });

  it("treats a non-'stop' finishReason on the extraction call as a failure and retries (defensive: AI SDK only resolves .output when finishReason is 'stop')", async () => {
    const model = mockModel(() => ({
      doGenerate: [
        { content: [{ type: "text" as const, text: "truncated" }], finishReason: { unified: "length" as const, raw: undefined }, usage, warnings: [] },
        generateTextResult(JSON.stringify({ summary: "ok", score: 1 })),
      ],
    }));

    const result = await generateStructuredOutput({
      model,
      system: undefined,
      messages: baseMessages,
      outputSchema: summarySchema,
    });

    expect(result).toEqual({ summary: "ok", score: 1 });
    expect(model.doGenerateCalls).toHaveLength(2);
  });

  it("does not mutate the caller's messages array across retries", async () => {
    const model = mockModel(() => ({
      doGenerate: [generateTextResult("not json"), generateTextResult(JSON.stringify({ summary: "ok", score: 1 }))],
    }));
    const messages: ModelMessage[] = [...baseMessages];
    const originalLength = messages.length;

    await generateStructuredOutput({ model, system: undefined, messages, outputSchema: summarySchema });

    expect(messages).toHaveLength(originalLength);
  });

  it("propagates non-validation errors (e.g. a transport failure) without wrapping them", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("network blew up");
      },
    });

    await expect(
      generateStructuredOutput({ model, system: undefined, messages: baseMessages, outputSchema: summarySchema }),
    ).rejects.toThrow("network blew up");
  });

  it("type: the resolved value is precisely the schema's inferred type", () => {
    expectTypeOf(generateStructuredOutput<Summary>).returns.resolves.toEqualTypeOf<Summary>();
  });
});

function baseAgent(model: MockLanguageModelV4, overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return defineAgent({ model, ...overrides });
}

describe("Session.send<T>(...outputSchema)", () => {
  it("happy path: TurnResult carries items/finalResponse as usual, plus a typed structuredOutput", async () => {
    const model = mockModel(() => ({
      doStream: stopStream("here is your summary"),
      doGenerate: generateTextResult(JSON.stringify({ summary: "fox story", score: 0.8 })),
    }));
    const session = createSession(baseAgent(model));

    const result = await session.send("summarize", { outputSchema: summarySchema });

    expect(result.finalResponse).toBe("here is your summary");
    expect(result.items.map((item) => item.type)).toContain("agent_message");
    expect(result.structuredOutput).toEqual({ summary: "fox story", score: 0.8 });
  });

  it("falls back through a corrective retry end-to-end when the extraction pass first returns invalid JSON", async () => {
    const model = mockModel(() => ({
      doStream: stopStream("here is your summary"),
      doGenerate: [generateTextResult("not json"), generateTextResult(JSON.stringify({ summary: "recovered", score: 0.3 }))],
    }));
    const session = createSession(baseAgent(model));

    const result = await session.send("summarize", { outputSchema: summarySchema });

    expect(result.structuredOutput).toEqual({ summary: "recovered", score: 0.3 });
    expect(model.doGenerateCalls).toHaveLength(2);
  });

  it("throws NimboStructuredOutputError (not NimboSessionError) when the extraction pass exhausts its retries", async () => {
    const model = mockModel(() => ({
      doStream: stopStream("here is your summary"),
      doGenerate: [generateTextResult("no"), generateTextResult("no"), generateTextResult("no")],
    }));
    const session = createSession(baseAgent(model));

    await expect(session.send("summarize", { outputSchema: summarySchema })).rejects.toBeInstanceOf(NimboStructuredOutputError);
  });

  it("does not push the extraction pass's messages into the session's persisted history", async () => {
    const model = mockModel(() => ({
      doStream: stopStream("here is your summary"),
      doGenerate: [generateTextResult("not json"), generateTextResult(JSON.stringify({ summary: "recovered", score: 0.3 }))],
    }));
    const session = createSession(baseAgent(model));

    await session.send("summarize", { outputSchema: summarySchema });

    // system(none)+user+assistant from the normal turn only — no trace of the extraction pass's
    // corrective assistant/user round-trip.
    expect(session.toJSON().messages).toHaveLength(2);
  });

  it("no outputSchema: behavior is unchanged — plain TurnResult, doGenerate never invoked", async () => {
    const model = mockModel(() => ({ doStream: stopStream("plain answer") }));
    const session = createSession(baseAgent(model));

    const result: TurnResult = await session.send("hi");

    expect(result.finalResponse).toBe("plain answer");
    expect("structuredOutput" in result).toBe(false);
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("type: send<T> with outputSchema resolves to TurnResult & { structuredOutput: T }; without it, plain TurnResult", () => {
    const model = mockModel(() => ({ doStream: stopStream("x") }));
    const session = createSession(baseAgent(model));

    // Assignability checks only — `session.send` is never *called* here (a bare property
    // reference has no runtime side effect), so this can't touch the mock model's one-shot
    // stream. A mismatch on either line fails `tsc --noEmit`, which gates this package same as
    // a failing test (see coder.md's three-greens acceptance bar).
    const plainSend: (input: Input) => Promise<TurnResult> = session.send;
    const structuredSend: (input: Input, opts: { outputSchema: typeof summarySchema }) => Promise<TurnResult & { structuredOutput: Summary }> =
      session.send;
    expectTypeOf(plainSend).toBeFunction();
    expectTypeOf(structuredSend).toBeFunction();
  });
});
