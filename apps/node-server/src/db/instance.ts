/**
 * 进程里那一个数据库连接。
 *
 * **配了 `DATABASE_URL` 就是 Postgres，没配就是 SQLite 文件。** 两档共用同一份查询代码
 * （Kysely），差别只在这个文件里：接哪个驱动、列类型按哪种方言建（见 `migrations.ts`）。
 *
 * **三件事值得说：**
 *
 * ① **用到时才真的打开库。** Kysely 实例本身不连库，底下的驱动也做成「第一次查询时才建」
 *    ——`generate:openapi` 会 import 整个 app，生成接口文档时不该在磁盘上凭空造出一个
 *    库文件、也不该去连一个可能还没起来的 Postgres。
 *
 * ② **认出旧版库就罢工**（只对 SQLite）。旧版用的是 drizzle 那套表，跟现在的表结构不兼容。
 *    建表语句是「表不存在才建」，所以旧库里同名的表照样在，新代码会在旧表上跑，缺哪一列
 *    要到某次查询才炸。这里当场报错，并告诉人怎么办——**不自动删、也不自动迁，删数据只能
 *    由人来做。**
 *
 * ③ **哪种库就只加载哪个驱动。** 两个驱动都是运行时才 `import` 进来的：跑 Postgres 的部署
 *    根本不会碰 better-sqlite3（一个原生模块，某些平台上装不起来），反过来也一样。
 *
 * ④ **Postgres 的大整数当数字读。** 毫秒时间戳存在 `bigint` 列里，pg 驱动缺省把它读成
 *    字符串（怕溢出）。时间戳离 2^53 还差着几千年，所以就地配一个解析器读成 number，
 *    省得每个取值点都要记得转一次。
 */
import type { Flavor } from '@runko/persist-kysely';
import type Database from 'better-sqlite3';
import { Kysely, PostgresDialect, SqliteDialect } from 'kysely';
import type pg from 'pg';

import type { ChatDatabase } from './schema.js';

/** SQLite 库文件的位置。 */
const SQLITE_PATH = process.env.DATABASE_PATH ?? 'data.db';

/** 配了它就走 Postgres。 */
const DATABASE_URL = process.env.DATABASE_URL?.trim();

/** 旧版（drizzle）库的记号：它的迁移记录表。 */
const LEGACY_MARKER_TABLE = '__drizzle_migrations';

/** Postgres 的 `bigint` 类型号；pg 缺省把它读成字符串。 */
const PG_INT8_OID = 20;

/** 这个 Kysely 实例接的是哪一家——`@runko/persist-kysely` 与建表语句都要按它分方言。 */
export const flavor: Flavor =
  DATABASE_URL === undefined || DATABASE_URL.length === 0 ?
    'sqlite'
  : 'postgres';

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

async function openSqlite(): Promise<Database.Database> {
  const { default: BetterSqlite3 } = await import('better-sqlite3');
  const sqlite = new BetterSqlite3(SQLITE_PATH);
  sqlite.pragma('journal_mode = WAL');
  assertNotLegacy(sqlite, SQLITE_PATH);
  return sqlite;
}

async function openPostgres(connectionString: string): Promise<pg.Pool> {
  const { Pool, TypeOverrides } = await import('pg');
  const types = new TypeOverrides();
  types.setTypeParser(PG_INT8_OID, (value: string) => Number(value));
  return new Pool({ connectionString, types });
}

function createDialect(): SqliteDialect | PostgresDialect {
  if (DATABASE_URL !== undefined && DATABASE_URL.length > 0) {
    const url = DATABASE_URL;
    return new PostgresDialect({ pool: () => openPostgres(url) });
  }
  return new SqliteDialect({ database: () => openSqlite() });
}

/**
 * 本应用的表、better-auth 的表、框架的表**共用这一个实例**（见 `schema.ts` 的文件头）。
 * 框架那边吃的是同一个东西：`kyselyPersistence(db, { flavor })`、`leaseArbitration(db, …)`。
 */
export const db = new Kysely<ChatDatabase>({ dialect: createDialect() });

/** 全应用共用的连接类型——测试里换成一个内存库的实例，形状一样。 */
export type Db = Kysely<ChatDatabase>;
