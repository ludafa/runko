/**
 * 用了 Kysely 之后，三个方言**还剩五处**真差异。全在这个文件里，其余代码方言无关。
 *
 * Kysely 抹平了绝大部分（占位符、标识符引号、查询构建、`numUpdatedRows`/`numDeletedRows`
 * 的语义），剩下这几处是它**故意不抹**的——因为三家的语义本来就不同：
 *
 * | | SQLite | Postgres | MySQL |
 * |---|---|---|---|
 * | 幂等插入 | `ON CONFLICT DO NOTHING` | 同左 | `ON DUPLICATE KEY UPDATE`（见下） |
 * | JSON 列类型 | `text` | `jsonb` | `json` |
 * | 读回来的 JSON | **字符串**（要自己 parse） | 对象（驱动已 parse） | 对象（驱动已 parse） |
 * | 整数列类型 | `integer` | `bigint` | `bigint` |
 * | 主键字符串列 | `varchar(255)` | 同左 | `varchar(255) COLLATE utf8mb4_bin`（见下） |
 *
 * > **MySQL 的两处坑，都不是「风格差异」而是会出错的语义差异：**
 * >
 * > ① **排序规则**。MySQL 8 的默认排序规则 `utf8mb4_0900_ai_ci` **大小写与重音都不敏感**，
 * > 而 SQLite 与 Postgres 都区分大小写。不显式 `COLLATE utf8mb4_bin` 的话，`AbC` 和 `abc`
 * > 会被当成同一个 conversationId——跨会话读到别人的账本；主键上还会撞键、第二条 append
 * > 被静默丢掉。契约明说 conversationId 是**不透明字符串**，宿主爱用什么用什么，所以
 * > 这不能推给宿主「别用混合大小写」。`tool_call_id` 更要紧：各家模型的 call id 本来就是
 * > 混合大小写（`toolu_01A09q…`、`call_AbC…`）。
 * >
 * > ② **`INSERT IGNORE` 不能用**。它不是「只忽略重复键」，而是把**所有**可恢复错误降级
 * > 成 warning：超长会被截断、约束失败整行被跳过，调用方却拿到「写成功了」。
 * > `ON CONFLICT (cols) DO NOTHING` 只忽略那一对列上的冲突，语义窄得多。所以 MySQL 这一档
 * > 走 `ON DUPLICATE KEY UPDATE <某列>=<某列>`（一个无操作的更新），只吞重复键。
 *
 * > **JSON 那两行是同一件事的两面**：列类型选了什么，读回来就是什么。SQLite 没有 JSON
 * > 列类型，只能存 TEXT，于是读回来是字符串；另两家有原生 JSON 类型，驱动直接给对象。
 * >
 * > **不要写「是字符串就 parse 一下」这种对冲**——一个合法存进去的 JSON 字符串（比如
 * > `ask-user` 的问题正文）读回来就是个 JS string，跟「还没解析的 JSON 文本」在类型上
 * > 完全一样，猜不出来。上一版就是栽在这。每种方言只认自己那一种。
 */
import type { JsonValue } from "@runko/core";

export type Flavor = "sqlite" | "postgres" | "mysql";

export interface FlavorTraits {
  readonly name: Flavor;
  /** 建表时 JSON 列用什么类型。 */
  readonly jsonColumnType: "text" | "jsonb" | "json";
  /** 建表时整数列用什么类型。 */
  readonly intColumnType: "integer" | "bigint";
  /**
   * 建表时**主键上的字符串列**用什么类型。MySQL 必须显式指定二进制排序规则，
   * 否则 ID 变成大小写不敏感——见本文件头的坑 ①。
   */
  readonly keyColumnType: string;
  /** 幂等插入靠哪条路——见本文件头那张表。 */
  readonly idempotentInsert: "on-conflict" | "on-duplicate-key";
  /** 读回来的 JSON 列要不要自己 parse。 */
  readonly parsesJsonOnRead: boolean;
}

const TRAITS: Record<Flavor, FlavorTraits> = {
  sqlite: {
    name: "sqlite",
    jsonColumnType: "text",
    intColumnType: "integer",
    keyColumnType: "varchar(255)",
    idempotentInsert: "on-conflict",
    parsesJsonOnRead: false,
  },
  postgres: {
    name: "postgres",
    jsonColumnType: "jsonb",
    intColumnType: "bigint",
    keyColumnType: "varchar(255)",
    idempotentInsert: "on-conflict",
    parsesJsonOnRead: true,
  },
  mysql: {
    name: "mysql",
    jsonColumnType: "json",
    intColumnType: "bigint",
    keyColumnType: "varchar(255) collate utf8mb4_bin",
    idempotentInsert: "on-duplicate-key",
    parsesJsonOnRead: true,
  },
};

export function traitsOf(flavor: Flavor): FlavorTraits {
  return TRAITS[flavor];
}

/** 写进 JSON 列的值：三家都吃字符串字面量。 */
export function encodeJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/**
 * 读回来的 JSON 列 → 原值。
 *
 * **按方言分派，不按值的类型猜**——理由见本文件头。
 */
export function decodeJson(traits: FlavorTraits, column: unknown): JsonValue {
  if (!traits.parsesJsonOnRead && typeof column === "string") {
    return JSON.parse(column) as JsonValue;
  }
  return column as JsonValue;
}

/**
 * Postgres/MySQL 的 `BIGINT` 经驱动回来可能是 **string** 或 **bigint**（mysql2 给
 * number，pg 给 string，Kysely 的计数给 bigint）。统一收成 number。
 */
export function toNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return 0;
}
