/**
 * 10-sandbox-vercel — the second "BYO cloud sandbox" example (see 09's header
 * for the shared background: docs/06-sandbox-workspace-research.md §8,
 * docs/03-construction-plan.md P10). This one wraps a Vercel Sandbox — a real
 * Amazon Linux 2023 Firecracker microVM — instead of an E2B one.
 *
 * `@nimbo/sandbox-vercel` is, like `@nimbo/sandbox-e2b`, **not** re-exported
 * by `@nimbo/sdk` — install it explicitly (`pnpm add @nimbo/sandbox-vercel
 * @vercel/sandbox`).
 *
 * Same structural-interface story as 09 (docs/06 §8.1): `vercelWorkspace(sandbox,
 * opts?)` accepts anything shaped like `VercelSandboxLike` (the `fs`/`runCommand`
 * subset it actually calls) — it never imports "@vercel/sandbox" at runtime.
 * The deterministic section below hands it an in-process fake and proves the
 * whole `NimboFS & NimboExec` contract with zero credentials, zero network.
 *
 * BYO instance: `vercelWorkspace()` never creates or destroys a sandbox — the
 * real-sandbox section below creates one with `Sandbox.create({ token, teamId,
 * projectId, runtime })` and is responsible for `sandbox.stop()` at the end.
 *
 * Known, as-documented limitations (the adapter's own `describe()` / docs/03
 * P10-2 "实际改动"):
 *   - **non-recursive `rm` of a directory is split across two real fs calls**:
 *     unlike the research doc's original assumption, `@vercel/sandbox`'s
 *     `fs.rm(path)` (non-recursive) throws `ERR_FS_EISDIR` for *any* directory
 *     regardless of whether it's empty — the adapter routes non-recursive
 *     directory removal through `fs.rmdir()` instead (empty succeeds, non-empty
 *     gets a real `ENOTEMPTY`), and only uses `fs.rm()` directly for files or
 *     `{recursive: true}` deletes;
 *   - **bash reaches the whole VM, not just the workspace root**: the file
 *     tools are anchored under `opts.root` (default `/vercel/sandbox`), but
 *     `bash -lc "<script>"` is a full real shell with sudo and no such
 *     confinement — an *absolute* bash path (`cat /notes.txt`) resolves
 *     against the sandbox's real filesystem root, not the workspace root. The
 *     model instruction below asks for a *relative* bash path (`cat
 *     notes.txt`) for the same reason as 09 — see
 *     `packages/sandbox-vercel/README.md` "已知限制" (a trait shared by all
 *     three sandbox adapters, not vercel-specific);
 *   - each NimboFS file-tool call is a network round trip — prefer a single
 *     bash command for scan-heavy work over many individual `glob`/`read_file`
 *     calls.
 *
 * Run: `node examples/10-sandbox-vercel.ts` (see examples/README.md for setup).
 *
 * Expected output shape:
 *   1. A deterministic section (no model, no env vars, no network): an
 *      in-process fake implementing `VercelSandboxLike`, wrapped by
 *      `vercelWorkspace()`, printing `describe()`, one `exec()` call, and one
 *      `writeFile`/`readFile` round trip.
 *   2. A real-sandbox section, gated in order: first `resolveModel()` (no
 *      model configured anywhere → setup instructions + clean `exit(0)`);
 *      then, only if a model *is* configured, all three of `VERCEL_TOKEN`/
 *      `VERCEL_TEAM_ID`/`VERCEL_PROJECT_ID` (see .env.template's
 *      "Vercel Sandbox" section) — any missing prints setup instructions and
 *      returns cleanly, **before** any sandbox or model call is made. This
 *      repo's checkout has no Vercel Sandbox credentials, so this section is
 *      expected to stop at the guidance message — the real-sandbox path
 *      compiles and reads correctly but is untested end-to-end here; results
 *      get backfilled into docs/05 once a user supplies the three variables.
 */
import { createSession, defineAgent } from "@nimbo/sdk";
import { vercelWorkspace } from "@nimbo/sandbox-vercel";
import type {
  VercelCommandResultLike,
  VercelDirentLike,
  VercelFileSystemLike,
  VercelRunCommandParams,
  VercelSandboxLike,
  VercelStatsLike,
} from "@nimbo/sandbox-vercel";
import { Sandbox } from "@vercel/sandbox";
import { resolveModel } from "./shared/model.ts";

const ROOT = "/vercel/sandbox";

/**
 * A few-dozen-line in-process fake satisfying `VercelSandboxLike` — no
 * network, no "@vercel/sandbox" import. Only supports what this demo
 * exercises; see `packages/sandbox-vercel/test/helpers.ts` for the fuller
 * fake the package's own contract tests use (ENOENT/EISDIR/ENOTEMPTY
 * emulation and all).
 */
function createFakeSandbox(): VercelSandboxLike {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>([ROOT]);

  function notFound(path: string): Error {
    return Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: "ENOENT" });
  }

  const fs: VercelFileSystemLike = {
    async readFile(path) {
      const data = files.get(path);
      if (data === undefined) throw notFound(path);
      return data;
    },
    async writeFile(path, data) {
      files.set(path, typeof data === "string" ? new TextEncoder().encode(data) : data);
    },
    async mkdir(path) {
      dirs.add(path);
      return path;
    },
    async readdir(path) {
      const prefix = `${path}/`;
      const entries: VercelDirentLike[] = [];
      for (const p of files.keys()) {
        if (p.startsWith(prefix) && !p.slice(prefix.length).includes("/")) {
          entries.push({ name: p.slice(prefix.length), isDirectory: () => false, isFile: () => true });
        }
      }
      return entries;
    },
    async stat(path) {
      const data = files.get(path);
      if (data === undefined && !dirs.has(path)) throw notFound(path);
      const isDir = data === undefined;
      const result: VercelStatsLike = { isDirectory: () => isDir, isFile: () => !isDir, size: data?.byteLength ?? 0, mtimeMs: Date.now() };
      return result;
    },
    async rm(path) {
      files.delete(path);
    },
    async rmdir(path) {
      dirs.delete(path);
    },
  };

  return {
    fs,
    async runCommand(params: VercelRunCommandParams): Promise<VercelCommandResultLike> {
      const text = `ran: ${params.cmd} ${(params.args ?? []).join(" ")}\n`;
      params.stdout?.write(text);
      return { exitCode: 0 };
    },
  };
}

async function deterministicSection(): Promise<void> {
  console.log("--- 1. a fake sandbox behind the VercelSandboxLike structural interface (BYO instance, no real @vercel/sandbox) ---");

  const workspace = vercelWorkspace(createFakeSandbox());
  console.log("describe():\n" + workspace.describe?.());

  await workspace.writeFile("/notes.txt", "hello from the fake vercel sandbox\n");
  const bytes = await workspace.readFile("/notes.txt");
  console.log("\nreadFile(/notes.txt) ->", new TextDecoder().decode(bytes));

  const result = await workspace.exec({ command: "cat notes.txt", cwd: "/", signal: new AbortController().signal });
  console.log("\nexec(\"cat notes.txt\") ->", result);
}

async function realSandboxSection(): Promise<void> {
  const model = resolveModel(); // no model configured anywhere -> prints setup instructions and exit(0)

  console.log("\n--- 2. a real Vercel Sandbox, driven by the model ---");

  const token = process.env.VERCEL_TOKEN?.trim();
  const teamId = process.env.VERCEL_TEAM_ID?.trim();
  const projectId = process.env.VERCEL_PROJECT_ID?.trim();
  if (token === undefined || token.length === 0 || teamId === undefined || teamId.length === 0 || projectId === undefined || projectId.length === 0) {
    console.log(
      "[nimbo example] VERCEL_TOKEN/VERCEL_TEAM_ID/VERCEL_PROJECT_ID are not fully set — skipping the real-sandbox section.\n" +
        'See the "Vercel Sandbox" section of .env.template for where to get each value. No sandbox is ' +
        "created and no model call is made while any of the three is missing.",
    );
    return;
  }

  // persistent: false — Vercel sandboxes default to snapshotting their
  // filesystem on stop() and lingering in the project's sandbox list until
  // deleted; a demo run has nothing worth resuming, so opt out and leave the
  // account clean (a billed leftover per run otherwise). Real applications
  // that resume sessions across processes are the case that wants the
  // persistent default (docs/06 §3.3).
  const sandbox = await Sandbox.create({ token, teamId, projectId, runtime: "node24", persistent: false });
  try {
    const workspace = vercelWorkspace(sandbox);
    const agent = defineAgent({ model });
    const session = createSession(agent, { workspace });

    const result = await session.send(
      "用 write_file 在 /notes.txt 写一句问候语，然后用 bash 执行 `cat notes.txt`（相对路径，不要写成 /notes.txt）验证内容与写入的一致。",
    );
    console.log("finalResponse:", result.finalResponse);
  } finally {
    await sandbox.stop();
  }
}

await deterministicSection();
await realSandboxSection();
