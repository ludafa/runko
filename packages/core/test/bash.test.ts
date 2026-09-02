import { describe, expect, it, vi } from "vitest";
import { createBashTool } from "../src/tools/builtin/bash.js";
import type { ExecOptions, ExecRequest, ExecResult, RunkoExec, ToolContext } from "../src/types.js";

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    fs: {
      readFile: async () => new Uint8Array(),
      writeFile: async () => {},
      rm: async () => {},
      mkdir: async () => {},
      readdir: async () => [],
      stat: async () => ({ type: "file" }),
      glob: async () => [],
    },
    abortSignal: new AbortController().signal,
    callId: "call_1",
    session: { id: "sess_1", turn: 0 },
    getSkill: () => ({ file: () => ({ text: async () => "" }) }),
    update: () => {},
    ...overrides,
  };
}

function resultOf(exitCode: number, stdout: string, stderr: string): ExecResult {
  return { exitCode, stdout, stderr, durationMs: 1 };
}

/** A `RunkoExec` fake whose `exec()` is fully controllable per test (result, output chunks, or a reject). */
function fakeExec(opts: {
  result?: ExecResult | (() => Promise<ExecResult>);
  onOutputChunks?: { stream: "stdout" | "stderr"; data: string }[];
  rejectWith?: unknown;
  describe?: () => string;
  defaultApproval?: RunkoExec["defaultApproval"];
  captureRequest?: (req: ExecRequest) => void;
}): RunkoExec {
  return {
    describe: opts.describe,
    defaultApproval: opts.defaultApproval,
    exec: async (req: ExecRequest, execOpts?: ExecOptions): Promise<ExecResult> => {
      opts.captureRequest?.(req);
      if (opts.rejectWith !== undefined) {throw opts.rejectWith;}
      for (const chunk of opts.onOutputChunks ?? []) {execOpts?.onOutput?.(chunk);}
      if (typeof opts.result === "function") {return opts.result();}
      return opts.result ?? resultOf(0, "", "");
    },
  };
}

describe("createBashTool", () => {
  describe("description composition (§1.10 描述 = 基础描述 + exec.describe?.() 拼接)", () => {
    it("is a non-empty string built from the base description alone when describe() is not provided", () => {
      const tool = createBashTool({ exec: fakeExec({}) });
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.description).not.toContain("Execution environment");
    });

    it("appends exec.describe()'s output when provided", () => {
      const tool = createBashTool({ exec: fakeExec({ describe: () => "OS: linux; network: reachable" }) });
      expect(tool.description).toContain("OS: linux; network: reachable");
    });

    it("omits the environment section when describe() returns an empty/whitespace string", () => {
      const tool = createBashTool({ exec: fakeExec({ describe: () => "   " }) });
      expect(tool.description).not.toContain("Execution environment");
    });
  });

  describe("approval default (§1.10 取 exec.defaultApproval; docs/tech/single-ledger.md §6.1 三值重构 never→allow / always→review)", () => {
    it("uses exec.defaultApproval verbatim when declared 'allow'", () => {
      const tool = createBashTool({ exec: fakeExec({ defaultApproval: "allow" }) });
      expect(tool.approval).toBe("allow");
    });

    it("uses exec.defaultApproval verbatim when declared 'review'", () => {
      const tool = createBashTool({ exec: fakeExec({ defaultApproval: "review" }) });
      expect(tool.approval).toBe("review");
    });

    it("falls back to the conservative default 'review' when the implementation declares no defaultApproval", () => {
      const tool = createBashTool({ exec: fakeExec({}) });
      expect(tool.approval).toBe("review");
    });
  });

  describe("execute(): timeout/non-zero exit are normal results, not thrown errors (§1.10 / docs/tech/builtin-tools.md §4)", () => {
    it("formats a successful (exit 0) run with stdout and the exit code", async () => {
      const tool = createBashTool({ exec: fakeExec({ result: resultOf(0, "hello\n", "") }) });
      const output = await tool.execute({ command: "echo hello" }, makeCtx());
      expect(typeof output).toBe("string");
      expect(output).toContain("hello");
      expect(output).toContain("exit code: 0");
    });

    it("formats a non-zero exit as a normal (non-throwing) result carrying stderr", async () => {
      const tool = createBashTool({ exec: fakeExec({ result: resultOf(1, "", "boom: command failed") }) });
      const output = await tool.execute({ command: "false" }, makeCtx());
      expect(output).toContain("boom: command failed");
      expect(output).toContain("exit code: 1");
    });

    it("formats a timeout's exit code (124, mini-bash's convention) as a normal result", async () => {
      const tool = createBashTool({ exec: fakeExec({ result: resultOf(124, "", "mini-bash: command timed out after 10ms") }) });
      const output = await tool.execute({ command: "sleep 1", timeout_ms: 10 }, makeCtx());
      expect(output).toContain("exit code: 124");
      expect(output).toContain("timed out");
    });

    it("reports '(no output)' when both stdout and stderr are empty", async () => {
      const tool = createBashTool({ exec: fakeExec({ result: resultOf(0, "", "") }) });
      const output = await tool.execute({ command: "true" }, makeCtx());
      expect(output).toContain("(no output)");
      expect(output).toContain("exit code: 0");
    });
  });

  describe("64KB truncation per stream (§1.10 / 工单：各自 64KB 上限，截断标注 [truncated])", () => {
    it("truncates stdout over 64KB and marks it, without truncating a short stderr", async () => {
      const bigStdout = "x".repeat(80_000);
      const tool = createBashTool({ exec: fakeExec({ result: resultOf(0, bigStdout, "short stderr") }) });
      const output = await tool.execute({ command: "big" }, makeCtx());

      expect(typeof output).toBe("string");
      const text = typeof output === "string" ? output : "";
      expect(text).toContain("[truncated");
      expect(text).toContain("short stderr");
      // the stdout section itself must not exceed the 64KB budget (plus the short truncation notice).
      const stdoutSection = text.split("stderr:")[0] ?? "";
      expect(new TextEncoder().encode(stdoutSection).length).toBeLessThan(80_000);
    });

    it("truncates stderr independently of stdout", async () => {
      const bigStderr = "e".repeat(80_000);
      const tool = createBashTool({ exec: fakeExec({ result: resultOf(1, "short stdout", bigStderr) }) });
      const output = await tool.execute({ command: "big" }, makeCtx());
      const text = typeof output === "string" ? output : "";
      expect(text).toContain("[truncated");
      expect(text).toContain("short stdout");
    });

    it("does not truncate output at or under the 64KB budget", async () => {
      const exact = "y".repeat(65_536);
      const tool = createBashTool({ exec: fakeExec({ result: resultOf(0, exact, "") }) });
      const output = await tool.execute({ command: "exact" }, makeCtx());
      const text = typeof output === "string" ? output : "";
      expect(text).not.toContain("[truncated");
    });
  });

  describe("onOutput → ctx.update() (§1.10 / docs/tech/builtin-tools.md §4)", () => {
    it("forwards every onOutput chunk's data to ctx.update, in order", async () => {
      const update = vi.fn();
      const tool = createBashTool({
        exec: fakeExec({
          onOutputChunks: [
            { stream: "stdout", data: "chunk-1" },
            { stream: "stdout", data: "chunk-2" },
            { stream: "stderr", data: "chunk-3" },
          ],
          result: resultOf(0, "chunk-1chunk-2", "chunk-3"),
        }),
      });
      await tool.execute({ command: "streaming" }, makeCtx({ update }));

      expect(update).toHaveBeenNthCalledWith(1, "chunk-1");
      expect(update).toHaveBeenNthCalledWith(2, "chunk-2");
      expect(update).toHaveBeenNthCalledWith(3, "chunk-3");
    });

    it("does not call ctx.update when the implementation never invokes onOutput", async () => {
      const update = vi.fn();
      const tool = createBashTool({ exec: fakeExec({ result: resultOf(0, "done", "") }) });
      await tool.execute({ command: "quiet" }, makeCtx({ update }));
      expect(update).not.toHaveBeenCalled();
    });
  });

  describe("request mapping (input → ExecRequest)", () => {
    it("forwards command/cwd/timeout_ms and ctx.abortSignal to exec()", async () => {
      let captured: ExecRequest | undefined;
      const signal = new AbortController().signal;
      const tool = createBashTool({
        exec: fakeExec({ result: resultOf(0, "", ""), captureRequest: (req) => (captured = req) }),
      });
      await tool.execute({ command: "ls -la", cwd: "/work", timeout_ms: 5000 }, makeCtx({ abortSignal: signal }));

      expect(captured).toMatchObject({ command: "ls -la", cwd: "/work", timeoutMs: 5000, signal });
    });

    it("omits cwd/timeoutMs when not provided by the caller", async () => {
      let captured: ExecRequest | undefined;
      const tool = createBashTool({
        exec: fakeExec({ result: resultOf(0, "", ""), captureRequest: (req) => (captured = req) }),
      });
      await tool.execute({ command: "pwd" }, makeCtx());

      expect(captured?.cwd).toBeUndefined();
      expect(captured?.timeoutMs).toBeUndefined();
    });

    it("rejects malformed input via inputSchema (command missing)", () => {
      const tool = createBashTool({ exec: fakeExec({}) });
      const parsed = tool.inputSchema.safeParse({});
      expect(parsed.success).toBe(false);
    });
  });

  describe("exec() reject fallback (orchitector 接缝 a: 第三方 RunkoExec 可能不守'失败即 ExecResult'契约)", () => {
    it("does not throw when exec() rejects — resolves a structured isError result instead", async () => {
      const tool = createBashTool({ exec: fakeExec({ rejectWith: new Error("sandbox is down") }) });

      const output = await tool.execute({ command: "anything" }, makeCtx());

      expect(typeof output).toBe("object");
      if (typeof output === "object" && output !== null && !Array.isArray(output)) {
        expect(output.isError).toBe(true);
        expect(typeof output.content === "string" ? output.content : "").toContain("sandbox is down");
      }
    });

    it("handles a non-Error rejection value without throwing", async () => {
      const tool = createBashTool({ exec: fakeExec({ rejectWith: "raw string rejection" }) });
      const output = await tool.execute({ command: "anything" }, makeCtx());
      expect(typeof output).toBe("object");
      if (typeof output === "object" && output !== null && !Array.isArray(output)) {
        expect(typeof output.content === "string" ? output.content : "").toContain("raw string rejection");
      }
    });
  });
});
