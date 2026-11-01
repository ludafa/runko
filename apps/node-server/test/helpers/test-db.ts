import Database from 'better-sqlite3';
import { Kysely, sql, SqliteDialect } from 'kysely';

import type { Db } from '../../src/db/instance.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import type { ChatDatabase } from '../../src/db/schema.js';
import { silentLogger } from './silent-logger.js';

/**
 * 一个干净的内存库，**用真的那套建表代码**（`migrateDatabase`）建表——better-auth 的表、
 * 本应用的表、框架的表三段都在，跟线上跑的是同一份。
 */
export async function createTestDb(): Promise<Db> {
  const db = new Kysely<ChatDatabase>({
    dialect: new SqliteDialect({ database: new Database(':memory:') }),
  });
  await migrateDatabase(db, 'sqlite', silentLogger);
  return db;
}

/** 插一行用户：会话表的 `user_id` 指向它。 */
export async function seedUser(db: Db, id: string): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insertInto('user')
    .values({
      id,
      name: id,
      email: `${id}@example.com`,
      emailVerified: 1,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .execute();
}

/**
 * 直接往 better-auth 的 `account` 表插一行 `provider_id = 'github'`——
 * `GET /api/github/status` 的 `linked` 就是查这张表（见 `routes/github.ts`
 * 的 `hasLinkedGithubAccount`）。
 *
 * 这张表是 better-auth 自己迁移出来的，`ChatDatabase.account`（`db/schema.ts`）
 * 只声明了本应用会读的那三列（`id`/`userId`/`providerId`），但表上还有
 * `accountId`/`createdAt`/`updatedAt` 等 `NOT NULL` 列——直接 `insertInto('account')`
 * 会被 Kysely 的类型挡住（多出声明外的必填列），所以这里用 `sql` 标签写原生
 * INSERT，绕开这层类型声明的缺口，不引入 `as` 断言。
 */
export async function linkGithubAccount(
  db: Db,
  userId: string,
  opts: { accountId?: string } = {},
): Promise<void> {
  const now = new Date().toISOString();
  const accountId = opts.accountId ?? `${userId}-github-account`;
  await sql`
    INSERT INTO account (id, accountId, providerId, userId, createdAt, updatedAt)
    VALUES (${`account-${accountId}`}, ${accountId}, ${'github'}, ${userId}, ${now}, ${now})
  `.execute(db);
}
