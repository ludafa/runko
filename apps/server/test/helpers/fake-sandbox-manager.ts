/**
 * A fake `SandboxManager` for `routes/chat.ts` integration tests — no
 * `@vercel/sandbox` involved at all (that state machine has its own
 * dedicated tests in test/agent/sandbox-manager.test.ts). `acquire()` always
 * hands back the same in-memory workspace (an `@nimbo/virtual-fs` `MemoryFS`
 * pre-seeded with the frontend-design `SKILL.md`, so `Skill.fromFS()`
 * succeeds, plus a trivial `NimboExec` stub — the test scenarios never
 * actually call `bash`).
 */
import type { NimboExec, NimboFS } from '@nimbo/core';
import { MemoryFS } from '@nimbo/sdk';

import type {
  AcquiredSandbox,
  AcquireInput,
  SandboxManager,
} from '../../src/agent/sandbox-manager.js';

const FRONTEND_DESIGN_SKILL_STUB = `---
description: Make one focused, non-generic visual/interaction improvement to an existing web UI without rewriting it.
---
# frontend-design (test stub)
`;

async function buildFakeWorkspace(): Promise<NimboFS & NimboExec> {
  const fs = new MemoryFS();
  await fs.writeFile(
    '/.agents/skills/frontend-design/SKILL.md',
    FRONTEND_DESIGN_SKILL_STUB,
  );
  const exec: NimboExec = {
    async exec() {
      return { exitCode: 0, stdout: '', stderr: '', durationMs: 0 };
    },
  };
  return Object.assign(fs, exec);
}

export interface FakeSandboxManager extends SandboxManager {
  readonly acquireCalls: AcquireInput[];
  readonly touchCalls: string[];
  readonly releaseCalls: string[];
}

export function createFakeSandboxManager(
  opts: { defaultBranch?: string } = {},
): FakeSandboxManager {
  const acquireCalls: AcquireInput[] = [];
  const touchCalls: string[] = [];
  const releaseCalls: string[] = [];
  const workspacePromise = buildFakeWorkspace();

  return {
    acquireCalls,
    touchCalls,
    releaseCalls,
    async acquire(input: AcquireInput): Promise<AcquiredSandbox> {
      acquireCalls.push(input);
      return {
        workspace: await workspacePromise,
        defaultBranch: opts.defaultBranch ?? 'main',
      };
    },
    async touch(sessionId: string): Promise<void> {
      touchCalls.push(sessionId);
    },
    release(sessionId: string): void {
      releaseCalls.push(sessionId);
    },
  };
}
