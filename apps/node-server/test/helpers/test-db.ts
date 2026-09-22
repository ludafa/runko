import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';

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
