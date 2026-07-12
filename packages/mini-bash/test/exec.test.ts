import { fromMemory } from "@nimbo/virtual-fs";
import { describe, expect, it } from "vitest";
import { miniBash } from "../src/index.js";
import { collectOutput, makeHangingFs, run } from "./helpers.js";

function fixture() {
  return fromMemory({
    "/a.txt": "line1\nline2\nline3\n",
    "/work/sub/file.txt": "nested\n",
  });
}

describe("miniBash().exec", () => {
  it("runs a three-stage pipeline: left stdout feeds right stdin", async () => {
    const result = await run(fixture(), "cat /a.txt | grep -n line | head -n 2");
    expect(result).toEqual({ exitCode: 0, stdout: "1:line1\n2:line2\n", stderr: "", durationMs: expect.any(Number) });
  });

  it("pipeline exit code is the last command's exit code, even if an earlier stage found nothing", async () => {
    const result = await run(fixture(), "grep zzz /a.txt | echo done");
    expect(result.stdout).toBe("done\n");
    expect(result.exitCode).toBe(0);
  });

  it("resolves a relative path against the default cwd '/'", async () => {
    const result = await run(fixture(), "cat work/sub/file.txt");
    expect(result).toEqual({ exitCode: 0, stdout: "nested\n", stderr: "", durationMs: expect.any(Number) });
  });

  it("resolves a relative path against a custom cwd", async () => {
    const result = await run(fixture(), "cat sub/file.txt", { cwd: "/work" });
    expect(result).toEqual({ exitCode: 0, stdout: "nested\n", stderr: "", durationMs: expect.any(Number) });
  });

  it("the same relative path resolves to a different (missing) file under a different cwd", async () => {
    const result = await run(fixture(), "cat sub/file.txt", { cwd: "/" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No such file or directory");
  });

  it("resolves .. relative to cwd without throwing (clamped, not a security boundary here)", async () => {
    const result = await run(fixture(), "cat ../../a.txt", { cwd: "/work/sub" });
    expect(result).toEqual({ exitCode: 0, stdout: "line1\nline2\nline3\n", stderr: "", durationMs: expect.any(Number) });
  });

  it("clamps a .. that underflows the root instead of throwing", async () => {
    const result = await run(fixture(), "cat ../../../../a.txt", { cwd: "/work/sub" });
    expect(result).toEqual({ exitCode: 0, stdout: "line1\nline2\nline3\n", stderr: "", durationMs: expect.any(Number) });
  });

  it("an unknown command reports 'command not found' with exit code 127", async () => {
    const result = await run(fixture(), "nope /a.txt");
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toBe("nope: command not found");
    expect(result.stdout).toBe("");
  });

  it("an unknown command mid-pipeline is rejected before any stage runs", async () => {
    const result = await run(fixture(), "cat /a.txt | nope | head");
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toBe("nope: command not found");
  });

  it("unsupported syntax is reported as a normal ExecResult, not a thrown exception", async () => {
    const result = await run(fixture(), "cat /a.txt > out.txt");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("mini-bash 不支持重定向");
    expect(result.stdout).toBe("");
  });

  it("a pipe character inside quotes is not treated as a pipe end-to-end", async () => {
    const result = await run(fixture(), 'echo "a | b"');
    expect(result).toEqual({ exitCode: 0, stdout: "a | b\n", stderr: "", durationMs: expect.any(Number) });
  });

  it("streams onOutput chunks per stage as they complete (stderr per failing stage, stdout once for the pipeline result)", async () => {
    const { chunks, onOutput } = collectOutput();
    const result = await run(fixture(), "cat /nope.txt | echo fallback", { onOutput });
    expect(result.stdout).toBe("fallback\n");
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.some((c) => c.stream === "stderr" && c.data.includes("No such file or directory"))).toBe(true);
    expect(chunks.some((c) => c.stream === "stdout" && c.data === "fallback\n")).toBe(true);
  });

  it("does not call onOutput for empty streams", async () => {
    const { chunks, onOutput } = collectOutput();
    await run(fixture(), "cat /a.txt", { onOutput });
    expect(chunks).toEqual([{ stream: "stdout", data: "line1\nline2\nline3\n" }]);
  });

  describe("control operators: ; && || 2>&1", () => {
    describe(";", () => {
      it("runs every chain in order and concatenates stdout/stderr", async () => {
        const result = await run(fixture(), "echo a; echo b; echo c");
        expect(result.stdout).toBe("a\nb\nc\n");
        expect(result.stderr).toBe("");
        expect(result.exitCode).toBe(0);
      });

      it("exit code is the last chain's, even when an earlier chain fails", async () => {
        const result = await run(fixture(), "cat /nope.txt; echo done");
        expect(result.stdout).toBe("done\n");
        expect(result.stderr).toContain("No such file or directory");
        expect(result.exitCode).toBe(0);
      });

      it("exit code reflects the last chain even when it is the failing one", async () => {
        const result = await run(fixture(), "echo a; cat /nope.txt");
        expect(result.stdout).toBe("a\n");
        expect(result.stderr).toContain("No such file or directory");
        expect(result.exitCode).toBe(1);
      });

      it("later chains still run after an earlier chain's command is not found", async () => {
        const result = await run(fixture(), "nope; echo b");
        expect(result.stdout).toBe("b\n");
        expect(result.stderr).toBe("nope: command not found");
        expect(result.exitCode).toBe(0);
      });
    });

    describe("&&", () => {
      it("skips the next pipeline when the previous one fails (short-circuit, side-effect probe)", async () => {
        // grep finds nothing in /a.txt (exit 1) -> `cat /a.txt` must never run;
        // if it did, its distinctive output would show up in stdout.
        const result = await run(fixture(), "grep zzz /a.txt && cat /a.txt");
        expect(result.stdout).toBe("");
        expect(result.exitCode).toBe(1);
      });

      it("runs the next pipeline when the previous one succeeds", async () => {
        const result = await run(fixture(), "echo a && echo b");
        expect(result.stdout).toBe("a\nb\n");
        expect(result.exitCode).toBe(0);
      });
    });

    describe("||", () => {
      it("runs the next pipeline when the previous one fails", async () => {
        const result = await run(fixture(), "grep zzz /a.txt || echo fallback");
        expect(result.stdout).toBe("fallback\n");
        expect(result.exitCode).toBe(0);
      });

      it("skips the next pipeline when the previous one succeeds (reverse short-circuit, side-effect probe)", async () => {
        // echo a succeeds -> `cat /a.txt` must never run.
        const result = await run(fixture(), "echo a || cat /a.txt");
        expect(result.stdout).toBe("a\n");
        expect(result.exitCode).toBe(0);
      });
    });

    describe("&& / || mixed, left-associative", () => {
      it("false-like || echo a && echo b runs both echoes (status carries through)", async () => {
        const result = await run(fixture(), "grep zzz /a.txt || echo a && echo b");
        expect(result.stdout).toBe("a\nb\n");
        expect(result.exitCode).toBe(0);
      });

      it("a skipped middle link does not reset the carried status for the following operator", async () => {
        // grep fails (1) -> && skips "cat /a.txt" -> status is still grep's (1) ->
        // || runs the fallback. The skipped cat must leave no trace in stdout.
        const result = await run(fixture(), "grep zzz /a.txt && cat /a.txt || echo fallback");
        expect(result.stdout).toBe("fallback\n");
        expect(result.exitCode).toBe(0);
      });
    });

    describe("| binds tighter than && / ||", () => {
      it("cat a | grep x && echo found treats the pipeline as one unit that must fully succeed", async () => {
        const result = await run(fixture(), "cat /a.txt | grep line && echo found");
        expect(result.stdout).toBe("line1\nline2\nline3\nfound\n");
        expect(result.exitCode).toBe(0);
      });

      it("a failing pipeline (last stage exit) still short-circuits the && that follows it", async () => {
        const result = await run(fixture(), "cat /a.txt | grep zzz && echo found");
        expect(result.stdout).toBe("");
        expect(result.exitCode).toBe(1);
      });
    });

    describe("2>&1", () => {
      it("merges this command's stderr into its stdout", async () => {
        const result = await run(fixture(), "cat /nope.txt 2>&1");
        expect(result.stdout).toContain("No such file or directory");
        expect(result.stderr).toBe("");
      });

      it("lets a downstream pipeline stage read the merged stderr via stdin", async () => {
        const result = await run(fixture(), "cat /nope.txt 2>&1 | grep 'No such'");
        expect(result.stdout).toContain("No such file or directory");
        expect(result.stderr).toBe("");
        expect(result.exitCode).toBe(0);
      });

      it("without 2>&1, stderr still goes to stderr and is not merged into stdout", async () => {
        const result = await run(fixture(), "cat /nope.txt");
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("No such file or directory");
      });
    });
  });

  describe("timeout", () => {
    it("aborts a hung command after timeoutMs and returns a non-zero exit instead of hanging or throwing", async () => {
      const bash = miniBash(makeHangingFs());
      const result = await bash.exec({ command: "cat /slow.txt", timeoutMs: 20, signal: new AbortController().signal });
      expect(result.exitCode).toBe(124);
      expect(result.stderr).toContain("timed out");
      expect(result.stdout).toBe("");
    });
  });

  describe("abort", () => {
    it("returns promptly with a non-zero exit when the signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      const result = await run(fixture(), "cat /a.txt", { signal: controller.signal });
      expect(result.exitCode).toBe(130);
      expect(result.stderr).toContain("aborted");
    });

    it("stops promptly when aborted mid-flight against a fs call that never resolves", async () => {
      const controller = new AbortController();
      const bash = miniBash(makeHangingFs());
      const execPromise = bash.exec({ command: "cat /slow.txt", signal: controller.signal });
      setTimeout(() => controller.abort(), 10);
      const result = await execPromise;
      expect(result.exitCode).toBe(130);
      expect(result.stderr).toContain("aborted");
    });
  });

  it("exposes defaultApproval 'never'", () => {
    expect(miniBash(fixture()).defaultApproval).toBe("never");
  });

  it("describe() documents the eight commands, single-level pipe, and unsupported syntax", () => {
    const description = miniBash(fixture()).describe?.() ?? "";
    for (const cmd of ["cat", "grep", "find", "tail", "head", "echo", "cd", "pwd"]) {
      expect(description).toContain(cmd);
    }
    expect(description).toContain("管道");
    expect(description).toContain("NimboFS");
    expect(description).toMatch(/只读/);
    expect(description).toContain("重定向");
    expect(description).toContain("变量展开");
    expect(description).toMatch(/子 shell|命令替换/);
    expect(description).toContain(";");
    expect(description).toContain("&&");
    expect(description).toContain("||");
    expect(description).toContain("2>&1");
    expect(description).toContain("通配符");
    expect(description).toContain("write_file");
    expect(description).toContain("cat <file>");
  });

  it("describe() documents cd's persistence and pipe-subshell semantics", () => {
    const description = miniBash(fixture()).describe?.() ?? "";
    expect(description).toContain("cd -");
    expect(description).toContain("跨调用持久化");
    expect(description).toMatch(/子 shell/);
    expect(description).toContain("req.cwd");
  });
});
