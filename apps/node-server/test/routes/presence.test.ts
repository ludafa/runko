/**
 * [在场](../../../../docs/terms.md)心跳接口（docs/tech/push-notification.md §5.2）
 * ——`POST .../presence`。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../../src/agent/store.js';
import { createConversation } from '../../src/agent/store.js';
import { isPresent, resetPresence } from '../../src/push/presence.js';
import { buildChatApp } from '../helpers/chat-app.js';
import { createFakeSandboxManager } from '../helpers/fake-sandbox-manager.js';
import { stopOnlyModel } from '../helpers/mock-model.js';
import { createTestDb, seedUser } from '../helpers/test-db.js';

const CONVERSATION_ID = 'conv-presence-1';

describe('routes/chat —— 在场心跳', () => {
  let db: Db;

  beforeEach(() => {
    resetPresence();
    db = createTestDb();
    seedUser(db, 'user-1');
    seedUser(db, 'user-2');
    createConversation(db, {
      id: CONVERSATION_ID,
      userId: 'user-1',
      title: 'Session',
      repo: 'acme/demo',
      branchName: `nimbo/chat-${CONVERSATION_ID}`,
      sandboxName: `nimbo-chat-${CONVERSATION_ID}`,
    });
  });

  afterEach(resetPresence);

  function app(userId: string) {
    return buildChatApp({
      db,
      sandboxManager: createFakeSandboxManager(),
      resolveModel: () => stopOnlyModel('hi'),
      userId,
    }).app;
  }

  async function post(
    userId: string,
    id: string,
    focused: boolean,
  ): Promise<Response> {
    return app(userId).request(
      `http://localhost/api/chat/conversations/${id}/presence`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ focused }),
      },
    );
  }

  it('focused=true 记在场，focused=false 立即销掉', async () => {
    expect(isPresent('user-1', CONVERSATION_ID)).toBe(false);

    const on = await post('user-1', CONVERSATION_ID, true);
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ ok: true });
    expect(isPresent('user-1', CONVERSATION_ID)).toBe(true);

    await post('user-1', CONVERSATION_ID, false);
    expect(isPresent('user-1', CONVERSATION_ID)).toBe(false);
  });

  it('在场记在上报者名下，不影响别人', async () => {
    await post('user-1', CONVERSATION_ID, true);
    expect(isPresent('user-2', CONVERSATION_ID)).toBe(false);
  });

  it('非属主返 404（与本文件其它会话接口一致，不泄露存在性），且不记在场', async () => {
    const res = await post('user-2', CONVERSATION_ID, true);
    expect(res.status).toBe(404);
    expect(isPresent('user-2', CONVERSATION_ID)).toBe(false);
  });

  it('会话不存在同样 404', async () => {
    const res = await post('user-1', 'no-such-conversation', true);
    expect(res.status).toBe(404);
  });

  it('缺 focused 字段被 zod 挡下', async () => {
    const res = await app('user-1').request(
      `http://localhost/api/chat/conversations/${CONVERSATION_ID}/presence`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
    );
    expect(res.status).toBe(400);
    expect(isPresent('user-1', CONVERSATION_ID)).toBe(false);
  });
});
