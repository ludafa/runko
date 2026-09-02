/**
 * `@nimbo/persist-postgres`——[持久化](../../../docs/host/contract/features/persistence.md)
 * 的 PostgreSQL（pg） 实现。
 *
 * **你只有一个驱动实例、没在用任何 ORM 时装这个。** 它是个薄壳：把你的驱动包成一个
 * Kysely 实例，转交给 `@nimbo/persist-kysely`。
 *
 * ```ts
 * import { Pool } from "pg";
 * const db = new Pool({ connectionString: process.env.DATABASE_URL });
 *
 * await migrate(db);                    // 建表，幂等
 * createAgentRuntime(agent, { persistence: postgresPersistence(db) });
 * ```
 *
 * **已经在用 Kysely 了？** 别用这个包——直接装 `@nimbo/persist-kysely`，把你自己的
 * 实例给它，nimbo 的四张表和你的表就在同一个实例、同一套迁移之下。
 */
import type { Persistence } from "@nimbo/agent";
import type { NimboDatabase } from "@nimbo/persist-kysely";
import { kyselyPersistence, migrate as migrateKysely } from "@nimbo/persist-kysely";
import { Kysely, PostgresDialect } from "kysely";
import type { Pool as PgPool } from "pg";

export const NIMBO_PERSIST_POSTGRES_VERSION = "0.0.0" as const;

export type {
  DecisionsTable,
  LedgerTable,
  NimboDatabase,
  QueueTable,
} from "@nimbo/persist-kysely";
export { DECISIONS_TABLE, LEDGER_TABLE, QUEUE_TABLE } from "@nimbo/persist-kysely";

/** 驱动 → Kysely。本包唯一做的事。 */
function toKysely(pool: PgPool): Kysely<NimboDatabase> {
  return new Kysely<NimboDatabase>({ dialect: new PostgresDialect({ pool: pool }) });
}

/**
 * 建表。**你自己调**，不是包在背后偷偷跑的——什么时候建表归你（启动时？部署脚本里？）。
 * 幂等，重复调用无副作用。
 */
export async function migrate(pool: PgPool): Promise<void> {
  await migrateKysely(toKysely(pool), { flavor: "postgres" });
}

/** 把一个 PostgreSQL（pg） 驱动装成 `Persistence`。 */
export function postgresPersistence(pool: PgPool): Persistence {
  return kyselyPersistence(toKysely(pool), { flavor: "postgres" });
}
