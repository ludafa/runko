import { describe, expect, it } from "vitest";
import { fromMemory } from "../../src/memory.js";
import { OverlayFS } from "../../src/overlay.js";
import { createDeleteFileTool } from "../../src/tools/delete-file.js";
import { createMapReadStateStore, createOnFileChangeMock, expectError, expectText, makeCtx } from "./helpers.js";

describe("delete_file", () => {
  it("deletes a single file and reports a delete file_change", async () => {
    const fs = fromMemory({ "a.txt": "x" });
    const onFileChange = createOnFileChangeMock();
    const tool = createDeleteFileTool({ readState: createMapReadStateStore(), onFileChange });

    const result = expectText(await tool.execute({ path: "/a.txt" }, makeCtx(fs)));
    expect(result).toContain("Deleted");
    await expect(fs.stat("/a.txt")).rejects.toThrow();
    expect(onFileChange).toHaveBeenCalledWith([{ path: "/a.txt", kind: "delete" }]);
  });

  it("rejects deleting a directory without recursive:true, even when it's empty", async () => {
    const fs = fromMemory({});
    await fs.mkdir("/empty-dir");
    const onFileChange = createOnFileChangeMock();
    const tool = createDeleteFileTool({ readState: createMapReadStateStore(), onFileChange });

    const content = expectError(await tool.execute({ path: "/empty-dir" }, makeCtx(fs)));
    expect(content).toContain("recursive");
    expect(onFileChange).not.toHaveBeenCalled();
  });

  it("recursively deletes a directory, expanding it into one file_change per file", async () => {
    const fs = fromMemory({ "dir/a.txt": "1", "dir/nested/b.txt": "2", "keep.txt": "3" });
    const onFileChange = createOnFileChangeMock();
    const tool = createDeleteFileTool({ readState: createMapReadStateStore(), onFileChange });

    const result = expectText(await tool.execute({ path: "/dir", recursive: true }, makeCtx(fs)));
    expect(result).toContain("2 files");
    await expect(fs.stat("/dir")).rejects.toThrow();
    expect(new TextDecoder().decode(await fs.readFile("/keep.txt"))).toBe("3"); // untouched

    expect(onFileChange).toHaveBeenCalledTimes(1);
    const changes = onFileChange.mock.calls[0]?.[0] ?? [];
    expect(new Set(changes.map((c) => c.path))).toEqual(new Set(["/dir/a.txt", "/dir/nested/b.txt"]));
    expect(changes.every((c) => c.kind === "delete")).toBe(true);
  });

  it("recursive delete of an empty directory does not report any file_change (no files under it)", async () => {
    const fs = fromMemory({});
    await fs.mkdir("/empty-dir");
    const onFileChange = createOnFileChangeMock();
    const tool = createDeleteFileTool({ readState: createMapReadStateStore(), onFileChange });

    await tool.execute({ path: "/empty-dir", recursive: true }, makeCtx(fs));
    expect(onFileChange).not.toHaveBeenCalled();
  });

  it("deleting a directory from an OverlayFS base leaves tombstones and a correct three-state diff", async () => {
    const base = fromMemory({ "dir/a.txt": "base-a\n", "dir/nested/b.txt": "base-b\n", "keep.txt": "keep\n" });
    const fs = new OverlayFS(base);
    const tool = createDeleteFileTool({ readState: createMapReadStateStore() });

    await tool.execute({ path: "/dir", recursive: true }, makeCtx(fs));

    await expect(fs.stat("/dir")).rejects.toThrow();
    await expect(fs.stat("/dir/a.txt")).rejects.toThrow();
    // base itself is untouched — the tombstone lives only in the overlay's view
    expect(new TextDecoder().decode(await base.readFile("/dir/a.txt"))).toBe("base-a\n");

    const diffs = await fs.diff();
    const byPath = Object.fromEntries(diffs.map((d) => [d.path, d]));
    expect(byPath["/dir/a.txt"]?.kind).toBe("deleted");
    expect(byPath["/dir/nested/b.txt"]?.kind).toBe("deleted");
    expect(byPath["/keep.txt"]).toBeUndefined();
  });

  it("errors when the path does not exist", async () => {
    const fs = fromMemory({});
    const tool = createDeleteFileTool({ readState: createMapReadStateStore() });

    const content = expectError(await tool.execute({ path: "/missing.txt" }, makeCtx(fs)));
    expect(content).toContain("does not exist");
  });
});
