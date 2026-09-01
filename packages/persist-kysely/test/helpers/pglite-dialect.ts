/**
 * 把 pglite 包成一个 Kysely dialect。
 *
 * **只给测试用**——pglite 是 Postgres 编译成的 WASM，进程内跑，让一致性套件的 Postgres
 * 那一档不需要起服务（CI 不用配 service container、贡献者不用装 Docker）。
 *
 * 复用 Kysely 自带的 `PostgresAdapter` / `PostgresIntrospector` / `PostgresQueryCompiler`
 * ——**方言的「怎么拼 SQL」部分跟真 Postgres 一模一样**，只有「怎么把 SQL 送出去」那一层
 * 换成 pglite。这正是要的：如果连编译出来的 SQL 都不一样，这一档就没有代表性了。
 */
import type { PGlite } from "@electric-sql/pglite";
import type {
  DatabaseConnection,
  Dialect,
  Driver,
  QueryResult,
  TransactionSettings,
} from "kysely";
import {
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from "kysely";
import type { CompiledQuery, DatabaseIntrospector, Kysely, QueryCompiler } from "kysely";

class PGliteConnection implements DatabaseConnection {
  readonly #client: PGlite;

  constructor(client: PGlite) {
    this.#client = client;
  }

  async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
    const result = await this.#client.query<R>(compiled.sql, [...compiled.parameters]);
    return {
      rows: result.rows,
      // pglite 的 `affectedRows` 对 SELECT 是 undefined；Kysely 只在 update/delete
      // 路径上读这两个字段，那时它一定有值。
      numAffectedRows: result.affectedRows === undefined ? undefined : BigInt(result.affectedRows),
    };
  }

  /** Kysely 的接口要求它存在；本 driver 不支持流式，调到就抛。测试路径上不会走到。 */
  streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("pglite 测试 driver 不支持 streamQuery");
  }
}

class PGliteDriver implements Driver {
  readonly #client: PGlite;
  readonly #connection: PGliteConnection;

  constructor(client: PGlite) {
    this.#client = client;
    this.#connection = new PGliteConnection(client);
  }

  init(): Promise<void> {
    return Promise.resolve();
  }

  acquireConnection(): Promise<DatabaseConnection> {
    return Promise.resolve(this.#connection);
  }

  async beginTransaction(conn: DatabaseConnection, _settings: TransactionSettings): Promise<void> {
    await conn.executeQuery({ sql: "begin", parameters: [], query: undefined as never, queryId: undefined as never });
  }

  async commitTransaction(conn: DatabaseConnection): Promise<void> {
    await conn.executeQuery({ sql: "commit", parameters: [], query: undefined as never, queryId: undefined as never });
  }

  async rollbackTransaction(conn: DatabaseConnection): Promise<void> {
    await conn.executeQuery({ sql: "rollback", parameters: [], query: undefined as never, queryId: undefined as never });
  }

  releaseConnection(): Promise<void> {
    return Promise.resolve();
  }

  async destroy(): Promise<void> {
    await this.#client.close();
  }
}

export function pgliteDialect(client: PGlite): Dialect {
  return {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new PGliteDriver(client),
    createIntrospector: (db: Kysely<unknown>): DatabaseIntrospector => new PostgresIntrospector(db),
    createQueryCompiler: (): QueryCompiler => new PostgresQueryCompiler(),
  };
}
