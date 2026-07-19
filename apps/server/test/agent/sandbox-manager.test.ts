import type {
  VercelFileSystemLike,
  VercelSandboxLike,
} from '@nimbo/sandbox-vercel';
import { vercelWorkspace } from '@nimbo/sandbox-vercel';
import { afterEach, describe, expect, it } from 'vitest';

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
  return {
    workspace: vercelWorkspace(sandbox),
    resumeToken: name,
    commands,
    extendIdleCalls,
    async extendIdle(idleTimeoutMs) {
      extendIdleCalls.push(idleTimeoutMs);
    },
  };
}

interface FakeProvider {
  provider: SandboxProvider;
  resumeCalls: string[];
  createCalls: CreateSandboxParams[];
  createdSandboxes: FakeProvisioned[];
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
