/**
 * D1 上的 Kysely 方言：在真的 D1（workerd 本地模拟）上跑读写，确认影响行数、自增 id、
 * 「不支持事务」与绑定值检查这几处约定。
 */
import { env } from 'cloudflare:workers';
import { Kysely, sql } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';

import { D1Dialect, toD1Binding } from '../src/db/d1-dialect.js';

interface Tables {
  dialect_probe: { id: number | null; name: string; score: number };
}

const db = new Kysely<Tables>({ dialect: new D1Dialect(env.DB) });

beforeAll(async () => {
  await sql`CREATE TABLE IF NOT EXISTS dialect_probe (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    score INTEGER NOT NULL
  )`.execute(db);
});

describe('D1Dialect', () => {
  it('插入拿得到自增 id，更新与删除报准影响行数', async () => {
    const inserted = await db
      .insertInto('dialect_probe')
      .values({ name: 'a', score: 1 })
      .executeTakeFirstOrThrow();
    expect(typeof inserted.insertId).toBe('bigint');
    expect(inserted.insertId).toBeGreaterThan(0n);

    await db
      .insertInto('dialect_probe')
      .values([
        { name: 'b', score: 2 },
        { name: 'c', score: 3 },
      ])
      .execute();

    const updated = await db
      .updateTable('dialect_probe')
      .set({ score: 10 })
      .where('score', '>=', 2)
      .executeTakeFirstOrThrow();
    expect(updated.numUpdatedRows).toBe(2n);

    const none = await db
      .updateTable('dialect_probe')
      .set({ score: 0 })
      .where('name', '=', 'nobody')
      .executeTakeFirstOrThrow();
    expect(none.numUpdatedRows).toBe(0n);

    const deleted = await db
      .deleteFrom('dialect_probe')
      .where('name', 'in', ['a', 'b'])
      .executeTakeFirstOrThrow();
    expect(deleted.numDeletedRows).toBe(2n);

    const rows = await db.selectFrom('dialect_probe').selectAll().execute();
    expect(rows.map((row) => [row.name, row.score])).toEqual([['c', 10]]);
  });

  it('upsert（ON CONFLICT DO UPDATE）照常编译执行', async () => {
    const first = await db
      .insertInto('dialect_probe')
      .values({ name: 'u', score: 1 })
      .executeTakeFirstOrThrow();
    const id = Number(first.insertId);
    await db
      .insertInto('dialect_probe')
      .values({ id, name: 'u', score: 2 })
      .onConflict((oc) => oc.column('id').doUpdateSet({ score: 2 }))
      .execute();
    const row = await db
      .selectFrom('dialect_probe')
      .select('score')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.score).toBe(2);
  });

  it('事务当场报错，而不是悄悄一条一条执行', async () => {
    await expect(
      db.transaction().execute(async (trx) => {
        await trx
          .insertInto('dialect_probe')
          .values({ name: 'tx', score: 1 })
          .execute();
      }),
    ).rejects.toThrow(/does not support interactive transactions/);
    const rows = await db
      .selectFrom('dialect_probe')
      .select('name')
      .where('name', '=', 'tx')
      .execute();
    expect(rows).toEqual([]);
  });
});

describe('toD1Binding', () => {
  it('原样放行 D1 收得下的值', () => {
    expect(toD1Binding('s')).toBe('s');
    expect(toD1Binding(1.5)).toBe(1.5);
    expect(toD1Binding(true)).toBe(true);
    expect(toD1Binding(null)).toBeNull();
    expect(toD1Binding(undefined)).toBeNull();
    const bytes = new Uint8Array([1, 2]);
    expect(toD1Binding(bytes)).toBe(bytes);
  });

  it('安全范围内的 bigint 转成 number，超出的当场报', () => {
    expect(toD1Binding(42n)).toBe(42);
    expect(() => toD1Binding(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow(
      RangeError,
    );
  });

  it('Date 与对象不收，报错里说清楚该怎么传', () => {
    expect(() => toD1Binding(new Date())).toThrow(/getTime\(\) or toISOString/);
    expect(() => toD1Binding({ a: 1 })).toThrow(TypeError);
  });
});
