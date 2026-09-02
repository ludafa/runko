/**
 * 四张表的 Kysely 类型。**这是本包唯一的「表长什么样」的事实来源**——DDL 与全部查询
 * 都从它推类型，改一个字段编译器会把所有该改的地方指出来。
 *
 * 字段语义见[架构总纲 §3](../../../docs/architecture/tech/agent-kernel.md)，不在这里复述。
 *
 * **表名写死，不做前缀。** 原先手搓那版有个 `tablePrefix`，换 Kysely 之后放弃了：
 * Kysely 的类型是按**字面量表名**推的，前缀一动态化就得退回 `any`，等于把这个库最值钱的
 * 东西（类型安全的查询）扔掉，去换一个几乎没人用的开关。真要隔离，Postgres/MySQL 有
 * **schema / database** 这个更对的工具（`db.withSchema(...)`）；SQLite 那边 `runko_` 前缀
 * 撞名的概率约等于零。
 */

export const LEDGER_TABLE = "agent_ledger";
export const DECISIONS_TABLE = "agent_decisions";
export const QUEUE_TABLE = "agent_queue";
export const LEASES_TABLE = "agent_leases";

/** [账本](../../../docs/terms.md)：一个会话的全部成品消息。 */
export interface LedgerTable {
  conversation_id: string;
  /** 每会话递增，由[归属仲裁](../../../docs/terms.md)分配。**允许有空洞**。 */
  seq: number;
  /** `RunkoUIMessage` 的 JSON。形状归 core 管，本包不拆列。 */
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
 * [租约表](../../../docs/terms.md)：**多进程下的[归属仲裁机制](../../../docs/terms.md)**。
 *
 * 一个会话一行，长期存在——`release()` 只把 `holder`/`lease_token` 置空，**不删行**，
 * 这样 `seq_watermark` 跨释放保留，下次抢占不用回账本重新问一次水位。
 */
export interface LeasesTable {
  conversation_id: string;
  /** 不透明字符串（pod 地址 / machine id / 随便什么），框架存它、传它，**不解释它**。空 = 当前没人持有。 */
  holder: string | null;
  /**
   * [租期标识](../../../docs/terms.md)：调用方生成的唯一串（实现用 `crypto.randomUUID()`），
   * **只需唯一、不需递增**——技术方案原文写的是 ULID，但它的可排序性在这里一次都没用到，
   * 所以不为它加一个依赖。
   *
   * 粒度是「一次租期」而不是「一个进程」——同一个进程两次抢占拿到两个不同的令牌，
   * 旧的那个此后一律被拒。拿 `holder` 当令牌会在「A 失联 → B 接管 → B 挂 → A 重新
   * 抢占」时放行 A 滞留在网络里的旧写入。
   */
  lease_token: string | null;
  /** [账本](../../../docs/terms.md)的 seq 水位。取号与「校验我还持有」是同一条 UPDATE。 */
  seq_watermark: number;
  /** 最后一次心跳的时刻。**判死靠它**：`now - heartbeat_at > 阈值` 即可被接管。 */
  heartbeat_at: number;
  acquired_at: number;
}

/**
 * 本包要求的库形状。宿主自己带 Kysely 实例时，把它并进自己的 `Database` 类型：
 *
 * ```ts
 * interface MyDatabase extends RunkoDatabase {
 *   my_users: MyUsersTable;
 * }
 * ```
 */
export interface RunkoDatabase {
  agent_ledger: LedgerTable;
  agent_decisions: DecisionsTable;
  agent_queue: QueueTable;
  agent_leases: LeasesTable;
}
