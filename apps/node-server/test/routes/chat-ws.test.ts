/**
 * [直播流](../../../../docs/terms.md)的 WebSocket 通道。
 *
 * 这条只能起一个**真的 HTTP 服务器**来测：WebSocket 的升级发生在服务器那一层，
 * `app.request()` 那种进程内调用根本走不到。服务器用随机端口、用完就关，跑完即退。
 *
 * 守两件事：**帧与 SSE 那条一模一样**（同一个 `toWireFrame`，这里验它真的送出去了），
 * 以及**不是你的会话连不上**。
 */
import type { AddressInfo } from 'node:net';

import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { createLocalProvider } from '../../src/agent/local-sandbox.js';
import { resolveModel } from '../../src/agent/model.js';
import { createSandboxManager } from '../../src/agent/sandbox-manager.js';
import { createConversation } from '../../src/agent/store.js';
import type { Db } from '../../src/db/instance.js';
import { toWireFrame } from '../../src/routes/chat.js';
import { createChatWsApp } from '../../src/routes/chat-ws.js';
import { buildChatApp } from '../helpers/chat-app.js';
import { silentLogger } from '../helpers/silent-logger.js';
import { createTestDb, seedUser } from '../helpers/test-db.js';

const USER_ID = 'user-1';

type ChatEnv = { Variables: { userId: string } };

/** 起一个真服务器，把 WebSocket 路由挂上去；返回地址与关服务器的函数。 */
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

/** 连上去，把收到的消息攒起来；连接关掉时 resolve。 */
function collect(url: string): {
  ready: Promise<void>;
  done: Promise<{ code: number; messages: string[] }>;
  socket: WebSocket;
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
  return { ready, done, socket };
}

describe('WebSocket 直播流', () => {
  let db: Db;
  let stop: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    // 演示模型每小段停 100 毫秒：这一轮要跑得够久，连上去时它还在说话。
    vi.stubEnv('CHAT_DEMO_DELAY_MS', '100');
    db = await createTestDb();
    await seedUser(db, USER_ID);
  });

  afterEach(async () => {
    await stop?.();
    stop = undefined;
    vi.unstubAllEnvs();
  });

  function build() {
    const sandboxManager = createSandboxManager(
      { local: createLocalProvider({ db, logger: silentLogger }) },
      { logger: silentLogger },
    );
    return buildChatApp({ db, sandboxManager, resolveModel, userId: USER_ID });
  }

  it('连上就把账本回放出来，然后正常关掉（这一轮已经结束）', async () => {
    const { runtime } = build();
    await createConversation(db, {
      id: 'conv-1',
      userId: USER_ID,
      title: '看直播',
      repo: null,
      branchName: null,
      sandboxName: 'runko-chat-conv-1',
      provider: 'local',
    });
    const server = startServer(db, runtime);
    stop = server.close;

    const client = collect(`${server.url}/api/chat/conversations/conv-1/ws`);
    await client.ready;
    const { code, messages } = await client.done;

    // 没有轮在跑：回放完就关。至少有一帧「有没有轮在跑」的权威快照。
    expect(code).toBe(1000);
    expect(messages.some((raw) => raw.includes('turnActive'))).toBe(true);
  });

  it('**不是你的会话连不上**：立刻关掉，一帧都不发', async () => {
    const { runtime } = build();
    await createConversation(db, {
      id: 'conv-other',
      userId: 'user-2',
      title: '别人的',
      repo: null,
      branchName: null,
      sandboxName: 'runko-chat-conv-other',
      provider: 'local',
    });
    const server = startServer(db, runtime);
    stop = server.close;

    const client = collect(
      `${server.url}/api/chat/conversations/conv-other/ws`,
    );
    await client.ready;
    const { code, messages } = await client.done;

    expect(code).toBe(4004);
    expect(messages).toEqual([]);
  });

  it('**一轮跑起来的内容会推过来**，形状与 SSE 那条完全一样', async () => {
    const { app, runtime } = build();
    const created = await app.request('/api/chat/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '直播一轮' }),
    });
    expect(created.status).toBe(201);
    const conversation: unknown = await created.json();
    const id =
      (
        typeof conversation === 'object' &&
        conversation !== null &&
        'id' in conversation &&
        typeof conversation.id === 'string'
      ) ?
        conversation.id
      : '';

    // **先起轮再连**：没有轮在跑时，订阅回放完就关——那是它该有的行为（见第一条用例）。
    await app.request(`/api/chat/conversations/${id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `你好${'字'.repeat(120)}` }),
    });

    const server = startServer(db, runtime);
    stop = server.close;
    const client = collect(`${server.url}/api/chat/conversations/${id}/ws`);
    await client.ready;

    const { messages } = await client.done;
    const text = messages.join('');
    // 直播的 chunk 与收尾的完整消息都到了。
    expect(text).toContain('text-delta');
    expect(text).toContain('你好');
  }, 20_000);
});
