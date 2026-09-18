/**
 * 四个集合的文档形状，以及**唯一一处需要小心的类型边界**：BSON ↔ JSON。
 *
 * 集合名固定：`agent_ledger` / `agent_decisions` / `agent_queue` / `agent_leases`。理由同
 * SQL 那几家——要隔离请用**另一个 database**（Mongo 里那是一等公民，比表名前缀干净得多）。
 *
 * 前三个是[持久化](../../../docs/host/contract/features/persistence.md)的，第四个是
 * [归属仲裁](../../../docs/terms.md)的——**两件事，装配时各传各的**，只是恰好住在同一个
 * database 里。
 */
import type { JsonValue } from "@runko/core";

export const LEDGER_COLLECTION = "agent_ledger";
export const DECISIONS_COLLECTION = "agent_decisions";
export const QUEUE_COLLECTION = "agent_queue";
export const LEASES_COLLECTION = "agent_leases";

/**
 * [账本](../../../docs/terms.md)文档。
 *
 * **不用复合 `_id`**（`{_id: {conversationId, seq}}`）虽然那样能白捡唯一性——因为
 * 嵌套文档的 `_id` 是**整体**建索引的，`{"_id.conversationId": x}` 这种查询用不上它。
 * 改成显式字段 + 一个唯一复合索引（`migrate()` 建），查询才走得了索引。
 */
export interface LedgerDoc {
  conversationId: string;
  /** 每会话递增，由[归属仲裁](../../../docs/terms.md)分配。**允许有空洞**。 */
  seq: number;
  /** `RunkoUIMessage`。以 BSON 文档存（不是字符串）——Mongo 的原生形态，工具里看得见。 */
  payload: JsonValue;
  ts: number;
}

/** [裁决表](../../../docs/terms.md)文档。`decidedAt` 为 `null` 即「尚未 settle」。 */
export interface DecisionDoc {
  conversationId: string;
  toolCallId: string;
  kind: string;
  toolName: string | null;
  payload: JsonValue | null;
  outcome: string | null;
  scope: string | null;
  decidedBy: string | null;
  message: string | null;
  requestedAt: number;
  decidedAt: number | null;
}

/**
 * [租约](../../../docs/terms.md)文档——一个会话一条，**`_id` 就是会话 id**。
 *
 * 唯一性于是由 `_id` 白送（不用额外建唯一索引），而且每一次读写都是按 `_id` 的点查，
 * 这正是 Mongo 最快的那条路。
 *
 * **字段名跟着本包走驼峰，不跟 SQL 表的下划线。** 它与 `agent_leases` 表一一对应
 * （[技术方案 §4.2](../../../docs/host/node/tech/multi-replica.md)），但同一个 database 里
 * 另外三个集合都是驼峰，为了「对齐一张永远不会跟它 join 的表」把这一个写成下划线，
 * 只会让用 Compass 翻库的人多一次愣神。
 */
export interface LeaseDoc {
  /** = `conversationId`。 */
  _id: string;
  /** 当前持有者（不透明字符串）。`null` = 没人持有。 */
  holder: string | null;
  /** 一次租期的唯一标识（[租期标识](../../../docs/terms.md)）。`null` = 没人持有。 */
  leaseToken: string | null;
  /** [账本](../../../docs/terms.md)水位，**跨释放保留**——下次抢占才不用回账本重新问。 */
  seqWatermark: number;
  /** 最后一次心跳写进来的时刻。别的副本判它死活看的就是这个值。 */
  heartbeatAt: number;
  /** 这次租期是什么时候抢到的。只用于排障，不参与任何判断。 */
  acquiredAt: number;
}

/** [待发队列](../../../docs/terms.md)文档。`_id` 直接用队列条目自己的 id。 */
export interface QueueDoc {
  _id: string;
  conversationId: string;
  /** 入队顺序，**不与账本 seq 共享空间**。 */
  seq: number;
  input: JsonValue;
  createdAt: number;
}

/**
 * **写进 BSON 之前先过一遍 JSON。**
 *
 * 这一步不是多余的，它修的是一个实测出来的行为差异：BSON 会把 `undefined` **存成
 * `null`**，而 SQL 那几家走的是 `JSON.stringify`（**直接把这个键丢掉**）。同一个
 * `RunkoUIMessage` 存进去、读出来，Mongo 给 `{cachedInputTokens: null}`、SQLite 给
 * `{}`——一致性套件的「原样往返」当场就会红。
 *
 * 修法有两条，选了这条：
 *
 * | | 怎么做 | 为什么不选 |
 * |---|---|---|
 * | 客户端开 `ignoreUndefined` | `new MongoClient(url, { ignoreUndefined: true })` | **客户端是宿主建的**，我们只拿到 `Db`，管不着它怎么建的 |
 * | ✅ 自己先 JSON 归一 | `JSON.parse(JSON.stringify(v))` | —— |
 *
 * 选后者还有一个额外好处：它让 Mongo 这一档的语义**可证地**与 SQL 那几家一致
 * ——因为它做的就是那几家在做的同一件事。
 */
export function toBson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}

/**
 * 读回来直接用——**不需要反向转换**。
 *
 * 存进去的已经是 JSON 归一过的纯数据，Mongo 原样给回来。数字、字符串、嵌套对象、
 * 数组都实测过原样往返（含 `Number.MAX_SAFE_INTEGER` 与浮点）。
 *
 * 留这个函数是为了让「读」这一侧有个明确的边界名字，将来真要加什么（比如剥掉
 * driver 塞进来的 `_id`）有地方放。
 *
 * ⚠️ **这是一处刻意的类型逃逸，范围仅限本函数。** 驱动把 BSON 文档的字段给成
 * `unknown`（它无法知道我们存了什么形状），而这一层唯一能做的就是把它交还给调用方。
 * 泛型 `as` 意味着**本边界上没有类型检查**——所以真正需要保证形状的地方必须自己校验：
 * 队列的 `input` 走 `decodeTurnInput`（zod）；账本的 `payload` 由 core 在
 * `createSession({ resume })` 里跑 `validateUIMessages` 兜住。别把这个函数当成
 * 「安全的转换」到处用。
 */
export function fromBson<T>(value: unknown): T {
  return value as T;
}
