/**
 * 本地沙盒的快照存进会话对象 SQLite：切块规则，以及在真的对象存储上存取、覆盖。
 */
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import {
  durableObjectSnapshotStore,
  migrateSnapshotStore,
  SNAPSHOT_TABLE,
  splitChunks,
} from '../src/sandbox/snapshot-store.js';

function freshObject() {
  return env.CONVERSATION.get(
    env.CONVERSATION.idFromName(`snapshot/${crypto.randomUUID()}`),
  );
}

describe('splitChunks', () => {
  it('空串也给一块：「存过空快照」与「从没存过」分得开', () => {
    expect(splitChunks('')).toEqual(['']);
  });

  it('按块大小切，拼回去不变', () => {
    const text = 'abcdefghij';
    const chunks = splitChunks(text, 3);
    expect(chunks).toEqual(['abc', 'def', 'ghi', 'j']);
    expect(chunks.join('')).toBe(text);
  });

  it('边界落在代理对中间时往前挪一格，每一块都是完整的 UTF-16', () => {
    // 'ab😀cd'：😀 占下标 2、3。块大小 3 的边界正好劈开它。
    const text = 'ab😀cd';
    const chunks = splitChunks(text, 3);
    expect(chunks).toEqual(['ab', '😀c', 'd']);
    for (const chunk of chunks) {
      expect(chunk.isWellFormed()).toBe(true);
    }
    expect(chunks.join('')).toBe(text);
  });

  it('块大小为 1 时整个代理对放进一块，不会原地打转', () => {
    const text = '😀a😀';
    expect(splitChunks(text, 1)).toEqual(['😀', 'a', '😀']);
  });
});

describe('durableObjectSnapshotStore', () => {
  it('没存过读出 undefined；存了读回同一份与同一个版本号', async () => {
    await runInDurableObject(freshObject(), async (_instance, state) => {
      migrateSnapshotStore(state.storage);
      const store = durableObjectSnapshotStore(state.storage);
      expect(await store.read('box')).toBeUndefined();

      await store.write('box', 3, '{"files":{}}');
      expect(await store.read('box')).toEqual({
        version: 3,
        snapshot: '{"files":{}}',
      });

      await store.write('empty', 1, '');
      expect(await store.read('empty')).toEqual({ version: 1, snapshot: '' });
    });
  });

  it('超过一块的快照切成多行存，读回拼得严丝合缝；再写短的会把多出来的行清掉', async () => {
    await runInDurableObject(freshObject(), async (_instance, state) => {
      migrateSnapshotStore(state.storage);
      const store = durableObjectSnapshotStore(state.storage);
      // 600K 个字符，含中文与 emoji：超过一块（512K 字符），落在不止一行。
      const big = '文件内容😀'.repeat(100_000);
      await store.write('big', 1, big);
      const rows = state.storage.sql
        .exec<{ n: number }>(
          `SELECT count(*) AS n FROM "${SNAPSHOT_TABLE}" WHERE "sandbox_name" = ?`,
          'big',
        )
        .one();
      expect(rows.n).toBeGreaterThan(1);
      expect(await store.read('big')).toEqual({ version: 1, snapshot: big });

      await store.write('big', 2, 'small');
      const after = state.storage.sql
        .exec<{ n: number }>(
          `SELECT count(*) AS n FROM "${SNAPSHOT_TABLE}" WHERE "sandbox_name" = ?`,
          'big',
        )
        .one();
      expect(after.n).toBe(1);
      expect(await store.read('big')).toEqual({
        version: 2,
        snapshot: 'small',
      });
    });
  });

  it('不同沙盒的快照互不相干', async () => {
    await runInDurableObject(freshObject(), async (_instance, state) => {
      migrateSnapshotStore(state.storage);
      const store = durableObjectSnapshotStore(state.storage);
      await store.write('a', 1, 'A');
      await store.write('b', 1, 'B');
      await store.write('a', 2, 'A2');
      expect(await store.read('b')).toEqual({ version: 1, snapshot: 'B' });
      expect(await store.read('a')).toEqual({ version: 2, snapshot: 'A2' });
    });
  });
});
