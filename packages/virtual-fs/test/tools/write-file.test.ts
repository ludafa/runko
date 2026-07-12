import { describe, expect, it } from "vitest";
import { MemoryFS, fromMemory } from "../../src/memory.js";
import { createWriteFileTool } from "../../src/tools/write-file.js";
import { createMapReadStateStore, createOnFileChangeMock, expectError, expectText, makeCtx, readMtime } from "./helpers.js";

describe("write_file", () => {
  it("creates a new file, auto-creating missing parent directories, and reports kind:add", async () => {
    const fs = new MemoryFS();
    const readState = createMapReadStateStore();
    const onFileChange = createOnFileChangeMock();
    const tool = createWriteFileTool({ readState, onFileChange });

    const result = expectText(await tool.execute({ path: "/deep/nested/new.txt", content: "hello" }, makeCtx(fs)));
    expect(result).toContain("created");
    expect(new TextDecoder().decode(await fs.readFile("/deep/nested/new.txt"))).toBe("hello");
    expect(onFileChange).toHaveBeenCalledWith([{ path: "/deep/nested/new.txt", kind: "add" }]);
  });

  it("rejects overwriting an existing file that has not been read in this session", async () => {
    const fs = fromMemory({ "a.txt": "old" });
    const onFileChange = createOnFileChangeMock();
    const tool = createWriteFileTool({ readState: createMapReadStateStore(), onFileChange });

    const content = expectError(await tool.execute({ path: "/a.txt", content: "new" }, makeCtx(fs)));
    expect(content).toContain("read_file");
    expect(new TextDecoder().decode(await fs.readFile("/a.txt"))).toBe("old"); // unchanged
    expect(onFileChange).not.toHaveBeenCalled();
  });

  it("allows overwriting an existing file after it was read, and reports kind:update", async () => {
    const fs = fromMemory({ "a.txt": "old" });
    const readState = createMapReadStateStore();
    const onFileChange = createOnFileChangeMock();
    readState.set("/a.txt", await readMtime(fs, "/a.txt"));
    const tool = createWriteFileTool({ readState, onFileChange });

    const result = expectText(await tool.execute({ path: "/a.txt", content: "new" }, makeCtx(fs)));
    expect(result).toContain("overwritten");
    expect(new TextDecoder().decode(await fs.readFile("/a.txt"))).toBe("new");
    expect(onFileChange).toHaveBeenCalledWith([{ path: "/a.txt", kind: "update" }]);
  });

  it("rejects overwriting when the file changed since it was last read (bash-bypass simulation)", async () => {
    const fs = fromMemory({ "a.txt": "v1" });
    const readState = createMapReadStateStore();
    readState.set("/a.txt", await readMtime(fs, "/a.txt"));

    // simulate an out-of-band write that bypasses the tool layer (e.g. a bash command)
    await fs.writeFile("/a.txt", "v2-from-bash");

    const tool = createWriteFileTool({ readState });
    const content = expectError(await tool.execute({ path: "/a.txt", content: "v3" }, makeCtx(fs)));
    expect(content).toContain("changed since it was last read");
    expect(content).toContain("read_file");
  });

  it("registers readState with the post-write mtime, so a subsequent overwrite needs no extra read", async () => {
    const fs = fromMemory({ "a.txt": "old" });
    const readState = createMapReadStateStore();
    readState.set("/a.txt", await readMtime(fs, "/a.txt"));
    const tool = createWriteFileTool({ readState });

    await tool.execute({ path: "/a.txt", content: "v2" }, makeCtx(fs));
    const secondResult = expectText(await tool.execute({ path: "/a.txt", content: "v3" }, makeCtx(fs)));
    expect(secondResult).toContain("overwritten");
    expect(new TextDecoder().decode(await fs.readFile("/a.txt"))).toBe("v3");
  });

  it("errors when writing over an existing directory", async () => {
    const fs = fromMemory({ "dir/child.txt": "x" });
    const tool = createWriteFileTool({ readState: createMapReadStateStore() });

    const content = expectError(await tool.execute({ path: "/dir", content: "oops" }, makeCtx(fs)));
    expect(content).toContain("directory");
  });
});
