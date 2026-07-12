import { describe, expect, it } from "vitest";
import { MemoryFS, fromMemory } from "../../src/memory.js";
import { createListDirTool } from "../../src/tools/list-dir.js";
import { expectError, expectText, makeCtx } from "./helpers.js";

describe("list_dir", () => {
  it("defaults to the root at depth 1: immediate children only, subdirectories not expanded", async () => {
    const fs = fromMemory({ "a.txt": "1", "dir/b.txt": "2" });
    const tool = createListDirTool();

    const result = expectText(await tool.execute({}, makeCtx(fs)));
    expect(result).toContain("a.txt");
    expect(result).toContain("dir/");
    expect(result).not.toContain("b.txt"); // not expanded at depth 1
  });

  it("depth:2 expands one more level", async () => {
    const fs = fromMemory({ "dir/b.txt": "2" });
    const tool = createListDirTool();

    const result = expectText(await tool.execute({ depth: 2 }, makeCtx(fs)));
    expect(result).toContain("dir/");
    expect(result).toContain("b.txt");
  });

  it("annotates non-text files with [mimeType] but leaves text files unannotated", async () => {
    const fs = fromMemory({ "logo.png": new Uint8Array([1, 2, 3]), "readme.txt": "hi" });
    const tool = createListDirTool();

    const result = expectText(await tool.execute({}, makeCtx(fs)));
    expect(result).toContain("logo.png [image/png]");
    expect(result.split("\n")).toContain("readme.txt"); // no bracketed mimeType suffix
    expect(result).not.toContain("readme.txt [");
  });

  it("annotates reference entries with '→ href' and appends descriptions", async () => {
    const fs = fromMemory({
      "builds/app.apk": {
        ref: "https://ci.example.com/build/123",
        mimeType: "application/vnd.android.package-archive",
        annotations: { description: "latest CI build" },
      },
    });
    const tool = createListDirTool();

    const result = expectText(await tool.execute({ path: "/builds" }, makeCtx(fs)));
    expect(result).toContain("app.apk → https://ci.example.com/build/123");
    expect(result).toContain("— latest CI build");
  });

  it("reports an empty directory distinctly", async () => {
    const fs = new MemoryFS();
    await fs.mkdir("/empty");
    const tool = createListDirTool();

    const result = expectText(await tool.execute({ path: "/empty" }, makeCtx(fs)));
    expect(result).toContain("(empty directory)");
  });

  it("truncates at the 500-entry cap with guidance to narrow the listing", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 600; i++) files[`f${i}.txt`] = "x";
    const fs = fromMemory(files);
    const tool = createListDirTool();

    const result = expectText(await tool.execute({}, makeCtx(fs)));
    expect(result).toContain("[truncated:");
    expect(result).toContain("500-entry limit");
    expect(result).toContain("glob");
  });

  it("errors when the path is a file", async () => {
    const fs = fromMemory({ "a.txt": "x" });
    const tool = createListDirTool();

    const content = expectError(await tool.execute({ path: "/a.txt" }, makeCtx(fs)));
    expect(content).toContain("read_file");
  });

  it("errors when the path does not exist", async () => {
    const fs = fromMemory({});
    const tool = createListDirTool();

    const content = expectError(await tool.execute({ path: "/missing" }, makeCtx(fs)));
    expect(content).toContain("does not exist");
  });
});
