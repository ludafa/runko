/**
 * 05-custom-exec — "bring your own sandbox" (docs/features/core-sdk.md §3.4 /
 * docs/tech/core-sdk.md §4.5a): `RunkoExec` is a three-method interface
 * (`exec`, optional `describe`, optional `defaultApproval`). runko ships
 * `@runko/mini-bash` (a read-only in-process interpreter) and
 * `localExec` (a real local shell) as reference implementations, but neither
 * is special — a host with its own Docker/e2b/remote-worker sandbox injects
 * its own object here and nothing about the agent loop, the `bash` tool, or
 * the approval chain has to change (this is docs/features/core-sdk.md §6's fourth success
 * criterion, verified end to end).
 *
 * This example's custom exec is a tiny in-memory stub (not a real sandbox) —
 * it "runs" a fixed whitelist of commands purely from a lookup table, to
 * keep the demo dependency-free while still exercising the real interface.
 *
 * Demonstrates: implementing RunkoExec from scratch, `defaultApproval`,
 * `describe()`, wiring it via `createSession({ exec })`.
 *
 * Run: `node examples/05-custom-exec.ts` (see examples/README.md for setup).
 *
 * Expected output shape:
 *   1. A deterministic section (no model, no env vars needed): calls the
 *      custom exec's `exec()` directly for a known and an unknown command,
 *      printing the resulting `ExecResult` (exit codes 0 and 127
 *      respectively — same convention `@runko/mini-bash` and `localExec`
 *      follow).
 *   2. If RUNKO_MODEL is set: the custom exec is wired into a session via
 *      `createSession({ exec })`, and the agent is asked to run one of the
 *      whitelisted commands through the `bash` tool. If RUNKO_MODEL is
 *      unset, this section is skipped with a clean exit.
 */
import type { ExecRequest, ExecResult, RunkoExec } from "@runko/sdk";
import { createSession, defineAgent } from "@runko/sdk";
import { resolveModel } from "./shared/model.ts";

/**
 * A minimal custom RunkoExec: a fixed command whitelist, no real process, no
 * real filesystem — this is the "fully decoupled" mode C from §4.5a (the
 * exec surface makes no promise about seeing files the agent wrote through
 * the file tools; a real sandbox implementation typically would, by running
 * on the same data as its own RunkoFS, i.e. mode A).
 */
function stubSandboxExec(): RunkoExec {
  const whitelist: Record<string, string> = {
    "whoami": "sandbox-worker\n",
    "pwd": "/workspace\n",
  };

  return {
    // A stub sandbox: no ambient trust, every command needs sign-off. Real
    // sandboxes usually declare "allow" instead (isolation is the boundary).
    defaultApproval: "review",
    describe(): string {
      return `stub-sandbox: an in-memory RunkoExec fake for examples/05-custom-exec.ts. Supported commands: ${Object.keys(whitelist).join(", ")}.`;
    },
    async exec(req: ExecRequest): Promise<ExecResult> {
      const start = Date.now();
      const stdout = whitelist[req.command];
      if (stdout === undefined) {
        return { exitCode: 127, stdout: "", stderr: `${req.command}: command not found\n`, durationMs: Date.now() - start };
      }
      return { exitCode: 0, stdout, stderr: "", durationMs: Date.now() - start };
    },
  };
}

async function deterministicSection(): Promise<void> {
  console.log("--- 1. calling a hand-written RunkoExec directly, no agent involved ---");

  const exec = stubSandboxExec();
  console.log("describe():", exec.describe?.());
  console.log("defaultApproval:", exec.defaultApproval);

  const known = await exec.exec({ command: "whoami", signal: new AbortController().signal });
  console.log('exec({ command: "whoami" }) ->', known);

  const unknown = await exec.exec({ command: "rm -rf /", signal: new AbortController().signal });
  console.log('exec({ command: "rm -rf /" }) ->', unknown);
}

async function modelDrivenSection(): Promise<void> {
  const model = resolveModel();

  console.log("\n--- 2. the same custom exec, wired into a session — no loop code changed ---");

  const agent = defineAgent({ model });
  // Swapping localExec/miniBash for stubSandboxExec() here is the entire integration
  // surface: createSession({ exec }) is agnostic to what's behind the interface.
  //
  // The stub declares `defaultApproval: "review"`, so every bash call raises an approval
  // request; without a session-level arbiter it would be denied by design (docs/tech/core-sdk.md §4.5a
  // "no-arbiter semantics" — an unanswered "review" must fail closed, not silently pass). A
  // real host would plug in its own UI/policy here; `onApproval: "allow"` just means "allow
  // whatever reaches me", which is enough to let this demo actually run the command.
  const session = createSession(agent, { exec: stubSandboxExec(), onApproval: "allow" });

  const result = await session.send("你现在是谁？用命令查一下。");
  console.log("finalResponse:", result.finalResponse);
  console.log(
    "tool_call items:",
    session.toJSON().messages.flatMap((m) => m.parts).filter((p) => p.type.startsWith("tool-")),
  );
}

await deterministicSection();
await modelDrivenSection();
