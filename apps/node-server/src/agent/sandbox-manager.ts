/**
 * Sandbox lifecycle (docs/tech/chat-webapp.md §2.2 `sandbox-manager.ts`,
 * generalized per docs/tech/sandbox-provider.md): every cloud-sandbox SDK
 * touch point in the whole server lives behind the structural
 * `SandboxProvider`/`ProvisionedSandbox` interfaces below — everything else
 * (routes/chat-agent) only ever sees `SandboxManager`, so tests inject fakes
 * with zero network/credentials (see test/agent/sandbox-manager.test.ts).
 *
 * A [沙盒 provider](docs/terms.md) is "which cloud sandbox this conversation
 * runs on" — `vercel` (`@vercel/sandbox`) or `e2b` (`@nimbo/sandbox-e2b`).
 * The manager holds a registry keyed by that id and picks per-conversation
 * (`AcquireInput.provider`). All provider-specific differences (clone timing,
 * resume-by-token, keepalive) are sealed inside the `SandboxProvider`
 * implementations — the `acquire` state machine below is provider-agnostic.
 *
 * `acquire()` is the single entry point for both "this conversation never had
 * a sandbox yet" (called once from `POST /api/chat/conversations`) and
 * "resume an existing conversation's sandbox" (called from every
 * `POST .../messages`) — three states:
 *
 *   1. in-process memory hit (this process already acquired it)     → reuse, no provider calls at all
 *   2. `provider.resume(resumeToken)` succeeds (the platform resumed
 *      it from its snapshot) → reuse as-is, branch/skill already there
 *   3. no `resumeToken` yet (brand-new), or `resume()` reports
 *      `unavailable` (snapshot expired/gone) → `provider.create()`
 *      (repo already cloned at the workspace root) + re-run the init plan
 *      (skill install, git identity, remote auth, exclude) + recover the
 *      conversation branch (`git fetch && checkout` if it was ever pushed,
 *      else `git checkout -b` to create it fresh) — one code path covers
 *      both the "brand-new" and the "expired" sub-cases.
 *
 * The [重连令牌](docs/terms.md) (`resumeToken`) differs by provider: Vercel's
 * is the deterministic sandbox `name` (known upfront, carried in via
 * `AcquireInput.resumeToken`); E2B's is the server-assigned `sandboxId` (only
 * known after `create()`, so `acquire()` returns the current token in
 * `AcquiredSandbox.resumeToken` for the route to persist).
 *
 * `touch()` is the whole "sleep" mechanism (docs/tech/chat-webapp.md §1.4): it
 * only calls the sandbox's own keepalive (`ProvisionedSandbox.extendIdle` —
 * Vercel `extendTimeout` / E2B `setTimeout`) — there is no server-side timer.
 * When a conversation goes idle past `SANDBOX_IDLE_TIMEOUT_MS`, the platform
 * stops + snapshots the sandbox on its own (Vercel `persistent`, E2B
 * `onTimeout:'pause'`); the next `acquire()` (state 2 or 3) recovers.
 */
import type { NimboExec, NimboFS } from '@nimbo/core';
import { e2bWorkspace } from '@nimbo/sandbox-e2b';
import type { VercelSandboxLike } from '@nimbo/sandbox-vercel';
import { vercelWorkspace } from '@nimbo/sandbox-vercel';
import { APIError, Sandbox } from '@vercel/sandbox';
import { Sandbox as E2bSandbox } from 'e2b';

import type { Logger } from '../logger.js';
import { logger as defaultLogger } from '../logger.js';
import { resolveE2bTemplate } from './e2b-template.js';

const LOG_SCOPE = 'sandbox-manager';

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

// ---- SandboxProvider: the sole seam onto a cloud-sandbox SDK (fake-able) ----

export type SandboxProviderId = 'vercel' | 'e2b';

/** The default [沙盒 provider](docs/terms.md) for a new conversation whose request omits one — `SANDBOX_PROVIDER` env, falling back to `'vercel'` (docs/tech/sandbox-provider.md §6). */
export function resolveDefaultProvider(): SandboxProviderId {
  return process.env.SANDBOX_PROVIDER?.trim().toLowerCase() === 'e2b' ?
      'e2b'
    : 'vercel';
}

export interface CreateSandboxParams {
  name: string;
  cloneUrl: string;
  githubPat: string;
  timeoutMs: number;
}

/**
 * A ready sandbox whose repo is already cloned at the workspace root. The
 * provider hides three things behind this handle: the `NimboFS & NimboExec`
 * view, the token to persist for the next resume, and the keepalive call.
 */
export interface ProvisionedSandbox {
  readonly workspace: NimboFS & NimboExec;
  /** Persist this to resume later: Vercel = the sandbox name (= the input token), E2B = the newly assigned sandboxId. */
  readonly resumeToken: string;
  /** Roll the sandbox's idle timeout forward (Vercel `extendTimeout` / E2B `setTimeout`). */
  extendIdle(idleTimeoutMs: number): Promise<void>;
}

export type ResumeResult =
  { kind: 'ok'; sandbox: ProvisionedSandbox } | { kind: 'unavailable' };

export interface SandboxProvider {
  readonly id: SandboxProviderId;
  /** Create a fresh sandbox with the repo cloned at the workspace root. */
  create(params: CreateSandboxParams): Promise<ProvisionedSandbox>;
  /** Resume by a previously persisted token; `unavailable` → caller re-creates. */
  resume(resumeToken: string): Promise<ResumeResult>;
  /**
   * Does this error mean "the sandbox behind that handle is gone/unusable"
   * (paused-and-not-reconnectable, stopped, deleted, never existed)?
   *
   * Lives on the provider because each SDK spells it differently (Vercel:
   * `APIError` 404/410; E2B: `SandboxNotFoundError` / a plain `Error` whose
   * message reads "Sandbox … not found"). It is deliberately part of the
   * **interface** rather than a provider-private helper: the manager has to
   * classify failures raised by *any* operation — `extendIdle` on a stale
   * handle, an `exec` against a paused sandbox — not just by `resume()`.
   * Before this existed, only `resume()` consulted it, so a cached handle that
   * went stale surfaced a raw 404 to the caller and never recovered
   * (docs/plans/sandbox-provider.md SP-7).
   */
  isGone(error: unknown): boolean;
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

// ---- Vercel provider ----

/** Any 404 ("this sandbox name was never created") or 410 ("stopped, and Vercel could not resume it from a snapshot") means "(re)create it". */
function isRecoverableGetFailure(error: unknown): boolean {
  return (
    error instanceof APIError &&
    (error.response.status === 404 || error.response.status === 410)
  );
}

/** Wraps a live `@vercel/sandbox` instance as a `ProvisionedSandbox` (its name is the resume token, `extendTimeout` is the keepalive). */
function vercelProvisioned(
  sandbox: VercelSandboxLike & {
    name: string;
    extendTimeout(durationMs: number): Promise<void>;
  },
): ProvisionedSandbox {
  return {
    workspace: vercelWorkspace(sandbox),
    resumeToken: sandbox.name,
    extendIdle: (idleTimeoutMs) => sandbox.extendTimeout(idleTimeoutMs),
  };
}

export function createVercelProvider(): SandboxProvider {
  return {
    id: 'vercel',
    async create(params: CreateSandboxParams): Promise<ProvisionedSandbox> {
      const token = requireEnv('VERCEL_TOKEN');
      const teamId = requireEnv('VERCEL_TEAM_ID');
      const projectId = requireEnv('VERCEL_PROJECT_ID');
      const sandbox = await Sandbox.create({
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
      return vercelProvisioned(sandbox);
    },
    async resume(resumeToken: string): Promise<ResumeResult> {
      const token = requireEnv('VERCEL_TOKEN');
      const teamId = requireEnv('VERCEL_TEAM_ID');
      const projectId = requireEnv('VERCEL_PROJECT_ID');
      try {
        const sandbox = await Sandbox.get({
          name: resumeToken,
          token,
          teamId,
          projectId,
        });
        return { kind: 'ok', sandbox: vercelProvisioned(sandbox) };
      } catch (error) {
        if (isRecoverableGetFailure(error)) return { kind: 'unavailable' };
        throw error;
      }
    },
    isGone: isRecoverableGetFailure,
  };
}

// ---- E2B provider ----

/**
 * Where the repo is cloned inside an E2B sandbox and thus the workspace root.
 * E2B has no create-time git source (unlike Vercel), so `create()` runs a
 * post-create `git clone` here; anchoring the workspace to this dir makes the
 * cwd-'/' shared init/branch commands (skill install, git config, fetch/
 * checkout) run inside the repo exactly as they do for Vercel's root
 * (docs/tech/sandbox-provider.md §1/§3).
 */
const E2B_WORKSPACE_ROOT = '/home/user/repo';

/** An E2B sandbox is gone (deleted / snapshot unrecoverable) → treat as `unavailable` and re-create, mirroring Vercel's 404/410. Structural check (host and package hold different `e2b` copies, so no `instanceof`): e2b's own `SandboxNotFoundError`/`NotFoundError` by name (`this.name` set in their constructors), plus a message net for the plain-`Error("Sandbox … not found")` path e2b also has (dist/index.js ~L4347). "Invalid sandbox ID" (a 400, malformed token) is deliberately NOT matched — that signals a real bug worth surfacing, not a recreate. */
function isE2bSandboxGone(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'SandboxNotFoundError' || error.name === 'NotFoundError')
    return true;
  return /sandbox\b.*\bnot found/i.test(error.message);
}

/** Retry budget for `resume`'s `connect` (see `resume` below). */
const E2B_RESUME_ATTEMPTS = 4;
const E2B_RESUME_BACKOFF_MS = 500;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Wraps a live `e2b` sandbox as a `ProvisionedSandbox` (its sandboxId is the resume token, `setTimeout` is the keepalive). */
function e2bProvisioned(sandbox: E2bSandbox): ProvisionedSandbox {
  return {
    workspace: e2bWorkspace(sandbox, { root: E2B_WORKSPACE_ROOT }),
    resumeToken: sandbox.sandboxId,
    extendIdle: (idleTimeoutMs) => sandbox.setTimeout(idleTimeoutMs),
  };
}

/** Rewrites `https://github.com/owner/repo.git` → `https://x-access-token:$GH_TOKEN@github.com/...`. `$GH_TOKEN` stays literal — the sandbox shell expands it from the env var set via `Sandbox.create`'s `envs` (never interpolates the PAT into the command string, same discipline as `remoteAuth`). */
function withTokenAuth(cloneUrl: string): string {
  return cloneUrl.replace(/^https:\/\//, 'https://x-access-token:$GH_TOKEN@');
}

export function createE2bProvider(): SandboxProvider {
  return {
    id: 'e2b',
    async create(params: CreateSandboxParams): Promise<ProvisionedSandbox> {
      const apiKey = requireEnv('E2B_API_KEY');
      const sandbox = await E2bSandbox.create({
        apiKey,
        // Our own template instead of E2B's stock `base` — the only way to get
        // more than base's 512 MiB, which `npm install` blows through
        // (resources are baked in at template build time; see e2b-template.ts).
        template: resolveE2bTemplate(),
        timeoutMs: params.timeoutMs,
        // Parity with Vercel `persistent`: auto-pause on idle timeout + auto-resume on traffic (full memory snapshot). docs/tech/sandbox-provider.md §5.
        lifecycle: { onTimeout: 'pause', autoResume: true },
        envs: { GH_TOKEN: params.githubPat },
        metadata: { name: params.name },
      });
      // E2B has no create-time git source — clone into the workspace root now.
      const clone = await sandbox.commands.run(
        `git clone --depth 1 ${withTokenAuth(params.cloneUrl)} ${E2B_WORKSPACE_ROOT}`,
        { timeoutMs: 2 * 60_000 },
      );
      if (clone.exitCode !== 0) {
        throw new Error(
          `E2B: git clone into ${E2B_WORKSPACE_ROOT} failed (exit ${String(clone.exitCode)}). ${clone.stderr}`,
        );
      }
      return e2bProvisioned(sandbox);
    },
    async resume(resumeToken: string): Promise<ResumeResult> {
      const apiKey = requireEnv('E2B_API_KEY');
      // A sandbox that just auto-paused (lifecycle.onTimeout:'pause') can
      // transiently 404 on `connect` for a moment while the platform settles
      // the pause snapshot — observed in real-machine acceptance
      // (docs/plans/sandbox-provider.md SP-6): the sandbox is actually still
      // there and reconnectable seconds later. So retry a few times before
      // concluding it's gone; a *persistent* not-found means re-create (which
      // would lose un-pushed WIP, so it must not fire on a transient blip).
      // `connect` auto-resumes a paused sandbox (lifecycle.autoResume).
      let lastError: unknown;
      for (let attempt = 1; attempt <= E2B_RESUME_ATTEMPTS; attempt++) {
        try {
          const sandbox = await E2bSandbox.connect(resumeToken, { apiKey });
          return { kind: 'ok', sandbox: e2bProvisioned(sandbox) };
        } catch (error) {
          lastError = error;
          if (attempt < E2B_RESUME_ATTEMPTS)
            await delay(E2B_RESUME_BACKOFF_MS * attempt);
        }
      }
      if (isE2bSandboxGone(lastError)) return { kind: 'unavailable' };
      throw lastError;
    },
    isGone: isE2bSandboxGone,
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
    // PAT read from the sandbox's own $GH_TOKEN env var (set at create time), never interpolated here.
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

/** Recovers the conversation's branch: `git fetch && checkout` if it was pushed before, else create it fresh. Covers both the brand-new and the expired-snapshot cases (see file header). */
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
  provider: SandboxProviderId;
  sandboxName: string;
  branchName: string;
  repoCloneUrl: string;
  repoOwner: string;
  repoName: string;
  githubPat: string;
  /** Previously persisted [重连令牌](docs/terms.md): Vercel = sandboxName, E2B = stored sandboxId. `undefined` for a brand-new conversation → straight to create. */
  resumeToken?: string;
}

/**
 * 这次 `acquire()` 实际走了文件头三态里的哪一条（docs/tech/telemetry.md §2.4）
 * ——三者的耗时量级差着两个数量级（`cache` 零远程调用、`resume` 一次连接 +
 * 续期 + 一次 `git` 探测、`create` 还要 clone + 装 skill + 切分支），是「这一轮
 * 起得慢」时第一个要看的字段。纯观测用途：调用方不得据此改变行为，三态返回的
 * `AcquiredSandbox` 在功能上完全等价。
 */
export type AcquireMode = 'cache' | 'resume' | 'create';

export interface AcquiredSandbox {
  workspace: NimboFS & NimboExec;
  defaultBranch: string;
  /** Current resume token — the route persists it (E2B's sandboxId is only known after create; Vercel's equals the name and is a no-op). */
  resumeToken: string;
  /** 观测字段，见 `AcquireMode`。 */
  mode: AcquireMode;
}

export interface SandboxManager {
  acquire(input: AcquireInput): Promise<AcquiredSandbox>;
  /** Extends the sandbox's platform-side timeout — throws if this conversation has no in-memory active sandbox (call `acquire()` first). */
  touch(conversationId: string): Promise<void>;
  /** Evicts the in-process cache entry (no provider call) — forces the next `acquire()` to go through `SandboxProvider.resume()` again. */
  release(conversationId: string): void;
  /**
   * Keepalive heartbeat for the duration of one turn (docs/plans/sandbox-provider.md SP-7 层 1).
   * Returns the stop function; calling it twice is a no-op.
   *
   * Necessary because the platform timeout is an **absolute deadline**, not an
   * activity-based idle timer: E2B's `POST /sandboxes/{id}/timeout` sets expiry
   * "x seconds from the time of the request", and running commands does *not*
   * push it back. Without a heartbeat, any turn that outlives the remaining TTL
   * gets its sandbox paused out from under it mid-run.
   *
   * Deliberately **turn-scoped**, not manager-scoped: a heartbeat that ran for
   * every cached sandbox would defeat idle-pause entirely and burn money.
   */
  startHeartbeat(conversationId: string): () => void;
}

interface ActiveSandbox {
  provisioned: ProvisionedSandbox;
  defaultBranch: string;
  /** The provider that produced `provisioned` — needed to classify errors (`isGone`) raised by later operations on this handle. */
  provider: SandboxProvider;
  /**
   * When the platform-side timeout is expected to fire, i.e. the last
   * create/resume/`extendIdle` + `idleTimeoutMs`. This is the cache's
   * invalidation clock: past it, the handle is presumed stale and `acquire()`
   * goes back through `resume()` instead of handing out a dead sandbox.
   */
  expiresAt: number;
}

export interface SandboxManagerConfig {
  idleTimeoutMs?: number;
  logger?: Logger;
}

export type SandboxProviderRegistry = Partial<
  Record<SandboxProviderId, SandboxProvider>
>;

export function createSandboxManager(
  providers: SandboxProviderRegistry,
  config: SandboxManagerConfig = {},
): SandboxManager {
  const idleTimeoutMs = config.idleTimeoutMs ?? resolveIdleTimeoutMs();
  const log = config.logger ?? defaultLogger;
  const active = new Map<string, ActiveSandbox>();
  const inflight = new Map<string, Promise<AcquiredSandbox>>();
  const heartbeats = new Map<string, NodeJS.Timeout>();

  /**
   * Half the timeout, so every tick has a full second tick's worth of slack
   * before the platform deadline it is pushing back.
   */
  const heartbeatIntervalMs = Math.max(1000, Math.floor(idleTimeoutMs / 2));

  /** Records that the platform-side deadline was just rolled forward to now + `idleTimeoutMs`. */
  function markAlive(entry: ActiveSandbox): void {
    entry.expiresAt = Date.now() + idleTimeoutMs;
  }

  /** Cache entry that is still within its platform deadline, else `undefined` (and evicted). */
  function liveEntry(conversationId: string): ActiveSandbox | undefined {
    const entry = active.get(conversationId);
    if (entry === undefined) return undefined;
    if (Date.now() < entry.expiresAt) return entry;
    // Presumed paused/expired platform-side. Dropping it here is what makes the
    // next acquire() reconnect instead of handing out a handle whose every call
    // 404s (docs/plans/sandbox-provider.md SP-7 层 2).
    log.info(LOG_SCOPE, 'sandbox cache entry expired, will reconnect', {
      conversationId,
    });
    evict(conversationId);
    return undefined;
  }

  function evict(conversationId: string): void {
    active.delete(conversationId);
    const timer = heartbeats.get(conversationId);
    if (timer !== undefined) {
      clearInterval(timer);
      heartbeats.delete(conversationId);
    }
  }

  /** The body behind both `touch()` and the heartbeat tick — see `touch` for why it evicts on a "gone" error. */
  async function extendDeadline(conversationId: string): Promise<void> {
    const entry = active.get(conversationId);
    if (entry === undefined) {
      throw new Error(
        `touch(${conversationId}): no active sandbox in memory — call acquire() first.`,
      );
    }
    try {
      await entry.provisioned.extendIdle(idleTimeoutMs);
    } catch (error) {
      if (entry.provider.isGone(error)) {
        log.warn(LOG_SCOPE, 'sandbox gone on keepalive, evicting cache', {
          conversationId,
        });
        evict(conversationId);
      }
      throw error;
    }
    markAlive(entry);
  }

  function resolveProvider(id: SandboxProviderId): SandboxProvider {
    const provider = providers[id];
    if (provider === undefined) {
      throw new Error(
        `No sandbox provider registered for "${id}" (registered: ${Object.keys(providers).join(', ') || 'none'}).`,
      );
    }
    return provider;
  }

  function toAcquired(
    entry: ActiveSandbox,
    mode: AcquireMode,
  ): AcquiredSandbox {
    return {
      workspace: entry.provisioned.workspace,
      defaultBranch: entry.defaultBranch,
      resumeToken: entry.provisioned.resumeToken,
      mode,
    };
  }

  async function doAcquire(input: AcquireInput): Promise<AcquiredSandbox> {
    // State 1: a cached handle that is still inside its platform deadline.
    // `liveEntry` (not `active.get`) is the fix for "the process happily reused
    // a handle whose sandbox the platform had already paused".
    const cached = liveEntry(input.conversationId);
    if (cached !== undefined) return toAcquired(cached, 'cache');

    const provider = resolveProvider(input.provider);

    // State 2: resume an existing snapshot by its persisted token.
    if (input.resumeToken !== undefined) {
      const resumed = await provider.resume(input.resumeToken);
      if (resumed.kind === 'ok') {
        // Roll the deadline forward explicitly rather than assuming what the
        // platform did on resume — it is what makes `expiresAt` truthful for
        // both providers (E2B's auto-resume resets the countdown with a 5-min
        // floor; Vercel's `get` makes no such promise). One extra call, only on
        // the resume path, never on a cache hit.
        try {
          await resumed.sandbox.extendIdle(idleTimeoutMs);
        } catch (error) {
          // Raced with the platform tearing it down between connect and
          // extend → fall through to create rather than hand back a dead handle.
          if (!provider.isGone(error)) throw error;
          log.warn(LOG_SCOPE, 'resumed sandbox vanished before keepalive', {
            conversationId: input.conversationId,
          });
          return await createAndRegister(input, provider);
        }
        const defaultBranch = await detectDefaultBranch(
          resumed.sandbox.workspace,
        );
        const entry: ActiveSandbox = {
          provisioned: resumed.sandbox,
          defaultBranch,
          provider,
          expiresAt: 0,
        };
        markAlive(entry);
        active.set(input.conversationId, entry);
        return toAcquired(entry, 'resume');
      }
    }

    // State 3: brand-new, or snapshot unavailable → create + re-run init + recover branch.
    return await createAndRegister(input, provider);
  }

  async function createAndRegister(
    input: AcquireInput,
    provider: SandboxProvider,
  ): Promise<AcquiredSandbox> {
    const provisioned = await provider.create({
      name: input.sandboxName,
      cloneUrl: input.repoCloneUrl,
      githubPat: input.githubPat,
      timeoutMs: idleTimeoutMs,
    });
    await installSkillAndConfigureGit(
      provisioned.workspace,
      input.repoOwner,
      input.repoName,
    );
    const defaultBranch = await detectDefaultBranch(provisioned.workspace);
    await recoverSessionBranch(provisioned.workspace, input.branchName);

    const entry: ActiveSandbox = {
      provisioned,
      defaultBranch,
      provider,
      expiresAt: 0,
    };
    markAlive(entry); // create() already set the platform timeout to idleTimeoutMs
    active.set(input.conversationId, entry);
    return toAcquired(entry, 'create');
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
    /**
     * Reactive half of cache invalidation (the TTL check in `acquire` is the
     * proactive half): clocks drift, the platform may pause early, and a sandbox
     * can be deleted out-of-band — so a "gone" error is also taken as proof the
     * cached handle is dead, and the entry is evicted so the very next
     * `acquire()` reconnects. Still rethrows: this call genuinely failed, and
     * each caller decides whether that is fatal (the approval/question routes
     * deliberately swallow it).
     */
    touch: extendDeadline,
    release(conversationId: string): void {
      evict(conversationId);
    },
    startHeartbeat(conversationId: string): () => void {
      // One heartbeat per conversation: a second turn cannot legitimately start
      // while one is running (`startTurn`'s guard), so an existing timer here
      // would be a leak from a turn that never settled — replace it.
      const existing = heartbeats.get(conversationId);
      if (existing !== undefined) clearInterval(existing);

      const timer = setInterval(() => {
        void (async (): Promise<void> => {
          try {
            await extendDeadline(conversationId);
          } catch (error) {
            // Never let a keepalive failure escape into an unhandled rejection
            // that kills the process. The turn will fail on its own next
            // sandbox call, with a far better error than this one.
            log.warn(LOG_SCOPE, 'sandbox heartbeat failed', {
              conversationId,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        })();
      }, heartbeatIntervalMs);
      // Don't hold the event loop open on shutdown just for a keepalive.
      timer.unref();
      heartbeats.set(conversationId, timer);

      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        // Only clear if it is still *this* turn's timer (a later turn may have
        // replaced it above).
        if (heartbeats.get(conversationId) === timer) {
          clearInterval(timer);
          heartbeats.delete(conversationId);
        }
      };
    },
  };
}
