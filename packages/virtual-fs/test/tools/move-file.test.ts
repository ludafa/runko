import { describe, expect, it } from "vitest";
import { fromMemory } from "../../src/memory.js";
import { OverlayFS } from "../../src/overlay.js";
import { createMoveFileTool } from "../../src/tools/move-file.js";
import { createMapReadStateStore, createOnFileChangeMock, expectError, expectText, makeCtx } from "./helpers.js";

describe("move-file", () => {
  it("moves a single file, producing a delete(from)+add(to) file_change pair in that order", async () => {
    const fs = fromMemory({ "a.txt": "content" });
    const onFileChange = createOnFileChangeMock();
    const tool = createMoveFileTool({ readState: createMapReadStateStore(), onFileChange });

    const result = expectText(await tool.execute({ from: "/a.txt", to: "/b.txt" }, makeCtx(fs)));
    expect(result).toContain('"/a.txt"');
    expect(result).toContain('"/b.txt"');
    expect(new TextDecoder().decode(await fs.readFile("/b.txt"))).toBe("content");
    await expect(fs.stat("/a.txt")).rejects.toThrow();
    expect(onFileChange).toHaveBeenCalledWith([
      { path: "/a.txt", kind: "delete" },
      { path: "/b.txt", kind: "add" },
    ]);
  });

  it("rejects moving onto an existing target without overwrite", async () => {
    const fs = fromMemory({ "a.txt": "1", "b.txt": "2" });
    const tool = createMoveFileTool({ readState: createMapReadStateStore() });

    const content = expectError(await tool.execute({ from: "/a.txt", to: "/b.txt" }, makeCtx(fs)));
    expect(content).toContain("already exists");
    expect(content).toContain("overwrite");
    expect(new TextDecoder().decode(await fs.readFile("/b.txt"))).toBe("2"); // untouched
  });

  it("overwrite:true replaces the existing target", async () => {
    const fs = fromMemory({ "a.txt": "new-content", "b.txt": "old-content" });
    const tool = createMoveFileTool({ readState: createMapReadStateStore() });

    await tool.execute({ from: "/a.txt", to: "/b.txt", overwrite: true }, makeCtx(fs));
    expect(new TextDecoder().decode(await fs.readFile("/b.txt"))).toBe("new-content");
    await expect(fs.stat("/a.txt")).rejects.toThrow();
  });

  it("moves a directory, relocating every file beneath it and emitting a pair per file", async () => {
    const fs = fromMemory({ "src/a.txt": "1", "src/nested/b.txt": "2" });
    const onFileChange = createOnFileChangeMock();
    const tool = createMoveFileTool({ readState: createMapReadStateStore(), onFileChange });

    await tool.execute({ from: "/src", to: "/dst" }, makeCtx(fs));

    expect(new TextDecoder().decode(await fs.readFile("/dst/a.txt"))).toBe("1");
    expect(new TextDecoder().decode(await fs.readFile("/dst/nested/b.txt"))).toBe("2");
    await expect(fs.stat("/src")).rejects.toThrow();

    expect(onFileChange).toHaveBeenCalledTimes(1);
    const changes = onFileChange.mock.calls[0]?.[0] ?? [];
    const deletes = new Set(changes.filter((c) => c.kind === "delete").map((c) => c.path));
    const adds = new Set(changes.filter((c) => c.kind === "add").map((c) => c.path));
    expect(deletes).toEqual(new Set(["/src/a.txt", "/src/nested/b.txt"]));
    expect(adds).toEqual(new Set(["/dst/a.txt", "/dst/nested/b.txt"]));
  });

  it("rejects moving a directory into its own subtree", async () => {
    const fs = fromMemory({ "src/a.txt": "1" });
    const tool = createMoveFileTool({ readState: createMapReadStateStore() });

    const content = expectError(await tool.execute({ from: "/src", to: "/src/nested" }, makeCtx(fs)));
    expect(content).toContain("own subtree");
  });

  it("rejects moving a directory that contains a reference entry, without touching anything", async () => {
    const fs = fromMemory({ "src/a.txt": "1", "src/ref.apk": { ref: "https://x" } });
    const tool = createMoveFileTool({ readState: createMapReadStateStore() });

    const content = expectError(await tool.execute({ from: "/src", to: "/dst" }, makeCtx(fs)));
    expect(content).toContain("reference entry");
    // nothing moved — the whole directory is untouched
    await expect(fs.stat("/src/a.txt")).resolves.toBeDefined();
    await expect(fs.stat("/dst")).rejects.toThrow();
  });

  it("rejects moving a single unresolved reference file", async () => {
    const fs = fromMemory({ "a.apk": { ref: "https://x" } });
    const tool = createMoveFileTool({ readState: createMapReadStateStore() });

    const content = expectError(await tool.execute({ from: "/a.apk", to: "/b.apk" }, makeCtx(fs)));
    expect(content).toContain("reference entry");
  });

  it("errors when from does not exist", async () => {
    const fs = fromMemory({});
    const tool = createMoveFileTool({ readState: createMapReadStateStore() });

    const content = expectError(await tool.execute({ from: "/missing.txt", to: "/b.txt" }, makeCtx(fs)));
    expect(content).toContain("does not exist");
  });

  it("errors when from and to are the same path", async () => {
    const fs = fromMemory({ "a.txt": "1" });
    const tool = createMoveFileTool({ readState: createMapReadStateStore() });

    const content = expectError(await tool.execute({ from: "/a.txt", to: "/a.txt" }, makeCtx(fs)));
    expect(content).toContain("nothing to move");
  });

  it("produces a diff()/writeBack()-consistent delete+add pair when moving a base file on an OverlayFS", async () => {
    const base = fromMemory({ "a.txt": "base-content\n" });
    const fs = new OverlayFS(base);
    const tool = createMoveFileTool({ readState: createMapReadStateStore() });

    await tool.execute({ from: "/a.txt", to: "/b.txt" }, makeCtx(fs));

    const diffs = await fs.diff();
    const byPath = Object.fromEntries(diffs.map((d) => [d.path, d]));
    expect(byPath["/a.txt"]?.kind).toBe("deleted");
    expect(byPath["/b.txt"]?.kind).toBe("created");
    expect(byPath["/b.txt"]?.after).toBe("base-content\n");
    // base itself is untouched — this is purely an overlay-level move
    expect(new TextDecoder().decode(await base.readFile("/a.txt"))).toBe("base-content\n");
  });
});
