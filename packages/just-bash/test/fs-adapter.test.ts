/**
 * `createFsAdapter`（NimboFS → IFileSystem）单测——逐行覆盖 docs/tech/core-sdk.md §4.5b
 * 降级表（`src/fs-adapter.ts` 头注释）。不经 `Bash`/`justBash`，直接对适配器
 * 调用，隔离"翻译是否正确"与"just-bash 解释器怎么用它"两层关注点。
 */
import { fromMemory } from "@nimbo/virtual-fs";
import { latin1FromBytes } from "just-bash";
import { describe, expect, it } from "vitest";
import { createFsAdapter } from "../src/fs-adapter.js";

describe("createFsAdapter: direct translation (readFile/readFileBuffer/writeFile/mkdir/readdir/rm/stat/exists)", () => {
  it("readFile decodes UTF-8 text", async () => {
    const adapter = createFsAdapter(fromMemory({ "/a.txt": "héllo\n" }));
    expect(await adapter.readFile("/a.txt")).toBe("héllo\n");
  });

  it("readFileBuffer returns the raw bytes unchanged", async () => {
    const fs = fromMemory({ "/a.bin": new Uint8Array([1, 2, 3, 255]) });
    const adapter = createFsAdapter(fs);
    expect([...(await adapter.readFileBuffer("/a.bin"))]).toEqual([1, 2, 3, 255]);
  });

  it("writeFile accepts string content, visible to the underlying NimboFS", async () => {
    const fs = fromMemory({});
    const adapter = createFsAdapter(fs);
    await adapter.writeFile("/w.txt", "written");
    expect(new TextDecoder().decode(await fs.readFile("/w.txt"))).toBe("written");
  });

  it("writeFile accepts Uint8Array content", async () => {
    const fs = fromMemory({});
    const adapter = createFsAdapter(fs);
    await adapter.writeFile("/w.bin", new Uint8Array([9, 8, 7]));
    expect([...(await fs.readFile("/w.bin"))]).toEqual([9, 8, 7]);
  });

  it("mkdir creates a directory visible to readdir", async () => {
    const fs = fromMemory({});
    const adapter = createFsAdapter(fs);
    await adapter.mkdir("/sub");
    const stat = await fs.stat("/sub");
    expect(stat.type).toBe("dir");
  });

  it("readdir returns entry names only", async () => {
    const adapter = createFsAdapter(fromMemory({ "/dir/a.txt": "a", "/dir/b.txt": "b" }));
    expect((await adapter.readdir("/dir")).sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("rm removes a file", async () => {
    const fs = fromMemory({ "/a.txt": "a" });
    const adapter = createFsAdapter(fs);
    await adapter.rm("/a.txt");
    await expect(fs.stat("/a.txt")).rejects.toThrow();
  });

  it("rm without force rejects on a missing path", async () => {
    const adapter = createFsAdapter(fromMemory({}));
    await expect(adapter.rm("/nope.txt")).rejects.toThrow();
  });

  it("rm with force does not reject on a missing path", async () => {
    const adapter = createFsAdapter(fromMemory({}));
    await expect(adapter.rm("/nope.txt", { force: true })).resolves.toBeUndefined();
  });

  it("stat reports a file: isFile, fixed mode 0o644, size, and a Date mtime", async () => {
    const adapter = createFsAdapter(fromMemory({ "/a.txt": "hello" }));
    const stat = await adapter.stat("/a.txt");
    expect(stat.isFile).toBe(true);
    expect(stat.isDirectory).toBe(false);
    expect(stat.isSymbolicLink).toBe(false);
    expect(stat.mode).toBe(0o644);
    expect(stat.size).toBe(5);
    expect(stat.mtime).toBeInstanceOf(Date);
  });

  it("stat reports a directory: isDirectory, fixed mode 0o755, size 0", async () => {
    const adapter = createFsAdapter(fromMemory({ "/dir/a.txt": "a" }));
    const stat = await adapter.stat("/dir");
    expect(stat.isDirectory).toBe(true);
    expect(stat.isFile).toBe(false);
    expect(stat.mode).toBe(0o755);
    expect(stat.size).toBe(0);
  });

  it("exists is true for a file and a directory, false for a missing path", async () => {
    const adapter = createFsAdapter(fromMemory({ "/a.txt": "a", "/dir/x": "x" }));
    expect(await adapter.exists("/a.txt")).toBe(true);
    expect(await adapter.exists("/dir")).toBe(true);
    expect(await adapter.exists("/nope")).toBe(false);
  });
});

describe("createFsAdapter: composed primitives (appendFile / cp / mv)", () => {
  it("appendFile creates the file when it does not exist yet", async () => {
    const fs = fromMemory({});
    const adapter = createFsAdapter(fs);
    await adapter.appendFile("/log.txt", "first\n");
    expect(new TextDecoder().decode(await fs.readFile("/log.txt"))).toBe("first\n");
  });

  it("appendFile concatenates onto existing content", async () => {
    const fs = fromMemory({ "/log.txt": "first\n" });
    const adapter = createFsAdapter(fs);
    await adapter.appendFile("/log.txt", "second\n");
    expect(new TextDecoder().decode(await fs.readFile("/log.txt"))).toBe("first\nsecond\n");
  });

  it("cp copies a single file (read+write)", async () => {
    const fs = fromMemory({ "/src.txt": "content" });
    const adapter = createFsAdapter(fs);
    await adapter.cp("/src.txt", "/dest.txt");
    expect(new TextDecoder().decode(await fs.readFile("/dest.txt"))).toBe("content");
    expect(new TextDecoder().decode(await fs.readFile("/src.txt"))).toBe("content"); // src untouched
  });

  it("cp on a directory without { recursive: true } rejects", async () => {
    const adapter = createFsAdapter(fromMemory({ "/dir/a.txt": "a" }));
    await expect(adapter.cp("/dir", "/dir2")).rejects.toThrow(/-r not specified/);
  });

  it("cp with { recursive: true } copies every file in the subtree to the relocated destination", async () => {
    const fs = fromMemory({ "/dir/a.txt": "a", "/dir/sub/b.txt": "b" });
    const adapter = createFsAdapter(fs);
    await adapter.cp("/dir", "/dir2", { recursive: true });
    expect(new TextDecoder().decode(await fs.readFile("/dir2/a.txt"))).toBe("a");
    expect(new TextDecoder().decode(await fs.readFile("/dir2/sub/b.txt"))).toBe("b");
    // source subtree is untouched by cp (unlike mv)
    expect(new TextDecoder().decode(await fs.readFile("/dir/a.txt"))).toBe("a");
  });

  it("mv renames a single file (read+write+rm)", async () => {
    const fs = fromMemory({ "/src.txt": "content" });
    const adapter = createFsAdapter(fs);
    await adapter.mv("/src.txt", "/dest.txt");
    expect(new TextDecoder().decode(await fs.readFile("/dest.txt"))).toBe("content");
    await expect(fs.stat("/src.txt")).rejects.toThrow();
  });

  it("mv on a directory copies the subtree to the destination and removes the source", async () => {
    const fs = fromMemory({ "/dir/a.txt": "a", "/dir/sub/b.txt": "b" });
    const adapter = createFsAdapter(fs);
    await adapter.mv("/dir", "/dir2");
    expect(new TextDecoder().decode(await fs.readFile("/dir2/a.txt"))).toBe("a");
    expect(new TextDecoder().decode(await fs.readFile("/dir2/sub/b.txt"))).toBe("b");
    await expect(fs.stat("/dir/a.txt")).rejects.toThrow();
  });
});

describe("createFsAdapter: pure path logic (resolvePath / realpath)", () => {
  it("resolvePath returns an absolute path unchanged (normalized)", () => {
    const adapter = createFsAdapter(fromMemory({}));
    expect(adapter.resolvePath("/somewhere", "/abs/path")).toBe("/abs/path");
  });

  it("resolvePath joins a relative path onto base", () => {
    const adapter = createFsAdapter(fromMemory({}));
    expect(adapter.resolvePath("/work", "rel/path")).toBe("/work/rel/path");
  });

  it("resolvePath clamps a .. that underflows the root instead of throwing", () => {
    const adapter = createFsAdapter(fromMemory({}));
    expect(adapter.resolvePath("/a", "../../../etc")).toBe("/etc");
  });

  it("realpath is just path normalization — no symlinks to resolve", async () => {
    const adapter = createFsAdapter(fromMemory({}));
    expect(await adapter.realpath("/a/./b/../c")).toBe("/a/c");
  });
});

describe("createFsAdapter: getAllPaths (fs.glob('**') + synthesized ancestor directories)", () => {
  it("is empty before refreshAllPaths() has ever run (sync cache, async source — documented limitation)", () => {
    const adapter = createFsAdapter(fromMemory({ "/a.txt": "a" }));
    expect(adapter.getAllPaths()).toEqual([]);
  });

  it("after refreshAllPaths(), returns every file plus every synthesized ancestor directory up to root", async () => {
    const fs = fromMemory({ "/a.txt": "a", "/sub/deep/b.txt": "b" });
    const adapter = createFsAdapter(fs);
    await adapter.refreshAllPaths();
    const paths = adapter.getAllPaths();
    expect(paths).toEqual(expect.arrayContaining(["/a.txt", "/sub/deep/b.txt", "/sub", "/sub/deep", "/"]));
  });

  it("reflects deletions on the next refresh", async () => {
    const fs = fromMemory({ "/a.txt": "a" });
    const adapter = createFsAdapter(fs);
    await adapter.refreshAllPaths();
    expect(adapter.getAllPaths()).toContain("/a.txt");
    await fs.rm("/a.txt");
    await adapter.refreshAllPaths();
    expect(adapter.getAllPaths()).not.toContain("/a.txt");
  });
});

describe("createFsAdapter: chmod/utimes are no-ops that still let the caller move on", () => {
  it("chmod resolves successfully without changing the fixed stat().mode", async () => {
    const adapter = createFsAdapter(fromMemory({ "/a.txt": "a" }));
    await expect(adapter.chmod("/a.txt", 0o755)).resolves.toBeUndefined();
    expect((await adapter.stat("/a.txt")).mode).toBe(0o644); // unchanged — chmod is a no-op
  });

  it("utimes resolves successfully as a no-op", async () => {
    const adapter = createFsAdapter(fromMemory({ "/a.txt": "a" }));
    await expect(adapter.utimes("/a.txt", new Date(), new Date())).resolves.toBeUndefined();
  });
});

describe("createFsAdapter: no symlinks (symlink/link/readlink reject; lstat = stat)", () => {
  it("symlink rejects with a descriptive 'not supported' message", async () => {
    const adapter = createFsAdapter(fromMemory({}));
    await expect(adapter.symlink("/target", "/link")).rejects.toThrow(/symlink is not supported/);
  });

  it("link rejects with a descriptive 'not supported' message", async () => {
    const adapter = createFsAdapter(fromMemory({ "/a.txt": "a" }));
    await expect(adapter.link("/a.txt", "/b.txt")).rejects.toThrow(/hard link is not supported/);
  });

  it("readlink rejects with a descriptive 'not supported' message", async () => {
    const adapter = createFsAdapter(fromMemory({ "/a.txt": "a" }));
    await expect(adapter.readlink("/a.txt")).rejects.toThrow(/readlink is not supported/);
  });

  it("lstat returns the same result as stat, with isSymbolicLink always false", async () => {
    const adapter = createFsAdapter(fromMemory({ "/a.txt": "a" }));
    const [stat, lstat] = await Promise.all([adapter.stat("/a.txt"), adapter.lstat("/a.txt")]);
    expect(lstat).toEqual(stat);
    expect(lstat.isSymbolicLink).toBe(false);
  });
});

describe("createFsAdapter: reference entries", () => {
  it("stat reports a reference entry as a file", async () => {
    const fs = fromMemory({ "/build.apk": { ref: "https://ci.example/123", mimeType: "application/vnd.android.package-archive" } });
    const adapter = createFsAdapter(fs);
    const stat = await adapter.stat("/build.apk");
    expect(stat.isFile).toBe(true);
    expect(stat.isDirectory).toBe(false);
  });

  it("readFile on an unresolved reference entry surfaces ReferenceNotResolvable's message unchanged (natural bubble-up)", async () => {
    const fs = fromMemory({ "/build.apk": { ref: "https://ci.example/123", annotations: { description: "nightly build" } } });
    const adapter = createFsAdapter(fs);
    await expect(adapter.readFile("/build.apk")).rejects.toThrow(/cannot be read directly/);
    await expect(adapter.readFile("/build.apk")).rejects.toThrow(/nightly build/);
  });
});

describe("createFsAdapter: optional members (readFileBytes / readdirWithFileTypes)", () => {
  it("readFileBytes round-trips the same bytes as readFileBuffer, via latin1FromBytes", async () => {
    const fs = fromMemory({ "/a.bin": new Uint8Array([0, 1, 2, 253, 254, 255]) });
    const adapter = createFsAdapter(fs);
    expect(adapter.readFileBytes).toBeDefined();
    const bytes = await adapter.readFileBytes?.("/a.bin");
    expect(bytes).toBeDefined();
    if (bytes === undefined) {throw new Error("unreachable");}
    const roundTripped = [...latin1FromBytes(bytes)].map((ch) => ch.charCodeAt(0));
    expect(roundTripped).toEqual([0, 1, 2, 253, 254, 255]);
  });

  it("readdirWithFileTypes reports file/dir kinds without a separate stat() per entry", async () => {
    const fs = fromMemory({ "/dir/a.txt": "a" });
    await fs.mkdir("/dir/sub");
    const adapter = createFsAdapter(fs);
    expect(adapter.readdirWithFileTypes).toBeDefined();
    const entries = await adapter.readdirWithFileTypes?.("/dir");
    expect(entries).toBeDefined();
    if (entries === undefined) {throw new Error("unreachable");}
    const byName = new Map(entries.map((e) => [e.name, e]));
    expect(byName.get("a.txt")).toEqual({ name: "a.txt", isFile: true, isDirectory: false, isSymbolicLink: false });
    expect(byName.get("sub")).toEqual({ name: "sub", isFile: false, isDirectory: true, isSymbolicLink: false });
  });
});
