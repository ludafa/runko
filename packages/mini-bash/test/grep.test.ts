import { fromMemory } from "@nimbo/virtual-fs";
import { describe, expect, it } from "vitest";
import { run } from "./helpers.js";

function fixture() {
  return fromMemory({
    "/a.txt": "nothing here\nnope either\n",
    "/b.txt": "foo\nbar\nfoo again\n",
  });
}

describe("grep", () => {
  it("prints matching lines by default", async () => {
    const result = await run(fixture(), "grep foo /b.txt");
    expect(result).toEqual({ exitCode: 0, stdout: "foo\nfoo again\n", stderr: "", durationMs: expect.any(Number) });
  });

  it("-i matches case-insensitively", async () => {
    const result = await run(fixture(), "grep -i FOO /b.txt");
    expect(result.stdout).toBe("foo\nfoo again\n");
    expect(result.exitCode).toBe(0);
  });

  it("without -i, case mismatch yields no matches", async () => {
    const result = await run(fixture(), "grep FOO /b.txt");
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(1);
  });

  it("-n prefixes matching lines with 1-based line numbers", async () => {
    const result = await run(fixture(), "grep -n foo /b.txt");
    expect(result.stdout).toBe("1:foo\n3:foo again\n");
  });

  it("-c prints the match count instead of lines", async () => {
    const result = await run(fixture(), "grep -c foo /b.txt");
    expect(result.stdout).toBe("2\n");
    expect(result.exitCode).toBe(0);
  });

  it("-c prints 0 (not empty) when a file has no matches, still exits 1", async () => {
    const result = await run(fixture(), "grep -c foo /a.txt");
    expect(result.stdout).toBe("0\n");
    expect(result.exitCode).toBe(1);
  });

  it("-l lists only filenames that contain a match", async () => {
    const result = await run(fixture(), "grep -l foo /a.txt /b.txt");
    expect(result.stdout).toBe("/b.txt\n");
    expect(result.exitCode).toBe(0);
  });

  it("-E is accepted and does not change matching (JS RegExp is already extended syntax)", async () => {
    const withFlag = await run(fixture(), "grep -E 'fo+' /b.txt");
    const withoutFlag = await run(fixture(), "grep 'fo+' /b.txt");
    expect(withFlag.stdout).toBe(withoutFlag.stdout);
    expect(withFlag.stdout).toBe("foo\nfoo again\n");
  });

  it("combines short flags in one token (-ni)", async () => {
    const result = await run(fixture(), "grep -ni FOO /b.txt");
    expect(result.stdout).toBe("1:foo\n3:foo again\n");
  });

  it("prefixes the filename when searching multiple files", async () => {
    const result = await run(fixture(), "grep -n foo /a.txt /b.txt");
    expect(result.stdout).toBe("/b.txt:1:foo\n/b.txt:3:foo again\n");
  });

  it("reads stdin when no files are given", async () => {
    const result = await run(fixture(), "cat /b.txt | grep -n foo");
    expect(result.stdout).toBe("1:foo\n3:foo again\n");
  });

  it("with no files and no piped input (sole/first stage), searches empty stdin and exits 1", async () => {
    const result = await run(fixture(), "grep foo");
    expect(result).toEqual({ exitCode: 1, stdout: "", stderr: "", durationMs: expect.any(Number) });
  });

  it("exits 1 with empty stdout on no matches", async () => {
    const result = await run(fixture(), "grep zzz /b.txt");
    expect(result).toEqual({ exitCode: 1, stdout: "", stderr: "", durationMs: expect.any(Number) });
  });

  it("requires a pattern operand", async () => {
    const result = await run(fixture(), "grep");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("missing pattern");
  });

  it("rejects an unknown flag", async () => {
    const result = await run(fixture(), "grep -z foo /b.txt");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("unknown option");
  });

  it("rejects an invalid regular expression", async () => {
    const result = await run(fixture(), "grep '(' /b.txt");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("invalid regular expression");
  });

  it("reports a missing file with exit code 2 (distinct from a bare no-match)", async () => {
    const result = await run(fixture(), "grep foo /nope.txt");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("No such file or directory");
  });

  it("has no side effects on the filesystem", async () => {
    const fs = fixture();
    const before = fs.snapshot();
    await run(fs, "grep -ncl foo /a.txt /b.txt");
    expect(fs.snapshot()).toEqual(before);
  });
});
