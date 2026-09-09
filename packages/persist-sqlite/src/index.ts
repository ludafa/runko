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
 * createAgentRuntime({ agent, prepareTurn, persistence: sqlitePersistence(db) });
 * ```
 *
 * **已经在用 Kysely 了？** 别用这个包——直接装 `@runko/persist-kysely`，把你自己的
 * 实例给它，runko 的四张表和你的表就在同一个实例、同一套迁移之下。
 */
import type { Arbitration, Persistence } from "@runko/agent";
import type { LeaseArbitrationOptions, RunkoDatabase } from "@runko/persist-kysely";
import { kyselyPersistence, leaseArbitration, migrate as migrateKysely } from "@runko/persist-kysely";
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
export { DEFAULT_HEARTBEAT_MS, DEFAULT_TAKEOVER_MS } from "@runko/persist-kysely";

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

/**
 * `sqliteArbitration()` 的入参——就是 `@runko/persist-kysely` 的那份，**去掉 `flavor`**：
 * 本包只接一家，方言不该再让调用方填一遍。
 */
export type SqliteArbitrationOptions = Omit<LeaseArbitrationOptions, "flavor">;

/**
 * 把同一个驱动装成**租约版[归属仲裁机制](../../../docs/terms.md)**——多副本部署要它。
 *
 * ```ts
 * createAgentRuntime({
 *   agent,
 *   prepareTurn,
 *   persistence: sqlitePersistence(database),
 *   arbitration: sqliteArbitration(database, { holder: process.env.RUNKO_NODE_URL }),
 * });
 * ```
 *
 * **`holder` 是你这个副本的可达地址**，框架原样存、原样传、**不解释它**：别的副本抢不到
 * 归属时会拿到它，由[接入层](../../../docs/terms.md)决定把请求转给谁。转发是宿主写的，
 * 不是框架做的。
 *
 * 两件事值得先知道：
 *
 * 1. `sqlitePersistence()` 与本函数会各建一个 Kysely 实例。Kysely 是查询构建器、
 *    连接池是你给的那个驱动，**两个实例共用同一个池**，不多占资源。
 * 2. **`migrate()` 仍然只调一次**——租约表 `agent_leases` 已经在里面了。
 *
 * 单进程就别装它：`@runko/agent` 内置的内存版更快，而且[独占](../../../docs/terms.md)
 * 是**真保证**，租约版只是**尽力 + 可检测**。
 */
export function sqliteArbitration(database: SqliteDatabase, opts: SqliteArbitrationOptions): Arbitration {
  return leaseArbitration(toKysely(database), { ...opts, flavor: "sqlite" });
}
