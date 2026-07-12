import { describe, expect, it } from "vitest";
import { fromMemory } from "../../src/memory.js";
import { createFileTools } from "../../src/tools/index.js";
import type { FileChange, FileToolName, ReadStateStore } from "../../src/tools/index.js";
import { createMapReadStateStore, createOnFileChangeMock, expectText, makeCtx } from "./helpers.js";

describe("createFileTools", () => {
  it("returns exactly the eight file tools, each Tool-shaped", () => {
    const tools = createFileTools({ readState: createMapReadStateStore() });
    const expectedNames: FileToolName[] = ["read_file", "write_file", "edit_file", "delete_file", "move_file", "list_dir", "glob", "grep"];

    expect(Object.keys(tools).sort()).toEqual([...expectedNames].sort());
    for (const name of expectedNames) {
      expect(typeof tools[name].description).toBe("string");
      expect(typeof tools[name].execute).toBe("function");
    }
  });

  it("shares one readState across tools: write_file then edit_file needs no read_file call in between", async () => {
    const fs = fromMemory({});
    const tools = createFileTools({ readState: createMapReadStateStore() });
    const ctx = makeCtx(fs);

    await tools.write_file.execute({ path: "/a.ts", content: "const x = 1;" }, ctx);
    const result = expectText(await tools.edit_file.execute({ path: "/a.ts", old_string: "const x = 1;", new_string: "const x = 2;" }, ctx));
    expect(result).toContain("1 replacement");
  });

  it("routes onFileChange from every mutating tool through the same callback", async () => {
    const fs = fromMemory({});
    const onFileChange = createOnFileChangeMock();
    const tools = createFileTools({ readState: createMapReadStateStore(), onFileChange });
    const ctx = makeCtx(fs);

    await tools.write_file.execute({ path: "/a.txt", content: "x" }, ctx);
    await tools.delete_file.execute({ path: "/a.txt" }, ctx);

    expect(onFileChange).toHaveBeenNthCalledWith(1, [{ path: "/a.txt", kind: "add" }]);
    expect(onFileChange).toHaveBeenNthCalledWith(2, [{ path: "/a.txt", kind: "delete" }]);
  });

  it("accepts a minimal custom ReadStateStore implementation (the P4 injection seam)", async () => {
    const backing: Record<string, number> = {};
    const customStore: ReadStateStore = {
      get: (path) => backing[path],
      set: (path, version) => {
        backing[path] = version;
      },
    };
    const fs = fromMemory({ "a.txt": "hello" });
    const tools = createFileTools({ readState: customStore });

    await tools.read_file.execute({ path: "/a.txt" }, makeCtx(fs));
    expect(backing["/a.txt"]).toBeTypeOf("number");
  });

  it("FileChange values only ever use the add/update/delete kind set", async () => {
    const fs = fromMemory({});
    const changes: FileChange[] = [];
    const tools = createFileTools({
      readState: createMapReadStateStore(),
      onFileChange: (batch) => changes.push(...batch),
    });
    const ctx = makeCtx(fs);

    await tools.write_file.execute({ path: "/a.txt", content: "x" }, ctx);
    await tools.edit_file.execute({ path: "/a.txt", old_string: "x", new_string: "y" }, ctx);
    await tools.move_file.execute({ from: "/a.txt", to: "/b.txt" }, ctx);
    await tools.delete_file.execute({ path: "/b.txt" }, ctx);

    expect(changes.length).toBeGreaterThan(0);
    for (const change of changes) {
      expect(["add", "update", "delete"]).toContain(change.kind);
    }
  });
});
