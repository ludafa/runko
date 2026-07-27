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
  /** 每次 `ensureLifetime()` 记一条会话 id（旧名 touchCalls，随主术语改名）。 */
  readonly ensureLifetimeCalls: string[];
  readonly releaseCalls: string[];
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
  /**
   * 设了就让**下一次** `acquire()` 挂在这个 promise 上（resolve 之后才返回沙盒），用完
   * 即清。用来撑开[起轮装配](../../../../docs/terms.md)窗口——测试要在这段时间里对同一个
   * 会话做别的请求（按[停止](../../../../docs/terms.md)、再发一条消息），
   * 见 docs/tech/turn-abort.md §3.3。
   *
   * `acquireCalls` 仍在挂住**之前**就记上，所以测试可以靠它确认「装配已经进去了」。
   */
  nextAcquireGate?: Promise<void>;
}

export function createFakeSandboxManager(
  opts: { defaultBranch?: string } = {},
): FakeSandboxManager {
  const acquireCalls: AcquireInput[] = [];
  const ensureLifetimeCalls: string[] = [];
  const releaseCalls: string[] = [];
  const workspacePromise = buildFakeWorkspace();

  const manager: FakeSandboxManager = {
    acquireCalls,
    ensureLifetimeCalls,
    releaseCalls,
    nextResumeToken: undefined,
    nextAcquireMode: undefined,
    nextAcquireGate: undefined,
    async acquire(input: AcquireInput): Promise<AcquiredSandbox> {
      acquireCalls.push(input);
      const gate = manager.nextAcquireGate;
      manager.nextAcquireGate = undefined;
      if (gate !== undefined) await gate; // 撑开起轮装配窗口——见 `nextAcquireGate`
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
    async ensureLifetime(conversationId: string): Promise<void> {
      ensureLifetimeCalls.push(conversationId);
    },
    release(conversationId: string): void {
      releaseCalls.push(conversationId);
    },
  };
  return manager;
}
