/**
 * `@runko/persist-sqlite`——[持久化](../../../docs/host/contract/features/persistence.md)
 * 的 SQLite（better-sqlite3） 实现。
 *
 * **你只有一个驱动实例、没在用任何 ORM 时装这个。** 它是个薄壳：把你的驱动包成一个
 * Kysely 实例，转交给 `@runko/persist-kysely`。
 *
 * ```ts
 * import Database from "better-sqlite3";
 * const db = new Database("app.db");
 *
 * await migrate(db);                    // 建表，幂等
 * createAgentRuntime(agent, { persistence: sqlitePersistence(db) });
 * ```
 *
 * **已经在用 Kysely 了？** 别用这个包——直接装 `@runko/persist-kysely`，把你自己的
 * 实例给它，runko 的四张表和你的表就在同一个实例、同一套迁移之下。
 */
import type { Persistence } from "@runko/agent";
import type { RunkoDatabase } from "@runko/persist-kysely";
import { kyselyPersistence, migrate as migrateKysely } from "@runko/persist-kysely";
import { Kysely, SqliteDialect } from "kysely";
import type { Database as SqliteDatabase } from "better-sqlite3";

export const RUNKO_PERSIST_SQLITE_VERSION = "0.0.0" as const;

export type {
  DecisionsTable,
  LedgerTable,
  RunkoDatabase,
  QueueTable,
} from "@runko/persist-kysely";
export { DECISIONS_TABLE, LEDGER_TABLE, QUEUE_TABLE } from "@runko/persist-kysely";

/** 驱动 → Kysely。本包唯一做的事。 */
function toKysely(database: SqliteDatabase): Kysely<RunkoDatabase> {
  return new Kysely<RunkoDatabase>({ dialect: new SqliteDialect({ database: database }) });
}

/**
 * 建表。**你自己调**，不是包在背后偷偷跑的——什么时候建表归你（启动时？部署脚本里？）。
 * 幂等，重复调用无副作用。
 */
export async function migrate(database: SqliteDatabase): Promise<void> {
  await migrateKysely(toKysely(database), { flavor: "sqlite" });
}

/** 把一个 SQLite（better-sqlite3） 驱动装成 `Persistence`。 */
export function sqlitePersistence(database: SqliteDatabase): Persistence {
  return kyselyPersistence(toKysely(database), { flavor: "sqlite" });
}
