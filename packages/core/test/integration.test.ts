/**
 * Integration test with `@runko/virtual-fs` (devDependency, not a runtime dependency of
 * `@runko/core` — see `session.ts`'s header for why core can't construct file tools itself).
 * This file plays the "host" role that `@runko/sdk` will formalize in P7: it pre-constructs
 * `session.readState`/`session.derivedData`-equivalent stores via the exported factories
 * (`createSessionReadState`/`createDerivedDataCollector`), wires them into
 * `createFileTools({ readState, onFileChange })`, puts the resulting tools on
 * `agent.tools`, and only then calls `createSession(agent, { fs, readState, derivedData })`
 * — the ordering seam documented in `session.ts`'s `SessionOptions.readState`/`derivedData`
 * doc comment (added in this ticket specifically to make this wiring possible; `agent.tools`
 * is frozen at `createSession(...)` time, before which no `Session` object exists yet).
 *
 * P13-5-2（docs/tech/single-ledger.md）迁移：断言从 `SessionEvent`/
 * `SessionItem` 改为读账本（`session.toJSON().messages` 的部件），`file_change`/
 * `plan_update` 由 `data-file-change`（逐条追加）/`data-plan-update`（同 id
 * 覆盖）两个 data 部件承载。
 */
import { describe, expect, it } from "vitest";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { createFileTools, fromMemory } from "@runko/virtual-fs";
import type { FileChange } from "@runko/virtual-fs";
import { createDerivedDataCollector, createSession, createSessionReadState, defineAgent } from "../src/index.js";
import type { AgentDefinition, DerivedDataCollector, SessionReadState } from "../src/index.js";
import { allToolParts, drainTurn, fileChangeParts, planUpdateParts } from "./helpers/runko-chunks.js";

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

/**
 * File tools signal domain-level failures (e.g. read-before-write violations) via a normal
 * `{ isError: true, content }` return value (docs/tech/builtin-tools.md §0.5), not by throwing —
 * so the tool part still settles to `state: "output-available"`; the failure shows up in
 * `output`. Narrows the tool part's `output` (`unknown` — TOOLS type param default, see
 * `state.ts`'s `RunkoUIMessage` header) down to that shape's `content` string without a type
 * assertion.
 */
function errorResultContent(output: unknown): string {
  if (typeof output !== "object" || output === null || Array.isArray(output)) {return "";}
  if (!("isError" in output) || output.isError !== true) {return "";}
  if (!("content" in output)) {return "";}
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

  // `update-plan` (core's own builtin) is still auto-injected by `createSession` alongside these —
  // see the "coexists" test below, which relies on that default rather than adding it here.
  const agent: AgentDefinition = defineAgent({ model, tools: fileTools });
  const session = createSession(agent, { fs, readState, derivedData });
  return { session, recordedChanges, readState, derivedData };
}

describe("core session + @runko/virtual-fs file tools (host-assembled, P4-2 seam)", () => {
  it("write-file: the data-file-change part reaches the ledger, the fs is actually written, and readState is updated", async () => {
    const fs = fromMemory({});
    const model = mockModel(() => ({
      doStream: [toolCallChunk("call_1", "write-file", { path: "/a.txt", content: "hello" }), stopChunk("done")],
    }));

    const { session, recordedChanges, readState } = assembleFileToolsSession(model, fs);

    await drainTurn(session.stream("write the file"));
    const messages = session.toJSON().messages;

    const changeParts = messages.flatMap(fileChangeParts);
    expect(changeParts).toEqual([{ type: "data-file-change", id: changeParts[0]?.id, data: { changes: [{ path: "/a.txt", kind: "add" }] } }]);
    expect(recordedChanges).toEqual([{ path: "/a.txt", kind: "add" }]);

    expect(new TextDecoder().decode(await fs.readFile("/a.txt"))).toBe("hello");
    expect(readState.get("/a.txt")).toBeDefined();

    const toolCalls = allToolParts(messages);
    expect(toolCalls[0]).toMatchObject({ state: "output-available" });
  });

  it("readState is shared session-wide: read-file then edit-file succeeds without re-reading; a never-read file still gets rejected", async () => {
    const fs = fromMemory({ "a.txt": "hello world", "b.txt": "untouched" });
    const model = mockModel(() => ({
      doStream: [
        toolCallChunk("call_1", "read-file", { path: "/a.txt" }),
        toolCallChunk("call_2", "edit-file", { path: "/a.txt", old_string: "world", new_string: "runko" }),
        stopChunk("edited"),
      ],
    }));

    const { session } = assembleFileToolsSession(model, fs);
    await drainTurn(session.stream("read then edit a.txt"));

    const toolCalls = allToolParts(session.toJSON().messages);
    expect(toolCalls.map((part) => part.state)).toEqual(["output-available", "output-available"]);
    expect(new TextDecoder().decode(await fs.readFile("/a.txt"))).toBe("hello runko");

    // second turn on the SAME session: edit-file on a file that was never read in this session
    // (its readState entry is untouched) must still be rejected — proves readState enforcement
    // is real (not a no-op) and persists across the session's lifecycle, not just within one call.
    const secondModel = mockModel(() => ({
      doStream: [toolCallChunk("call_3", "edit-file", { path: "/b.txt", old_string: "untouched", new_string: "changed" }), stopChunk("done")],
    }));
    const { session: secondSession } = assembleFileToolsSession(secondModel, fs);
    await drainTurn(secondSession.stream("edit b.txt without reading it first"));
    const secondToolCalls = allToolParts(secondSession.toJSON().messages);
    // state stays "output-available" (execute() returned normally) — the rejection is a
    // structured { isError: true, content } return value, not a thrown error (see
    // errorResultContent above).
    expect(secondToolCalls[0]?.state).toBe("output-available");
    expect(errorResultContent(secondToolCalls[0]?.output)).toContain("read-file");
    expect(new TextDecoder().decode(await fs.readFile("/b.txt"))).toBe("untouched"); // unchanged
  });

  it("update-plan (core's own builtin) coexists with externally injected file tools in the same turn", async () => {
    const fs = fromMemory({});
    const model = mockModel(() => ({
      doStream: [
        toolCallChunk("call_1", "update-plan", { items: [{ text: "write the file", completed: false }] }),
        toolCallChunk("call_2", "write-file", { path: "/notes.txt", content: "plan applied" }),
        stopChunk("done"),
      ],
    }));

    const { session } = assembleFileToolsSession(model, fs);
    await drainTurn(session.stream("plan then write"));
    const messages = session.toJSON().messages;

    const planParts = messages.flatMap(planUpdateParts);
    expect(planParts).toEqual([
      { type: "data-plan-update", id: "plan-update", data: { items: [{ text: "write the file", completed: false }] } },
    ]);

    const changeParts = messages.flatMap(fileChangeParts);
    expect(changeParts).toEqual([
      { type: "data-file-change", id: changeParts[0]?.id, data: { changes: [{ path: "/notes.txt", kind: "add" }] } },
    ]);

    expect(new TextDecoder().decode(await fs.readFile("/notes.txt"))).toBe("plan applied");
  });
});
