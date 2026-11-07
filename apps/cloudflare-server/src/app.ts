/**
 * Worker 的 Hono 应用：登录、会话接口（两个服务端共用的那一份路由）、GitHub、配置。
 * 前端是同一个 Worker 的静态资源，`wrangler.jsonc` 里 `/api/*` 先进 Worker，其余由静态资源答。
 */
import {
  createGithubApp,
  isGithubAppConfigured,
} from '@runko-chat/shared/agent/github-app';
import { hasRealModel } from '@runko-chat/shared/agent/model';
import { resolveIdleTimeoutMs } from '@runko-chat/shared/agent/sandbox-manager';
import type { ConversationProvider } from '@runko-chat/shared/db/schema';
import type { Logger } from '@runko-chat/shared/logger';
import { createLogger } from '@runko-chat/shared/logger';
import { createRequireAuth } from '@runko-chat/shared/middleware/auth';
import type { ChatEnv } from '@runko-chat/shared/routes/chat';
import { createChatRoutes } from '@runko-chat/shared/routes/chat';
import { WS_ROUTE } from '@runko-chat/shared/routes/chat-ws';
import { createExampleRoutes } from '@runko-chat/shared/routes/example';
import { createGithubRoutes } from '@runko-chat/shared/routes/github';
import type { ChatConfigDto } from '@runko-chat/shared/schemas/chat';
import type { MiddlewareHandler } from 'hono';
import { Hono } from 'hono';

import { authFor, getGithubUserToken, githubLoginEnabled } from './auth.js';
import { createCloudflareBackend } from './backend.js';
import { chatDb } from './db/instance.js';
import type { Env } from './env.js';
import { cloudflareSandboxEnabled, textEnv } from './env.js';
import { handleLiveTailSocket } from './routes/ws.js';

type WorkerEnv = { Bindings: Env };

/**
 * 这台服务端能做什么。Cloudflare 沙盒要容器绑定**并且**配了 GitHub App（没有 App 就没法给
 * 沙盒签仓库令牌，选了也建不成会话）；本地沙盒永远能用。没有集群控制台。
 */
export function capabilitiesOf(env: Env): ChatConfigDto {
  const text = textEnv(env);
  const providers: ConversationProvider[] = [];
  if (cloudflareSandboxEnabled(env) && isGithubAppConfigured(text)) {
    providers.push('cloudflare');
  }
  providers.push('local');
  const named = text.SANDBOX_PROVIDER?.trim().toLowerCase();
  const defaultProvider =
    providers.find((id) => id === named) ?? providers[0] ?? 'local';
  return {
    providers,
    defaultProvider,
    model: hasRealModel(text) ? 'deepseek' : 'demo',
    clusterConsole: false,
  };
}

/** 按请求的来源拿 better-auth：`authFor` 在 isolate 里缓存实例。 */
function requireAuthFor(env: Env): MiddlewareHandler<ChatEnv> {
  return (c, next) =>
    createRequireAuth(authFor(env, new URL(c.req.url).origin))(c, next);
}

/**
 * 每个 `env` 一套子应用。`env` 在同一个 isolate 里通常是同一个对象，于是只建一次；
 * 换了也只是多建一次，行为不变。
 */
interface SubApps {
  chat: ReturnType<typeof createChatRoutes>;
  github: ReturnType<typeof createGithubRoutes>;
  /** 起步模板的笔记示例（首页要用），同 Node 版。 */
  examples: ReturnType<typeof createExampleRoutes>;
  backend: ReturnType<typeof createCloudflareBackend>;
}

const subApps = new WeakMap<Env, SubApps>();

function subAppsFor(env: Env, log: Logger): SubApps {
  const cached = subApps.get(env);
  if (cached !== undefined) {
    return cached;
  }
  const text = textEnv(env);
  const db = chatDb(env.DB);
  const backend = createCloudflareBackend(env);
  const githubApp = createGithubApp({
    env: text,
    getUserToken: (userId) =>
      getGithubUserToken(
        authFor(env, env.SERVER_URL?.trim() || 'http://worker.internal'),
        userId,
      ),
  });
  const authMiddleware = requireAuthFor(env);
  const built: SubApps = {
    backend,
    chat: createChatRoutes({
      db,
      backend,
      authMiddleware,
      githubApp,
      capabilities: () => capabilitiesOf(env),
      sandboxIdleTimeoutMs: resolveIdleTimeoutMs(text),
      onSwallowedError: (where, conversationId, error) => {
        log.warn('chat', 'failed to extend sandbox lifetime', {
          where,
          conversationId,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    }),
    github: createGithubRoutes({ db, githubApp, authMiddleware }),
    examples: createExampleRoutes(authMiddleware),
  };
  subApps.set(env, built);
  return built;
}

export function createApp(log: Logger = createLogger()): Hono<WorkerEnv> {
  const app = new Hono<WorkerEnv>();

  // 健康检查：不鉴权、不碰数据库。
  app.get('/health', (c) => c.json({ ok: true }));

  app.on(['GET', 'POST'], '/api/auth/*', (c) =>
    authFor(c.env, new URL(c.req.url).origin).handler(c.req.raw),
  );

  // 登录页要在登录之前知道 GitHub 登录开没开——同 Node 版，不鉴权、不外泄 key。
  app.get('/api/auth-config', (c) =>
    c.json({ github: githubLoginEnabled(c.env) }),
  );

  // 推送本期不做：照 Node 版「没开」的形状答，前端就不渲染铃铛。
  app.get('/api/push/config', (c) =>
    c.json({ enabled: false, publicKey: null }),
  );

  app.get(WS_ROUTE, (c) =>
    handleLiveTailSocket(c, subAppsFor(c.env, log).backend.runtime, log),
  );

  app.all('/api/chat/*', (c) =>
    subAppsFor(c.env, log).chat.fetch(c.req.raw, c.env, c.executionCtx),
  );
  app.all('/api/github/*', (c) =>
    subAppsFor(c.env, log).github.fetch(c.req.raw, c.env, c.executionCtx),
  );

  app.all('/api/notes/*', (c) =>
    subAppsFor(c.env, log).examples.fetch(c.req.raw, c.env, c.executionCtx),
  );

  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

  // 正常情况下非 `/api` 的请求由静态资源直接答，到不了这里；没配静态资源时（测试）回 404。
  app.all('*', (c) =>
    c.env.ASSETS !== undefined ? c.env.ASSETS.fetch(c.req.raw) : c.notFound(),
  );

  return app;
}
