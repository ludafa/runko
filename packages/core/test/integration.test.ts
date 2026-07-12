/**
 * Integration test with `@nimbo/virtual-fs` (devDependency, not a runtime dependency of
 * `@nimbo/core` — see `session.ts`'s header for why core can't construct file tools itself).
 * This file plays the "host" role that `@nimbo/sdk` will formalize in P7: it pre-constructs
 * `session.readState`/`session.derivedData`-equivalent stores via the exported factories
 * (`createSessionReadState`/`createDerivedDataCollector`), wires them into
 * `createFileTools({ readState, onFileChange })`, puts the resulting tools on
 * `agent.tools`, and only then calls `createSession(agent, { fs, readState, derivedData })`
 * — the ordering seam documented in `session.ts`'s `SessionOptions.readState`/`derivedData`
 * doc comment (added in this ticket specifically to make this wiring possible; `agent.tools`
 * is frozen at `createSession(...)` time, before which no `Session` object exists yet).
 */
import { describe, expect, it } from "vitest";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { createFileTools, fromMemory } from "@nimbo/virtual-fs";
import type { FileChange } from "@nimbo/virtual-fs";
import { createDerivedDataCollector, createSession, createSessionReadState, defineAgent } from "../src/index.js";
import type { AgentDefinition, DerivedDataCollector, SessionReadState } from "../src/index.js";
import type { SessionEvent, SessionItem } from "../src/index.js";

function mockModel(buildOptions: () => ConstructorParameters<typeof MockLanguageModelV4>[0]): MockLanguageModelV4 {
  return new MockLanguageModelV4(buildOptions());
}

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
} as const;

function toolCallChunk(toolCallId: string, toolName: string, input: unknown) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "tool-call" as const, toolCallId, toolName, input: JSON.stringify(input) },
        { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: undefined }, usage },
      ],
      initialDelayInMs: null,
      chunkDelayInMs: null,
    }),
  };
}

function stopChunk(text: string) {
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
function isFileChangeItem(item: SessionItem): item is Extract<SessionItem, { type: "file_change" }> {
  return item.type === "file_change";
}
function isPlanUpdateItem(item: SessionItem): item is Extract<SessionItem, { type: "plan_update" }> {
  return item.type === "plan_update";
}
function isToolCallItem(item: SessionItem): item is Extract<SessionItem, { type: "tool_call" }> {
  return item.type === "tool_call";
}

/**
 * File tools signal domain-level failures (e.g. read-before-write violations) via a normal
 * `{ isError: true, content }` return value (04-builtin-tools.md §0.5), not by throwing —
 * so the tool_call item's `status` is still `"completed"`; the failure shows up in `output`.
 * Narrows `output` (`ToolOutput = string | JsonValue`) down to that shape's `content` string
 * without a type assertion.
 */
function errorResultContent(output: Extract<SessionItem, { type: "tool_call" }>["output"]): string {
  if (typeof output !== "object" || output === null || Array.isArray(output)) return "";
  if (output.isError !== true) return "";
  return typeof output.content === "string" ? output.content : "";
}

/** The host-assembly pattern described in the file header, packaged for reuse across tests. */
function assembleFileToolsSession(
  model: MockLanguageModelV4,
  fs: ReturnType<typeof fromMemory>,
): { session: ReturnType<typeof createSession>; recordedChanges: FileChange[]; readState: SessionReadState; derivedData: DerivedDataCollector } {
  const readState = createSessionReadState();
  const derivedData = createDerivedDataCollector();
  const recordedChanges: FileChange[] = [];

  const fileTools = createFileTools({
    readState,
    onFileChange: (changes) => {
      recordedChanges.push(...changes);
      changes.forEach((change) => derivedData.recordFileChange(change));
    },
  });

  // `update_plan` (core's own builtin) is still auto-injected by `createSession` alongside these —
  // see the "coexists" test below, which relies on that default rather than adding it here.
  const agent: AgentDefinition = defineAgent({ model, tools: fileTools });
  const session = createSession(agent, { fs, readState, derivedData });
  return { session, recordedChanges, readState, derivedData };
}

describe("core session + @nimbo/virtual-fs file tools (host-assembled, P4-2 seam)", () => {
  it("write_file: the file_change item reaches the host, the fs is actually written, and readState is updated", async () => {
    const fs = fromMemory({});
    const model = mockModel(() => ({
      doStream: [toolCallChunk("call_1", "write_file", { path: "/a.txt", content: "hello" }), stopChunk("done")],
    }));

    const { session, recordedChanges, readState } = assembleFileToolsSession(model, fs);

    const events = await drainStream(session.stream("write the file"));

    const fileChangeItems = events.filter(isItemCompleted).map((e) => e.item).filter(isFileChangeItem);
    expect(fileChangeItems).toEqual([{ id: fileChangeItems[0]?.id, type: "file_change", changes: [{ path: "/a.txt", kind: "add" }] }]);
    expect(recordedChanges).toEqual([{ path: "/a.txt", kind: "add" }]);

    expect(new TextDecoder().decode(await fs.readFile("/a.txt"))).toBe("hello");
    expect(readState.get("/a.txt")).toBeDefined();

    const toolCallItems = events.filter(isItemCompleted).map((e) => e.item).filter(isToolCallItem);
    expect(toolCallItems[0]?.status).toBe("completed");
  });

  it("readState is shared session-wide: read_file then edit_file succeeds without re-reading; a never-read file still gets rejected", async () => {
    const fs = fromMemory({ "a.txt": "hello world", "b.txt": "untouched" });
    const model = mockModel(() => ({
      doStream: [
        toolCallChunk("call_1", "read_file", { path: "/a.txt" }),
        toolCallChunk("call_2", "edit_file", { path: "/a.txt", old_string: "world", new_string: "nimbo" }),
        stopChunk("edited"),
      ],
    }));

    const { session } = assembleFileToolsSession(model, fs);
    const events = await drainStream(session.stream("read then edit a.txt"));

    const toolCalls = events.filter(isItemCompleted).map((e) => e.item).filter(isToolCallItem);
    expect(toolCalls.map((item) => item.status)).toEqual(["completed", "completed"]);
    expect(new TextDecoder().decode(await fs.readFile("/a.txt"))).toBe("hello nimbo");

    // second turn on the SAME session: edit_file on a file that was never read in this session
    // (its readState entry is untouched) must still be rejected — proves readState enforcement
    // is real (not a no-op) and persists across the session's lifecycle, not just within one call.
    const secondModel = mockModel(() => ({
      doStream: [toolCallChunk("call_3", "edit_file", { path: "/b.txt", old_string: "untouched", new_string: "changed" }), stopChunk("done")],
    }));
    const { session: secondSession } = assembleFileToolsSession(secondModel, fs);
    const secondEvents = await drainStream(secondSession.stream("edit b.txt without reading it first"));
    const secondToolCalls = secondEvents.filter(isItemCompleted).map((e) => e.item).filter(isToolCallItem);
    // status stays "completed" (execute() returned normally) — the rejection is a structured
    // { isError: true, content } return value, not a thrown error (see errorResultContent above).
    expect(secondToolCalls[0]?.status).toBe("completed");
    expect(errorResultContent(secondToolCalls[0]?.output)).toContain("read_file");
    expect(new TextDecoder().decode(await fs.readFile("/b.txt"))).toBe("untouched"); // unchanged
  });

  it("update_plan (core's own builtin) coexists with externally injected file tools in the same turn", async () => {
    const fs = fromMemory({});
    const model = mockModel(() => ({
      doStream: [
        toolCallChunk("call_1", "update_plan", { items: [{ text: "write the file", completed: false }] }),
        toolCallChunk("call_2", "write_file", { path: "/notes.txt", content: "plan applied" }),
        stopChunk("done"),
      ],
    }));

    const { session } = assembleFileToolsSession(model, fs);
    const events = await drainStream(session.stream("plan then write"));

    const planItems = events.filter(isItemCompleted).map((e) => e.item).filter(isPlanUpdateItem);
    expect(planItems).toEqual([{ id: planItems[0]?.id, type: "plan_update", items: [{ text: "write the file", completed: false }] }]);

    const fileChangeItems = events.filter(isItemCompleted).map((e) => e.item).filter(isFileChangeItem);
    expect(fileChangeItems).toEqual([{ id: fileChangeItems[0]?.id, type: "file_change", changes: [{ path: "/notes.txt", kind: "add" }] }]);

    expect(new TextDecoder().decode(await fs.readFile("/notes.txt"))).toBe("plan applied");
  });
});
