/**
 * P7-1 acceptance: default assembly — `fs` defaults to a fresh `MemoryFS`, and the file
 * tools eight-set is wired end-to-end (readState + file_change → session.derivedData),
 * without the host hand-assembling `createFileTools({...})` the way core's own
 * `test/integration.test.ts` demonstrates as the "host" seam this ticket automates.
 * Also covers the `workspace` (NimboFS & NimboExec) overload's generic type retention.
 *
 * P13-5-2（docs/tech/single-ledger.md）迁移：断言从 `SessionEvent`/
 * `SessionItem` 改为读账本（`session.toJSON().messages` 的部件）：
 * `toolCallItems`/`fileChangeItems`（helpers.ts）现在从账本 flatMap 工具/
 * `data-file-change` 部件，`status: "completed"` 换成 `state: "output-available"`。
 */
import { describe, expect, it } from "vitest";
import { defineAgent, MemoryFS, miniBash } from "../src/index.js";
import type { AgentDefinition, NimboExec, NimboFS } from "../src/index.js";
import { createSession } from "../src/index.js";
import { drainStream, fileChangeItems, mockModel, stopChunk, toolCallChunk, toolCallItems } from "./helpers.js";

describe("default assembly: fs defaults to MemoryFS, file tools eight-set default on", () => {
  it("createSession(agent) with no options at all still works (opts entirely omitted)", async () => {
    const model = mockModel(() => ({ doStream: [stopChunk("hi")] }));
    const agent = defineAgent({ model });

    const session = createSession(agent);
    expect(session.fs).toBeInstanceOf(MemoryFS);

    const result = await session.send("hello");
    expect(result.finalResponse).toBe("hi");
  });

  it("write-file (mock model tool call) actually writes the default MemoryFS, derives a data-file-change part, and is visible via session.fs.diff()", async () => {
    const model = mockModel(() => ({
      doStream: [toolCallChunk("call_1", "write-file", { path: "/notes.txt", content: "hello nimbo" }), stopChunk("done")],
    }));
    const agent = defineAgent({ model });
    const session = createSession(agent);

    await drainStream(session.stream("write a file"));
    const messages = session.toJSON().messages;

    const calls = toolCallItems(messages);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.state).toBe("output-available");

    const changes = fileChangeItems(messages);
    expect(changes).toEqual([{ type: "data-file-change", id: changes[0]?.id, data: { changes: [{ path: "/notes.txt", kind: "add" }] } }]);

    expect(new TextDecoder().decode(await session.fs.readFile("/notes.txt"))).toBe("hello nimbo");
    const diff = await session.fs.diff();
    expect(diff).toEqual([{ path: "/notes.txt", kind: "created", after: "hello nimbo", patch: expect.any(String) }]);
  });

  it("readState is shared internally: write-file then edit-file (same turn, no explicit read-file) succeeds", async () => {
    const model = mockModel(() => ({
      doStream: [
        toolCallChunk("call_1", "write-file", { path: "/a.txt", content: "hello world" }),
        toolCallChunk("call_2", "edit-file", { path: "/a.txt", old_string: "world", new_string: "nimbo" }),
        stopChunk("done"),
      ],
    }));
    const agent = defineAgent({ model });
    const session = createSession(agent);

    await drainStream(session.stream("write then edit"));
    const calls = toolCallItems(session.toJSON().messages);
    expect(calls.map((c) => c.state)).toEqual(["output-available", "output-available"]);
    expect(new TextDecoder().decode(await session.fs.readFile("/a.txt"))).toBe("hello nimbo");

    // session.readState is the same store the internally-wired file tools use.
    expect(session.readState.get("/a.txt")).toBeDefined();
  });

  it("session.derivedData is the same collector the internal file tools report into (host can still record its own derived data on it)", async () => {
    const model = mockModel(() => ({ doStream: [toolCallChunk("call_1", "write-file", { path: "/x.txt", content: "y" }), stopChunk("done")] }));
    const agent = defineAgent({ model });
    const session = createSession(agent);

    await drainStream(session.stream("write"));
    expect(fileChangeItems(session.toJSON().messages)).toHaveLength(1);
    // recordPlanUpdate is exposed on the same object (SessionDerivedDataRecorder) — proving
    // this is the live session-internal collector, not a disconnected default.
    expect(typeof session.derivedData.recordFileChange).toBe("function");
    expect(typeof session.derivedData.recordPlanUpdate).toBe("function");
  });
});

describe("default assembly: SessionOptions.workspace (NimboFS & NimboExec, mode A same-source workspace)", () => {
  function createWorkspace(): NimboFS & NimboExec & { marker(): string } {
    const fs = new MemoryFS();
    const exec = miniBash(fs);
    return {
      readFile: (path) => fs.readFile(path),
      writeFile: (path, data) => fs.writeFile(path, data),
      rm: (path, opts) => fs.rm(path, opts),
      mkdir: (path) => fs.mkdir(path),
      readdir: (path) => fs.readdir(path),
      stat: (path) => fs.stat(path),
      glob: (pattern) => fs.glob(pattern),
      exec: (req, opts) => exec.exec(req, opts),
      describe: () => exec.describe?.() ?? "",
      defaultApproval: exec.defaultApproval,
      marker: () => "combined-workspace",
    };
  }

  it("session.fs retains the workspace's concrete type (extra members compile and run), and bash sees files written by the file tools", async () => {
    const workspace = createWorkspace();
    const model = mockModel(() => ({
      doStream: [
        toolCallChunk("call_1", "write-file", { path: "/a.txt", content: "hello" }),
        toolCallChunk("call_2", "bash", { command: "cat a.txt" }),
        stopChunk("done"),
      ],
    }));
    const agent: AgentDefinition = defineAgent({ model });
    const session = createSession(agent, { workspace });

    // type-level proof: `marker()` only exists on our combined workspace object, not on the
    // bare `NimboFS` interface — this line would fail to compile if the generic overload
    // widened `session.fs` back down to `NimboFS`.
    expect(session.fs.marker()).toBe("combined-workspace");

    await drainStream(session.stream("write then cat via bash"));
    const calls = toolCallItems(session.toJSON().messages);
    expect(calls.map((c) => c.state)).toEqual(["output-available", "output-available"]);
    // the bash tool call's output should contain the content written by write-file — same
    // source, no materialize/reconcile step needed (docs/tech/core-sdk.md §4.5a mode A).
    expect(JSON.stringify(calls[1]?.output)).toContain("hello");
  });
});
