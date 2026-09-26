/**
 * [节点下线](../../../../docs/terms.md)时，`GET .../stream`（SSE 直播）的最后一帧是[请重连帧](../../../../docs/terms.md)：
 * 框架在这份对话交接完之后发它、然后收线，前端收到就立刻重连（docs/logic/orchestration/tech/handover.md §8）。
 *
 * 闸门本身（挡不挡新请求）在 `test/offline.test.ts` 里测；这里只测**既有连接**。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { createLocalProvider } from '../../src/agent/local-sandbox.js';
import { resolveModel } from '../../src/agent/model.js';
import { createSandboxManager } from '../../src/agent/sandbox-manager.js';
import type { Db } from '../../src/db/instance.js';
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
    get frames(): ChatReplayFrame[] {
      return parseSseFrames(buffer);
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

describe('节点下线：SSE 直播以请重连帧收尾', () => {
  let db: Db;
  let sessions: FakeSessions;

  beforeEach(async () => {
    db = await createTestDb();
    await seedUser(db, USER_ID);
    sessions = createFakeSessions();
  });

  function build() {
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
    });
  }

  async function createConversationVia(app: ReturnType<typeof build>['app']) {
    const response = await app.request('/api/chat/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '下线测试' }),
    });
    return ConversationSchema.parse(await response.json());
  }

  it('交权之后：这条 SSE 连接的最后一帧是 {reconnect:true}，然后结束——即便那一轮还没收尾', async () => {
    const { app, runtime } = build();
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
    await reader.readUntil((frames) =>
      frames.some((frame) => 'turnActive' in frame && frame.turnActive),
    );

    // 假 session 不理交权信号：宽限期一到，框架照样给本进程的订阅发请重连帧。
    const shutdown = runtime.shutdown({ graceMs: 50 });
    await reader.waitClosed();
    expect(reader.frames.at(-1)).toEqual({ reconnect: true });

    session.emit({ type: 'finish' });
    session.finish();
    await shutdown;
  });

  it('没有下线：轮正常收尾，连接照常关闭，不带请重连帧', async () => {
    const { app } = build();
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
    await reader.waitClosed();
    expect(reader.frames.some((frame) => 'reconnect' in frame)).toBe(false);
  });
});
