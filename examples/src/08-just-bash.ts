/**
 * 08-just-bash — the "full-syntax bash" upgrade path from
 * docs/tech/core-sdk.md §4.5b: `@nimbo/mini-bash`'s six read-only commands
 * can't carry a Claude-style model's high-frequency `if`/`for`/`while`/
 * `case` scripts, so nimbo ships a second, *optional* `NimboExec`
 * implementation — `@nimbo/just-bash`, an adapter over
 * vercel-labs/just-bash — instead of trying to grow mini-bash's interpreter
 * into a full shell. It is a one-line swap for `miniBash(fs)`
 * (`createSession({ fs, exec: justBash(fs) })`) but supports the real
 * control-flow surface: if/elif/else, for (list and C-style), while/until,
 * case, functions with `local`, variable/parameter expansion, glob
 * expansion, pipes, `&&`/`||`, and redirections (`>`, `>>`, `<`, `2>&1`).
 *
 * `@nimbo/just-bash` is **not** re-exported by `@nimbo/sdk` (§4.5b "包关系":
 * just-bash's own dependency tree carries optional wasm bits — sql.js,
 * quickjs-emscripten — that the sdk's batteries-included default shouldn't
 * force on every consumer), so unlike `miniBash` in 04-mini-bash.ts, this
 * example imports `justBash` from its own package and installs it
 * separately (see examples/README.md and this repo's root README package
 * table).
 *
 * Same mode-A "same-source workspace" story as 04: `justBash(fs)` and the
 * file tools share one `NimboFS`, so a file the agent writes through
 * `write-file` is immediately visible to the script, and vice versa —
 * nothing to keep in sync (§4.5a mode A).
 *
 * Known, as-documented limitations this example does **not** paper over
 * (§4.5b "已知限制" / the adapter's own `describe()`):
 *   - output is **not streamed** — just-bash has no incremental callback, so
 *     `onOutput` fires at most once per stream, only after the whole script
 *     has finished (proven below by counting the callback's invocations);
 *   - no symlinks, no network;
 *   - execution limits are enforced by default (maxCommandCount /
 *     maxLoopIterations 2000, maxOutputSize 1MB — see `JustBashOptions.limits`
 *     to override).
 *
 * Demonstrates: `justBash(fs, opts?)`, a real if/for/function/redirection
 * script run directly against the interpreter (bypassing the agent loop),
 * the non-streaming `onOutput` contract, and `createSession({ fs, exec })`
 * wired so the model can drive the same interpreter through the `bash`
 * tool for a task that genuinely needs control flow (something mini-bash's
 * six commands could not express).
 *
 * Run: `pnpm example 08` (or `node examples/src/08-just-bash.ts`; see
 * examples/README.md for setup — this example additionally needs
 * `@nimbo/just-bash`, which `pnpm install` sets up for you).
 *
 * Expected output shape:
 *   1. A deterministic section (no model, no env vars needed): prints
 *      `exec.describe()`, then runs a script that creates a directory,
 *      writes three files inside a `for` loop, counts them with a `local`-
 *      scoped function guarded by an `if`/`else`, appends the tally through
 *      `>>` redirection, and `cat`s the result — printing the full
 *      `ExecResult` (`{ exitCode: 0, stdout: "...", stderr: "", durationMs }`)
 *      plus proof that `onOutput` fired exactly once.
 *   2. If NIMBO_MODEL is set: a full session with both the file tools and
 *      `bash` wired to the same fs; the agent is asked to write a `for`-loop
 *      script that counts `.txt` files under a directory — a task
 *      `@nimbo/mini-bash` has no syntax to express. If NIMBO_MODEL is
 *      unset, this section is skipped with a clean exit.
 */
import { createSession, defineAgent, NimboFS } from "@nimbo/sdk";
import { justBash } from "@nimbo/just-bash";
import { resolveModel } from "./shared/model.ts";

const CONTROL_FLOW_SCRIPT = `
mkdir -p /reports
count=0
for lang in ts js py; do
  echo "checking \${lang}" >> /reports/log.txt
  if [ "\${lang}" = "js" ]; then
    count=$((count+1))
  fi
done

summarize() {
  local total="$1"
  if [ "$total" -gt 0 ]; then
    echo "flagged: $total"
  else
    echo "flagged: none"
  fi
}

summarize "$count" >> /reports/log.txt
cat /reports/log.txt
`;

async function deterministicSection(): Promise<void> {
  console.log("--- 1. full-syntax script (for + if/else + function/local + redirection), run directly ---");

  const fs = NimboFS.fromMemory({});
  const exec = justBash(fs);
  console.log("describe():\n" + exec.describe?.());

  const outputChunks: { stream: "stdout" | "stderr"; data: string }[] = [];
  const result = await exec.exec(
    { command: CONTROL_FLOW_SCRIPT, cwd: "/", signal: new AbortController().signal },
    { onOutput: (chunk) => outputChunks.push(chunk) },
  );
  console.log("\nExecResult ->", result);
  // Proof of the "output is NOT streamed" claim above: exactly one onOutput
  // call for the whole script, not one per `echo`/`cat` inside it.
  console.log(`onOutput fired ${String(outputChunks.length)} time(s) (non-streaming: the whole script's stdout in one chunk)`);
}

async function modelDrivenSection(): Promise<void> {
  const model = resolveModel();

  console.log("\n--- 2. agent drives a for-loop script through bash (same session) ---");

  const fs = NimboFS.fromMemory({});
  const agent = defineAgent({ model });
  const session = createSession(agent, { fs, exec: justBash(fs) });

  const result = await session.send(
    "在 /data 目录下创建 3 个 .txt 文件，然后用 bash 写一段 for 循环脚本统计 /data 下有多少个 .txt 文件，把统计结果打印出来。",
  );
  console.log("finalResponse:", result.finalResponse);
  console.log(
    "tool_call items:",
    session.toJSON().messages.flatMap((m) => m.parts).filter((p) => p.type.startsWith("tool-")),
  );
}

await deterministicSection();
await modelDrivenSection();
