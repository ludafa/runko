/**
 * STEER-1/STEER-1F (`Session.steer`, docs/tech/core-sdk.md §4.2) acceptance tests — see the
 * STEER-2/STEER-2F work orders for the nine numbered scenarios this file's
 * `describe` blocks map to 1:1 (scenario 8 is folded into the Checkpoint A
 * section per the work order's own "可与场景 2 合并验证" note), plus a
 * dedicated STEER-1F regression section below them.
 *
 * P13-5-2（docs/tech/single-ledger.md）迁移：`session.stream()`/
 * `runTurn()` 现在产出 `RunkoChunk` 而不是退役的 `SessionEvent`，"steer 注入
 * 的消息" 现在是一条 `metadata.steered:true` 的 user `RunkoUIMessage`（不再有
 * `user_message` item 或摘要出来的 `item.text`——ledger 里的 `parts` 本身就是
 * 完整保真的展示形态，见 §7 一节的裁量说明）。断言因此分两层：
 * - chunk 层：`session.stream()`/`runTurn()` 产出的 `RunkoChunk` 序列（步骤
 *   边界、settle 时机）。
 * - 账本层：`session.toJSON().messages`（`runTurn` 直接 push 的同一个数组）
 *   与 `model.doStreamCalls[n].prompt`（`convertToModelMessages()` 现场推导、
 *   真正发给模型的东西）。
 *
 * Two levels of testing, matching the two files under test:
 * - `loop.test.ts`-style: `runTurn(...)` invoked directly (scenario 9, the
 *   `drainSteers` equivalence class, and the STEER-1F known-gap regression —
 *   both `loop.ts`-only concerns).
 * - `session.test.ts`-style: `createSession(...)` + `session.steer(...)`,
 *   which is how every other scenario actually exercises the feature (steer
 *   is a `Session` method; `RunTurnOptions.drainSteers` is session.ts's
 *   private wiring into it).
 *
 * Determinism note (mirrors the work order's own framing): several scenarios
 * need `session.steer(...)` called at an exact point *during* a turn. Two
 * techniques are used, both deterministic (no timers/races):
 * 1. A tool whose `execute()` calls `session.steer(...)` — the call happens
 *    synchronously inside `executeToolCall`, which is on the only code path
 *    running at that instant (single-threaded JS, no concurrent tool calls
 *    in this loop). Requires a small forward-reference (`slot`) since the
 *    tool object must exist before `createSession(...)` returns the `Session`
 *    it will call `.steer()` on.
 * 2. Driving `session.stream()` by hand and calling `session.steer(...)` the
 *    moment a specific chunk is observed (`text-end` — the point at which an
 *    assistant step's text part is fully settled, the closest analogue to the
 *    retired `item.completed`) — the generator is suspended exactly there
 *    until the test resumes it, so the call is guaranteed to land before the
 *    next drain checkpoint runs.
 *
 * STEER-1F (docs/tech/core-sdk.md §4.2, "STEER-1F 修复" / "已知缺口"): fixed the tool-calls
 * branch that hits `maxTurnsPerRun` (a steer queued during that step's tool
 * execution used to be silently discarded — see the git history of this file
 * for the pre-fix version of the "turn-scope queue clearing" test below,
 * which asserted the *bug*). Three termination paths now drain before
 * yielding their terminal event: the normal (`finishReason !== "tool-calls"`)
 * tail, the tool-calls/`maxTurnsPerRun` branch, and the `maxTurnsPerRun <= 0`
 * fallback. Two termination paths remain undrained by design-for-now
 * (spec-declared known gap, not this work order's scope to close):
 * `runOneStep`/`executeStepToolCalls` throwing (`aborted`/`provider_error`).
 */
import { describe, expect, it } from "vitest";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { defineAgent } from "../src/agent.js";
import type { AgentDefinition } from "../src/agent.js";
import { createSession } from "../src/session.js";
import type { Session } from "../src/session.js";
import { runTurn } from "../src/loop.js";
import type { RunTurnOptions } from "../src/loop.js";
import { createOnceApprovalMemory } from "../src/approval.js";
import { createDerivedDataCollector } from "../src/runtime.js";
import type { RunkoFS, Tool } from "../src/types.js";
import type { RunkoUIMessage } from "../src/state.js";
import {
  chunksOfType,
  collectText,
  drainTurn,
  fingerprintChunk,
  fingerprintMessage,
  lastIndexOfChunkType,
  userTextMessage,
} from "./helpers/runko-chunks.js";

// ---------------------------------------------------------------------------
// shared helpers (same shapes as loop.test.ts / session.test.ts — this repo's
// existing tests keep each file self-contained rather than sharing a
// test-utils module, followed here for consistency).
// ---------------------------------------------------------------------------

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

/** Same shape as session.test.ts's helper of the same name: step 1 tool-calls, step 2 stop. */
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
 * Two independent single-step "stop" responses, one per call — for tests that drive the *same*
 * session/model across two separate turns (`stopModel`'s static `doStream: {...}` object would
 * hand a second call an already-drained stream; see session.test.ts's `alwaysToolCallsModel`
 * header comment for the same caveat).
 */
function twoTurnStopModel(firstText: string, secondText: string): MockLanguageModelV4 {
  return mockModel(() => ({
    doStream: [
      {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: firstText },
            { type: "text-end", id: "t1" },
            { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      },
      {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t2" },
            { type: "text-delta", id: "t2", delta: secondText },
            { type: "text-end", id: "t2" },
            { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      },
    ],
  }));
}

function baseAgent(model: MockLanguageModelV4, overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return defineAgent({ model, ...overrides });
}

function isSteered(message: RunkoUIMessage): boolean {
  return message.metadata?.steered === true;
}

/** Forward-reference cell: a tool's `execute()` needs to call `session.steer(...)`, but the
 * tool object must exist *before* `createSession(...)` returns the session — classic
 * chicken-and-egg. Assigned right after `createSession(...)` returns, read only once a tool
 * call actually executes (always after that assignment). */
interface SessionSlot {
  current: Session | undefined;
}

function readSlot(slot: SessionSlot): Session {
  if (slot.current === undefined) {
    throw new Error("test bug: tool executed before the session was assigned into the slot");
  }
  return slot.current;
}

// ---- loop.ts-level helpers (scenario 9 + the known-gap regression only — direct runTurn(...) calls) ----

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

// ---------------------------------------------------------------------------
// 1. idle semantics
// ---------------------------------------------------------------------------

describe("Session.steer — idle semantics (§4.2: no in-flight turn)", () => {
  it("returns false with no side effects before any turn has ever started, and a subsequent send()'s first prompt doesn't carry it", async () => {
    const model = stopModel("hello");
    const session = createSession(baseAgent(model));

    expect(session.steer("nobody is listening")).toBe(false);

    await session.send("go");

    const prompt = model.doStreamCalls[0]?.prompt ?? [];
    const userMessages = prompt.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]).toMatchObject({ content: [{ type: "text", text: "go" }] });
  });

  it("returns false again once a turn has completed (turnActive resets when the turn ends)", async () => {
    const session = createSession(baseAgent(stopModel("done")));
    await session.send("go");
    expect(session.steer("too late, turn already ended")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Checkpoint A (tool execution) + the tool-result/steer dangerous-window
//    contract — also covers scenario 8 (steer during send()) at the end.
// ---------------------------------------------------------------------------

describe("Session.steer — Checkpoint A: steering from inside a tool's execute()", () => {
  it("returns true; the injected steered user message lands strictly after the tool result (never between the assistant tool-call message and its tool result); chunk ordering and the ledger reflect it", async () => {
    const slot: SessionSlot = { current: undefined };
    let steerReturnValue: boolean | undefined;

    const steeringTool: Tool = {
      description: "calls session.steer() during execution",
      inputSchema: z.object({}),
      execute: () => {
        steerReturnValue = readSlot(slot).steer("steered during tool execution");
        return "tool done";
      },
    };

    const model = toolCallThenStopModel("steer_tool", {}, "final answer");
    const session = createSession(baseAgent(model, { tools: { steer_tool: steeringTool } }));
    slot.current = session;

    const { chunks } = await drainTurn(session.stream("go"));

    expect(steerReturnValue).toBe(true);

    // Provider hazard regression: Anthropic/OpenAI-compatible providers require a tool-call's
    // assistant message and its tool-result message to be strictly adjacent. Step 2's prompt
    // must show assistant(tool-call) -> tool(result) -> user(steer), in that order, with
    // nothing wedged between the assistant message and the tool result.
    const step2Prompt = model.doStreamCalls[1]?.prompt ?? [];
    expect(step2Prompt.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
    expect(step2Prompt[3]).toMatchObject({ role: "user", content: [{ type: "text", text: "steered during tool execution" }] });

    // chunk ordering: the tool settles (tool-output-available) before the steered message's
    // own `start` chunk, which in turn lands before step 2's own `start-step` — atomic, never
    // interleaved mid-step.
    const steeredMessage = session.toJSON().messages.find(isSteered);
    expect(steeredMessage).toBeDefined();
    const toolOutputIndex = chunks.findIndex((c) => c.type === "tool-output-available");
    const steerStartIndex = chunks.findIndex((c) => c.type === "start" && c.messageId === steeredMessage?.id);
    const secondStartStepIndex = lastIndexOfChunkType(chunks, "start-step");
    expect(toolOutputIndex).toBeGreaterThanOrEqual(0);
    expect(steerStartIndex).toBeGreaterThan(toolOutputIndex);
    expect(secondStartStepIndex).toBeGreaterThan(steerStartIndex);

    expect(collectText(steeredMessage)).toBe("steered during tool execution");
  });

  it("(scenario 8) also works when the turn is driven via send() rather than stream()", async () => {
    const slot: SessionSlot = { current: undefined };
    let steerReturnValue: boolean | undefined;

    const steeringTool: Tool = {
      description: "calls session.steer() during execution",
      inputSchema: z.object({}),
      execute: () => {
        steerReturnValue = readSlot(slot).steer("steered via send()");
        return "tool done";
      },
    };

    const model = toolCallThenStopModel("send_steer_tool", {}, "final via send");
    const session = createSession(baseAgent(model, { tools: { send_steer_tool: steeringTool } }));
    slot.current = session;

    const pending = session.send("go"); // not yet awaited — the turn (and steer's tool call) run while this is pending
    const result = await pending;

    expect(steerReturnValue).toBe(true);
    expect(session.toJSON().messages.some(isSteered)).toBe(true);
    expect(result.finalResponse).toBe("final via send");

    const step2Prompt = model.doStreamCalls[1]?.prompt ?? [];
    expect(step2Prompt.at(-1)).toMatchObject({ role: "user", content: [{ type: "text", text: "steered via send()" }] });
  });
});

// ---------------------------------------------------------------------------
// 3. Checkpoint B (tail of turn)
// ---------------------------------------------------------------------------

describe("Session.steer — Checkpoint B: steering as the turn's tail step completes", () => {
  it("doesn't end the turn on that step; runs one more step; ends with message-metadata status:'completed'; ledger is user(go) -> assistant(text1) -> user(steer) -> assistant(text2)", async () => {
    const model = mockModel(() => ({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t1" },
              { type: "text-delta", id: "t1", delta: "first text" },
              { type: "text-end", id: "t1" },
              { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
            ],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t2" },
              { type: "text-delta", id: "t2", delta: "second text" },
              { type: "text-end", id: "t2" },
              { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
            ],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        },
      ],
    }));

    const session = createSession(baseAgent(model));
    const gen = session.stream("go");

    let steered = false;
    let next = await gen.next();
    while (!next.done) {
      // `text-end` is the closest chunk-level analogue to the retired `item.completed` for the
      // assistant's text — the generator is suspended exactly here (runOneStep's last text
      // chunk before `finish-step`/`finish`), so this steer is guaranteed to land in Checkpoint
      // B's drain rather than being lost.
      if (!steered && next.value.type === "text-end") {
        expect(session.steer("steered at tail")).toBe(true);
        steered = true;
      }
      next = await gen.next();
    }
    const result = next.value;

    expect(steered).toBe(true);
    expect(model.doStreamCalls).toHaveLength(2);

    const step2Prompt = model.doStreamCalls[1]?.prompt ?? [];
    expect(step2Prompt.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(step2Prompt[2]).toMatchObject({ role: "user", content: [{ type: "text", text: "steered at tail" }] });

    const history = session.toJSON().messages;
    expect(history.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(isSteered(history[2] ?? { id: "", role: "system", parts: [] })).toBe(true);

    expect(history[3]?.metadata?.status).toBe("completed");
    expect(result.finalResponse).toBe("second text");
  });
});

// ---------------------------------------------------------------------------
// 4. budget exhaustion at Checkpoint B
// ---------------------------------------------------------------------------

describe("Session.steer — budget exhaustion at Checkpoint B", () => {
  it("maxTurnsPerRun: 1 + steer at the only step's tail: message-metadata status:'failed'/max_turns, not 'completed' (though the steer *was* drained into the ledger)", async () => {
    const model = stopModel("only text");
    const session = createSession(baseAgent(model, { maxTurnsPerRun: 1 }));
    const gen = session.stream("go");

    const chunks = [];
    let steered = false;
    let next = await gen.next();
    while (!next.done) {
      chunks.push(next.value);
      if (!steered && next.value.type === "text-end") {
        expect(session.steer("too late for more budget")).toBe(true);
        steered = true;
      }
      next = await gen.next();
    }

    expect(steered).toBe(true);
    const metadataChunks = chunksOfType(chunks, "message-metadata");
    expect(metadataChunks[0]?.messageMetadata.status).toBe("failed");
    expect(metadataChunks[0]?.messageMetadata.error?.code).toBe("max_turns");
    expect(model.doStreamCalls).toHaveLength(1);

    // the steer WAS drained (Checkpoint B ran before the max_turns check) — it's in the ledger
    // even though the turn ultimately fails for lack of budget to let the model see it.
    const history = session.toJSON().messages;
    expect(history.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(isSteered(history[2] ?? { id: "", role: "system", parts: [] })).toBe(true);
    expect(collectText(history[2])).toBe("too late for more budget");
  });
});

// ---------------------------------------------------------------------------
// 5. multiple steer() calls before the same checkpoint stay in call order
// ---------------------------------------------------------------------------

describe("Session.steer — ordering of multiple queued messages", () => {
  it("two steer() calls made back-to-back inside the same tool execution are both injected, in call order", async () => {
    const slot: SessionSlot = { current: undefined };
    const returnValues: boolean[] = [];

    const steeringTool: Tool = {
      description: "queues two steer messages",
      inputSchema: z.object({}),
      execute: () => {
        const session = readSlot(slot);
        returnValues.push(session.steer("first steer"));
        returnValues.push(session.steer("second steer"));
        return "done";
      },
    };

    const model = toolCallThenStopModel("multi_steer_tool", {}, "final");
    const session = createSession(baseAgent(model, { tools: { multi_steer_tool: steeringTool } }));
    slot.current = session;

    const { result } = await drainTurn(session.stream("go"));

    expect(returnValues).toEqual([true, true]);

    const steeredTexts = session.toJSON().messages.filter(isSteered).map(collectText);
    expect(steeredTexts).toEqual(["first steer", "second steer"]);

    const step2Prompt = model.doStreamCalls[1]?.prompt ?? [];
    const userEntries = step2Prompt.filter((m) => m.role === "user");
    expect(userEntries.map((m) => m.content)).toEqual([
      [{ type: "text", text: "go" }],
      [{ type: "text", text: "first steer" }],
      [{ type: "text", text: "second steer" }],
    ]);

    expect(result.finalResponse).toBe("final");
  });
});

// ---------------------------------------------------------------------------
// 6. turn-scope clearing
// ---------------------------------------------------------------------------

describe("Session.steer — turn-scope queue clearing", () => {
  it("(STEER-1F) a steer queued during the final step's tool execution, when that step is itself the last budgeted step, is drained before the turn fails — its message persists in the session's history across turns rather than being discarded", async () => {
    // maxTurnsPerRun: 1 + a tool-calls-finishing step exhausts the budget in the branch that,
    // pre-STEER-1F, had no drain checkpoint of its own (loop.ts's tool-calls/max_turns branch
    // used to run straight to the failure metadata after settling the tool call, silently
    // dropping any steer() queued during that step's tool execution). STEER-1F added a drain
    // there too — this test now asserts the *fixed* behavior: the queued message survives (in
    // the persisted message history) even though the turn itself still ends in
    // message-metadata status:'failed'/max_turns for lack of a further step to let the model see it.
    const slot: SessionSlot = { current: undefined };
    let steerReturnValue: boolean | undefined;

    const steeringTool: Tool = {
      description: "queues a steer during the final budgeted step's tool execution",
      inputSchema: z.object({}),
      execute: () => {
        steerReturnValue = readSlot(slot).steer("orphaned steer message");
        return "tool done";
      },
    };

    const model = toolCallThenStopModel("loop_tool", {}, "clean turn");
    const session = createSession(baseAgent(model, { tools: { loop_tool: steeringTool }, maxTurnsPerRun: 1 }));
    slot.current = session;

    const { chunks: firstChunks } = await drainTurn(session.stream("go"));

    expect(steerReturnValue).toBe(true);
    const firstMetadata = chunksOfType(firstChunks, "message-metadata");
    expect(firstMetadata[0]?.messageMetadata.error?.code).toBe("max_turns");
    // STEER-1F: drained before the failure — the message exists with the original text.
    const firstHistory = session.toJSON().messages;
    const steeredMessage = firstHistory.find(isSteered);
    expect(collectText(steeredMessage)).toBe("orphaned steer message");

    // same session, second turn: the drained message is part of persisted history now, so it
    // must resurface (not be a leak — it was legitimately backfilled into `messages` before the
    // turn failed). Expect all three user messages, in order: turn 1's own input, the drained
    // steer message, then turn 2's own input.
    const secondResult = await session.send("second turn");
    expect(secondResult.finalResponse).toBe("clean turn");

    const secondPrompt = model.doStreamCalls[1]?.prompt ?? [];
    const userMessages = secondPrompt.filter((m) => m.role === "user");
    expect(userMessages.map((m) => m.content)).toEqual([
      [{ type: "text", text: "go" }],
      [{ type: "text", text: "orphaned steer message" }],
      [{ type: "text", text: "second turn" }],
    ]);
  });
});

// ---------------------------------------------------------------------------
// STEER-1F regression #1: chunk ordering for the (now-fixed) tool-calls/
// max_turns drain — the steered message's `start` chunk must land before
// message-metadata, and the drained message must be visible to the very next
// model call this session makes (whether that's a hypothetical next step in
// the same turn, if one existed, or — as here, since the budget is already
// spent — the next turn's first model call).
// ---------------------------------------------------------------------------

describe("Session.steer — STEER-1F regression: drain-before-max_turns ordering", () => {
  it("the steered message's `start` chunk appears before message-metadata in the chunk stream, the ledger carries it, and the same session's next send() sees it in its prompt", async () => {
    const slot: SessionSlot = { current: undefined };
    let steerReturnValue: boolean | undefined;

    const steeringTool: Tool = {
      description: "queues a steer during the final budgeted step's tool execution",
      inputSchema: z.object({}),
      execute: () => {
        steerReturnValue = readSlot(slot).steer("drained before max_turns");
        return "tool done";
      },
    };

    const model = toolCallThenStopModel("budget_tool", {}, "second turn text");
    const session = createSession(baseAgent(model, { tools: { budget_tool: steeringTool }, maxTurnsPerRun: 1 }));
    slot.current = session;

    const { chunks } = await drainTurn(session.stream("go"));

    expect(steerReturnValue).toBe(true);

    const steeredMessage = session.toJSON().messages.find(isSteered);
    expect(steeredMessage).toBeDefined();
    const steerStartIndex = chunks.findIndex((c) => c.type === "start" && c.messageId === steeredMessage?.id);
    const metadataIndex = chunks.findIndex((c) => c.type === "message-metadata");
    expect(steerStartIndex).toBeGreaterThanOrEqual(0);
    expect(metadataIndex).toBeGreaterThan(steerStartIndex);
    expect(chunksOfType(chunks, "message-metadata")[0]?.messageMetadata.error?.code).toBe("max_turns");

    expect(collectText(steeredMessage)).toBe("drained before max_turns");

    await session.send("follow up");
    const nextPrompt = model.doStreamCalls[1]?.prompt ?? [];
    const nextUserContents = nextPrompt.filter((m) => m.role === "user").map((m) => JSON.stringify(m.content));
    expect(nextUserContents.some((content) => content.includes("drained before max_turns"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// STEER-1F regression #2: the declared known gap. docs/tech/core-sdk.md §4.2 states that
// `runOneStep`/`executeStepToolCalls` throwing (`aborted`/`provider_error`)
// does *not* drain — this test pins down that *current* (gap) behavior so a
// future work order that closes it will see this assertion flip and know to
// update it, rather than the gap silently regressing further unnoticed.
// ---------------------------------------------------------------------------

describe("runTurn — known gap (docs/tech/core-sdk.md §4.2): provider_error does not drain queued steer messages", () => {
  it("doStream throwing (provider_error) skips the drain the other three termination paths perform — content queued right as the failing step ran is discarded, never surfaces in the ledger", async () => {
    // Driving this through a real `session.steer()` call would require a tool execution to run
    // *while* the very step whose model call then throws is in flight — `simulateReadableStream`
    // (and this repo's other tests) only support a step's `doStream` throwing outright, with no
    // partial chunks first (see loop.test.ts's own "provider error" test), so there's no yield
    // point for a test to hook a `session.steer()` call into before the throw. This test instead
    // drives `drainSteers` directly (same level as loop.test.ts/the scenario-9 test below):
    // `doStream` pushes into `queue` as its very last act before throwing, standing in for
    // "something got queued right as this failing model call was in flight".
    let queue: RunkoUIMessage[] = [];
    const drainSteers = (): RunkoUIMessage[] => {
      const drained = queue;
      queue = [];
      return drained;
    };

    const model = mockModel(() => ({
      doStream: async () => {
        queue.push({ ...userTextMessage("steer_1", "queued right as the failing step ran"), metadata: { steered: true } });
        throw new Error("network exploded");
      },
    }));

    const messages: RunkoUIMessage[] = [userTextMessage("u1", "go")];
    const { chunks } = await drainTurn(runTurn(turnOptions(model, { messages, drainSteers })));

    const metadataChunks = chunksOfType(chunks, "message-metadata");
    expect(metadataChunks[0]?.messageMetadata.error?.code).toBe("provider_error");

    // known gap, pinned down: the queued message is still sitting in `queue` — the catch around
    // runOneStep never called drainSteers again after the model call failed.
    expect(queue).toHaveLength(1);
    // No steered message ever reaches the ledger — that's the known gap this section documents.
    expect(messages.some(isSteered)).toBe(false);
    // 发现的 src 缺陷（见 loop.test.ts 的 "abort"/"provider error" 测试内联
    // 注释，同一处根因，与 steer 无关）：`messages` 正确应恰好 2 条（user +
    // 携带失败 metadata 的 assistant），实际会残留一条孤儿占位 assistant
    // 消息、共 3 条。下面这个断言按"应有行为"编写，当前会失败。
    expect(messages).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// STEER-3T (STEER-3A Finding 4, docs/tech/core-sdk.md §4.2): steer() must honestly return
// false once the terminal chunk (message-metadata) has already been produced
// by runTurn — even if the consumer's own `.next()` call that observed it
// hasn't returned control back to it yet. Pre-fix, `stream()` only flipped
// `turnActive` to false in its `finally` block, which runs *after* the
// terminal event has already been handed to the consumer via a bare
// `yield* turnGen` — so a steer() called in direct reaction to seeing the
// terminal event used to return `true` while the content was silently
// dropped a moment later by that same `finally` block. The fix (session.ts's
// manual delegation loop) flips `turnActive = false` *before* yielding the
// terminal chunk onward, so this reaction window now correctly sees no
// in-flight turn.
// ---------------------------------------------------------------------------

describe("Session.steer — STEER-3T: honest false once the terminal chunk has already fired", () => {
  it("returns false when called upon observing a 'completed' message-metadata chunk, and the rejected content never leaks into the next turn", async () => {
    const model = twoTurnStopModel("first turn reply", "second turn reply");
    const session = createSession(baseAgent(model));

    const gen = session.stream("go");
    let sawTerminal = false;
    let next = await gen.next();
    while (!next.done) {
      if (next.value.type === "message-metadata" && next.value.messageMetadata.status === "completed") {
        expect(session.steer("too late, turn already completed")).toBe(false);
        sawTerminal = true;
      }
      next = await gen.next();
    }
    expect(sawTerminal).toBe(true);

    const secondResult = await session.send("second turn");
    expect(secondResult.finalResponse).toBe("second turn reply");

    const secondPrompt = model.doStreamCalls[1]?.prompt ?? [];
    const userMessages = secondPrompt.filter((m) => m.role === "user");
    expect(userMessages.map((m) => m.content)).toEqual([
      [{ type: "text", text: "go" }],
      [{ type: "text", text: "second turn" }],
    ]);
  });

  it("returns false when called upon observing a 'failed'/max_turns message-metadata chunk, and the rejected content never leaks into the next turn", async () => {
    const tool: Tool = { description: "d", inputSchema: z.object({}), execute: () => "ok" };
    const model = toolCallThenStopModel("noop_tool", {}, "second turn reply");
    const session = createSession(baseAgent(model, { tools: { noop_tool: tool }, maxTurnsPerRun: 1 }));

    const gen = session.stream("go");
    let sawFailed = false;
    let next = await gen.next();
    while (!next.done) {
      if (next.value.type === "message-metadata" && next.value.messageMetadata.status === "failed") {
        expect(next.value.messageMetadata.error?.code).toBe("max_turns");
        expect(session.steer("too late, turn already failed")).toBe(false);
        sawFailed = true;
      }
      next = await gen.next();
    }
    expect(sawFailed).toBe(true);

    const secondResult = await session.send("second turn");
    expect(secondResult.finalResponse).toBe("second turn reply");

    const secondPrompt = model.doStreamCalls[1]?.prompt ?? [];
    const userMessages = secondPrompt.filter((m) => m.role === "user");
    expect(userMessages.map((m) => m.content)).toEqual([
      [{ type: "text", text: "go" }],
      [{ type: "text", text: "second turn" }],
    ]);
  });
});

// ---------------------------------------------------------------------------
// 7. steered input fidelity — docs/tech/single-ledger.md §5-2 裁量: the old `user_message.text`
// one-line *summary* (e.g. "look: [image]") is retired along with SessionItem
// — a steered message's `parts` array *is* the full-fidelity display form
// now (no separate summary field to keep in sync), so this section asserts
// the parts land in the ledger exactly as constructed, and that the same
// fidelity survives into the model-facing conversion.
// ---------------------------------------------------------------------------

describe("Session.steer — steered input fidelity (parts are the display form now, no separate summary)", () => {
  it("plain string / multi-text-block / text+image steer inputs land as full-fidelity parts in the ledger, and the same content reaches the model prompt untouched", async () => {
    const slot: SessionSlot = { current: undefined };

    const steeringTool: Tool = {
      description: "queues three differently-shaped steer inputs",
      inputSchema: z.object({}),
      execute: () => {
        const session = readSlot(slot);
        session.steer("plain string steer");
        session.steer([
          { type: "text", text: "part a " },
          { type: "text", text: "part b" },
        ]);
        session.steer([
          { type: "text", text: "look: " },
          { type: "image", data: "base64imagedata", mediaType: "image/png" },
        ]);
        return "done";
      },
    };

    const model = toolCallThenStopModel("summarize_tool", {}, "final");
    const session = createSession(baseAgent(model, { tools: { summarize_tool: steeringTool } }));
    slot.current = session;

    await drainTurn(session.stream("go"));

    const steeredMessages = session.toJSON().messages.filter(isSteered);
    expect(steeredMessages).toHaveLength(3);
    expect(steeredMessages[0]?.parts).toEqual([{ type: "text", text: "plain string steer" }]);
    expect(steeredMessages[1]?.parts).toEqual([
      { type: "text", text: "part a " },
      { type: "text", text: "part b" },
    ]);
    expect(steeredMessages[2]?.parts).toEqual([
      { type: "text", text: "look: " },
      { type: "file", mediaType: "image/png", url: "data:image/png;base64,base64imagedata" },
    ]);

    // Full fidelity into the model-facing conversion too — nothing dropped/summarized. Asserted
    // via JSON substring containment (rather than a deep `toEqual`) to sidestep pinning the
    // exact `FilePart.data` shape ai's convertToModelMessages() produces (a real `URL` instance,
    // not a plain string) — session.ts's header already documents that conversion precisely.
    const step2Prompt = model.doStreamCalls[1]?.prompt ?? [];
    const userEntries = step2Prompt.filter((m) => m.role === "user");
    expect(userEntries).toHaveLength(4); // "go" + 3 steers
    expect(JSON.stringify(userEntries[1])).toContain("plain string steer");
    expect(JSON.stringify(userEntries[2])).toContain("part a ");
    expect(JSON.stringify(userEntries[2])).toContain("part b");
    expect(JSON.stringify(userEntries[3])).toContain("look: ");
    expect(JSON.stringify(userEntries[3])).toContain("base64imagedata");
  });
});

// ---------------------------------------------------------------------------
// 9. drainSteers equivalence class (loop.ts-level: an always-empty drainer
//    must behave identically to omitting drainSteers)
// ---------------------------------------------------------------------------

describe("runTurn — drainSteers equivalence class (§4.2: omitted vs. always-empty)", () => {
  it("a drainSteers that always returns [] produces the exact same chunk/ledger shape as omitting drainSteers entirely", async () => {
    function buildModel(): MockLanguageModelV4 {
      return mockModel(() => ({
        doStream: {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t1" },
              { type: "text-delta", id: "t1", delta: "steady state" },
              { type: "text-end", id: "t1" },
              { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
            ],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        },
      }));
    }

    const withoutMessages: RunkoUIMessage[] = [userTextMessage("u1", "go")];
    const withoutDrain = await drainTurn(runTurn(turnOptions(buildModel(), { messages: withoutMessages })));

    const withEmptyMessages: RunkoUIMessage[] = [userTextMessage("u1", "go")];
    const withEmptyDrain = await drainTurn(
      runTurn(turnOptions(buildModel(), { messages: withEmptyMessages, drainSteers: () => [] })),
    );

    expect(withEmptyDrain.chunks.map(fingerprintChunk)).toEqual(withoutDrain.chunks.map(fingerprintChunk));
    expect(withEmptyDrain.result.finalResponse).toBe(withoutDrain.result.finalResponse);
    expect(withEmptyDrain.result.usage).toEqual(withoutDrain.result.usage);
    expect(withEmptyMessages.map(fingerprintMessage)).toEqual(withoutMessages.map(fingerprintMessage));
  });
});
