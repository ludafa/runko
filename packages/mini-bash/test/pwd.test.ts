import { fromMemory } from "@nimbo/virtual-fs";
import { describe, expect, it } from "vitest";
import { run } from "./helpers.js";

describe("pwd", () => {
  it("prints the root by default", async () => {
    const result = await run(fromMemory(), "pwd");
    expect(result).toEqual({ exitCode: 0, stdout: "/\n", stderr: "", durationMs: expect.any(Number) });
  });

  it("prints a custom starting cwd", async () => {
    const result = await run(fromMemory({ "/work/a.txt": "x" }), "pwd", { cwd: "/work" });
    expect(result.stdout).toBe("/work\n");
    expect(result.exitCode).toBe(0);
  });

  it("follows a preceding cd within the same chain", async () => {
    const result = await run(fromMemory({ "/work/a.txt": "x" }), "cd /work && pwd");
    expect(result.stdout).toBe("/work\n");
    expect(result.exitCode).toBe(0);
  });

  it("ignores any arguments given to it", async () => {
    const result = await run(fromMemory(), "pwd ignored args");
    expect(result.stdout).toBe("/\n");
    expect(result.exitCode).toBe(0);
  });

  it("its output on the left of a pipe is readable by the next stage", async () => {
    const result = await run(fromMemory({ "/work/a.txt": "x" }), "cd /work && pwd | grep work");
    expect(result.stdout).toBe("/work\n");
    expect(result.exitCode).toBe(0);
  });

  it("has no side effects on the filesystem", async () => {
    const fs = fromMemory({ "/work/a.txt": "x" });
    const before = fs.snapshot();
    await run(fs, "cd /work && pwd");
    expect(fs.snapshot()).toEqual(before);
  });
});
