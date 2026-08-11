/**
 * NimboExec 契约（docs/host/sandbox/tech.md §3.2 / §8.2 Vercel 列）：`bash -lc` 单 argv 传递
 * （零拼接）、Writable 分片 → onOutput 顺序、超时 124 / 中止 130 的区分、
 * P6-1（全部失败路径 resolve 非零而不 reject——含 SDK 抛出真实异常这条），
 * `defaultApproval`/`describe()` 表面。
 */
import type { ExecOutputChunk } from "@nimbo/core";
import { describe, expect, it } from "vitest";
import { vercelWorkspace } from "../src/index.js";
import { FakeVercelSandbox, writeChunks } from "./helpers.js";

function newSignal(): AbortSignal {
  return new AbortController().signal;
}

describe("NimboExec surface", () => {
  it("exposes defaultApproval 'allow'", () => {
    const ws = vercelWorkspace(new FakeVercelSandbox());
    expect(ws.defaultApproval).toBe("allow");
  });

  it("describe() declares the real-Linux/Firecracker environment, sudo, bash -lc, root anchoring vs. bash's unconfined reach, and the RTT cost of fs tools", () => {
    const description = vercelWorkspace(new FakeVercelSandbox()).describe?.() ?? "";
    expect(description).toMatch(/firecracker/i);
    expect(description).toMatch(/amazon linux/i);
    expect(description).toMatch(/sudo/i);
    expect(description).toContain("bash -lc");
    expect(description).toMatch(/root/i);
    expect(description).toMatch(/not confined|not.*confined/i);
    expect(description).toMatch(/network round trip|round trip/i);
  });
});

describe("argv semantics: the whole script is a single argv passed to bash -lc, never split/concatenated", () => {
  it("passes cmd:'bash', args:['-lc', <the exact command string>] to runCommand", async () => {
    const sandbox = new FakeVercelSandbox();
    const ws = vercelWorkspace(sandbox);
    const script = 'echo "a" | grep a && echo "b; c" > /dev/null';
    await ws.exec({ command: script, signal: newSignal() });

    expect(sandbox.calls).toHaveLength(1);
    expect(sandbox.calls[0]?.cmd).toBe("bash");
    expect(sandbox.calls[0]?.args).toEqual(["-lc", script]);
  });

  it("anchors cwd under root by default, and under an explicit req.cwd when provided", async () => {
    const sandbox = new FakeVercelSandbox();
    const ws = vercelWorkspace(sandbox);

    await ws.exec({ command: "pwd", signal: newSignal() });
    expect(sandbox.calls[0]?.cwd).toBe("/vercel/sandbox");

    await ws.exec({ command: "pwd", cwd: "/src", signal: newSignal() });
    expect(sandbox.calls[1]?.cwd).toBe("/vercel/sandbox/src");
  });
});

describe("streaming: chunks written to the injected stdout/stderr Writables surface via onOutput, in order, and are also collected in full", () => {
  it("forwards stdout and stderr chunks through onOutput as they're written, and aggregates the full text in the final ExecResult", async () => {
    const sandbox = new FakeVercelSandbox({
      runCommandImpl: async (call) => {
        await writeChunks(call.stdout, ["hello ", "world"]);
        await writeChunks(call.stderr, ["warn: ", "careful"]);
        return { exitCode: 0 };
      },
    });
    const ws = vercelWorkspace(sandbox);

    const chunks: ExecOutputChunk[] = [];
    const result = await ws.exec({ command: "irrelevant", signal: newSignal() }, { onOutput: (c) => chunks.push(c) });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello world");
    expect(result.stderr).toBe("warn: careful");
    expect(chunks).toEqual([
      { stream: "stdout", data: "hello " },
      { stream: "stdout", data: "world" },
      { stream: "stderr", data: "warn: " },
      { stream: "stderr", data: "careful" },
    ]);
  });

  it("works fine with no onOutput callback provided", async () => {
    const sandbox = new FakeVercelSandbox({
      runCommandImpl: async (call) => {
        await writeChunks(call.stdout, ["ok"]);
        return { exitCode: 0 };
      },
    });
    const ws = vercelWorkspace(sandbox);
    const result = await ws.exec({ command: "echo ok", signal: newSignal() });
    expect(result.stdout).toBe("ok");
  });
});

describe("timeout", () => {
  it("resolves exit 124 (not throwing/hanging) when the command outlives timeoutMs, even if the underlying runCommand() never settles", async () => {
    const sandbox = new FakeVercelSandbox({
      runCommandImpl: () => new Promise(() => {}), // simulates a real network call still pending
    });
    const ws = vercelWorkspace(sandbox);

    const start = Date.now();
    const result = await ws.exec({ command: "sleep 999", timeoutMs: 30, signal: newSignal() });
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain("timed out");
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("still passes the native timeoutMs through to runCommand as a defense-in-depth kill signal", async () => {
    const sandbox = new FakeVercelSandbox({ runCommandImpl: () => new Promise(() => {}) });
    const ws = vercelWorkspace(sandbox);
    await ws.exec({ command: "sleep 999", timeoutMs: 30, signal: newSignal() });
    expect(sandbox.calls[0]?.timeoutMs).toBe(30);
  });
});

describe("abort", () => {
  it("resolves exit 130 promptly when the signal is already aborted before exec() is called", async () => {
    const controller = new AbortController();
    controller.abort();
    const sandbox = new FakeVercelSandbox();
    const ws = vercelWorkspace(sandbox);

    const result = await ws.exec({ command: "echo should-not-matter", signal: controller.signal });
    expect(result.exitCode).toBe(130);
    expect(result.stderr).toContain("aborted");
  });

  it("resolves exit 130 promptly when aborted mid-flight, without waiting for the never-settling runCommand() call", async () => {
    const sandbox = new FakeVercelSandbox({ runCommandImpl: () => new Promise(() => {}) });
    const ws = vercelWorkspace(sandbox);
    const controller = new AbortController();
    const execPromise = ws.exec({ command: "sleep 999", signal: controller.signal });
    setTimeout(() => controller.abort(), 15);

    const start = Date.now();
    const result = await execPromise;
    expect(result.exitCode).toBe(130);
    expect(result.stderr).toContain("aborted");
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("distinguishes timeout (124) from user abort (130) when both a timeoutMs and a signal are given and only the signal fires first", async () => {
    const sandbox = new FakeVercelSandbox({ runCommandImpl: () => new Promise(() => {}) });
    const ws = vercelWorkspace(sandbox);
    const controller = new AbortController();
    const execPromise = ws.exec({ command: "sleep 999", timeoutMs: 5000, signal: controller.signal });
    setTimeout(() => controller.abort(), 15);

    const result = await execPromise;
    expect(result.exitCode).toBe(130);
  });
});

describe("P6-1: exec() never rejects — a real thrown error from runCommand() resolves as a guided non-zero ExecResult", () => {
  it("translates a sandbox-stopped-style thrown error into a non-zero exit with guidance, not a rejection", async () => {
    const sandbox = new FakeVercelSandbox({
      runCommandImpl: () => Promise.reject(new Error("session not found: this sandbox has already been stopped")),
    });
    const ws = vercelWorkspace(sandbox);

    const result = await ws.exec({ command: "echo hi", signal: newSignal() });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("session not found");
    expect(result.stderr).toMatch(/stopped|expired/i);
    expect(result.stdout).toBe("");
  });

  it("preserves any partial output already streamed before the failure", async () => {
    const sandbox = new FakeVercelSandbox({
      runCommandImpl: async (call) => {
        await writeChunks(call.stdout, ["partial output before it died"]);
        throw new Error("connection reset");
      },
    });
    const ws = vercelWorkspace(sandbox);
    const result = await ws.exec({ command: "echo hi", signal: newSignal() });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("partial output before it died");
    expect(result.stderr).toContain("connection reset");
  });
});
