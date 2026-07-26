/**
 * Builds/publishes the chat server's E2B [沙盒模板](../../../docs/terms.md).
 *
 * Why this exists: E2B only lets you set CPU/RAM when *building a template* —
 * `Sandbox.create` has no memory option — and the stock `base` template's
 * 512 MiB gets `npm install` OOM-killed. This builds the very same base image
 * with the spec from `.env` (`E2B_TEMPLATE` / `E2B_TEMPLATE_MEMORY_MB` /
 * `E2B_TEMPLATE_CPU_COUNT`, defaults in `src/agent/e2b-template.ts`).
 *
 *     pnpm --filter @nimbo-chat/node-server e2b:template
 *
 * This script is the *only* consumer of the memory/CPU vars — E2B gives no
 * other moment to set them — so editing them in `.env` does nothing until this
 * runs again. One-time per E2B team otherwise; builds are idempotent
 * (re-running with the same name republishes under that name).
 */
import { defaultBuildLogger, Template } from 'e2b';

import {
  resolveE2bTemplate,
  resolveE2bTemplateCpuCount,
  resolveE2bTemplateMemoryMB,
} from '../src/agent/e2b-template.js';

const apiKey = process.env.E2B_API_KEY?.trim();
if (apiKey === undefined || apiKey.length === 0) {
  console.error(
    'Missing E2B_API_KEY — set it in .env (or the shell) before building the template.',
  );
  process.exit(1);
}

// Resolved before the build so a malformed spec fails here, loudly, rather
// than publishing a template whose size is not what .env says.
const name = resolveE2bTemplate();
const cpuCount = resolveE2bTemplateCpuCount();
const memoryMB = resolveE2bTemplateMemoryMB();

console.log(
  `Building E2B template "${name}" (${String(cpuCount)} vCPU, ${String(memoryMB)} MiB)…`,
);

// `fromBaseImage()` is exactly the image E2B's stock `base` template uses, so
// nothing inside the sandbox changes — only the resource allocation.
const info = await Template.build(Template().fromBaseImage(), name, {
  apiKey,
  cpuCount,
  memoryMB,
  onBuildLogs: defaultBuildLogger(),
});

console.log(
  `Done. Template "${name}" is live (templateId ${info.templateId}, ${String(cpuCount)} vCPU / ${String(memoryMB)} MiB). New sandboxes pick it up automatically.`,
);
