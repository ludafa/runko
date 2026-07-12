import { describe, expect, it } from "vitest";
import { fromMemory } from "../../src/memory.js";
import { createGlobTool } from "../../src/tools/glob.js";
import { expectText, makeCtx } from "./helpers.js";

describe("glob", () => {
  it("matches files by pattern across the whole tree, sorted by path", async () => {
    const fs = fromMemory({ "src/b.ts": "1", "src/a.ts": "2", "src/nested/c.ts": "3", "src/d.js": "4" });
    const tool = createGlobTool();

    const result = expectText(await tool.execute({ pattern: "**/*.ts" }, makeCtx(fs)));
    expect(result.split("\n")).toEqual(["/src/a.ts", "/src/b.ts", "/src/nested/c.ts"]);
  });

  it("scopes matching under the given path", async () => {
    const fs = fromMemory({ "src/a.ts": "1", "other/b.ts": "2" });
    const tool = createGlobTool();

    const result = expectText(await tool.execute({ pattern: "*.ts", path: "/src" }, makeCtx(fs)));
    expect(result).toBe("/src/a.ts");
  });

  it("returns an informative (non-error) message when nothing matches", async () => {
    const fs = fromMemory({ "a.txt": "1" });
    const tool = createGlobTool();

    const result = await tool.execute({ pattern: "*.ts" }, makeCtx(fs));
    expect(typeof result).toBe("string");
    expect(String(result)).toContain("No files matched");
  });

  it("truncates at the 1000-match cap with guidance to narrow the pattern", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 1200; i++) files[`f${i}.ts`] = "x";
    const fs = fromMemory(files);
    const tool = createGlobTool();

    const result = expectText(await tool.execute({ pattern: "*.ts" }, makeCtx(fs)));
    expect(result).toContain("[truncated:");
    expect(result).toContain("1000 of 1200");
    const matchedLines = result.split("\n").filter((l) => !l.startsWith("[truncated:"));
    expect(matchedLines).toHaveLength(1000);
  });
});
