/**
 * GitHub App 客户端（docs/ingress/tech/github-repo-access.md §3/§6）。
 *
 * 两种身份、两套令牌：
 *
 * - **用户令牌**：better-auth 的 `account` 表管，本文件只管拿到手之后怎么用——问 GitHub
 *   「这个用户能看到哪些装了 App 的仓库」（`listUserInstallations`/`listInstallationRepos`）。
 * - **安装令牌**：本文件自己签发。用私钥签一张 App JWT（RS256，Node 自带 `crypto`，
 *   不引新依赖），拿它换一把只对**一个仓库**有效、1 小时过期的安装令牌
 *   （`mintInstallationToken`）。
 *
 * `createGithubApp()` 把两者接起来：`getRepoToken()` 是每一轮真正调用的那个入口——
 * 缓存命中直接给；没命中就先用用户令牌核对一次权限，权限还在才签新的（§3.3）。
 * `fetch`/`getUserToken`/`now` 都是可注入的（测试用假 GitHub、假用户令牌源）。
 */
import { createSign } from 'node:crypto';

import { isAPIError } from 'better-auth/api';
import { z } from 'zod';

import { auth } from '../auth.js';

const DEFAULT_GITHUB_API_URL = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';

/** App JWT 的时钟容忍与有效期（GitHub 上限 10 分钟）——iat 往前留一分钟防时钟偏差，exp 给 9 分钟。 */
const APP_JWT_ISSUED_AT_SKEW_SECONDS = 60;
const APP_JWT_TTL_SECONDS = 9 * 60;

/**
 * 安装令牌剩余不到这个数就重签一把（docs/ingress/tech/github-repo-access.md §2）。令牌只在起轮时写进沙盒，
 * 一轮里要一直能用——留足 50 分钟，一轮跑得久、或者停下来等人审批 `git push`，推送也不会撞上过期。
 */
const INSTALLATION_TOKEN_MIN_TTL_MS = 50 * 60 * 1000;

/** GitHub 列表接口的分页步长（两个 `/repositories` 端点的上限都是 100）。 */
const REPOS_PER_PAGE = 100;

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

export interface GithubAppConfig {
  readonly appId: string;
  readonly appSlug: string;
  readonly privateKey: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly apiUrl: string;
}

/** 私钥允许把真实换行写成字面量 `\n`（部署平台的环境变量常这么存），两种写法都认。 */
function normalizePrivateKey(raw: string): string {
  return raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
}

/**
 * 懒读 `GITHUB_APP_*`/`GITHUB_CLIENT_*`（同 `model.ts` 的纪律：不在
 * 模块加载期读，测试/`generate:openapi` 才不会因为没配就炸）。五项缺一即视为未配置——
 * 少了 client id/secret，用户根本连不上 GitHub，App 也就没法用。
 */
export function loadGithubAppConfig(
  env: NodeJS.ProcessEnv = process.env,
): GithubAppConfig | undefined {
  const appId = env.GITHUB_APP_ID?.trim();
  const appSlug = env.GITHUB_APP_SLUG?.trim();
  const rawPrivateKey = env.GITHUB_APP_PRIVATE_KEY?.trim();
  const clientId = env.GITHUB_CLIENT_ID?.trim();
  const clientSecret = env.GITHUB_CLIENT_SECRET?.trim();
  if (
    appId === undefined ||
    appId.length === 0 ||
    appSlug === undefined ||
    appSlug.length === 0 ||
    rawPrivateKey === undefined ||
    rawPrivateKey.length === 0 ||
    clientId === undefined ||
    clientId.length === 0 ||
    clientSecret === undefined ||
    clientSecret.length === 0
  ) {
    return undefined;
  }
  const apiUrlRaw = env.GITHUB_API_URL?.trim();
  return {
    appId,
    appSlug,
    privateKey: normalizePrivateKey(rawPrivateKey),
    clientId,
    clientSecret,
    apiUrl:
      apiUrlRaw !== undefined && apiUrlRaw.length > 0 ?
        apiUrlRaw.replace(/\/+$/, '')
      : DEFAULT_GITHUB_API_URL,
  };
}

export function isGithubAppConfigured(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return loadGithubAppConfig(env) !== undefined;
}

// ---------------------------------------------------------------------------
// 仓库引用——owner/name 与克隆地址
// ---------------------------------------------------------------------------

export interface GithubRepoRef {
  readonly owner: string;
  readonly repo: string;
  /** 恒为 HTTPS 形式——沙盒里没有 SSH 密钥。 */
  readonly cloneUrl: string;
}

/** 把 GitHub 的 `full_name`（`owner/repo`）拆开，顺带拼出克隆地址。 */
export function splitFullName(fullName: string): GithubRepoRef {
  const idx = fullName.indexOf('/');
  if (idx <= 0 || idx === fullName.length - 1) {
    throw new Error(`Unexpected GitHub repo full_name shape: "${fullName}"`);
  }
  const owner = fullName.slice(0, idx);
  const repo = fullName.slice(idx + 1);
  return { owner, repo, cloneUrl: `https://github.com/${owner}/${repo}.git` };
}

// ---------------------------------------------------------------------------
// 错误分类
// ---------------------------------------------------------------------------

export class GithubNotConfiguredError extends Error {
  constructor(message = 'GitHub App 未配置') {
    super(message);
    this.name = 'GithubNotConfiguredError';
  }
}

export class GithubNotLinkedError extends Error {
  constructor(message = '用户尚未连接 GitHub 账号') {
    super(message);
    this.name = 'GithubNotLinkedError';
  }
}

export class GithubRepoForbiddenError extends Error {
  constructor(message = '没有权限访问这个仓库') {
    super(message);
    this.name = 'GithubRepoForbiddenError';
  }
}

/**
 * 三种典型错误 → HTTP 状态与错误码（docs/ingress/tech/github-repo-access.md §5）的统一
 * 分类。`routes/chat.ts`、`routes/github.ts` 各自决定要不要用某一支——比如
 * `GET /api/github/repos` 永远不会撞见 `forbidden`，但复用同一份分类不费事。
 */
export type GithubErrorKind =
  'not-configured' | 'not-linked' | 'forbidden' | 'unknown';

export function classifyGithubError(error: unknown): GithubErrorKind {
  if (error instanceof GithubNotConfiguredError) {
    return 'not-configured';
  }
  if (error instanceof GithubNotLinkedError) {
    return 'not-linked';
  }
  if (error instanceof GithubRepoForbiddenError) {
    return 'forbidden';
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// App JWT（RS256，node:crypto）
// ---------------------------------------------------------------------------

function base64url(input: string | Uint8Array): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64url');
}

/** App 自己的身份令牌：签给 `POST /app/installations/:id/access_tokens` 用，别处不需要它。 */
export function mintAppJwt(
  config: GithubAppConfig,
  now: () => number = Date.now,
): string {
  const nowSeconds = Math.floor(now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      iat: nowSeconds - APP_JWT_ISSUED_AT_SKEW_SECONDS,
      exp: nowSeconds + APP_JWT_TTL_SECONDS,
      iss: config.appId,
    }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = createSign('RSA-SHA256')
    .update(signingInput)
    .sign(config.privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

// ---------------------------------------------------------------------------
// GitHub REST 调用——全部走这一个薄封装，响应一律 zod 校验
// ---------------------------------------------------------------------------

async function readBodyPreview(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.replace(/\s+/g, ' ').trim().slice(0, 200);
  } catch {
    return '';
  }
}

/** GitHub 接口回了非 2xx。带上状态码，调用方据此分辨「没权限」与真故障。 */
export class GithubApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'GithubApiError';
    this.status = status;
  }
}

interface GithubApiCallOptions {
  readonly method?: 'GET' | 'POST';
  /** 承载者令牌——App JWT 或用户令牌，调用方决定给哪个。 */
  readonly token: string;
  /** 令牌是谁的。用户令牌被 GitHub 拒（401）= 用户撤销了授权或令牌续不上，当作没连接，界面会引导重新连接。 */
  readonly as: 'app' | 'user';
  readonly body?: unknown;
}

async function callGithubApi(
  config: GithubAppConfig,
  fetchImpl: typeof fetch,
  path: string,
  opts: GithubApiCallOptions,
): Promise<unknown> {
  const response = await fetchImpl(`${config.apiUrl}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      authorization: `Bearer ${opts.token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': GITHUB_API_VERSION,
      ...(opts.body !== undefined ?
        { 'content-type': 'application/json' }
      : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  if (response.status === 401 && opts.as === 'user') {
    throw new GithubNotLinkedError();
  }
  if (!response.ok) {
    const preview = await readBodyPreview(response);
    throw new GithubApiError(
      response.status,
      `GitHub API ${opts.method ?? 'GET'} ${path} failed (HTTP ${String(response.status)})` +
        (preview.length > 0 ? `: ${preview}` : '.'),
    );
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`GitHub API ${path} returned a non-JSON response.`);
  }
}

const installationSchema = z.object({ id: z.number().int() });
const listInstallationsResponseSchema = z.object({
  installations: z.array(installationSchema),
});

const repoApiSchema = z.object({
  id: z.number().int(),
  full_name: z.string(),
  private: z.boolean(),
  default_branch: z.string(),
});
const listRepositoriesResponseSchema = z.object({
  total_count: z.number().int(),
  repositories: z.array(repoApiSchema),
});

const installationTokenResponseSchema = z.object({
  token: z.string(),
  expires_at: z.string(),
});

export interface GithubRepoSummary {
  readonly installationId: number;
  readonly repoId: number;
  readonly fullName: string;
  readonly private: boolean;
  readonly defaultBranch: string;
}

export interface GithubRepoToken {
  readonly token: string;
  /** 毫秒 epoch。 */
  readonly expiresAt: number;
}

/** 一把安装令牌连同它对应的仓库（核对权限时拿到的那份），调用方不用再单独核对一次。 */
export interface GithubRepoAccess extends GithubRepoToken {
  readonly repo: GithubRepoSummary;
}

/** `GET /user/installations`——这个用户身上挂了哪些安装。 */
export async function listUserInstallations(
  config: GithubAppConfig,
  userToken: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<number[]> {
  const raw = await callGithubApi(config, fetchImpl, '/user/installations', {
    token: userToken,
    as: 'user',
  });
  const parsed = listInstallationsResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      'GitHub API /user/installations returned an unexpected shape.',
    );
  }
  return parsed.data.installations.map((installation) => installation.id);
}

/** `GET /user/installations/:id/repositories`，翻到底——这个用户在这次安装里勾过的全部仓库。 */
export async function listInstallationRepos(
  config: GithubAppConfig,
  userToken: string,
  installationId: number,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<GithubRepoSummary[]> {
  const repos: GithubRepoSummary[] = [];
  let page = 1;
  for (;;) {
    const raw = await callGithubApi(
      config,
      fetchImpl,
      `/user/installations/${String(installationId)}/repositories?per_page=${String(REPOS_PER_PAGE)}&page=${String(page)}`,
      { token: userToken, as: 'user' },
    );
    const parsed = listRepositoriesResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `GitHub API /user/installations/${String(installationId)}/repositories returned an unexpected shape.`,
      );
    }
    for (const repo of parsed.data.repositories) {
      repos.push({
        installationId,
        repoId: repo.id,
        fullName: repo.full_name,
        private: repo.private,
        defaultBranch: repo.default_branch,
      });
    }
    const seenSoFar = page * REPOS_PER_PAGE;
    if (
      parsed.data.repositories.length < REPOS_PER_PAGE ||
      seenSoFar >= parsed.data.total_count
    ) {
      return repos;
    }
    page += 1;
  }
}

/** 这个用户在这次安装里，是否真的挂着这个仓库——核对权限用（建会话时、令牌快过期重签时）。 */
export async function userCanAccessRepo(
  config: GithubAppConfig,
  userToken: string,
  installationId: number,
  repoId: number,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<GithubRepoSummary | undefined> {
  let repos: GithubRepoSummary[];
  try {
    repos = await listInstallationRepos(
      config,
      userToken,
      installationId,
      fetchImpl,
    );
  } catch (error) {
    // 用户已经不在这个安装里（退出了组织、安装被卸载）：GitHub 对这个安装回 404。
    if (error instanceof GithubApiError && error.status === 404) {
      return undefined;
    }
    throw error;
  }
  return repos.find((repo) => repo.repoId === repoId);
}

/** 跨全部安装列出这个用户勾过的仓库——`GET /api/github/repos` 的数据源。 */
export async function listAccessibleRepos(
  config: GithubAppConfig,
  userToken: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<GithubRepoSummary[]> {
  const installationIds = await listUserInstallations(
    config,
    userToken,
    fetchImpl,
  );
  // 各个安装互不依赖，并发问。
  const perInstallation = await Promise.all(
    installationIds.map((installationId) =>
      listInstallationRepos(config, userToken, installationId, fetchImpl),
    ),
  );
  return perInstallation.flat();
}

/** 用 App JWT 换一把只对 `repoId` 这一个仓库有效的安装令牌（1 小时过期，`contents:write`+`metadata:read`）。 */
export async function mintInstallationToken(
  config: GithubAppConfig,
  installationId: number,
  repoId: number,
  fetchImpl: typeof fetch = globalThis.fetch,
  now: () => number = Date.now,
): Promise<GithubRepoToken> {
  const jwt = mintAppJwt(config, now);
  const raw = await callGithubApi(
    config,
    fetchImpl,
    `/app/installations/${String(installationId)}/access_tokens`,
    {
      method: 'POST',
      token: jwt,
      as: 'app',
      body: {
        repository_ids: [repoId],
        permissions: { contents: 'write', metadata: 'read' },
      },
    },
  );
  const parsed = installationTokenResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      'GitHub API POST .../access_tokens returned an unexpected shape.',
    );
  }
  return {
    token: parsed.data.token,
    expiresAt: new Date(parsed.data.expires_at).getTime(),
  };
}

// ---------------------------------------------------------------------------
// GithubApp——有状态的那一层：默认配置源、用户令牌来源、安装令牌缓存
// ---------------------------------------------------------------------------

export interface GithubRepoSelector {
  readonly userId: string;
  readonly installationId: number;
  readonly repoId: number;
}

export interface GithubApp {
  readonly configured: boolean;
  /** `https://github.com/apps/<slug>/installations/new`；未配置时为 `undefined`。 */
  readonly installUrl: string | undefined;
  /** 这个用户勾过的全部仓库（跨全部安装）。未连接 GitHub 抛 `GithubNotLinkedError`。 */
  listAccessibleRepos(userId: string): Promise<GithubRepoSummary[]>;
  /** 核对 + 描述一个仓库：这个用户在这次安装里真能看到它。看不到抛 `GithubRepoForbiddenError`。 */
  verifyRepoAccess(selector: GithubRepoSelector): Promise<GithubRepoSummary>;
  /** 拿一把只对这个仓库有效的安装令牌：缓存命中直接给；否则重新核对权限再签发新的。 */
  getRepoToken(selector: GithubRepoSelector): Promise<GithubRepoAccess>;
}

export interface CreateGithubAppOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  /** 拿一个用户当前有效的 GitHub 用户令牌；没连接过返回 `undefined`。缺省接 better-auth。 */
  getUserToken?: (userId: string) => Promise<string | undefined>;
  now?: () => number;
}

/**
 * 生产默认的用户令牌来源：better-auth 管着 `account` 表与刷新逻辑，这里只是原样转发
 * （`auth.api.getAccessToken` 直接服务端调用，不带 headers 时按传入的 `userId` 解析，
 * 见 better-auth `resolveUserId`）。
 *
 * better-auth 以 `APIError` 报的（账号没连过 GitHub、刷新令牌失效）= 没连接，返回 `undefined`；
 * 别的错误（库连不上之类）原样抛——见 `requireUserToken` 的契约。
 */
async function defaultGetUserToken(
  userId: string,
): Promise<string | undefined> {
  try {
    const result = await auth.api.getAccessToken({
      body: { providerId: 'github', userId },
    });
    return result.accessToken;
  } catch (error) {
    if (isAPIError(error)) {
      return undefined;
    }
    throw error;
  }
}

export function createGithubApp(opts: CreateGithubAppOptions = {}): GithubApp {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  // 每次现取：不在构造时把 `Date.now` 的引用定死。
  const now = opts.now ?? ((): number => Date.now());
  const getUserToken = opts.getUserToken ?? defaultGetUserToken;
  const config = loadGithubAppConfig(env);
  /**
   * 按「用户 + 安装 + 仓库」缓存安装令牌（§2/§3.3）。键里必须有用户：同一个仓库两个人都能用时，
   * 一个人被移出仓库之后，不能再拿到另一个人缓存下来的令牌。
   */
  const tokenCache = new Map<string, GithubRepoAccess>();

  function requireConfig(): GithubAppConfig {
    if (config === undefined) {
      throw new GithubNotConfiguredError();
    }
    return config;
  }

  // 契约：`getUserToken` 返回 `undefined` = 没连接 GitHub；它抛错 = 基础设施故障，原样透出，
  // 不说成「没连接」——那会把用户引去重新连 GitHub。
  async function requireUserToken(userId: string): Promise<string> {
    const token = await getUserToken(userId);
    if (token === undefined) {
      throw new GithubNotLinkedError();
    }
    return token;
  }

  async function requireAccessibleRepo(
    cfg: GithubAppConfig,
    selector: GithubRepoSelector,
  ): Promise<GithubRepoSummary> {
    const userToken = await requireUserToken(selector.userId);
    const repo = await userCanAccessRepo(
      cfg,
      userToken,
      selector.installationId,
      selector.repoId,
      fetchImpl,
    );
    if (repo === undefined) {
      throw new GithubRepoForbiddenError();
    }
    return repo;
  }

  return {
    configured: config !== undefined,
    installUrl:
      config === undefined ? undefined : (
        `https://github.com/apps/${config.appSlug}/installations/new`
      ),

    async listAccessibleRepos(userId) {
      const cfg = requireConfig();
      const userToken = await requireUserToken(userId);
      return await listAccessibleRepos(cfg, userToken, fetchImpl);
    },

    async verifyRepoAccess(selector) {
      const cfg = requireConfig();
      return await requireAccessibleRepo(cfg, selector);
    },

    async getRepoToken(selector) {
      const cfg = requireConfig();
      const key = `${selector.userId}:${String(selector.installationId)}:${String(selector.repoId)}`;
      const cached = tokenCache.get(key);
      if (
        cached !== undefined &&
        cached.expiresAt - now() > INSTALLATION_TOKEN_MIN_TTL_MS
      ) {
        return cached;
      }
      // 缓存没有或快过期：重签前先用会话主人的用户令牌再核对一次权限
      // （docs/ingress/tech/github-repo-access.md §3.3——用户可能已经在 GitHub 上收回了这个仓库）。
      const repo = await requireAccessibleRepo(cfg, selector);
      const minted = await mintInstallationToken(
        cfg,
        selector.installationId,
        selector.repoId,
        fetchImpl,
        now,
      );
      const access: GithubRepoAccess = { ...minted, repo };
      tokenCache.set(key, access);
      return access;
    },
  };
}

/** 生产单例：env 懒读、构造本身零 I/O，`routes/chat.ts`/`routes/github.ts` 共用（令牌缓存也共享）。 */
export const defaultGithubApp: GithubApp = createGithubApp();
