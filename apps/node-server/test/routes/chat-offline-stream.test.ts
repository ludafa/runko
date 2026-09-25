/**
 * [节点下线](../../../../docs/terms.md)信号触发时，`GET .../stream`（SSE 直播）要断开——
 * 前端见「轮还在跑却断了」会退避重连，经 nginx 落到别的节点
 * （docs/host/node/tech/cluster-console.md §4.2）。
 *
 * 闸门本身（挡不挡新请求）在 `test/offline.test.ts` 里测；这里只测**既有连接**怎么响应
 * `deps.offlineSignal`——直接给 `buildChatApp` 传一个我们自己控制的 `AbortSignal`，
 * 不必真的走一遍 SIGTERM/`disconnectStreams()`。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createLocalProvider } from '../../src/agent/local-sandbox.js';
import { resolveModel } from '../../src/agent/model.js';
import { createSandboxManager } from '../../src/agent/sandbox-manager.js';
import type { Db } from '../../src/db/instance.js';
import { createForwarder, FORWARDED_HEADER } from '../../src/routes/forward.js';
import type { ChatReplayFrame } from '../../src/schemas/chat.js';
import {
  chatReplayFrameSchema,
  ConversationSchema,
} from '../../src/schemas/chat.js';
import { buildChatApp } from '../helpers/chat-app.js';
import type { FakeSessions } from '../helpers/fake-turn-session.js';
import { createFakeSessions } from '../helpers/fake-turn-session.js';
import { silentLogger } from '../helpers/silent-logger.js';
import { createTestDb, seedUser } from '../helpers/test-db.js';

const USER_ID = 'user-1';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseSseFrames(body: string): ChatReplayFrame[] {
  return body
    .split('\n\n')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => {
      const dataLine = chunk
        .split('\n')
        .find((line) => line.startsWith('data: '));
      return chatReplayFrameSchema.parse(
        JSON.parse(dataLine?.slice('data: '.length) ?? 'null'),
      );
    });
}

/** 边读边看的 SSE 消费者，与 `test/routes/chat.test.ts` 同款：需要知道连接关没关。 */
function createIncrementalReader(response: Response) {
  if (response.body === null) {
    throw new Error('response has no body');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let closed = false;

  void (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (value !== undefined) {
        buffer += decoder.decode(value, { stream: true });
      }
      if (done) {
        closed = true;
        return;
      }
    }
  })();

  return {
    get isClosed() {
      return closed;
    },
    async readUntil(
      predicate: (frames: ChatReplayFrame[]) => boolean,
      maxAttempts = 300,
    ): Promise<ChatReplayFrame[]> {
      for (let i = 0; i < maxAttempts; i += 1) {
        const frames = parseSseFrames(buffer);
        if (predicate(frames) || closed) {
          return frames;
        }
        await sleep(5);
      }
      throw new Error(`timed out; buffer so far: ${buffer}`);
    },
    async waitClosed(maxAttempts = 300): Promise<void> {
      for (let i = 0; i < maxAttempts; i += 1) {
        if (closed) {
          return;
        }
        await sleep(5);
      }
      throw new Error(`stream never closed; buffer so far: ${buffer}`);
    },
  };
}

describe('节点下线：SSE 直播随 offlineSignal 断开', () => {
  let db: Db;
  let sessions: FakeSessions;

  beforeEach(async () => {
    db = await createTestDb();
    await seedUser(db, USER_ID);
    sessions = createFakeSessions();
  });

  function build(offlineSignal?: AbortSignal, withForwarder = false) {
    const sandboxManager = createSandboxManager(
      { local: createLocalProvider({ db, logger: silentLogger }) },
      { logger: silentLogger },
    );
    return buildChatApp({
      db,
      sandboxManager,
      resolveModel,
      userId: USER_ID,
      sessionFactory: sessions.factory,
      ...(offlineSignal !== undefined ? { offlineSignal } : {}),
      ...(withForwarder ? { forwarder: createForwarder() } : {}),
    });
  }

  // `sandboxManager` 这里只装了 `local` 那一档——与 `test/routes/chat-ws.test.ts` 的
  // `startServer` 助手同款，不传 `provider` 就落到能用的那一档。
  async function createConversationVia(app: ReturnType<typeof build>['app']) {
    const response = await app.request('/api/chat/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '下线测试' }),
    });
    return ConversationSchema.parse(await response.json());
  }

  it('下线信号触发：正在直播的这条 SSE 连接结束，即便那一轮还在跑', async () => {
    const controller = new AbortController();
    const { app } = build(controller.signal);
    const created = await createConversationVia(app);
    await app.request(`/api/chat/conversations/${created.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    const session = await sessions.next();
    await session.started;
    session.emit({ type: 'start', messageId: 'm-1' });

    const response = await app.request(
      `/api/chat/conversations/${created.id}/stream`,
    );
    const reader = createIncrementalReader(response);
    // 先确认连接真的建立、且轮还在跑（权威快照到了）——不是还没连上就巧合关闭。
    await reader.readUntil((frames) =>
      frames.some((frame) => 'turnActive' in frame && frame.turnActive),
    );
    expect(reader.isClosed).toBe(false);

    controller.abort();
    await reader.waitClosed();

    // 那一轮本身没有被下线信号打断——它只关掉了这一条直播连接。
    expect(session.signal?.aborted).not.toBe(true);

    // 收尾：让这一轮跑完，避免把假 session 悬在测试进程里。
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
    await vi.waitFor(async () => {
      const activity = await app.request(
        `/api/chat/conversations/${created.id}/activity`,
      );
      expect(await activity.json()).toMatchObject({ active: false });
    });
  });

  it('没配 offlineSignal（生产默认装配以外的宿主，或单进程跑法）：轮结束前连接不会因为下线而中途关闭', async () => {
    const { app } = build(); // 不传 offlineSignal
    const created = await createConversationVia(app);
    await app.request(`/api/chat/conversations/${created.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    const session = await sessions.next();
    await session.started;

    const response = await app.request(
      `/api/chat/conversations/${created.id}/stream`,
    );
    const reader = createIncrementalReader(response);
    await reader.readUntil((frames) =>
      frames.some((frame) => 'turnActive' in frame && frame.turnActive),
    );
    // 给它一点时间——没有信号可触发，连接不该自己关掉。
    await sleep(30);
    expect(reader.isClosed).toBe(false);

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
    await reader.waitClosed(); // 轮正常收尾，连接正常关闭
  });

  it('别的节点转发来的直播：下线信号触发也不断（没配 Redis 时只有本节点能播）', async () => {
    const controller = new AbortController();
    const { app } = build(controller.signal, true);
    const created = await createConversationVia(app);
    await app.request(`/api/chat/conversations/${created.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    const session = await sessions.next();
    await session.started;
    session.emit({ type: 'start', messageId: 'm-1' });

    const response = await app.request(
      `/api/chat/conversations/${created.id}/stream`,
      { headers: { [FORWARDED_HEADER]: '1' } },
    );
    const reader = createIncrementalReader(response);
    await reader.readUntil((frames) =>
      frames.some((frame) => 'turnActive' in frame && frame.turnActive),
    );

    controller.abort();
    await sleep(30);
    expect(reader.isClosed).toBe(false);

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
    await reader.waitClosed(); // 轮收尾，连接照常关闭
  });
});
