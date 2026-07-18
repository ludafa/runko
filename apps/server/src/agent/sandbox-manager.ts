/**
 * Sandbox lifecycle (docs/tech/chat-webapp.md §2.2 `sandbox-manager.ts`):
 * every `@vercel/sandbox`/`@nimbo/sandbox-vercel` touch point in the whole
 * server lives in this module — everything else (routes/chat-agent) only
 * sees the structural `SandboxClient`/`ManagedSandbox` interfaces below, so
 * tests can inject a fake with zero network/credentials (see
 * test/agent/sandbox-manager.test.ts).
 *
 * `acquire()` is the single entry point for both "this session never had a
 * sandbox yet" (called once from `POST /api/chat/conversations`) and "resume an
 * existing session's sandbox" (called from every `POST .../messages`) — the
 * three states the ticket asks tests to cover:
 *
 *   1. in-process memory hit (this process already has it acquired)         → reuse, no Vercel calls at all
 *   2. `SandboxClient.get()` succeeds (Vercel resumed it from its snapshot) → reuse as-is, branch/skill already there
 *   3. `SandboxClient.get()` fails ("not_found" a brand-new session ever
 *      had, or "unavailable" — snapshot expired/gone) → `create()` + re-run
 *      the init plan (skill install, git identity, remote auth, exclude) +
 *      recover the session branch (`git fetch && checkout` if it was ever
 *      pushed, else `git checkout -b` to create it fresh) — one code path
 *      covers both the "brand-new" and the "expired" sub-cases, since a
 *      `git fetch` of a branch that was never pushed simply fails the same
 *      way an expired-but-since-recreated remote would; either way the
 *      fallback creates the branch fresh.
 *
 * `touch()` is the whole "sleep" mechanism (docs/tech/chat-webapp.md §1.4): it only calls
 * Vercel's own `extendTimeout()` — there is no server-side timer. When a
 * session goes idle past `SANDBOX_IDLE_TIMEOUT_MS`, Vercel stops + snapshots
 * the sandbox on its own; the next `acquire()` (state 2 or 3 above) recovers.
 */
import type { NimboExec, NimboFS } from '@nimbo/core';
import type { VercelSandboxLike } from '@nimbo/sandbox-vercel';
import { vercelWorkspace } from '@nimbo/sandbox-vercel';
import { APIError, Sandbox } from '@vercel/sandbox';

export const DEFAULT_SANDBOX_IDLE_TIMEOUT_MS = 300_000;

export function resolveIdleTimeoutMs(): number {
  const raw = process.env.SANDBOX_IDLE_TIMEOUT_MS?.trim();
  if (raw === undefined || raw.length === 0)
    return DEFAULT_SANDBOX_IDLE_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ?
      parsed
    : DEFAULT_SANDBOX_IDLE_TIMEOUT_MS;
}

// ---- SandboxClient: the sole seam onto @vercel/sandbox (fake-able) ----

export interface ManagedSandbox extends VercelSandboxLike {
  readonly name: string;
  extendTimeout(durationMs: number): Promise<void>;
}

export interface CreateSandboxParams {
  name: string;
  cloneUrl: string;
  githubPat: string;
  timeoutMs: number;
}

export type GetSandboxResult =
  { kind: 'ok'; sandbox: ManagedSandbox } | { kind: 'unavailable' };

export interface SandboxClient {
  create(params: CreateSandboxParams): Promise<ManagedSandbox>;
  get(name: string): Promise<GetSandboxResult>;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(
      `Missing required environment variable ${name} (see .env.example).`,
    );
  }
  return value;
}

/** Any 404 ("this sandbox name was never created") or 410 ("stopped, and Vercel could not resume it from a snapshot") means "(re)create it". */
function isRecoverableGetFailure(error: unknown): boolean {
  return (
    error instanceof APIError &&
    (error.response.status === 404 || error.response.status === 410)
  );
}

export function createVercelSandboxClient(): SandboxClient {
  return {
    async create(params: CreateSandboxParams): Promise<ManagedSandbox> {
      const token = requireEnv('VERCEL_TOKEN');
      const teamId = requireEnv('VERCEL_TEAM_ID');
      const projectId = requireEnv('VERCEL_PROJECT_ID');
      return Sandbox.create({
        name: params.name,
        token,
        teamId,
        projectId,
        runtime: 'node24',
        persistent: true, // the precondition for "sleep = Vercel's own snapshot-on-timeout" (docs/tech/chat-webapp.md §1.4/§2.2)
        timeout: params.timeoutMs,
        source: {
          type: 'git',
          url: params.cloneUrl,
          username: 'x-access-token',
          password: params.githubPat,
          depth: 1,
        },
        env: { GH_TOKEN: params.githubPat },
      });
    },
    async get(name: string): Promise<GetSandboxResult> {
      const token = requireEnv('VERCEL_TOKEN');
      const teamId = requireEnv('VERCEL_TEAM_ID');
      const projectId = requireEnv('VERCEL_PROJECT_ID');
      try {
        const sandbox = await Sandbox.get({ name, token, teamId, projectId });
        return { kind: 'ok', sandbox };
      } catch (error) {
        if (isRecoverableGetFailure(error)) return { kind: 'unavailable' };
        throw error;
      }
    },
  };
}

// ---- host-side init plan (skill install + git config), run only on (re)create ----

interface InitScripts {
  installSkill: string;
  cloneFallback: string;
  gitIdentity: string;
  remoteAuth: string;
  gitExclude: string;
}

/** Same six commands as examples/12's `buildInitPlan` (docs/tech/sandbox.md §2.3/§2.4), minus default-branch detection (kept separate, see `detectDefaultBranch`). */
function buildInitScripts(owner: string, repo: string): InitScripts {
  return {
    installSkill:
      'npx -y skills add anthropics/skills --skill frontend-design -a cursor -y',
    cloneFallback:
      'test -f .agents/skills/frontend-design/SKILL.md || ' +
      '(git clone --depth 1 https://github.com/anthropics/skills /tmp/nimbo-skills-src && ' +
      'mkdir -p .agents/skills && cp -r /tmp/nimbo-skills-src/skills/frontend-design .agents/skills/)',
    gitIdentity:
      'git config user.name "nimbo-agent" && git config user.email "nimbo-agent@users.noreply.github.com"',
    // PAT read from the sandbox's own $GH_TOKEN env var (set via Sandbox.create's `env`), never interpolated here.
    remoteAuth: `git remote set-url origin "https://x-access-token:$GH_TOKEN@github.com/${owner}/${repo}.git"`,
    gitExclude: "printf '%s\\n' '.agents/' '.skills/' >> .git/info/exclude",
  };
}

async function runScript(
  workspace: NimboFS & NimboExec,
  command: string,
  timeoutMs?: number,
): Promise<{ exitCode: number; stdout: string }> {
  const result = await workspace.exec({
    command,
    cwd: '/',
    signal: new AbortController().signal,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
  return { exitCode: result.exitCode, stdout: result.stdout };
}

async function installSkillAndConfigureGit(
  workspace: NimboFS & NimboExec,
  owner: string,
  repo: string,
): Promise<void> {
  const scripts = buildInitScripts(owner, repo);

  await runScript(workspace, scripts.installSkill, 5 * 60_000); // best-effort — cloneFallback below is the actual success gate
  const fallback = await runScript(
    workspace,
    scripts.cloneFallback,
    2 * 60_000,
  );
  if (fallback.exitCode !== 0) {
    throw new Error(
      'Failed to install the frontend-design skill (both `npx skills` and the git-clone fallback failed).',
    );
  }

  const identity = await runScript(workspace, scripts.gitIdentity);
  if (identity.exitCode !== 0)
    throw new Error(
      `git identity setup failed (exit ${String(identity.exitCode)}).`,
    );

  const remoteAuth = await runScript(workspace, scripts.remoteAuth);
  if (remoteAuth.exitCode !== 0)
    throw new Error(
      `git remote set-url failed (exit ${String(remoteAuth.exitCode)}).`,
    );

  await runScript(workspace, scripts.gitExclude); // best-effort, not fatal
}

/** Recovers the session's branch: `git fetch && checkout` if it was pushed before, else create it fresh. Covers both the brand-new and the expired-snapshot cases (see file header). */
async function recoverSessionBranch(
  workspace: NimboFS & NimboExec,
  branchName: string,
): Promise<void> {
  const fetchAndCheckout = await runScript(
    workspace,
    `git fetch origin ${branchName} && git checkout ${branchName}`,
  );
  if (fetchAndCheckout.exitCode !== 0) {
    const createBranch = await runScript(
      workspace,
      `git checkout -b ${branchName}`,
    );
    if (createBranch.exitCode !== 0) {
      throw new Error(
        `Could not check out branch "${branchName}" from origin, nor create it fresh.`,
      );
    }
  }
}

const DEFAULT_BRANCH_FALLBACK = 'main';

/** Parses `git symbolic-ref refs/remotes/origin/HEAD`'s stdout (e.g. "refs/remotes/origin/main\n") down to "main". */
function parseDefaultBranchRef(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  const idx = trimmed.lastIndexOf('/');
  if (idx === -1 || idx === trimmed.length - 1) return undefined;
  return trimmed.slice(idx + 1);
}

async function detectDefaultBranch(
  workspace: NimboFS & NimboExec,
): Promise<string> {
  const result = await runScript(
    workspace,
    'git symbolic-ref refs/remotes/origin/HEAD',
  );
  if (result.exitCode !== 0) return DEFAULT_BRANCH_FALLBACK;
  return parseDefaultBranchRef(result.stdout) ?? DEFAULT_BRANCH_FALLBACK;
}

// ---- SandboxManager: acquire/touch/release state machine ----

export interface AcquireInput {
  conversationId: string;
  sandboxName: string;
  branchName: string;
  repoCloneUrl: string;
  repoOwner: string;
  repoName: string;
  githubPat: string;
}

export interface AcquiredSandbox {
  workspace: NimboFS & NimboExec;
  defaultBranch: string;
}

export interface SandboxManager {
  acquire(input: AcquireInput): Promise<AcquiredSandbox>;
  /** Extends the sandbox's Vercel-side timeout — throws if this session has no in-memory active sandbox (call `acquire()` first). */
  touch(conversationId: string): Promise<void>;
  /** Evicts the in-process cache entry (no Vercel call) — forces the next `acquire()` to go through `SandboxClient.get()` again. */
  release(conversationId: string): void;
}

interface ActiveSandbox {
  sandbox: ManagedSandbox;
  workspace: NimboFS & NimboExec;
  defaultBranch: string;
}

export interface SandboxManagerConfig {
  idleTimeoutMs?: number;
}

export function createSandboxManager(
  client: SandboxClient,
  config: SandboxManagerConfig = {},
): SandboxManager {
  const idleTimeoutMs = config.idleTimeoutMs ?? resolveIdleTimeoutMs();
  const active = new Map<string, ActiveSandbox>();
  const inflight = new Map<string, Promise<AcquiredSandbox>>();

  async function doAcquire(input: AcquireInput): Promise<AcquiredSandbox> {
    const cached = active.get(input.conversationId);
    if (cached !== undefined) {
      return {
        workspace: cached.workspace,
        defaultBranch: cached.defaultBranch,
      };
    }

    const getResult = await client.get(input.sandboxName);
    if (getResult.kind === 'ok') {
      const workspace = vercelWorkspace(getResult.sandbox);
      const defaultBranch = await detectDefaultBranch(workspace);
      active.set(input.conversationId, {
        sandbox: getResult.sandbox,
        workspace,
        defaultBranch,
      });
      return { workspace, defaultBranch };
    }

    const sandbox = await client.create({
      name: input.sandboxName,
      cloneUrl: input.repoCloneUrl,
      githubPat: input.githubPat,
      timeoutMs: idleTimeoutMs,
    });
    const workspace = vercelWorkspace(sandbox);
    await installSkillAndConfigureGit(
      workspace,
      input.repoOwner,
      input.repoName,
    );
    const defaultBranch = await detectDefaultBranch(workspace);
    await recoverSessionBranch(workspace, input.branchName);

    active.set(input.conversationId, { sandbox, workspace, defaultBranch });
    return { workspace, defaultBranch };
  }

  return {
    acquire(input: AcquireInput): Promise<AcquiredSandbox> {
      const existing = inflight.get(input.conversationId);
      if (existing !== undefined) return existing;

      const promise = doAcquire(input).finally(() =>
        inflight.delete(input.conversationId),
      );
      inflight.set(input.conversationId, promise);
      return promise;
    },
    async touch(conversationId: string): Promise<void> {
      const activeSandbox = active.get(conversationId);
      if (activeSandbox === undefined) {
        throw new Error(
          `touch(${conversationId}): no active sandbox in memory — call acquire() first.`,
        );
      }
      await activeSandbox.sandbox.extendTimeout(idleTimeoutMs);
    },
    release(conversationId: string): void {
      active.delete(conversationId);
    },
  };
}
