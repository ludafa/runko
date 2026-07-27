/**
 * 投递层（docs/tech/push-notification.md §6）——注入假 transport，不 mock 整个
 * `web-push` 模块，也就不需要真的发网络。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../../src/agent/store.js';
import type {
  PushTransport,
  TransportOptions,
  TransportSubscription,
} from '../../src/push/sender.js';
import { sendToUser, tagFor, topicFor } from '../../src/push/sender.js';
import { listSubscriptions, upsertSubscription } from '../../src/push/store.js';
import type { PushPayload } from '../../src/push/types.js';
import { silentLogger } from '../helpers/silent-logger.js';
import { createTestDb, seedUser } from '../helpers/test-db.js';

const CONVERSATION_ID = '3f1b2c4d-1111-2222-3333-444455556666';

function payload(overrides: Partial<PushPayload> = {}): PushPayload {
  return {
    v: 1,
    kind: 'approval',
    conversationId: CONVERSATION_ID,
    title: '等你批准',
    body: '给博客站换主题 · 要跑 rm -rf build',
    url: `/chat/${CONVERSATION_ID}`,
    tag: `approval:${CONVERSATION_ID}`,
    sticky: true,
    ...overrides,
  };
}

/** 带 `statusCode` 的错误——真 `WebPushError` 与这个假的满足同一个结构守卫。 */
function httpError(statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(`HTTP ${String(statusCode)}`), { statusCode });
}

interface Call {
  subscription: TransportSubscription;
  body: string;
  options: TransportOptions;
}

function recordingTransport(behavior: (endpoint: string) => void = () => {}): {
  calls: Call[];
  transport: PushTransport;
} {
  const calls: Call[] = [];
  return {
    calls,
    transport: (subscription, body, options) => {
      calls.push({ subscription, body, options });
      behavior(subscription.endpoint);
      return Promise.resolve();
    },
  };
}

describe('push/sender —— 合并标签与 topic', () => {
  it('一轮完成与一轮失败共用一个标签组（对同一条会话互斥且时序相继）', () => {
    expect(tagFor('turn-done', 'c1')).toBe('turn:c1');
    expect(tagFor('turn-failed', 'c1')).toBe('turn:c1');
    expect(tagFor('approval', 'c1')).toBe('approval:c1');
    expect(tagFor('question', 'c1')).toBe('question:c1');
  });

  it('topic 对 36 字符 uuid 也在 32 字符以内，且字符集合法', () => {
    const topic = topicFor('approval', CONVERSATION_ID);
    expect(topic.length).toBeLessThanOrEqual(32);
    expect(topic).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it('不同 kind 的 topic 不撞车（turn-done/turn-failed 有意同组）', () => {
    expect(topicFor('approval', 'c')).not.toBe(topicFor('question', 'c'));
    expect(topicFor('turn-done', 'c')).toBe(topicFor('turn-failed', 'c'));
  });
});

describe('push/sender —— 投递', () => {
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
    seedUser(db, 'user-1');
  });

  function addSubscription(endpoint: string): void {
    upsertSubscription(db, {
      endpoint,
      userId: 'user-1',
      p256dh: 'k',
      auth: 'a',
    });
  }

  it('没有订阅时什么都不发', async () => {
    const { calls, transport } = recordingTransport();
    await sendToUser(db, 'user-1', payload(), {
      transport,
      logger: silentLogger,
    });
    expect(calls).toHaveLength(0);
  });

  it('扇出到每一台设备，成功的记 lastSentAt', async () => {
    addSubscription('https://a.example/1');
    addSubscription('https://b.example/2');
    const { calls, transport } = recordingTransport();

    await sendToUser(db, 'user-1', payload(), {
      transport,
      logger: silentLogger,
    });

    expect(calls.map((c) => c.subscription.endpoint).sort()).toEqual([
      'https://a.example/1',
      'https://b.example/2',
    ]);
    for (const row of listSubscriptions(db, 'user-1')) {
      expect(row.lastSentAt).toBeInstanceOf(Date);
    }
  });

  it('410 = 订阅作废，就地删行；同一批里成功的那台不受影响', async () => {
    addSubscription('https://gone.example/1');
    addSubscription('https://ok.example/2');
    const { transport } = recordingTransport((endpoint) => {
      if (endpoint.includes('gone')) throw httpError(410);
    });

    await sendToUser(db, 'user-1', payload(), {
      transport,
      logger: silentLogger,
    });

    const rows = listSubscriptions(db, 'user-1');
    expect(rows.map((r) => r.endpoint)).toEqual(['https://ok.example/2']);
    expect(rows[0]?.lastSentAt).toBeInstanceOf(Date);
  });

  it('404 同样回收', async () => {
    addSubscription('https://gone.example/1');
    const { transport } = recordingTransport(() => {
      throw httpError(404);
    });
    await sendToUser(db, 'user-1', payload(), {
      transport,
      logger: silentLogger,
    });
    expect(listSubscriptions(db, 'user-1')).toHaveLength(0);
  });

  it('5xx 不删行，只记 last_error（一次网络抖动不该让人默默失去通知）', async () => {
    addSubscription('https://flaky.example/1');
    const { transport } = recordingTransport(() => {
      throw httpError(503);
    });

    await sendToUser(db, 'user-1', payload(), {
      transport,
      logger: silentLogger,
    });

    const rows = listSubscriptions(db, 'user-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lastError).toContain('503');
    expect(rows[0]?.lastSentAt).toBeNull();
  });

  it('没有 statusCode 的普通错误（网络断了）也走"留行记痕"', async () => {
    addSubscription('https://offline.example/1');
    const { transport } = recordingTransport(() => {
      throw new Error('ECONNREFUSED');
    });
    await sendToUser(db, 'user-1', payload(), {
      transport,
      logger: silentLogger,
    });
    const rows = listSubscriptions(db, 'user-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lastError).toContain('ECONNREFUSED');
  });

  it('一台设备抛错不影响另一台（allSettled 语义），整体永不 reject', async () => {
    addSubscription('https://boom.example/1');
    addSubscription('https://ok.example/2');
    const { calls, transport } = recordingTransport((endpoint) => {
      if (endpoint.includes('boom')) throw new Error('boom');
    });

    await expect(
      sendToUser(db, 'user-1', payload(), {
        transport,
        logger: silentLogger,
      }),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it('审批类走 high 紧急度，TTL 用调用方给的剩余秒数', async () => {
    addSubscription('https://a.example/1');
    const { calls, transport } = recordingTransport();

    await sendToUser(db, 'user-1', payload({ kind: 'approval' }), {
      transport,
      logger: silentLogger,
      ttlSeconds: 240,
    });

    expect(calls[0]?.options.urgency).toBe('high');
    expect(calls[0]?.options.TTL).toBe(240);
  });

  it('一轮结束类走 normal 紧急度与 600 秒默认 TTL', async () => {
    addSubscription('https://a.example/1');
    const { calls, transport } = recordingTransport();

    await sendToUser(db, 'user-1', payload({ kind: 'turn-done' }), {
      transport,
      logger: silentLogger,
    });

    expect(calls[0]?.options.urgency).toBe('normal');
    expect(calls[0]?.options.TTL).toBe(600);
  });

  it('载荷原样 JSON 序列化后交给 transport', async () => {
    addSubscription('https://a.example/1');
    const { calls, transport } = recordingTransport();
    const sent = payload();

    await sendToUser(db, 'user-1', sent, {
      transport,
      logger: silentLogger,
    });

    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual(sent);
  });
});
