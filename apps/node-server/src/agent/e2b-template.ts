/**
 * The [沙盒模板](../../../../docs/terms.md) the chat server's E2B provider
 * creates sandboxes from (docs/tech/sandbox-provider.md §5).
 *
 * E2B fixes CPU/RAM at **template build time** — `Sandbox.create` has no
 * memory knob at all (`SandboxOpts` only carries template / timeout /
 * lifecycle / envs / metadata). E2B's stock `base` template hands out 2 vCPU
 * and **512 MiB**, and 512 MiB is not enough to run `npm install` on a real
 * repo (the kernel OOM-kills it), so the server runs on a template we build
 * ourselves from the *same* base image with only the memory raised:
 *
 *     pnpm --filter @nimbo-chat/node-server e2b:template
 *
 * All three knobs come from env with the constants below as defaults, but they
 * are read at **two different times**, and conflating them is the trap here:
 *
 * - `E2B_TEMPLATE` (the name) is read on every `Sandbox.create` — change it and
 *   the next sandbox uses it.
 * - `E2B_TEMPLATE_MEMORY_MB` / `E2B_TEMPLATE_CPU_COUNT` are read **only by the
 *   build script**, because that is the only moment E2B lets anyone set them.
 *   Changing them without re-running the build changes nothing at all.
 *
 * Until that build has run, creating an E2B sandbox fails with a
 * template-not-found error from E2B.
 */

/** Default template name — what `scripts/build-e2b-template.ts` publishes and `Sandbox.create` asks for. */
export const DEFAULT_E2B_TEMPLATE_NAME = 'nimbo-chat-base';

/** Default memory, raised from base's 512 MiB — `npm install` on a real repo OOMs at 512. */
export const DEFAULT_E2B_TEMPLATE_MEMORY_MB = 1024;

/** Default vCPU count — unchanged from E2B base's own default; only memory was the problem. */
export const DEFAULT_E2B_TEMPLATE_CPU_COUNT = 2;

/**
 * Parses a positive-integer env var for the template spec.
 *
 * Unlike `resolveIdleTimeoutMs`, a malformed value throws instead of silently
 * falling back: these two feed a one-shot build, so a typo'd `4O96` would
 * quietly publish a 1 GiB template that *looks* like the 4 GiB you asked for
 * and only shows up as an OOM weeks later. Failing the build is cheap; a
 * silently wrong template is not.
 */
function resolvePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw.length === 0) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid ${name}="${raw}" — expected a positive integer (e.g. ${String(fallback)}). Fix it in .env or unset it to use the default.`,
    );
  }
  return parsed;
}

/**
 * Which template to create sandboxes from (`E2B_TEMPLATE`, default
 * `nimbo-chat-base`). Also the escape hatch back to stock `base` or to a
 * differently-sized variant without a code change. Read lazily, same "never
 * read env at import time" discipline as `model.ts` / `github-repo.ts`.
 */
export function resolveE2bTemplate(): string {
  const raw = process.env.E2B_TEMPLATE?.trim();
  return raw === undefined || raw.length === 0 ?
      DEFAULT_E2B_TEMPLATE_NAME
    : raw;
}

/** Memory baked into the template at build time (`E2B_TEMPLATE_MEMORY_MB`, default 1024). Build-script only — see the file header. */
export function resolveE2bTemplateMemoryMB(): number {
  return resolvePositiveIntEnv(
    'E2B_TEMPLATE_MEMORY_MB',
    DEFAULT_E2B_TEMPLATE_MEMORY_MB,
  );
}

/** vCPU count baked into the template at build time (`E2B_TEMPLATE_CPU_COUNT`, default 2). Build-script only — see the file header. */
export function resolveE2bTemplateCpuCount(): number {
  return resolvePositiveIntEnv(
    'E2B_TEMPLATE_CPU_COUNT',
    DEFAULT_E2B_TEMPLATE_CPU_COUNT,
  );
}
