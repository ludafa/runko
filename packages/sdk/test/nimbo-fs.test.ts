/**
 * P7-1 acceptance: `NimboFS.fromMemory`/`NimboFS.fromDirectory` value-namespace calls
 * (docs/core/core-sdk/feature.md §4.1: `NimboFS.fromDirectory("./project")`).
 */
import * as nodeFs from "node:fs/promises";
import * as nodePath from "node:path";
import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NimboFS } from "../src/index.js";
import type { NimboFS as NimboFSType } from "../src/index.js";

describe("NimboFS value namespace", () => {
  it("fromMemory builds a working in-memory FS from a plain object", async () => {
    const fs = NimboFS.fromMemory({ "a.txt": "hello", "src/index.ts": "export {}" });
    expect(new TextDecoder().decode(await fs.readFile("/a.txt"))).toBe("hello");
    expect(new TextDecoder().decode(await fs.readFile("/src/index.ts"))).toBe("export {}");
  });

  it("fromMemory's return type is usable wherever the NimboFS type is expected, without a cast", () => {
    const fs: NimboFSType = NimboFS.fromMemory({});
    expect(typeof fs.readFile).toBe("function");
  });

  describe("fromDirectory", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await nodeFs.mkdtemp(nodePath.join(os.tmpdir(), "nimbo-sdk-fromDirectory-"));
      await nodeFs.mkdir(nodePath.join(tmpDir, "src"), { recursive: true });
      await nodeFs.writeFile(nodePath.join(tmpDir, "src", "index.ts"), "var x = 1;\n");
    });

    afterEach(async () => {
      await nodeFs.rm(tmpDir, { recursive: true, force: true });
    });

    it("mounts a real directory read-through, zero-copy overlay (OverlayFS, has diff()/writeBack())", async () => {
      const fs = NimboFS.fromDirectory(tmpDir);
      expect(new TextDecoder().decode(await fs.readFile("/src/index.ts"))).toBe("var x = 1;\n");
      // OverlayFS-only capabilities (not on the plain NimboFS interface) prove the concrete
      // return type is preserved, not widened to the bare interface.
      expect(typeof fs.diff).toBe("function");
      expect(typeof fs.writeBack).toBe("function");
      expect(await fs.diff()).toEqual([]); // nothing written yet — no diff
    });

    it("writes land in the overlay, never on real disk (§4.4)", async () => {
      const fs = NimboFS.fromDirectory(tmpDir);
      await fs.writeFile("/src/index.ts", "const x = 1;\n");
      const diff = await fs.diff();
      expect(diff).toEqual([{ path: "/src/index.ts", kind: "modified", before: "var x = 1;\n", after: "const x = 1;\n", patch: expect.any(String) }]);
      expect(await nodeFs.readFile(nodePath.join(tmpDir, "src", "index.ts"), "utf8")).toBe("var x = 1;\n");
    });
  });
});
