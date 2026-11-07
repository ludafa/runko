import { createMiddleware } from 'hono/factory';

type AuthEnv = {
  Variables: {
    userId: string;
  };
};

/** better-auth 实例上本中间件用到的那一个方法。两个服务端各有自己的 better-auth 实例。 */
export interface SessionReader {
  api: {
    getSession(opts: {
      headers: Headers;
    }): Promise<{ user: { id: string } } | null>;
  };
}

/** 要登录的路由前面挂它：没登录回 401，登录了把 `userId` 放进上下文。 */
export function createRequireAuth(auth: SessionReader) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    const session = await auth.api.getSession({
      headers: c.req.raw.headers,
    });

    if (!session) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    c.set('userId', session.user.id);
    await next();
    return undefined;
  });
}
