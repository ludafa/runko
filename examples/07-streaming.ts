/**
 * 07-streaming — consuming `session.stream()` live (docs/tech/single-ledger.md
 * §5 单账本): `session.stream(input)` returns an
 * `AsyncGenerator<NimboChunk, TurnResult>` — every `yield` is a `NimboChunk`
 * (ai 的 `UIMessageChunk` 词汇表，对 `NimboUIMessage` 实例化) the host can
 * render as it happens (assistant text arriving delta-by-delta via
 * `text-delta`, a tool call walking `tool-input-available` ->
 * `tool-output-available`, plus `start`/`finish` and `data-*` parts), while
 * the generator's own `return` is the `TurnResult` — the same value
 * `session.send()` would have handed back had this been a buffered call.
 *
 * Reaching that `return` value is the one non-obvious part: a plain
 * `for await (const event of session.stream(...))` only ever surfaces
 * *yielded* values — JS discards an async generator's `return` when driven
 * by `for-await`. This example instead drives the generator by hand with
 * `.next()` (the same idiom `Session.send()` uses internally on `stream()`,
 * see `packages/core/src/session.ts`), which is the only way to receive
 * both the live events *and* the final `TurnResult` from one `stream()` call.
 *
 * Demonstrates: `session.stream(input)`, `AsyncGenerator<NimboChunk,
 * TurnResult>` consumed via manual `.next()` driving, `text-delta` rendered
 * as a typewriter (`process.stdout.write`, no per-delta reprint), tool chunks
 * (`tool-input-available` -> `tool-output-available`), and the `TurnResult`
 * (`finalResponse`/`usage`) recovered from the generator's `return`.
 *
 * Run: `node examples/07-streaming.ts` (see examples/README.md for setup).
 *
 * Expected output shape:
 *   1. A deterministic section (no model, no env vars needed): a
 *      `MockLanguageModelV4` (from `ai/test`, the same fixture style as
 *      `packages/core/test/loop.test.ts`) is scripted with two response
 *      steps — a few text deltas explaining the plan followed by a
 *      `write-file` tool call, then a final wrap-up message — run through
 *      the real `createSession()` + `stream()` pipeline (`@nimbo/sdk`'s
 *      default file tools, an in-memory `NimboFS`). Every event prints as a
 *      typed timeline line (`[event.type] ...`); the agent_message deltas
 *      additionally render as a typewriter effect via `process.stdout.write`
 *      instead of being reprinted whole on every `item.updated`.
 *   2. If NIMBO_MODEL is set: the same `stream()` + manual-drive loop against
 *      a real model asked to write a short file — the terminal shows a live
 *      typewriter response interleaved with real `tool_call` events as they
 *      happen, not replayed after the fact. If NIMBO_MODEL is unset, this
 *      section is skipped with a clean exit.
 */
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { createSession, defineAgent, NimboFS } from "@nimbo/sdk";
import type { NimboChunk, TurnResult } from "@nimbo/sdk";
import { resolveModel } from "./shared/model.ts";

/** Same literal shape as the `usage` fixture in packages/core/test/loop.test.ts —
 * MockLanguageModelV4's `finish` chunk requires one, its actual numbers don't matter here. */
const MOCK_USAGE = {
  inputTokens: { total: 12, noCache: 12, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 9, text: 9, reasoning: undefined },
};

/**
 * Two `doStream` steps — step 1 ends in `finishReason: "tool-calls"` so
 * `runTurn` executes `write-file` and loops for step 2, which ends in
 * `"stop"` and closes the turn. Same two-step shape as the existing
 * `runTurn` multi-step test in packages/core/test/loop.test.ts.
 */
function buildMockModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: [
      {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "I'll " },
            { type: "text-delta", id: "t1", delta: "create " },
            { type: "text-delta", id: "t1", delta: "notes.txt for you." },
            { type: "text-end", id: "t1" },
            {
              type: "tool-call",
              toolCallId: "call_1",
              toolName: "write-file",
              input: JSON.stringify({ path: "/notes.txt", content: "hello from nimbo\n" }),
            },
            { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: MOCK_USAGE },
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
            { type: "text-delta", id: "t2", delta: "Done" },
            { type: "text-delta", id: "t2", delta: " — notes.txt is written." },
            { type: "text-end", id: "t2" },
            { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: MOCK_USAGE },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      },
    ],
  });
}

// ---- typed chunk formatting (NimboChunk = ai 的 UIMessageChunk 词汇表，对 NimboUIMessage 实例化) ----

/**
 * One display line per `NimboChunk`. Handles the chunk types this demo
 * actually produces; the `default` catch-all keeps it total over ai's
 * open-ended `UIMessageChunk` union (any other chunk just prints its bare
 * `type`), so no exhaustiveness burden as the vocabulary grows. Text deltas
 * are handled separately in `streamAndPrint` (typewriter), so they never
 * reach here.
 */
function formatChunk(chunk: NimboChunk): string {
  switch (chunk.type) {
    case "text-start":
      return `[text-start] id=${chunk.id}`;
    case "text-end":
      return `[text-end] id=${chunk.id}`;
    case "tool-input-available":
      return `[tool-input-available] ${chunk.toolName} callId=${chunk.toolCallId} input=${JSON.stringify(chunk.input)}`;
    case "tool-output-available":
      return `[tool-output-available] callId=${chunk.toolCallId} output=${JSON.stringify(chunk.output)}`;
    default:
      return `[${chunk.type}]`;
  }
}

/**
 * Drives `session.stream(...)` by hand (see header comment for why) and
 * prints a typed timeline live as chunks arrive. `text-delta` chunks are the
 * one special case: instead of a timeline line per delta (a log flood), only
 * the new slice is written via `process.stdout.write`, which reads as a
 * typewriter. Every other chunk (notably `tool-input-available` /
 * `tool-output-available`) gets its own `formatChunk` line.
 *
 * `midLine` tracks whether the cursor is mid-typewriter-line (a raw
 * `process.stdout.write` with no trailing `\n` yet) — `logLine` closes that
 * line first if so, so a timeline line (e.g. the `write-file` tool call that
 * fires while text is still streaming) never gets glued onto the tail of a
 * delta instead of starting on its own line.
 */
async function streamAndPrint(stream: AsyncGenerator<NimboChunk, TurnResult>): Promise<TurnResult> {
  let midLine = false;

  function logLine(text: string): void {
    if (midLine) {
      process.stdout.write("\n");
      midLine = false;
    }
    console.log(text);
  }

  let step = await stream.next();
  while (!step.done) {
    const chunk = step.value;

    if (chunk.type === "text-delta") {
      if (chunk.delta.length > 0) {
        process.stdout.write(chunk.delta);
        midLine = true;
      }
    } else {
      logLine(formatChunk(chunk));
    }

    step = await stream.next();
  }

  return step.value;
}

async function deterministicSection(): Promise<void> {
  console.log("--- 1. session.stream() consumed live against a scripted MockLanguageModelV4 ---\n");

  const agent = defineAgent({ model: buildMockModel() });
  const session = createSession(agent, { fs: NimboFS.fromMemory({}) });

  const result = await streamAndPrint(session.stream("写一个 /notes.txt 文件，内容随意，然后确认完成。"));

  console.log("\nTurnResult — the generator's own `return` value, recovered via manual `.next()` driving:");
  console.log({
    finalResponse: result.finalResponse,
    usage: result.usage,
    messages: session.toJSON().messages.length,
  });
}

async function modelDrivenSection(): Promise<void> {
  const model = resolveModel();

  console.log("\n--- 2. same stream() + manual-drive loop against a real model ---\n");

  const agent = defineAgent({ model });
  const session = createSession(agent, { fs: NimboFS.fromMemory({}) });

  const result = await streamAndPrint(
    session.stream("创建 /streaming-demo.txt，写一句你喜欢的技术格言，然后确认完成。"),
  );

  console.log("\nfinalResponse:", result.finalResponse);
}

await deterministicSection();
await modelDrivenSection();
