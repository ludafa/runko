/**
 * NimboExec 契约（docs/tech/sandbox.md §3.2 / §8.2；工单验收点）：P6-1 全部失败路径 resolve
 * 而非 reject、超时/中止归一 124/130、`onOutput` 分片顺序、cwd 锚定、
 * `describe()`/`defaultApproval`。
 */
import type { ExecOutputChunk } from "@nimbo/core";
import { describe, expect, it } from "vitest";
import { e2bWorkspace } from "../src/index.js";
import { createFakeE2bSandbox } from "./helpers.js";

function neverAborts(): AbortSignal {
  return new AbortController().signal;
}

describe("NimboExec surface", () => {
  it("defaultApproval is 'allow' (isolation is the boundary, not approval)", () => {
    const workspace = e2bWorkspace(createFakeE2bSandbox());
    expect(workspace.defaultApproval).toBe("allow");
  });

  it("describe() truthfully declares a real Firecracker VM, same-source workspace, and steers scans toward bash", () => {
    const description = e2bWorkspace(createFakeE2bSandbox()).describe?.() ?? "";
    expect(description).toMatch(/firecracker/i);
    expect(description).toMatch(/real machine|full linux/i);
    expect(description).toMatch(/same-source|same filesystem/i);
    expect(description).toMatch(/isolation/i);
    expect(description).toMatch(/single bash command/i);
  });
});

describe("P6-1: every failure path resolves a non-zero ExecResult, never rejects", () => {
  it("a non-zero exit (e2b's CommandExitError-shaped throw) resolves losslessly, no exception", async () => {
    const workspace = e2bWorkspace(createFakeE2bSandbox());
    const result = await workspace.exec({ command: "fail:3:boom", signal: neverAborts() });
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("boom");
  });

  it("e2b's own TimeoutError-shaped throw normalizes to exit 124", async () => {
    const workspace = e2bWorkspace(createFakeE2bSandbox());
    const result = await workspace.exec({ command: "timeout-error", signal: neverAborts() });
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain("timed out");
  });

  it("an unrecognized sandbox error (e.g. SandboxNotFoundError-shaped: stopped/expired) resolves non-zero with actionable guidance, not a throw", async () => {
    const workspace = e2bWorkspace(createFakeE2bSandbox());
    const result = await workspace.exec({ command: "sandbox-error", signal: neverAborts() });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("sandbox not found");
    expect(result.stderr).toMatch(/stopped|timeout|recreate/i);
  });
});

describe("timeout", () => {
  it("aborts a hung command after timeoutMs and returns exit 124 instead of hanging or throwing", async () => {
    const workspace = e2bWorkspace(createFakeE2bSandbox());
    const start = Date.now();
    const result = await workspace.exec({ command: "hang", timeoutMs: 30, signal: neverAborts() });
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain("timed out");
    expect(result.stdout).toBe("");
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe("abort", () => {
  it("returns promptly with exit 130 when the signal is already aborted before exec() is called", async () => {
    const workspace = e2bWorkspace(createFakeE2bSandbox());
    const controller = new AbortController();
    controller.abort();
    const result = await workspace.exec({ command: "echo:should-not-run", signal: controller.signal });
    expect(result.exitCode).toBe(130);
    expect(result.stderr).toContain("aborted");
    expect(result.stdout).toBe("");
  });

  it("stops promptly when aborted mid-flight against a hung remote call (independent race, not cooperative)", async () => {
    const workspace = e2bWorkspace(createFakeE2bSandbox());
    const controller = new AbortController();
    const execPromise = workspace.exec({ command: "hang", signal: controller.signal });
    setTimeout(() => controller.abort(), 15);

    const start = Date.now();
    const result = await execPromise;
    expect(result.exitCode).toBe(130);
    expect(result.stderr).toContain("aborted");
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe("onOutput streaming", () => {
  it("delivers stdout chunks in emission order before the final ExecResult resolves", async () => {
    const workspace = e2bWorkspace(createFakeE2bSandbox());
    const chunks: ExecOutputChunk[] = [];
    const result = await workspace.exec({ command: "chunks:first-|second-|third", signal: neverAborts() }, { onOutput: (c) => chunks.push(c) });

    expect(chunks).toEqual([
      { stream: "stdout", data: "first-" },
      { stream: "stdout", data: "second-" },
      { stream: "stdout", data: "third" },
    ]);
    expect(result.stdout).toBe("first-second-third");
    expect(result.exitCode).toBe(0);
  });

  it("delivers stderr chunks too, even on a failing command (CommandExitError-shaped path)", async () => {
    const workspace = e2bWorkspace(createFakeE2bSandbox());
    const chunks: ExecOutputChunk[] = [];
    await workspace.exec({ command: "fail:1:oops", signal: neverAborts() }, { onOutput: (c) => chunks.push(c) });
    expect(chunks).toEqual([{ stream: "stderr", data: "oops" }]);
  });
});

describe("cwd anchoring", () => {
  it("defaults to the workspace root when req.cwd is not given", async () => {
    const workspace = e2bWorkspace(createFakeE2bSandbox());
    const result = await workspace.exec({ command: "pwd", signal: neverAborts() });
    expect(result.stdout).toBe("/home/user\n");
  });

  it("anchors a relative-looking virtual req.cwd under the configured root", async () => {
    const workspace = e2bWorkspace(createFakeE2bSandbox(), { root: "/home/user" });
    const result = await workspace.exec({ command: "pwd", cwd: "/sub", signal: neverAborts() });
    expect(result.stdout).toBe("/home/user/sub\n");
  });

  it("anchors under a custom root", async () => {
    const workspace = e2bWorkspace(createFakeE2bSandbox(["/workspace/app"]), { root: "/workspace/app" });
    const result = await workspace.exec({ command: "pwd", signal: neverAborts() });
    expect(result.stdout).toBe("/workspace/app\n");
  });
});
