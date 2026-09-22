/**
 * **哪些请求要转给[持有者](../../../../docs/terms.md)**——这里守的是那张清单本身，
 * 尤其是[直播流](../../../../docs/terms.md)那一条随 Redis 分档：
 *
 * - **没配 Redis**：直播流必须转。[进行中草稿](../../../../docs/terms.md)只在持有者的
 *   进程内存里，就地订阅只能看到已经落盘的部分，正在说的那半句看不见。
 * - **配了 Redis**：直播流不转。内容广播到每个副本，就地订阅即可——转过去只是多一跳，
 *   而且持有者一崩，连接跟着断。
 *
 * 转错方向的后果都是静默的：要么用户盯着一个不动的页面，要么多一跳没人察觉。所以这张
 * 清单值得单独钉住。见 docs/host/node/tech/cluster-lab.md §5。
 */
import type { AgentRuntime } from '@runko/agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createLocalProvider } from '../../src/agent/local-sandbox.js';
import { resolveModel } from '../../src/agent/model.js';
import { createChatPersistence } from '../../src/agent/persistence.js';
import { createChatRuntime } from '../../src/agent/runtime.js';
import { createSandboxManager } from '../../src/agent/sandbox-manager.js';
import { createConversation } from '../../src/agent/store.js';
import type { Db } from '../../src/db/instance.js';
import { createChatApp } from '../../src/routes/chat.js';
import { createForwarder } from '../../src/routes/forward.js';
import { fakeAuthMiddleware } from '../helpers/chat-app.js';
import { silentLogger } from '../helpers/silent-logger.js';
import { createTestDb, seedUser } from '../helpers/test-db.js';

const USER_ID = 'user-1';
const HOLDER = 'http://replica-b:3900';
const CONVERSATION_ID = 'conv-1';

/** 本副本发出去的每一次转发。 */
interface ForwardedRequest {
  url: string;
  method: string;
}

/**
 * 起一个 chat 应用，它眼里「这一轮跑在别的副本上」恒成立——这样凡是清单上的路径都会
 * 真的转出去，不在清单上的就地答。
 */
function buildForwardingApp(
  db: Db,
  runtime: AgentRuntime,
  forwardStream: boolean | undefined,
) {
  const sandboxManager = createSandboxManager(
    { local: createLocalProvider({ db, logger: silentLogger }) },
    { logger: silentLogger },
  );
  const forwarded: ForwardedRequest[] = [];
  vi.stubGlobal(
    'fetch',
    (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      forwarded.push({
        url: String(input),
        method: init?.method ?? 'GET',
      });
      return Promise.resolve(new Response('{}', { status: 200 }));
    },
  );
  const app = createChatApp({
    db,
    // 归属的答案直接给死：这一组用例问的是「清单里有谁」，不是「怎么判归属」
    //（那归 `@runko/agent` 的仲裁测试管）。
    runtime: {
      ...runtime,
      getActivity: () =>
        Promise.resolve({ active: true, local: false, holder: HOLDER }),
    },
    decisions: createChatPersistence(db).decisions,
    sandboxManager,
    resolveModel,
    authMiddleware: fakeAuthMiddleware(USER_ID),
    forwarder: createForwarder({ url: 'http://replica-a:3900' }, silentLogger),
    ...(forwardStream !== undefined ? { forwardStream } : {}),
  });
  return { app, forwarded };
}

describe('转发清单', () => {
  let db: Db;
  let runtime: AgentRuntime;

  beforeEach(async () => {
    db = await createTestDb();
    await seedUser(db, USER_ID);
    await createConversation(db, {
      id: CONVERSATION_ID,
      userId: USER_ID,
      title: '转发',
      repo: null,
      branchName: null,
      sandboxName: `runko-chat-${CONVERSATION_ID}`,
      provider: 'local',
    });
    const sandboxManager = createSandboxManager(
      { local: createLocalProvider({ db, logger: silentLogger }) },
      { logger: silentLogger },
    );
    runtime = createChatRuntime({
      db,
      sandboxManager,
      resolveModel,
      logger: silentLogger,
    });
  });

  it('**没配 Redis：直播流要转**（正在说的那半句只在持有者内存里）', async () => {
    const { app, forwarded } = buildForwardingApp(db, runtime, undefined);

    await app.request(`/api/chat/conversations/${CONVERSATION_ID}/stream`);

    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]?.url).toBe(
      `${HOLDER}/api/chat/conversations/${CONVERSATION_ID}/stream`,
    );
  });

  it('**配了 Redis：直播流不转**（内容广播到了每个副本，就地订阅即可）', async () => {
    const { app, forwarded } = buildForwardingApp(db, runtime, false);

    await app.request(`/api/chat/conversations/${CONVERSATION_ID}/stream`);

    expect(forwarded).toEqual([]);
  });

  it('配了 Redis 也只免了直播流这一条——要在持有者内存里办的事照转', async () => {
    const { app, forwarded } = buildForwardingApp(db, runtime, false);

    await app.request(`/api/chat/conversations/${CONVERSATION_ID}/abort`, {
      method: 'POST',
    });
    await app.request(`/api/chat/conversations/${CONVERSATION_ID}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '你好' }),
    });
    await app.request(`/api/chat/conversations/${CONVERSATION_ID}/queue`, {
      method: 'DELETE',
    });

    expect(
      forwarded.map((r) => `${r.method} ${new URL(r.url).pathname}`),
    ).toEqual([
      `POST /api/chat/conversations/${CONVERSATION_ID}/abort`,
      `POST /api/chat/conversations/${CONVERSATION_ID}/messages`,
      `DELETE /api/chat/conversations/${CONVERSATION_ID}/queue`,
    ]);
  });

  it('会话列表这类哪个副本都能答的请求，一概不转', async () => {
    const { app, forwarded } = buildForwardingApp(db, runtime, undefined);

    await app.request('/api/chat/conversations');

    expect(forwarded).toEqual([]);
  });
});
