/**
 * NimboFS 七方法契约（工单验收点：逐条覆盖 + NotFoundError/DirectoryNotEmptyError
 * + glob 匹配与排序 + mtime 抬升 + 路径锚定与 `..`），对照 `@nimbo/virtual-fs`
 * 的 `MemoryFS` 语义（docs/tech/sandbox.md §8.2）。
 */
import { DirectoryNotEmptyError, NotFoundError, PathEscapesRootError } from "@nimbo/virtual-fs";
import { describe, expect, it } from "vitest";
import { e2bWorkspace } from "../src/index.js";
import { createFakeE2bSandbox } from "./helpers.js";

function textOf(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

describe("readFile", () => {
  it("reads back exactly what writeFile wrote", async () => {
    const workspace = e2bWorkspace(createFakeE2bSandbox());
    await workspace.writeFile("/a.txt", "hello e2b");
    expect(textOf(await workspace.readFile("/a.txt"))).toBe("hello e2b");
  });

  it("throws NotFoundError (not e2b's own error class) for a missing path", async () => {
    const workspace = e2bWorkspace(createFakeE2bSandbox());
    await expect(workspace.readFile("/missing.txt")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("writeFile", () => {
  it("creates missing parent directories implicitly", async () => {
    const workspace = e2bWorkspace(createFakeE2bSandbox());
    await workspace.writeFile("/a/b/c.txt", "deep");
    expect(textOf(await workspace.readFile("/a/b/c.txt"))).toBe("deep");
    expect((await workspace.stat("/a/b")).type).toBe("dir");
  });

  it("bumps mtime on every write (readState judge)", async () => {
    const workspace = e2bWorkspace(createFakeE2bSandbox());
    await workspace.writeFile("/a.txt", "v1");
    const first = (await workspace.stat("/a.txt")).mtime;
    expect(first).toBeDefined();

    await workspace.writeFile("/a.txt", "v2");
    const second = (await workspace.stat("/a.txt")).mtime;
    expect(second).toBeDefined();
    expect(second).toBeGreaterThan(first ?? -1);
  });
});

describe("mkdir", () => {
  it("creates a directory (and its parents) that readdir/stat can then see", async () => {
    const workspace = e2bWorkspace(createFakeE2bSandbox());
    await workspace.mkdir("/x/y/z");
    expect((await workspace.stat("/x/y/z")).type).toBe("dir");
    expect((await workspace.readdir("/x/y")).map((e) => e.name)).toEqual(["z"]);
  });
});

describe("rm", () => {
  it("removes a file", async () => {
    const workspace = e2bWorkspace(createFakeE2bSandbox());
    await workspace.writeFile("/a.txt", "x");
    await workspace.rm("/a.txt");
    await expect(workspace.stat("/a.txt")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws NotFoundError removing a path that doesn't exist", async () => {
    const workspace = e2bWorkspace(createFakeE2bSandbox());
    await expect(workspace.rm("/missing")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws DirectoryNotEmptyError removing a non-empty directory without recursive (e2b's remove() is unconditionally recursive, so this check is the adapter's own)", async () => {
    const workspace = e2bWorkspace(createFakeE2bSandbox());
    await workspace.writeFile("/dir/child.txt", "x");
    await expect(workspace.rm("/dir")).rejects.toBeInstanceOf(DirectoryNotEmptyError);
    // still there — the rejected call must not have partially deleted anything.
    expect(textOf(await workspace.readFile("/dir/child.txt"))).toBe("x");
  });

  it("removes an empty directory without recursive", async () => {
    const workspace = e2bWorkspace(createFakeE2bSandbox());
    await workspace.mkdir("/empty");
    await workspace.rm("/empty");
    await expect(workspace.stat("/empty")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("removes a non-empty directory with recursive: true", async () => {
    const workspace = e2bWorkspace(createFakeE2bSandbox());
    await workspace.writeFile("/dir/a.txt", "a");
    await workspace.writeFile("/dir/sub/b.txt", "b");
    await workspace.rm("/dir", { recursive: true });
    await expect(workspace.stat("/dir")).rejects.toBeInstanceOf(NotFoundError);
    await expect(workspace.stat("/dir/sub/b.txt")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("readdir", () => {
  it("lists direct children only (files and dirs), sorted by name, with type/size/mtime", async () => {
    const workspace = e2bWorkspace(createFakeE2bSandbox());
    await workspace.writeFile("/dir/b.txt", "bb");
    await workspace.writeFile("/dir/a.txt", "a");
    await workspace.mkdir("/dir/sub");
    await workspace.writeFile("/dir/sub/deep.txt", "deep"); // must not show up at this level

    const entries = await workspace.readdir("/dir");
    expect(entries.map((e) => e.name)).toEqual(["a.txt", "b.txt", "sub"]);
    const a = entries.find((e) => e.name === "a.txt");
    expect(a?.type).toBe("file");
    expect(a?.size).toBe(1);
    expect(a?.mtime).toBeDefined();
    const sub = entries.find((e) => e.name === "sub");
    expect(sub?.type).toBe("dir");
    expect(sub?.size).toBeUndefined();
  });

  it("throws NotFoundError for a missing directory", async () => {
    const workspace = e2bWorkspace(createFakeE2bSandbox());
    await expect(workspace.readdir("/missing")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("stat", () => {
  it("reports type file/dir with size present only for files", async () => {
    const workspace = e2bWorkspace(createFakeE2bSandbox());
    await workspace.writeFile("/a.txt", "abcd");
    await workspace.mkdir("/dir");

    const fileStat = await workspace.stat("/a.txt");
    expect(fileStat.type).toBe("file");
    expect(fileStat.size).toBe(4);

    const dirStat = await workspace.stat("/dir");
    expect(dirStat.type).toBe("dir");
    expect(dirStat.size).toBeUndefined();
  });
});

describe("glob", () => {
  it("matches files recursively, excludes directories, and sorts the result", async () => {
    const workspace = e2bWorkspace(createFakeE2bSandbox());
    await workspace.writeFile("/src/b.ts", "b");
    await workspace.writeFile("/src/a.ts", "a");
    await workspace.writeFile("/src/sub/deep.ts", "deep");
    await workspace.writeFile("/README.md", "readme");
    await workspace.mkdir("/src/empty-dir");

    const matches = await workspace.glob("/src/**/*.ts");
    expect(matches).toEqual(["/src/a.ts", "/src/b.ts", "/src/sub/deep.ts"]);
  });

  it("returns virtual paths (root prefix stripped), not the sandbox's real absolute paths", async () => {
    const workspace = e2bWorkspace(createFakeE2bSandbox(["/workspace/app"]), { root: "/workspace/app" });
    await workspace.writeFile("/notes/todo.txt", "todo");
    expect(await workspace.glob("/**/*.txt")).toEqual(["/notes/todo.txt"]);
  });
});

describe("path anchoring", () => {
  it("defaults root to /home/user", async () => {
    const sandbox = createFakeE2bSandbox();
    const workspace = e2bWorkspace(sandbox);
    await workspace.writeFile("/a.txt", "x");
    expect(textOf(sandbox.debugReadRaw("/home/user/a.txt") ?? new Uint8Array())).toBe("x");
  });

  it("anchors under a custom root", async () => {
    const sandbox = createFakeE2bSandbox(["/workspace/app"]);
    const workspace = e2bWorkspace(sandbox, { root: "/workspace/app" });
    await workspace.writeFile("/notes/todo.txt", "todo");
    expect(textOf(sandbox.debugReadRaw("/workspace/app/notes/todo.txt") ?? new Uint8Array())).toBe("todo");
  });

  it("rejects '..' that escapes the virtual root, same as @nimbo/virtual-fs (normalizePath's existing semantics, not reimplemented here)", async () => {
    const workspace = e2bWorkspace(createFakeE2bSandbox());
    await expect(workspace.readFile("/../etc/passwd")).rejects.toBeInstanceOf(PathEscapesRootError);
  });
});
