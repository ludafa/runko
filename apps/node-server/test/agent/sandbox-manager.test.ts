import type {
  VercelFileSystemLike,
  VercelSandboxLike,
} from '@nimbo/sandbox-vercel';
import { vercelWorkspace } from '@nimbo/sandbox-vercel';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  AcquireInput,
  CreateSandboxParams,
  ProvisionedSandbox,
  ResumeResult,
  SandboxProvider,
} from '../../src/agent/sandbox-manager.js';
import {
  createSandboxManager,
  resolveDefaultProvider,
} from '../../src/agent/sandbox-manager.js';

// ---------------------------------------------------------------------------
// A structurally-injected fake SandboxProvider (no @vercel/sandbox import, no
// network) — same style as examples/10/12's fakes. The underlying fake
// `VercelSandboxLike` is wrapped by the *real* `vercelWorkspace()` adapter, so
// tests exercise the actual NimboExec→runCommand path. `runCommand` records
// every script it was asked to run (so tests can assert exactly what
// sandbox-manager.ts did/skipped) and special-cases `git symbolic-ref` to
// answer with a stubbed default-branch ref.
// ---------------------------------------------------------------------------

function rejectingFs(): VercelFileSystemLike {
  const notUsed = (): Promise<never> =>
    Promise.reject(new Error('fs not used by sandbox-manager tests'));
  return {
    readFile: notUsed,
    writeFile: notUsed,
    mkdir: notUsed,
    readdir: notUsed,
    stat: notUsed,
    rm: notUsed,
    rmdir: notUsed,
  };
}

interface FakeProvisioned extends ProvisionedSandbox {
  readonly commands: string[];
  readonly extendIdleCalls: number[];
  /** 设成一个 Error 后，之后每次 `extendIdle` 都抛它——模拟「句柄背后的沙盒已经没了」。 */
  extendIdleError?: Error;
}

function createFakeProvisioned(
  name: string,
  exitCodeFor: (script: string) => number = () => 0,
): FakeProvisioned {
  const commands: string[] = [];
  const extendIdleCalls: number[] = [];
  const sandbox: VercelSandboxLike = {
    fs: rejectingFs(),
    async runCommand(params) {
      const script = params.args?.[1] ?? '';
      commands.push(script);
      if (script.includes('git symbolic-ref')) {
        params.stdout?.write('refs/remotes/origin/main\n');
        return { exitCode: 0 };
      }
      return { exitCode: exitCodeFor(script) };
    },
  };
  const provisioned: FakeProvisioned = {
    workspace: vercelWorkspace(sandbox),
    resumeToken: name,
    commands,
    extendIdleCalls,
    extendIdleError: undefined,
    async extendIdle(idleTimeoutMs) {
      if (provisioned.extendIdleError !== undefined)
        throw provisioned.extendIdleError;
      extendIdleCalls.push(idleTimeoutMs);
    },
  };
  return provisioned;
}

interface FakeProvider {
  provider: SandboxProvider;
  resumeCalls: string[];
  createCalls: CreateSandboxParams[];
  createdSandboxes: FakeProvisioned[];
}

/** 假 provider 的「沙盒没了」约定：`message` 含 `gone` 即算没了（不牵扯真 SDK 的错误类型）。 */
export function fakeGoneError(): Error {
  return new Error('fake sandbox is gone');
}

function createFakeProvider(opts: {
  resumeResult: (resumeToken: string) => Promise<ResumeResult>;
  exitCodeFor?: (script: string) => number;
}): FakeProvider {
  const resumeCalls: string[] = [];
  const createCalls: CreateSandboxParams[] = [];
  const createdSandboxes: FakeProvisioned[] = [];
  const provider: SandboxProvider = {
    id: 'vercel',
    async create(params) {
      createCalls.push(params);
      const provisioned = createFakeProvisioned(params.name, opts.exitCodeFor);
      createdSandboxes.push(provisioned);
      return provisioned;
    },
    async resume(resumeToken) {
      resumeCalls.push(resumeToken);
      return opts.resumeResult(resumeToken);
    },
    isGone: (error) => error instanceof Error && error.message.includes('gone'),
  };
  return { provider, resumeCalls, createCalls, createdSandboxes };
}

function acquireInput(overrides: Partial<AcquireInput> = {}): AcquireInput {
  return {
    conversationId: 'session-1',
    provider: 'vercel',
    sandboxName: 'nimbo-chat-session-1',
    resumeToken: 'nimbo-chat-session-1',
    branchName: 'nimbo/chat-session-1',
    repoCloneUrl: 'https://github.com/acme/demo.git',
    repoOwner: 'acme',
    repoName: 'demo',
    githubPat: 'test-pat',
    ...overrides,
  };
}

/** Wires the fake provider into the manager under the id the tests use ('vercel'). */
function managerWith(fake: FakeProvider, idleTimeoutMs = 1000) {
  return createSandboxManager({ vercel: fake.provider }, { idleTimeoutMs });
}

describe('sandbox-manager', () => {
  it('acquire(): resumes via SandboxProvider.resume() without re-running the init plan', async () => {
    const preExisting = createFakeProvisioned('nimbo-chat-session-1');
    const fake = createFakeProvider({
      resumeResult: async () => ({ kind: 'ok', sandbox: preExisting }),
    });
    const manager = managerWith(fake);

    const result = await manager.acquire(acquireInput());

    expect(fake.resumeCalls).toEqual(['nimbo-chat-session-1']);
    expect(fake.createCalls).toHaveLength(0);
    expect(result.defaultBranch).toBe('main');
    expect(result.resumeToken).toBe('nimbo-chat-session-1');
    // Only the default-branch detection ran — no skill install/git identity/branch checkout on the resumed path.
    expect(preExisting.commands).toEqual([
      'git symbolic-ref refs/remotes/origin/HEAD',
    ]);
    await expect(
      result.workspace.exec({
        command: 'true',
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
  });

  it('acquire(): a brand-new conversation (no resumeToken) skips resume and goes straight to create', async () => {
    const fake = createFakeProvider({
      resumeResult: async () => ({ kind: 'unavailable' }),
    });
    const manager = managerWith(fake);

    const result = await manager.acquire(
      acquireInput({ resumeToken: undefined }),
    );

    expect(fake.resumeCalls).toHaveLength(0); // never attempted — nothing to resume yet
    expect(fake.createCalls).toHaveLength(1);
    expect(result.resumeToken).toBe('nimbo-chat-session-1'); // provisioned token (= sandbox name here)
  });

  it('acquire(): (re)creates + reinstalls + recovers the branch when resume() reports unavailable (expired snapshot)', async () => {
    const fake = createFakeProvider({
      resumeResult: async () => ({ kind: 'unavailable' }),
      // Simulate a branch that was never pushed: `git fetch origin <branch>` fails, forcing the `git checkout -b` fallback.
      exitCodeFor: (script) => (script.startsWith('git fetch origin') ? 1 : 0),
    });
    const manager = managerWith(fake);

    const input = acquireInput();
    const result = await manager.acquire(input);

    expect(fake.resumeCalls).toEqual([input.resumeToken]);
    expect(fake.createCalls).toEqual([
      {
        name: input.sandboxName,
        cloneUrl: input.repoCloneUrl,
        githubPat: input.githubPat,
        timeoutMs: 1000,
      },
    ]);
    expect(result.defaultBranch).toBe('main');

    const sandbox = fake.createdSandboxes[0];
    expect(sandbox).toBeDefined();
    const commands = sandbox?.commands ?? [];
    expect(commands.some((c) => c.includes('npx -y skills add'))).toBe(true);
    expect(commands.some((c) => c.includes('git config user.name'))).toBe(true);
    expect(commands.some((c) => c.includes('git remote set-url origin'))).toBe(
      true,
    );
    expect(commands.some((c) => c.includes('.git/info/exclude'))).toBe(true);
    expect(commands).toContain('git symbolic-ref refs/remotes/origin/HEAD');
    expect(commands.some((c) => c.startsWith('git fetch origin'))).toBe(true);
    expect(commands).toContain(`git checkout -b ${input.branchName}`);
  });

  it('acquire(): recovers an already-pushed branch with fetch+checkout (no -b fallback needed)', async () => {
    const fake = createFakeProvider({
      resumeResult: async () => ({ kind: 'unavailable' }),
    }); // default exitCodeFor -> everything succeeds
    const manager = managerWith(fake);

    const input = acquireInput();
    await manager.acquire(input);

    const commands = fake.createdSandboxes[0]?.commands ?? [];
    expect(
      commands.some(
        (c) => c.startsWith('git fetch origin') && c.includes('git checkout'),
      ),
    ).toBe(true);
    expect(commands).not.toContain(`git checkout -b ${input.branchName}`);
  });

  it('acquire(): an in-process memory hit skips the provider entirely', async () => {
    const fake = createFakeProvider({
      resumeResult: async () => ({ kind: 'unavailable' }),
    });
    const manager = managerWith(fake);

    const input = acquireInput();
    await manager.acquire(input);
    expect(fake.createCalls).toHaveLength(1);
    expect(fake.resumeCalls).toHaveLength(1);

    const second = await manager.acquire(input);
    expect(fake.createCalls).toHaveLength(1); // unchanged
    expect(fake.resumeCalls).toHaveLength(1); // unchanged
    expect(second.defaultBranch).toBe('main');
  });

  it('acquire(): reports which of the three paths it took via `mode` (观测字段，docs/tech/telemetry.md §2.4)', async () => {
    // 3：resume 报 unavailable → 重建。
    const rebuilding = createFakeProvider({
      resumeResult: async () => ({ kind: 'unavailable' }),
    });
    const rebuildManager = managerWith(rebuilding);
    const input = acquireInput();
    expect((await rebuildManager.acquire(input)).mode).toBe('create');
    // 1：同一个 conversation 再来一次 → 进程内缓存命中，零远程调用。
    expect((await rebuildManager.acquire(input)).mode).toBe('cache');

    // 2：resume 成功。
    const resuming = createFakeProvider({
      resumeResult: async () => ({
        kind: 'ok',
        sandbox: createFakeProvisioned('nimbo-chat-session-1'),
      }),
    });
    expect((await managerWith(resuming).acquire(input)).mode).toBe('resume');
  });

  it('touch(): extends the acquired sandbox’s idle timeout; rejects for a conversation never acquired', async () => {
    const fake = createFakeProvider({
      resumeResult: async () => ({ kind: 'unavailable' }),
    });
    const manager = managerWith(fake, 42_000);

    const input = acquireInput();
    await manager.acquire(input);
    await manager.touch(input.conversationId);

    expect(fake.createdSandboxes[0]?.extendIdleCalls).toEqual([42_000]);
    await expect(manager.touch('never-acquired')).rejects.toThrow(
      /no active sandbox/,
    );
  });

  it('release(): evicts the memory cache, forcing the next acquire() back through the provider', async () => {
    const fake = createFakeProvider({
      resumeResult: async () => ({ kind: 'unavailable' }),
    });
    const manager = managerWith(fake);

    const input = acquireInput();
    await manager.acquire(input);
    manager.release(input.conversationId);
    await manager.acquire(input);

    expect(fake.createCalls).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // SP-7 缓存失效 + 保活心跳（docs/tech/sandbox-provider.md §5.1）。
  // 底层前提：平台超时是**绝对截止时间**，跑命令不续期——所以缓存句柄会过期，
  // 长轮次需要心跳。
  // -------------------------------------------------------------------------

  it('acquire(): 缓存过了平台截止时间就不再复用，重新走 resume（SP-7 的核心修复）', async () => {
    vi.useFakeTimers();
    try {
      const fake = createFakeProvider({
        resumeResult: async () => ({ kind: 'unavailable' }),
      });
      const manager = managerWith(fake, 300_000);

      const input = acquireInput();
      await manager.acquire(input);
      expect(fake.resumeCalls).toHaveLength(1);

      // 还没到期 → 仍走缓存
      vi.setSystemTime(Date.now() + 299_000);
      await manager.acquire(input);
      expect(fake.resumeCalls).toHaveLength(1);

      // 过了截止时间 → 缓存作废，重新问 provider（修复前这里会把已失效的句柄交出去）
      vi.setSystemTime(Date.now() + 2_000);
      await manager.acquire(input);
      expect(fake.resumeCalls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('touch(): 成功保活把截止时间往后推，缓存继续有效', async () => {
    vi.useFakeTimers();
    try {
      const fake = createFakeProvider({
        resumeResult: async () => ({ kind: 'unavailable' }),
      });
      const manager = managerWith(fake, 300_000);

      const input = acquireInput();
      await manager.acquire(input);

      vi.setSystemTime(Date.now() + 200_000);
      await manager.touch(input.conversationId); // 截止时间重置为 now + 300s

      vi.setSystemTime(Date.now() + 200_000); // 距 acquire 已 400s，但距 touch 只 200s
      await manager.acquire(input);
      expect(fake.resumeCalls).toHaveLength(1); // 仍是缓存命中
    } finally {
      vi.useRealTimers();
    }
  });

  it('touch(): 抛「沙盒没了」→ 驱逐缓存（下次 acquire 重连），并把错误原样抛出', async () => {
    const fake = createFakeProvider({
      resumeResult: async () => ({ kind: 'unavailable' }),
    });
    const manager = managerWith(fake);

    const input = acquireInput();
    await manager.acquire(input);
    const sandbox = fake.createdSandboxes[0];
    expect(sandbox).toBeDefined();
    if (sandbox === undefined) return;

    sandbox.extendIdleError = fakeGoneError();
    await expect(manager.touch(input.conversationId)).rejects.toThrow(/gone/);

    // 关键断言：缓存已被驱逐，下一次 acquire 回到 provider 而不是继续用死句柄
    await manager.acquire(input);
    expect(fake.resumeCalls).toHaveLength(2);
  });

  it('touch(): 抛「不是沙盒没了」的错误时不驱逐缓存（网络抖动别把好句柄扔了）', async () => {
    const fake = createFakeProvider({
      resumeResult: async () => ({ kind: 'unavailable' }),
    });
    const manager = managerWith(fake);

    const input = acquireInput();
    await manager.acquire(input);
    const sandbox = fake.createdSandboxes[0];
    expect(sandbox).toBeDefined();
    if (sandbox === undefined) return;

    sandbox.extendIdleError = new Error('ECONNRESET');
    await expect(manager.touch(input.conversationId)).rejects.toThrow(
      /ECONNRESET/,
    );

    sandbox.extendIdleError = undefined;
    await manager.acquire(input);
    expect(fake.resumeCalls).toHaveLength(1); // 缓存还在
  });

  it('startHeartbeat(): 按 idleTimeout/2 周期保活，停止函数一停就不再打', async () => {
    vi.useFakeTimers();
    try {
      const fake = createFakeProvider({
        resumeResult: async () => ({ kind: 'unavailable' }),
      });
      const manager = managerWith(fake, 300_000);

      const input = acquireInput();
      await manager.acquire(input);
      const sandbox = fake.createdSandboxes[0];
      expect(sandbox).toBeDefined();
      if (sandbox === undefined) return;

      const stop = manager.startHeartbeat(input.conversationId);
      expect(sandbox.extendIdleCalls).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(150_000);
      expect(sandbox.extendIdleCalls).toEqual([300_000]);

      await vi.advanceTimersByTimeAsync(150_000);
      expect(sandbox.extendIdleCalls).toEqual([300_000, 300_000]);

      stop();
      await vi.advanceTimersByTimeAsync(600_000);
      expect(sandbox.extendIdleCalls).toHaveLength(2); // 停了就不再涨
    } finally {
      vi.useRealTimers();
    }
  });

  it('startHeartbeat(): 心跳里保活失败只吞掉，不冒成未处理拒绝', async () => {
    vi.useFakeTimers();
    try {
      const fake = createFakeProvider({
        resumeResult: async () => ({ kind: 'unavailable' }),
      });
      const manager = managerWith(fake, 300_000);

      const input = acquireInput();
      await manager.acquire(input);
      const sandbox = fake.createdSandboxes[0];
      expect(sandbox).toBeDefined();
      if (sandbox === undefined) return;
      sandbox.extendIdleError = fakeGoneError();

      const stop = manager.startHeartbeat(input.conversationId);
      await expect(vi.advanceTimersByTimeAsync(150_000)).resolves.not.toThrow();
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('startHeartbeat(): 停止函数可重复调用（幂等）', async () => {
    const fake = createFakeProvider({
      resumeResult: async () => ({ kind: 'unavailable' }),
    });
    const manager = managerWith(fake);
    await manager.acquire(acquireInput());

    const stop = manager.startHeartbeat('session-1');
    stop();
    expect(() => {
      stop();
    }).not.toThrow();
  });

  it('release(): 同时停掉这个会话的心跳（不留下打死句柄的定时器）', async () => {
    vi.useFakeTimers();
    try {
      const fake = createFakeProvider({
        resumeResult: async () => ({ kind: 'unavailable' }),
      });
      const manager = managerWith(fake, 300_000);

      const input = acquireInput();
      await manager.acquire(input);
      const sandbox = fake.createdSandboxes[0];
      expect(sandbox).toBeDefined();
      if (sandbox === undefined) return;

      manager.startHeartbeat(input.conversationId);
      manager.release(input.conversationId);

      await vi.advanceTimersByTimeAsync(600_000);
      expect(sandbox.extendIdleCalls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('acquire(): resume 成功后显式保活一次，让缓存的截止时间可信', async () => {
    const resumed = createFakeProvisioned('nimbo-chat-session-1');
    const fake = createFakeProvider({
      resumeResult: async () => ({ kind: 'ok', sandbox: resumed }),
    });
    const manager = managerWith(fake, 42_000);

    await manager.acquire(acquireInput());
    expect(resumed.extendIdleCalls).toEqual([42_000]);
  });

  it('acquire(): resume 回来的句柄在保活时就已经没了 → 退回 create', async () => {
    const resumed = createFakeProvisioned('nimbo-chat-session-1');
    resumed.extendIdleError = fakeGoneError();
    const fake = createFakeProvider({
      resumeResult: async () => ({ kind: 'ok', sandbox: resumed }),
    });
    const manager = managerWith(fake);

    await manager.acquire(acquireInput());
    expect(fake.createCalls).toHaveLength(1);
  });

  it('acquire(): concurrent calls for the same conversation single-flight into one resume()', async () => {
    let resolveResume: ((result: ResumeResult) => void) | undefined;
    const gate = new Promise<ResumeResult>((resolve) => {
      resolveResume = resolve;
    });
    const fake = createFakeProvider({ resumeResult: async () => gate });
    const manager = managerWith(fake);

    const input = acquireInput();
    const first = manager.acquire(input);
    const second = manager.acquire(input);

    expect(fake.resumeCalls).toHaveLength(1); // the second call joined the in-flight promise synchronously, before the gate even opened

    const sandbox = createFakeProvisioned(input.sandboxName);
    resolveResume?.({ kind: 'ok', sandbox });

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(fake.resumeCalls).toHaveLength(1);
    expect(firstResult.workspace).toBe(secondResult.workspace);
  });

  it('acquire(): throws for a provider id that is not registered', async () => {
    const fake = createFakeProvider({
      resumeResult: async () => ({ kind: 'unavailable' }),
    });
    const manager = managerWith(fake);

    await expect(
      manager.acquire(acquireInput({ provider: 'e2b' })),
    ).rejects.toThrow(/No sandbox provider registered for "e2b"/);
  });
});

describe('resolveDefaultProvider (docs/tech/sandbox-provider.md §6)', () => {
  const ORIGINAL = process.env.SANDBOX_PROVIDER;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.SANDBOX_PROVIDER;
    else process.env.SANDBOX_PROVIDER = ORIGINAL;
  });

  it('defaults to "vercel" when SANDBOX_PROVIDER is unset', () => {
    delete process.env.SANDBOX_PROVIDER;
    expect(resolveDefaultProvider()).toBe('vercel');
  });

  it('resolves "e2b" when SANDBOX_PROVIDER=e2b', () => {
    process.env.SANDBOX_PROVIDER = 'e2b';
    expect(resolveDefaultProvider()).toBe('e2b');
  });

  it('is case-insensitive and trims surrounding whitespace ("E2B", " e2b ")', () => {
    process.env.SANDBOX_PROVIDER = 'E2B';
    expect(resolveDefaultProvider()).toBe('e2b');

    process.env.SANDBOX_PROVIDER = ' e2b ';
    expect(resolveDefaultProvider()).toBe('e2b');
  });

  it('falls back to "vercel" for any other value ("foo", "Vercel", empty string)', () => {
    process.env.SANDBOX_PROVIDER = 'foo';
    expect(resolveDefaultProvider()).toBe('vercel');

    process.env.SANDBOX_PROVIDER = 'Vercel';
    expect(resolveDefaultProvider()).toBe('vercel');

    process.env.SANDBOX_PROVIDER = '';
    expect(resolveDefaultProvider()).toBe('vercel');
  });
});
