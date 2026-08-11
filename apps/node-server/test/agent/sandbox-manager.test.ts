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
import { createLogger } from '../../src/logger.js';

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
  readonly ensureLifetimeCalls: number[];
  /** 设成一个 Error 后，之后每次 `ensureLifetime` 都抛它——模拟「句柄背后的沙盒已经没了」。 */
  ensureLifetimeError?: Error;
}

function createFakeProvisioned(
  name: string,
  exitCodeFor: (script: string) => number = () => 0,
): FakeProvisioned {
  const commands: string[] = [];
  const ensureLifetimeCalls: number[] = [];
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
    ensureLifetimeCalls,
    ensureLifetimeError: undefined,
    async ensureLifetime(targetMs) {
      if (provisioned.ensureLifetimeError !== undefined)
        throw provisioned.ensureLifetimeError;
      ensureLifetimeCalls.push(targetMs);
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

/** 收集日志行的 manager——保活的可观测性是运维判断「它在不在工作」的唯一依据，得钉住。 */
function managerWithLog(fake: FakeProvider, idleTimeoutMs = 1000) {
  const lines: string[] = [];
  const manager = createSandboxManager(
    { vercel: fake.provider },
    {
      idleTimeoutMs,
      logger: createLogger({
        level: 'debug',
        sink: (line) => lines.push(line),
      }),
    },
  );
  const parsed = (message: string): Record<string, unknown>[] =>
    lines
      .filter((line) => line.includes(message))
      .map((line): Record<string, unknown> => {
        const start = line.indexOf('{');
        if (start === -1) return {};
        const value: unknown = JSON.parse(line.slice(start));
        return typeof value === 'object' && value !== null ? { ...value } : {};
      });
  return { manager, lines, parsed };
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
    expect(fake.createCalls).toMatchObject([
      {
        name: input.sandboxName,
        cloneUrl: input.repoCloneUrl,
        githubPat: input.githubPat,
        timeoutMs: 1000,
        // 保活配置也一并交给 provider（内容由专门的用例断言）
        keepAlive: { idleTimeoutMs: 1000 },
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

  it('acquire(): reports which of the three paths it took via `mode` (观测字段，docs/app/telemetry/tech.md §2.4)', async () => {
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

  it('ensureLifetime(): extends the acquired sandbox’s idle timeout; rejects for a conversation never acquired', async () => {
    const fake = createFakeProvider({
      resumeResult: async () => ({ kind: 'unavailable' }),
    });
    const manager = managerWith(fake, 42_000);

    const input = acquireInput();
    await manager.acquire(input);
    await manager.ensureLifetime(input.conversationId);

    expect(fake.createdSandboxes[0]?.ensureLifetimeCalls).toEqual([42_000]);
    await expect(manager.ensureLifetime('never-acquired')).rejects.toThrow(
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
  // SP-7 缓存失效 + 保活心跳（docs/host/sandbox-provider/tech.md §5.1）。
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

  it('ensureLifetime(): 成功保活把截止时间往后推，缓存继续有效', async () => {
    vi.useFakeTimers();
    try {
      const fake = createFakeProvider({
        resumeResult: async () => ({ kind: 'unavailable' }),
      });
      const manager = managerWith(fake, 300_000);

      const input = acquireInput();
      await manager.acquire(input);

      vi.setSystemTime(Date.now() + 200_000);
      await manager.ensureLifetime(input.conversationId); // 截止时间重置为 now + 300s

      vi.setSystemTime(Date.now() + 200_000); // 距 acquire 已 400s，但距 touch 只 200s
      await manager.acquire(input);
      expect(fake.resumeCalls).toHaveLength(1); // 仍是缓存命中
    } finally {
      vi.useRealTimers();
    }
  });

  it('ensureLifetime(): 抛「沙盒没了」→ 驱逐缓存（下次 acquire 重连），并把错误原样抛出', async () => {
    const fake = createFakeProvider({
      resumeResult: async () => ({ kind: 'unavailable' }),
    });
    const manager = managerWith(fake);

    const input = acquireInput();
    await manager.acquire(input);
    const sandbox = fake.createdSandboxes[0];
    expect(sandbox).toBeDefined();
    if (sandbox === undefined) return;

    sandbox.ensureLifetimeError = fakeGoneError();
    await expect(manager.ensureLifetime(input.conversationId)).rejects.toThrow(
      /gone/,
    );

    // 关键断言：缓存已被驱逐，下一次 acquire 回到 provider 而不是继续用死句柄
    await manager.acquire(input);
    expect(fake.resumeCalls).toHaveLength(2);
  });

  it('ensureLifetime(): 抛「不是沙盒没了」的错误时不驱逐缓存（网络抖动别把好句柄扔了）', async () => {
    const fake = createFakeProvider({
      resumeResult: async () => ({ kind: 'unavailable' }),
    });
    const manager = managerWith(fake);

    const input = acquireInput();
    await manager.acquire(input);
    const sandbox = fake.createdSandboxes[0];
    expect(sandbox).toBeDefined();
    if (sandbox === undefined) return;

    sandbox.ensureLifetimeError = new Error('ECONNRESET');
    await expect(manager.ensureLifetime(input.conversationId)).rejects.toThrow(
      /ECONNRESET/,
    );

    sandbox.ensureLifetimeError = undefined;
    await manager.acquire(input);
    expect(fake.resumeCalls).toHaveLength(1); // 缓存还在
  });

  it('manager 自己不再持有任何定时器——一轮进行期间的保活归适配器（KA-5）', async () => {
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

      // 光推进时钟：以前这里有个 turn 级心跳定时器会打出续期，现在一次都不该有。
      await vi.advanceTimersByTimeAsync(600_000);
      expect(sandbox.ensureLifetimeCalls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('建盒时把保活配置交给适配器，`idleTimeoutMs` 与建盒 timeout 一致', async () => {
    const fake = createFakeProvider({
      resumeResult: async () => ({ kind: 'unavailable' }),
    });
    const manager = managerWith(fake, 42_000);

    await manager.acquire(acquireInput());

    expect(fake.createCalls[0]?.timeoutMs).toBe(42_000);
    expect(fake.createCalls[0]?.keepAlive.idleTimeoutMs).toBe(42_000);
  });

  it('适配器内部续期经 onRenew 同步回缓存——长轮次之后不会白走一次 resume', async () => {
    vi.useFakeTimers();
    try {
      const fake = createFakeProvider({
        resumeResult: async () => ({ kind: 'unavailable' }),
      });
      const manager = managerWith(fake, 300_000);

      const input = acquireInput();
      await manager.acquire(input);

      // 模拟一轮跑了 20 分钟：适配器每 150 秒自己续一次，通过 onRenew 报回来。
      const onRenew = fake.createCalls[0]?.keepAlive.onRenew;
      expect(onRenew).toBeDefined();
      for (let i = 0; i < 8; i++) {
        vi.setSystemTime(Date.now() + 150_000);
        onRenew?.({
          ok: true,
          trigger: 'exec',
          expiresAt: Date.now() + 300_000,
        });
      }

      // 缓存仍然有效 → 下一条消息直接命中，不回 provider（`resumeCalls` 停在
      // 首次 acquire 那一次，不再增长）。
      const again = await manager.acquire(input);
      expect(again.mode).toBe('cache');
      expect(fake.createCalls).toHaveLength(1);
      expect(fake.resumeCalls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('没有续期通知时缓存照常过期——主动失效那一半没被削弱', async () => {
    vi.useFakeTimers();
    try {
      const fake = createFakeProvider({
        resumeResult: async () => ({ kind: 'unavailable' }),
      });
      const manager = managerWith(fake, 300_000);

      const input = acquireInput();
      await manager.acquire(input);

      const before = fake.resumeCalls.length;
      vi.setSystemTime(Date.now() + 300_001); // 一次续期都没发生
      await manager.acquire(input);

      expect(fake.resumeCalls).toHaveLength(before + 1); // 驱逐后重新走 resume
    } finally {
      vi.useRealTimers();
    }
  });

  it('续期失败的 onRenew 不会把缓存的到期时刻往前推', async () => {
    const fake = createFakeProvider({
      resumeResult: async () => ({ kind: 'unavailable' }),
    });
    const manager = managerWith(fake, 300_000);

    const input = acquireInput();
    await manager.acquire(input);
    fake.createCalls[0]?.keepAlive.onRenew?.({
      ok: false,
      trigger: 'activity',
      error: new Error('transient'),
    });

    expect((await manager.acquire(input)).mode).toBe('cache');
  });

  it('acquire(): resume 成功后显式保活一次，让缓存的截止时间可信', async () => {
    const resumed = createFakeProvisioned('nimbo-chat-session-1');
    const fake = createFakeProvider({
      resumeResult: async () => ({ kind: 'ok', sandbox: resumed }),
    });
    const manager = managerWith(fake, 42_000);

    await manager.acquire(acquireInput());
    expect(resumed.ensureLifetimeCalls).toEqual([42_000]);
  });

  it('acquire(): resume 回来的句柄在保活时就已经没了 → 退回 create', async () => {
    const resumed = createFakeProvisioned('nimbo-chat-session-1');
    resumed.ensureLifetimeError = fakeGoneError();
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

describe('resolveDefaultProvider (docs/host/sandbox-provider/tech.md §6)', () => {
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

describe('sandbox-manager: 保活的可观测性', () => {
  it('沙盒登记时打一行「保活已就位」，带上该等的续期节奏', async () => {
    const fake = createFakeProvider({
      resumeResult: async () => ({ kind: 'unavailable' }),
    });
    const { manager, parsed } = managerWithLog(fake, 300_000);

    await manager.acquire(acquireInput());

    const armed = parsed('sandbox keepalive armed');
    expect(armed).toHaveLength(1);
    expect(armed[0]).toMatchObject({
      conversationId: 'session-1',
      mode: 'create',
      provider: 'vercel',
      idleTimeoutMs: 300_000,
      expectRenewEveryMs: 150_000,
    });
  });

  it('每次真实续期打一行，带 trigger 与 ttlMs', async () => {
    const fake = createFakeProvider({
      resumeResult: async () => ({ kind: 'unavailable' }),
    });
    const { manager, parsed } = managerWithLog(fake, 300_000);

    const input = acquireInput();
    await manager.acquire(input);
    fake.createCalls[0]?.keepAlive.onRenew?.({
      ok: true,
      trigger: 'exec',
      expiresAt: Date.now() + 300_000,
    });

    const renewed = parsed('sandbox keepalive renewed');
    expect(renewed).toHaveLength(1);
    expect(renewed[0]).toMatchObject({
      conversationId: input.conversationId,
      trigger: 'exec',
    });
    // ttlMs 是「续完还能活多久」，允许一点执行耗时的抖动。
    expect(Number(renewed[0]?.ttlMs)).toBeGreaterThan(299_000);
  });

  it('第二次起带 sinceLastMs——长轮次期间它应稳定在续期节奏附近，是判断保活是否正常的主要依据', async () => {
    vi.useFakeTimers();
    try {
      const fake = createFakeProvider({
        resumeResult: async () => ({ kind: 'unavailable' }),
      });
      const { manager, parsed } = managerWithLog(fake, 300_000);

      await manager.acquire(acquireInput());
      const onRenew = fake.createCalls[0]?.keepAlive.onRenew;

      onRenew?.({ ok: true, trigger: 'exec', expiresAt: Date.now() + 300_000 });
      vi.setSystemTime(Date.now() + 150_000);
      onRenew?.({ ok: true, trigger: 'exec', expiresAt: Date.now() + 300_000 });

      const renewed = parsed('sandbox keepalive renewed');
      expect(renewed).toHaveLength(2);
      expect(renewed[0]?.sinceLastMs).toBeUndefined(); // 第一次没有「上一次」
      expect(renewed[1]?.sinceLastMs).toBe(150_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('续期失败打 warn，并报出距上次成功续期多久（离到期还剩多少余量）', async () => {
    vi.useFakeTimers();
    try {
      const fake = createFakeProvider({
        resumeResult: async () => ({ kind: 'unavailable' }),
      });
      const { manager, parsed } = managerWithLog(fake, 300_000);

      await manager.acquire(acquireInput());
      const onRenew = fake.createCalls[0]?.keepAlive.onRenew;

      onRenew?.({ ok: true, trigger: 'exec', expiresAt: Date.now() + 300_000 });
      vi.setSystemTime(Date.now() + 200_000);
      onRenew?.({
        ok: false,
        trigger: 'exec',
        error: new Error('sandbox gone'),
      });

      const failed = parsed('sandbox keepalive failed');
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({
        trigger: 'exec',
        sinceLastMs: 200_000,
        message: 'sandbox gone',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('失败不刷新 sinceLastMs 的基准——下一次成功仍以上一次**成功**为准', async () => {
    vi.useFakeTimers();
    try {
      const fake = createFakeProvider({
        resumeResult: async () => ({ kind: 'unavailable' }),
      });
      const { manager, parsed } = managerWithLog(fake, 300_000);

      await manager.acquire(acquireInput());
      const onRenew = fake.createCalls[0]?.keepAlive.onRenew;

      onRenew?.({ ok: true, trigger: 'exec', expiresAt: Date.now() + 300_000 });
      vi.setSystemTime(Date.now() + 100_000);
      onRenew?.({ ok: false, trigger: 'exec', error: new Error('blip') });
      vi.setSystemTime(Date.now() + 50_000);
      onRenew?.({ ok: true, trigger: 'exec', expiresAt: Date.now() + 300_000 });

      const renewed = parsed('sandbox keepalive renewed');
      expect(renewed[1]?.sinceLastMs).toBe(150_000); // 100k + 50k，不是 50k
    } finally {
      vi.useRealTimers();
    }
  });
});
