/**
 * NimboFS 七方法契约（docs/host/sandbox/tech.md §3.1 / §8.2 Vercel 列）：ENOENT → NotFoundError，
 * 非递归 rm 对空/非空目录的分流（`src/fs.ts` 头注释记录的实测发现——node
 * `fs.rm()` 不能承担这个语义，必须靠 `fs.rmdir()`），glob 递归 + matcher，
 * mtime 整数 ms，root 锚定，readdir/mkdir/writeFile 的父目录语义。
 */
import { DirectoryNotEmptyError, NotFoundError } from "@nimbo/virtual-fs";
import { describe, expect, it } from "vitest";
import { vercelWorkspace } from "../src/index.js";
import { FakeVercelSandbox, writeChunks } from "./helpers.js";

describe("readFile", () => {
  it("reads a file anchored under root", async () => {
    const sandbox = new FakeVercelSandbox({ files: { "/a.txt": "hello" } });
    const ws = vercelWorkspace(sandbox);
    const bytes = await ws.readFile("/a.txt");
    expect(new TextDecoder().decode(bytes)).toBe("hello");
  });

  it("throws NotFoundError (not the raw ENOENT error) for a missing path", async () => {
    const sandbox = new FakeVercelSandbox({});
    const ws = vercelWorkspace(sandbox);
    await expect(ws.readFile("/missing.txt")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("anchors virtual paths to a custom root option", async () => {
    const sandbox = new FakeVercelSandbox({ root: "/workspace", files: { "/a.txt": "hi" } });
    // the file physically lives at /workspace/a.txt in the fake's real tree.
    expect(await sandbox.fs.readFile("/workspace/a.txt")).toBeDefined();
    const ws = vercelWorkspace(sandbox, { root: "/workspace" });
    expect(new TextDecoder().decode(await ws.readFile("/a.txt"))).toBe("hi");
  });
});

describe("writeFile", () => {
  it("writes a new file and auto-creates missing intermediate directories (node fs.writeFile itself would ENOENT)", async () => {
    const sandbox = new FakeVercelSandbox({});
    const ws = vercelWorkspace(sandbox);
    await ws.writeFile("/deep/nested/dir/file.txt", "content");
    expect(new TextDecoder().decode(await ws.readFile("/deep/nested/dir/file.txt"))).toBe("content");
  });

  it("overwrites an existing file", async () => {
    const sandbox = new FakeVercelSandbox({ files: { "/a.txt": "old" } });
    const ws = vercelWorkspace(sandbox);
    await ws.writeFile("/a.txt", "new");
    expect(new TextDecoder().decode(await ws.readFile("/a.txt"))).toBe("new");
  });

  it("accepts Uint8Array data", async () => {
    const sandbox = new FakeVercelSandbox({});
    const ws = vercelWorkspace(sandbox);
    await ws.writeFile("/bin.dat", new Uint8Array([1, 2, 3]));
    expect(Array.from(await ws.readFile("/bin.dat"))).toEqual([1, 2, 3]);
  });
});

describe("mkdir", () => {
  it("creates a directory (and its parents) so readdir succeeds afterward", async () => {
    const sandbox = new FakeVercelSandbox({});
    const ws = vercelWorkspace(sandbox);
    await ws.mkdir("/a/b/c");
    expect(await ws.readdir("/a/b/c")).toEqual([]);
  });

  it("is idempotent on an already-existing directory", async () => {
    const sandbox = new FakeVercelSandbox({});
    const ws = vercelWorkspace(sandbox);
    await ws.mkdir("/a");
    await expect(ws.mkdir("/a")).resolves.toBeUndefined();
  });
});

describe("readdir", () => {
  it("lists files and directories with type, sorted by name", async () => {
    const sandbox = new FakeVercelSandbox({
      files: { "/dir/b.txt": "b", "/dir/a.txt": "a" },
    });
    await sandbox.fs.mkdir("/vercel/sandbox/dir/sub", { recursive: true });
    const ws = vercelWorkspace(sandbox);
    const entries = await ws.readdir("/dir");
    expect(entries.map((e) => e.name)).toEqual(["a.txt", "b.txt", "sub"]);
    expect(entries.find((e) => e.name === "sub")?.type).toBe("dir");
    expect(entries.find((e) => e.name === "a.txt")?.type).toBe("file");
  });

  it("annotates non-text files with an inferred mimeType", async () => {
    const sandbox = new FakeVercelSandbox({ files: { "/pic.png": new Uint8Array([0, 1]) } });
    const ws = vercelWorkspace(sandbox);
    const entries = await ws.readdir("/");
    const pic = entries.find((e) => e.name === "pic.png");
    expect(pic?.mimeType).toBe("image/png");
  });

  it("throws NotFoundError for a missing directory", async () => {
    const sandbox = new FakeVercelSandbox({});
    const ws = vercelWorkspace(sandbox);
    await expect(ws.readdir("/nope")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("stat", () => {
  it("reports type file with size + mimeType + integer mtime", async () => {
    const sandbox = new FakeVercelSandbox({ files: { "/a.txt": "hello" } });
    const ws = vercelWorkspace(sandbox);
    const stat = await ws.stat("/a.txt");
    expect(stat.type).toBe("file");
    expect(stat.size).toBe(5);
    expect(stat.mimeType).toBe("text/plain");
    expect(Number.isInteger(stat.mtime)).toBe(true);
  });

  it("reports type dir for a directory", async () => {
    const sandbox = new FakeVercelSandbox({});
    await sandbox.fs.mkdir("/vercel/sandbox/somedir", { recursive: true });
    const ws = vercelWorkspace(sandbox);
    const stat = await ws.stat("/somedir");
    expect(stat.type).toBe("dir");
  });

  it("converts the sandbox's mtimeMs into an integer epoch ms value even when fractional", async () => {
    const sandbox = new FakeVercelSandbox({ files: { "/a.txt": "hi" } });
    const original = await sandbox.fs.stat("/vercel/sandbox/a.txt");
    const fractionalStat = { ...original, mtimeMs: 1000.7 };
    sandbox.fs.stat = () => Promise.resolve(fractionalStat);
    const ws = vercelWorkspace(sandbox);
    const stat = await ws.stat("/a.txt");
    expect(stat.mtime).toBe(1001);
    expect(Number.isInteger(stat.mtime)).toBe(true);
  });

  it("throws NotFoundError for a missing path", async () => {
    const sandbox = new FakeVercelSandbox({});
    const ws = vercelWorkspace(sandbox);
    await expect(ws.stat("/missing")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("rm", () => {
  it("removes a file without needing { recursive: true }", async () => {
    const sandbox = new FakeVercelSandbox({ files: { "/a.txt": "hi" } });
    const ws = vercelWorkspace(sandbox);
    await ws.rm("/a.txt");
    await expect(ws.stat("/a.txt")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("removes an empty directory without { recursive: true } (routes through fs.rmdir, not fs.rm — see src/fs.ts header)", async () => {
    const sandbox = new FakeVercelSandbox({});
    await sandbox.fs.mkdir("/vercel/sandbox/empty", { recursive: true });
    const ws = vercelWorkspace(sandbox);
    await ws.rm("/empty");
    await expect(ws.stat("/empty")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws DirectoryNotEmptyError for a non-empty directory without { recursive: true }", async () => {
    const sandbox = new FakeVercelSandbox({ files: { "/dir/child.txt": "x" } });
    const ws = vercelWorkspace(sandbox);
    await expect(ws.rm("/dir")).rejects.toBeInstanceOf(DirectoryNotEmptyError);
    // and it must not actually have deleted anything on that failed attempt.
    expect(new TextDecoder().decode(await ws.readFile("/dir/child.txt"))).toBe("x");
  });

  it("removes a non-empty directory with { recursive: true }", async () => {
    const sandbox = new FakeVercelSandbox({ files: { "/dir/child.txt": "x", "/dir/sub/deep.txt": "y" } });
    const ws = vercelWorkspace(sandbox);
    await ws.rm("/dir", { recursive: true });
    await expect(ws.stat("/dir")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws NotFoundError for a missing path", async () => {
    const sandbox = new FakeVercelSandbox({});
    const ws = vercelWorkspace(sandbox);
    await expect(ws.rm("/missing")).rejects.toBeInstanceOf(NotFoundError);
  });
});

/**
 * `glob()` is now a single `node -e`-script round-trip (docs/host/sandbox/tech.md §4 native search fast
 * path, `src/fs.ts` header) with the old per-file `readdir` + `matchesGlob` walk (`walkFiles`) kept
 * only as the fallback for when the sandbox has no usable `node` (`exitCode: 127`/rejection —
 * `FakeVercelSandbox`'s default `runCommandImpl` resolves `{exitCode:0}` with empty stdout, which is
 * neither of those — it's a script-ran-but-produced-garbage-output case, covered separately in
 * search.test.ts's "script really executed but failed" scenarios). The two sub-`describe`s below
 * exercise the native round-trip (writing the script's expected stdout JSON directly, since the
 * fake never actually executes the `-e` argument) and the `walkFiles` fallback respectively.
 */
describe("glob", () => {
  describe("native round-trip (single runCommand call, JSON stdout parsed into paths)", () => {
    it("returns only files, sorted, from a single runCommand call", async () => {
      const sandbox = new FakeVercelSandbox({
        files: { "/src/index.ts": "a", "/src/sub/deep.ts": "b", "/README.md": "c" },
        runCommandImpl: async (call) => {
          await writeChunks(call.stdout, [JSON.stringify({ paths: ["/src/index.ts", "/src/sub/deep.ts"], total: 2 })]);
          return { exitCode: 0 };
        },
      });
      const ws = vercelWorkspace(sandbox);
      const matches = await ws.glob("**/*.ts");
      expect(matches).toEqual(["/src/index.ts", "/src/sub/deep.ts"]);
      expect(sandbox.calls).toHaveLength(1);
      expect(sandbox.calls[0]?.cmd).toBe("node");
    });

    it("returns an empty array when nothing matches, without throwing", async () => {
      const sandbox = new FakeVercelSandbox({
        files: { "/a.txt": "x" },
        runCommandImpl: async (call) => {
          await writeChunks(call.stdout, [JSON.stringify({ paths: [], total: 0 })]);
          return { exitCode: 0 };
        },
      });
      const ws = vercelWorkspace(sandbox);
      expect(await ws.glob("**/*.nomatch")).toEqual([]);
    });
  });

  describe("walkFiles fallback (node unavailable: exit 127)", () => {
    it("recursively walks directories (readdir + matchesGlob), returns only files, sorted", async () => {
      const sandbox = new FakeVercelSandbox({
        files: {
          "/src/index.ts": "a",
          "/src/sub/deep.ts": "b",
          "/README.md": "c",
        },
        runCommandImpl: async () => ({ exitCode: 127 }),
      });
      const ws = vercelWorkspace(sandbox);
      const matches = await ws.glob("**/*.ts");
      expect(matches).toEqual(["/src/index.ts", "/src/sub/deep.ts"]);
    });

    it("returns an empty array when nothing matches, without throwing", async () => {
      const sandbox = new FakeVercelSandbox({ files: { "/a.txt": "x" }, runCommandImpl: async () => ({ exitCode: 127 }) });
      const ws = vercelWorkspace(sandbox);
      expect(await ws.glob("**/*.nomatch")).toEqual([]);
    });

    it("does not apply the grep/glob-tool default ignore (.git/node_modules) — glob() itself never filtered them, even before the native rewrite", async () => {
      const sandbox = new FakeVercelSandbox({
        files: { "/.git/config": "a", "/node_modules/pkg/index.js": "b", "/src/a.ts": "c" },
        runCommandImpl: async () => ({ exitCode: 127 }),
      });
      const ws = vercelWorkspace(sandbox);
      expect(await ws.glob("**/*")).toEqual(expect.arrayContaining(["/.git/config", "/node_modules/pkg/index.js", "/src/a.ts"]));
    });
  });
});

describe("root anchoring", () => {
  it("defaults to /vercel/sandbox", async () => {
    const sandbox = new FakeVercelSandbox({ files: { "/a.txt": "hi" } });
    expect(await sandbox.fs.readFile("/vercel/sandbox/a.txt")).toBeDefined();
    const ws = vercelWorkspace(sandbox);
    expect(new TextDecoder().decode(await ws.readFile("/a.txt"))).toBe("hi");
  });

  it("keeps the agent-facing path clean ('/'-rooted) regardless of the real root directory", async () => {
    const sandbox = new FakeVercelSandbox({ root: "/tmp/ws", files: { "/nested/a.txt": "hi" } });
    const ws = vercelWorkspace(sandbox, { root: "/tmp/ws" });
    const entries = await ws.readdir("/nested");
    expect(entries.map((e) => e.name)).toEqual(["a.txt"]);
  });

  it("rejects '..' escaping past the virtual root for the fs tools (PathEscapesRootError), same boundary as MemoryFS/DirFS — src/path.ts's documented interpretation of docs/host/sandbox/tech.md §3.1", async () => {
    const sandbox = new FakeVercelSandbox({ files: { "/a.txt": "hi" } });
    const ws = vercelWorkspace(sandbox);
    await expect(ws.readFile("/../etc/passwd")).rejects.toThrow(/escapes root/);
  });
});
