/** 推送订阅的四个接口（docs/app/push-notification/tech.md §3.1）。 */
import type { MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../../src/agent/store.js';
import { listSubscriptions } from '../../src/push/store.js';
import { createPushApp } from '../../src/routes/push.js';
import { silentLogger } from '../helpers/silent-logger.js';
import { createTestDb, seedUser } from '../helpers/test-db.js';

type PushEnv = { Variables: { userId: string } };

function fakeAuth(userId: string): MiddlewareHandler<PushEnv> {
  return createMiddleware<PushEnv>(async (c, next) => {
    c.set('userId', userId);
    await next();
  });
}

const unauthorized: MiddlewareHandler<PushEnv> = createMiddleware<PushEnv>(
  // 签名要 `Promise<Response>`（中间件可以 await 下游），这里直接短路返回。
  async (c) => Promise.resolve(c.json({ error: 'Unauthorized' }, 401)),
);

const SUBSCRIPTION = {
  endpoint: 'https://fcm.example/send/abc',
  keys: { p256dh: 'key', auth: 'auth' },
  userAgent: 'Chrome/999',
};

function enableVapid(): void {
  process.env.VAPID_PUBLIC_KEY = 'pub-key';
  process.env.VAPID_PRIVATE_KEY = 'priv-key';
  process.env.VAPID_SUBJECT = 'mailto:me@example.com';
}

function disableVapid(): void {
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  delete process.env.VAPID_SUBJECT;
}

function jsonRequest(path: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe('routes/push', () => {
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
    seedUser(db, 'user-1');
    disableVapid();
  });

  afterEach(disableVapid);

  function app(userId = 'user-1') {
    return createPushApp({
      db,
      authMiddleware: fakeAuth(userId),
      logger: silentLogger,
    });
  }

  it('GET /config：没配 VAPID 时如实回答「没开」，不是 404', async () => {
    const res = await app().request('http://localhost/api/push/config');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false, publicKey: null });
  });

  it('GET /config：配好后返回公钥', async () => {
    enableVapid();
    const res = await app().request('http://localhost/api/push/config');
    expect(await res.json()).toEqual({ enabled: true, publicKey: 'pub-key' });
  });

  it('未登录时四个接口全部 401', async () => {
    enableVapid();
    const anon = createPushApp({
      db,
      authMiddleware: unauthorized,
      logger: silentLogger,
    });
    for (const req of [
      new Request('http://localhost/api/push/config'),
      jsonRequest('/api/push/subscriptions', SUBSCRIPTION),
      jsonRequest('/api/push/unsubscribe', { endpoint: 'x' }),
      jsonRequest('/api/push/test'),
    ]) {
      expect((await anon.request(req)).status).toBe(401);
    }
  });

  it('禁用状态下登记订阅返 503 且不写库（存下来也永远发不出去）', async () => {
    const res = await app().request(
      jsonRequest('/api/push/subscriptions', SUBSCRIPTION),
    );
    expect(res.status).toBe(503);
    expect(listSubscriptions(db, 'user-1')).toHaveLength(0);
  });

  it('登记订阅落库，且带上 userAgent', async () => {
    enableVapid();
    const res = await app().request(
      jsonRequest('/api/push/subscriptions', SUBSCRIPTION),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const rows = listSubscriptions(db, 'user-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.endpoint).toBe(SUBSCRIPTION.endpoint);
    expect(rows[0]?.userAgent).toBe('Chrome/999');
  });

  it('重复登记幂等：仍然只有一行', async () => {
    enableVapid();
    await app().request(jsonRequest('/api/push/subscriptions', SUBSCRIPTION));
    await app().request(jsonRequest('/api/push/subscriptions', SUBSCRIPTION));
    expect(listSubscriptions(db, 'user-1')).toHaveLength(1);
  });

  it('缺字段的请求体被 zod 挡下（400），不落库', async () => {
    enableVapid();
    const res = await app().request(
      jsonRequest('/api/push/subscriptions', { endpoint: 'https://x.example' }),
    );
    expect(res.status).toBe(400);
    expect(listSubscriptions(db, 'user-1')).toHaveLength(0);
  });

  it('退订：删掉那一行', async () => {
    enableVapid();
    await app().request(jsonRequest('/api/push/subscriptions', SUBSCRIPTION));
    const res = await app().request(
      jsonRequest('/api/push/unsubscribe', {
        endpoint: SUBSCRIPTION.endpoint,
      }),
    );
    expect(res.status).toBe(200);
    expect(listSubscriptions(db, 'user-1')).toHaveLength(0);
  });

  it('退订一个不存在的 endpoint 也返回成功（幂等，不是 404）', async () => {
    enableVapid();
    const res = await app().request(
      jsonRequest('/api/push/unsubscribe', { endpoint: 'https://nope/x' }),
    );
    expect(res.status).toBe(200);
  });

  it('退订不要求 VAPID 配着——功能关掉后仍然得让人能清掉自己的订阅', async () => {
    const res = await app().request(
      jsonRequest('/api/push/unsubscribe', { endpoint: 'https://nope/x' }),
    );
    expect(res.status).toBe(200);
  });

  it('测试通知：禁用时 503', async () => {
    const res = await app().request(jsonRequest('/api/push/test'));
    expect(res.status).toBe(503);
  });

  it('测试通知：启用且没有订阅时也返回成功（没设备可发不是错误）', async () => {
    enableVapid();
    const res = await app().request(jsonRequest('/api/push/test'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
