/**
 * End-to-end wiring test for the `bash` builtin tool + `@nimbo/mini-bash`
 * (04-builtin-tools.md §4 bash 验收项 / tech-spec §4.5a). `@nimbo/mini-bash`
 * is a devDependency (not a runtime dependency of `@nimbo/core` — mirrors the
 * existing `@nimbo/virtual-fs` devDep pattern documented in `session.ts`'s
 * header): this file plays the "host" role, wiring `createSession(agent, {
 * fs, exec: miniBash(fs) })` / `{ workspace }` the way `@nimbo/sdk` (P7) will
 * formalize.
 *
 * 04 §4 bash 验收项逐条对应：
 *   1. 未注入 exec 时工具列表无 bash → "no bash tool ..." 用例
 *   2. 注入后出现 → 其余全部用例（bash 调用返回 completed，而不是 Unknown tool）
 *   3. 审批默认值来自 defaultApproval → "approval default" describe 块
 *   4. onOutput → item.updated → "onOutput chunks reach the host ..." 用例
 *   5. 超时/非零退出码正常回填（非 isError 崩溃）→ "timed-out or non-zero-exit" 用例
 */
import { describe, expect, it } from "vitest";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { createFileTools, fromMemory } from "@nimbo/virtual-fs";
import { miniBash } from "@nimbo/mini-bash";
import { createDerivedDataCollector, createSession, createSessionReadState, defineAgent } from "../src/index.js";
import type { AgentDefinition, NimboExec, NimboFS, SessionEvent, SessionItem } from "../src/index.js";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
} as const;

function toolCallStep(toolCallId: string, toolName: string, input: unknown) {
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

function stopStep(text: string) {
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

type Step = ReturnType<typeof toolCallStep> | ReturnType<typeof stopStep>;

function mockModel(steps: Step[]): MockLanguageModelV4 {
  return new MockLanguageModelV4({ doStream: steps });
}

function stopModel(text: string): MockLanguageModelV4 {
  return mockModel([stopStep(text)]);
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
function isItemUpdated(event: SessionEvent): event is { type: "item.updated"; item: SessionItem } {
  return event.type === "item.updated";
}
function isToolCallItem(item: SessionItem): item is Extract<SessionItem, { type: "tool_call" }> {
  return item.type === "tool_call";
}

function stringOutput(output: Extract<SessionItem, { type: "tool_call" }>["output"]): string {
  return typeof output === "string" ? output : "";
}

/** Same `{ isError, content }` narrowing pattern as `integration.test.ts`'s `errorResultContent`. */
function errorResultContent(output: Extract<SessionItem, { type: "tool_call" }>["output"]): string {
  if (typeof output !== "object" || output === null || Array.isArray(output)) return "";
  if (output.isError !== true) return "";
  return typeof output.content === "string" ? output.content : "";
}

describe("bash builtin + exec/workspace wiring (04 §4 / tech-spec §4.5a)", () => {
  it("no bash tool in the list when exec is not injected — the model's bash call comes back as Unknown tool", async () => {
    const model = mockModel([toolCallStep("call_1", "bash", { command: "echo hi" }), stopStep("done")]);
    const session = createSession(defineAgent({ model }));

    const events = await drainStream(session.stream("run something"));
    const toolCalls = events.filter(isItemCompleted).map((e) => e.item).filter(isToolCallItem);

    expect(toolCalls[0]?.status).toBe("failed");
    expect(stringOutput(toolCalls[0]?.output)).toContain("Unknown tool");
  });

  it("bash appears and runs directly once exec is injected — real mini-bash, whose defaultApproval is 'never'", async () => {
    const fs = fromMemory({ "greeting.txt": "hello from mini-bash\n" });
    const exec = miniBash(fs);
    const model = mockModel([toolCallStep("call_1", "bash", { command: "cat greeting.txt" }), stopStep("done")]);
    const session = createSession(defineAgent({ model }), { fs, exec });

    const events = await drainStream(session.stream("cat the file"));
    const toolCalls = events.filter(isItemCompleted).map((e) => e.item).filter(isToolCallItem);

    expect(toolCalls[0]?.status).toBe("completed");
    expect(stringOutput(toolCalls[0]?.output)).toContain("hello from mini-bash");
  });

  describe("approval default comes from exec.defaultApproval (§1.10)", () => {
    it("a NimboExec declaring defaultApproval:'always' is denied when no session onApproval is configured (no-arbiter deny)", async () => {
      const exec: NimboExec = {
        defaultApproval: "always",
        exec: async () => ({ exitCode: 0, stdout: "should not run", stderr: "", durationMs: 1 }),
      };
      const model = mockModel([toolCallStep("call_1", "bash", { command: "echo hi" }), stopStep("done")]);
      const session = createSession(defineAgent({ model }), { exec });

      const events = await drainStream(session.stream("run it"));
      const toolCalls = events.filter(isItemCompleted).map((e) => e.item).filter(isToolCallItem);

      expect(toolCalls[0]?.status).toBe("denied");
      expect(stringOutput(toolCalls[0]?.output)).toContain("no approver configured");
    });

    it("the same always-approval exec runs once a session onApproval:'never' backstop is configured", async () => {
      const exec: NimboExec = {
        defaultApproval: "always",
        exec: async () => ({ exitCode: 0, stdout: "ran", stderr: "", durationMs: 1 }),
      };
      const model = mockModel([toolCallStep("call_1", "bash", { command: "echo hi" }), stopStep("done")]);
      const session = createSession(defineAgent({ model }), { exec, onApproval: "never" });

      const events = await drainStream(session.stream("run it"));
      const toolCalls = events.filter(isItemCompleted).map((e) => e.item).filter(isToolCallItem);

      expect(toolCalls[0]?.status).toBe("completed");
      expect(stringOutput(toolCalls[0]?.output)).toContain("ran");
    });
  });

  it("onOutput chunks reach the host as item.updated (buffer-then-replay, P4-2), before item.completed", async () => {
    const exec: NimboExec = {
      defaultApproval: "never",
      exec: async (_req, opts) => {
        opts?.onOutput?.({ stream: "stdout", data: "progress-1" });
        opts?.onOutput?.({ stream: "stdout", data: "progress-2" });
        return { exitCode: 0, stdout: "progress-1progress-2", stderr: "", durationMs: 1 };
      },
    };
    const model = mockModel([toolCallStep("call_1", "bash", { command: "streaming" }), stopStep("done")]);
    const session = createSession(defineAgent({ model }), { exec });

    const events = await drainStream(session.stream("stream it"));
    const updated = events.filter(isItemUpdated).map((e) => e.item).filter(isToolCallItem);

    expect(updated.map((item) => item.output)).toEqual(["progress-1", "progress-1progress-2"]);
    expect(updated.every((item) => item.status === "in_progress")).toBe(true);

    const completed = events.filter(isItemCompleted).map((e) => e.item).filter(isToolCallItem);
    expect(completed[0]?.status).toBe("completed");
  });

  describe("timeout/non-zero exit backfill as a normal completed tool_call (04 §4, not isError/failed)", () => {
    it("a non-zero exit from real mini-bash (grep with no match, exit 1) is completed, not failed", async () => {
      const fs = fromMemory({ "a.txt": "hello\n" });
      const exec = miniBash(fs);
      const model = mockModel([toolCallStep("call_1", "bash", { command: "grep zzz a.txt" }), stopStep("done")]);
      const session = createSession(defineAgent({ model }), { fs, exec });

      const events = await drainStream(session.stream("grep it"));
      const toolCalls = events.filter(isItemCompleted).map((e) => e.item).filter(isToolCallItem);

      expect(toolCalls[0]?.status).toBe("completed");
      expect(stringOutput(toolCalls[0]?.output)).toContain("exit code: 1");
    });

    it("a timed-out ExecResult (exit 124, mini-bash's own convention) is completed, not failed", async () => {
      const exec: NimboExec = {
        defaultApproval: "never",
        exec: async () => ({ exitCode: 124, stdout: "", stderr: "mini-bash: command timed out after 5ms", durationMs: 5 }),
      };
      const model = mockModel([toolCallStep("call_1", "bash", { command: "sleep 1", timeout_ms: 5 }), stopStep("done")]);
      const session = createSession(defineAgent({ model }), { exec });

      const events = await drainStream(session.stream("run with a short timeout"));
      const toolCalls = events.filter(isItemCompleted).map((e) => e.item).filter(isToolCallItem);

      expect(toolCalls[0]?.status).toBe("completed");
      expect(stringOutput(toolCalls[0]?.output)).toContain("exit code: 124");
      expect(stringOutput(toolCalls[0]?.output)).toContain("timed out");
    });
  });
});

describe("SessionOptions.workspace syntax sugar (§4.5a 模式 A) and its exclusivity with fs/exec", () => {
  /**
   * A single object implementing `NimboFS & NimboExec` by delegating every method to a real
   * `MemoryFS` — this is the "one object translates every method faithfully" shape §4.5a mode A
   * describes for a real sandbox, kept minimal here since the point under test is session wiring
   * (which surface `workspace` feeds bash/fs from), not command semantics.
   */
  function fakeWorkspace(): NimboFS & NimboExec {
    const fs = fromMemory({});
    return {
      readFile: (path) => fs.readFile(path),
      writeFile: (path, data) => fs.writeFile(path, data),
      rm: (path, opts) => fs.rm(path, opts),
      mkdir: (path) => fs.mkdir(path),
      readdir: (path) => fs.readdir(path),
      stat: (path) => fs.stat(path),
      glob: (pattern) => fs.glob(pattern),
      defaultApproval: "never",
      exec: async () => ({ exitCode: 0, stdout: "from workspace exec", stderr: "", durationMs: 1 }),
    };
  }

  it("workspace + fs together throws a configuration error", () => {
    const workspace = fakeWorkspace();
    const fs = fromMemory({});
    const agent: AgentDefinition = defineAgent({ model: stopModel("x") });
    expect(() => createSession(agent, { workspace, fs })).toThrow(/mutually exclusive/);
  });

  it("workspace + exec together throws a configuration error", () => {
    const workspace = fakeWorkspace();
    const exec: NimboExec = { exec: async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 }) };
    const agent: AgentDefinition = defineAgent({ model: stopModel("x") });
    expect(() => createSession(agent, { workspace, exec })).toThrow(/mutually exclusive/);
  });

  it("workspace alone wires the same object as both session.fs and the bash tool's exec", async () => {
    const workspace = fakeWorkspace();
    const model = mockModel([toolCallStep("call_1", "bash", { command: "anything" }), stopStep("done")]);
    const session = createSession(defineAgent({ model }), { workspace });

    expect(session.fs).toBe(workspace);

    const events = await drainStream(session.stream("run"));
    const toolCalls = events.filter(isItemCompleted).map((e) => e.item).filter(isToolCallItem);
    expect(toolCalls[0]?.status).toBe("completed");
    expect(stringOutput(toolCalls[0]?.output)).toContain("from workspace exec");
  });
});

describe("mode A: same-source workspace, fs + exec: miniBash(fs) (tech-spec §4.5a)", () => {
  function assembleFileToolsSession(model: MockLanguageModelV4, fs: ReturnType<typeof fromMemory>, exec: NimboExec) {
    const readState = createSessionReadState();
    const derivedData = createDerivedDataCollector();
    const fileTools = createFileTools({
      readState,
      onFileChange: (changes) => changes.forEach((change) => derivedData.recordFileChange(change)),
    });
    const agent: AgentDefinition = defineAgent({ model, tools: fileTools });
    return createSession(agent, { fs, exec, readState, derivedData });
  }

  it("bash sees a file the agent just wrote via write_file — same fs, nothing to reconcile", async () => {
    const fs = fromMemory({});
    const exec = miniBash(fs);
    const model = mockModel([
      toolCallStep("call_1", "write_file", { path: "/note.txt", content: "hello from write_file" }),
      toolCallStep("call_2", "bash", { command: "cat note.txt" }),
      stopStep("done"),
    ]);
    const session = assembleFileToolsSession(model, fs, exec);

    const events = await drainStream(session.stream("write then cat"));
    const toolCalls = events.filter(isItemCompleted).map((e) => e.item).filter(isToolCallItem);

    expect(toolCalls[0]?.status).toBe("completed"); // write_file
    expect(toolCalls[1]?.status).toBe("completed"); // bash
    expect(stringOutput(toolCalls[1]?.output)).toContain("hello from write_file");
  });

  describe("readState invalidation on bash-bypass writes (04 §0.4 / §4.5a 模式 A 衍生规则 2)", () => {
    /**
     * Real mini-bash is entirely read-only (§4.5a: "全部命令跑在...只读"), so it cannot itself
     * produce a bash-made write to demonstrate this rule against. Per the ticket's own guidance
     * ("mini-bash 全只读，故用测试自写的可写 fake exec 或直接改 fs 模拟"), this is a small
     * self-authored writable `NimboExec` — its `exec()` writes straight to the shared `fs` for a
     * `write <path> <content>` pseudo-command, standing in for "bash actually touched the file",
     * so the test exercises the *real* bash tool (approval chain, ExecResult backfill, etc.) and
     * not just a raw `fs.writeFile` call.
     */
    function writableFakeExec(fs: NimboFS): NimboExec {
      return {
        defaultApproval: "never",
        exec: async (req) => {
          const match = /^write (\S+) (.*)$/s.exec(req.command);
          if (match === null) return { exitCode: 127, stdout: "", stderr: `unsupported: ${req.command}`, durationMs: 1 };
          const [, path, content] = match;
          if (path === undefined) return { exitCode: 2, stdout: "", stderr: "missing path", durationMs: 1 };
          await fs.writeFile(path, content ?? "");
          return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
        },
      };
    }

    it("a bash-made write invalidates readState — a subsequent edit_file on that path is rejected until re-read", async () => {
      const fs = fromMemory({ "a.txt": "hello" });
      const exec = writableFakeExec(fs);
      const model = mockModel([
        toolCallStep("call_1", "read_file", { path: "/a.txt" }),
        toolCallStep("call_2", "bash", { command: "write /a.txt changed-by-bash" }),
        toolCallStep("call_3", "edit_file", { path: "/a.txt", old_string: "hello", new_string: "nope" }),
        stopStep("done"),
      ]);
      const session = assembleFileToolsSession(model, fs, exec);

      const events = await drainStream(session.stream("read, bash-write, then try to edit_file"));
      const toolCalls = events.filter(isItemCompleted).map((e) => e.item).filter(isToolCallItem);

      expect(toolCalls[0]?.status).toBe("completed"); // read_file
      expect(toolCalls[1]?.status).toBe("completed"); // bash write (a normal ExecResult, exit 0)
      // edit_file's execute() itself returns normally with an { isError: true, content } value
      // (04 §0.5) — status stays "completed", the rejection shows up in output (same pattern as
      // integration.test.ts's errorResultContent).
      expect(toolCalls[2]?.status).toBe("completed");
      expect(errorResultContent(toolCalls[2]?.output)).toContain("changed since it was last read");

      expect(new TextDecoder().decode(await fs.readFile("/a.txt"))).toBe("changed-by-bash");
    });
  });
});
