/**
 * `@nimbo/persist-kysely`——[持久化](../../../docs/host/contract/features/persistence.md)
 * 的 Kysely 实现。**你已经在用 Kysely 时装这个**，把你的实例给它。
 *
 * ```ts
 * import { Kysely, PostgresDialect } from "kysely";
 * import { kyselyPersistence, migrate } from "@nimbo/persist-kysely";
 *
 * const db = new Kysely<MyDatabase>({ dialect: new PostgresDialect({ pool }) });
 * await migrate(db, { flavor: "postgres" });
 *
 * createAgentRuntime(agent, { persistence: kyselyPersistence(db, { flavor: "postgres" }) });
 * ```
 *
 * **只有一个驱动、没在用 Kysely** 的话别用这个包——用那三个薄壳，它们替你把 Kysely
 * 装配好：`@nimbo/persist-sqlite` / `@nimbo/persist-postgres` / `@nimbo/persist-mysql`。
 *
 * **为什么是 Kysely**：这跟 better-auth 是同一个答案（它的内置适配器也是 kysely）。
 * 上一版手搓了一个方言层，在「MySQL 不支持 RETURNING」这类差异上已经开始长分支；换成
 * 现成的之后，三个方言真正的差异只剩三处（见 `flavor.ts`）。
 *
 * **这一版只出持久化，不含租约版[归属仲裁](../../../docs/terms.md)**（心跳 + 租期标识 +
 * CAS）——那是下一批，仲裁仍用 `@nimbo/agent` 内置的单进程实现。
 */
import type { Persistence } from "@nimbo/agent";
import type { Kysely } from "kysely";

import type { Flavor } from "./flavor.js";
import { traitsOf } from "./flavor.js";
import type { NimboDatabase } from "./schema.js";
import { createDecisionStore, createLedgerStore, createQueueStore } from "./stores.js";

export const NIMBO_PERSIST_KYSELY_VERSION = "0.0.0" as const;

export type { Flavor, FlavorTraits } from "./flavor.js";
export type { MigrateOptions } from "./migrate.js";
export { migrate } from "./migrate.js";
export type { DecisionsTable, LedgerTable, NimboDatabase, QueueTable } from "./schema.js";
export { DECISIONS_TABLE, LEDGER_TABLE, QUEUE_TABLE } from "./schema.js";

export interface KyselyPersistenceOptions {
  /**
   * 你这个 Kysely 实例接的是哪一家。三处方言差异靠它分派（见 `flavor.ts`）——Kysely
   * 抹平了绝大部分，但**列类型**、**幂等插入写法**、**JSON 读回来是不是已解析**这三样
   * 它故意不抹，因为三家的语义本来就不同。
   */
  flavor: Flavor;
}

/**
 * 把一个 Kysely 实例装成 `Persistence`。
 *
 * 库的类型只要**包含** `NimboDatabase` 那三张表就行——你自己的表照常在同一个实例里，
 * 两边互不干扰。
 */
export function kyselyPersistence<DB extends NimboDatabase>(
  db: Kysely<DB>,
  opts: KyselyPersistenceOptions,
): Persistence {
  // 收窄到本包认识的那三张表。`DB extends NimboDatabase` 已经保证宿主的库类型是
  // `NimboDatabase` 的超集，而本包的查询只碰这三张表——所以这个收窄是安全的。
  // 之所以要写出来，是 Kysely 的 `Kysely<DB>` 在 DB 上不变（invariant），泛型子类型
  // 关系传不过去；这是对接三方泛型容器的边界，隔离在这一行里。
  const scoped = db as unknown as Kysely<NimboDatabase>;
  const traits = traitsOf(opts.flavor);
  return {
    ledger: createLedgerStore(scoped, traits),
    decisions: createDecisionStore(scoped, traits),
    queue: createQueueStore(scoped, traits),
  };
}
