/**
 * Shared helper for every script in examples/: resolve a model from the
 * environment instead of hardcoding one, and exit *cleanly* — not crash —
 * when nothing is configured. Each example is split into two parts:
 *
 *   1. A deterministic section that needs no network access and no model —
 *      it exercises nimbo's VirtualFS/NimboExec/skills mechanics directly
 *      and always prints the same shape of output.
 *   2. A model-driven section (the actual agent loop) that requires a model
 *      to be configured. Without one, `resolveModel()` prints setup
 *      instructions and calls `process.exit(0)` — a missing API key is a
 *      normal "not configured yet" state for a demo script, not a failure.
 *
 * Two independent ways to configure a model (P8-1c added the first; the
 * second is the original path), tried in this order:
 *
 *   1. **DeepSeek direct**: `the repo-root .env` (gitignored, never committed —
 *      see .gitignore's bare `.env` pattern) holding `DEEPSEEK_API_BASE_URL`
 *      + `DEEPSEEK_API_TOKEN`. Loaded via Node's built-in
 *      `process.loadEnvFile` — no third-party dotenv dependency. A variable
 *      already present in `process.env` (e.g. shell-exported) is never
 *      overwritten by the file's value; that's `loadEnvFile`'s own behavior
 *      (verified empirically: `FOO=already_set node --...` + a `.env` with
 *      `FOO=from_file` leaves `process.env.FOO` as `"already_set"`), not
 *      something re-implemented here. Both variables must be set and
 *      non-empty for this path to activate — either missing falls through
 *      to path 2, treated the same as neither being configured. The model
 *      id defaults to `"deepseek-chat"`; set `NIMBO_MODEL` to override it
 *      (e.g. `"deepseek-reasoner"`) when this path is the one that ends up
 *      active. Note the overload: here `NIMBO_MODEL` means a bare DeepSeek
 *      model id, not a gateway `"provider/model"` string as it does for
 *      path 2 below — the two paths are mutually exclusive per run (the
 *      DeepSeek vars being present is what decides which reading applies),
 *      so this isn't ambiguous in practice, just worth knowing.
 *   2. **AI SDK Gateway string**: `LanguageModel` (the type
 *      `AgentDefinition.model` expects, re-exported transitively from the
 *      `ai` package) is a union that already includes plain strings — an AI
 *      SDK Gateway model id such as `"anthropic/claude-sonnet-5"` is a
 *      first-class `LanguageModel` value, no provider package required (see
 *      docs/tech/core-sdk.md §4.3 and the root README's five-line example).
 *      Requires `NIMBO_MODEL` + `AI_GATEWAY_API_KEY`.
 *
 * Neither path configured → setup instructions covering both, then a clean
 * exit.
 *
 * Prefer a different provider entirely (e.g. `@ai-sdk/anthropic`)? Edit
 * `resolveModel()`'s body directly — nimbo's `AgentDefinition.model` accepts
 * any AI SDK `LanguageModel`; the two paths above are just the
 * zero-extra-setup options these examples default to.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LanguageModel } from "ai";
import { createDeepSeek } from "@ai-sdk/deepseek";

const SETUP_INSTRUCTIONS = `
[nimbo example] No model configured — skipping the model-driven part of this example.

To run it against DeepSeek directly:

  Create the repo-root .env (gitignored, never committed) with:
    DEEPSEEK_API_BASE_URL=https://your-deepseek-endpoint/v1
    DEEPSEEK_API_TOKEN=...
  Optionally: export NIMBO_MODEL="deepseek-reasoner"   # overrides the default "deepseek-chat"

...or run it against the AI SDK Gateway:

  export NIMBO_MODEL="anthropic/claude-sonnet-5"   # any AI SDK Gateway model id
  export AI_GATEWAY_API_KEY="..."                  # https://vercel.com/ai-gateway

...or edit examples/shared/model.ts to construct a provider instance directly
(e.g. import { anthropic } from "@ai-sdk/anthropic") if you'd rather not use
either of the above. See examples/README.md for the full list of env vars.
`.trim();

const DEEPSEEK_DEFAULT_MODEL_ID = "deepseek-chat";

/**
 * `process.loadEnvFile`'s thrown value is `unknown` at the catch boundary
 * (TS's `useUnknownInCatchVariables`) — this narrows just enough to tell
 * "file doesn't exist" (expected: the root .env is optional, most checkouts
 * won't have one) from any other failure (unexpected: a malformed file or a
 * permission error should surface, not be silently swallowed). Isolated
 * here as the one place this module touches an unnarrowed catch value —
 * same controlled pattern as `describeError` in packages/core/src/loop.ts.
 */
function isEnoentError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * Loads the repo-root `.env` if present; a no-op (not an error) if it doesn't
 * exist. All config was consolidated into the single root `.env` on
 * 2026-07-12 (there is no longer a separate examples/.env) — see
 * `<repo>/.env.template`.
 */
function loadRootDotEnv(): void {
  // shared/ -> src/ -> examples/ -> repo root
  const dotEnvPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    ".env",
  );
  try {
    process.loadEnvFile(dotEnvPath);
  } catch (error) {
    if (!isEnoentError(error)) throw error;
  }
}

/** DeepSeek direct path (see header comment, point 1) — `undefined` when not configured. */
function resolveDeepSeekModel(): LanguageModel | undefined {
  const baseURL = process.env.DEEPSEEK_API_BASE_URL?.trim();
  const apiKey = process.env.DEEPSEEK_API_TOKEN?.trim();
  if (baseURL === undefined || baseURL.length === 0 || apiKey === undefined || apiKey.length === 0) {
    return undefined;
  }

  const deepseek = createDeepSeek({ baseURL, apiKey });
  const modelId = process.env.NIMBO_MODEL?.trim();
  return deepseek(modelId === undefined || modelId.length === 0 ? DEEPSEEK_DEFAULT_MODEL_ID : modelId);
}

/** AI SDK Gateway path (see header comment, point 2) — `undefined` when not configured. */
function resolveGatewayModel(): LanguageModel | undefined {
  const spec = process.env.NIMBO_MODEL;
  if (spec === undefined || spec.trim().length === 0) return undefined;
  return spec;
}

/**
 * Returns the configured model, or exits the process cleanly (code 0) after
 * printing setup instructions. Never throws — an unconfigured demo is not a
 * bug in the example.
 */
export function resolveModel(): LanguageModel {
  loadRootDotEnv();

  const model = resolveDeepSeekModel() ?? resolveGatewayModel();
  if (model !== undefined) return model;

  console.log(SETUP_INSTRUCTIONS);
  process.exit(0);
}
