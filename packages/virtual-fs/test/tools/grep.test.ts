import { describe, expect, it } from "vitest";
import { fromMemory } from "../../src/memory.js";
import { createGrepTool } from "../../src/tools/grep.js";
import { expectError, expectText, makeCtx } from "./helpers.js";

describe("grep", () => {
  it("files mode (default) returns the sorted list of matching file paths", async () => {
    const fs = fromMemory({
      "a.ts": "export const TODO = 1;",
      "b.ts": "export const x = 2;",
      "c.ts": "// TODO: fix this",
    });
    const tool = createGrepTool();

    const result = expectText(await tool.execute({ pattern: "TODO" }, makeCtx(fs)));
    expect(result.split("\n")).toEqual(["/a.ts", "/c.ts"]);
  });

  it("content mode returns line-numbered matches: 'path:line:text'", async () => {
    const fs = fromMemory({ "a.ts": "line1\nTODO here\nline3" });
    const tool = createGrepTool();

    const result = expectText(await tool.execute({ pattern: "TODO", mode: "content" }, makeCtx(fs)));
    expect(result).toBe("/a.ts:2:TODO here");
  });

  it("content mode expands ±context lines, marked with '-' instead of ':'", async () => {
    const fs = fromMemory({ "a.ts": "l1\nl2\nTODO\nl4\nl5" });
    const tool = createGrepTool();

    const result = expectText(await tool.execute({ pattern: "TODO", mode: "content", context: 1 }, makeCtx(fs)));
    expect(result).toBe("/a.ts-2-l2\n/a.ts:3:TODO\n/a.ts-4-l4");
  });

  it("ignore_case makes matching case-insensitive", async () => {
    const fs = fromMemory({ "a.ts": "Todo item" });
    const tool = createGrepTool();

    const result = expectText(await tool.execute({ pattern: "todo", ignore_case: true }, makeCtx(fs)));
    expect(result).toBe("/a.ts");
  });

  it("scopes the search under path and by glob", async () => {
    const fs = fromMemory({ "src/a.ts": "TODO", "src/a.js": "TODO", "other/b.ts": "TODO" });
    const tool = createGrepTool();

    const result = expectText(await tool.execute({ pattern: "TODO", path: "/src", glob: "*.ts" }, makeCtx(fs)));
    expect(result).toBe("/src/a.ts");
  });

  it("errors with guidance on an invalid regular expression", async () => {
    const fs = fromMemory({ "a.ts": "x" });
    const tool = createGrepTool();

    const content = expectError(await tool.execute({ pattern: "(unclosed" }, makeCtx(fs)));
    expect(content).toContain("Invalid regular expression");
  });

  it("returns an informative (non-error) message when nothing matches", async () => {
    const fs = fromMemory({ "a.ts": "hello" });
    const tool = createGrepTool();

    const result = await tool.execute({ pattern: "TODO" }, makeCtx(fs));
    expect(typeof result).toBe("string");
    expect(String(result)).toContain("No files");
  });

  it("skips binary files entirely", async () => {
    const fs = fromMemory({ "logo.png": new TextEncoder().encode("TODO-not-real-text"), "a.ts": "TODO" });
    const tool = createGrepTool();

    const result = expectText(await tool.execute({ pattern: "TODO" }, makeCtx(fs)));
    expect(result).toBe("/a.ts");
  });

  it("truncates files-mode at the 100-file cap with guidance", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 150; i++) files[`f${i}.ts`] = "TODO";
    const fs = fromMemory(files);
    const tool = createGrepTool();

    const result = expectText(await tool.execute({ pattern: "TODO" }, makeCtx(fs)));
    expect(result).toContain("[truncated:");
    expect(result).toContain("100 of 150");
  });

  it("truncates content-mode at the 500-line cap with guidance", async () => {
    const lines = Array.from({ length: 600 }, (_, i) => `TODO-${i}`);
    const fs = fromMemory({ "a.ts": lines.join("\n") });
    const tool = createGrepTool();

    const result = expectText(await tool.execute({ pattern: "TODO", mode: "content" }, makeCtx(fs)));
    expect(result).toContain("[truncated:");
    expect(result).toContain("500-line output cap");
    const matchedLines = result.split("\n").filter((l) => !l.startsWith("[truncated:"));
    expect(matchedLines).toHaveLength(500);
  });
});
