import { describe, expect, it } from "vitest";
import {
  DirFS,
  MemoryFS,
  NotFoundError,
  OverlayFS,
  PathEscapesRootError,
  ReadOnlyFileSystemError,
  ReferenceNotResolvable,
  buildFileDiff,
  computeUnifiedDiff,
  createFileTools,
  fromDirectory,
  fromMemory,
  inferMimeType,
  normalizePath,
} from "../src/index.js";
import type { CreateFileToolsOptions, FileChange, FileToolName, ReadStateStore } from "../src/index.js";

describe("@nimbo/virtual-fs public API surface", () => {
  it("exports the FS classes and factory functions", () => {
    expect(typeof MemoryFS).toBe("function");
    expect(typeof OverlayFS).toBe("function");
    expect(typeof DirFS).toBe("function");
    expect(typeof fromMemory).toBe("function");
    expect(typeof fromDirectory).toBe("function");
  });

  it("exports the error classes", () => {
    expect(typeof NotFoundError).toBe("function");
    expect(typeof PathEscapesRootError).toBe("function");
    expect(typeof ReadOnlyFileSystemError).toBe("function");
    expect(typeof ReferenceNotResolvable).toBe("function");
  });

  it("exports the path/mime/diff utility functions", () => {
    expect(normalizePath("a/b.txt")).toBe("/a/b.txt");
    expect(inferMimeType("/a.json")).toBe("application/json");
    expect(computeUnifiedDiff("/a.txt", "x", "y")).toContain("@@");
    expect(buildFileDiff("/a.txt", undefined, "x")?.kind).toBe("created");
  });

  it("end-to-end: fromMemory + read/write via the public entry point", async () => {
    const fs = fromMemory({ "a.txt": "hello" });
    expect(new TextDecoder().decode(await fs.readFile("/a.txt"))).toBe("hello");
  });

  it("exports createFileTools (and the ReadStateStore/FileChange seam types) from the package root", async () => {
    expect(typeof createFileTools).toBe("function");

    const store = new Map<string, number>();
    const readState: ReadStateStore = { get: (p) => store.get(p), set: (p, v) => void store.set(p, v) };
    const opts: CreateFileToolsOptions = {
      readState,
      onFileChange: (changes: FileChange[]) => void changes,
    };
    const tools = createFileTools(opts);
    const names: FileToolName[] = ["read-file", "write-file", "edit-file", "delete-file", "move-file", "list-dir", "glob", "grep"];
    expect(Object.keys(tools).sort()).toEqual([...names].sort());

    const fs = fromMemory({ "a.txt": "hello" });
    await tools["read-file"].execute({ path: "/a.txt" }, {
      fs,
      abortSignal: new AbortController().signal,
      callId: "call_1",
      session: { id: "s", turn: 0 },
      getSkill: () => ({ file: () => ({ text: async () => "" }) }),
      update: () => {},
    });
    expect(store.get("/a.txt")).toBeTypeOf("number");
  });
});
