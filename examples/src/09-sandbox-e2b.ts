/**
 * 09-sandbox-e2b — the first of three "BYO cloud sandbox" examples
 * (docs/tech/sandbox.md §8, docs/plans/core-sdk.md P10):
 * instead of `RunkoFS.fromMemory()`/`fromDirectory()` or the in-process
 * `miniBash`/`justBash` exec implementations, an agent's files and bash
 * commands can live in a real E2B cloud sandbox (a Firecracker microVM) —
 * one line of `createSession({ workspace })` away.
 *
 * `@runko/sandbox-e2b` is, like `@runko/just-bash` (see 08), **not**
 * re-exported by `@runko/sdk` — it's an optional integration, installed
 * explicitly (`pnpm add @runko/sandbox-e2b e2b`).
 *
 * Structural interface, not a hard dependency on the `e2b` package (docs/06
 * §8.1): `e2bWorkspace(sandbox, opts?)` accepts anything shaped like
 * `E2bSandboxLike` (a `files`/`commands` method subset) — it never imports
 * "e2b" at runtime. That means the deterministic section below can hand it a
 * few dozen lines of an in-process fake and prove the whole `RunkoFS &
 * RunkoExec` contract works with zero credentials, zero network, and zero
 * real e2b package import. `e2b` itself is only ever needed by the *host*
 * (this script), to actually create a real sandbox instance — the adapter
 * doesn't care.
 *
 * BYO instance: `e2bWorkspace()` never creates or destroys a sandbox. The
 * real-sandbox section below creates one with `Sandbox.create()`, hands it to
 * `e2bWorkspace()`, and is responsible for `sandbox.kill()` at the end.
 *
 * Known, as-documented limitations (the adapter's own `describe()` / docs/03
 * P10-1 "实际改动"):
 *   - **cancellation abandons waiting, it does not kill the remote
 *     process**: aborting/timing out an `exec()` call makes runko stop
 *     *waiting* for the result (return 124/130 promptly), but the command
 *     may keep running inside the sandbox to completion — actually killing
 *     it needs e2b's separate `background: true` + `CommandHandle.kill()`
 *     API, outside this adapter's v1 surface;
 *   - **bash reaches the whole VM, not just the workspace root**: the file
 *     tools (`read-file`/`write-file`/...) are anchored under `opts.root`
 *     (default `/home/user`), but `bash` itself is a real shell with no such
 *     confinement — an *absolute* path in a bash command (e.g. `cat
 *     /notes.txt`) resolves against the sandbox's real filesystem root, not
 *     the workspace root, and will miss a file the file tools just wrote at
 *     `/home/user/notes.txt`. The model instruction below deliberately asks
 *     for a *relative* bash path (`cat notes.txt`) to land in the same place
 *     the file tools see — see `packages/sandbox-e2b/README.md` "已知限制"
 *     for the full writeup (this is a "real FS + root anchor" trait shared by
 *     all three sandbox adapters, not e2b-specific);
 *   - each RunkoFS file-tool call is a network round trip — prefer a single
 *     bash command for scan-heavy work (grep/find over many files) instead of
 *     many individual `glob`/`read-file` calls.
 *
 * Run: `node examples/09-sandbox-e2b.ts` (see examples/README.md for setup).
 *
 * Expected output shape:
 *   1. A deterministic section (no model, no env vars, no network): a
 *      few-dozen-line fake implementing `E2bSandboxLike` in-process, wrapped
 *      by `e2bWorkspace()`, printing `describe()`, one `exec()` call, and one
 *      `writeFile`/`readFile` round trip.
 *   2. A real-sandbox section, gated on two independent things in order:
 *      first `resolveModel()` (no model configured → setup instructions +
 *      clean `exit(0)`); then, only if a model *is* configured, `E2B_API_KEY`
 *      (see .env.template's E2B section) — missing it prints setup
 *      instructions and returns cleanly, **before** any sandbox or model call
 *      is made. Both configured: creates a real E2B sandbox, wires it through
 *      `e2bWorkspace()` into a session, asks the model to write and verify a
 *      file, then `sandbox.kill()`s it. This repo's checkout has no E2B
 *      credentials, so this section is expected to stop at the guidance
 *      message — the real-sandbox path compiles and reads correctly but is
 *      untested end-to-end here; results get backfilled into docs/plans/verification.md once a
 *      user supplies E2B_API_KEY.
 */
import { createSession, defineAgent } from "@runko/sdk";
import { e2bWorkspace } from "@runko/sandbox-e2b";
import type { E2bEntryInfo, E2bSandboxLike } from "@runko/sandbox-e2b";
import { Sandbox } from "e2b";
import { resolveModel } from "./shared/model.ts";

/**
 * A few-dozen-line in-process fake satisfying `E2bSandboxLike` — no network,
 * no "e2b" import. Only supports what this demo exercises (single-level
 * `list`, no recursive glob, no simulated failures); see
 * `packages/sandbox-e2b/test/helpers.ts` for the fuller fake the package's
 * own contract tests use.
 */
function createFakeSandbox(): E2bSandboxLike {
  const files = new Map<string, { data: Uint8Array; modifiedTime: Date }>();
  const dirs = new Set<string>(["/", "/home/user"]);

  function dirnameOf(path: string): string {
    const idx = path.lastIndexOf("/");
    return idx <= 0 ? "/" : path.slice(0, idx);
  }
  function basenameOf(path: string): string {
    return path.slice(path.lastIndexOf("/") + 1);
  }
  function notFound(path: string): Error {
    return Object.assign(new Error(`no such file or directory: ${path}`), { name: "FileNotFoundError" });
  }

  return {
    files: {
      async read(path) {
        const file = files.get(path);
        if (file === undefined) {throw notFound(path);}
        return file.data;
      },
      async write(path, data) {
        dirs.add(dirnameOf(path));
        const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
        files.set(path, { data: bytes, modifiedTime: new Date() });
        return { name: basenameOf(path), path };
      },
      async list(path, opts) {
        void opts; // demo fake always lists one level, matching the default depth
        const entries: E2bEntryInfo[] = [];
        for (const [p, f] of files) {if (dirnameOf(p) === path) {entries.push({ name: basenameOf(p), type: "file", path: p, size: f.data.byteLength, modifiedTime: f.modifiedTime });}}
        for (const d of dirs) {if (d !== path && dirnameOf(d) === path) {entries.push({ name: basenameOf(d), type: "dir", path: d, size: 0 });}}
        return entries;
      },
      async remove(path) {
        files.delete(path);
        dirs.delete(path);
      },
      async makeDir(path) {
        const existed = dirs.has(path);
        dirs.add(path);
        return !existed;
      },
      async getInfo(path) {
        const file = files.get(path);
        if (file !== undefined) {return { name: basenameOf(path), type: "file", path, size: file.data.byteLength, modifiedTime: file.modifiedTime };}
        if (dirs.has(path)) {return { name: basenameOf(path), type: "dir", path, size: 0 };}
        throw notFound(path);
      },
    },
    commands: {
      async run(command, opts) {
        opts?.onStdout?.(`$ ${command}\n`);
        return { exitCode: 0, stdout: `ran: ${command}\n`, stderr: "" };
      },
    },
  };
}

async function deterministicSection(): Promise<void> {
  console.log("--- 1. a fake sandbox behind the E2bSandboxLike structural interface (BYO instance, no real e2b) ---");

  const workspace = e2bWorkspace(createFakeSandbox());
  console.log("describe():\n" + workspace.describe?.());

  await workspace.writeFile("/notes.txt", "hello from the fake e2b sandbox\n");
  const bytes = await workspace.readFile("/notes.txt");
  console.log("\nreadFile(/notes.txt) ->", new TextDecoder().decode(bytes));

  const result = await workspace.exec({ command: "cat notes.txt", cwd: "/", signal: new AbortController().signal });
  console.log("\nexec(\"cat notes.txt\") ->", result);
}

async function realSandboxSection(): Promise<void> {
  const model = resolveModel(); // no model configured anywhere -> prints setup instructions and exit(0)

  console.log("\n--- 2. a real E2B sandbox, driven by the model ---");

  const apiKey = process.env.E2B_API_KEY?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    console.log(
      "[runko example] E2B_API_KEY is not set — skipping the real-sandbox section.\n" +
        "Get a free API key at https://e2b.dev (Dashboard -> API Keys) and set it in the repo-root .env " +
        '(see the "E2B" section of .env.template) or export it directly. No sandbox is created ' +
        "and no model call is made when this variable is missing.",
    );
    return;
  }

  const sandbox = await Sandbox.create();
  try {
    const workspace = e2bWorkspace(sandbox);
    const agent = defineAgent({ model });
    const session = createSession(agent, { workspace });

    const result = await session.send(
      "用 write-file 在 /notes.txt 写一句问候语，然后用 bash 执行 `cat notes.txt`（相对路径，不要写成 /notes.txt）验证内容与写入的一致。",
    );
    console.log("finalResponse:", result.finalResponse);
  } finally {
    await sandbox.kill();
  }
}

await deterministicSection();
await realSandboxSection();
