import { fromMemory } from "@nimbo/virtual-fs";
import { describe, expect, it } from "vitest";
import { run } from "./helpers.js";

function fixture() {
  return fromMemory({
    "/a.txt": "l1\nl2\nl3\n",
    "/b.txt": "x1\nx2\n",
  });
}

describe("tail", () => {
  it("-n N prints the last N lines", async () => {
    const result = await run(fixture(), "tail -n 2 /a.txt");
    expect(result).toEqual({ exitCode: 0, stdout: "l2\nl3\n", stderr: "", durationMs: expect.any(Number) });
  });

  it("defaults to 10 lines", async () => {
    const result = await run(fixture(), "tail /a.txt");
    expect(result.stdout).toBe("l1\nl2\nl3\n");
  });

  it("requesting more lines than the file has returns the whole file (boundary)", async () => {
    const result = await run(fixture(), "tail -n 100 /a.txt");
    expect(result.stdout).toBe("l1\nl2\nl3\n");
  });

  it("-n 0 prints nothing (avoids the Array.slice(-0) === slice(0) pitfall)", async () => {
    const result = await run(fixture(), "tail -n 0 /a.txt");
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("reads stdin when no files are given", async () => {
    const result = await run(fixture(), "cat /a.txt | tail -n 1");
    expect(result.stdout).toBe("l3\n");
  });

  it("with no files and no piped input (sole/first stage), reads empty stdin", async () => {
    const result = await run(fixture(), "tail -n 1");
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "", durationMs: expect.any(Number) });
  });

  it("prints ==> file <== headers when given multiple files", async () => {
    const result = await run(fixture(), "tail -n 1 /a.txt /b.txt");
    expect(result.stdout).toBe("==> /a.txt <==\nl3\n\n==> /b.txt <==\nx2\n");
  });

  it("rejects a negative -n value", async () => {
    const result = await run(fixture(), "tail -n -1 /a.txt");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("invalid number of lines");
  });

  it("reports a missing file", async () => {
    const result = await run(fixture(), "tail -n 1 /nope.txt");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No such file or directory");
  });

  it("has no side effects on the filesystem", async () => {
    const fs = fixture();
    const before = fs.snapshot();
    await run(fs, "tail -n 1 /a.txt /b.txt");
    expect(fs.snapshot()).toEqual(before);
  });
});
