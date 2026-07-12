import type { VercelFileSystemLike } from '@nimbo/sandbox-vercel';
import { describe, expect, it } from 'vitest';

import type {
  AcquireInput,
  CreateSandboxParams,
  GetSandboxResult,
  ManagedSandbox,
  SandboxClient,
} from '../../src/agent/sandbox-manager.js';
import { createSandboxManager } from '../../src/agent/sandbox-manager.js';

// ---------------------------------------------------------------------------
// A structurally-injected fake Sandbox (no @vercel/sandbox import, no
// network) — same style as examples/10/12's fakes. `runCommand` records
// every script it was asked to run (so tests can assert exactly what
// sandbox-manager.ts did/skipped) and special-cases `git symbolic-ref` to
// answer with a stubbed default-branch ref.
// ---------------------------------------------------------------------------

interface FakeManagedSandbox extends ManagedSandbox {
  readonly commands: string[];
  readonly extendTimeoutCalls: number[];
}

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

function createFakeManagedSandbox(
  name: string,
  exitCodeFor: (script: string) => number = () => 0,
): FakeManagedSandbox {
  const commands: string[] = [];
  const extendTimeoutCalls: number[] = [];
  return {
    name,
    fs: rejectingFs(),
    commands,
    extendTimeoutCalls,
    async runCommand(params) {
      const script = params.args?.[1] ?? '';
      commands.push(script);
      if (script.includes('git symbolic-ref')) {
        params.stdout?.write('refs/remotes/origin/main\n');
        return { exitCode: 0 };
      }
      return { exitCode: exitCodeFor(script) };
    },
    async extendTimeout(durationMs) {
      extendTimeoutCalls.push(durationMs);
    },
  };
}

interface FakeSandboxClient {
  client: SandboxClient;
  getCalls: string[];
  createCalls: CreateSandboxParams[];
  createdSandboxes: FakeManagedSandbox[];
}

function createFakeSandboxClient(opts: {
  getResult: (name: string) => Promise<GetSandboxResult>;
  exitCodeFor?: (script: string) => number;
}): FakeSandboxClient {
  const getCalls: string[] = [];
  const createCalls: CreateSandboxParams[] = [];
  const createdSandboxes: FakeManagedSandbox[] = [];
  const client: SandboxClient = {
    async create(params) {
      createCalls.push(params);
      const sandbox = createFakeManagedSandbox(params.name, opts.exitCodeFor);
      createdSandboxes.push(sandbox);
      return sandbox;
    },
    async get(name) {
      getCalls.push(name);
      return opts.getResult(name);
    },
  };
  return { client, getCalls, createCalls, createdSandboxes };
}

function acquireInput(overrides: Partial<AcquireInput> = {}): AcquireInput {
  return {
    sessionId: 'session-1',
    sandboxName: 'nimbo-chat-session-1',
    branchName: 'nimbo/chat-session-1',
    repoCloneUrl: 'https://github.com/acme/demo.git',
    repoOwner: 'acme',
    repoName: 'demo',
    githubPat: 'test-pat',
    ...overrides,
  };
}

describe('sandbox-manager', () => {
  it('acquire(): resumes via SandboxClient.get() without re-running the init plan', async () => {
    const preExisting = createFakeManagedSandbox('nimbo-chat-session-1');
    const fake = createFakeSandboxClient({
      getResult: async () => ({ kind: 'ok', sandbox: preExisting }),
    });
    const manager = createSandboxManager(fake.client, { idleTimeoutMs: 1000 });

    const result = await manager.acquire(acquireInput());

    expect(fake.getCalls).toEqual(['nimbo-chat-session-1']);
    expect(fake.createCalls).toHaveLength(0);
    expect(result.defaultBranch).toBe('main');
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

  it('acquire(): (re)creates + reinstalls + recovers the branch when get() reports unavailable (expired/never created)', async () => {
    const fake = createFakeSandboxClient({
      getResult: async () => ({ kind: 'unavailable' }),
      // Simulate a branch that was never pushed: `git fetch origin <branch>` fails, forcing the `git checkout -b` fallback.
      exitCodeFor: (script) => (script.startsWith('git fetch origin') ? 1 : 0),
    });
    const manager = createSandboxManager(fake.client, { idleTimeoutMs: 1000 });

    const input = acquireInput();
    const result = await manager.acquire(input);

    expect(fake.getCalls).toEqual([input.sandboxName]);
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
    const fake = createFakeSandboxClient({
      getResult: async () => ({ kind: 'unavailable' }),
    }); // default exitCodeFor -> everything succeeds
    const manager = createSandboxManager(fake.client, { idleTimeoutMs: 1000 });

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

  it('acquire(): an in-process memory hit skips SandboxClient entirely', async () => {
    const fake = createFakeSandboxClient({
      getResult: async () => ({ kind: 'unavailable' }),
    });
    const manager = createSandboxManager(fake.client, { idleTimeoutMs: 1000 });

    const input = acquireInput();
    await manager.acquire(input);
    expect(fake.createCalls).toHaveLength(1);
    expect(fake.getCalls).toHaveLength(1);

    const second = await manager.acquire(input);
    expect(fake.createCalls).toHaveLength(1); // unchanged
    expect(fake.getCalls).toHaveLength(1); // unchanged
    expect(second.defaultBranch).toBe('main');
  });

  it('touch(): extends the acquired sandbox’s timeout; rejects for a session never acquired', async () => {
    const fake = createFakeSandboxClient({
      getResult: async () => ({ kind: 'unavailable' }),
    });
    const manager = createSandboxManager(fake.client, {
      idleTimeoutMs: 42_000,
    });

    const input = acquireInput();
    await manager.acquire(input);
    await manager.touch(input.sessionId);

    expect(fake.createdSandboxes[0]?.extendTimeoutCalls).toEqual([42_000]);
    await expect(manager.touch('never-acquired')).rejects.toThrow(
      /no active sandbox/,
    );
  });

  it('release(): evicts the memory cache, forcing the next acquire() back through SandboxClient', async () => {
    const fake = createFakeSandboxClient({
      getResult: async () => ({ kind: 'unavailable' }),
    });
    const manager = createSandboxManager(fake.client, { idleTimeoutMs: 1000 });

    const input = acquireInput();
    await manager.acquire(input);
    manager.release(input.sessionId);
    await manager.acquire(input);

    expect(fake.createCalls).toHaveLength(2);
  });

  it('acquire(): concurrent calls for the same session single-flight into one SandboxClient.get()', async () => {
    let resolveGet: ((result: GetSandboxResult) => void) | undefined;
    const gate = new Promise<GetSandboxResult>((resolve) => {
      resolveGet = resolve;
    });
    const fake = createFakeSandboxClient({ getResult: async () => gate });
    const manager = createSandboxManager(fake.client, { idleTimeoutMs: 1000 });

    const input = acquireInput();
    const first = manager.acquire(input);
    const second = manager.acquire(input);

    expect(fake.getCalls).toHaveLength(1); // the second call joined the in-flight promise synchronously, before the gate even opened

    const sandbox = createFakeManagedSandbox(input.sandboxName);
    resolveGet?.({ kind: 'ok', sandbox });

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(fake.getCalls).toHaveLength(1);
    expect(firstResult.workspace).toBe(secondResult.workspace);
  });
});
