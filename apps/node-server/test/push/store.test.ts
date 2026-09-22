/** `push_subscriptions` 的读写（docs/ingress/tech/push-notification.md §2）。 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../../src/db/instance.js';
import {
  deleteSubscription,
  listSubscriptions,
  markError,
  markSent,
  upsertSubscription,
} from '../../src/push/store.js';
import { createTestDb, seedUser } from '../helpers/test-db.js';

const ENDPOINT = 'https://fcm.example/send/abc';

describe('push/store', () => {
  let db: Db;

  beforeEach(async () => {
    db = await createTestDb();
    await seedUser(db, 'user-1');
    await seedUser(db, 'user-2');
  });

  it('upsert 两次只有一行，后一次的密钥与 UA 生效', async () => {
    await upsertSubscription(db, {
      endpoint: ENDPOINT,
      userId: 'user-1',
      p256dh: 'key-1',
      auth: 'auth-1',
      userAgent: 'Chrome',
    });
    await upsertSubscription(db, {
      endpoint: ENDPOINT,
      userId: 'user-1',
      p256dh: 'key-2',
      auth: 'auth-2',
      userAgent: 'Firefox',
    });

    const rows = await listSubscriptions(db, 'user-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.p256dh).toBe('key-2');
    expect(rows[0]?.auth).toBe('auth-2');
    expect(rows[0]?.userAgent).toBe('Firefox');
  });

  it('同一台设备换账号登录：行还是一行，归属换人', async () => {
    await upsertSubscription(db, {
      endpoint: ENDPOINT,
      userId: 'user-1',
      p256dh: 'k',
      auth: 'a',
    });
    await upsertSubscription(db, {
      endpoint: ENDPOINT,
      userId: 'user-2',
      p256dh: 'k',
      auth: 'a',
    });

    expect(await listSubscriptions(db, 'user-1')).toHaveLength(0);
    expect(await listSubscriptions(db, 'user-2')).toHaveLength(1);
  });

  it('createdAt 不被重复上报刷新（记的是"第一次开启通知"）', async () => {
    // 列是毫秒时间戳，真等一秒太慢；用假时钟把时间推远，同时也就不依赖机器快慢了。
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-27T10:00:00Z'));
      await upsertSubscription(db, {
        endpoint: ENDPOINT,
        userId: 'user-1',
        p256dh: 'k',
        auth: 'a',
      });
      const first = (await listSubscriptions(db, 'user-1'))[0]?.createdAt;

      vi.setSystemTime(new Date('2026-07-27T11:00:00Z'));
      await upsertSubscription(db, {
        endpoint: ENDPOINT,
        userId: 'user-1',
        p256dh: 'k',
        auth: 'a',
      });
      expect((await listSubscriptions(db, 'user-1'))[0]?.createdAt).toEqual(
        first,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('重新上报会清掉上一次的失败痕迹', async () => {
    await upsertSubscription(db, {
      endpoint: ENDPOINT,
      userId: 'user-1',
      p256dh: 'k',
      auth: 'a',
    });
    await markError(db, ENDPOINT, '推送服务 500');
    expect((await listSubscriptions(db, 'user-1'))[0]?.lastError).toBe(
      '推送服务 500',
    );

    await upsertSubscription(db, {
      endpoint: ENDPOINT,
      userId: 'user-1',
      p256dh: 'k',
      auth: 'a',
    });
    expect((await listSubscriptions(db, 'user-1'))[0]?.lastError).toBeNull();
  });

  it('markSent 记时刻并清失败；markError 只留痕不删行', async () => {
    await upsertSubscription(db, {
      endpoint: ENDPOINT,
      userId: 'user-1',
      p256dh: 'k',
      auth: 'a',
    });
    await markError(db, ENDPOINT, 'boom');
    await markSent(db, ENDPOINT);

    const row = (await listSubscriptions(db, 'user-1'))[0];
    expect(row?.lastSentAt).toBeInstanceOf(Date);
    expect(row?.lastError).toBeNull();
  });

  it('删除幂等：删不存在的 endpoint 不报错', async () => {
    await expect(
      deleteSubscription(db, 'https://nope.example/x'),
    ).resolves.toBeUndefined();

    await upsertSubscription(db, {
      endpoint: ENDPOINT,
      userId: 'user-1',
      p256dh: 'k',
      auth: 'a',
    });
    await deleteSubscription(db, ENDPOINT);
    expect(await listSubscriptions(db, 'user-1')).toHaveLength(0);
  });

  it('按人隔离：查不到别人的订阅', async () => {
    await upsertSubscription(db, {
      endpoint: ENDPOINT,
      userId: 'user-1',
      p256dh: 'k',
      auth: 'a',
    });
    expect(await listSubscriptions(db, 'user-2')).toHaveLength(0);
  });
});
