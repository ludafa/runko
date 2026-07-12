import { describe, expect, it } from "vitest";
import { buildFileDiff, computeUnifiedDiff } from "../src/diff.js";

describe("buildFileDiff", () => {
  it("returns undefined when before and after are identical", () => {
    expect(buildFileDiff("/a.txt", "same", "same")).toBeUndefined();
  });

  it("reports 'created' when before is undefined", () => {
    const diff = buildFileDiff("/a.txt", undefined, "hello\n");
    expect(diff).toBeDefined();
    expect(diff?.kind).toBe("created");
    expect(diff?.before).toBeUndefined();
    expect(diff?.after).toBe("hello\n");
    expect(diff?.patch).toContain("+hello");
  });

  it("reports 'deleted' when after is undefined", () => {
    const diff = buildFileDiff("/a.txt", "hello\n", undefined);
    expect(diff).toBeDefined();
    expect(diff?.kind).toBe("deleted");
    expect(diff?.before).toBe("hello\n");
    expect(diff?.after).toBeUndefined();
    expect(diff?.patch).toContain("-hello");
  });

  it("reports 'modified' when both exist and differ", () => {
    const diff = buildFileDiff("/a.txt", "line1\nline2\n", "line1\nline2changed\n");
    expect(diff).toBeDefined();
    expect(diff?.kind).toBe("modified");
    expect(diff?.patch).toContain("-line2");
    expect(diff?.patch).toContain("+line2changed");
    // 未改动的 line1 应该作为上下文原样出现（前缀空格）。
    expect(diff?.patch).toContain(" line1");
  });
});

describe("computeUnifiedDiff", () => {
  it("returns an empty string for identical content", () => {
    expect(computeUnifiedDiff("/a.txt", "same", "same")).toBe("");
  });

  it("includes standard unified-diff-style headers", () => {
    const patch = computeUnifiedDiff("/a.txt", "old\n", "new\n");
    expect(patch).toContain("--- a//a.txt");
    expect(patch).toContain("+++ b//a.txt");
    expect(patch).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
  });

  it("handles multi-line insertions and deletions via LCS", () => {
    const before = "a\nb\nc\nd\n";
    const after = "a\nx\nc\ny\n";
    const patch = computeUnifiedDiff("/f.txt", before, after);
    expect(patch).toContain("-b");
    expect(patch).toContain("+x");
    expect(patch).toContain("-d");
    expect(patch).toContain("+y");
    expect(patch).toContain(" a");
    expect(patch).toContain(" c");
  });

  it("handles empty-to-nonempty (pure insertion)", () => {
    const patch = computeUnifiedDiff("/f.txt", "", "a\nb\n");
    expect(patch).toContain("+a");
    expect(patch).toContain("+b");
    expect(patch).not.toContain("-a");
  });

  it("handles nonempty-to-empty (pure deletion)", () => {
    const patch = computeUnifiedDiff("/f.txt", "a\nb\n", "");
    expect(patch).toContain("-a");
    expect(patch).toContain("-b");
    expect(patch).not.toContain("+a");
  });
});
