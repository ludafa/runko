import { describe, expect, it } from "vitest";
import { fromMemory } from "../../src/memory.js";
import { createReadFileTool } from "../../src/tools/read-file.js";
import { createMapReadStateStore, expectError, expectText, makeCtx } from "./helpers.js";

describe("read_file", () => {
  it("reads a small file cat -n style, 1-indexed line numbers", async () => {
    const fs = fromMemory({ "a.txt": "line1\nline2\nline3" });
    const readState = createMapReadStateStore();
    const tool = createReadFileTool({ readState });

    const result = expectText(await tool.execute({ path: "/a.txt" }, makeCtx(fs)));
    expect(result).toBe("     1\tline1\n     2\tline2\n     3\tline3");
  });

  it("registers readState after a successful read, keyed by the file's mtime", async () => {
    const fs = fromMemory({ "a.txt": "hello" });
    const readState = createMapReadStateStore();
    const tool = createReadFileTool({ readState });

    await tool.execute({ path: "/a.txt" }, makeCtx(fs));
    const stat = await fs.stat("/a.txt");
    expect(readState.get("/a.txt")).toBe(stat.mtime);
  });

  it("supports offset/limit pagination", async () => {
    const fs = fromMemory({ "a.txt": "l1\nl2\nl3\nl4\nl5" });
    const tool = createReadFileTool({ readState: createMapReadStateStore() });

    const result = expectText(await tool.execute({ path: "/a.txt", offset: 1, limit: 2 }, makeCtx(fs)));
    expect(result).toBe("     2\tl2\n     3\tl3");
  });

  it("truncates at the 2000-line budget and tells the model how to page further", async () => {
    const lines = Array.from({ length: 2500 }, (_, i) => `line-${i}`);
    const fs = fromMemory({ "big.txt": lines.join("\n") });
    const tool = createReadFileTool({ readState: createMapReadStateStore() });

    const result = expectText(await tool.execute({ path: "/big.txt" }, makeCtx(fs)));
    const outputLines = result.split("\n");
    expect(outputLines[0]).toBe("     1\tline-0");
    expect(result).toContain("[truncated:");
    expect(result).toContain("2000-line budget");
    expect(result).toContain("offset=2000");
    expect(result.match(/^\s*\d+\t/gm)?.length).toBe(2000); // exactly 2000 numbered lines, plus the trailing notice line
  });

  it("truncates at the 256KB budget even under the 2000-line cap", async () => {
    const bigLine = "x".repeat(100_000);
    const fs = fromMemory({ "wide.txt": [bigLine, bigLine, bigLine, bigLine].join("\n") }); // ~400KB total, 4 lines
    const tool = createReadFileTool({ readState: createMapReadStateStore() });

    const result = expectText(await tool.execute({ path: "/wide.txt" }, makeCtx(fs)));
    expect(result).toContain("[truncated:");
    expect(result).toContain("256KB size budget");
    expect(result.match(/^\s*\d+\t/gm)?.length).toBeLessThan(4);
  });

  it("errors with guidance when offset is at or beyond the end of the file", async () => {
    const fs = fromMemory({ "a.txt": "l1\nl2" });
    const tool = createReadFileTool({ readState: createMapReadStateStore() });

    const content = expectError(await tool.execute({ path: "/a.txt", offset: 5 }, makeCtx(fs)));
    expect(content).toContain("offset 5");
    expect(content).toContain("2 lines");
  });

  it("reports an empty file distinctly", async () => {
    const fs = fromMemory({ "empty.txt": "" });
    const tool = createReadFileTool({ readState: createMapReadStateStore() });

    const result = expectText(await tool.execute({ path: "/empty.txt" }, makeCtx(fs)));
    expect(result).toBe("(empty file)");
  });

  it("errors with guidance when the path is a directory", async () => {
    const fs = fromMemory({ "dir/a.txt": "x" });
    const tool = createReadFileTool({ readState: createMapReadStateStore() });

    const content = expectError(await tool.execute({ path: "/dir" }, makeCtx(fs)));
    expect(content).toContain("directory");
    expect(content).toContain("list_dir");
  });

  it("surfaces a path that escapes the virtual root as a guided error, without the tool re-implementing the check (§0.2: FS layer owns path safety)", async () => {
    const fs = fromMemory({ "a.txt": "x" });
    const tool = createReadFileTool({ readState: createMapReadStateStore() });

    const content = expectError(await tool.execute({ path: "/../../escape.txt" }, makeCtx(fs)));
    expect(content).toContain("escape");
  });

  it("errors with guidance when the path does not exist", async () => {
    const fs = fromMemory({});
    const tool = createReadFileTool({ readState: createMapReadStateStore() });

    const content = expectError(await tool.execute({ path: "/missing.txt" }, makeCtx(fs)));
    expect(content).toContain("does not exist");
  });

  it("returns structured guidance (not a bare error) for a binary file", async () => {
    const fs = fromMemory({ "logo.png": new Uint8Array([1, 2, 3, 4]) });
    const tool = createReadFileTool({ readState: createMapReadStateStore() });

    const result = await tool.execute({ path: "/logo.png" }, makeCtx(fs));
    expect(typeof result).toBe("object");
    if (typeof result === "object" && result !== null && !Array.isArray(result)) {
      expect(result.isError).toBeUndefined();
      expect(result.type).toBe("binary");
      expect(result.path).toBe("/logo.png");
      expect(result.mimeType).toBe("image/png");
      expect(result.size).toBe(4);
      expect(typeof result.hint).toBe("string");
    }
  });

  it("treats a file with no recognized extension (Makefile-like) as text, not binary", async () => {
    const fs = fromMemory({ Makefile: "build:\n\techo hi" });
    const tool = createReadFileTool({ readState: createMapReadStateStore() });

    const result = expectText(await tool.execute({ path: "/Makefile" }, makeCtx(fs)));
    expect(result).toContain("build:");
  });

  it("returns structured guidance sourced from ReferenceNotResolvable when no resolver is injected", async () => {
    const fs = fromMemory({
      "builds/app.apk": {
        ref: "https://ci.example.com/build/123",
        mimeType: "application/vnd.android.package-archive",
        annotations: { description: "latest CI build" },
      },
    });
    const tool = createReadFileTool({ readState: createMapReadStateStore() });

    const result = await tool.execute({ path: "/builds/app.apk" }, makeCtx(fs));
    expect(typeof result).toBe("object");
    if (typeof result === "object" && result !== null && !Array.isArray(result)) {
      expect(result.isError).toBeUndefined();
      expect(result.type).toBe("reference");
      expect(result.path).toBe("/builds/app.apk");
      expect(result.href).toBe("https://ci.example.com/build/123");
      expect(result.mimeType).toBe("application/vnd.android.package-archive");
      expect(result.description).toBe("latest CI build");
    }
  });

  it("reads reference content directly when a resolveReference is injected", async () => {
    const fs = fromMemory(
      { "builds/notes.txt": { ref: "https://ci.example.com/notes" } },
      { resolveReference: async () => new TextEncoder().encode("resolved line1\nresolved line2") },
    );
    const tool = createReadFileTool({ readState: createMapReadStateStore() });

    const result = expectText(await tool.execute({ path: "/builds/notes.txt" }, makeCtx(fs)));
    expect(result).toBe("     1\tresolved line1\n     2\tresolved line2");
  });
});
