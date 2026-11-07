/**
 * Node 版才有的两档云沙盒：Vercel（`@vercel/sandbox`）与 E2B（`@runko/sandbox-e2b`）。
 *
 * 与厂商无关的那部分（`acquire` 状态机、初始化脚本、本地沙盒）在共用层
 * `@runko-chat/shared/agent/sandbox-manager`；这里只放碰厂商 SDK 的实现，以及「这台服务端
 * 配得起哪几档」的判断——它要读 Vercel / E2B 的 key，只有 Node 版关心。
 */
import type { KeepAliveOptions } from '@runko/core';
import { e2bWorkspace } from '@runko/sandbox-e2b';
import type { VercelSandboxLike } from '@runko/sandbox-vercel';
import { vercelWorkspace } from '@runko/sandbox-vercel';
import { isGithubAppConfigured } from '@runko-chat/shared/agent/github-app';
import type {
  CreateSandboxParams,
  ProvisionedSandbox,
  ResumeResult,
  SandboxProvider,
  SandboxProviderId,
} from '@runko-chat/shared/agent/sandbox-manager';
import {
  forwardKeepAlive,
  withTokenAuth,
} from '@runko-chat/shared/agent/sandbox-manager';
import type { EnvLike } from '@runko-chat/shared/env';
import { processEnv } from '@runko-chat/shared/env';
import { APIError, Sandbox } from '@vercel/sandbox';
import { Sandbox as E2bSandbox } from 'e2b';

import { resolveE2bTemplate } from './e2b-template.js';

/**
 * 这台服务端能用哪几档[沙盒 provider](docs/terms.md)：云沙盒要**自己的 key 并且配了
 * GitHub App**——没有 App 就没法给沙盒签仓库令牌，选了也建不成会话
 * （docs/ingress/tech/github-repo-access.md §5）。[本地沙盒](docs/terms.md)永远能用。
 */
export function availableProviders(
  env: EnvLike = processEnv(),
): SandboxProviderId[] {
  const ids: SandboxProviderId[] = [];
  const githubReady = isGithubAppConfigured(env);
  if (githubReady && (env.VERCEL_TOKEN?.trim() ?? '').length > 0) {
    ids.push('vercel');
  }
  if (githubReady && (env.E2B_API_KEY?.trim() ?? '').length > 0) {
    ids.push('e2b');
  }
  ids.push('local');
  return ids;
}

/**
 * 建会话的请求没指定 provider 时用哪一档。
 *
 * `SANDBOX_PROVIDER` 点名了、而且这台服务端真配得起它，就听它的；否则挑配得起的第一档——
 * 什么 key 都没配时那就是[本地沙盒](docs/terms.md)，于是零配置也能建会话。云沙盒还要配了
 * GitHub App 才算配得起（`availableProviders`），点名了却没配齐的不能硬给。
 */
export function resolveDefaultProvider(
  env: EnvLike = processEnv(),
): SandboxProviderId {
  const named = env.SANDBOX_PROVIDER?.trim().toLowerCase();
  const available = availableProviders(env);
  const match = available.find((id) => id === named);
  return match ?? available[0] ?? 'local';
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
          password: params.githubToken,
          depth: 1,
        },
        // 不设沙盒级 `GH_TOKEN`：它建盒时定死、过期后改不了，还会误导 agent 去用一把
        // 失效的令牌（docs/ingress/tech/github-repo-access.md §4）。令牌只在这次 `source`
        // 里过一道，随后靠 git 凭据助手读令牌文件（`installSkillAndConfigureGit`）。
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
        // 不设沙盒级 `envs`——理由同 Vercel 那边（见上）。令牌只在下面这一条克隆命令的
        // `envs` 里出现，那是这条命令自己的环境变量，不影响这个沙盒之后的任何一次调用。
        metadata: { name: params.name },
      });
      // E2B 创建时没法指定 git 源——现在把仓库 clone 进工作区根目录。
      const clone = await sandbox.commands.run(
        `git clone --depth 1 ${withTokenAuth(params.cloneUrl)} ${E2B_WORKSPACE_ROOT}`,
        { timeoutMs: 2 * 60_000, envs: { GH_TOKEN: params.githubToken } },
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
