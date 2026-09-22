import type { BetterAuthOptions } from 'better-auth';
import { betterAuth } from 'better-auth';

import { db, flavor } from './db/instance.js';

const clientUrl =
  process.env.CLIENT_URL ??
  `http://localhost:${process.env.CLIENT_PORT ?? 5173}`;

const trustedOrigins = [clientUrl];

/**
 * 单独导出一份配置，是因为建表也要用它：`db/migrate.ts` 把它交给 better-auth 的
 * `getMigrations`，由 better-auth 自己建自己的表。
 *
 * **数据库传的是实例（`{ db, type }`），不是方言对象。** better-auth 内部会拿 `instanceof`
 * 认方言，而它依赖的 kysely 与本仓的不是同一份拷贝，认不出来；给实例这条路不做这个判断。
 *
 * **限流计数存库**（缺省是进程内存）：多副本时每个副本各数各的，限额会变成副本数的倍数。
 */
export const authOptions = {
  baseURL: process.env.SERVER_URL ?? 'http://localhost:3000',
  database: { db, type: flavor },
  emailAndPassword: {
    enabled: true,
  },
  socialProviders:
    process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET ?
      {
        github: {
          clientId: process.env.GITHUB_CLIENT_ID,
          clientSecret: process.env.GITHUB_CLIENT_SECRET,
        },
      }
    : undefined,
  rateLimit: { storage: 'database' },
  trustedOrigins,
} satisfies BetterAuthOptions;

export const auth = betterAuth(authOptions);
