import { fromMemory } from "@nimbo/virtual-fs";
import { describe, expect, it } from "vitest";
import { run, withFailingReaddir } from "./helpers.js";

function fixture() {
  return fromMemory({
    "/dir/a.txt": "a",
    "/dir/b.md": "b",
    "/dir/sub/c.txt": "c",
  });
}

describe("find", () => {
  it("-type f lists only files, recursively", async () => {
    const result = await run(fixture(), "find /dir -type f");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.split("\n").filter(Boolean).sort()).toEqual(["/dir/a.txt", "/dir/b.md", "/dir/sub/c.txt"]);
  });

  it("-type d lists only directories, including the root and nested ones", async () => {
    const result = await run(fixture(), "find /dir -type d");
    expect(result.stdout.split("\n").filter(Boolean).sort()).toEqual(["/dir", "/dir/sub"]);
  });

  it("-name matches a single path segment (basename) with * and ?", async () => {
    const result = await run(fixture(), "find /dir -name '*.txt'");
    expect(result.stdout.split("\n").filter(Boolean).sort()).toEqual(["/dir/a.txt", "/dir/sub/c.txt"]);
  });

  it("combines -type and -name", async () => {
    const result = await run(fixture(), "find /dir -type f -name 'b.*'");
    expect(result.stdout.trim()).toBe("/dir/b.md");
  });

  it("defaults path to the current directory when omitted", async () => {
    const result = await run(fixture(), "find -type f", { cwd: "/dir/sub" });
    expect(result.stdout.trim()).toBe("/dir/sub/c.txt");
  });

  it("reports a missing root path on stderr with a non-zero exit", async () => {
    const result = await run(fixture(), "find /nope -type f");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No such file or directory");
  });

  it("rejects -type with an invalid value", async () => {
    const result = await run(fixture(), "find /dir -type x");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("-type requires 'f' or 'd'");
  });

  it("rejects -name without a value", async () => {
    const result = await run(fixture(), "find /dir -name");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("-name requires an argument");
  });

  it("rejects an unknown option", async () => {
    const result = await run(fixture(), "find /dir -bogus");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("unknown option");
  });

  it("reports a readdir() failure mid-traversal as an error result instead of throwing", async () => {
    const fs = withFailingReaddir(fixture(), "/dir/sub", new Error("boom"));
    const result = await run(fs, "find /dir");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("boom");
  });

  it("has no side effects on the filesystem", async () => {
    const fs = fixture();
    const before = fs.snapshot();
    await run(fs, "find /dir -type f -name '*.txt'");
    expect(fs.snapshot()).toEqual(before);
  });
});
