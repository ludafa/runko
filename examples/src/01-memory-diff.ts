/**
 * 01-memory-diff — the "SaaS inline code assistant" scenario from
 * docs/features/core-sdk.md §3.1: a code snippet lives only in memory, the
 * agent edits it, the host reads back a diff. Nothing ever touches the real
 * disk, which is the whole point of NimboFS.fromMemory — this is what makes
 * nimbo safe to run per-request in a multi-tenant service.
 *
 * Demonstrates: NimboFS.fromMemory, defineAgent, createSession, session.send,
 * session.fs.diff().
 *
 * Run: `node examples/01-memory-diff.ts` (see examples/README.md for setup).
 *
 * Expected output shape:
 *   1. A deterministic section (no model, no env vars needed) that writes a
 *      file into a MemoryFS by hand and prints session.fs.diff() — proving
 *      diff() reports `kind: "created"` for a brand new in-memory file.
 *   2. If NIMBO_MODEL is set: a second MemoryFS seeded with a small file,
 *      the agent asked to make an edit, and the resulting diff — `kind:
 *      "modified"` with `before`/`after`/`patch` populated. If NIMBO_MODEL is
 *      unset, this section is skipped with a clean exit (code 0).
 */
import { createSession, defineAgent, NimboFS } from "@nimbo/sdk";
import { resolveModel } from "./shared/model.ts";

async function deterministicSection(): Promise<void> {
  console.log("--- 1. NimboFS.fromMemory + diff(), no model involved ---");

  const fs = NimboFS.fromMemory({ "src/index.ts": "var x = 1;\n" });
  await fs.writeFile("src/greeting.ts", 'export const greeting = "hi";\n');

  // MemoryFS has no persistent base snapshot (docs/tech/core-sdk.md §4.4) — every entry
  // it currently holds reports as `kind: "created"`, including the file the
  // constructor seeded it with.
  console.log(JSON.stringify(await fs.diff(), null, 2));
}

async function modelDrivenSection(): Promise<void> {
  const model = resolveModel();

  console.log("\n--- 2. agent edits an in-memory file, host reads back the diff ---");

  const fs = NimboFS.fromMemory({ "src/index.ts": "var x = 1;\nvar y = 2;\n" });
  const agent = defineAgent({ model });
  const session = createSession(agent, { fs });

  const result = await session.send("把 src/index.ts 里的 var 全部改成 const");
  console.log("finalResponse:", result.finalResponse);
  console.log("diff:", JSON.stringify(await session.fs.diff(), null, 2));
}

await deterministicSection();
await modelDrivenSection();
