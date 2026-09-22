/**
 * [在场](../../../../docs/terms.md)（docs/ingress/tech/push-notification.md §5.2）——
 * 存在库里，到点自动作废。用假时钟测，不真等 45 秒。
 *
 * 最要紧的一条是最后那个：**上报与读取不在同一个进程里也要算数**，多副本靠这条。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../../src/db/instance.js';
import {
  clearPresent,
  isPresent,
  markPresent,
} from '../../src/push/presence.js';
import { createTestDb } from '../helpers/test-db.js';

describe('push/presence', () => {
  let db: Db;

  beforeEach(async () => {
    db = await createTestDb();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-27T10:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('没上报过就不在场', async () => {
    expect(await isPresent(db, 'user-1', 'conv-1')).toBe(false);
  });

  it('上报后 44 秒仍在场，46 秒后过期', async () => {
    await markPresent(db, 'user-1', 'conv-1');
    vi.advanceTimersByTime(44_000);
    expect(await isPresent(db, 'user-1', 'conv-1')).toBe(true);

    vi.advanceTimersByTime(2_000);
    expect(await isPresent(db, 'user-1', 'conv-1')).toBe(false);
  });

  it('心跳续期不累加，每次都是从现在起 45 秒', async () => {
    await markPresent(db, 'user-1', 'conv-1');
    vi.advanceTimersByTime(20_000);
    await markPresent(db, 'user-1', 'conv-1'); // 一次心跳
    vi.advanceTimersByTime(40_000); // 距首次上报 60 秒，距最近一次 40 秒
    expect(await isPresent(db, 'user-1', 'conv-1')).toBe(true);
  });

  it('clearPresent 立即生效，不等过期', async () => {
    await markPresent(db, 'user-1', 'conv-1');
    await clearPresent(db, 'user-1', 'conv-1');
    expect(await isPresent(db, 'user-1', 'conv-1')).toBe(false);
  });

  it('按 (用户, 会话) 隔离：别人的在场不算我的，别的会话也不算', async () => {
    await markPresent(db, 'user-1', 'conv-1');
    expect(await isPresent(db, 'user-2', 'conv-1')).toBe(false);
    expect(await isPresent(db, 'user-1', 'conv-2')).toBe(false);
  });

  it('过期的行不算在场，下一次写入时被清掉', async () => {
    await markPresent(db, 'user-1', 'conv-1');
    vi.advanceTimersByTime(60_000);
    expect(await isPresent(db, 'user-1', 'conv-1')).toBe(false);

    // 任何一次写入都会顺手清掉过期行，这张表不会一直长胖。
    await markPresent(db, 'user-2', 'conv-9');
    const rows = await db.selectFrom('chat_presence').selectAll().execute();
    expect(rows.map((row) => row.user_id)).toEqual(['user-2']);
  });

  it('**上报与读取不在同一个进程也算数**——多副本靠这条', async () => {
    // 同一个库、两个「副本」：上报走这边，读在那边。
    await markPresent(db, 'user-1', 'conv-1');
    const anotherReplica = db;
    expect(await isPresent(anotherReplica, 'user-1', 'conv-1')).toBe(true);
  });
});
