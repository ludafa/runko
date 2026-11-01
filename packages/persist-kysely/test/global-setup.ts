/**
 * 真库的表在**所有测试文件开跑之前**串行建好，测试文件里不再调 `migrate()`。
 *
 * `conformance.test.ts` 与 `arbitration.test.ts` 是并行跑的，连的又是同一个真库。
 * 两边各自建表，就是两个连接同时跑 `CREATE TABLE IF NOT EXISTS`——Postgres 上会撞
 * `pg_type` 的唯一索引报重复键（`migrate()` 注释里写着：幂等 ≠ 可并发）。
 * 表建好之后，测试只清数据，不再碰 schema。
 *
 * 没给连接串的那一档什么都不做；sqlite 与 pglite 每档自己建表，不经过这里。
 */
import { Kysely, MysqlDialect, PostgresDialect } from "kysely";

import { migrate } from "../src/index.js";
import type { RunkoDatabase } from "../src/index.js";

export default async function setup(): Promise<void> {
  const postgresUrl = process.env["RUNKO_TEST_POSTGRES_URL"];
  if (postgresUrl !== undefined) {
    const { Pool } = await import("pg");
    const db = new Kysely<RunkoDatabase>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: postgresUrl }) }) });
    try {
      await migrate(db, { flavor: "postgres" });
    } finally {
      await db.destroy();
    }
  }

  const mysqlUrl = process.env["RUNKO_TEST_MYSQL_URL"];
  if (mysqlUrl !== undefined) {
    const { createPool } = await import("mysql2");
    const db = new Kysely<RunkoDatabase>({ dialect: new MysqlDialect({ pool: createPool(mysqlUrl) }) });
    try {
      await migrate(db, { flavor: "mysql" });
    } finally {
      await db.destroy();
    }
  }
}
