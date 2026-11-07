/**
 * better-auth 的配置。与 Node 版同一套（邮箱密码、可选 GitHub 登录、限流计数存库），只换了库实例。
 *
 * 单独一个文件、不碰任何 Workers 类型：D1 的建表 SQL 由 Node 脚本（`scripts/generate-d1-migrations.ts`）
 * 拿这份配置交给 better-auth 的 `getMigrations` 生成，不手写第二份 DDL。
 */
import type { Db } from '@runko-chat/shared/db/schema';
import type { BetterAuthOptions } from 'better-auth';

export interface GithubLogin {
  clientId: string;
  clientSecret: string;
}

export interface AuthOptionsInput {
  db: Db;
  baseURL: string;
  secret?: string;
  github?: GithubLogin;
}

export function authOptions(input: AuthOptionsInput): BetterAuthOptions {
  return {
    baseURL: input.baseURL,
    ...(input.secret !== undefined ? { secret: input.secret } : {}),
    // 传实例（`{ db, type }`）而不是方言对象：理由同 Node 版的 `auth.ts`。
    database: { db: input.db, type: 'sqlite' },
    emailAndPassword: { enabled: true },
    socialProviders:
      input.github !== undefined ? { github: input.github } : undefined,
    // 计数存库：同一个 Worker 在全球很多 isolate 里跑，各数各的就等于没限。
    rateLimit: { storage: 'database' },
    // 前端与接口同源（静态资源由同一个 Worker 发），只信自己。
    trustedOrigins: [input.baseURL],
  };
}
