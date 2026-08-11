/**
 * 推送订阅的四个接口（docs/app/push-notification/tech.md §3.1）——全部要登录，与
 * `routes/chat.ts` 同一个 `requireAuth`。
 *
 * 一条贯穿的姿态：**功能没开时，读接口如实回答「没开」，写接口返 503**。读接口
 * 刻意不返 404——前端一次 `GET /api/push/config` 就要能决定「渲不渲染铃铛、用哪个
 * 公钥订阅」，把「没开」表达成一次失败会逼前端去分辨"是没开还是网挂了"。
 */
import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';

import type { Db } from '../agent/store.js';
import { db as defaultDb } from '../db/instance.js';
import type { Logger } from '../logger.js';
import { logger as defaultLogger } from '../logger.js';
import { requireAuth } from '../middleware/auth.js';
import { sendToUser } from '../push/sender.js';
import { deleteSubscription, upsertSubscription } from '../push/store.js';
import type { PushPayload } from '../push/types.js';
import { getVapidConfig, isPushEnabled } from '../push/vapid.js';
import { ErrorSchema } from '../schemas/api.js';
import {
  PushAckSchema,
  PushConfigSchema,
  PushSubscribeInputSchema,
  PushUnsubscribeInputSchema,
} from '../schemas/push.js';

type PushEnv = { Variables: { userId: string } };

export interface PushRouteDeps {
  db: Db;
  /** 与 `ChatRouteDeps.authMiddleware` 同样的理由：集成测试塞一个固定 userId 的桩。 */
  authMiddleware: MiddlewareHandler<PushEnv>;
  logger?: Logger;
}

const DISABLED_MESSAGE = '推送未启用：服务端没有配置 VAPID 密钥';

export function createPushApp(deps: PushRouteDeps): OpenAPIHono<PushEnv> {
  const app = new OpenAPIHono<PushEnv>();
  const log = deps.logger ?? defaultLogger;

  app.use('/api/push/*', deps.authMiddleware);

  // ---- GET /api/push/config ----

  const configRoute = createRoute({
    method: 'get',
    path: '/api/push/config',
    tags: ['Push'],
    summary:
      '推送是否可用 + VAPID 公钥（docs/app/push-notification/tech.md §3.1）：前端据此决定渲不渲染铃铛',
    responses: {
      200: {
        content: { 'application/json': { schema: PushConfigSchema } },
        description:
          'OK（未启用时 `{enabled:false, publicKey:null}`，不是错误）',
      },
      401: {
        content: { 'application/json': { schema: ErrorSchema } },
        description: 'Unauthorized',
      },
    },
  });

  app.openapi(configRoute, (c) => {
    const vapid = getVapidConfig();
    return c.json(
      {
        enabled: vapid !== undefined,
        publicKey: vapid?.publicKey ?? null,
      },
      200,
    );
  });

  // ---- POST /api/push/subscriptions ----

  const subscribeRoute = createRoute({
    method: 'post',
    path: '/api/push/subscriptions',
    tags: ['Push'],
    summary:
      '登记一条推送订阅（幂等，按 endpoint upsert）：页面每次加载都会重报一次，用来兜住浏览器悄悄换过 endpoint 的情况',
    request: {
      body: {
        content: { 'application/json': { schema: PushSubscribeInputSchema } },
        required: true,
      },
    },
    responses: {
      200: {
        content: { 'application/json': { schema: PushAckSchema } },
        description: 'Stored',
      },
      401: {
        content: { 'application/json': { schema: ErrorSchema } },
        description: 'Unauthorized',
      },
      503: {
        content: { 'application/json': { schema: ErrorSchema } },
        description:
          'Push disabled — 服务端没配 VAPID，存下来也永远发不出去，故不写库',
      },
    },
  });

  app.openapi(subscribeRoute, (c) => {
    if (!isPushEnabled()) return c.json({ error: DISABLED_MESSAGE }, 503);
    const userId = c.get('userId');
    const { endpoint, keys, userAgent } = c.req.valid('json');

    upsertSubscription(deps.db, {
      endpoint,
      userId,
      p256dh: keys.p256dh,
      auth: keys.auth,
      ...(userAgent !== undefined ? { userAgent } : {}),
    });
    return c.json({ ok: true as const }, 200);
  });

  // ---- POST /api/push/unsubscribe ----

  const unsubscribeRoute = createRoute({
    method: 'post',
    path: '/api/push/unsubscribe',
    tags: ['Push'],
    summary:
      '注销一条推送订阅（幂等：不存在也返回成功）。用 POST 而不是带 body 的 DELETE——后者在部分 HTTP 客户端/代理上会被丢掉 body',
    request: {
      body: {
        content: { 'application/json': { schema: PushUnsubscribeInputSchema } },
        required: true,
      },
    },
    responses: {
      200: {
        content: { 'application/json': { schema: PushAckSchema } },
        description: 'Removed（本来就不存在时同样返回这个）',
      },
      401: {
        content: { 'application/json': { schema: ErrorSchema } },
        description: 'Unauthorized',
      },
    },
  });

  app.openapi(unsubscribeRoute, (c) => {
    const { endpoint } = c.req.valid('json');
    // 刻意不校验这条订阅属不属于调用者：能拿到 endpoint 的只有那台设备的浏览器
    // 自己，而「删掉一条自己的投递地址」本就是它随时可做的事。加一次属主查询
    // 只会让"换账号后退订"这类正常路径莫名失败。
    deleteSubscription(deps.db, endpoint);
    return c.json({ ok: true as const }, 200);
  });

  // ---- POST /api/push/test ----

  const testRoute = createRoute({
    method: 'post',
    path: '/api/push/test',
    tags: ['Push'],
    summary:
      '给自己的全部设备发一条测试通知——端到端验证推送通道是否打通（docs/app/push-notification/plan.md PN-10 用例 4）',
    responses: {
      200: {
        content: { 'application/json': { schema: PushAckSchema } },
        description:
          'Accepted —— 只表示「已交给推送服务」，不表示设备一定收到了',
      },
      401: {
        content: { 'application/json': { schema: ErrorSchema } },
        description: 'Unauthorized',
      },
      503: {
        content: { 'application/json': { schema: ErrorSchema } },
        description: 'Push disabled',
      },
    },
  });

  app.openapi(testRoute, async (c) => {
    if (!isPushEnabled()) return c.json({ error: DISABLED_MESSAGE }, 503);
    const userId = c.get('userId');
    const payload: PushPayload = {
      v: 1,
      kind: 'turn-done',
      conversationId: 'test',
      title: '测试通知',
      body: '推送通道通了。点下面的按钮可以顺便测一下按钮链路。',
      url: '/chat',
      tag: 'turn:test',
      // 测试通知挂住不消失：这条的**唯一**用途就是让人确认"我确实收到了"，
      // 恰恰不能几秒后自己溜走（与 `turn-done` 那一档的取值刻意不同）。
      sticky: true,
      // 带上按钮，好让人**不必等一次真实审批**就能验证「点按钮 → SW 发请求 →
      // 收到响应」这条链路通不通（docs/app/push-notification/tech.md §6.5）。
      //
      // `callId` 是个哨兵值，会话 id 也是 `'test'`——审批接口查不到这条会话，必然
      // 返回 404，SW 因此弹出「这条审批已经处理过了」。**弹出来就说明链路是通的**；
      // 什么都不弹才说明按钮点击压根没送到 SW（多半是平台把它降级成了普通点击）。
      callId: 'test-call',
      actions: [
        { id: 'allow', title: '允许', behavior: 'allow' },
        { id: 'deny', title: '拒绝', behavior: 'deny' },
      ],
    };
    await sendToUser(deps.db, userId, payload, { logger: log });
    return c.json({ ok: true as const }, 200);
  });

  return app;
}

export const pushApp = createPushApp({
  db: defaultDb,
  authMiddleware: requireAuth,
});
