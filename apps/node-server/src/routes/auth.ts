import { Hono } from 'hono';

import { auth } from '../auth.js';

const authApp = new Hono();

authApp.on(['POST', 'GET'], '/api/auth/*', (c) => auth.handler(c.req.raw));

export { authApp };
