import { fromMemory } from "@nimbo/virtual-fs";
import { describe, expect, it } from "vitest";
import { run } from "./helpers.js";

describe("echo", () => {
  it("prints its arguments space-joined with a trailing newline", async () => {
    const result = await run(fromMemory(), "echo hello world");
    expect(result).toEqual({ exitCode: 0, stdout: "hello world\n", stderr: "", durationMs: expect.any(Number) });
  });

  it("-n suppresses the trailing newline", async () => {
    const result = await run(fromMemory(), "echo -n hello");
    expect(result).toEqual({ exitCode: 0, stdout: "hello", stderr: "", durationMs: expect.any(Number) });
  });

  it("with no arguments prints just a newline", async () => {
    const result = await run(fromMemory(), "echo");
    expect(result.stdout).toBe("\n");
    expect(result.exitCode).toBe(0);
  });

  it("with no arguments and -n prints nothing", async () => {
    const result = await run(fromMemory(), "echo -n");
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("ignores piped-in stdin (echo never reads stdin)", async () => {
    const fs = fromMemory({ "/a.txt": "from file\n" });
    const result = await run(fs, "cat /a.txt | echo hi");
    expect(result.stdout).toBe("hi\n");
  });

  it("has no side effects on the filesystem", async () => {
    const fs = fromMemory({ "/a.txt": "x" });
    const before = fs.snapshot();
    await run(fs, "echo hi there");
    expect(fs.snapshot()).toEqual(before);
  });
});
