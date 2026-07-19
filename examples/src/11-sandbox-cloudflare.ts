/**
 * 11-sandbox-cloudflare — the third "BYO cloud sandbox" example (see 09's
 * header for the shared background: docs/tech/sandbox.md
 * §8, docs/plans/core-sdk.md P10). Cloudflare Sandbox is architecturally
 * different from E2B/Vercel: it can only be *accessed* from inside a
 * Cloudflare Worker (a Durable Object binding), so "agent runs on any Node
 * machine" (this repo's whole premise) requires a small **gateway** —
 * `@nimbo/sandbox-cloudflare/worker`'s `createSandboxGateway()` — deployed to
 * the host's own Cloudflare account, translating a plain HTTP+NDJSON protocol
 * into real `@cloudflare/sandbox` calls. `examples/cloudflare-gateway-ref/` is a
 * reference implementation of that gateway (~15 lines + wrangler.jsonc +
 * Dockerfile) — bring your own CF account and copy it into your own wrangler
 * project to deploy (see its own README).
 *
 * `@nimbo/sandbox-cloudflare` is, like the other two adapters, **not**
 * re-exported by `@nimbo/sdk` — install it explicitly (`pnpm add
 * @nimbo/sandbox-cloudflare`; note there's no provider SDK to add on the
 * client side — see below).
 *
 * Two entry points, two different "no runtime import" stories (docs/tech/sandbox.md §8.1/
 * §8.2):
 *   - `.` (this script's `cloudflareWorkspace`, runs on **any** Node ≥20):
 *     a pure `fetch` client — it never imports `@cloudflare/sandbox` (that
 *     package can only load inside workerd), so, unlike 09/10, there is no
 *     provider SDK to install on the client side at all — just a URL, a
 *     token, and plain HTTP;
 *   - `./worker` (`createSandboxGateway`, runs **inside** the host's own
 *     wrangler project — see `examples/cloudflare-gateway-ref/index.ts`):
 *     translates the wire protocol into calls against `CfSandboxLike`, a
 *     structural subset of `@cloudflare/sandbox`'s `ISandbox`.
 *
 * The deterministic section below is the interesting one for this adapter:
 * because both ends of the protocol are plain functions, the *entire*
 * client → gateway → sandbox round trip can run **in one Node process, with
 * zero deployment** — `createSandboxGateway({ token, getSandbox: () =>
 * fakeSandbox })` wired directly to `cloudflareWorkspace({ url, token, fetch:
 * <a fetch that hands requests straight to gateway.fetch() instead of going
 * over the network> })`. Every byte still goes through the real zod-validated
 * JSON wire format and the real NDJSON exec stream parser — only the TCP/HTTP
 * transport is skipped.
 *
 * Known, as-documented limitations (the adapter's own `describe()` / docs/03
 * P10-3 "实际改动" 裁量 ①⑤ / "验收备注（三家通用观察）"):
 *   - **path anchoring is implicit and gateway-side, with no `root` option**:
 *     unlike E2B/Vercel (client-side `opts.root`), the Cloudflare gateway
 *     anchors the virtual root `/` at the *sandbox's own default working
 *     directory* by stripping the leading `/` off virtual paths server-side
 *     — there is nothing to configure. The side effect: a bash command with
 *     a *leading-slash* absolute path (`cat /notes.txt`) lands on the
 *     sandbox's real filesystem root, not the workspace root, and misses a
 *     file the file tools just wrote — same "real FS + root anchor" trait as
 *     09/10, just with the anchor hidden inside the gateway instead of a
 *     client option. The model instruction below asks for a relative bash
 *     path for this reason;
 *   - `readdir`/`stat` report `"file"` for symlinks and any other
 *     non-regular entry — there's no "reference" concept in a real sandbox
 *     filesystem;
 *   - `mtime` is the container's real file modification time, commonly
 *     second-level precision (not the millisecond precision `MemoryFS`
 *     gives);
 *   - each NimboFS file-tool call is one HTTP round trip through the gateway
 *     (tens to hundreds of ms) — prefer a single bash command
 *     (`find`/`grep`) for scan-heavy work over many individual `glob`/
 *     `read-file` calls.
 *
 * Run: `node examples/11-sandbox-cloudflare.ts` (see examples/README.md for
 * setup; see examples/cloudflare-gateway-ref/README.md to deploy the real
 * gateway).
 *
 * Expected output shape:
 *   1. A deterministic section (no model, no env vars, no network, no
 *      deployment): the full client → gateway → fake-sandbox round trip
 *      described above, printing `describe()`, one `exec()` call, and one
 *      `writeFile`/`readFile` round trip.
 *   2. A real-gateway section, gated in order: first `resolveModel()` (no
 *      model configured anywhere → setup instructions + clean `exit(0)`);
 *      then, only if a model *is* configured, both `NIMBO_CF_GATEWAY_URL`
 *      and `NIMBO_CF_GATEWAY_TOKEN` (see .env.template's
 *      "Cloudflare Sandbox gateway" section and
 *      examples/cloudflare-gateway-ref/README.md for how to deploy and obtain
 *      them) — either missing prints setup instructions and returns cleanly,
 *      **before** any HTTP request or model call is made. This repo's
 *      checkout has no deployed gateway, so this section is expected to stop
 *      at the guidance message — the real-gateway path compiles and reads
 *      correctly but is untested end-to-end here; results get backfilled
 *      into docs/plans/verification.md once a user deploys the gateway and supplies the two
 *      variables. Note there is no `Sandbox`-style SDK object to create or
 *      tear down here (unlike 09/10): the sandbox's lifecycle is owned by
 *      the host's wrangler project, not by this client.
 */
import { createSession, defineAgent } from "@nimbo/sdk";
import { cloudflareWorkspace } from "@nimbo/sandbox-cloudflare";
import { createSandboxGateway } from "@nimbo/sandbox-cloudflare/worker";
import type { CfSandboxLike } from "@nimbo/sandbox-cloudflare/worker";
import { resolveModel } from "./shared/model.ts";

/**
 * A few-dozen-line in-process fake satisfying `CfSandboxLike` — no network,
 * no "@cloudflare/sandbox" import (that package can't even load outside
 * workerd). Only supports what this demo exercises; see
 * `packages/sandbox-cloudflare/test/helpers.ts` for the fuller fake the
 * package's own contract tests use.
 */
function createFakeSandbox(): CfSandboxLike {
  const files = new Map<string, Uint8Array>();

  return {
    async exec(command, options = {}) {
      const start = Date.now();
      const text = `ran: ${command}\n`;
      options.onOutput?.("stdout", text);
      return { exitCode: 0, stdout: text, stderr: "", duration: Date.now() - start };
    },
    async readFile(path) {
      const data = files.get(path);
      if (data === undefined) throw new Error(`no such file: ${path}`);
      return { content: Buffer.from(data).toString("base64") };
    },
    async writeFile(path, content) {
      files.set(path, Buffer.from(content, "base64"));
      return { success: true };
    },
    async mkdir() {
      return { success: true }; // demo never lists directories, so a real tree isn't needed
    },
    async deleteFile(path) {
      files.delete(path);
      return { success: true };
    },
    async listFiles() {
      return { files: [] }; // not exercised by this demo's write/read/exec round trip
    },
  };
}

async function deterministicSection(): Promise<void> {
  console.log("--- 1. client -> gateway -> fake sandbox, all in one process, zero deployment ---");

  const token = "demo-token";
  const sandbox = createFakeSandbox();
  const gateway = createSandboxGateway({ token, getSandbox: () => sandbox });
  const workspace = cloudflareWorkspace({
    url: "http://gateway.local",
    token,
    // Hands requests directly to the in-process gateway instead of a real
    // network call — the same technique packages/sandbox-cloudflare's own
    // e2e tests use (test/helpers.ts's fetchViaGateway).
    fetch: async (input, init) => gateway.fetch(new Request(input, init)),
  });

  console.log("describe():\n" + workspace.describe?.());

  await workspace.writeFile("/notes.txt", "hello from the in-process gateway demo\n");
  const bytes = await workspace.readFile("/notes.txt");
  console.log("\nreadFile(/notes.txt) ->", new TextDecoder().decode(bytes));

  const result = await workspace.exec({ command: "cat notes.txt", cwd: "/", signal: new AbortController().signal });
  console.log("\nexec(\"cat notes.txt\") ->", result);
}

async function realGatewaySection(): Promise<void> {
  const model = resolveModel(); // no model configured anywhere -> prints setup instructions and exit(0)

  console.log("\n--- 2. a real, deployed Cloudflare Sandbox gateway, driven by the model ---");

  const url = process.env.NIMBO_CF_GATEWAY_URL?.trim();
  const token = process.env.NIMBO_CF_GATEWAY_TOKEN?.trim();
  if (url === undefined || url.length === 0 || token === undefined || token.length === 0) {
    console.log(
      "[nimbo example] NIMBO_CF_GATEWAY_URL/NIMBO_CF_GATEWAY_TOKEN are not fully set — skipping the real-gateway section.\n" +
        "Stand up your own gateway first, using examples/cloudflare-gateway-ref/ as reference (see that directory's README — Workers Paid plan required, no " +
        'free tier), then fill both values in per the "Cloudflare Sandbox gateway" section of ' +
        ".env.template. No HTTP request is made and no model call happens while either is missing.",
    );
    return;
  }
  const sandboxId = process.env.NIMBO_CF_SANDBOX_ID?.trim();

  // No SDK, no create()/kill() — the gateway's `getSandbox()` wiring (see
  // examples/cloudflare-gateway-ref/index.ts) owns the sandbox's lifecycle.
  const workspace = cloudflareWorkspace({
    url,
    token,
    ...(sandboxId !== undefined && sandboxId.length > 0 ? { sandboxId } : {}),
  });
  const agent = defineAgent({ model });
  const session = createSession(agent, { workspace });

  const result = await session.send(
    "用 write-file 在 /notes.txt 写一句问候语，然后用 bash 执行 `cat notes.txt`（相对路径，不要写成 /notes.txt）验证内容与写入的一致。",
  );
  console.log("finalResponse:", result.finalResponse);
}

await deterministicSection();
await realGatewaySection();
