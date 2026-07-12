import { fromMemory } from "@nimbo/virtual-fs";
import { describe, expect, it } from "vitest";
import { run } from "./helpers.js";

function fixture() {
  return fromMemory({
    "/a.txt": "hello\n",
    "/src/index.ts": "console.log(1)\n",
    "/src/sub/deep.txt": "deep\n",
  });
}

describe("cd", () => {
  it("succeeds silently on an existing directory", async () => {
    const result = await run(fixture(), "cd /src");
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "", durationMs: expect.any(Number) });
  });

  it("with no arguments returns to the root", async () => {
    const result = await run(fixture(), "cd /src && cd && pwd");
    expect(result.stdout).toBe("/\n");
    expect(result.exitCode).toBe(0);
  });

  it("resolves a relative target against the current cwd", async () => {
    const result = await run(fixture(), "cd src && cat index.ts", { cwd: "/" });
    expect(result.stdout).toBe("console.log(1)\n");
    expect(result.exitCode).toBe(0);
  });

  it("reports a missing target on stderr and exits non-zero", async () => {
    const result = await run(fixture(), "cd /nope");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("cd: /nope: No such file or directory\n");
  });

  it("reports a file target (not a directory) as an error", async () => {
    const result = await run(fixture(), "cd /a.txt");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("cd: /a.txt: Not a directory\n");
  });

  it("explicitly rejects cd - instead of silently ignoring it", async () => {
    const result = await run(fixture(), "cd -");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("cd: cd -");
    expect(result.stderr).toContain("not supported");
  });

  it("rejects more than one argument instead of silently using the first", async () => {
    const result = await run(fixture(), "cd /src /a.txt");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("cd: too many arguments\n");
  });

  it("has no side effects on the filesystem, on success or on any failure path", async () => {
    const fs = fixture();
    const before = fs.snapshot();
    await run(fs, "cd /src");
    await run(fs, "cd /nope");
    await run(fs, "cd /a.txt");
    await run(fs, "cd -");
    await run(fs, "cd /src /a.txt");
    await run(fs, "cd");
    expect(fs.snapshot()).toEqual(before);
  });
});
