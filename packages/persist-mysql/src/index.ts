/**
 * `@nimbo/persist-mysql`——[持久化](../../../docs/host/contract/features/persistence.md)
 * 的 MySQL（mysql2） 实现。
 *
 * **你只有一个驱动实例、没在用任何 ORM 时装这个。** 它是个薄壳：把你的驱动包成一个
 * Kysely 实例，转交给 `@nimbo/persist-kysely`。
 *
 * ```ts
 * import { createPool } from "mysql2";
 * const db = createPool({ uri: process.env.DATABASE_URL });
 *
 * await migrate(db);                    // 建表，幂等
 * createAgentRuntime(agent, { persistence: mysqlPersistence(db) });
 * ```
 *
 * **已经在用 Kysely 了？** 别用这个包——直接装 `@nimbo/persist-kysely`，把你自己的
 * 实例给它，nimbo 的三张表和你的表就在同一个实例、同一套迁移之下。
 */
import type { Persistence } from "@nimbo/agent";
import type { NimboDatabase } from "@nimbo/persist-kysely";
import { kyselyPersistence, migrate as migrateKysely } from "@nimbo/persist-kysely";
import { Kysely, MysqlDialect } from "kysely";
import type { Pool as MysqlPool } from "mysql2";

export const NIMBO_PERSIST_MYSQL_VERSION = "0.0.0" as const;

export type {
  DecisionsTable,
  LedgerTable,
  NimboDatabase,
  QueueTable,
} from "@nimbo/persist-kysely";
export { DECISIONS_TABLE, LEDGER_TABLE, QUEUE_TABLE } from "@nimbo/persist-kysely";

/** 驱动 → Kysely。本包唯一做的事。 */
function toKysely(pool: MysqlPool): Kysely<NimboDatabase> {
  return new Kysely<NimboDatabase>({ dialect: new MysqlDialect({ pool: pool }) });
}

/**
 * 建表。**你自己调**，不是包在背后偷偷跑的——什么时候建表归你（启动时？部署脚本里？）。
 * 幂等，重复调用无副作用。
 */
export async function migrate(pool: MysqlPool): Promise<void> {
  await migrateKysely(toKysely(pool), { flavor: "mysql" });
}

/** 把一个 MySQL（mysql2） 驱动装成 `Persistence`。 */
export function mysqlPersistence(pool: MysqlPool): Persistence {
  return kyselyPersistence(toKysely(pool), { flavor: "mysql" });
}
