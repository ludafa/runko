/**
 * `localExec` (P7-3 task 1, docs/tech/core-sdk.md §4.5a / docs/tech/builtin-tools.md §1.10).
 * Uses real `node -e "..."` invocations (cross-platform, safe, and always
 * available since these tests themselves run under Node) rather than shell
 * builtins that differ between /bin/sh and cmd.exe.
 */
import * as nodeFs from "node:fs/promises";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fromMemory } from "@nimbo/virtual-fs";
import { localExec } from "../../src/exec/local.js";
import type { ExecOutputChunk, ExecRequest } from "../../src/types.js";

function req(command: string, overrides: Partial<Omit<ExecRequest, "command">> = {}): ExecRequest {
  return { command, signal: new AbortController().signal, ...overrides };
}

function nodeEval(code: string): string {
  return `node -e "${code.replace(/"/g, '\\"')}"`;
}

describe("localExec()", () => {
  describe("defaultApproval (docs/tech/builtin-tools.md §1.10 出厂值; docs/tech/single-ledger.md §6.1 三值重构 always→review)", () => {
    it("is 'review', with materialize off", () => {
      expect(localExec().defaultApproval).toBe("review");
    });

    it("is still 'review' with materialize on (local exec has no sandboxing either way)", () => {
      const fs = fromMemory({});
      expect(localExec({ materialize: true, fs }).defaultApproval).toBe("review");
    });
  });

  describe("materialize: true requires fs (constructor-time guard, not exec()-time)", () => {
    it("throws synchronously when localExec() itself is called without fs", () => {
      expect(() => localExec({ materialize: true })).toThrow(/requires a NimboFS reference/);
    });

    it("does not throw when materialize is false/omitted, even without fs", () => {
      expect(() => localExec()).not.toThrow();
      expect(() => localExec({ materialize: false })).not.toThrow();
    });
  });

  describe("describe() (docs/tech/builtin-tools.md §1.10 环境自描述, ≤150 token 规格)", () => {
    it("includes the real OS platform/arch and the running Node version", () => {
      const description = localExec().describe?.() ?? "";
      expect(description).toContain(nodeOs.platform());
      expect(description).toContain(nodeOs.arch());
      expect(description).toContain(process.version);
    });

    it("describes mode C (fully decoupled) when materialize is off", () => {
      const description = localExec().describe?.() ?? "";
      expect(description).toContain("mode C");
      expect(description).not.toContain("mode B");
    });

    it("describes mode B (materialize/reconcile) when materialize is on", () => {
      const fs = fromMemory({});
      const description = localExec({ materialize: true, fs }).describe?.() ?? "";
      expect(description).toContain("mode B");
      expect(description).toContain("reconcil");
    });

    it("mentions network reachability (host machine, not a sandbox)", () => {
      const description = localExec().describe?.() ?? "";
      expect(description.toLowerCase()).toContain("network");
    });
  });

  describe("real execution (non-materialize, mode C)", () => {
    it("runs a real node subprocess and returns its stdout and exit code", async () => {
      const result = await localExec().exec(req(nodeEval("console.log(1 + 1)")));
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("2");
      expect(typeof result.durationMs).toBe("number");
    });

    it("captures a non-zero exit code without throwing", async () => {
      const result = await localExec().exec(req(nodeEval("process.exit(3)")));
      expect(result.exitCode).toBe(3);
    });

    it("captures stderr separately from stdout", async () => {
      const result = await localExec().exec(req(nodeEval("console.error('oops')")));
      expect(result.stderr).toContain("oops");
      expect(result.stdout).not.toContain("oops");
    });

    it("maps a self-inflicted signal termination to the POSIX 128+signal exit code convention", async () => {
      const result = await localExec().exec(req(nodeEval("process.kill(process.pid, 'SIGKILL')")));
      expect(result.exitCode).toBe(128 + nodeOs.constants.signals.SIGKILL);
    });

    it("never rejects even for a command that doesn't exist — resolves with a non-zero exit code", async () => {
      const result = await localExec().exec(req("this-command-does-not-exist-xyz-nimbo"));
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBeTypeOf("string");
      expect(result.stderr).toBeTypeOf("string");
    });

    it("never rejects even when cwd itself does not exist — resolves with a non-zero exit code and diagnostic stderr", async () => {
      const result = await localExec().exec(req("echo hi", { cwd: nodePath.join(nodeOs.tmpdir(), "nimbo-does-not-exist-xyz") }));
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.length).toBeGreaterThan(0);
    });

    it("forwards onOutput chunks for real subprocess output", async () => {
      const chunks: ExecOutputChunk[] = [];
      const result = await localExec().exec(req(nodeEval("process.stdout.write('hello-onOutput')")), {
        onOutput: (chunk) => chunks.push(chunk),
      });
      expect(result.stdout).toBe("hello-onOutput");
      expect(chunks.some((c) => c.stream === "stdout" && c.data.includes("hello-onOutput"))).toBe(true);
    });
  });

  describe("cwd resolution — mode C: real host path", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), "nimbo-local-exec-cwd-"));
    });

    afterEach(async () => {
      await nodeFs.rm(tmpDir, { recursive: true, force: true });
    });

    // `nodeFs.realpath()` (not just `nodePath.resolve()`) because on macOS `os.tmpdir()` sits under a
    // symlink (`/var` → `/private/var`) that the child's `process.cwd()` reports already resolved.
    it("uses opts.cwd as the default real cwd for every call", async () => {
      const exec = localExec({ cwd: tmpDir });
      const result = await exec.exec(req(nodeEval("console.log(process.cwd())")));
      expect(result.stdout.trim()).toBe(await nodeFs.realpath(tmpDir));
    });

    it("req.cwd overrides opts.cwd for that one call", async () => {
      const otherDir = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), "nimbo-local-exec-cwd-override-"));
      try {
        const exec = localExec({ cwd: tmpDir });
        const result = await exec.exec(req(nodeEval("console.log(process.cwd())"), { cwd: otherDir }));
        expect(result.stdout.trim()).toBe(await nodeFs.realpath(otherDir));
      } finally {
        await nodeFs.rm(otherDir, { recursive: true, force: true });
      }
    });

    it("defaults to process.cwd() when neither opts.cwd nor req.cwd is set", async () => {
      const result = await localExec().exec(req(nodeEval("console.log(process.cwd())")));
      expect(result.stdout.trim()).toBe(await nodeFs.realpath(process.cwd()));
    });
  });

  describe("timeout (§4.5a 实现契约: 超时不 reject)", () => {
    it("kills a long-running command after timeoutMs and reports exit code 124", async () => {
      const result = await localExec().exec(req(nodeEval("setTimeout(() => {}, 5000)"), { timeoutMs: 100 }));
      expect(result.exitCode).toBe(124);
    }, 10_000);

    it("does not time out a command that finishes well within the budget", async () => {
      const result = await localExec().exec(req(nodeEval("console.log('fast')"), { timeoutMs: 5000 }));
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("fast");
    });
  });

  describe("abort (§4.5a 实现契约: abort 不 reject)", () => {
    it("kills a running command when the signal aborts mid-flight and reports exit code 130", async () => {
      const controller = new AbortController();
      const promise = localExec().exec(req(nodeEval("setTimeout(() => {}, 5000)"), { signal: controller.signal }));
      setTimeout(() => controller.abort(), 50);
      const result = await promise;
      expect(result.exitCode).toBe(130);
    }, 10_000);

    it("resolves immediately (still 130) when the signal is already aborted before exec() is called", async () => {
      const controller = new AbortController();
      controller.abort();
      const result = await localExec().exec(req(nodeEval("setTimeout(() => {}, 5000)"), { signal: controller.signal }));
      expect(result.exitCode).toBe(130);
    }, 10_000);
  });

  describe("materialize round trip (mode B, §4.5a)", () => {
    it("a command's file writes are reconciled back into fs by mtime", async () => {
      const fs = fromMemory({ "a.txt": "original" });
      const exec = localExec({ materialize: true, fs });

      const result = await exec.exec(req(nodeEval("require('fs').writeFileSync('a.txt', 'modified-by-command')")));
      expect(result.exitCode).toBe(0);
      expect(new TextDecoder().decode(await fs.readFile("/a.txt"))).toBe("modified-by-command");
    });

    it("a new file created by the command is reconciled into fs", async () => {
      const fs = fromMemory({});
      const exec = localExec({ materialize: true, fs });

      await exec.exec(req(nodeEval("require('fs').writeFileSync('new.txt', 'created-by-command')")));
      expect(new TextDecoder().decode(await fs.readFile("/new.txt"))).toBe("created-by-command");
    });

    it("a file deleted by the command is removed from fs", async () => {
      const fs = fromMemory({ "gone.txt": "will be deleted" });
      const exec = localExec({ materialize: true, fs });

      await exec.exec(req(nodeEval("require('fs').unlinkSync('gone.txt')")));
      await expect(fs.stat("/gone.txt")).rejects.toThrow();
    });

    it("an entire directory deleted by the command removes every fs entry under it, without throwing", async () => {
      const fs = fromMemory({ "nested/a.txt": "one", "nested/deeper/b.txt": "two", "top-level.txt": "kept" });
      const exec = localExec({ materialize: true, fs });

      const result = await exec.exec(req(nodeEval("require('fs').rmSync('nested', { recursive: true })")));
      expect(result.exitCode).toBe(0);
      await expect(fs.stat("/nested/a.txt")).rejects.toThrow();
      await expect(fs.stat("/nested/deeper/b.txt")).rejects.toThrow();
      expect(new TextDecoder().decode(await fs.readFile("/top-level.txt"))).toBe("kept");
    });

    it("a file the command never touches is left untouched in fs", async () => {
      const fs = fromMemory({ "untouched.txt": "still here" });
      const exec = localExec({ materialize: true, fs });

      await exec.exec(req(nodeEval("1")));
      expect(new TextDecoder().decode(await fs.readFile("/untouched.txt"))).toBe("still here");
    });

    it("nested directories round-trip both ways (materialize preserves structure, reconcile finds nested writes)", async () => {
      const fs = fromMemory({ "nested/dir/file.txt": "deep" });
      const exec = localExec({ materialize: true, fs });

      const result = await exec.exec(req(nodeEval("console.log(require('fs').readFileSync('nested/dir/file.txt', 'utf8'))")));
      expect(result.stdout.trim()).toBe("deep");

      await exec.exec(req(nodeEval("require('fs').writeFileSync('nested/dir/other.txt', 'also deep')")));
      expect(new TextDecoder().decode(await fs.readFile("/nested/dir/other.txt"))).toBe("also deep");
    });

    it("req.cwd in materialize mode is a virtual path relative to the materialized fs root", async () => {
      const fs = fromMemory({ "sub/marker.txt": "found me" });
      const exec = localExec({ materialize: true, fs });

      const result = await exec.exec(req(nodeEval("console.log(require('fs').readFileSync('marker.txt', 'utf8'))"), { cwd: "/sub" }));
      expect(result.stdout.trim()).toBe("found me");
    });

    it("cleans up the temp directory after exec() resolves", async () => {
      const fs = fromMemory({});
      const exec = localExec({ materialize: true, fs });

      const result = await exec.exec(req(nodeEval("console.log(process.cwd())")));
      const capturedTmpDir = result.stdout.trim();
      expect(capturedTmpDir.length).toBeGreaterThan(0);
      await expect(nodeFs.stat(capturedTmpDir)).rejects.toThrow();
    });

    it("reference entries are not materialized (no local bytes) and do not break materialize/reconcile", async () => {
      const fs = fromMemory({ "a.txt": "plain file", "ref.bin": { ref: "https://example.com/asset" } });
      const exec = localExec({ materialize: true, fs });

      const result = await exec.exec(req(nodeEval("console.log(require('fs').existsSync('ref.bin'))")));
      expect(result.stdout.trim()).toBe("false");
      const stat = await fs.stat("/ref.bin");
      expect(stat.type).toBe("reference"); // untouched by materialize/reconcile
    });

    describe("symlinks are not reconciled (v1 convenience impl, not a security boundary — head comment)", () => {
      it("a symlink created by the command inside the temp dir is silently skipped, without failing the run", async () => {
        const fs = fromMemory({ "real.txt": "target content" });
        const exec = localExec({ materialize: true, fs });

        const result = await exec.exec(
          req(nodeEval("require('fs').symlinkSync('real.txt', 'link.txt'); console.log('done')")),
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe("done");
        await expect(fs.stat("/link.txt")).rejects.toThrow(); // never reconciled into fs
      });
    });
  });
});
