import { describe, expect, it } from "vitest";
import { fromMemory } from "../../src/memory.js";
import { createEditFileTool } from "../../src/tools/edit-file.js";
import { createReadFileTool } from "../../src/tools/read-file.js";
import { createMapReadStateStore, createOnFileChangeMock, expectError, expectText, makeCtx, readMtime } from "./helpers.js";

describe("edit_file", () => {
  it("replaces a uniquely-matching old_string after the file was read", async () => {
    const fs = fromMemory({ "a.ts": "const x = 1;\nconst y = 2;" });
    const readState = createMapReadStateStore();
    readState.set("/a.ts", await readMtime(fs, "/a.ts"));
    const onFileChange = createOnFileChangeMock();
    const tool = createEditFileTool({ readState, onFileChange });

    const result = expectText(await tool.execute({ path: "/a.ts", old_string: "const x = 1;", new_string: "const x = 42;" }, makeCtx(fs)));
    expect(result).toContain("1 replacement");
    expect(new TextDecoder().decode(await fs.readFile("/a.ts"))).toBe("const x = 42;\nconst y = 2;");
    expect(onFileChange).toHaveBeenCalledWith([{ path: "/a.ts", kind: "update" }]);
  });

  it("full acceptance flow: read -> edit -> edit again requires no second read_file call", async () => {
    const fs = fromMemory({ "a.ts": "const x = 1;" });
    const readState = createMapReadStateStore();
    const readTool = createReadFileTool({ readState });
    const editTool = createEditFileTool({ readState });
    const ctx = makeCtx(fs);

    await readTool.execute({ path: "/a.ts" }, ctx);

    const first = expectText(await editTool.execute({ path: "/a.ts", old_string: "const x = 1;", new_string: "const x = 2;" }, ctx));
    expect(first).toContain("1 replacement");

    // no read_file call in between — must still succeed because edit_file re-registers readState after writing
    const second = expectText(await editTool.execute({ path: "/a.ts", old_string: "const x = 2;", new_string: "const x = 3;" }, ctx));
    expect(second).toContain("1 replacement");
    expect(new TextDecoder().decode(await fs.readFile("/a.ts"))).toBe("const x = 3;");
  });

  it("rejects an edit when the file was never read in this session", async () => {
    const fs = fromMemory({ "a.ts": "const x = 1;" });
    const tool = createEditFileTool({ readState: createMapReadStateStore() });

    const content = expectError(await tool.execute({ path: "/a.ts", old_string: "1", new_string: "2" }, makeCtx(fs)));
    expect(content).toContain("read_file");
  });

  it("rejects an edit when the file changed on disk since it was last read (bash-bypass simulation)", async () => {
    const fs = fromMemory({ "a.ts": "const x = 1;" });
    const readState = createMapReadStateStore();
    readState.set("/a.ts", await readMtime(fs, "/a.ts"));

    await fs.writeFile("/a.ts", "const x = 999; // changed by bash");

    const tool = createEditFileTool({ readState });
    const content = expectError(await tool.execute({ path: "/a.ts", old_string: "const x = 1;", new_string: "const x = 2;" }, makeCtx(fs)));
    expect(content).toContain("changed since it was last read");
    expect(content).toContain("read_file");
  });

  it("errors with corrective guidance when old_string is not found", async () => {
    const fs = fromMemory({ "a.ts": "const x = 1;" });
    const readState = createMapReadStateStore();
    readState.set("/a.ts", await readMtime(fs, "/a.ts"));
    const tool = createEditFileTool({ readState });

    const content = expectError(await tool.execute({ path: "/a.ts", old_string: "const z = 999;", new_string: "const z = 1000;" }, makeCtx(fs)));
    expect(content).toContain("was not found");
    expect(content).toContain("read_file");
  });

  it("errors with corrective guidance when old_string matches multiple locations and replace_all is not set", async () => {
    const fs = fromMemory({ "a.ts": "foo();\nfoo();\nfoo();" });
    const readState = createMapReadStateStore();
    readState.set("/a.ts", await readMtime(fs, "/a.ts"));
    const tool = createEditFileTool({ readState });

    const content = expectError(await tool.execute({ path: "/a.ts", old_string: "foo();", new_string: "bar();" }, makeCtx(fs)));
    expect(content).toContain("3 locations");
    expect(content).toContain("replace_all");
  });

  it("replace_all:true replaces every occurrence", async () => {
    const fs = fromMemory({ "a.ts": "foo();\nfoo();\nfoo();" });
    const readState = createMapReadStateStore();
    readState.set("/a.ts", await readMtime(fs, "/a.ts"));
    const tool = createEditFileTool({ readState });

    const result = expectText(await tool.execute({ path: "/a.ts", old_string: "foo();", new_string: "bar();", replace_all: true }, makeCtx(fs)));
    expect(result).toContain("3 replacements");
    expect(new TextDecoder().decode(await fs.readFile("/a.ts"))).toBe("bar();\nbar();\nbar();");
  });

  it("rejects old_string === new_string as a no-op", async () => {
    const fs = fromMemory({ "a.ts": "const x = 1;" });
    const readState = createMapReadStateStore();
    readState.set("/a.ts", await readMtime(fs, "/a.ts"));
    const tool = createEditFileTool({ readState });

    const content = expectError(await tool.execute({ path: "/a.ts", old_string: "const x = 1;", new_string: "const x = 1;" }, makeCtx(fs)));
    expect(content).toContain("identical");
  });

  it("errors when the path does not exist, suggesting write_file", async () => {
    const fs = fromMemory({});
    const tool = createEditFileTool({ readState: createMapReadStateStore() });

    const content = expectError(await tool.execute({ path: "/missing.ts", old_string: "a", new_string: "b" }, makeCtx(fs)));
    expect(content).toContain("does not exist");
    expect(content).toContain("write_file");
  });

  it("errors when the path is a directory", async () => {
    const fs = fromMemory({ "dir/a.txt": "x" });
    const tool = createEditFileTool({ readState: createMapReadStateStore() });

    const content = expectError(await tool.execute({ path: "/dir", old_string: "a", new_string: "b" }, makeCtx(fs)));
    expect(content).toContain("directory");
  });

  it("errors when the path is an unresolved reference entry", async () => {
    const fs = fromMemory({ "ref.bin": { ref: "https://x" } });
    const readState = createMapReadStateStore();
    readState.set("/ref.bin", await readMtime(fs, "/ref.bin"));
    const tool = createEditFileTool({ readState });

    const content = expectError(await tool.execute({ path: "/ref.bin", old_string: "a", new_string: "b" }, makeCtx(fs)));
    expect(content).toContain("reference entry");
  });
});
