/**
 * `@runko/persist-mongo`——[持久化](../../../docs/host/contract/features/persistence.md)
 * 的 **MongoDB** 实现，也是第一个**非关系型**实现。
 *
 * ```ts
 * import { MongoClient } from "mongodb";
 * import { migrate, mongoPersistence } from "@runko/persist-mongo";
 *
 * const client = new MongoClient(process.env.MONGO_URL);
 * await client.connect();
 * const db = client.db("myapp");
 *
 * await migrate(db);                    // 建索引，幂等
 * createAgentRuntime({
 *   agent,
 *   prepareTurn,
 *   persistence: mongoPersistence(db),
 *   // 多副本才要这一行；单进程不传，走内置的内存版归属仲裁
 *   arbitration: mongoArbitration(db, { holder: process.env.POD_URL }),
 * });
 * ```
 *
 * **它不是薄壳。** SQLite / Postgres / MySQL 那三个包底下共用 `@runko/persist-kysely`
 * ——Kysely 是 SQL 查询构建器，Mongo 用不上。这个包**直接实现三个领域接口**。
 *
 * ## 它顺带证明了什么
 *
 * 契约里有三条准则，当初就是为了**不把非关系型挡在门外**才那么写的。这是第一次真去验：
 *
 * | 准则 | 结论 |
 * |---|---|
 * | 不假设事务能跨接口 | ✅ 需要原子的只有 `dequeue`，Mongo 的 `findOneAndDelete` 原生原子 |
 * | 不要求 CAS | ✅ 一次都没用上（租约版仲裁用 CAS，但那是**另一个接口**，持久化这三个没有） |
 * | 不支持跨会话查询 | ✅ 每个查询都以 `conversationId` 打头，正好是索引前缀 |
 *
 * 三条全成立，接口**没有漏掉关系型假设**。
 *
 * ## 要求
 *
 * **MongoDB 5.0+**。工具入参是任意 JSON，键里可能有 `.` 或 `$`——5.0 之前的 MongoDB
 * 不接受这种字段名。实测 MongoDB 8 全放行。
 *
 * ## 两样能力，装配时各传各的
 *
 * | 给什么 | 是什么 | 什么时候要 |
 * |---|---|---|
 * | `mongoPersistence(db)` | [持久化](../../../docs/host/contract/features/persistence.md)：账本 · 裁决表 · 待发队列 | 总是 |
 * | `mongoArbitration(db, { holder })` | 租约版[归属仲裁](../../../docs/terms.md)：同一时刻只有一个副本在推进一份对话 | **多副本才要**（[多副本部署](../../../docs/host/node/features/multi-replica.md)） |
 *
 * 两样吃的是**同一个 `Db`**，`migrate(db)` 也把两边要的索引一起建了。
 */
import type { Persistence } from "@runko/agent";
import type { Db } from "mongodb";

import { createDecisionStore, createLedgerStore, createQueueStore } from "./stores.js";
import { createToolTailStore } from "./tails.js";

export const RUNKO_PERSIST_MONGO_VERSION = "0.0.0" as const;

export type { DecisionDoc, LeaseDoc, LedgerDoc, NodeDoc, QueueDoc, ToolTailDoc } from "./collections.js";
export {
  DECISIONS_COLLECTION,
  LEASES_COLLECTION,
  LEDGER_COLLECTION,
  NODES_COLLECTION,
  QUEUE_COLLECTION,
  TAILS_COLLECTION,
} from "./collections.js";
export type { MongoArbitrationOptions } from "./arbitration.js";
export {
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_TAKEOVER_MS,
  mongoArbitration,
} from "./arbitration.js";
export type { MongoNodeRegistryOptions } from "./nodes.js";
export { mongoNodeRegistry } from "./nodes.js";
export { migrate } from "./migrate.js";

/**
 * 把一个 MongoDB `Db` 装成 `Persistence`。
 *
 * **吃 `Db` 而不是 `MongoClient`**：选哪个 database 是宿主的决定（多租户可能一租户
 * 一个 db），连接的生命周期也归宿主管——本包不 connect、不 close。
 *
 * 四个集合固定叫 `agent_ledger` / `agent_decisions` / `agent_queue` / `agent_tool_tails`，
 * 你自己的集合照常在同一个 db 里，互不干扰。
 */
export function mongoPersistence(db: Db): Persistence {
  return {
    ledger: createLedgerStore(db),
    decisions: createDecisionStore(db),
    queue: createQueueStore(db),
    tails: createToolTailStore(db),
  };
}
