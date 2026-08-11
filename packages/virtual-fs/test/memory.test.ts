import * as nodeFs from "node:fs/promises";
import * as nodePath from "node:path";
import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jsonValueSchema } from "@nimbo/core";
import type { NimboFS } from "@nimbo/core";
import {
  DirectoryNotEmptyError,
  MemoryFS,
  NotFoundError,
  ReferenceNotResolvable,
  fromMemory,
} from "../src/memory.js";
import { PathEscapesRootError } from "../src/path.js";

describe("MemoryFS basic NimboFS surface", () => {
  it("writes and reads a text file", async () => {
    const fs = new MemoryFS();
    await fs.writeFile("/a.txt", "hello");
    const data = await fs.readFile("/a.txt");
    expect(new TextDecoder().decode(data)).toBe("hello");
  });

  it("writes and reads binary content", async () => {
    const fs = new MemoryFS();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await fs.writeFile("/bin.dat", bytes);
    const data = await fs.readFile("/bin.dat");
    expect([...data]).toEqual([1, 2, 3, 4]);
  });

  it("auto-creates ancestor directories on write", async () => {
    const fs = new MemoryFS();
    await fs.writeFile("/a/b/c.txt", "deep");
    const stat = await fs.stat("/a/b");
    expect(stat.type).toBe("dir");
    const entries = await fs.readdir("/a");
    expect(entries.map((e) => e.name)).toEqual(["b"]);
  });

  it("readFile throws NotFoundError for a missing path", async () => {
    const fs = new MemoryFS();
    await expect(fs.readFile("/missing.txt")).rejects.toThrow(NotFoundError);
  });

  it("mkdir creates an empty directory visible via stat/readdir", async () => {
    const fs = new MemoryFS();
    await fs.mkdir("/empty");
    expect((await fs.stat("/empty")).type).toBe("dir");
    expect(await fs.readdir("/empty")).toEqual([]);
  });

  it("rm deletes a file", async () => {
    const fs = new MemoryFS();
    await fs.writeFile("/a.txt", "x");
    await fs.rm("/a.txt");
    await expect(fs.stat("/a.txt")).rejects.toThrow(NotFoundError);
  });

  it("rm on a non-empty directory without recursive throws DirectoryNotEmptyError", async () => {
    const fs = new MemoryFS();
    await fs.writeFile("/dir/a.txt", "x");
    await expect(fs.rm("/dir")).rejects.toThrow(DirectoryNotEmptyError);
  });

  it("rm with recursive:true removes a directory and its contents", async () => {
    const fs = new MemoryFS();
    await fs.writeFile("/dir/a.txt", "x");
    await fs.writeFile("/dir/nested/b.txt", "y");
    await fs.rm("/dir", { recursive: true });
    await expect(fs.stat("/dir")).rejects.toThrow(NotFoundError);
    await expect(fs.stat("/dir/a.txt")).rejects.toThrow(NotFoundError);
    await expect(fs.stat("/dir/nested/b.txt")).rejects.toThrow(NotFoundError);
  });

  it("rejects paths that escape the virtual root", async () => {
    const fs = new MemoryFS();
    await expect(fs.writeFile("../escape.txt", "x")).rejects.toThrow(PathEscapesRootError);
    await expect(fs.readFile("/a/../../escape.txt")).rejects.toThrow(PathEscapesRootError);
  });

  it("readdir lists direct children only, sorted by name", async () => {
    const fs = new MemoryFS();
    await fs.writeFile("/b.txt", "1");
    await fs.writeFile("/a.txt", "2");
    await fs.mkdir("/c-dir");
    await fs.writeFile("/nested/deep.txt", "3");
    const entries = await fs.readdir("/");
    expect(entries.map((e) => e.name)).toEqual(["a.txt", "b.txt", "c-dir", "nested"]);
  });

  it("glob matches files by pattern, not directories", async () => {
    const fs = new MemoryFS();
    await fs.writeFile("/src/index.ts", "a");
    await fs.writeFile("/src/nested/util.ts", "b");
    await fs.writeFile("/src/index.js", "c");
    await fs.mkdir("/src/emptydir");
    const matches = await fs.glob("**/*.ts");
    expect(matches.sort()).toEqual(["/src/index.ts", "/src/nested/util.ts"]);
  });
});

describe("MemoryFS stat()/mime inference", () => {
  it("infers mimeType by extension when not overridden", async () => {
    const fs = new MemoryFS();
    await fs.writeFile("/a.json", "{}");
    const stat = await fs.stat("/a.json");
    expect(stat.mimeType).toBe("application/json");
  });

  it("falls back to the default mime type for an unknown extension", async () => {
    const fs = new MemoryFS();
    await fs.writeFile("/a.mystery", "x");
    const stat = await fs.stat("/a.mystery");
    expect(stat.mimeType).toBe("application/octet-stream");
  });

  it("mtime strictly increases across successive writes to the same path", async () => {
    const fs = new MemoryFS();
    await fs.writeFile("/a.txt", "v1");
    const first = (await fs.stat("/a.txt")).mtime;
    await fs.writeFile("/a.txt", "v2");
    const second = (await fs.stat("/a.txt")).mtime;
    await fs.writeFile("/a.txt", "v3");
    const third = (await fs.stat("/a.txt")).mtime;
    expect(first).toBeTypeOf("number");
    expect(second).toBeGreaterThan(first ?? 0);
    expect(third).toBeGreaterThan(second ?? 0);
  });
});

describe("MemoryFS reference entries", () => {
  it("stat() reports type:reference with href and annotations", async () => {
    const fs = fromMemory({
      "builds/app.apk": {
        ref: "https://ci.example.com/build/123",
        mimeType: "application/vnd.android.package-archive",
        annotations: { description: "latest CI build", tags: ["build"] },
      },
    });
    const stat = await fs.stat("/builds/app.apk");
    expect(stat.type).toBe("reference");
    expect(stat.href).toBe("https://ci.example.com/build/123");
    expect(stat.annotations?.description).toBe("latest CI build");
  });

  it("readFile without an injected resolver throws ReferenceNotResolvable carrying guidance fields", async () => {
    const fs = fromMemory({
      "builds/app.apk": {
        ref: "https://ci.example.com/build/123",
        mimeType: "application/vnd.android.package-archive",
        annotations: { description: "latest CI build" },
      },
    });
    try {
      await fs.readFile("/builds/app.apk");
      throw new Error("expected readFile to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ReferenceNotResolvable);
      if (error instanceof ReferenceNotResolvable) {
        expect(error.path).toBe("/builds/app.apk");
        expect(error.href).toBe("https://ci.example.com/build/123");
        expect(error.mimeType).toBe("application/vnd.android.package-archive");
        expect(error.description).toBe("latest CI build");
        expect(error.message).toContain("resolveReference");
      }
    }
  });

  it("readFile resolves directly when a resolveReference is injected", async () => {
    const fs = fromMemory(
      { "builds/app.apk": { ref: "https://ci.example.com/build/123" } },
      {
        resolveReference: async (entry) => {
          expect(entry.href).toBe("https://ci.example.com/build/123");
          return new TextEncoder().encode("resolved-content");
        },
      },
    );
    const data = await fs.readFile("/builds/app.apk");
    expect(new TextDecoder().decode(data)).toBe("resolved-content");
  });
});

describe("fromMemory", () => {
  it("populates string and Uint8Array entries synchronously", async () => {
    const fs = fromMemory({
      "a.txt": "hello",
      "b.bin": new Uint8Array([9, 8, 7]),
    });
    expect(new TextDecoder().decode(await fs.readFile("/a.txt"))).toBe("hello");
    expect([...(await fs.readFile("/b.bin"))]).toEqual([9, 8, 7]);
  });
});

describe("MemoryFS.diff()", () => {
  it("reports every current file as 'created' relative to an empty baseline", () => {
    const fs = fromMemory({ "a.txt": "hello\n", "dir/b.txt": "world\n" });
    const diffs = fs.diff();
    expect(diffs.map((d) => d.path).sort()).toEqual(["/a.txt", "/dir/b.txt"]);
    expect(diffs.every((d) => d.kind === "created")).toBe(true);
  });
});

describe("MemoryFS.writeBack()", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await nodeFs.mkdtemp(nodePath.join(os.tmpdir(), "nimbo-memoryfs-"));
  });

  afterEach(async () => {
    await nodeFs.rm(tmpDir, { recursive: true, force: true });
  });

  it("materializes files to a real directory, idempotently", async () => {
    const fs = fromMemory({ "a.txt": "hello", "nested/b.txt": "world" });
    await fs.writeBack(tmpDir);
    await fs.writeBack(tmpDir); // second call must be a no-op in effect

    const a = await nodeFs.readFile(nodePath.join(tmpDir, "a.txt"), "utf-8");
    const b = await nodeFs.readFile(nodePath.join(tmpDir, "nested", "b.txt"), "utf-8");
    expect(a).toBe("hello");
    expect(b).toBe("world");
  });
});

describe("MemoryFS.snapshot()/restore()", () => {
  it("round-trips file content", async () => {
    const fs = new MemoryFS();
    await fs.writeFile("/a.txt", "v1");
    const snap = fs.snapshot();

    await fs.writeFile("/a.txt", "v2");
    await fs.writeFile("/b.txt", "new file");
    expect(new TextDecoder().decode(await fs.readFile("/a.txt"))).toBe("v2");

    fs.restore(snap);
    expect(new TextDecoder().decode(await fs.readFile("/a.txt"))).toBe("v1");
    await expect(fs.stat("/b.txt")).rejects.toThrow(NotFoundError);
  });

  it("produces a JSON-serializable snapshot (no raw Uint8Array leakage)", async () => {
    const fs = new MemoryFS();
    await fs.writeFile("/a.bin", new Uint8Array([1, 2, 3]));
    const snap = fs.snapshot();
    const roundTripped = JSON.parse(JSON.stringify(snap));
    const restored = new MemoryFS();
    restored.restore(roundTripped);
    expect([...(await restored.readFile("/a.bin"))]).toEqual([1, 2, 3]);
  });

  it("round-trips reference entries", async () => {
    const fs = fromMemory({ "ref.apk": { ref: "https://x", mimeType: "application/x", annotations: { description: "d" } } });
    const snap = fs.snapshot();
    const restored = new MemoryFS();
    restored.restore(snap);
    const stat = await restored.stat("/ref.apk");
    expect(stat.type).toBe("reference");
    expect(stat.href).toBe("https://x");
  });

  /**
   * 任务 0 回归测试（跨包 bug 根因修复，orchitector 裁定并入 P7-3；bug 由
   * P7-2 施工时在 core 的 `toCleanJsonValue` 防御层发现）：未设置 mimeType 的
   * file 条目、未设置 mimeType/annotations 的 reference 条目，snapshot() 必须
   * 省略这些键而非写显式 `undefined` 值——后者精确落在 `jsonValueSchema` 的
   * `z.record` 拒绝范围内（`undefined` 不是合法 JSON 值），即便 `JSON.stringify`
   * 会默默丢弃它。
   */
  describe("snapshot() omits unset optional keys rather than writing explicit undefined (task 0 regression)", () => {
    it("a file with no mimeType set: snapshot() passes jsonValueSchema directly and has no mimeType key", async () => {
      const fs = new MemoryFS();
      await fs.writeFile("/a.mystery-ext-with-no-inferred-mime", "content");
      const snap = fs.snapshot();

      const parsed = jsonValueSchema.safeParse(snap);
      expect(parsed.success).toBe(true);

      const entry = snap.files["/a.mystery-ext-with-no-inferred-mime"];
      expect(entry?.kind).toBe("file");
      expect(Object.keys(entry ?? {})).not.toContain("mimeType");
    });

    it("a reference entry with no mimeType/annotations set: snapshot() passes jsonValueSchema and omits both keys", async () => {
      const fs = fromMemory({ "ref.bin": { ref: "https://x" } });
      const snap = fs.snapshot();

      const parsed = jsonValueSchema.safeParse(snap);
      expect(parsed.success).toBe(true);

      const entry = snap.files["/ref.bin"];
      expect(entry?.kind).toBe("reference");
      expect(Object.keys(entry ?? {})).not.toContain("mimeType");
      expect(Object.keys(entry ?? {})).not.toContain("annotations");
    });

    it("snapshot→restore round-trip is unaffected by the omitted keys (file gets its mimeType inferred as before)", async () => {
      const fs = new MemoryFS();
      await fs.writeFile("/a.txt", "hello");
      const snap = fs.snapshot();

      const restored = new MemoryFS();
      restored.restore(snap);
      expect(new TextDecoder().decode(await restored.readFile("/a.txt"))).toBe("hello");
      const stat = await restored.stat("/a.txt");
      expect(stat.mimeType).toBe("text/plain"); // inferred by extension, same as a fresh un-mimeType'd write
    });

    it("a file entry with mimeType actually set keeps the key on the next snapshot() (fix only omits when unset)", async () => {
      const fs = new MemoryFS();
      fs.restore({
        files: { "/img.png": { kind: "file", dataBase64: Buffer.from("x").toString("base64"), mtime: 1, mimeType: "image/png" } },
        dirs: ["/"],
      });
      const snap = fs.snapshot();
      expect(snap.files["/img.png"]).toMatchObject({ kind: "file", mimeType: "image/png" });
    });
  });
});

describe("MemoryFS native search seam (docs/host/sandbox/tech.md §4)", () => {
  it("does not implement searchFiles/searchContent — grep/glob must always fall back to JS scanning against it", () => {
    // typed as the NimboFS interface (not the concrete class) — searchFiles/searchContent are
    // optional members of the interface, not members of MemoryFS's own declared shape, so accessing
    // them off a bare `MemoryFS`-typed value wouldn't even type-check.
    const fs: NimboFS = new MemoryFS();
    expect(fs.searchFiles).toBeUndefined();
    expect(fs.searchContent).toBeUndefined();
  });
});
