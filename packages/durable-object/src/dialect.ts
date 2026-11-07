/**
 * Durable Object 自带 SQLite（`ctx.storage.sql`）的 Kysely 方言。
 *
 * 「怎么拼 SQL」全用 Kysely 自带的 SQLite 那一套（编译器、适配器、内省），只有「怎么把 SQL
 * 送出去」换成 `sql.exec()`。所以编出来的 SQL 与 better-sqlite3 那一档一模一样。
 *
 * 本文件不 import 任何 Cloudflare 的东西：`SqlStorageLike` 是 `ctx.storage.sql` 的结构化最小子集，
 * 真的 `SqlStorage` 天然满足它。
 */
import type {
  CompiledQuery,
  DatabaseConnection,
  DatabaseIntrospector,
  Dialect,
  DialectAdapter,
  Driver,
  QueryCompiler,
  QueryResult,
} from "kysely";
import { Kysely, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler } from "kysely";

/** `sql.exec()` 返回的游标——只用到这两样。 */
export interface SqlStorageCursorLike {
  toArray(): Record<string, unknown>[];
  /** 这条语句写了多少行。**含索引的写入**，所以不能当影响行数用（见 `affectedRows`）。 */
  readonly rowsWritten: number;
}

/** `ctx.storage.sql` 的结构化最小子集。 */
export interface SqlStorageLike {
  exec(query: string, ...bindings: unknown[]): SqlStorageCursorLike;
}

export interface DurableObjectSqliteDialectConfig {
  sql: SqlStorageLike;
}

const TRANSACTION_UNSUPPORTED =
  "Durable Object SQL does not allow BEGIN/SAVEPOINT, so Kysely transactions are not supported here. " +
  "Wrap the work in ctx.storage.transactionSync(() => ...) instead (its callback must be synchronous).";

const STREAM_UNSUPPORTED = "Durable Object SQL dialect does not support streaming queries; use execute() instead.";

/** Kysely 查询树里会写行的那几种根节点。 */
const WRITE_KINDS = new Set(["InsertQueryNode", "UpdateQueryNode", "DeleteQueryNode", "MergeQueryNode"]);

/** 手写 SQL（`sql\`...\``）只认开头的关键字。`WITH ... UPDATE` 这种认不出来，不报影响行数。 */
const RAW_WRITE = /^\s*(?:insert|update|delete|replace)\b/i;

function isWriteStatement(compiled: CompiledQuery): boolean {
  const kind = compiled.query.kind;
  if (WRITE_KINDS.has(kind)) {
    return true;
  }
  return kind === "RawNode" && RAW_WRITE.test(compiled.sql);
}

/**
 * 把 Kysely 给的参数换成 DO SQL 收的类型。
 *
 * DO SQL 只收 string / number / null / ArrayBuffer（及其视图），其余类型的行为实测如下：
 * boolean 会被绑成字符串 `"true"`，Date 会被绑成 `toString()` 的那串英文，bigint 直接抛。
 * 前两种是静默写错，所以这里要么换成对的、要么当场抛。
 */
export function toSqlBinding(value: unknown): unknown {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "string" || typeof value === "number") {
    return value;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (typeof value === "bigint") {
    // 读回来也只有 number：超出安全整数的值存进去就再也读不准，不如当场报。
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new RangeError(`Durable Object SQL cannot store ${String(value)} exactly: integers must fit in a JS number.`);
    }
    return Number(value);
  }
  if (value instanceof ArrayBuffer) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  const kind = value instanceof Date ? "a Date (pass getTime() or toISOString())" : typeof value;
  throw new TypeError(`Durable Object SQL cannot bind ${kind}; use a string, number, boolean, bigint, null or bytes.`);
}

/**
 * 写语句的影响行数。
 *
 * 不能用游标的 `rowsWritten`：它把索引的写入也算进去（实测：往有主键和一个索引的表插一行报 3）。
 * 准数是写完立刻查一次 `changes()`。`exec` 是同步的，中间插不进别的语句，所以查到的就是这一条的。
 * 一行都没写时 `changes()` 必为 0，省掉这一次查询。
 */
function affectedRows(sql: SqlStorageLike, cursor: SqlStorageCursorLike): { numAffectedRows: bigint; insertId?: bigint } {
  if (cursor.rowsWritten === 0) {
    return { numAffectedRows: 0n };
  }
  const row = sql.exec("SELECT changes() AS changes, last_insert_rowid() AS insert_id").toArray()[0];
  const changes = row?.["changes"];
  const insertId = row?.["insert_id"];
  return {
    numAffectedRows: BigInt(typeof changes === "number" ? changes : 0),
    ...(typeof insertId === "number" ? { insertId: BigInt(insertId) } : {}),
  };
}

class DurableObjectSqliteConnection implements DatabaseConnection {
  readonly #sql: SqlStorageLike;

  constructor(sql: SqlStorageLike) {
    this.#sql = sql;
  }

  executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
    try {
      const cursor = this.#sql.exec(compiled.sql, ...compiled.parameters.map(toSqlBinding));
      // 行的形状由 Kysely 的查询类型保证，这里是 driver 交回 Kysely 的那条边界。
      const rows = cursor.toArray() as R[];
      if (!isWriteStatement(compiled)) {
        return Promise.resolve({ rows });
      }
      return Promise.resolve({ rows, ...affectedRows(this.#sql, cursor) });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error(STREAM_UNSUPPORTED);
  }
}

class DurableObjectSqliteDriver implements Driver {
  readonly #connection: DurableObjectSqliteConnection;

  constructor(sql: SqlStorageLike) {
    this.#connection = new DurableObjectSqliteConnection(sql);
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

  /** DO 的存储归平台管，关不掉也不该关。 */
  destroy(): Promise<void> {
    return Promise.resolve();
  }
}

export class DurableObjectSqliteDialect implements Dialect {
  readonly #sql: SqlStorageLike;

  constructor(config: DurableObjectSqliteDialectConfig) {
    this.#sql = config.sql;
  }

  createDriver(): Driver {
    return new DurableObjectSqliteDriver(this.#sql);
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

/** `ctx.storage.sql` → Kysely 实例。 */
export function durableObjectKysely<DB>(sql: SqlStorageLike): Kysely<DB> {
  return new Kysely<DB>({ dialect: new DurableObjectSqliteDialect({ sql }) });
}
