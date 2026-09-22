import { swaggerUI } from '@hono/swagger-ui';
import { OpenAPIHono } from '@hono/zod-openapi';
import { cors } from 'hono/cors';

import { authApp } from './routes/auth.js';
import { chatApp } from './routes/chat.js';
import { exampleApp } from './routes/example.js';
import { pushApp } from './routes/push.js';

const app = new OpenAPIHono();

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

// Mount routes
/**
 * 健康检查。**不鉴权、不碰数据库**：docker 的 healthcheck 与 nginx 用它判断这个副本起没起来，
 * 库连不上时它也该老实说「我在」——那是另一个问题，不该让编排以为整个容器废了。
 */
app.get('/health', (c) => c.json({ ok: true }));

app.route('/', authApp);
app.route('/', exampleApp);
app.route('/', chatApp);
app.route('/', pushApp);

// OpenAPI spec + Swagger UI
app.doc31('/doc', {
  openapi: '3.1.0',
  info: { title: 'Hono Mono Starter API', version: '1.0.0' },
});
app.get('/reference', swaggerUI({ url: '/doc' }));

export { app };
