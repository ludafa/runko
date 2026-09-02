/**
 * Sandbox lifecycle (docs/tech/chat-webapp.md §2.2 `sandbox-manager.ts`,
 * generalized per docs/tech/sandbox-provider.md): every cloud-sandbox SDK
 * touch point in the whole server lives behind the structural
 * `SandboxProvider`/`ProvisionedSandbox` interfaces below — everything else
 * (routes/chat-agent) only ever sees `SandboxManager`, so tests inject fakes
 * with zero network/credentials (see test/agent/sandbox-manager.test.ts).
 *
 * A [沙盒 provider](docs/terms.md) is "which cloud sandbox this conversation
 * runs on" — `vercel` (`@vercel/sandbox`) or `e2b` (`@runko/sandbox-e2b`).
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
 * `ensureLifetime()` is the whole "sleep" mechanism (docs/tech/chat-webapp.md §1.4):
 * it only asks the workspace to top its own lifetime back up — there is no
 * server-side timer. When a conversation goes idle past
 * `SANDBOX_IDLE_TIMEOUT_MS`, the platform stops + snapshots the sandbox on its
 * own (Vercel `persistent`, E2B `onTimeout:'pause'`); the next `acquire()`
 * (state 2 or 3) recovers.
 *
 * ---- 保活归 SDK 了（docs/tech/sandbox-keepalive.md，KA-5） ----
 *
 * 这个文件以前自己起过一个 turn 级心跳定时器（`startHeartbeat`），现在**整个删掉**：
 * 一轮进行期间的续期由适配器自己做（`e2bWorkspace`/`vercelWorkspace` 的 `keepAlive`
 * 选项），它有两个这里拿不到的信号——core 推来的[活动信号](../../../../docs/terms.md)、
 * 以及 exec 调用自身的进行状态。这里只剩下**轮之外**的手动补足（起轮前、审批/提问
 * 路由），走 `ensureLifetime()`。
 *
 * 两个语义变化值得记住：
 *
 * 1. **「补足」不是「加时」。** 旧的 `extendIdle` 对 Vercel 调 `extendTimeout(idleTimeout)`，
 *    而那个 API 是**累加**的——每条用户消息盲加 5 分钟，高频对话后沙盒多活几十分钟
 *    白计费。新的 `ensureLifetime` 是「补到至少 X，够了就什么都不做」，天然免疫。
 * 2. **`expiresAt` 由 `onRenew` 回调驱动。** 续期发生在适配器内部，这里看不见；
 *    不接这个回调的话，一轮跑 30 分钟之后本地这本账还停在起轮时的值，下一条消息
 *    会误判缓存过期、白走一次 `resume()`（见 `keepAliveOptionsFor`）。
 */
import type {
  KeepAliveOptions,
  RunkoActivityAware,
  RunkoExec,
  RunkoFS,
  RunkoKeepAliveCapable,
} from '@runko/core';
import { e2bWorkspace } from '@runko/sandbox-e2b';
import type { VercelSandboxLike } from '@runko/sandbox-vercel';
import { vercelWorkspace } from '@runko/sandbox-vercel';
import { APIError, Sandbox } from '@vercel/sandbox';
import { Sandbox as E2bSandbox } from 'e2b';

import type { Logger } from '../logger.js';
import { logger as defaultLogger } from '../logger.js';
import { resolveE2bTemplate } from './e2b-template.js';

const LOG_SCOPE = 'sandbox-manager';

export const DEFAULT_SANDBOX_IDLE_TIMEOUT_MS = 300_000;

export function resolveIdleTimeoutMs(): number {
  const raw = process.env.SANDBOX_IDLE_TIMEOUT_MS?.trim();
  if (raw === undefined || raw.length === 0) {
    return DEFAULT_SANDBOX_IDLE_TIMEOUT_MS;
  }
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
  /** 交给适配器的[保活](../../../../docs/terms.md)配置，见 `keepAliveOptionsFor`。 */
  keepAlive: KeepAliveOptions;
}

/** 工作区在这里的完整形状：两个功能面 + 两个保活面（适配器在开了 `keepAlive` 时才挂上）。 */
export type ManagedWorkspace = RunkoFS &
  RunkoExec &
  RunkoActivityAware &
  RunkoKeepAliveCapable;

/**
 * A ready sandbox whose repo is already cloned at the workspace root. The
 * provider hides three things behind this handle: the workspace view, the token
 * to persist for the next resume, and the keepalive call.
 */
export interface ProvisionedSandbox {
  readonly workspace: ManagedWorkspace;
  /** Persist this to resume later: Vercel = the sandbox name (= the input token), E2B = the newly assigned sandboxId. */
  readonly resumeToken: string;
  /**
   * 把沙盒剩余[存活时长](../../../../docs/terms.md)**补足**到 `targetMs`
   * （够了就什么都不做——不是无脑加时，见文件头）。转发到适配器的
   * `workspace.keepAlive`，厂商差异全在那边。
   */
  ensureLifetime(targetMs: number): Promise<void>;
}

export type ResumeResult =
  { kind: 'ok'; sandbox: ProvisionedSandbox } | { kind: 'unavailable' };

export interface SandboxProvider {
  readonly id: SandboxProviderId;
  /** Create a fresh sandbox with the repo cloned at the workspace root. */
  create(params: CreateSandboxParams): Promise<ProvisionedSandbox>;
  /** Resume by a previously persisted token; `unavailable` → caller re-creates. */
  resume(
    resumeToken: string,
    keepAlive: KeepAliveOptions,
  ): Promise<ResumeResult>;
  /**
   * Does this error mean "the sandbox behind that handle is gone/unusable"
   * (paused-and-not-reconnectable, stopped, deleted, never existed)?
   *
   * Lives on the provider because each SDK spells it differently (Vercel:
   * `APIError` 404/410; E2B: `SandboxNotFoundError` / a plain `Error` whose
   * message reads "Sandbox … not found"). It is deliberately part of the
   * **interface** rather than a provider-private helper: the manager has to
   * classify failures raised by *any* operation — `ensureLifetime` on a stale
   * handle, an `exec` against a paused sandbox — not just by `resume()`.
   * Before this existed, only `resume()` consulted it, so a cached handle that
   * went stale surfaced a raw 404 to the caller and never recovered
   * (docs/plans/sandbox-provider.md SP-7).
   */
  isGone(error: unknown): boolean;
}

/**
 * 把工作区的可选 `keepAlive` 收成必有的转发函数。
 *
 * **刻意显式判空抛错，不写成 `workspace.keepAlive?.(ms)`**——那会把「这家不支持保活」
 * 静默变成 no-op，正好复现已经修过的那个线上 bug（沙盒被平台从底下暂停），而且更难查：
 * 什么都不报，只是沙盒莫名其妙死了。
 */
function forwardKeepAlive(
  workspace: ManagedWorkspace,
  providerId: SandboxProviderId,
): (targetMs: number) => Promise<void> {
  return (targetMs) => {
    const keepAlive = workspace.keepAlive;
    if (keepAlive === undefined) {
      return Promise.reject(
        new Error(
          `provider "${providerId}": the workspace has no keepAlive capability — the adapter was built ` +
            'without a keepAlive option, or the sandbox instance lacks the vendor lifetime API.',
        ),
      );
    }
    return keepAlive(targetMs);
  };
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

/** Wraps a live `@vercel/sandbox` instance as a `ProvisionedSandbox` (its name is the resume token; keepalive lives inside the adapter). */
function vercelProvisioned(
  sandbox: VercelSandboxLike & { name: string },
  keepAlive: KeepAliveOptions,
): ProvisionedSandbox {
  const workspace = vercelWorkspace(sandbox, { keepAlive });
  return {
    workspace,
    resumeToken: sandbox.name,
    ensureLifetime: forwardKeepAlive(workspace, 'vercel'),
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
      return vercelProvisioned(sandbox, params.keepAlive);
    },
    async resume(
      resumeToken: string,
      keepAlive: KeepAliveOptions,
    ): Promise<ResumeResult> {
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
        return { kind: 'ok', sandbox: vercelProvisioned(sandbox, keepAlive) };
      } catch (error) {
        if (isRecoverableGetFailure(error)) {
          return { kind: 'unavailable' };
        }
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
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === 'SandboxNotFoundError' || error.name === 'NotFoundError') {
    return true;
  }
  return /sandbox\b.*\bnot found/i.test(error.message);
}

/** Retry budget for `resume`'s `connect` (see `resume` below). */
const E2B_RESUME_ATTEMPTS = 4;
const E2B_RESUME_BACKOFF_MS = 500;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Wraps a live `e2b` sandbox as a `ProvisionedSandbox` (its sandboxId is the resume token; keepalive lives inside the adapter). */
function e2bProvisioned(
  sandbox: E2bSandbox,
  keepAlive: KeepAliveOptions,
): ProvisionedSandbox {
  const workspace = e2bWorkspace(sandbox, {
    root: E2B_WORKSPACE_ROOT,
    keepAlive,
  });
  return {
    workspace,
    resumeToken: sandbox.sandboxId,
    ensureLifetime: forwardKeepAlive(workspace, 'e2b'),
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
      return e2bProvisioned(sandbox, params.keepAlive);
    },
    async resume(
      resumeToken: string,
      keepAlive: KeepAliveOptions,
    ): Promise<ResumeResult> {
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
          return { kind: 'ok', sandbox: e2bProvisioned(sandbox, keepAlive) };
        } catch (error) {
          lastError = error;
          if (attempt < E2B_RESUME_ATTEMPTS) {
            await delay(E2B_RESUME_BACKOFF_MS * attempt);
          }
        }
      }
      if (isE2bSandboxGone(lastError)) {
        return { kind: 'unavailable' };
      }
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
      '(git clone --depth 1 https://github.com/anthropics/skills /tmp/runko-skills-src && ' +
      'mkdir -p .agents/skills && cp -r /tmp/runko-skills-src/skills/frontend-design .agents/skills/)',
    gitIdentity:
      'git config user.name "runko-agent" && git config user.email "runko-agent@users.noreply.github.com"',
    // PAT read from the sandbox's own $GH_TOKEN env var (set at create time), never interpolated here.
    remoteAuth: `git remote set-url origin "https://x-access-token:$GH_TOKEN@github.com/${owner}/${repo}.git"`,
    gitExclude: "printf '%s\\n' '.agents/' '.skills/' >> .git/info/exclude",
  };
}

async function runScript(
  workspace: RunkoFS & RunkoExec,
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
  workspace: RunkoFS & RunkoExec,
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
  if (identity.exitCode !== 0) {
    throw new Error(
      `git identity setup failed (exit ${String(identity.exitCode)}).`,
    );
  }

  const remoteAuth = await runScript(workspace, scripts.remoteAuth);
  if (remoteAuth.exitCode !== 0) {
    throw new Error(
      `git remote set-url failed (exit ${String(remoteAuth.exitCode)}).`,
    );
  }

  await runScript(workspace, scripts.gitExclude); // best-effort, not fatal
}

/** Recovers the conversation's branch: `git fetch && checkout` if it was pushed before, else create it fresh. Covers both the brand-new and the expired-snapshot cases (see file header). */
async function recoverSessionBranch(
  workspace: RunkoFS & RunkoExec,
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
  if (idx === -1 || idx === trimmed.length - 1) {
    return undefined;
  }
  return trimmed.slice(idx + 1);
}

async function detectDefaultBranch(
  workspace: RunkoFS & RunkoExec,
): Promise<string> {
  const result = await runScript(
    workspace,
    'git symbolic-ref refs/remotes/origin/HEAD',
  );
  if (result.exitCode !== 0) {
    return DEFAULT_BRANCH_FALLBACK;
  }
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
  workspace: RunkoFS & RunkoExec;
  defaultBranch: string;
  /** Current resume token — the route persists it (E2B's sandboxId is only known after create; Vercel's equals the name and is a no-op). */
  resumeToken: string;
  /** 观测字段，见 `AcquireMode`。 */
  mode: AcquireMode;
}

export interface SandboxManager {
  acquire(input: AcquireInput): Promise<AcquiredSandbox>;
  /**
   * 手动把沙盒[存活时长](../../../../docs/terms.md)补足一次——这个会话没有进程内活
   * 沙盒时抛错（先 `acquire()`）。
   *
   * 只用于**轮之外**的时机（起轮前、审批/提问路由）。一轮进行期间的续期由适配器
   * 自己做，不需要也不该由这里驱动，见文件头。
   */
  ensureLifetime(conversationId: string): Promise<void>;
  /** Evicts the in-process cache entry (no provider call) — forces the next `acquire()` to go through `SandboxProvider.resume()` again. */
  release(conversationId: string): void;
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

  /** Records that the platform-side deadline was just rolled forward to now + `idleTimeoutMs`. */
  function markAlive(entry: ActiveSandbox): void {
    entry.expiresAt = Date.now() + idleTimeoutMs;
  }

  /**
   * 交给适配器的[保活](../../../../docs/terms.md)配置。
   *
   * `onRenew` 是**必需**的，不是可选的观测口：续期发生在适配器内部，这里看不见。
   * 不把它同步回 `entry.expiresAt` 的话，一轮跑 30 分钟（期间适配器一直在续、沙盒
   * 好好的）之后来了新消息，`liveEntry()` 会看到起轮时那个早过期的时间戳 → 驱逐 →
   * 白走一次 `resume()`。不是正确性 bug，但每轮多一次连接往返，正好打在
   * `AcquireMode` 遥测最在意的地方。
   *
   * 闭包按 `conversationId` **惰性**取 entry——工作区是在 entry 存进 `active` 之前
   * 就造好的，早绑会拿到 undefined。
   */
  function keepAliveOptionsFor(conversationId: string): KeepAliveOptions {
    /**
     * 上一次**真实**续期发生的时刻（闸门判定「水位还够」而跳过的不算）。只为算
     * 日志里的 `sinceLastMs`——见 `onRenew` 里对这个字段的说明。
     */
    let lastRenewAt: number | undefined;

    return {
      idleTimeoutMs,
      onRenew: (info) => {
        const now = Date.now();
        const sinceLastMs =
          lastRenewAt === undefined ? undefined : now - lastRenewAt;

        if (!info.ok) {
          log.warn(LOG_SCOPE, 'sandbox keepalive failed', {
            conversationId,
            trigger: info.trigger,
            // 距上次成功续期多久——直接说明这个盒离到期还有多少余量。
            sinceLastMs,
            message:
              info.error instanceof Error ?
                info.error.message
              : String(info.error),
          });
          return;
        }

        lastRenewAt = now;
        const entry = active.get(conversationId);
        if (entry !== undefined && info.expiresAt !== undefined) {
          entry.expiresAt = info.expiresAt;
        }

        /**
         * 保活的**唯一**可观测出口（docs/features/sandbox-keepalive.md §3.5）：
         * 续期动作发生在适配器内部，不打这行日志的话运维完全看不见它在不在工作。
         *
         * 怎么看这行判断正常：
         * - `sinceLastMs` 是**最诊断性**的数字。一轮长跑期间它应该稳定在
         *   `idleTimeoutMs / 2` 左右（默认 150000）。中间突然拉大到接近
         *   `idleTimeoutMs`，说明有一段时间没人喂信号——沙盒离被平台暂停不远了。
         * - `trigger` 说明是哪条路在喂：`exec` = 有条命令正在跑（这段 core 不产
         *   chunk，全靠适配器自打点）；`activity` = 一轮在正常推进；`approval` =
         *   卡在等人；`manual` = 宿主在轮之外主动补的（起轮前、审批路由）。
         * - `ttlMs` 是续完之后还能活多久，正常应等于 `idleTimeoutMs`。
         *
         * 用 info 而不是 debug：这是判断「保活到底在不在工作」的主要依据，得默认
         * 可见。频率不高——补足语义把绝大多数调用挡在门外，真正落到这里的大约
         * 每 `idleTimeoutMs / 2` 一次。
         */
        log.info(LOG_SCOPE, 'sandbox keepalive renewed', {
          conversationId,
          trigger: info.trigger,
          sinceLastMs,
          ttlMs:
            info.expiresAt === undefined ? undefined : info.expiresAt - now,
        });
      },
    };
  }

  /**
   * 登记一个新拿到的沙盒句柄，并打一行「保活已就位」。
   *
   * 这行日志是为了让**没有** `sandbox keepalive renewed` 这件事变得可读：光看不到
   * 续期日志，分不清是「保活没配上」还是「还没到该续的时候」。有了这行就分得清——
   * 它出现过，说明这个盒的保活是开着的，`expectRenewEveryMs` 就是该等的节奏。
   */
  function register(
    conversationId: string,
    entry: ActiveSandbox,
    mode: Exclude<AcquireMode, 'cache'>,
  ): void {
    active.set(conversationId, entry);
    log.info(LOG_SCOPE, 'sandbox keepalive armed', {
      conversationId,
      mode,
      provider: entry.provider.id,
      idleTimeoutMs,
      expectRenewEveryMs: Math.max(1000, Math.floor(idleTimeoutMs / 2)),
    });
  }

  /** Cache entry that is still within its platform deadline, else `undefined` (and evicted). */
  function liveEntry(conversationId: string): ActiveSandbox | undefined {
    const entry = active.get(conversationId);
    if (entry === undefined) {
      return undefined;
    }
    if (Date.now() < entry.expiresAt) {
      return entry;
    }
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
  }

  /** `ensureLifetime()` 的实现——见接口上的注释解释为什么 gone 错误要顺手驱逐缓存。 */
  async function extendDeadline(conversationId: string): Promise<void> {
    const entry = active.get(conversationId);
    if (entry === undefined) {
      throw new Error(
        `ensureLifetime(${conversationId}): no active sandbox in memory — call acquire() first.`,
      );
    }
    try {
      await entry.provisioned.ensureLifetime(idleTimeoutMs);
    } catch (error) {
      if (entry.provider.isGone(error)) {
        log.warn(LOG_SCOPE, 'sandbox gone on keepalive, evicting cache', {
          conversationId,
        });
        evict(conversationId);
      }
      throw error;
    }
    /**
     * 兜底：闸门判定「水位还够」时不会触发 `onRenew`，这里也就拿不到新的到期时刻。
     * 但那正说明沙盒离到期还远，把本地账推到满水位是安全的（真实到期只会更晚）。
     */
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
    if (cached !== undefined) {
      return toAcquired(cached, 'cache');
    }

    const provider = resolveProvider(input.provider);

    // State 2: resume an existing snapshot by its persisted token.
    if (input.resumeToken !== undefined) {
      const resumed = await provider.resume(
        input.resumeToken,
        keepAliveOptionsFor(input.conversationId),
      );
      if (resumed.kind === 'ok') {
        // Roll the deadline forward explicitly rather than assuming what the
        // platform did on resume — it is what makes `expiresAt` truthful for
        // both providers (E2B's auto-resume resets the countdown with a 5-min
        // floor; Vercel's `get` makes no such promise). One extra call, only on
        // the resume path, never on a cache hit.
        try {
          await resumed.sandbox.ensureLifetime(idleTimeoutMs);
        } catch (error) {
          // Raced with the platform tearing it down between connect and
          // extend → fall through to create rather than hand back a dead handle.
          if (!provider.isGone(error)) {
            throw error;
          }
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
        register(input.conversationId, entry, 'resume');
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
      keepAlive: keepAliveOptionsFor(input.conversationId),
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
    register(input.conversationId, entry, 'create');
    return toAcquired(entry, 'create');
  }

  return {
    acquire(input: AcquireInput): Promise<AcquiredSandbox> {
      const existing = inflight.get(input.conversationId);
      if (existing !== undefined) {
        return existing;
      }

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
    ensureLifetime: extendDeadline,
    release(conversationId: string): void {
      evict(conversationId);
    },
  };
}
