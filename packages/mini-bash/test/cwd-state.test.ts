/**
 * cd 的"跨链穿透 + 管道子 shell 隔离 + 跨 exec() 调用持久化"语义（P6-4，
 * 见 exec.ts DESCRIBE 与 runPipeline/runChain/exec() 顶部注释）——这些行为
 * 横跨解释器的三层（管道/链/整段脚本+实例），不属于任何单个命令的单元测
 * 试，独立成文件，与 cd.test.ts/pwd.test.ts（单命令行为）分开。
 */
import { fromMemory } from "@runko/virtual-fs";
import { describe, expect, it } from "vitest";
import { miniBash } from "../src/index.js";
import { run } from "./helpers.js";

function fixture() {
  return fromMemory({
    "/src/index.ts": "console.log(1)\n",
    "/src/sub/deep.txt": "deep\n",
    "/other/file.txt": "other\n",
  });
}

describe("cd: cwd state propagation within a single exec() call", () => {
  it("`;` threads the new cwd into the next chain's relative-path resolution", async () => {
    const result = await run(fixture(), "cd src; cat index.ts");
    expect(result).toEqual({ exitCode: 0, stdout: "console.log(1)\n", stderr: "", durationMs: expect.any(Number) });
  });

  it("`&&` threads the new cwd into the next link within the same chain", async () => {
    const result = await run(fixture(), "cd src && cat index.ts");
    expect(result.stdout).toBe("console.log(1)\n");
    expect(result.exitCode).toBe(0);
  });

  it("a failing cd short-circuits the `&&` chain: the next link never runs, and cwd stays put", async () => {
    const result = await run(fixture(), "cd /nope && cat index.ts");
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("No such file or directory");
    expect(result.exitCode).toBe(1);
  });

  it("cwd keeps threading across more than one `;`-separated chain", async () => {
    const result = await run(fixture(), "cd src; cd sub; cat deep.txt");
    expect(result.stdout).toBe("deep\n");
    expect(result.exitCode).toBe(0);
  });

  describe("pipe subshell semantics", () => {
    it("a cd as one stage of a multi-stage pipeline succeeds but has no effect once the pipeline ends", async () => {
      const result = await run(fixture(), "cd src | cat; pwd");
      expect(result.stdout).toBe("/\n");
      expect(result.exitCode).toBe(0);
    });

    it("a cd does not leak its new cwd into a sibling stage of the same pipeline either", async () => {
      const result = await run(fixture(), "cd src | pwd");
      expect(result.stdout).toBe("/\n");
      expect(result.exitCode).toBe(0);
    });
  });
});

describe("cd: cross-call persistence on the same miniBash(fs) instance", () => {
  it("a cd in one exec() call becomes the default starting cwd for the next exec() call", async () => {
    const bash = miniBash(fixture());
    const first = await bash.exec({ command: "cd src", signal: new AbortController().signal });
    expect(first.exitCode).toBe(0);

    const second = await bash.exec({ command: "cat index.ts", signal: new AbortController().signal });
    expect(second).toEqual({ exitCode: 0, stdout: "console.log(1)\n", stderr: "", durationMs: expect.any(Number) });
  });

  it("an explicit req.cwd is only that call's starting point, not a new permanent memory when no cd runs", async () => {
    const bash = miniBash(fixture());
    await bash.exec({ command: "cd src", signal: new AbortController().signal });

    const result = await bash.exec({ command: "cat file.txt", cwd: "/other", signal: new AbortController().signal });
    expect(result).toEqual({ exitCode: 0, stdout: "other\n", stderr: "", durationMs: expect.any(Number) });

    // no cd happened in that last call, so the instance still remembers /src, not /other.
    const third = await bash.exec({ command: "cat index.ts", signal: new AbortController().signal });
    expect(third.stdout).toBe("console.log(1)\n");
  });

  it("a cd during a call with an explicit req.cwd still updates the instance's remembered cwd", async () => {
    const bash = miniBash(fixture());
    await bash.exec({ command: "cd sub", cwd: "/src", signal: new AbortController().signal });

    const result = await bash.exec({ command: "cat deep.txt", signal: new AbortController().signal });
    expect(result).toEqual({ exitCode: 0, stdout: "deep\n", stderr: "", durationMs: expect.any(Number) });
  });

  it("two separate miniBash(fs) instances over the same fs do not share cwd state", async () => {
    const fs = fixture();
    const bashA = miniBash(fs);
    const bashB = miniBash(fs);

    await bashA.exec({ command: "cd src", signal: new AbortController().signal });

    const resultA = await bashA.exec({ command: "pwd", signal: new AbortController().signal });
    const resultB = await bashB.exec({ command: "pwd", signal: new AbortController().signal });
    expect(resultA.stdout).toBe("/src\n");
    expect(resultB.stdout).toBe("/\n");
  });

  it("a failed cd does not update the instance's remembered cwd", async () => {
    const bash = miniBash(fixture());
    const first = await bash.exec({ command: "cd /nope", signal: new AbortController().signal });
    expect(first.exitCode).toBe(1);

    const second = await bash.exec({ command: "pwd", signal: new AbortController().signal });
    expect(second.stdout).toBe("/\n");
  });
});
