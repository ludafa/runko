import { SearchUnsupportedError } from "@runko/core";
import { describe, expect, it, vi } from "vitest";
import { fromMemory } from "../../src/memory.js";
import { createGlobTool } from "../../src/tools/glob.js";
import { expectError, expectText, makeCtx } from "./helpers.js";
import { NativeSearchFake, ThrowingSearchFake } from "./search-fakes.js";

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
    for (let i = 0; i < 1200; i++) {files[`f${i}.ts`] = "x";}
    const fs = fromMemory(files);
    const tool = createGlobTool();

    const result = expectText(await tool.execute({ pattern: "*.ts" }, makeCtx(fs)));
    expect(result).toContain("[truncated:");
    expect(result).toContain("1000 of 1200");
    const matchedLines = result.split("\n").filter((l) => !l.startsWith("[truncated:"));
    expect(matchedLines).toHaveLength(1000);
  });

  it("does not truncate when the match count lands exactly on the 1000 cap (boundary: <= is not truncated)", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 1000; i++) {files[`f${i}.ts`] = "x";}
    const fs = fromMemory(files);
    const tool = createGlobTool();

    const result = expectText(await tool.execute({ pattern: "*.ts" }, makeCtx(fs)));
    expect(result).not.toContain("[truncated:");
    expect(result.split("\n")).toHaveLength(1000);
  });
});

describe("glob: default ignore (.git/node_modules, docs/tech/sandbox.md §4)", () => {
  function fsWithIgnoredDirs() {
    return fromMemory({
      "src/a.ts": "1",
      ".git/config": "2",
      ".git/objects/pack.idx": "3",
      "node_modules/pkg/index.js": "4",
    });
  }

  it("skips .git and node_modules by default even under a broad pattern", async () => {
    const fs = fsWithIgnoredDirs();
    const tool = createGlobTool();

    const result = expectText(await tool.execute({ pattern: "**/*" }, makeCtx(fs)));
    expect(result.split("\n")).toEqual(["/src/a.ts"]);
  });

  it("a pattern that spells out .git without pointing path at it still gets ignored (only path explicitly inside opts in)", async () => {
    const fs = fsWithIgnoredDirs();
    const tool = createGlobTool();

    const result = await tool.execute({ pattern: "**/.git/**" }, makeCtx(fs));
    expect(typeof result).toBe("string");
    expect(String(result)).toContain("No files matched");
  });

  it("path explicitly pointing inside /.git opts that subtree back in", async () => {
    const fs = fsWithIgnoredDirs();
    const tool = createGlobTool();

    const result = expectText(await tool.execute({ pattern: "**/*", path: "/.git" }, makeCtx(fs)));
    expect(result.split("\n").sort()).toEqual(["/.git/config", "/.git/objects/pack.idx"]);
  });

  it("path explicitly pointing inside /node_modules opts that subtree back in", async () => {
    const fs = fsWithIgnoredDirs();
    const tool = createGlobTool();

    const result = expectText(await tool.execute({ pattern: "**/*", path: "/node_modules" }, makeCtx(fs)));
    expect(result.split("\n")).toEqual(["/node_modules/pkg/index.js"]);
  });
});

describe("glob: native search path (ctx.fs.searchFiles)", () => {
  it("prefers searchFiles over glob()/readFile() when the FS implements it", async () => {
    const fs = fromMemory({ "src/a.ts": "1", "src/b.ts": "2", "other/c.ts": "3" });
    const globSpy = vi.spyOn(fs, "glob");
    const native = new NativeSearchFake(fs);
    const tool = createGlobTool();

    const result = expectText(await tool.execute({ pattern: "**/*.ts", path: "/src" }, makeCtx(native)));

    expect(result.split("\n")).toEqual(["/src/a.ts", "/src/b.ts"]);
    expect(native.fileSearchCalls).toHaveLength(1);
    expect(globSpy).not.toHaveBeenCalled();
  });

  it("passes pattern/ignore/limit through the query exactly as the fallback path would compute them", async () => {
    const fs = fromMemory({ "src/a.ts": "1" });
    const native = new NativeSearchFake(fs);
    const tool = createGlobTool();

    await tool.execute({ pattern: "*.ts", path: "/src" }, makeCtx(native));

    expect(native.fileSearchCalls[0]).toEqual({
      pattern: "/src/*.ts",
      ignore: ["**/.git", "**/node_modules"],
      limit: 1000,
    });
  });

  it("drops the default-ignore entry whose directory the path parameter explicitly points inside", async () => {
    const fs = fromMemory({ ".git/config": "1" });
    const native = new NativeSearchFake(fs);
    const tool = createGlobTool();

    await tool.execute({ pattern: "*", path: "/.git" }, makeCtx(native));

    expect(native.fileSearchCalls[0]?.ignore).toEqual(["**/node_modules"]);
  });

  it("native and JS-fallback paths produce byte-identical output for the same fixture (no path scope, has matches)", async () => {
    const files = { "src/b.ts": "1", "src/a.ts": "2", "src/nested/c.ts": "3", "src/d.js": "4" };
    const tool = createGlobTool();

    const nativeResult = expectText(await tool.execute({ pattern: "**/*.ts" }, makeCtx(new NativeSearchFake(fromMemory(files)))));
    const fallbackResult = expectText(await tool.execute({ pattern: "**/*.ts" }, makeCtx(fromMemory(files))));

    expect(nativeResult).toBe(fallbackResult);
  });

  it("native and JS-fallback paths produce byte-identical output when nothing matches", async () => {
    const files = { "a.txt": "1" };
    const tool = createGlobTool();

    const nativeResult = await tool.execute({ pattern: "*.ts" }, makeCtx(new NativeSearchFake(fromMemory(files))));
    const fallbackResult = await tool.execute({ pattern: "*.ts" }, makeCtx(fromMemory(files)));

    expect(nativeResult).toEqual(fallbackResult);
  });

  it("native and JS-fallback paths produce byte-identical truncation notices at the 1000/1200 cap", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 1200; i++) {files[`f${i}.ts`] = "x";}
    const tool = createGlobTool();

    const nativeResult = expectText(await tool.execute({ pattern: "*.ts" }, makeCtx(new NativeSearchFake(fromMemory(files)))));
    const fallbackResult = expectText(await tool.execute({ pattern: "*.ts" }, makeCtx(fromMemory(files))));

    expect(nativeResult).toBe(fallbackResult);
    expect(nativeResult).toContain("1000 of 1200");
  });
});

describe("glob: SearchUnsupportedError falls back to JS scanning", () => {
  it("falls back silently and returns the same result the JS path would produce", async () => {
    const files = { "src/a.ts": "1", "src/b.ts": "2" };
    const tool = createGlobTool();
    const throwing = new ThrowingSearchFake(fromMemory(files), new SearchUnsupportedError());

    const globSpy = vi.spyOn(throwing, "glob");
    const result = expectText(await tool.execute({ pattern: "**/*.ts" }, makeCtx(throwing)));
    const fallbackResult = expectText(await tool.execute({ pattern: "**/*.ts" }, makeCtx(fromMemory(files))));

    expect(result).toBe(fallbackResult);
    expect(globSpy).toHaveBeenCalled(); // proves the fallback path (glob()) actually ran, not just an empty native result.
  });
});

describe("glob: a non-SearchUnsupportedError from searchFiles surfaces via errorResult, not a silent fallback", () => {
  it("reports the underlying error message and does not retry via glob()", async () => {
    const files = { "src/a.ts": "1" };
    const tool = createGlobTool();
    const throwing = new ThrowingSearchFake(fromMemory(files), new Error("sandbox network dropped"));
    const globSpy = vi.spyOn(throwing, "glob");

    const content = expectError(await tool.execute({ pattern: "**/*.ts" }, makeCtx(throwing)));

    expect(content).toContain("sandbox network dropped");
    expect(globSpy).not.toHaveBeenCalled();
  });
});
