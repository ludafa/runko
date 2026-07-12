#!/usr/bin/env node
/**
 * Standalone type-check for examples/ (the P8-1 acceptance gate "examples 全部
 * tsc --noEmit 通过"). Deliberately NOT wired into the root `pnpm typecheck`:
 * that script is `pnpm -r run typecheck` over workspace members, and examples/
 * is not a workspace member (see README.md "why examples/ isn't a workspace
 * package") — hooking it in would require editing the root package.json, which
 * belongs to the workspace packages, not to the examples.
 *
 * Usage: `node examples/typecheck.mjs`   (run `pnpm -r build` and
 * `node examples/setup-node-modules.mjs` once beforehand)
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const examplesDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(examplesDir, "..");
const tscBin = join(repoRoot, "node_modules", ".bin", "tsc");

if (!existsSync(join(examplesDir, "node_modules", "@nimbo", "sdk"))) {
  console.error("examples/node_modules is not set up — run `node examples/setup-node-modules.mjs` first.");
  process.exit(1);
}

const result = spawnSync(tscBin, ["-p", join(examplesDir, "tsconfig.json")], { stdio: "inherit" });
process.exit(result.status ?? 1);
