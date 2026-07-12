#!/usr/bin/env node
/**
 * One-time local setup for examples/: creates `examples/node_modules` with
 * symlinks to the workspace packages (`@nimbo/sdk` and friends) plus `zod`
 * and `ai`, so the example scripts can `import ... from "@nimbo/sdk"` with
 * plain Node module resolution.
 *
 * Why this script exists instead of `pnpm install`: examples/ is
 * deliberately *not* listed in the root `pnpm-workspace.yaml` (see
 * examples/README.md "why examples/ isn't a workspace package") — this
 * script hand-rolls the same symlink layout pnpm would have produced had it
 * been a workspace member, using only `node:fs`, no package manager
 * involved. It never touches `pnpm-lock.yaml` or any other package's
 * `node_modules`, and everything it creates lives under
 * `examples/node_modules`, which is already covered by the repo's root
 * `.gitignore` (`node_modules/` with no leading slash matches at any depth)
 * — nothing it does is ever committed.
 *
 * Safe to re-run: existing correct symlinks are left alone, nothing outside
 * `examples/node_modules` is touched.
 *
 * Usage: `node examples/setup-node-modules.mjs`
 */
import { existsSync, mkdirSync, readlinkSync, symlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const examplesDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(examplesDir, "..");

/** { linkPath relative to examples/node_modules, target relative to repo root } */
const LINKS = [
  { link: "@nimbo/sdk", target: "packages/sdk" },
  { link: "@nimbo/core", target: "packages/core" },
  { link: "@nimbo/virtual-fs", target: "packages/virtual-fs" },
  { link: "@nimbo/mini-bash", target: "packages/mini-bash" },
  // @nimbo/just-bash (P9-2) is deliberately NOT re-exported by @nimbo/sdk
  // (docs/02-tech-spec.md §4.5b "包关系" — its dependency tree carries
  // optional wasm bits the sdk's batteries-included default shouldn't force
  // on every consumer), so 08-just-bash.ts imports it directly and it needs
  // its own top-level link here, same as @nimbo/mini-bash above.
  { link: "@nimbo/just-bash", target: "packages/just-bash" },
  // zod/ai aren't hoisted to the repo root (this monorepo doesn't declare them
  // as root devDependencies) — packages/sdk/node_modules already resolved
  // them once via its own peer/dev dependencies, so we link through it.
  { link: "zod", target: "packages/sdk/node_modules/zod" },
  { link: "ai", target: "packages/sdk/node_modules/ai" },
  // just-bash (the vercel-labs runtime, @nimbo/just-bash's own dependency) —
  // link through packages/just-bash/node_modules the same way, rather than
  // through the sdk: it's a dependency of that package specifically, not of
  // the sdk. Its own transitive deps (sql.js/quickjs-emscripten etc.)
  // resolve on their own once Node follows this symlink to the real pnpm
  // store location, which already has its isolated node_modules — nothing
  // else to hand-link.
  { link: "just-bash", target: "packages/just-bash/node_modules/just-bash" },
  // examples-only provider (P8-1c, shared/model.ts's deepseek path) — not used by any
  // package's own src, declared as a plain devDependency of packages/sdk (not the
  // shared catalog, since nothing else in the workspace consumes it) purely so it lands
  // in a node_modules this script can link through, same as zod/ai above.
  { link: "@ai-sdk/deepseek", target: "packages/sdk/node_modules/@ai-sdk/deepseek" },
  // P10 sandbox adapter packages — like @nimbo/just-bash, none of them is
  // re-exported by @nimbo/sdk (docs/06 §8: optional heavy-ish integrations,
  // installed explicitly), so examples 09/10/11 import them directly.
  { link: "@nimbo/sandbox-e2b", target: "packages/sandbox-e2b" },
  { link: "@nimbo/sandbox-vercel", target: "packages/sandbox-vercel" },
  { link: "@nimbo/sandbox-cloudflare", target: "packages/sandbox-cloudflare" },
  // Provider SDKs the examples use to create the BYO sandbox instance
  // (docs/06 §8.2: the adapters themselves never import these at runtime —
  // the *host*, here the example script, creates the sandbox and hands it
  // over). They are devDependencies of the adapter packages, so link
  // through those node_modules, same pattern as just-bash above.
  // (@cloudflare/sandbox has no entry here on purpose: it can only load
  // inside workerd — the gateway template at examples/cloudflare-gateway/
  // installs it itself, and example 11 talks plain HTTP to the deployed
  // gateway instead.)
  { link: "e2b", target: "packages/sandbox-e2b/node_modules/e2b" },
  { link: "@vercel/sandbox", target: "packages/sandbox-vercel/node_modules/@vercel/sandbox" },
];

function ensureSymlink(linkAbs, targetAbs) {
  if (existsSync(linkAbs)) {
    const isCorrectLink = (() => {
      try {
        // resolve() handles both relative and absolute link targets.
        return resolve(dirname(linkAbs), readlinkSync(linkAbs)) === resolve(targetAbs);
      } catch {
        return false; // not a symlink (e.g. a real directory) — leave it alone, don't clobber.
      }
    })();
    if (isCorrectLink) {
      console.log(`ok      ${linkAbs.replace(repoRoot + "/", "")}`);
      return;
    }
    console.log(`skip    ${linkAbs.replace(repoRoot + "/", "")} (exists, not our symlink — remove it manually to reset)`);
    return;
  }
  mkdirSync(dirname(linkAbs), { recursive: true });
  // Relative link target: the layout survives the repo being checked out at a
  // different absolute path (e.g. another machine or a moved clone).
  symlinkSync(relative(dirname(linkAbs), targetAbs), linkAbs, "dir");
  console.log(`created ${linkAbs.replace(repoRoot + "/", "")} -> ${targetAbs.replace(repoRoot + "/", "")}`);
}

if (!existsSync(join(repoRoot, "packages", "sdk", "node_modules", "zod"))) {
  console.error(
    'packages/sdk/node_modules/zod is missing — run "pnpm install" (and "pnpm -r build" for the ' +
      "example scripts' bare-specifier imports of @nimbo/sdk to resolve real dist output) at the repo root first.",
  );
  process.exit(1);
}

for (const { link, target } of LINKS) {
  ensureSymlink(join(examplesDir, "node_modules", link), join(repoRoot, target));
}
