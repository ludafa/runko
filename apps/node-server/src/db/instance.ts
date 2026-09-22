/**
 * 进程里那一个数据库连接。
 *
 * **两件事值得说：**
 *
 * ① **用到时才真的打开库。** Kysely 实例本身不连库，底下那个 better-sqlite3 句柄也做成
 *    「第一次查询时才建」——`generate:openapi` 会 import 整个 app，生成接口文档时不该
 *    在磁盘上凭空造出一个库文件。
 *
 * ② **认出旧版库就罢工。** 旧版用的是 drizzle 那套表，跟现在的表结构不兼容。建表语句是
 *    「表不存在才建」，所以旧库里同名的表照样在，新代码会在旧表上跑，缺哪一列要到某次
 *    查询才炸。这里当场报错，并告诉人怎么办——**不自动删、也不自动迁，删数据只能由人来做。**
 */
import type { Flavor } from '@runko/persist-kysely';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';

import type { ChatDatabase } from './schema.js';

/** SQLite 库文件的位置。 */
const SQLITE_PATH = process.env.DATABASE_PATH ?? 'data.db';

/** 旧版（drizzle）库的记号：它的迁移记录表。 */
const LEGACY_MARKER_TABLE = '__drizzle_migrations';

/** 这个 Kysely 实例接的是哪一家——`@runko/persist-kysely` 与建表语句都要按它分方言。 */
export const flavor: Flavor = 'sqlite';

export function assertNotLegacy(sqlite: Database.Database, path: string): void {
  const found = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(LEGACY_MARKER_TABLE);
  if (found === undefined) {
    return;
  }
  throw new Error(
    `${path} 是旧版本的数据库（表结构已经换掉，不兼容）。` +
      `里面的账号与会话没法直接用；确认不要了就删掉这个文件再启动，` +
      `或者把 DATABASE_PATH 指到一个新文件。`,
  );
}

function openSqlite(): Database.Database {
  const sqlite = new Database(SQLITE_PATH);
  sqlite.pragma('journal_mode = WAL');
  assertNotLegacy(sqlite, SQLITE_PATH);
  return sqlite;
}

/**
 * 本应用的表、better-auth 的表、框架的表**共用这一个实例**（见 `schema.ts` 的文件头）。
 * 框架那边吃的是同一个东西：`kyselyPersistence(db, { flavor })`、`leaseArbitration(db, …)`。
 */
export const db = new Kysely<ChatDatabase>({
  dialect: new SqliteDialect({ database: () => Promise.resolve(openSqlite()) }),
});

/** 全应用共用的连接类型——测试里换成一个内存库的实例，形状一样。 */
export type Db = Kysely<ChatDatabase>;
