/**
 * **同一批读写，在两种库上各跑一遍。**
 *
 * 一份查询代码同时伺候 SQLite 与 Postgres，最容易出事的正是两边行为不一致的地方：
 * 毫秒时间戳（一边 `integer` 一边 `bigint`，后者读回来默认是字符串）、upsert 的写法、
 * `null` 与「没有这一列」。只在 SQLite 上测的话，这些要等换库那天才在生产上现形。
 *
 * Postgres 那一档用 pglite（Postgres 编译成的 WASM，进程内跑），**编译出来的 SQL 与真
 * Postgres 一模一样**，只有「怎么把 SQL 送出去」那一层不同。
 */
import { PGlite } from '@electric-sql/pglite';
import Database from 'better-sqlite3';
import type {
  DatabaseConnection,
  Dialect,
  Driver,
  QueryResult,
  TransactionSettings,
} from 'kysely';
import {
  CompiledQuery,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  SqliteDialect,
} from 'kysely';
import { describe, expect, it } from 'vitest';

import {
  grantConversationApproval,
  hasConversationGrant,
} from '../../src/agent/conversation-grants.js';
import {
  createConversation,
  getConversation,
  listConversations,
  updateConversation,
} from '../../src/agent/store.js';
import type { Db } from '../../src/db/instance.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import type { ChatDatabase } from '../../src/db/schema.js';
import {
  listSubscriptions,
  markSent,
  upsertSubscription,
} from '../../src/push/store.js';
import { silentLogger } from '../helpers/silent-logger.js';
import { seedUser } from '../helpers/test-db.js';

// ---------------------------------------------------------------------------
// pglite → Kysely dialect（只给测试用；与 packages/persist-kysely 的同名 helper 同款）
// ---------------------------------------------------------------------------

class PGliteConnection implements DatabaseConnection {
  readonly #client: PGlite;

  constructor(client: PGlite) {
    this.#client = client;
  }

  async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
    const result = await this.#client.query<R>(compiled.sql, [
      ...compiled.parameters,
    ]);
    return {
      rows: result.rows,
      numAffectedRows:
        result.affectedRows === undefined ?
          undefined
        : BigInt(result.affectedRows),
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('pglite dialect does not stream');
  }
}

function pgliteDialect(client: PGlite): Dialect {
  const connection = new PGliteConnection(client);
  const driver: Driver = {
    init: () => Promise.resolve(),
    acquireConnection: () => Promise.resolve(connection),
    beginTransaction: async (conn: DatabaseConnection, _s: TransactionSettings) => {
      await conn.executeQuery(CompiledQuery.raw('begin'));
    },
    commitTransaction: async (conn: DatabaseConnection) => {
      await conn.executeQuery(CompiledQuery.raw('commit'));
    },
    rollbackTransaction: async (conn: DatabaseConnection) => {
      await conn.executeQuery(CompiledQuery.raw('rollback'));
    },
    releaseConnection: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
  };
  return {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => driver,
    createIntrospector: (db: Kysely<unknown>) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  };
}

// ---------------------------------------------------------------------------

interface Dialect_ {
  name: string;
  make: () => Promise<Db>;
}

const DIALECTS: Dialect_[] = [
  {
    name: 'sqlite',
    make: async () => {
      const db = new Kysely<ChatDatabase>({
        dialect: new SqliteDialect({ database: new Database(':memory:') }),
      });
      await migrateDatabase(db, 'sqlite', silentLogger);
      return db;
    },
  },
  {
    name: 'postgres (pglite)',
    make: async () => {
      const db = new Kysely<ChatDatabase>({
        dialect: pgliteDialect(new PGlite()),
      });
      await migrateDatabase(db, 'postgres', silentLogger);
      return db;
    },
  },
];

describe.each(DIALECTS)('两种库跑同一批读写 · $name', ({ make }) => {
  it('建表跑得通，表都在', async () => {
    const db = await make();
    // 三拨表各抽一张：better-auth 的、本应用的、框架的。
    await expect(db.selectFrom('user').selectAll().execute()).resolves.toEqual(
      [],
    );
    await expect(
      db.selectFrom('conversations').selectAll().execute(),
    ).resolves.toEqual([]);
    await expect(
      db.selectFrom('agent_ledger').selectAll().execute(),
    ).resolves.toEqual([]);
  });

  it('会话：存进去什么样，读回来就什么样（时间是毫秒精度的 Date）', async () => {
    const db = await make();
    await seedUser(db, 'user-1');

    const created = await createConversation(db, {
      id: 'conv-1',
      userId: 'user-1',
      title: '试一下',
      repo: 'acme/demo',
      branchName: 'runko/chat-1',
      sandboxName: 'runko-chat-conv-1',
      provider: 'local',
    });

    const read = await getConversation(db, 'conv-1', 'user-1');
    expect(read?.title).toBe('试一下');
    expect(read?.provider).toBe('local');
    expect(read?.createdAt.getTime()).toBe(created.createdAt.getTime());
    expect(read?.lastActiveAt).toBeInstanceOf(Date);

    await updateConversation(db, 'conv-1', { status: 'sleeping' });
    expect((await getConversation(db, 'conv-1', 'user-1'))?.status).toBe(
      'sleeping',
    );
    expect(await listConversations(db, 'user-1')).toHaveLength(1);
  });

  it('本地沙盒没有仓库与分支：两列存 null，读回来还是 null', async () => {
    const db = await make();
    await seedUser(db, 'user-1');

    await createConversation(db, {
      id: 'conv-local',
      userId: 'user-1',
      title: '本地',
      repo: null,
      branchName: null,
      sandboxName: 'runko-chat-conv-local',
      provider: 'local',
    });

    const read = await getConversation(db, 'conv-local', 'user-1');
    expect(read?.repo).toBeNull();
    expect(read?.branchName).toBeNull();
  });

  it('推送订阅的 upsert：同一个 endpoint 重复登记只有一行，密钥被覆盖', async () => {
    const db = await make();
    await seedUser(db, 'user-1');

    await upsertSubscription(db, {
      endpoint: 'https://push.example/1',
      userId: 'user-1',
      p256dh: 'key-1',
      auth: 'auth-1',
      userAgent: 'Chrome',
    });
    await upsertSubscription(db, {
      endpoint: 'https://push.example/1',
      userId: 'user-1',
      p256dh: 'key-2',
      auth: 'auth-2',
      userAgent: 'Firefox',
    });

    const rows = await listSubscriptions(db, 'user-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.p256dh).toBe('key-2');

    await markSent(db, 'https://push.example/1');
    expect((await listSubscriptions(db, 'user-1'))[0]?.lastSentAt).toBeInstanceOf(
      Date,
    );
  });

  it('会话级授权：重复授权幂等，查得到自己的、查不到别人的', async () => {
    const db = await make();
    await seedUser(db, 'user-1');

    const input = { command: 'rm -rf build' };
    await grantConversationApproval(db, 'conv-1', 'user-1', 'bash', input);
    await grantConversationApproval(db, 'conv-1', 'user-1', 'bash', input);

    expect(
      await hasConversationGrant(db, 'conv-1', 'user-1', 'bash', input),
    ).toBe(true);
    expect(
      await hasConversationGrant(db, 'conv-1', 'user-2', 'bash', input),
    ).toBe(false);
  });
});
