import * as nodeFs from "node:fs/promises";
import * as nodePath from "node:path";
import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunkoFS } from "@runko/core";
import { OverlayFS, fromDirectory } from "../src/overlay.js";
import { NotFoundError, fromMemory } from "../src/memory.js";

describe("OverlayFS read-through / write-shadow / delete-tombstone", () => {
  it("reads through to base when overlay has no entry", async () => {
    const base = fromMemory({ "a.txt": "base-a" });
    const fs = new OverlayFS(base);
    expect(new TextDecoder().decode(await fs.readFile("/a.txt"))).toBe("base-a");
  });

  it("writes shadow the base without mutating it", async () => {
    const base = fromMemory({ "a.txt": "base-a" });
    const fs = new OverlayFS(base);
    await fs.writeFile("/a.txt", "overlay-a");
    expect(new TextDecoder().decode(await fs.readFile("/a.txt"))).toBe("overlay-a");
    expect(new TextDecoder().decode(await base.readFile("/a.txt"))).toBe("base-a");
  });

  it("a new overlay-only file appears in readdir/glob alongside base files", async () => {
    const base = fromMemory({ "a.txt": "base-a" });
    const fs = new OverlayFS(base);
    await fs.writeFile("/c.txt", "new");
    const entries = await fs.readdir("/");
    expect(entries.map((e) => e.name).sort()).toEqual(["a.txt", "c.txt"]);
    expect(await fs.glob("*.txt")).toEqual(["/a.txt", "/c.txt"]);
  });

  it("deleting a base file leaves a tombstone: invisible in stat/readdir/glob", async () => {
    const base = fromMemory({ "a.txt": "base-a", "b.txt": "base-b" });
    const fs = new OverlayFS(base);
    await fs.rm("/b.txt");

    await expect(fs.stat("/b.txt")).rejects.toThrow(NotFoundError);
    const entries = await fs.readdir("/");
    expect(entries.map((e) => e.name)).toEqual(["a.txt"]);
    expect(await fs.glob("*.txt")).toEqual(["/a.txt"]);

    // base itself is untouched — the tombstone lives only in the overlay's view.
    expect(new TextDecoder().decode(await base.readFile("/b.txt"))).toBe("base-b");
  });

  it("recursively deleting a base directory hides every file beneath it", async () => {
    const base = fromMemory({ "dir/a.txt": "1", "dir/nested/b.txt": "2", "keep.txt": "3" });
    const fs = new OverlayFS(base);
    await fs.rm("/dir", { recursive: true });

    await expect(fs.stat("/dir")).rejects.toThrow(NotFoundError);
    await expect(fs.stat("/dir/a.txt")).rejects.toThrow(NotFoundError);
    await expect(fs.stat("/dir/nested/b.txt")).rejects.toThrow(NotFoundError);
    expect(await fs.glob("**/*.txt")).toEqual(["/keep.txt"]);
  });

  it("writing a new file under a previously-deleted base directory resurrects that path only", async () => {
    const base = fromMemory({ "dir/old.txt": "old" });
    const fs = new OverlayFS(base);
    await fs.rm("/dir", { recursive: true });
    await fs.writeFile("/dir/new.txt", "new");

    expect(new TextDecoder().decode(await fs.readFile("/dir/new.txt"))).toBe("new");
    await expect(fs.stat("/dir/old.txt")).rejects.toThrow(NotFoundError);
  });
});

describe("OverlayFS.diff()", () => {
  it("reports a genuine three-state diff against base", async () => {
    const base = fromMemory({ "a.txt": "base-a\n", "b.txt": "base-b\n" });
    const fs = new OverlayFS(base);
    await fs.writeFile("/a.txt", "overlay-a\n"); // modified
    await fs.writeFile("/c.txt", "new-c\n"); // created
    await fs.rm("/b.txt"); // deleted

    const diffs = await fs.diff();
    const byPath = Object.fromEntries(diffs.map((d) => [d.path, d]));

    expect(byPath["/a.txt"]?.kind).toBe("modified");
    expect(byPath["/a.txt"]?.before).toBe("base-a\n");
    expect(byPath["/a.txt"]?.after).toBe("overlay-a\n");
    expect(byPath["/a.txt"]?.patch).toContain("-base-a");
    expect(byPath["/a.txt"]?.patch).toContain("+overlay-a");

    expect(byPath["/c.txt"]?.kind).toBe("created");
    expect(byPath["/c.txt"]?.patch).toContain("+new-c");

    expect(byPath["/b.txt"]?.kind).toBe("deleted");
    expect(byPath["/b.txt"]?.before).toBe("base-b\n");
    expect(byPath["/b.txt"]?.patch).toContain("-base-b");
  });

  it("includes deleted files from a recursively removed base directory", async () => {
    const base = fromMemory({ "dir/a.txt": "1\n", "dir/nested/b.txt": "2\n" });
    const fs = new OverlayFS(base);
    await fs.rm("/dir", { recursive: true });

    const diffs = await fs.diff();
    const paths = diffs.map((d) => d.path).sort();
    expect(paths).toEqual(["/dir/a.txt", "/dir/nested/b.txt"]);
    expect(diffs.every((d) => d.kind === "deleted")).toBe(true);
  });

  it("omits unchanged files entirely", async () => {
    const base = fromMemory({ "a.txt": "unchanged" });
    const fs = new OverlayFS(base);
    await fs.writeFile("/a.txt", "unchanged"); // write identical content back
    const diffs = await fs.diff();
    expect(diffs).toEqual([]);
  });
});

describe("OverlayFS.writeBack()", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await nodeFs.mkdtemp(nodePath.join(os.tmpdir(), "runko-overlay-writeback-"));
  });

  afterEach(async () => {
    await nodeFs.rm(tmpDir, { recursive: true, force: true });
  });

  it("applies only the diff to an explicit targetDir, idempotently", async () => {
    const base = fromMemory({ "old.txt": "old-content" });
    const fs = new OverlayFS(base);
    await fs.writeFile("/new.txt", "new-content");
    await fs.rm("/old.txt");

    await fs.writeBack(tmpDir);
    const afterFirst = (await nodeFs.readdir(tmpDir)).sort();
    expect(afterFirst).toEqual(["new.txt"]);
    expect(await nodeFs.readFile(nodePath.join(tmpDir, "new.txt"), "utf-8")).toBe("new-content");

    await fs.writeBack(tmpDir); // idempotent: repeat call, same end state
    const afterSecond = (await nodeFs.readdir(tmpDir)).sort();
    expect(afterSecond).toEqual(afterFirst);
  });

  it("defaults targetDir to the DirFS base's root when mounted via fromDirectory", async () => {
    await nodeFs.writeFile(nodePath.join(tmpDir, "keep.txt"), "keep");
    await nodeFs.writeFile(nodePath.join(tmpDir, "old.txt"), "old");

    const fs = fromDirectory(tmpDir);
    await fs.writeFile("/new.txt", "new");
    await fs.rm("/old.txt");

    await fs.writeBack();
    expect(await nodeFs.readFile(nodePath.join(tmpDir, "keep.txt"), "utf-8")).toBe("keep");
    expect(await nodeFs.readFile(nodePath.join(tmpDir, "new.txt"), "utf-8")).toBe("new");
    await expect(nodeFs.stat(nodePath.join(tmpDir, "old.txt"))).rejects.toThrow();

    await fs.writeBack(); // idempotent second call onto the same real directory
    expect(await nodeFs.readFile(nodePath.join(tmpDir, "new.txt"), "utf-8")).toBe("new");
    await expect(nodeFs.stat(nodePath.join(tmpDir, "old.txt"))).rejects.toThrow();
  });

  it("throws when base is not a DirFS and no targetDir is given", async () => {
    const fs = new OverlayFS(fromMemory({}));
    await fs.writeFile("/a.txt", "a");
    await expect(fs.writeBack()).rejects.toThrow(/requires an explicit targetDir/);
  });
});

describe("OverlayFS.snapshot()/restore()", () => {
  it("restores both overlay writes and tombstones", async () => {
    const base = fromMemory({ "a.txt": "base-a", "b.txt": "base-b" });
    const fs = new OverlayFS(base);
    const snap = fs.snapshot();

    await fs.writeFile("/a.txt", "changed-a");
    await fs.rm("/b.txt");
    await fs.writeFile("/c.txt", "new-c");

    fs.restore(snap);

    expect(new TextDecoder().decode(await fs.readFile("/a.txt"))).toBe("base-a");
    expect(new TextDecoder().decode(await fs.readFile("/b.txt"))).toBe("base-b");
    await expect(fs.stat("/c.txt")).rejects.toThrow(NotFoundError);
  });
});

describe("fromDirectory", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await nodeFs.mkdtemp(nodePath.join(os.tmpdir(), "runko-fromdirectory-"));
    await nodeFs.mkdir(nodePath.join(tmpDir, "node_modules"), { recursive: true });
    await nodeFs.writeFile(nodePath.join(tmpDir, "a.txt"), "real-a");
    await nodeFs.writeFile(nodePath.join(tmpDir, "node_modules", "x.js"), "ignored");
  });

  afterEach(async () => {
    await nodeFs.rm(tmpDir, { recursive: true, force: true });
  });

  it("mounts a real directory as a read-through, zero-copy overlay", async () => {
    const fs = fromDirectory(tmpDir);
    expect(new TextDecoder().decode(await fs.readFile("/a.txt"))).toBe("real-a");
    await fs.writeFile("/a.txt", "virtual-a");
    expect(new TextDecoder().decode(await fs.readFile("/a.txt"))).toBe("virtual-a");
    // the real file on disk must remain untouched until writeBack() is called.
    expect(await nodeFs.readFile(nodePath.join(tmpDir, "a.txt"), "utf-8")).toBe("real-a");
  });

  it("passes through the ignore option to the underlying DirFS", async () => {
    const fs = fromDirectory(tmpDir, { ignore: ["node_modules"] });
    await expect(fs.stat("/node_modules/x.js")).rejects.toThrow(NotFoundError);
    expect((await fs.readdir("/")).map((e) => e.name)).not.toContain("node_modules");
  });
});

describe("OverlayFS native search seam (docs/tech/sandbox.md §4)", () => {
  it("does not implement searchFiles/searchContent — a native-searching remote base's results would miss overlay writes, so grep/glob must fall back to JS scanning (which goes through the merged glob() view) against it", () => {
    const base = fromMemory({ "a.txt": "base-a" });
    const fs: RunkoFS = new OverlayFS(base);
    expect(fs.searchFiles).toBeUndefined();
    expect(fs.searchContent).toBeUndefined();
  });
});
