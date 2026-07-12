/**
 * 07-streaming — consuming `session.stream()` live (docs/02-tech-spec.md
 * §4.2 `stream()`/`SessionEvent`, §4.3 event 翻译): `session.stream(input)`
 * returns an `AsyncGenerator<SessionEvent, TurnResult>` — every `yield` is a
 * `SessionEvent` the host can render as it happens (agent_message text
 * arriving delta-by-delta via `item.updated`, a `tool_call` item walking
 * `in_progress` -> `completed`, and a final `turn.completed` carrying
 * `usage`), while the generator's own `return` is the `TurnResult` — the
 * same value `session.send()` would have handed back had this been a
 * buffered call.
 *
 * Reaching that `return` value is the one non-obvious part: a plain
 * `for await (const event of session.stream(...))` only ever surfaces
 * *yielded* values — JS discards an async generator's `return` when driven
 * by `for-await`. This example instead drives the generator by hand with
 * `.next()` (the same idiom `Session.send()` uses internally on `stream()`,
 * see `packages/core/src/session.ts`), which is the only way to receive
 * both the live events *and* the final `TurnResult` from one `stream()` call.
 *
 * Demonstrates: `session.stream(input)`, `AsyncGenerator<SessionEvent,
 * TurnResult>` consumed via manual `.next()` driving, `item.started` /
 * `item.updated` / `item.completed` for `agent_message` (text deltas
 * rendered with `process.stdout.write`, no per-delta reprint) and
 * `tool_call` (`status: "in_progress"` -> `"completed"`), `turn.completed`'s
 * `usage`.
 *
 * Run: `node examples/07-streaming.ts` (see examples/README.md for setup).
 *
 * Expected output shape:
 *   1. A deterministic section (no model, no env vars needed): a
 *      `MockLanguageModelV4` (from `ai/test`, the same fixture style as
 *      `packages/core/test/loop.test.ts`) is scripted with two response
 *      steps — a few text deltas explaining the plan followed by a
 *      `write_file` tool call, then a final wrap-up message — run through
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
import type { SessionEvent, SessionItem, TurnResult } from "@nimbo/sdk";
import { resolveModel } from "./shared/model.ts";

/** Same literal shape as the `usage` fixture in packages/core/test/loop.test.ts —
 * MockLanguageModelV4's `finish` chunk requires one, its actual numbers don't matter here. */
const MOCK_USAGE = {
  inputTokens: { total: 12, noCache: 12, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 9, text: 9, reasoning: undefined },
};

/**
 * Two `doStream` steps — step 1 ends in `finishReason: "tool-calls"` so
 * `runTurn` executes `write_file` and loops for step 2, which ends in
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
              toolName: "write_file",
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

// ---- typed event/item formatting (no `any`/`unknown`, narrowed via `in`/discriminant checks) ----

function isItemEvent(event: SessionEvent): event is Extract<SessionEvent, { item: SessionItem }> {
  return "item" in event;
}

function formatItem(item: SessionItem): string {
  switch (item.type) {
    case "agent_message":
      return `agent_message id=${item.id} text=${JSON.stringify(item.text)}`;
    case "reasoning":
      return `reasoning id=${item.id} text=${JSON.stringify(item.text)}`;
    case "tool_call":
      return (
        `tool_call id=${item.id} toolName=${item.toolName} status=${item.status} input=${JSON.stringify(item.input)}` +
        (item.output !== undefined ? ` output=${JSON.stringify(item.output)}` : "")
      );
    case "file_change":
      return `file_change id=${item.id} changes=${JSON.stringify(item.changes)}`;
    case "plan_update":
      return `plan_update id=${item.id} items=${JSON.stringify(item.items)}`;
    case "error":
      return `error id=${item.id} message=${item.message}`;
  }
}

function formatEvent(event: SessionEvent): string {
  if (isItemEvent(event)) return `[${event.type}] ${formatItem(event.item)}`;
  switch (event.type) {
    case "session.started":
      return `[session.started] sessionId=${event.sessionId}`;
    case "turn.started":
      return `[turn.started] turn=${event.turn}`;
    case "turn.completed":
      return `[turn.completed] usage=${JSON.stringify(event.usage)}`;
    case "turn.failed":
      return `[turn.failed] code=${event.error.code} message=${event.error.message}`;
  }
}

/**
 * Drives `session.stream(...)` by hand (see header comment for why) and
 * prints a typed timeline live as events arrive. `agent_message` deltas are
 * the one special case: `item.updated` does *not* get its own timeline line
 * (that would reprint the whole accumulated string on every delta) — instead
 * only the new slice is written via `process.stdout.write`, which is what
 * makes it read as a typewriter instead of a log flood. Every other item
 * type (notably `tool_call`'s `in_progress` -> `completed` walk) always gets
 * a timeline line.
 *
 * `midLine` tracks whether the cursor is mid-typewriter-line (a raw
 * `process.stdout.write` with no trailing `\n` yet) — `logLine` closes that
 * line first if so, so a timeline line (e.g. the `write_file` tool call that
 * fires while text is still streaming) never gets glued onto the tail of a
 * delta instead of starting on its own line.
 */
async function streamAndPrint(stream: AsyncGenerator<SessionEvent, TurnResult>): Promise<TurnResult> {
  const typedSoFar = new Map<string, string>();
  let midLine = false;

  function logLine(text: string): void {
    if (midLine) {
      process.stdout.write("\n");
      midLine = false;
    }
    console.log(text);
  }

  function typeDelta(text: string): void {
    if (text.length === 0) return;
    process.stdout.write(text);
    midLine = true;
  }

  let step = await stream.next();
  while (!step.done) {
    const event = step.value;

    if (isItemEvent(event) && event.item.type === "agent_message") {
      const item = event.item;
      if (event.type === "item.started") {
        typedSoFar.set(item.id, "");
        logLine(`[item.started] agent_message id=${item.id} (streaming...)`);
      }
      const previous = typedSoFar.get(item.id) ?? "";
      typeDelta(item.text.slice(previous.length));
      typedSoFar.set(item.id, item.text);
      if (event.type === "item.completed") {
        logLine(`[item.completed] agent_message id=${item.id} text=${JSON.stringify(item.text)}`);
      }
    } else {
      logLine(formatEvent(event));
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
  console.log({ finalResponse: result.finalResponse, usage: result.usage, itemCount: result.items.length });
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
