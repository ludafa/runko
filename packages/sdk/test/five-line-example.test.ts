/**
 * P7-1 acceptance: docs/features/core-sdk.md §4.1's five-line quickstart, ported to this
 * package with the two deviations the ticket allows — the import source (`@nimbo/sdk` via
 * this package's own `../src/index.js`, since a package's tests always exercise its own
 * source) and the model (`MockLanguageModelV4` standing in for `anthropic(...)`, since real
 * network calls have no place in a unit test). Every other line is unchanged:
 *
 *   import { defineAgent, createSession } from "nimbo";
 *   import { anthropic } from "@ai-sdk/anthropic";
 *
 *   const agent = defineAgent({ model: anthropic("claude-sonnet-5") });
 *   const session = createSession(agent, { fs: NimboFS.fromDirectory("./project") });
 *   const result = await session.send("把 src/index.ts 里的 var 全部改成 const");
 *   console.log(result.finalResponse, session.fs.diff());
 */
import * as nodeFs from "node:fs/promises";
import * as nodePath from "node:path";
import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineAgent, createSession, NimboFS } from "../src/index.js";
import { mockModel, stopChunk, toolCallChunk } from "./helpers.js";

describe("docs/features/core-sdk.md §4.1 five-line quickstart (import source + model are the only deviations)", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await nodeFs.mkdtemp(nodePath.join(os.tmpdir(), "nimbo-sdk-quickstart-"));
    await nodeFs.mkdir(nodePath.join(projectDir, "src"), { recursive: true });
    await nodeFs.writeFile(nodePath.join(projectDir, "src", "index.ts"), "var x = 1;\n");
  });

  afterEach(async () => {
    await nodeFs.rm(projectDir, { recursive: true, force: true });
  });

  it("runs the quickstart end to end: agent reads, edits, and the diff is visible on session.fs", async () => {
    const model = mockModel(() => ({
      doStream: [
        toolCallChunk("call_1", "read-file", { path: "/src/index.ts" }),
        toolCallChunk("call_2", "edit-file", { path: "/src/index.ts", old_string: "var x = 1;", new_string: "const x = 1;" }),
        stopChunk("已将 src/index.ts 里的 var 改成 const。"),
      ],
    }));

    const agent = defineAgent({ model });
    const session = createSession(agent, { fs: NimboFS.fromDirectory(projectDir) });
    const result = await session.send("把 src/index.ts 里的 var 全部改成 const");

    expect(result.finalResponse).toBe("已将 src/index.ts 里的 var 改成 const。");
    // `session.fs.diff()` must compile without a cast — NimboFS.fromDirectory(...) returns an
    // OverlayFS, and createSession(...)'s generic overload preserves that concrete type.
    expect(await session.fs.diff()).toEqual([
      { path: "/src/index.ts", kind: "modified", before: "var x = 1;\n", after: "const x = 1;\n", patch: expect.any(String) },
    ]);

    // the real directory itself is untouched — writes only ever land in the overlay.
    expect(await nodeFs.readFile(nodePath.join(projectDir, "src", "index.ts"), "utf8")).toBe("var x = 1;\n");
  });
});
