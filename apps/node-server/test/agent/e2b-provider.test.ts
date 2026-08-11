/**
 * Contract tests for `createE2bProvider()` (docs/host/sandbox-provider/plan.md
 * SP-2). The `e2b` package's static `Sandbox.create`/`Sandbox.connect` are
 * mocked — no network, no credentials — and the *real* `@nimbo/sandbox-e2b`
 * `e2bWorkspace()` wraps a structural fake sandbox. Asserts the three
 * provider-specific things Vercel does differently: post-create `git clone`
 * into the workspace root, sandboxId as the resume token, and `setTimeout`
 * keepalive — plus resume-by-id error mapping and the missing-key guard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_E2B_TEMPLATE_NAME } from '../../src/agent/e2b-template.js';
import type { CreateSandboxParams } from '../../src/agent/sandbox-manager.js';

const { createMock, connectMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  connectMock: vi.fn(),
}));

vi.mock('e2b', () => ({
  Sandbox: {
    create: (...args: unknown[]) => createMock(...args),
    connect: (...args: unknown[]) => connectMock(...args),
  },
}));

// Imported after the mock is registered (vi.mock is hoisted above imports).
const { createE2bProvider } =
  await import('../../src/agent/sandbox-manager.js');

interface FakeE2bSandbox {
  sandboxId: string;
  files: unknown;
  commands: { run: (cmd: string, opts?: unknown) => Promise<unknown> };
  setTimeout: (ms: number) => Promise<void>;
  runCalls: { cmd: string; opts?: unknown }[];
  setTimeoutCalls: number[];
}

function fakeE2bSandbox(
  sandboxId: string,
  opts: { cloneExit?: number } = {},
): FakeE2bSandbox {
  const runCalls: { cmd: string; opts?: unknown }[] = [];
  const setTimeoutCalls: number[] = [];
  const noopFs = {
    read: async () => new Uint8Array(),
    write: async (path: string) => ({ name: path, path }),
    list: async () => [],
    remove: async () => {},
    makeDir: async () => true,
    getInfo: async (path: string) => ({
      name: path,
      type: 'dir',
      path,
      size: 0,
    }),
  };
  return {
    sandboxId,
    files: noopFs,
    commands: {
      run: async (cmd: string, runOpts?: unknown) => {
        runCalls.push({ cmd, opts: runOpts });
        const exitCode = cmd.includes('git clone') ? (opts.cloneExit ?? 0) : 0;
        return {
          exitCode,
          stdout: '',
          stderr: exitCode === 0 ? '' : 'fatal: clone failed',
        };
      },
    },
    setTimeout: async (ms: number) => {
      setTimeoutCalls.push(ms);
    },
    runCalls,
    setTimeoutCalls,
  };
}

function createParams(
  overrides: Partial<CreateSandboxParams> = {},
): CreateSandboxParams {
  return {
    name: 'nimbo-chat-conv-1',
    cloneUrl: 'https://github.com/acme/demo.git',
    githubPat: 'PAT123',
    timeoutMs: 1000,
    keepAlive: { idleTimeoutMs: 1000 },
    ...overrides,
  };
}

const ORIGINAL_KEY = process.env.E2B_API_KEY;
const ORIGINAL_TEMPLATE = process.env.E2B_TEMPLATE;

beforeEach(() => {
  createMock.mockReset();
  connectMock.mockReset();
  process.env.E2B_API_KEY = 'test-e2b-key';
  delete process.env.E2B_TEMPLATE;
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.E2B_API_KEY;
  else process.env.E2B_API_KEY = ORIGINAL_KEY;
  if (ORIGINAL_TEMPLATE === undefined) delete process.env.E2B_TEMPLATE;
  else process.env.E2B_TEMPLATE = ORIGINAL_TEMPLATE;
});

describe('createE2bProvider', () => {
  it('create(): creates from our own template with pause-on-timeout lifecycle + GH_TOKEN env, clones the repo into the workspace root, returns sandboxId as the resume token', async () => {
    const fake = fakeE2bSandbox('sbx_abc');
    createMock.mockResolvedValue(fake);

    const provisioned = await createE2bProvider().create(createParams());

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0]?.[0]).toMatchObject({
      apiKey: 'test-e2b-key',
      // NOT E2B's stock `base` — that one is capped at 512 MiB (e2b-template.ts).
      template: DEFAULT_E2B_TEMPLATE_NAME,
      timeoutMs: 1000,
      lifecycle: { onTimeout: 'pause', autoResume: true },
      envs: { GH_TOKEN: 'PAT123' },
      metadata: { name: 'nimbo-chat-conv-1' },
    });

    const cloneCmd = fake.runCalls.find((c) => c.cmd.includes('git clone'));
    expect(cloneCmd?.cmd).toBe(
      'git clone --depth 1 https://x-access-token:$GH_TOKEN@github.com/acme/demo.git /home/user/repo',
    );
    expect(provisioned.resumeToken).toBe('sbx_abc');

    // 保活转发到适配器：补足语义下第一次必定真的打一次 setTimeout。
    await provisioned.ensureLifetime(4242);
    expect(fake.setTimeoutCalls).toEqual([4242]);
  });

  it('create(): E2B_TEMPLATE overrides the template (escape hatch back to stock `base` / a differently-sized variant, no code change)', async () => {
    process.env.E2B_TEMPLATE = 'base';
    createMock.mockResolvedValue(fakeE2bSandbox('sbx_abc'));

    await createE2bProvider().create(createParams());

    expect(createMock.mock.calls[0]?.[0]).toMatchObject({ template: 'base' });
  });

  it('create(): throws when the git clone fails', async () => {
    createMock.mockResolvedValue(fakeE2bSandbox('sbx_x', { cloneExit: 128 }));

    await expect(createE2bProvider().create(createParams())).rejects.toThrow(
      /git clone into \/home\/user\/repo failed \(exit 128\)/,
    );
  });

  it('resume(): connects by sandboxId (auto-resume) and reports ok', async () => {
    const fake = fakeE2bSandbox('sbx_resumed');
    connectMock.mockResolvedValue(fake);

    const result = await createE2bProvider().resume('sbx_resumed', {
      idleTimeoutMs: 1000,
    });

    expect(connectMock).toHaveBeenCalledWith('sbx_resumed', {
      apiKey: 'test-e2b-key',
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.sandbox.resumeToken).toBe('sbx_resumed');
    }
  });

  it('resume(): retries a transient not-found and reconnects the same sandbox (a just-paused sandbox can 404 for a moment — docs/host/sandbox-provider/plan.md SP-6)', async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeE2bSandbox('sbx_resumed');
      // First connect 404s (pause snapshot still settling), second succeeds.
      connectMock
        .mockRejectedValueOnce(
          Object.assign(new Error('Sandbox sbx_resumed not found'), {
            name: 'SandboxNotFoundError',
          }),
        )
        .mockResolvedValueOnce(fake);

      const promise = createE2bProvider().resume('sbx_resumed', {
        idleTimeoutMs: 1000,
      });
      await vi.runAllTimersAsync(); // advance the retry backoff
      const result = await promise;

      expect(connectMock).toHaveBeenCalledTimes(2);
      expect(result.kind).toBe('ok'); // reconnected — NOT discarded/recreated (WIP preserved)
      if (result.kind === 'ok') {
        expect(result.sandbox.resumeToken).toBe('sbx_resumed');
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('resume(): maps a *persistent* SandboxNotFoundError to unavailable after exhausting retries (so the manager re-creates)', async () => {
    vi.useFakeTimers();
    try {
      connectMock.mockRejectedValue(
        Object.assign(new Error('Sandbox sbx_missing not found'), {
          name: 'SandboxNotFoundError',
        }),
      );

      const promise = createE2bProvider().resume('sbx_missing', {
        idleTimeoutMs: 1000,
      });
      await vi.runAllTimersAsync();

      await expect(promise).resolves.toEqual({ kind: 'unavailable' });
      expect(connectMock.mock.calls.length).toBeGreaterThan(1); // retried, didn't give up on the first blip
    } finally {
      vi.useRealTimers();
    }
  });

  it('resume(): rethrows a persistent non-"gone" error (e.g. a real network/auth failure — must not silently re-create)', async () => {
    vi.useFakeTimers();
    try {
      connectMock.mockRejectedValue(new Error('network boom'));

      // Attach the rejection expectation synchronously (before advancing
      // timers) so the promise never rejects into an unobserved window.
      const promise = createE2bProvider().resume('sbx_x', {
        idleTimeoutMs: 1000,
      });
      await Promise.all([
        expect(promise).rejects.toThrow(/network boom/),
        vi.runAllTimersAsync(),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('create()/resume(): throw a guidance error when E2B_API_KEY is missing', async () => {
    delete process.env.E2B_API_KEY;

    await expect(createE2bProvider().create(createParams())).rejects.toThrow(
      /E2B_API_KEY/,
    );
    await expect(
      createE2bProvider().resume('sbx_x', { idleTimeoutMs: 1000 }),
    ).rejects.toThrow(/E2B_API_KEY/);
    expect(createMock).not.toHaveBeenCalled();
    expect(connectMock).not.toHaveBeenCalled();
  });
});
