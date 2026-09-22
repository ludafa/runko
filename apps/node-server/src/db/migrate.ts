/**
 * 建表：三段，顺序不能换。
 *
 * | 顺序 | 谁的表 | 谁来建 |
 * |---|---|---|
 * | ① | better-auth（`user` `session` …） | better-auth 的 `getMigrations` |
 * | ② | 本应用（`conversations` …） | `migrations.ts`，走 Kysely 的 `Migrator` |
 * | ③ | 框架（`agent_ledger` …） | `@runko/persist-kysely` 的 `migrate()` |
 *
 * ① 必须在 ② 前面：本应用的表有外键指向 `user`。
 *
 * **SQLite 在启动时自动跑一遍**（单进程，不会有两个人同时建表）；**Postgres 要显式跑
 * `db:migrate`**，副本启动时不跑——框架那段建表只有「表不存在才建」、没加锁，多个副本
 * 同时起会撞在一起。
 */
import type { Flavor } from '@runko/persist-kysely';
import { migrate as migrateRunkoTables } from '@runko/persist-kysely';
import { getMigrations } from 'better-auth/db/migration';
import { Migrator } from 'kysely/migration';

import { authOptions } from '../auth.js';
import type { Logger } from '../logger.js';
import { logger as defaultLogger } from '../logger.js';
import type { Db } from './instance.js';
import { appMigrationProvider } from './migrations.js';

const LOG_SCOPE = 'db';

/**
 * 建表。**库与方言是参数**，不是模块里那个单例——测试要对着一个一次性的内存库建同一套表，
 * 走的必须是这份代码，不能另抄一份 DDL（抄一份就会跟真的那套悄悄长歪）。
 */
export async function migrateDatabase(
  db: Db,
  flavor: Flavor,
  log: Logger = defaultLogger,
): Promise<void> {
  const authMigrations = await getMigrations({
    ...authOptions,
    database: { db, type: flavor },
  });
  await authMigrations.runMigrations();

  const migrator = new Migrator({ db, provider: appMigrationProvider(flavor) });
  const { error, results } = await migrator.migrateToLatest();
  for (const result of results ?? []) {
    if (result.status === 'Success') {
      log.info(LOG_SCOPE, 'migration applied', { name: result.migrationName });
    }
  }
  if (error !== undefined) {
    throw error instanceof Error ? error : new Error(String(error));
  }

  await migrateRunkoTables(db, { flavor });
}
