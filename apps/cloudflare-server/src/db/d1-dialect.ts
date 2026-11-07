/**
 * D1 上的 Kysely 方言：编译用 Kysely 自带的 SQLite 编译器，执行交给 D1 的
 * `prepare().bind().all()`。better-auth 与 chat 应用的数据访问都吃这个实例。
 *
 * D1 没有交互式事务（`BEGIN` 发不出去），所以 `transaction()` 当场报错，而不是悄悄退化成
 * 一条一条执行——那样会把「要么全成、要么全不成」静默变成「可能做一半」。
 */
import type {
  CompiledQuery,
  DatabaseConnection,
  DatabaseIntrospector,
  Dialect,
  DialectAdapter,
  Driver,
  Kysely,
  QueryCompiler,
  QueryResult,
} from 'kysely';
import { SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler } from 'kysely';

const TRANSACTION_UNSUPPORTED =
  'D1 does not support interactive transactions; use D1Database.batch() for atomic multi-statement writes.';

const STREAM_UNSUPPORTED =
  'D1 dialect does not support streaming queries; use execute() instead.';

/** D1 收 string / number / boolean / null / 字节。Date 与超出安全整数的 bigint 会被写错，当场报。 */
export function toD1Binding(value: unknown): unknown {
  if (value === undefined || value === null) {
    return null;
  }
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'bigint') {
    if (
      value > BigInt(Number.MAX_SAFE_INTEGER) ||
      value < BigInt(Number.MIN_SAFE_INTEGER)
    ) {
      throw new RangeError(
        `D1 cannot store ${String(value)} exactly: integers must fit in a JS number.`,
      );
    }
    return Number(value);
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return value;
  }
  const kind =
    value instanceof Date ?
      'a Date (pass getTime() or toISOString())'
    : typeof value;
  throw new TypeError(
    `D1 cannot bind ${kind}; use a string, number, boolean, bigint, null or bytes.`,
  );
}

class D1Connection implements DatabaseConnection {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
    const statement = this.#db
      .prepare(compiled.sql)
      .bind(...compiled.parameters.map(toD1Binding));
    const result = await statement.all<R>();
    const changes = result.meta.changes;
    const lastRowId = result.meta.last_row_id;
    return {
      rows: result.results,
      // 只读语句的 `changes` 是 0，Kysely 只在写语句上读它。
      numAffectedRows: BigInt(changes),
      ...(changes > 0 && typeof lastRowId === 'number' ?
        { insertId: BigInt(lastRowId) }
      : {}),
    };
  }

  streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error(STREAM_UNSUPPORTED);
  }
}

class D1Driver implements Driver {
  readonly #connection: D1Connection;

  constructor(db: D1Database) {
    this.#connection = new D1Connection(db);
  }

  init(): Promise<void> {
    return Promise.resolve();
  }

  acquireConnection(): Promise<DatabaseConnection> {
    return Promise.resolve(this.#connection);
  }

  beginTransaction(): Promise<void> {
    return Promise.reject(new Error(TRANSACTION_UNSUPPORTED));
  }

  commitTransaction(): Promise<void> {
    return Promise.reject(new Error(TRANSACTION_UNSUPPORTED));
  }

  rollbackTransaction(): Promise<void> {
    return Promise.reject(new Error(TRANSACTION_UNSUPPORTED));
  }

  releaseConnection(): Promise<void> {
    return Promise.resolve();
  }

  /** 绑定归平台管，关不掉也不该关。 */
  destroy(): Promise<void> {
    return Promise.resolve();
  }
}

export class D1Dialect implements Dialect {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  createDriver(): Driver {
    return new D1Driver(this.#db);
  }

  createQueryCompiler(): QueryCompiler {
    return new SqliteQueryCompiler();
  }

  createAdapter(): DialectAdapter {
    return new SqliteAdapter();
  }

  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new SqliteIntrospector(db);
  }
}
