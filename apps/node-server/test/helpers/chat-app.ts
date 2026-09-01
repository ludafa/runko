/**
 * 集成测试的公共装配：一套 db + 假沙盒 + `@nimbo/agent` 运行时 + chat 路由。
 *
 * 迁移到 `@nimbo/agent` 之后，`createChatApp` 需要的东西比从前多了两样（`runtime` 与
 * 框架的[裁决表](../../../../docs/terms.md)读口），而这两样又都得跟同一个 db、同一个
 * 假沙盒接上——每个测试文件各拼一遍必然漂，所以收在这里。
 */
import type { DrivenSession, SessionFactory } from '@nimbo/agent';
import type { LanguageModel } from 'ai';
import type { MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';

import { createChatPersistence } from '../../src/agent/persistence.js';
import { createChatRuntime } from '../../src/agent/runtime.js';
import type { SandboxManager } from '../../src/agent/sandbox-manager.js';
import type { Db } from '../../src/agent/store.js';
import type { ChatNotifier } from '../../src/push/notifier.js';
import { createChatApp } from '../../src/routes/chat.js';
import type { TelemetryStore } from '../../src/telemetry.js';
import { silentLogger } from './silent-logger.js';

type ChatEnv = { Variables: { userId: string } };

export function fakeAuthMiddleware(userId: string): MiddlewareHandler<ChatEnv> {
  return createMiddleware<ChatEnv>(async (c, next) => {
    c.set('userId', userId);
    await next();
  });
}

export const unauthorizedMiddleware: MiddlewareHandler<ChatEnv> =
  createMiddleware<ChatEnv>(async (c) =>
    c.json({ error: 'Unauthorized' }, 401),
  );

export interface BuildChatAppOptions {
  db: Db;
  sandboxManager: SandboxManager;
  resolveModel: () => LanguageModel;
  userId?: string;
  authMiddleware?: MiddlewareHandler<ChatEnv>;
  telemetryStore?: TelemetryStore;
  notifier?: ChatNotifier;
  /** 塞一对假的 `stream()`/`toJSON()`，整条轮编排链路零模型跑完。 */
  sessionFactory?: SessionFactory;
}

export function buildChatApp(opts: BuildChatAppOptions) {
  const runtime = createChatRuntime({
    db: opts.db,
    sandboxManager: opts.sandboxManager,
    resolveModel: opts.resolveModel,
    logger: silentLogger,
    ...(opts.telemetryStore !== undefined ?
      { telemetryStore: opts.telemetryStore }
    : {}),
    ...(opts.notifier !== undefined ? { notifier: opts.notifier } : {}),
    ...(opts.sessionFactory !== undefined ?
      { sessionFactory: opts.sessionFactory }
    : {}),
  });
  const app = createChatApp({
    db: opts.db,
    runtime,
    decisions: createChatPersistence(opts.db, silentLogger).decisions,
    sandboxManager: opts.sandboxManager,
    resolveModel: opts.resolveModel,
    authMiddleware:
      opts.authMiddleware ?? fakeAuthMiddleware(opts.userId ?? 'user-1'),
    ...(opts.telemetryStore !== undefined ?
      { telemetryStore: opts.telemetryStore }
    : {}),
  });
  return { app, runtime };
}

export type { DrivenSession };
