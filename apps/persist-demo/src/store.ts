/**
 * 本 demo **自己的**那点数据：会话清单。
 *
 * **这一段恰恰是重点**：`@runko/persist-*` 不管它。框架的准则是「runko 不拥有用户
 * 实体」——它只认一个不透明的 `conversationId` 字符串，不建外键、不存标题、不知道
 * 谁是谁。所以「会话叫什么、什么时候建的」这些**产品数据**归宿主自己存。
 *
 * 于是这个 demo 里有两套表并存，而且**互不知道对方**：
 *
 * | 谁的 | 表 | 谁在写 |
 * |---|---|---|
 * | runko 的 | `agent_ledger` / `agent_decisions` / `agent_queue` | `@runko/persist-*` |
 * | demo 的 | `demo_conversations` | 本文件 |
 *
 * > 本文件用的是**裸 SQL + 一个三方言的小分支**。这是「demo 要同时支持三种库」的成本，
 * > **不是「当 runko 宿主」的成本**——真实应用只挑一个库，直接写那一家的 SQL 就完了。
 * > 真嫌烦的话，宿主也可以自己用 Kysely 把这张表一起管起来（那样就该装
 * > `@runko/persist-kysely`，runko 的表和自己的表进同一个实例、同一套迁移）。
 */
import type { Db } from "mongodb";

import type { RawHandle } from "./driver.js";

export interface ConversationRow {
  id: string;
  title: string;
  createdAt: number;
}

export interface DemoStore {
  migrate(): Promise<void>;
  create(title: string): Promise<ConversationRow>;
  list(): Promise<ConversationRow[]>;
  get(id: string): Promise<ConversationRow | undefined>;
}

export function createSqlStore(raw: RawHandle): DemoStore {
  /** 三家的占位符不一样：Postgres 是 `$n`，另两家是 `?`。 */
  const ph = (n: number): string => (raw.kind === "postgres" ? `$${String(n)}` : "?");
  const int = raw.kind === "sqlite" ? "INTEGER" : "BIGINT";
  // MySQL 的主键不能是无长度的 TEXT，得给长度；另两家把 VARCHAR(255) 当普通变长文本。
  const key = "VARCHAR(255)";

  const toRow = (row: Record<string, unknown>): ConversationRow => ({
    id: String(row["id"] ?? ""),
    title: String(row["title"] ?? ""),
    // Postgres 的 BIGINT 经驱动回来是 string，另两家是 number。
    createdAt: Number(row["created_at"] ?? 0),
  });

  return {
    async migrate() {
      await raw.run(
        `CREATE TABLE IF NOT EXISTS demo_conversations (
           id         ${key} NOT NULL PRIMARY KEY,
           title      TEXT   NOT NULL,
           created_at ${int} NOT NULL
         )`,
        [],
      );
    },

    async create(title) {
      const row: ConversationRow = { id: crypto.randomUUID(), title, createdAt: Date.now() };
      await raw.run(
        `INSERT INTO demo_conversations (id, title, created_at) VALUES (${ph(1)}, ${ph(2)}, ${ph(3)})`,
        [row.id, row.title, row.createdAt],
      );
      return row;
    },

    async list() {
      const rows = await raw.all(
        "SELECT id, title, created_at FROM demo_conversations ORDER BY created_at DESC",
        [],
      );
      return rows.map(toRow);
    },

    async get(id) {
      const rows = await raw.all(
        `SELECT id, title, created_at FROM demo_conversations WHERE id = ${ph(1)}`,
        [id],
      );
      const first = rows[0];
      return first === undefined ? undefined : toRow(first);
    },
  };
}

// ---------------------------------------------------------------------------
// Mongo 那一档：同一个 `DemoStore`，形态完全不同
// ---------------------------------------------------------------------------

/**
 * 会话清单存成一个**集合**，不是表。
 *
 * 放这儿是为了让对比一目了然：上面那个 SQL 版有建表 DDL、三家占位符分支、BIGINT 与
 * VARCHAR 的类型差异；这个版本**一样都没有**——`insertOne` / `find` / `findOne` 三句完事。
 *
 * 这恰恰是「持久化归宿主」这条分层的意义：宿主的产品数据用什么形态存，是宿主的事，
 * runko 不知道也不该知道。它只认一个不透明的 `conversationId`。
 */
export function createMongoStore(db: Db): DemoStore {
  interface ConversationDoc {
    _id: string;
    title: string;
    createdAt: number;
  }
  const col = db.collection<ConversationDoc>("demo_conversations");

  const toRow = (doc: ConversationDoc): ConversationRow => ({
    id: doc._id,
    title: doc.title,
    createdAt: doc.createdAt,
  });

  return {
    migrate() {
      // 集合是隐式创建的，什么都不用做。留着这个空实现是因为 `DemoStore` 对四种库
      // 呈现同一套动作——少一个方法反而要让调用方分支。
      return Promise.resolve();
    },

    async create(title) {
      const row: ConversationRow = { id: crypto.randomUUID(), title, createdAt: Date.now() };
      await col.insertOne({ _id: row.id, title: row.title, createdAt: row.createdAt });
      return row;
    },

    async list() {
      const docs = await col.find().sort({ createdAt: -1 }).toArray();
      return docs.map(toRow);
    },

    async get(id) {
      const doc = await col.findOne({ _id: id });
      return doc === null ? undefined : toRow(doc);
    },
  };
}
