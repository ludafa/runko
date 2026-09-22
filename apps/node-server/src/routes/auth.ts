import { Hono } from 'hono';

import { auth } from '../auth.js';

const authApp = new Hono();

authApp.on(['POST', 'GET'], '/api/auth/*', (c) => auth.handler(c.req.raw));

/**
 * 登录页要知道「GitHub 登录开没开」——而这个问题恰恰要在登录之前回答，所以单开一个
 * **不鉴权**的端点。它只回答开没开，不外泄任何 key。
 */
authApp.get('/api/auth-config', (c) =>
  c.json({
    github:
      (process.env.GITHUB_CLIENT_ID?.trim() ?? '').length > 0 &&
      (process.env.GITHUB_CLIENT_SECRET?.trim() ?? '').length > 0,
  }),
);

export { authApp };
