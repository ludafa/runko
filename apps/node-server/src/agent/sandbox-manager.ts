/**
 * 沙盒生命周期（docs/ingress/tech/chat-webapp.md §2.2 `sandbox-manager.ts`，按
 * docs/host/contract/tech/sandbox-provider.md 泛化）。
 *
 * 整个服务端碰云沙盒 SDK 的地方，全部关在下面 `SandboxProvider`/`ProvisionedSandbox`
 * 这两个结构化接口后面。其余代码（routes、chat-agent）只看得见 `SandboxManager`，所以
 * 测试可以注入假实现，零网络零凭证（见 test/agent/sandbox-manager.test.ts）。
 *
 * [沙盒 provider](docs/terms.md) 就是「这个会话跑在哪家云沙盒上」——`vercel`
 * （`@vercel/sandbox`）或 `e2b`（`@runko/sandbox-e2b`）。manager 持有一张按 id 索引的
 * 注册表，按会话选一家（`AcquireInput.provider`）。厂商之间的全部差异（什么时候 clone、
 * 怎么按令牌重连、怎么保活）都封在各自的 `SandboxProvider` 实现里，下面 `acquire` 那个
 * 状态机与厂商无关。
 *
 * `acquire()` 是唯一入口，两种场景共用——「这个会话还从没有过沙盒」（`POST
 * /api/chat/conversations` 调一次）与「把已有会话的沙盒恢复出来」（每次
 * `POST .../messages` 都调）。它有三态：
 *
 *   1. 进程内内存命中（本进程已经拿到过）→ 直接复用，一次远程调用都不发
 *   2. `provider.resume(resumeToken)` 成功（平台从快照把它恢复了）→ 原样复用，
 *      分支与 skill 都还在
 *   3. 还没有 `resumeToken`（全新会话），或 `resume()` 报 `unavailable`（快照过期/没了）
 *      → `provider.create()`（仓库已经 clone 在工作区根）+ 重跑一遍初始化脚本
 *      （装 skill、配 git 身份、配远端鉴权、写 exclude）+ 恢复会话分支（推送过就
 *      `git fetch && checkout`，没推送过就 `git checkout -b` 新建）。「全新」与「过期」
 *      两种子情况走的是同一段代码。
 *
 * [重连令牌](docs/terms.md)（`resumeToken`）各家不同：Vercel 的是那个确定性的沙盒
 * `name`（事先就知道，经 `AcquireInput.resumeToken` 传进来）；E2B 的是服务端分配的
 * `sandboxId`（只有 `create()` 之后才知道，所以 `acquire()` 会把当前令牌放在
 * `AcquiredSandbox.resumeToken` 里返回，交给路由落库）。
 *
 * `ensureLifetime()` 就是整个「休眠」机制（docs/ingress/tech/chat-webapp.md §1.4）：它只是
 * 请工作区把自己的存活时长补回去，**服务端这边没有任何定时器**。一个会话闲置超过
 * `SANDBOX_IDLE_TIMEOUT_MS` 之后，平台会自己停机并打快照（Vercel 的 `persistent`、E2B 的
 * `onTimeout:'pause'`），下一次 `acquire()` 走第 2 或第 3 态把它恢复回来。
 *
 * ---- 保活归 SDK（docs/logic/orchestration/tech/sandbox-keepalive.md，KA-5） ----
 *
 * 一轮进行期间的续期由适配器自己做（`e2bWorkspace`/`vercelWorkspace` 的 `keepAlive`
 * 选项）：它有两个这里拿不到的信号——core 推来的[活动信号](../../../../docs/terms.md)，
 * 以及 exec 调用自身的进行状态。这个文件只负责**轮之外**的手动补足（起轮前、审批/提问
 * 路由），走 `ensureLifetime()`。
 *
 * 两件事值得记住：
 *
 * 1. **`ensureLifetime` 是「补足」，不是「加时」。** 语义是「补到至少 X，够了就什么都
 *    不做」。这条很关键：Vercel 的 `extendTimeout` 是**累加**的，照着它的语义每条用户
 *    消息盲加 5 分钟，高频对话之后沙盒会多活几十分钟、白计费。
 * 2. **`expiresAt` 由 `onRenew` 回调驱动。** 续期发生在适配器内部，这里看不见。不接这个
 *    回调的话，一轮跑 30 分钟之后本地这本账还停在起轮时的值，下一条消息会误判缓存过期、
 *    白走一次 `resume()`（见 `keepAliveOptionsFor`）。
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

// ---- SandboxProvider：对接云沙盒 SDK 的唯一接缝（可替换成假实现） ----

export type SandboxProviderId = 'vercel' | 'e2b' | 'local';

/** 这台服务端能用哪几档[沙盒 provider](docs/terms.md)：云沙盒要 key，[本地沙盒](docs/terms.md)永远能用。 */
export function availableProviders(
  env: NodeJS.ProcessEnv = process.env,
): SandboxProviderId[] {
  const ids: SandboxProviderId[] = [];
  if ((env.VERCEL_TOKEN?.trim() ?? '').length > 0) {
    ids.push('vercel');
  }
  if ((env.E2B_API_KEY?.trim() ?? '').length > 0) {
    ids.push('e2b');
  }
  ids.push('local');
  return ids;
}

/**
 * 建会话的请求没指定 provider 时用哪一档。
 *
 * `SANDBOX_PROVIDER` 点名了就听它的；没点名就挑**这台服务端真配得起**的第一档——
 * 什么 key 都没配时那就是[本地沙盒](docs/terms.md)，于是零配置也能建会话。
 */
export function resolveDefaultProvider(
  env: NodeJS.ProcessEnv = process.env,
): SandboxProviderId {
  const named = env.SANDBOX_PROVIDER?.trim().toLowerCase();
  const available = availableProviders(env);
  if (named === 'e2b' || named === 'vercel' || named === 'local') {
    return named;
  }
  return available[0] ?? 'local';
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
 * 一个已就绪的沙盒，仓库已经 clone 在工作区根目录。provider 把三样东西藏在这个句柄
 * 后面：工作区视图、下次重连要用的令牌、以及保活调用。
 */
export interface ProvisionedSandbox {
  readonly workspace: ManagedWorkspace;
  /**
   * 把工作区存一份下来，下次还能恢复成这个样子。**只有[本地沙盒](../../../../docs/terms.md)
   * 需要**——云沙盒的文件本来就在云上，重连就回来了。每轮收尾调一次（`SandboxManager.persist`）。
   */
  persist?(): Promise<void>;
  /** 落库保存，下次重连要用：Vercel 是沙盒名（= 传进来的那个令牌），E2B 是新分配的 sandboxId。 */
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
  /**
   * 这一档有没有 git 与网络。
   *
   * `false` 时建盒之后**不装 skill、不配 git、不开分支**——那三步都要联网，在
   * [本地沙盒](../../../../docs/terms.md)里一定失败，而它本来也不需要：没有仓库可拉。
   */
  readonly usesGit: boolean;
  /** 新建一个沙盒，仓库 clone 在工作区根目录。 */
  create(params: CreateSandboxParams): Promise<ProvisionedSandbox>;
  /** 用之前落库的令牌重连；返回 `unavailable` 就由调用方重新创建。 */
  resume(
    resumeToken: string,
    keepAlive: KeepAliveOptions,
  ): Promise<ResumeResult>;
  /**
   * 这个错误是不是意味着「这个句柄背后的沙盒已经没了/不能用了」（被暂停且连不回来、
   * 已停机、已删除、从来就不存在）？
   *
   * 放在 provider 上，是因为每家 SDK 的表达方式都不一样（Vercel 是 `APIError` 的
   * 404/410；E2B 是 `SandboxNotFoundError`，或者一个消息写着 "Sandbox … not found" 的
   * 普通 `Error`）。
   *
   * 它刻意放进**接口**而不是做成 provider 内部的私有辅助函数：manager 需要给**任何**
   * 操作抛出的失败分类——对一个过期句柄调 `ensureLifetime`、对一个被暂停的沙盒跑
   * `exec`——不只是 `resume()` 那一处。只在 `resume()` 里判的话，一个悄悄过期的缓存句柄
   * 会把裸 404 直接甩给调用方，而且永远自愈不了（docs/host/contract/plans/sandbox-provider.md SP-7）。
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

/** 404（「这个沙盒名从来没被创建过」）或 410（「已停机，而且 Vercel 没能从快照恢复」）都意味着「重新创建一个」。 */
function isRecoverableGetFailure(error: unknown): boolean {
  return (
    error instanceof APIError &&
    (error.response.status === 404 || error.response.status === 410)
  );
}

/** 把一个活着的 `@vercel/sandbox` 实例包成 `ProvisionedSandbox`（沙盒名就是重连令牌；保活在适配器内部做）。 */
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
    usesGit: true,
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
        persistent: true, // 「休眠 = 交给 Vercel 自己超时打快照」的前提条件（docs/ingress/tech/chat-webapp.md §1.4/§2.2）
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
 * E2B 沙盒里仓库 clone 到哪，工作区根就是哪。
 *
 * E2B 不像 Vercel，创建时没法指定 git 源，所以 `create()` 之后要自己跑一次
 * `git clone`。把工作区根锚在这个目录上，那些以 cwd `'/'` 跑的共用初始化/分支命令
 * （装 skill、配 git、fetch/checkout）就和 Vercel 的根目录一样，正好落在仓库里
 * （docs/host/contract/tech/sandbox-provider.md §1/§3）。
 */
const E2B_WORKSPACE_ROOT = '/home/user/repo';

/** E2B 沙盒已经没了（被删、快照恢复不了）→ 当作 `unavailable` 重新创建，与 Vercel 的 404/410 对齐。这里做的是结构化判断（宿主与包各自装了一份 `e2b`，所以不能用 `instanceof`）：按名字认 e2b 自己的 `SandboxNotFoundError`/`NotFoundError`（它们的构造函数里会设 `this.name`），再加一张消息网兜住 e2b 另一条抛普通 `Error("Sandbox … not found")` 的路（dist/index.js 约 L4347）。"Invalid sandbox ID"（400，令牌本身是坏的）刻意**不**匹配——那是真 bug，该暴露出来，不该悄悄重建。 */
function isE2bSandboxGone(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === 'SandboxNotFoundError' || error.name === 'NotFoundError') {
    return true;
  }
  return /sandbox\b.*\bnot found/i.test(error.message);
}

/** `resume` 里那次 `connect` 的重试预算（见下面的 `resume`）。 */
const E2B_RESUME_ATTEMPTS = 4;
const E2B_RESUME_BACKOFF_MS = 500;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** 把一个活着的 `e2b` 沙盒包成 `ProvisionedSandbox`（sandboxId 就是重连令牌；保活在适配器内部做）。 */
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

/** 把 `https://github.com/owner/repo.git` 改写成 `https://x-access-token:$GH_TOKEN@github.com/...`。`$GH_TOKEN` 保持字面量不展开——由沙盒里的 shell 从 `Sandbox.create` 的 `envs` 设进去的环境变量展开，绝不把 PAT 拼进命令字符串（与 `remoteAuth` 同一套纪律）。 */
function withTokenAuth(cloneUrl: string): string {
  return cloneUrl.replace(/^https:\/\//, 'https://x-access-token:$GH_TOKEN@');
}

export function createE2bProvider(): SandboxProvider {
  return {
    id: 'e2b',
    usesGit: true,
    async create(params: CreateSandboxParams): Promise<ProvisionedSandbox> {
      const apiKey = requireEnv('E2B_API_KEY');
      const sandbox = await E2bSandbox.create({
        apiKey,
        // 用我们自己的模板，而不是 E2B 自带的 `base`——这是唯一能拿到超过 base 那
        // 512 MiB 内存的办法，而 `npm install` 一跑就爆（资源规格是模板构建时定死的，
        // 见 e2b-template.ts）。
        template: resolveE2bTemplate(),
        timeoutMs: params.timeoutMs,
        // 与 Vercel 的 `persistent` 对齐：闲置超时自动暂停 + 来流量自动恢复（整份内存快照）。docs/host/contract/tech/sandbox-provider.md §5。
        lifecycle: { onTimeout: 'pause', autoResume: true },
        envs: { GH_TOKEN: params.githubPat },
        metadata: { name: params.name },
      });
      // E2B 创建时没法指定 git 源——现在把仓库 clone 进工作区根目录。
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
      // 刚刚自动暂停（lifecycle.onTimeout:'pause'）的沙盒，在平台落定暂停快照的那一小
      // 会儿里，`connect` 可能短暂返回 404——真机验收时实测到过
      // （docs/host/contract/plans/sandbox-provider.md SP-6）：沙盒其实还在，几秒后就连得上。
      //
      // 所以先重试几次再下「它没了」的结论。**持续**的 not-found 才意味着要重建，而重建
      // 会丢掉还没推送的改动，绝不能被一次瞬时抖动触发。
      // `connect` 会自动把暂停的沙盒恢复起来（lifecycle.autoResume）。
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

// ---- 宿主侧初始化脚本（装 skill + 配 git），只在（重新）创建时跑 ----

interface InitScripts {
  installSkill: string;
  cloneFallback: string;
  gitIdentity: string;
  remoteAuth: string;
  gitExclude: string;
}

/** 与 examples/12 的 `buildInitPlan` 同样那六条命令（docs/host/contract/tech/sandbox.md §2.3/§2.4），不含默认分支探测——那一步单独放在 `detectDefaultBranch` 里。 */
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
    // PAT 由沙盒自己的 $GH_TOKEN 环境变量（创建时设进去的）提供，绝不在这里拼进字符串。
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

  await runScript(workspace, scripts.installSkill, 5 * 60_000); // 尽力而为——下面的 cloneFallback 才是真正的成功判据
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

  await runScript(workspace, scripts.gitExclude); // 尽力而为，失败也不致命
}

/** 恢复会话分支：之前推送过就 `git fetch && checkout`，没推送过就新建一条。全新会话与快照过期两种情况都走这里（见文件头）。 */
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

/** 把 `git symbolic-ref refs/remotes/origin/HEAD` 的标准输出（形如 "refs/remotes/origin/main\n"）截成 "main"。 */
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

// ---- SandboxManager：acquire/touch/release 状态机 ----

export interface AcquireInput {
  conversationId: string;
  provider: SandboxProviderId;
  sandboxName: string;
  /** 仓库那一组：只有会用 git 的档（云沙盒）才需要；[本地沙盒](../../../../docs/terms.md)一律不传。 */
  branchName?: string;
  repoCloneUrl?: string;
  repoOwner?: string;
  repoName?: string;
  githubPat?: string;
  /** 之前落库的[重连令牌](docs/terms.md)：Vercel 是 sandboxName，E2B 是存下来的 sandboxId。全新会话是 `undefined`，直接走创建。 */
  resumeToken?: string;
}

/**
 * 这次 `acquire()` 实际走了文件头三态里的哪一条（docs/ingress/tech/telemetry.md §2.4）
 * ——三者的耗时量级差着两个数量级（`cache` 零远程调用、`resume` 一次连接 +
 * 续期 + 一次 `git` 探测、`create` 还要 clone + 装 skill + 切分支），是「这一轮
 * 起得慢」时第一个要看的字段。纯观测用途：调用方不得据此改变行为，三态返回的
 * `AcquiredSandbox` 在功能上完全等价。
 */
export type AcquireMode = 'cache' | 'resume' | 'create';

export interface AcquiredSandbox {
  workspace: RunkoFS & RunkoExec;
  defaultBranch: string;
  /** 当前的重连令牌，由路由负责落库（E2B 的 sandboxId 只有创建之后才知道；Vercel 的等于沙盒名，落库等于没变）。 */
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
  /**
   * 把工作区存一份下来（只有[本地沙盒](../../../../docs/terms.md)有这回事，其余档是空操作）。
   * 每轮收尾调一次；这个会话此刻没有活沙盒时什么都不做。
   */
  persist(conversationId: string): Promise<void>;
  /** 把进程内的缓存项踢掉（不发任何远程调用）——逼下一次 `acquire()` 重新走一遍 `SandboxProvider.resume()`。 */
  release(conversationId: string): void;
}

interface ActiveSandbox {
  provisioned: ProvisionedSandbox;
  defaultBranch: string;
  /** 产出 `provisioned` 的那个 provider——后续在这个句柄上的操作抛错时，要靠它来分类（`isGone`）。 */
  provider: SandboxProvider;
  /**
   * 预计平台侧超时会在什么时候触发，也就是最后一次 create/resume/续期的时刻 +
   * `idleTimeoutMs`。
   *
   * 它是缓存的失效时钟：过了这个点就认为句柄已经过期，`acquire()` 会重新走一遍
   * `resume()`，而不是把一个已经死掉的沙盒交出去。
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

  /** 记一笔：平台侧的到期时刻刚被推到「现在 + `idleTimeoutMs`」。 */
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
         * 保活的**唯一**可观测出口（docs/logic/orchestration/features/sandbox-keepalive.md §3.5）：
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

  /** 返回还没过平台到期时刻的缓存项；过期的返回 `undefined`（并顺手踢掉）。 */
  function liveEntry(conversationId: string): ActiveSandbox | undefined {
    const entry = active.get(conversationId);
    if (entry === undefined) {
      return undefined;
    }
    if (Date.now() < entry.expiresAt) {
      return entry;
    }
    // 认为平台侧已经暂停/过期了。在这里丢掉它，下一次 acquire() 才会去重连，而不是
    // 交出一个每次调用都 404 的句柄（docs/host/contract/plans/sandbox-provider.md SP-7 层 2）。
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
    // 第 1 态：缓存里那个句柄还在平台到期时刻之内。
    // 这里用 `liveEntry` 而不是 `active.get`，是为了不出现「平台早把沙盒暂停了，进程还
    // 在高高兴兴复用那个句柄」。
    const cached = liveEntry(input.conversationId);
    if (cached !== undefined) {
      return toAcquired(cached, 'cache');
    }

    const provider = resolveProvider(input.provider);

    // 第 2 态：用落库的令牌把已有快照恢复出来。
    if (input.resumeToken !== undefined) {
      const resumed = await provider.resume(
        input.resumeToken,
        keepAliveOptionsFor(input.conversationId),
      );
      if (resumed.kind === 'ok') {
        // 显式把到期时刻往后推，而不是去猜平台在 resume 时做了什么——这样
        // `expiresAt` 对两家都是真话（E2B 的自动恢复会把倒计时重置，且有 5 分钟下限；
        // Vercel 的 `get` 没有这种承诺）。代价是多一次调用，且只在 resume 这条路上，
        // 缓存命中时不会发生。
        try {
          await resumed.sandbox.ensureLifetime(idleTimeoutMs);
        } catch (error) {
          // 在 connect 与续期之间，平台正好把它拆了——落到创建那条路，而不是把一个
          // 死句柄交回去。
          if (!provider.isGone(error)) {
            throw error;
          }
          log.warn(LOG_SCOPE, 'resumed sandbox vanished before keepalive', {
            conversationId: input.conversationId,
          });
          return await createAndRegister(input, provider);
        }
        const defaultBranch =
          provider.usesGit ?
            await detectDefaultBranch(resumed.sandbox.workspace)
          : '';
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

    // 第 3 态：全新会话，或快照恢复不了 → 创建 + 重跑初始化 + 恢复分支。
    return await createAndRegister(input, provider);
  }

  async function createAndRegister(
    input: AcquireInput,
    provider: SandboxProvider,
  ): Promise<AcquiredSandbox> {
    const provisioned = await provider.create({
      name: input.sandboxName,
      cloneUrl: input.repoCloneUrl ?? '',
      githubPat: input.githubPat ?? '',
      timeoutMs: idleTimeoutMs,
      keepAlive: keepAliveOptionsFor(input.conversationId),
    });
    // 没有 git 的档（本地沙盒）跳过这三步：它们都要联网，而那一档没有仓库可拉。
    let defaultBranch = '';
    if (provider.usesGit) {
      await installSkillAndConfigureGit(
        provisioned.workspace,
        input.repoOwner ?? '',
        input.repoName ?? '',
      );
      defaultBranch = await detectDefaultBranch(provisioned.workspace);
      await recoverSessionBranch(provisioned.workspace, input.branchName ?? '');
    }

    const entry: ActiveSandbox = {
      provisioned,
      defaultBranch,
      provider,
      expiresAt: 0,
    };
    markAlive(entry); // create() 已经把平台超时设成了 idleTimeoutMs
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
     * 缓存失效的「被动」那一半（`acquire` 里的 TTL 检查是主动那一半）。
     *
     * 时钟会漂、平台可能提前暂停、沙盒也可能被带外删掉，所以一个「gone」错误同样被当作
     * 「这个缓存句柄已经死了」的证据：踢掉缓存项，下一次 `acquire()` 就会去重连。
     *
     * 但仍然把错误重新抛出——这次调用确实失败了，是否致命由各个调用方自己决定
     * （审批/提问那两条路由刻意吞掉它）。
     */
    ensureLifetime: extendDeadline,
    async persist(conversationId: string): Promise<void> {
      await active.get(conversationId)?.provisioned.persist?.();
    },
    release(conversationId: string): void {
      evict(conversationId);
    },
  };
}
