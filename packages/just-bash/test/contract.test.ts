/**
 * NimboExec 表面契约（docs/tech/core-sdk.md §4.5b "NimboExec 表面" 一节）：describe() 的
 * 声明内容、defaultApproval，以及"全部失败路径 resolve 而非 reject"（§4.5a
 * 实现契约）在语法错误这条路径上的验证。
 */
import type { NimboFS } from "@nimbo/core";
import { fromMemory } from "@nimbo/virtual-fs";
import { describe, expect, it } from "vitest";
import { justBash } from "../src/index.js";
import { run } from "./helpers.js";

describe("NimboExec surface", () => {
  it("exposes defaultApproval 'allow'", () => {
    expect(justBash(fromMemory({})).defaultApproval).toBe("allow");
  });

  it("describe() declares full syntax, no symlinks, no network, non-streaming output, persistent cwd, and execution limits", () => {
    const description = justBash(fromMemory({})).describe?.() ?? "";
    expect(description).toMatch(/if\/elif|for|while|until|case/);
    expect(description).toMatch(/symlink/i);
    expect(description).toContain("No symlinks");
    expect(description).toMatch(/network/i);
    expect(description).toContain("No network");
    expect(description).toMatch(/not.*stream/i);
    expect(description).toContain("cwd is persistent");
    expect(description).toMatch(/limits? (are|is) enforced/i);
  });
});

describe("syntax errors resolve as a normal ExecResult, not a thrown/rejected exception (§4.5a)", () => {
  it("an unterminated quote resolves with a non-zero exit and a stderr message, no throw", async () => {
    const result = await run(fromMemory({}), 'echo "unterminated');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(result.stdout).toBe("");
  });

  it("an unknown command resolves with exit 127 and a 'command not found' style message", async () => {
    const result = await run(fromMemory({}), "totally-not-a-real-command foo");
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain("not found");
  });
});

describe("a genuinely broken injected NimboFS still resolves instead of rejecting (§4.5a never-reject, defensive fallback)", () => {
  it("a fs.glob() that throws (breaking the getAllPaths cache warm-up) surfaces as exit 1 with an 'internal error' message, not a thrown/rejected exec()", async () => {
    const good = fromMemory({});
    const brokenFs: NimboFS = {
      readFile: (path) => good.readFile(path),
      writeFile: (path, data) => good.writeFile(path, data),
      rm: (path, opts) => good.rm(path, opts),
      mkdir: (path) => good.mkdir(path),
      readdir: (path) => good.readdir(path),
      stat: (path) => good.stat(path),
      glob: () => {
        throw new Error("simulated catastrophic glob() failure");
      },
    };
    const bash = justBash(brokenFs);
    const result = await bash.exec({ command: "echo hi", signal: new AbortController().signal });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("internal error");
    expect(result.stderr).toContain("simulated catastrophic glob() failure");
  });
});
