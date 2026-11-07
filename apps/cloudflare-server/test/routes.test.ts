/**
 * 经 Worker 的 `fetch` 打接口，走与浏览器同一条路：登录（better-auth on D1）、共用路由、
 * Cloudflare 版会话后端（RPC 进会话对象）、列表读 D1 回写的副本。
 */
import { describe, expect, it, vi } from 'vitest';

import {
  api,
  createConversation,
  detail,
  json,
  listed,
  replay,
  send,
  signUp,
  textOf,
  waitForFrame,
  waitIdle,
} from './helpers.js';

/** 演示模型按 12 个字符一小段地复述，测试配置里每段隔 20ms：这么长能跑一秒多。 */
const LONG_TEXT = 'x'.repeat(800);

describe('不用登录的接口', () => {
  it('健康检查、登录配置、推送配置照 Node 版的形状答；未知的 /api 路径是 JSON 404', async () => {
    expect(await json(await api('/health'))).toEqual({ ok: true });
    expect(await json(await api('/api/auth-config'))).toEqual({
      github: false,
    });
    expect(await json(await api('/api/push/config'))).toEqual({
      enabled: false,
      publicKey: null,
    });
    const missing = await api('/api/nope');
    expect(missing.status).toBe(404);
    expect(await json(missing)).toEqual({ error: 'Not found' });
  });

  it('会话接口、笔记示例都要登录', async () => {
    expect((await api('/api/chat/conversations')).status).toBe(401);
    expect((await api('/api/chat/config')).status).toBe(401);
    expect((await api('/api/notes')).status).toBe(401);
  });

  it('没配静态资源时（测试里），非 /api 路径回 404', async () => {
    expect((await api('/chat/whatever')).status).toBe(404);
  });
});

describe('登录之后', () => {
  it('能力开关：只有本地沙盒、演示模型、没有集群控制台', async () => {
    const cookie = await signUp('config');
    expect(await json(await api('/api/chat/config', { cookie }))).toEqual({
      providers: ['local'],
      defaultProvider: 'local',
      model: 'demo',
      clusterConsole: false,
    });
  });

  it('建会话时选了这台服务端没开的沙盒：400，不建', async () => {
    const cookie = await signUp('provider');
    for (const provider of ['cloudflare', 'vercel']) {
      const response = await api('/api/chat/conversations', {
        method: 'POST',
        cookie,
        body: JSON.stringify({
          title: 'nope',
          provider,
          repo: { installationId: 1, repoId: 2 },
        }),
      });
      expect(response.status).toBe(400);
      expect(await json(response)).toEqual({
        error: `sandbox provider "${provider}" is not available on this server`,
      });
    }
    const list = await api('/api/chat/conversations', { cookie });
    expect(await json(list)).toEqual([]);
  });

  it('首页的笔记示例能用', async () => {
    const cookie = await signUp('notes');
    expect(await json(await api('/api/notes', { cookie }))).toEqual([]);
    const created = await api('/api/notes', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 't', body: 'b' }),
    });
    expect(created.status).toBe(201);
    const notes = await json<{ title: string }[]>(
      await api('/api/notes', { cookie }),
    );
    expect(notes.map((note) => note.title)).toEqual(['t']);
  });

  it('建会话 → 发消息 → 跑完：账本里一问一答，列表上的状态跟着回写', async () => {
    const cookie = await signUp('turn');
    const id = await createConversation(cookie, 'first');
    expect(await send(cookie, id, 'hello there')).toBe('started');
    await waitIdle(cookie, id);

    const messages = await replay(cookie, id);
    expect(messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
    ]);
    expect(textOf(messages[0])).toBe('hello there');
    expect(textOf(messages[1])).toContain('hello there');

    await vi.waitFor(async () => {
      const row = await listed(cookie, id);
      expect(row?.turnInProgress).toBe(false);
      expect(row?.queuedMessages).toEqual([]);
      expect(row?.pendingDecisions).toBe(0);
    });
  });

  it('一轮在跑时再发是排队，跑完接着跑；列表上看得到排着的那条', async () => {
    const cookie = await signUp('queue');
    const id = await createConversation(cookie, 'queue');
    expect(await send(cookie, id, LONG_TEXT)).toBe('started');
    expect(await send(cookie, id, 'second')).toBe('queued');

    await vi.waitFor(async () => {
      const row = await listed(cookie, id);
      expect(row?.turnInProgress).toBe(true);
      expect(row?.queuedMessages.map((item) => item.text)).toEqual(['second']);
    });

    await vi.waitFor(
      async () => {
        const messages = await replay(cookie, id);
        expect(messages.map(textOf).at(-2)).toBe('second');
        expect(messages.at(-1)?.metadata?.status).toBe('completed');
      },
      { timeout: 10_000, interval: 100 },
    );
    await vi.waitFor(async () => {
      const row = await listed(cookie, id);
      expect(row?.turnInProgress).toBe(false);
      expect(row?.queuedMessages).toEqual([]);
    });
  });

  it('删一条排队、清空队列', async () => {
    const cookie = await signUp('dequeue');
    const id = await createConversation(cookie, 'dequeue');
    await send(cookie, id, LONG_TEXT);
    await send(cookie, id, 'one');
    await send(cookie, id, 'two');
    await send(cookie, id, 'three');

    const queued = (await detail(cookie, id)).queuedMessages;
    expect(queued.map((item) => item.text)).toEqual(['one', 'two', 'three']);
    const removed = await api(
      `/api/chat/conversations/${id}/queue/${queued[0]!.id}`,
      { method: 'DELETE', cookie },
    );
    expect(removed.status).toBe(200);
    expect(
      (await detail(cookie, id)).queuedMessages.map((item) => item.text),
    ).toEqual(['two', 'three']);

    const cleared = await api(`/api/chat/conversations/${id}/queue`, {
      method: 'DELETE',
      cookie,
    });
    expect(cleared.status).toBe(200);
    expect((await detail(cookie, id)).queuedMessages).toEqual([]);
    await waitIdle(cookie, id);
  });

  it('停止：这一轮收成「已中断」', async () => {
    const cookie = await signUp('abort');
    const id = await createConversation(cookie, 'abort');
    await send(cookie, id, LONG_TEXT);
    const aborted = await api(`/api/chat/conversations/${id}/abort`, {
      method: 'POST',
      cookie,
    });
    expect(aborted.status).toBe(200);
    await waitIdle(cookie, id);
    const messages = await replay(cookie, id);
    expect(messages.at(-1)?.metadata?.status).toBe('interrupted');
  });

  it('审批：危险命令停下来等人，批准后跑完', async () => {
    const cookie = await signUp('approval');
    const id = await createConversation(cookie, 'approval');
    await send(cookie, id, 'run: rm -rf /tmp/nothing-here');

    const approvalId = await waitForFrame(cookie, id, (frame) => {
      if (frame.chunk?.type === 'tool-approval-request') {
        return frame.chunk.approvalId as string;
      }
      return frame.message?.parts.find(
        (part) => part.state === 'approval-requested',
      )?.approval?.id;
    });
    expect((await detail(cookie, id)).pendingDecisions).toBe(1);
    await vi.waitFor(async () => {
      expect((await listed(cookie, id))?.pendingDecisions).toBe(1);
    });

    const decided = await api(
      `/api/chat/conversations/${id}/approvals/${approvalId}`,
      { method: 'POST', cookie, body: JSON.stringify({ behavior: 'allow' }) },
    );
    expect(decided.status).toBe(200);
    await waitIdle(cookie, id);
    expect((await detail(cookie, id)).pendingDecisions).toBe(0);
    await vi.waitFor(async () => {
      expect((await listed(cookie, id))?.pendingDecisions).toBe(0);
    });
  });

  it('提问：答了之后这一轮接着跑完', async () => {
    const cookie = await signUp('question');
    const id = await createConversation(cookie, 'question');
    await send(cookie, id, 'ask: favourite colour?');

    const callId = await waitForFrame(cookie, id, (frame) => {
      if (
        frame.chunk?.type === 'tool-input-available' &&
        frame.chunk.toolName === 'ask-user'
      ) {
        return frame.chunk.toolCallId as string;
      }
      return frame.message?.parts.find(
        (part) =>
          part.type === 'tool-ask-user' && part.state === 'input-available',
      )?.toolCallId;
    });
    const answered = await api(
      `/api/chat/conversations/${id}/questions/${callId}`,
      { method: 'POST', cookie, body: JSON.stringify({ answer: 'blue' }) },
    );
    expect(answered.status).toBe(200);
    await waitIdle(cookie, id);
    const messages = await replay(cookie, id);
    expect(
      messages
        .flatMap((message) => message.parts)
        .some(
          (candidate) =>
            candidate.type === 'tool-ask-user' &&
            candidate.state === 'output-available',
        ),
    ).toBe(true);
  });

  it('别人的会话一律 404', async () => {
    const owner = await signUp('owner');
    const stranger = await signUp('stranger');
    const id = await createConversation(owner, 'private');
    for (const [path, init] of [
      [`/api/chat/conversations/${id}`, {}],
      [`/api/chat/conversations/${id}/stream`, {}],
      [`/api/chat/conversations/${id}/activity`, {}],
      [
        `/api/chat/conversations/${id}/messages`,
        { method: 'POST', body: JSON.stringify({ text: 'hi' }) },
      ],
    ] as const) {
      const response = await api(path, { ...init, cookie: stranger });
      expect(response.status, path).toBe(404);
    }
    expect(await listed(stranger, id)).toBeUndefined();
  });
});

describe('WebSocket 通道', () => {
  it('不是升级请求回 426，没登录回 401', async () => {
    const cookie = await signUp('ws-guard');
    const id = await createConversation(cookie, 'ws');
    expect(
      (await api(`/api/chat/conversations/${id}/ws`, { cookie })).status,
    ).toBe(426);
    expect(
      (
        await api(`/api/chat/conversations/${id}/ws`, {
          headers: { upgrade: 'websocket' },
        })
      ).status,
    ).toBe(401);
  });

  it('推的帧与 SSE 那条一样；没有轮在跑时回放完就以 1000 关上', async () => {
    const cookie = await signUp('ws');
    const id = await createConversation(cookie, 'ws');
    await send(cookie, id, 'over websocket');
    await waitIdle(cookie, id);

    const response = await api(`/api/chat/conversations/${id}/ws`, {
      cookie,
      headers: { upgrade: 'websocket' },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    const frames: { message?: { role: string } }[] = [];
    const closed = new Promise<number>((resolve) => {
      socket.addEventListener('message', (event) => {
        frames.push(JSON.parse(event.data as string));
      });
      socket.addEventListener('close', (event) => resolve(event.code));
    });
    socket.accept();
    expect(await closed).toBe(1000);
    expect(
      frames.flatMap((frame) =>
        frame.message === undefined ? [] : [frame.message.role],
      ),
    ).toEqual(['user', 'assistant']);
  });

  it('别人的会话以 4004 关上', async () => {
    const owner = await signUp('ws-owner');
    const stranger = await signUp('ws-stranger');
    const id = await createConversation(owner, 'ws');
    const response = await api(`/api/chat/conversations/${id}/ws`, {
      cookie: stranger,
      headers: { upgrade: 'websocket' },
    });
    const socket = response.webSocket!;
    const closed = new Promise<number>((resolve) => {
      socket.addEventListener('close', (event) => resolve(event.code));
    });
    socket.accept();
    expect(await closed).toBe(4004);
  });
});
