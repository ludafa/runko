/**
 * Worker 与会话对象拿到的 `env`：三个绑定（D1、会话对象、沙盒）加一组字符串配置。
 *
 * 字符串配置（`wrangler.jsonc` 的 `vars` 与 `wrangler secret`）和 Node 版的环境变量**同名**，
 * 共用层里读配置的函数吃的是 `EnvLike`，用 `textEnv` 把绑定剥掉再交过去。
 */
import type { Sandbox } from '@cloudflare/sandbox';
import type { EnvLike } from '@runko-chat/shared/env';

import type { ConversationObject } from './conversation-object.js';

export interface Env {
  DB: D1Database;
  CONVERSATION: DurableObjectNamespace<ConversationObject>;
  /** 没配容器（或本地没有 Docker）时不存在——这时只提供本地沙盒。 */
  Sandbox?: DurableObjectNamespace<Sandbox>;
  ASSETS?: Fetcher;
  /** better-auth 的签名密钥。线上必填（`wrangler secret put BETTER_AUTH_SECRET`）。 */
  BETTER_AUTH_SECRET?: string;
  /** 对外的地址（如 `https://chat.example.com`）——better-auth 拼回调地址用。不配就用请求自己的来源。 */
  SERVER_URL?: string;
  /** `off` = 即使绑定了沙盒也不提供 Cloudflare 沙盒（本地没有 Docker 时用）。 */
  CLOUDFLARE_SANDBOX?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
}

/** `env` 里的字符串项——交给共用层那些读配置的函数。绑定（对象）一律剥掉。 */
export function textEnv(env: object): EnvLike {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') {
      out[key] = value;
    }
  }
  return out;
}

/** 这台服务端能不能开 Cloudflare 沙盒。 */
export function cloudflareSandboxEnabled(env: Env): boolean {
  return env.Sandbox !== undefined && env.CLOUDFLARE_SANDBOX?.trim() !== 'off';
}
