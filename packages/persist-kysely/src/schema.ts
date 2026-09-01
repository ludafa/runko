/**
 * 三张表的 Kysely 类型。**这是本包唯一的「表长什么样」的事实来源**——DDL 与全部查询
 * 都从它推类型，改一个字段编译器会把所有该改的地方指出来。
 *
 * 字段语义见[架构总纲 §3](../../../docs/architecture/tech/agent-kernel.md)，不在这里复述。
 *
 * **表名写死，不做前缀。** 原先手搓那版有个 `tablePrefix`，换 Kysely 之后放弃了：
 * Kysely 的类型是按**字面量表名**推的，前缀一动态化就得退回 `any`，等于把这个库最值钱的
 * 东西（类型安全的查询）扔掉，去换一个几乎没人用的开关。真要隔离，Postgres/MySQL 有
 * **schema / database** 这个更对的工具（`db.withSchema(...)`）；SQLite 那边 `nimbo_` 前缀
 * 撞名的概率约等于零。
 */

export const LEDGER_TABLE = "nimbo_ledger";
export const DECISIONS_TABLE = "nimbo_decisions";
export const QUEUE_TABLE = "nimbo_queue";

/** [账本](../../../docs/terms.md)：一个会话的全部成品消息。 */
export interface LedgerTable {
  conversation_id: string;
  /** 每会话递增，由[归属仲裁](../../../docs/terms.md)分配。**允许有空洞**。 */
  seq: number;
  /** `NimboUIMessage` 的 JSON。形状归 core 管，本包不拆列。 */
  payload: string;
  ts: number;
}

/** [裁决表](../../../docs/terms.md)：人工裁决的留底。`decided_at` 为空即「尚未 settle」。 */
export interface DecisionsTable {
  conversation_id: string;
  tool_call_id: string;
  kind: string;
  tool_name: string | null;
  payload: string | null;
  outcome: string | null;
  scope: string | null;
  decided_by: string | null;
  message: string | null;
  requested_at: number;
  decided_at: number | null;
}

/** [待发队列](../../../docs/terms.md)：agent 忙时用户发的消息。 */
export interface QueueTable {
  conversation_id: string;
  id: string;
  /** 入队顺序，**不与账本 seq 共享空间**。 */
  seq: number;
  input: string;
  created_at: number;
}

/**
 * 本包要求的库形状。宿主自己带 Kysely 实例时，把它并进自己的 `Database` 类型：
 *
 * ```ts
 * interface MyDatabase extends NimboDatabase {
 *   my_users: MyUsersTable;
 * }
 * ```
 */
export interface NimboDatabase {
  nimbo_ledger: LedgerTable;
  nimbo_decisions: DecisionsTable;
  nimbo_queue: QueueTable;
}
