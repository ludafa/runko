/**
 * 一个能**故意坏掉**的 SQLite dialect——只给测试用。
 *
 * 心跳的自我围栏有两种失败形状要覆盖，两种都必须能在测试里造出来：
 *
 * - **抛错**：库连不上。`fail(n)` 让接下来 n 条查询直接 reject。
 * - **挂住不返回**：TCP 黑洞、连接池耗尽、网络分区下的 TCP 停滞。`hang()` 让此后每条
 *   查询都返回一个**永不 settle** 的 promise。这一档比抛错更常见，也更难写对——它
 *   进不了 `catch`，只是让上一拍永远不结束。
 *
 * 实现上只包住 driver 那一层：**怎么拼 SQL 完全走真的 `SqliteDialect`**，只有「怎么把
 * SQL 送出去」被换掉，这样测出来的行为才有代表性。
 */
import type Database from "better-sqlite3";
import type {
  AbortableOperationOptions,
  CompiledQuery,
  DatabaseConnection,
  DatabaseIntrospector,
  Dialect,
  DialectAdapter,
  Driver,
  Kysely,
  QueryCompiler,
  QueryResult,
  TransactionSettings,
} from "kysely";
import { SqliteDialect } from "kysely";

export interface FaultyDialect {
  dialect: Dialect;
  /** 接下来 `count` 条查询直接抛错（模拟连不上）。 */
  fail: (count: number) => void;
  /** 此后每条查询都挂住不返回（模拟 TCP 黑洞 / 连接池耗尽）。 */
  hang: () => void;
}

export function faultySqlite(database: Database.Database): FaultyDialect {
  const inner = new SqliteDialect({ database });
  let failures = 0;
  let hanging = false;

  class FaultyConnection implements DatabaseConnection {
    readonly #inner: DatabaseConnection;

    constructor(connection: DatabaseConnection) {
      this.#inner = connection;
    }

    async executeQuery<R>(compiled: CompiledQuery, options?: AbortableOperationOptions): Promise<QueryResult<R>> {
      if (hanging) {
        // 永不 settle——这正是「挂住」那一档，`catch` 永远等不到。
        return await new Promise<QueryResult<R>>(() => undefined);
      }
      if (failures > 0) {
        failures -= 1;
        throw new Error("simulated db failure");
      }
      return await this.#inner.executeQuery<R>(compiled, options);
    }

    streamQuery<R>(
      compiled: CompiledQuery,
      chunkSize: number,
      options?: AbortableOperationOptions,
    ): AsyncIterableIterator<QueryResult<R>> {
      return this.#inner.streamQuery<R>(compiled, chunkSize, options);
    }
  }

  /** 包装连接 → 原连接。driver 的其余方法都要拿原连接，不能把包装传回去。 */
  const originals = new WeakMap<DatabaseConnection, DatabaseConnection>();
  const unwrap = (connection: DatabaseConnection): DatabaseConnection => originals.get(connection) ?? connection;

  return {
    fail: (count: number): void => {
      failures = count;
    },
    hang: (): void => {
      hanging = true;
    },
    dialect: {
      createAdapter: (): DialectAdapter => inner.createAdapter(),
      createQueryCompiler: (): QueryCompiler => inner.createQueryCompiler(),
      createIntrospector: (db: Kysely<never>): DatabaseIntrospector => inner.createIntrospector(db),
      createDriver: (): Driver => {
        const driver = inner.createDriver();
        return {
          init: async (): Promise<void> => {
            await driver.init();
          },
          acquireConnection: async (): Promise<DatabaseConnection> => {
            const connection = await driver.acquireConnection();
            const wrapped = new FaultyConnection(connection);
            originals.set(wrapped, connection);
            return wrapped;
          },
          beginTransaction: async (connection, settings: TransactionSettings): Promise<void> => {
            await driver.beginTransaction(unwrap(connection), settings);
          },
          commitTransaction: async (connection): Promise<void> => {
            await driver.commitTransaction(unwrap(connection));
          },
          rollbackTransaction: async (connection): Promise<void> => {
            await driver.rollbackTransaction(unwrap(connection));
          },
          releaseConnection: async (connection): Promise<void> => {
            await driver.releaseConnection(unwrap(connection));
          },
          destroy: async (): Promise<void> => {
            await driver.destroy();
          },
        };
      },
    },
  };
}
