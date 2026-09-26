/**
 * [节点下线](../../../../docs/terms.md)信号触发时，WebSocket 直播要以 1012（服务重启）关掉，
 * 前端据此退避重连（docs/host/node/tech/cluster-console.md §4.2）。
 *
 * 起真服务器的理由与 `test/routes/chat-ws.test.ts` 一样：WebSocket 升级发生在服务器那一层，
 * `app.request()` 那种进程内调用走不到。这里的装配也照抄那份文件的 `startServer`，只多接一个
 * 我们自己控制的 `offlineSignal`。
 */
import type { AddressInfo } from 'node:net';

import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { createLocalProvider } from '../../src/agent/local-sandbox.js';
import { resolveModel } from '../../src/agent/model.js';
import { createSandboxManager } from '../../src/agent/sandbox-manager.js';
import { createConversation } from '../../src/agent/store.js';
import type { Db } from '../../src/db/instance.js';
import { toWireFrame } from '../../src/routes/chat.js';
import { createChatWsApp } from '../../src/routes/chat-ws.js';
import { buildChatApp } from '../helpers/chat-app.js';
import type { FakeSessions } from '../helpers/fake-turn-session.js';
import { createFakeSessions } from '../helpers/fake-turn-session.js';
import { silentLogger } from '../helpers/silent-logger.js';
import { createTestDb, seedUser } from '../helpers/test-db.js';

const USER_ID = 'user-1';

type ChatEnv = { Variables: { userId: string } };

/** 起一个真服务器，把 WebSocket 路由挂上去。 */
function startServer(
  db: Db,
  runtime: Parameters<typeof createChatWsApp>[0]['runtime'],
) {
  const app = new Hono<ChatEnv>();
  const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
  app.route(
    '/',
    createChatWsApp({
      db,
      runtime,
      authMiddleware: createMiddleware<ChatEnv>(async (c, next) => {
        c.set('userId', USER_ID);
        await next();
      }),
      upgradeWebSocket,
      toWire: toWireFrame,
      logger: silentLogger,
    }),
  );
  const server = serve({ fetch: app.fetch, port: 0 });
  injectWebSocket(server);
  const address = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${String(address.port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** 连上去，把收到的消息与关闭码攒起来。 */
function collect(url: string): {
  ready: Promise<void>;
  done: Promise<{ code: number; messages: string[] }>;
} {
  const socket = new WebSocket(url);
  const messages: string[] = [];
  const ready = new Promise<void>((resolve, reject) => {
    socket.once('open', () => {
      resolve();
    });
    socket.once('error', reject);
  });
  const done = new Promise<{ code: number; messages: string[] }>((resolve) => {
    socket.on('message', (data) => {
      messages.push(String(data));
    });
    socket.once('close', (code) => {
      resolve({ code, messages });
    });
  });
  return { ready, done };
}

describe('节点下线：WebSocket 直播收到请重连帧、以 1012 关闭', () => {
  let db: Db;
  let stop: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    db = await createTestDb();
    await seedUser(db, USER_ID);
  });

  afterEach(async () => {
    await stop?.();
    stop = undefined;
  });

  function build(sessions?: FakeSessions) {
    const sandboxManager = createSandboxManager(
      { local: createLocalProvider({ db, logger: silentLogger }) },
      { logger: silentLogger },
    );
    return buildChatApp({
      db,
      sandboxManager,
      resolveModel,
      userId: USER_ID,
      ...(sessions !== undefined ? { sessionFactory: sessions.factory } : {}),
    });
  }

  it('交权之后：先收到 {reconnect:true}，再以 1012（服务重启）关掉——即便那一轮还没收尾', async () => {
    const sessions = createFakeSessions();
    const { runtime } = build(sessions);
    await createConversation(db, {
      id: 'conv-offline',
      userId: USER_ID,
      title: '下线测试',
      repo: null,
      branchName: null,
      sandboxName: 'runko-chat-conv-offline',
      provider: 'local',
    });
    // 先起一轮，让连接连上之后真的卡在「等下一个 chunk」上——不然没有轮在跑时订阅
    // 几毫秒内就自己回放完收线，请重连帧根本来不及赶在它前面。
    expect(
      (await runtime.enqueue('conv-offline', { text: 'hi', userId: USER_ID }))
        .mode,
    ).toBe('started');
    const session = await sessions.next();
    await session.started;

    const server = startServer(db, runtime);
    stop = server.close;

    const client = collect(
      `${server.url}/api/chat/conversations/conv-offline/ws`,
    );
    await client.ready;
    // 假 session 不理交权信号：宽限期一到，框架照样踢掉本进程的订阅。
    const shutdown = runtime.shutdown({ graceMs: 50 });
    const { code, messages } = await client.done;

    expect(code).toBe(1012);
    expect(messages.at(-1)).toBe(JSON.stringify({ reconnect: true }));

    // 收尾：把这一轮跑完，别把假 session 悬在测试进程里。
    session.emit({ type: 'finish' });
    session.push({
      id: 'a-1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'hi' }],
      metadata: { turn: 1, usage: {}, status: 'completed' },
    });
    session.emit({
      type: 'message-metadata',
      messageMetadata: { turn: 1, usage: {}, status: 'completed' },
    });
    session.finish();
    await shutdown;
  });

  it('没有下线：正常收尾走 1000，不是 1012', async () => {
    const { runtime } = build();
    await createConversation(db, {
      id: 'conv-normal',
      userId: USER_ID,
      title: '对照组',
      repo: null,
      branchName: null,
      sandboxName: 'runko-chat-conv-normal',
      provider: 'local',
    });
    const server = startServer(db, runtime);
    stop = server.close;

    const client = collect(
      `${server.url}/api/chat/conversations/conv-normal/ws`,
    );
    await client.ready;
    const { code } = await client.done;

    expect(code).toBe(1000);
  });
});
