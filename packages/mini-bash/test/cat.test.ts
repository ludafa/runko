import { fromMemory } from "@runko/virtual-fs";
import { describe, expect, it } from "vitest";
import { run, withFailingReadFile } from "./helpers.js";

function fixture() {
  return fromMemory({
    "/a.txt": "line1\nline2\nline3\n",
    "/b.txt": "tail-of-b",
    "/dir/inner.txt": "inner\n",
  });
}

describe("cat", () => {
  it("prints a single file's content", async () => {
    const result = await run(fixture(), "cat /a.txt");
    expect(result).toEqual({ exitCode: 0, stdout: "line1\nline2\nline3\n", stderr: "", durationMs: expect.any(Number) });
  });

  it("concatenates multiple files in argument order, raw byte-for-byte", async () => {
    const result = await run(fixture(), "cat /a.txt /b.txt");
    expect(result.stdout).toBe("line1\nline2\nline3\ntail-of-b");
    expect(result.exitCode).toBe(0);
  });

  it("reads stdin when given no arguments (right side of a pipe)", async () => {
    const result = await run(fixture(), "echo hi | cat");
    expect(result).toEqual({ exitCode: 0, stdout: "hi\n", stderr: "", durationMs: expect.any(Number) });
  });

  it("with no arguments and no piped input (sole/first stage), reads empty stdin rather than erroring", async () => {
    const result = await run(fixture(), "cat");
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "", durationMs: expect.any(Number) });
  });

  it("reports a missing file on stderr and exits non-zero, without crashing", async () => {
    const result = await run(fixture(), "cat /nope.txt");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("cat: /nope.txt: No such file or directory");
  });

  it("continues past a missing file to read the rest, still exits non-zero", async () => {
    const result = await run(fixture(), "cat /nope.txt /a.txt");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("line1\nline2\nline3\n");
    expect(result.stderr).toContain("No such file or directory");
  });

  it("reports a directory argument as an error", async () => {
    const result = await run(fixture(), "cat /dir");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("cat: /dir: Is a directory");
  });

  it("surfaces a readFile() failure even when stat() reported a readable file (non-conforming RunkoFS)", async () => {
    const fs = withFailingReadFile(fixture(), "/a.txt", new Error("boom"));
    const result = await run(fs, "cat /a.txt");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("cat: /a.txt: boom\n");
  });
});
