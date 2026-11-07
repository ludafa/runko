/**
 * better-auth 接 D1。与 Node 版同一套配置（邮箱密码、可选 GitHub 登录、限流计数存库），
 * 只换了库实例。
 *
 * 实例按「D1 绑定 + 对外地址」缓存在 isolate 里：建一个 better-auth 实例要编译一遍插件与
 * 路由，不该每个请求都做。
 */
import { betterAuth } from 'better-auth';
import { isAPIError } from 'better-auth/api';

import type { GithubLogin } from './auth-options.js';
import { authOptions } from './auth-options.js';
import { chatDb } from './db/instance.js';
import type { Env } from './env.js';

function githubLogin(env: Env): GithubLogin | undefined {
  const clientId = env.GITHUB_CLIENT_ID?.trim();
  const clientSecret = env.GITHUB_CLIENT_SECRET?.trim();
  if (
    clientId === undefined ||
    clientId.length === 0 ||
    clientSecret === undefined ||
    clientSecret.length === 0
  ) {
    return undefined;
  }
  return { clientId, clientSecret };
}

/** 登录页问「GitHub 登录开没开」。 */
export function githubLoginEnabled(env: Env): boolean {
  return githubLogin(env) !== undefined;
}

type Auth = ReturnType<typeof betterAuth>;

const instances = new WeakMap<D1Database, Map<string, Auth>>();

/**
 * 拿 better-auth 实例。`origin` 是这次请求的来源（`https://host`）：配了 `SERVER_URL` 就用它，
 * 没配就用请求自己的来源，本地 `wrangler dev` 与线上域名都不用改配置。
 */
export function authFor(env: Env, origin: string): Auth {
  const baseURL = env.SERVER_URL?.trim() || origin;
  let byUrl = instances.get(env.DB);
  if (byUrl === undefined) {
    byUrl = new Map();
    instances.set(env.DB, byUrl);
  }
  const cached = byUrl.get(baseURL);
  if (cached !== undefined) {
    return cached;
  }
  const github = githubLogin(env);
  const auth = betterAuth(
    authOptions({
      db: chatDb(env.DB),
      baseURL,
      ...(env.BETTER_AUTH_SECRET !== undefined ?
        { secret: env.BETTER_AUTH_SECRET }
      : {}),
      ...(github !== undefined ? { github } : {}),
    }),
  );
  byUrl.set(baseURL, auth);
  return auth;
}

/**
 * 一个用户当前有效的 GitHub 用户令牌（better-auth 代管刷新）。没连接过 = `undefined`；
 * 别的错误原样抛——契约见共用层 `requireUserToken`。
 */
export async function getGithubUserToken(
  auth: Auth,
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
