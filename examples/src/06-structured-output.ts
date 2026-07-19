/**
 * 06-structured-output — the "automation pipeline node" scenario from
 * docs/features/core-sdk.md §3.2: run an agent as a CI/background-job step
 * and get a typed, zod-validated result back instead of free text
 * (docs/tech/core-sdk.md §4.8 "结构化输出").
 *
 * `session.send<T>(input, { outputSchema })` runs the normal turn to
 * completion first (tool calls, file edits, everything `session.send()`
 * without a schema would do), then folds the finished turn into JSON
 * matching `outputSchema` as a separate step — `result.items`/
 * `result.finalResponse` are unaffected, `result.structuredOutput` is
 * additive. Validation failures are retried against the model (up to 2
 * extra calls); exhausting the retry budget throws
 * `NimboStructuredOutputError` rather than silently returning something
 * that doesn't match the schema.
 *
 * Demonstrates: `session.send<T>(input, { outputSchema })`,
 * `NimboStructuredOutputError`.
 *
 * Run: `node examples/06-structured-output.ts` (see examples/README.md for setup).
 *
 * Expected output shape:
 *   1. A deterministic section (no model, no env vars needed): defines the
 *      zod schema this example asks the model to fill in, and parses a
 *      hand-written sample object against it — showing the exact shape
 *      `result.structuredOutput` will have, independent of any model call.
 *   2. If NIMBO_MODEL is set: the agent reads a short changelog entry from
 *      an in-memory file and is asked to extract it as structured data;
 *      `result.structuredOutput` is printed and is a `ReleaseNote` value, not
 *      a string. If NIMBO_MODEL is unset, this section is skipped with a
 *      clean exit.
 */
import { z } from "zod";
import { createSession, defineAgent, NimboFS } from "@nimbo/sdk";
import { resolveModel } from "./shared/model.ts";

const releaseNoteSchema = z.object({
  version: z.string().describe('semver, e.g. "1.4.0"'),
  breaking: z.boolean(),
  summary: z.string().describe("one sentence, no markdown"),
});

type ReleaseNote = z.infer<typeof releaseNoteSchema>;

const CHANGELOG_ENTRY = `
## 1.4.0
BREAKING: \`readFile\` now returns a Promise instead of taking a callback.
Also fixes a memory leak in the watcher.
`.trim();

function deterministicSection(): void {
  console.log("--- 1. the schema this example asks the model to fill in ---");
  console.log(JSON.stringify(z.toJSONSchema(releaseNoteSchema), null, 2));

  const sample: ReleaseNote = releaseNoteSchema.parse({
    version: "1.4.0",
    breaking: true,
    summary: "readFile is now Promise-based; fixes a watcher memory leak.",
  });
  console.log("\na value that satisfies the schema (hand-written, not model output):", sample);
}

async function modelDrivenSection(): Promise<void> {
  const model = resolveModel();

  console.log("\n--- 2. agent reads the changelog, returns typed structured output ---");

  const fs = NimboFS.fromMemory({ "CHANGELOG.md": CHANGELOG_ENTRY });
  const agent = defineAgent({ model });
  const session = createSession(agent, { fs });

  const result = await session.send<ReleaseNote>("读一下 CHANGELOG.md，把最新版本的信息提取出来。", {
    outputSchema: releaseNoteSchema,
  });

  // `result.structuredOutput` is a `ReleaseNote`, not `unknown` — no cast needed here.
  console.log("finalResponse:", result.finalResponse);
  console.log("structuredOutput:", result.structuredOutput);
}

deterministicSection();
await modelDrivenSection();
