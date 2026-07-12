/**
 * 02-dir-mount — zero-copy overlay mount of a real directory
 * (docs/02-tech-spec.md §4.4 `OverlayFS`): reads pass through to disk, every
 * write lands in an in-memory overlay, and the real directory is untouched
 * until you explicitly call `writeBack()`. This is what makes it safe to
 * hand an agent a real project directory without risking the working tree.
 *
 * Demonstrates: NimboFS.fromDirectory, session.fs.diff(), session.fs.writeBack().
 *
 * Run: `node examples/02-dir-mount.ts` (see examples/README.md for setup).
 *
 * Expected output shape:
 *   1. A deterministic section (no model, no env vars needed): mounts a
 *      scratch directory, confirms diff() is empty right after mounting
 *      (nothing written to the overlay yet), then writes a file through the
 *      FS interface and confirms it does NOT appear on real disk until
 *      writeBack() is called.
 *   2. If NIMBO_MODEL is set: the agent edits a real file through the
 *      mounted overlay; the diff is printed, writeBack() is called, and the
 *      real file's new contents are read back from disk to prove it landed.
 *      If NIMBO_MODEL is unset, this section is skipped with a clean exit.
 */
import * as nodeFs from "node:fs/promises";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { createSession, defineAgent, NimboFS } from "@nimbo/sdk";
import { resolveModel } from "./shared/model.ts";

async function makeScratchProject(seedContent: string): Promise<string> {
  const dir = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), "nimbo-example-02-"));
  await nodeFs.mkdir(nodePath.join(dir, "src"), { recursive: true });
  await nodeFs.writeFile(nodePath.join(dir, "src", "index.ts"), seedContent);
  return dir;
}

async function deterministicSection(): Promise<void> {
  console.log("--- 1. mount, write through the overlay, real disk stays untouched until writeBack() ---");

  const projectDir = await makeScratchProject("var x = 1;\n");
  const fs = NimboFS.fromDirectory(projectDir);

  console.log("diff() right after mounting:", await fs.diff()); // []: nothing written to the overlay yet

  await fs.writeFile("/src/index.ts", "const x = 1;\n");
  const onRealDisk = await nodeFs.readFile(nodePath.join(projectDir, "src", "index.ts"), "utf8");
  console.log("real disk content after an overlay write (still the original):", JSON.stringify(onRealDisk));
  console.log("diff() now reports the pending change:", await fs.diff());

  await nodeFs.rm(projectDir, { recursive: true, force: true });
}

async function modelDrivenSection(): Promise<void> {
  const model = resolveModel();

  console.log("\n--- 2. agent edits a mounted directory, host calls writeBack() ---");

  const projectDir = await makeScratchProject("var x = 1;\n");
  const agent = defineAgent({ model });
  // createSession's generic overload keeps `session.fs`'s concrete type — fromDirectory(...)
  // returns an OverlayFS, so `session.fs.diff()`/`.writeBack()` are available without a cast.
  const session = createSession(agent, { fs: NimboFS.fromDirectory(projectDir) });

  const result = await session.send("把 src/index.ts 里的 var 全部改成 const");
  console.log("finalResponse:", result.finalResponse);
  console.log("diff:", await session.fs.diff());

  await session.fs.writeBack();
  const written = await nodeFs.readFile(nodePath.join(projectDir, "src", "index.ts"), "utf8");
  console.log("real disk content after writeBack():", JSON.stringify(written));

  await nodeFs.rm(projectDir, { recursive: true, force: true });
}

await deterministicSection();
await modelDrivenSection();
