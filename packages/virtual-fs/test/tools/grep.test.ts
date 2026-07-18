import { SearchUnsupportedError } from "@nimbo/core";
import { describe, expect, it, vi } from "vitest";
import { fromMemory } from "../../src/memory.js";
import { createGrepTool } from "../../src/tools/grep.js";
import { expectError, expectText, makeCtx } from "./helpers.js";
import { NativeSearchFake, ThrowingSearchFake } from "./search-fakes.js";

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

  it("does not truncate files-mode when the match count lands exactly on the 100-file cap", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 100; i++) files[`f${i}.ts`] = "TODO";
    const fs = fromMemory(files);
    const tool = createGrepTool();

    const result = expectText(await tool.execute({ pattern: "TODO" }, makeCtx(fs)));
    expect(result).not.toContain("[truncated:");
    expect(result.split("\n")).toHaveLength(100);
  });

  it("does not truncate content-mode when the total line count lands exactly on the 500-line cap", async () => {
    const lines = Array.from({ length: 500 }, (_, i) => `TODO-${i}`);
    const fs = fromMemory({ "a.ts": lines.join("\n") });
    const tool = createGrepTool();

    const result = expectText(await tool.execute({ pattern: "TODO", mode: "content" }, makeCtx(fs)));
    expect(result).not.toContain("[truncated:");
    expect(result.split("\n")).toHaveLength(500);
  });

  it("file-count cap and line cap are independent: file count exceeds 100 but total selected lines stay under 500 reports the file-count reason", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 150; i++) files[`f${i}.ts`] = `TODO-${i}`; // 1 matching line per file
    const fs = fromMemory(files);
    const tool = createGrepTool();

    const result = expectText(await tool.execute({ pattern: "TODO", mode: "content" }, makeCtx(fs)));
    expect(result).toContain("[truncated:");
    expect(result).toContain("100 of 150 matching files");
    expect(result).not.toContain("500-line output cap");
    const matchedLines = result.split("\n").filter((l) => !l.startsWith("[truncated:"));
    expect(matchedLines).toHaveLength(100); // one line per file, well under the 500-line cap
  });

  it("file-count cap and line cap are independent: file count stays under 100 but total lines exceed 500 reports the line-cap reason", async () => {
    const fs = fromMemory({
      "a.ts": Array.from({ length: 300 }, (_, i) => `TODO-a-${i}`).join("\n"),
      "b.ts": Array.from({ length: 300 }, (_, i) => `TODO-b-${i}`).join("\n"),
    });
    const tool = createGrepTool();

    const result = expectText(await tool.execute({ pattern: "TODO", mode: "content" }, makeCtx(fs)));
    expect(result).toContain("[truncated:");
    expect(result).toContain("500-line output cap");
    expect(result).not.toContain("matching files");
    const matchedLines = result.split("\n").filter((l) => !l.startsWith("[truncated:"));
    expect(matchedLines).toHaveLength(500);
  });
});

describe("grep: default ignore (.git/node_modules, docs/tech/sandbox.md §4)", () => {
  function fsWithIgnoredDirs() {
    return fromMemory({
      "src/a.ts": "TODO",
      ".git/config": "TODO",
      "node_modules/pkg/index.js": "TODO",
    });
  }

  it("files mode: skips .git and node_modules by default", async () => {
    const fs = fsWithIgnoredDirs();
    const tool = createGrepTool();

    const result = expectText(await tool.execute({ pattern: "TODO" }, makeCtx(fs)));
    expect(result.split("\n")).toEqual(["/src/a.ts"]);
  });

  it("content mode: skips .git and node_modules by default", async () => {
    const fs = fsWithIgnoredDirs();
    const tool = createGrepTool();

    const result = expectText(await tool.execute({ pattern: "TODO", mode: "content" }, makeCtx(fs)));
    expect(result).toBe("/src/a.ts:1:TODO");
  });

  it("path explicitly pointing inside /.git opts that subtree back in", async () => {
    const fs = fsWithIgnoredDirs();
    const tool = createGrepTool();

    const result = expectText(await tool.execute({ pattern: "TODO", path: "/.git" }, makeCtx(fs)));
    expect(result).toBe("/.git/config");
  });

  it("path explicitly pointing inside /node_modules opts that subtree back in", async () => {
    const fs = fsWithIgnoredDirs();
    const tool = createGrepTool();

    const result = expectText(await tool.execute({ pattern: "TODO", path: "/node_modules" }, makeCtx(fs)));
    expect(result).toBe("/node_modules/pkg/index.js");
  });
});

describe("grep: native search path (ctx.fs.searchContent)", () => {
  it("prefers searchContent over the glob()+per-file-read fallback when the FS implements it", async () => {
    // glob() is the first thing fallbackSearchContent() calls (candidate discovery) — asserting it
    // never fires is proof the fallback path didn't run at all, independent of whatever the native
    // implementation itself does internally to compute its answer.
    const fs = fromMemory({ "src/a.ts": "TODO", "src/b.ts": "nope" });
    const globSpy = vi.spyOn(fs, "glob");
    const native = new NativeSearchFake(fs);
    const tool = createGrepTool();

    const result = expectText(await tool.execute({ pattern: "TODO", path: "/src" }, makeCtx(native)));

    expect(result).toBe("/src/a.ts");
    expect(native.contentSearchCalls).toHaveLength(1);
    expect(globSpy).not.toHaveBeenCalled();
  });

  it("passes scope/ignore/mode/context/ignoreCase/caps through the query exactly", async () => {
    const fs = fromMemory({ "src/a.ts": "TODO" });
    const native = new NativeSearchFake(fs);
    const tool = createGrepTool();

    await tool.execute({ pattern: "TODO", path: "/src", glob: "*.ts", mode: "content", context: 2, ignore_case: true }, makeCtx(native));

    expect(native.contentSearchCalls[0]).toEqual({
      pattern: "TODO",
      ignoreCase: true,
      scope: "/src/*.ts",
      ignore: ["**/.git", "**/node_modules"],
      mode: "content",
      context: 2,
      maxFiles: 100,
      maxLines: 500,
    });
  });

  it("defaults mode to 'files' and leaves context undefined in the query when not provided", async () => {
    const fs = fromMemory({ "a.ts": "TODO" });
    const native = new NativeSearchFake(fs);
    const tool = createGrepTool();

    await tool.execute({ pattern: "TODO" }, makeCtx(native));

    expect(native.contentSearchCalls[0]?.mode).toBe("files");
    expect(native.contentSearchCalls[0]?.context).toBeUndefined();
  });

  it("native and JS-fallback paths produce byte-identical output: files mode", async () => {
    const files = { "a.ts": "export const TODO = 1;", "b.ts": "export const x = 2;", "c.ts": "// TODO: fix this" };
    const tool = createGrepTool();

    const nativeResult = expectText(await tool.execute({ pattern: "TODO" }, makeCtx(new NativeSearchFake(fromMemory(files)))));
    const fallbackResult = expectText(await tool.execute({ pattern: "TODO" }, makeCtx(fromMemory(files))));

    expect(nativeResult).toBe(fallbackResult);
  });

  it("native and JS-fallback paths produce byte-identical output: content mode with ±context", async () => {
    const files = { "a.ts": "l1\nl2\nTODO\nl4\nl5" };
    const tool = createGrepTool();

    const nativeResult = expectText(
      await tool.execute({ pattern: "TODO", mode: "content", context: 1 }, makeCtx(new NativeSearchFake(fromMemory(files)))),
    );
    const fallbackResult = expectText(await tool.execute({ pattern: "TODO", mode: "content", context: 1 }, makeCtx(fromMemory(files))));

    expect(nativeResult).toBe(fallbackResult);
    expect(nativeResult).toBe("/a.ts-2-l2\n/a.ts:3:TODO\n/a.ts-4-l4");
  });

  it("native and JS-fallback paths produce byte-identical output: ignore_case", async () => {
    const files = { "a.ts": "Todo item" };
    const tool = createGrepTool();

    const nativeResult = expectText(
      await tool.execute({ pattern: "todo", ignore_case: true }, makeCtx(new NativeSearchFake(fromMemory(files)))),
    );
    const fallbackResult = expectText(await tool.execute({ pattern: "todo", ignore_case: true }, makeCtx(fromMemory(files))));

    expect(nativeResult).toBe(fallbackResult);
  });

  it("native and JS-fallback paths produce byte-identical truncation notices: files-mode 100/150 cap", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 150; i++) files[`f${i}.ts`] = "TODO";
    const tool = createGrepTool();

    const nativeResult = expectText(await tool.execute({ pattern: "TODO" }, makeCtx(new NativeSearchFake(fromMemory(files)))));
    const fallbackResult = expectText(await tool.execute({ pattern: "TODO" }, makeCtx(fromMemory(files))));

    expect(nativeResult).toBe(fallbackResult);
    expect(nativeResult).toContain("100 of 150");
  });

  it("native and JS-fallback paths produce byte-identical truncation notices: content-mode 500/600 line cap", async () => {
    const lines = Array.from({ length: 600 }, (_, i) => `TODO-${i}`);
    const files = { "a.ts": lines.join("\n") };
    const tool = createGrepTool();

    const nativeResult = expectText(
      await tool.execute({ pattern: "TODO", mode: "content" }, makeCtx(new NativeSearchFake(fromMemory(files)))),
    );
    const fallbackResult = expectText(await tool.execute({ pattern: "TODO", mode: "content" }, makeCtx(fromMemory(files))));

    expect(nativeResult).toBe(fallbackResult);
    expect(nativeResult).toContain("500-line output cap");
  });
});

describe("grep: SearchUnsupportedError falls back to JS scanning", () => {
  it("falls back silently and returns the same result the JS path would produce", async () => {
    const files = { "a.ts": "TODO", "b.ts": "nope" };
    const tool = createGrepTool();
    const throwing = new ThrowingSearchFake(fromMemory(files), new SearchUnsupportedError());
    const globSpy = vi.spyOn(throwing, "glob");

    const result = expectText(await tool.execute({ pattern: "TODO" }, makeCtx(throwing)));
    const fallbackResult = expectText(await tool.execute({ pattern: "TODO" }, makeCtx(fromMemory(files))));

    expect(result).toBe(fallbackResult);
    expect(globSpy).toHaveBeenCalled(); // proves the fallback path actually ran.
  });
});

describe("grep: a non-SearchUnsupportedError from searchContent surfaces via errorResult, not a silent fallback", () => {
  it("reports the underlying error message and does not retry via glob()", async () => {
    const files = { "a.ts": "TODO" };
    const tool = createGrepTool();
    const throwing = new ThrowingSearchFake(fromMemory(files), new Error("sandbox network dropped"));
    const globSpy = vi.spyOn(throwing, "glob");

    const content = expectError(await tool.execute({ pattern: "TODO" }, makeCtx(throwing)));

    expect(content).toContain("sandbox network dropped");
    expect(globSpy).not.toHaveBeenCalled();
  });
});
