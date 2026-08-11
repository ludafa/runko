import * as nodeFs from "node:fs/promises";
import * as nodePath from "node:path";
import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NimboFS } from "@nimbo/core";
import { DirFS, ReadOnlyFileSystemError } from "../src/dir.js";
import { NotFoundError } from "../src/memory.js";

describe("DirFS", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await nodeFs.mkdtemp(nodePath.join(os.tmpdir(), "nimbo-dirfs-"));
    await nodeFs.mkdir(nodePath.join(tmpDir, "src", "nested"), { recursive: true });
    await nodeFs.writeFile(nodePath.join(tmpDir, "a.txt"), "hello");
    await nodeFs.writeFile(nodePath.join(tmpDir, "src", "index.ts"), "export {}");
    await nodeFs.writeFile(nodePath.join(tmpDir, "src", "nested", "deep.ts"), "export const x = 1;");
    await nodeFs.mkdir(nodePath.join(tmpDir, "node_modules", "pkg"), { recursive: true });
    await nodeFs.writeFile(nodePath.join(tmpDir, "node_modules", "pkg", "index.js"), "module.exports = {}");
  });

  afterEach(async () => {
    await nodeFs.rm(tmpDir, { recursive: true, force: true });
  });

  it("reads real file content", async () => {
    const fs = new DirFS(tmpDir);
    const data = await fs.readFile("/a.txt");
    expect(new TextDecoder().decode(data)).toBe("hello");
  });

  it("stat reports type/size/mtime/mimeType for a file and type for a dir", async () => {
    const fs = new DirFS(tmpDir);
    const fileStat = await fs.stat("/a.txt");
    expect(fileStat.type).toBe("file");
    expect(fileStat.size).toBe(5);
    expect(fileStat.mimeType).toBe("text/plain");
    expect(typeof fileStat.mtime).toBe("number");

    const dirStat = await fs.stat("/src");
    expect(dirStat.type).toBe("dir");
  });

  it("readdir lists direct children with metadata", async () => {
    const fs = new DirFS(tmpDir);
    const entries = await fs.readdir("/src");
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(["index.ts", "nested"]);
    const indexEntry = entries.find((e) => e.name === "index.ts");
    expect(indexEntry?.type).toBe("file");
    expect(indexEntry?.mimeType).toBe("application/typescript");
  });

  it("glob recursively matches files under the real directory", async () => {
    const fs = new DirFS(tmpDir);
    const matches = await fs.glob("**/*.ts");
    expect(matches.sort()).toEqual(["/src/index.ts", "/src/nested/deep.ts"]);
  });

  it("throws NotFoundError for a missing path", async () => {
    const fs = new DirFS(tmpDir);
    await expect(fs.stat("/missing.txt")).rejects.toThrow(NotFoundError);
    await expect(fs.readFile("/missing.txt")).rejects.toThrow(NotFoundError);
  });

  it("all write methods throw ReadOnlyFileSystemError", async () => {
    const fs = new DirFS(tmpDir);
    await expect(fs.writeFile("/a.txt", "x")).rejects.toThrow(ReadOnlyFileSystemError);
    await expect(fs.rm("/a.txt")).rejects.toThrow(ReadOnlyFileSystemError);
    await expect(fs.mkdir("/new-dir")).rejects.toThrow(ReadOnlyFileSystemError);
  });

  it("ignore hides an entire subtree from stat/readdir/glob", async () => {
    const fs = new DirFS(tmpDir, { ignore: ["node_modules"] });
    await expect(fs.stat("/node_modules")).rejects.toThrow(NotFoundError);
    await expect(fs.stat("/node_modules/pkg/index.js")).rejects.toThrow(NotFoundError);

    const rootEntries = await fs.readdir("/");
    expect(rootEntries.map((e) => e.name)).not.toContain("node_modules");

    const matches = await fs.glob("**/*");
    expect(matches.some((p) => p.startsWith("/node_modules"))).toBe(false);
  });
});

describe("DirFS native search seam (docs/host/sandbox/tech.md §4)", () => {
  it("does not implement searchFiles/searchContent — grep/glob must always fall back to JS scanning against it", () => {
    // no real directory needed — DirFS's constructor doesn't touch disk, and this test only checks
    // the shape of the instance (searchFiles/searchContent absent), never calling any I/O method.
    const fs: NimboFS = new DirFS("/does-not-need-to-exist");
    expect(fs.searchFiles).toBeUndefined();
    expect(fs.searchContent).toBeUndefined();
  });
});
