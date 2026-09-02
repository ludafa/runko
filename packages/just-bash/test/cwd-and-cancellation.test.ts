/**
 * cwd 实例持久化（工单验收点："cd 实例持久（跨两次 exec）+ req.cwd 覆盖不
 * 转正"）与超时/中止语义。`exec.ts` 头注释记录了一个实测发现：这套持久化
 * 不是 just-bash 自带的（`Bash.exec()` 每次调用互不影响状态），是适配器自己
 * 用 `instanceCwd` 维护的——这里的用例直接对应那份实现推理，与
 * `@runko/mini-bash` 的 `test/cwd-state.test.ts` 同款场景对照。
 */
import { fromMemory } from "@runko/virtual-fs";
import { describe, expect, it } from "vitest";
import { justBash } from "../src/index.js";
import { makeHangingFs, run } from "./helpers.js";

function fixture() {
  return fromMemory({
    "/src/index.ts": "console.log(1)\n",
    "/src/sub/deep.txt": "deep\n",
    "/other/file.txt": "other\n",
  });
}

describe("cwd: cross-call persistence on the same justBash(fs) instance", () => {
  it("a cd in one exec() call becomes the default starting cwd for the next exec() call", async () => {
    const bash = justBash(fixture());
    const first = await bash.exec({ command: "cd /src", signal: new AbortController().signal });
    expect(first.exitCode).toBe(0);

    const second = await bash.exec({ command: "cat index.ts", signal: new AbortController().signal });
    expect(second.stdout).toBe("console.log(1)\n");
    expect(second.exitCode).toBe(0);
  });

  it("an explicit req.cwd is only that call's starting point, not a new permanent memory when no cd runs", async () => {
    const bash = justBash(fixture());
    await bash.exec({ command: "cd /src", signal: new AbortController().signal });

    const result = await bash.exec({ command: "cat file.txt", cwd: "/other", signal: new AbortController().signal });
    expect(result.stdout).toBe("other\n");
    expect(result.exitCode).toBe(0);

    // no cd happened in that last call, so the instance still remembers /src, not /other.
    const third = await bash.exec({ command: "cat index.ts", signal: new AbortController().signal });
    expect(third.stdout).toBe("console.log(1)\n");
  });

  it("a cd during a call with an explicit req.cwd still updates the instance's remembered cwd", async () => {
    const bash = justBash(fixture());
    await bash.exec({ command: "cd sub", cwd: "/src", signal: new AbortController().signal });

    const result = await bash.exec({ command: "cat deep.txt", signal: new AbortController().signal });
    expect(result.stdout).toBe("deep\n");
    expect(result.exitCode).toBe(0);
  });

  it("two separate justBash(fs) instances over the same fs do not share cwd state", async () => {
    const fs = fixture();
    const bashA = justBash(fs);
    const bashB = justBash(fs);

    await bashA.exec({ command: "cd /src", signal: new AbortController().signal });

    const resultA = await bashA.exec({ command: "pwd", signal: new AbortController().signal });
    const resultB = await bashB.exec({ command: "pwd", signal: new AbortController().signal });
    expect(resultA.stdout).toBe("/src\n");
    expect(resultB.stdout).toBe("/\n");
  });
});

describe("timeout", () => {
  it("aborts a hung command after timeoutMs and returns exit 124 instead of hanging or throwing", async () => {
    const bash = justBash(makeHangingFs());
    const start = Date.now();
    const result = await bash.exec({ command: "cat /slow.txt", timeoutMs: 30, signal: new AbortController().signal });
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain("timed out");
    expect(result.stdout).toBe("");
    expect(Date.now() - start).toBeLessThan(1000); // promptly, not by coincidence
  });
});

describe("abort", () => {
  it("returns promptly with exit 130 when the signal is already aborted before exec() is even called", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await run(fixture(), "echo should-not-run", { signal: controller.signal });
    expect(result.exitCode).toBe(130);
    expect(result.stderr).toContain("aborted");
    expect(result.stdout).toBe("");
  });

  it("stops promptly when aborted mid-flight against a fs call that never resolves (just-bash's own cooperative cancellation cannot save this — see exec.ts header)", async () => {
    const bash = justBash(makeHangingFs());
    const controller = new AbortController();
    const execPromise = bash.exec({ command: "cat /slow.txt", signal: controller.signal });
    setTimeout(() => controller.abort(), 15);

    const start = Date.now();
    const result = await execPromise;
    expect(result.exitCode).toBe(130);
    expect(result.stderr).toContain("aborted");
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
