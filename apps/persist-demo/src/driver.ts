/**
 * 选驱动——**换库只动这一个文件**，业务代码一个字不改。这正是「持久化是宿主层能力」
 * 那句话的实际手感。
 *
 * 每种库对应一个**独立的包**，各自只吃自己那个驱动：
 *
 * | `DEMO_DB` | 装的包 | 你要给它什么 |
 * |---|---|---|
 * | 缺省 / `sqlite` / `memory` | `@runko/persist-sqlite` | 一个 `better-sqlite3` 实例 |
 * | `postgres` | `@runko/persist-postgres` | 一个 `pg.Pool` |
 * | `mysql` | `@runko/persist-mysql` | 一个 `mysql2` 连接池 |
 * | `mongo` | `@runko/persist-mongo` | 一个 MongoDB `Db` |
 *
 * **Mongo 那一档不是 SQL**，所以它连 demo 自己那张会话表也换了形态（集合而不是表）。
 * 于是 `makeStore()` 由各驱动自己给——见 `store.ts`。
 *
 * 三个 import 都是**动态**的：跑 SQLite 的人不该被迫加载 `pg` 和 `mysql2`。
 */
import type { Arbitration, Persistence } from "@runko/agent";

import type { DemoStore } from "./store.js";
import { createMongoStore, createSqlStore } from "./store.js";

export type DriverKind = "sqlite" | "memory" | "postgres" | "mysql" | "mongo";

/** 多副本时给租约版[归属仲裁机制](../../../docs/terms.md)的入参。 */
export interface ArbitrationSettings {
  /** 本副本的可达地址，原样进 `holder`。 */
  holder: string;
  heartbeatMs?: number;
  takeoverMs?: number;
}

export interface OpenedDriver {
  persistence: Persistence;
  /**
   * 把**同一个驱动实例**装成租约版归属仲裁——多副本要它。缺席 = 这一档还没有租约版
   * 实现（Mongo 目前如此），调用方应当退回单副本。
   */
  makeArbitration?: (settings: ArbitrationSettings) => Arbitration;
  /** 库名，用于日志与 e2e 断言。 */
  kind: "sqlite" | "postgres" | "mysql" | "mongo";
  close(): Promise<void>;
  /**
   * demo **自己那点数据**（会话清单）的存法。由各驱动自己给，因为它跟 runko 那三张
   * 表用的是同一个连接——而且 Mongo 那一档形态完全不同（集合，不是表）。
   */
  makeStore: () => DemoStore;
}

/** demo 自己的表要用的最小查询口。三种驱动各给一份。 */
export interface RawHandle {
  kind: "sqlite" | "postgres" | "mysql";
  all(sql: string, params: readonly (string | number)[]): Promise<Record<string, unknown>[]>;
  run(sql: string, params: readonly (string | number)[]): Promise<void>;
}

export interface OpenDriverOptions {
  /** 缺省读 `DEMO_DB`。 */
  kind?: DriverKind;
  /** SQLite 的库文件路径；缺省读 `DEMO_DB_PATH`，再缺省 `demo.db`。 */
  path?: string;
  /** Postgres / MySQL 连接串；缺省读 `DATABASE_URL`。 */
  url?: string;
}

export async function openDriver(opts: OpenDriverOptions = {}): Promise<OpenedDriver> {
  const kind = opts.kind ?? readKind();
  const url = opts.url ?? process.env["DATABASE_URL"] ?? "";

  if (kind === "postgres") {
    const [{ Pool }, { migrate, postgresArbitration, postgresPersistence }] = await Promise.all([
      import("pg"),
      import("@runko/persist-postgres"),
    ]);
    const pool = new Pool({ connectionString: url });
    await migrate(pool);
    return {
      persistence: postgresPersistence(pool),
      makeArbitration: (settings) => postgresArbitration(pool, settings),
      kind: "postgres",
      makeStore: () =>
        createSqlStore({
          kind: "postgres",
          all: async (sql, params) => (await pool.query(sql, [...params])).rows as Record<string, unknown>[],
          run: async (sql, params) => {
            await pool.query(sql, [...params]);
          },
        }),
      close: async () => {
        await pool.end();
      },
    };
  }

  if (kind === "mysql") {
    const [{ createPool }, { migrate, mysqlArbitration, mysqlPersistence }] = await Promise.all([
      import("mysql2/promise"),
      import("@runko/persist-mysql"),
    ]);
    const pool = createPool(url);
    // `mysql2/promise` 的池跟 `mysql2` 的池是同一个东西，只是包了 Promise；
    // persist-mysql 吃的是回调式那个，用 `.pool` 取出来。
    await migrate(pool.pool);
    return {
      persistence: mysqlPersistence(pool.pool),
      makeArbitration: (settings) => mysqlArbitration(pool.pool, settings),
      kind: "mysql",
      makeStore: () =>
        createSqlStore({
          kind: "mysql",
          all: async (sql, params) => {
            const [rows] = await pool.query(sql, [...params]);
            return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
          },
          run: async (sql, params) => {
            await pool.query(sql, [...params]);
          },
        }),
      close: async () => {
        await pool.end();
      },
    };
  }

  if (kind === "mongo") {
    const [{ MongoClient }, { migrate, mongoPersistence }] = await Promise.all([
      import("mongodb"),
      import("@runko/persist-mongo"),
    ]);
    const client = new MongoClient(url);
    await client.connect();
    // database 名字从连接串里取，取不到就用 `persist_demo`——**选哪个 db 是宿主的决定**，
    // 包只吃一个 `Db`。
    const dbName = new URL(url).pathname.replace(/^\//, "") || "persist_demo";
    const db = client.db(dbName);
    await migrate(db);
    return {
      persistence: mongoPersistence(db),
      kind: "mongo",
      makeStore: () => createMongoStore(db),
      close: async () => {
        await client.close();
      },
    };
  }

  const [{ default: Database }, { migrate, sqliteArbitration, sqlitePersistence }] = await Promise.all([
    import("better-sqlite3"),
    import("@runko/persist-sqlite"),
  ]);
  const file = kind === "memory" ? ":memory:" : (opts.path ?? process.env["DEMO_DB_PATH"] ?? "demo.db");
  const db = new Database(file);
  if (file !== ":memory:") {
    // **多进程共用一个 SQLite 文件时这两条是必需的**（部署形态里的「① 同机 cluster」）：
    // 默认的 rollback journal 下第二个写者直接吃 `SQLITE_BUSY`，而不是等一下再来。
    // WAL 让读写不互斥，`busy_timeout` 让写写冲突退化成「等一会儿」。
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
  }
  await migrate(db);
  return {
    persistence: sqlitePersistence(db),
    // 同机多进程共用一个 SQLite 文件也是多副本的一档（部署形态里的「① 同机 cluster」），
    // 所以这一档也给。`:memory:` 那档给了也没用——每个进程各有一份内存库。
    makeArbitration: (settings) => sqliteArbitration(db, settings),
    kind: "sqlite",
    makeStore: () =>
      createSqlStore({
        kind: "sqlite",
        all: (sql, params) => Promise.resolve(db.prepare(sql).all(...params) as Record<string, unknown>[]),
        run: (sql, params) => {
          db.prepare(sql).run(...params);
          return Promise.resolve();
        },
      }),
    close: () => {
      db.close();
      return Promise.resolve();
    },
  };
}

function readKind(): DriverKind {
  const raw = process.env["DEMO_DB"]?.trim().toLowerCase();
  if (raw === "postgres" || raw === "mysql" || raw === "mongo" || raw === "memory" || raw === "sqlite") {
    return raw;
  }
  return "sqlite";
}
