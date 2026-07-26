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
  AcquireMode,
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
  /** 每次 `startHeartbeat` 记一条 `{conversationId, stopped}`；`stopped` 由返回的停止函数翻真，用来断言心跳没有泄漏。 */
  readonly heartbeats: { conversationId: string; stopped: boolean }[];
  /**
   * When set, the *next* `acquire()` call returns this string as
   * `resumeToken` instead of the default (`input.resumeToken ??
   * input.sandboxName`), then resets to `undefined` — lets a test simulate an
   * E2B "resume unavailable → re-create" that mints a brand-new `sandboxId`
   * on a specific acquire (docs/tech/sandbox-provider.md §3.1), so
   * `routes/chat.ts`'s POST .../messages rewrite-on-change branch can be
   * exercised without a real/fake `SandboxProvider`.
   */
  nextResumeToken?: string;
  /** 覆盖 `acquire()` 报出的 `mode`（缺省 `'resume'`）——用来断言 `turn-launcher` 把它原样写进 `turn-prepare` 载荷（docs/tech/telemetry.md §2.4）。 */
  nextAcquireMode?: AcquireMode;
}

export function createFakeSandboxManager(
  opts: { defaultBranch?: string } = {},
): FakeSandboxManager {
  const acquireCalls: AcquireInput[] = [];
  const touchCalls: string[] = [];
  const releaseCalls: string[] = [];
  const heartbeats: { conversationId: string; stopped: boolean }[] = [];
  const workspacePromise = buildFakeWorkspace();

  const manager: FakeSandboxManager = {
    acquireCalls,
    touchCalls,
    releaseCalls,
    heartbeats,
    nextResumeToken: undefined,
    nextAcquireMode: undefined,
    async acquire(input: AcquireInput): Promise<AcquiredSandbox> {
      acquireCalls.push(input);
      const resumeToken =
        manager.nextResumeToken ?? input.resumeToken ?? input.sandboxName;
      manager.nextResumeToken = undefined;
      return {
        workspace: await workspacePromise,
        defaultBranch: opts.defaultBranch ?? 'main',
        resumeToken,
        // 假件恒报 'resume'（`nextAcquireMode` 可覆盖单次）——真件的三态判定
        // 有自己的专属测试（test/agent/sandbox-manager.test.ts），这里只需要一个
        // 合法值让 `turn-launcher` 的遥测载荷有东西可填。
        mode: manager.nextAcquireMode ?? 'resume',
      };
    },
    async touch(conversationId: string): Promise<void> {
      touchCalls.push(conversationId);
    },
    release(conversationId: string): void {
      releaseCalls.push(conversationId);
    },
    startHeartbeat(conversationId: string): () => void {
      // 不真的起定时器（测试里没有需要保活的东西），只记账：谁开的、停没停。
      const record = { conversationId, stopped: false };
      heartbeats.push(record);
      return () => {
        record.stopped = true;
      };
    },
  };
  return manager;
}
