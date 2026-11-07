/**
 * 建表：`@runko/persist-kysely` 的那几张，加本包自己的一张归属表。幂等（全部 `IF NOT EXISTS`）。
 *
 * `createDurableObjectRuntime` 会在 `ready` 里替你调它；自己装配时，在 `blockConcurrencyWhile` 里先调一次。
 */
import type { RunkoDatabase } from "@runko/persist-kysely";
import { migrate } from "@runko/persist-kysely";
import type { Kysely } from "kysely";

export const OWNERSHIP_TABLE = "agent_do_ownership";

/**
 * 归属表：一个会话一行，同时装两个标记。
 *
 * - **[起轮标记](../../../docs/terms.md)**（`instance_id` 非空）：哪个实例在跑这一轮。平台保证同一时刻只有一个实例，
 *   所以标记上的实例不是自己，就一定是上一辈子留下的。
 * - **[待接手](../../../docs/terms.md)标记**（`awaiting_takeover = 1`）：有活没干完，等人推一把。
 */
export interface OwnershipTable {
  conversation_id: string;
  /** 起轮标记：在跑这一轮的实例。`null` = 没轮在跑。 */
  instance_id: string | null;
  holder: string | null;
  acquired_at: number | null;
  /** 0 / 1。 */
  awaiting_takeover: number;
  updated_at: number;
}

/** 给 `db.withTables<OwnershipTables>()` 用。写成 type 而不是 interface：Kysely 要求它带隐式索引签名。 */
export type OwnershipTables = {
  agent_do_ownership: OwnershipTable;
};

export async function migrateDurableObject(db: Kysely<RunkoDatabase>): Promise<void> {
  await migrate(db, { flavor: "sqlite" });
  await db.schema
    .createTable(OWNERSHIP_TABLE)
    .ifNotExists()
    .addColumn("conversation_id", "varchar(255)", (c) => c.notNull().primaryKey())
    .addColumn("instance_id", "varchar(255)")
    .addColumn("holder", "varchar(255)")
    .addColumn("acquired_at", "integer")
    .addColumn("awaiting_takeover", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("updated_at", "integer", (c) => c.notNull())
    .execute();
}
