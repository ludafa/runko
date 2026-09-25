import { createNodeWebSocket } from '@hono/node-ws';
import { swaggerUI } from '@hono/swagger-ui';
import { OpenAPIHono } from '@hono/zod-openapi';
import { cors } from 'hono/cors';

import { db } from './db/instance.js';
import { requireAuth } from './middleware/auth.js';
import { authApp } from './routes/auth.js';
import {
  chatApp,
  chatRuntime,
  nodeOffline,
  toWireFrame,
} from './routes/chat.js';
import { createChatWsApp } from './routes/chat-ws.js';
import { consoleApp } from './routes/console.js';
import { exampleApp } from './routes/example.js';
import { pushApp } from './routes/push.js';

const app = new OpenAPIHono();

/**
 * WebSocket 的升级发生在 HTTP 服务器那一层，所以要在这里把它造出来、再由 `index.ts` 在
 * `serve()` 之后注进去。**顺序是硬的**：`createNodeWebSocket` 要先拿到 app 的引用，
 * 之后才轮到把 WebSocket 路由挂上去。
 */
const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });

export { injectWebSocket };

// CORS for client dev server. Derived from CLIENT_URL, falling back to
// CLIENT_PORT (matches vite.config.ts's same-named fallback).
const clientUrl =
  process.env.CLIENT_URL ??
  `http://localhost:${process.env.CLIENT_PORT ?? 5173}`;
const corsOrigins = [clientUrl];

app.use(
  '/api/*',
  cors({
    origin: corsOrigins,
    credentials: true,
  }),
);

/**
 * [节点下线](../../../docs/terms.md)闸门：挂在一切路由之前，WebSocket 升级与 `/health` 也在它后面。
 * 下线中只放行别的节点转发来的请求，其余 503，nginx 换节点重试（docs/host/node/tech/cluster-console.md §4.1）。
 */
app.use('*', nodeOffline.gate);

// Mount routes
/**
 * 健康检查。**不鉴权、不碰数据库**：docker 的 healthcheck 与 nginx 用它判断这个副本起没起来，
 * 库连不上时它也该老实说「我在」——那是另一个问题，不该让编排以为整个容器废了。
 */
app.get('/health', (c) => c.json({ ok: true }));

app.route('/', authApp);
app.route(
  '/',
  createChatWsApp({
    db,
    runtime: chatRuntime,
    authMiddleware: requireAuth,
    upgradeWebSocket,
    toWire: toWireFrame,
    offlineSignal: nodeOffline.signal,
  }),
);
app.route('/', exampleApp);
app.route('/', chatApp);
app.route('/', pushApp);
app.route('/', consoleApp);

// OpenAPI spec + Swagger UI
app.doc31('/doc', {
  openapi: '3.1.0',
  info: { title: 'Hono Mono Starter API', version: '1.0.0' },
});
app.get('/reference', swaggerUI({ url: '/doc' }));

export { app };
