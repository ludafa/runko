/**
 * 建表，走 Kysely 的 schema builder——**一份 DDL 跑三个方言**，列类型的差异走
 * `FlavorTraits`。
 *
 * **你自己调**，不是包在背后偷偷跑的。幂等（全部 `ifNotExists`），跑几次都一样。
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";

import type { Flavor } from "./flavor.js";
import { traitsOf } from "./flavor.js";
import type { RunkoDatabase } from "./schema.js";
import { DECISIONS_TABLE, LEASES_TABLE, LEDGER_TABLE, QUEUE_TABLE } from "./schema.js";

export interface MigrateOptions {
  flavor: Flavor;
}

export async function migrate(db: Kysely<RunkoDatabase>, opts: MigrateOptions): Promise<void> {
  const t = traitsOf(opts.flavor);
  // MySQL 的 TEXT 列不能直接当主键（要指定长度），所以主键上的字符串列一律 varchar(255)。
  // 另两家把 varchar(255) 当普通变长文本，没有副作用。
  //
  // **MySQL 上还必须显式带排序规则**（`collate utf8mb4_bin`）：它的默认排序规则
  // `utf8mb4_0900_ai_ci` 大小写与重音都不敏感，会把 `AbC` 和 `abc` 当成同一个 ID——
  // 跨会话读到别人的账本，主键上还会撞键。详见 `flavor.ts` 头部的坑 ①。
  const key = sql.raw(t.keyColumnType);

  await db.schema
    .createTable(LEDGER_TABLE)
    .ifNotExists()
    .addColumn("conversation_id", key, (c) => c.notNull())
    .addColumn("seq", t.intColumnType, (c) => c.notNull())
    .addColumn("payload", t.jsonColumnType, (c) => c.notNull())
    .addColumn("ts", t.intColumnType, (c) => c.notNull())
    .addPrimaryKeyConstraint("agent_ledger_pk", ["conversation_id", "seq"])
    .execute();

  await db.schema
    .createTable(DECISIONS_TABLE)
    .ifNotExists()
    .addColumn("conversation_id", key, (c) => c.notNull())
    .addColumn("tool_call_id", key, (c) => c.notNull())
    .addColumn("kind", "varchar(32)", (c) => c.notNull())
    .addColumn("tool_name", "varchar(255)")
    .addColumn("payload", t.jsonColumnType)
    .addColumn("outcome", "varchar(32)")
    .addColumn("scope", "varchar(32)")
    .addColumn("decided_by", "varchar(255)")
    .addColumn("message", "text")
    .addColumn("requested_at", t.intColumnType, (c) => c.notNull())
    .addColumn("decided_at", t.intColumnType)
    .addPrimaryKeyConstraint("agent_decisions_pk", ["conversation_id", "tool_call_id"])
    .execute();

  await db.schema
    .createTable(QUEUE_TABLE)
    .ifNotExists()
    .addColumn("conversation_id", key, (c) => c.notNull())
    .addColumn("id", key, (c) => c.notNull())
    .addColumn("seq", t.intColumnType, (c) => c.notNull())
    .addColumn("input", t.jsonColumnType, (c) => c.notNull())
    .addColumn("created_at", t.intColumnType, (c) => c.notNull())
    .addPrimaryKeyConstraint("agent_queue_pk", ["conversation_id", "id"])
    // **seq 的唯一性交给数据库**。应用层「先查最大值再插」在并发下必然有窗口：两个请求
    // 读到同一份快照就会算出同一个 seq，之后按 seq 排序平局，先到先发不再成立。写后读回
    // 校验也堵不住——校验那次读可能发生在对手插入之前。有了这条约束，撞号的那条会被
    // 幂等插入吞掉，调用方读回来发现自己不在队列里，换个号重来（见 `stores.ts` 的 `enqueue`）。
    .addUniqueConstraint("agent_queue_seq_uk", ["conversation_id", "seq"])
    .execute();
  // [租约表](../../../docs/terms.md)：多进程下的归属仲裁机制。单进程用不上它——内存版
  // 的归属表跟进程同生共死，根本不落库；这张表建了也只是空着，没有代价。
  await db.schema
    .createTable(LEASES_TABLE)
    .ifNotExists()
    .addColumn("conversation_id", key, (c) => c.notNull())
    .addColumn("holder", "varchar(255)")
    // 令牌也要显式排序规则：MySQL 默认大小写不敏感，两个只差大小写的令牌会被当成同一个。
    .addColumn("lease_token", sql.raw(t.keyColumnType))
    .addColumn("seq_watermark", t.intColumnType, (c) => c.notNull())
    .addColumn("heartbeat_at", t.intColumnType, (c) => c.notNull())
    .addColumn("acquired_at", t.intColumnType, (c) => c.notNull())
    .addPrimaryKeyConstraint("agent_leases_pk", ["conversation_id"])
    .execute();

  // ⚠️ **`migrate()` 只做首建，不做 schema 演进。** 四张表全是 `CREATE TABLE IF NOT
  // EXISTS`：表已经存在时它是彻底的 no-op，**不会**改列、加列或改排序规则。所以后续版本
  // 若动了 schema（哪怕只是给某列换排序规则），老库必须由宿主自己出一次迁移——本包不
  // 带版本表、不记 migration 历史。README 与 `schema.sql` 里写的是同一句承诺。
  //
  // 另外它**不能并发调**：Postgres 上多个实例同时跑 `CREATE TABLE IF NOT EXISTS` 会撞
  // `pg_type` 的唯一索引报重复键（Postgres 已知行为）。幂等 ≠ 可并发——启动时串行调一次。
}

/*
 * **队列表刻意不建二级索引。** 原先有个 `(conversation_id, seq)` 的索引，去掉了，两个理由：
 *
 * 1. **用不上。** 主键 `(conversation_id, id)` 的前导列就是 `conversation_id`，
 *    `WHERE conversation_id = ?` 已经走得了主键；剩下的只是给一个**有上限的**集合
 *    （`queue.max` 缺省 10）排序，内存里排完全免费。
 * 2. **MySQL 不支持 `CREATE INDEX IF NOT EXISTS`。** 保留它就得为 MySQL 单开一条
 *    「先查 information_schema / 或吞掉 ER_DUP_KEYNAME」的分支——为一个用不上的索引
 *    付这个复杂度不划算。
 *
 * 哪天队列真的变成无上限的大表，再连同分页一起重新设计。
 */
