/**
 * 通知决策层（docs/app/push-notification/tech.md §5、§6.1）——三道闸门的真值表、文案
 * 截断、以及最要紧的那条：**抛错绝不影响一轮**。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../../src/agent/store.js';
import { createConversation, enqueueMessage } from '../../src/agent/store.js';
import { createChatNotifier } from '../../src/push/notifier.js';
import { markPresent, resetPresence } from '../../src/push/presence.js';
import type { PushTransport } from '../../src/push/sender.js';
import { upsertSubscription } from '../../src/push/store.js';
import type { PushPayload } from '../../src/push/types.js';
import { silentLogger } from '../helpers/silent-logger.js';
import { createTestDb, seedUser } from '../helpers/test-db.js';

const CONVERSATION_ID = 'conv-1';
const TITLE = '给博客站换主题';

/** 收下每一条投出去的载荷；`flush` 等一个微任务队列——notifier 是同步返回的。 */
function collector(): { sent: PushPayload[]; transport: PushTransport } {
  const sent: PushPayload[] = [];
  return {
    sent,
    transport: (_subscription, body) => {
      const parsed: unknown = JSON.parse(body);
      // 测试里对自己刚发出去的东西做一次形状确认即可，不必再引一套 schema。
      if (typeof parsed === 'object' && parsed !== null && 'kind' in parsed) {
        sent.push(parsed as PushPayload);
      }
      return Promise.resolve();
    },
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('push/notifier', () => {
  let db: Db;

  beforeEach(() => {
    resetPresence();
    process.env.VAPID_PUBLIC_KEY = 'pub';
    process.env.VAPID_PRIVATE_KEY = 'priv';
    process.env.VAPID_SUBJECT = 'mailto:me@example.com';
    delete process.env.CHAT_PUSH_EVENTS;

    db = createTestDb();
    seedUser(db, 'user-1');
    createConversation(db, {
      id: CONVERSATION_ID,
      userId: 'user-1',
      title: TITLE,
      repo: 'acme/demo',
      branchName: 'nimbo/chat-conv-1',
      sandboxName: 'nimbo-chat-conv-1',
    });
    upsertSubscription(db, {
      endpoint: 'https://a.example/1',
      userId: 'user-1',
      p256dh: 'k',
      auth: 'a',
    });
  });

  afterEach(() => {
    resetPresence();
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;
    delete process.env.CHAT_PUSH_EVENTS;
  });

  function notifier(transport: PushTransport) {
    return createChatNotifier({ db, logger: silentLogger, transport });
  }

  it('要审批：标题固定，正文带会话标题与命令', async () => {
    const { sent, transport } = collector();
    notifier(transport).approvalPending({
      conversationId: CONVERSATION_ID,
      userId: 'user-1',
      callId: 'call-1',
      toolName: 'bash',
      input: { command: 'rm -rf build' },
      timeoutMs: 240_000,
    });
    await flush();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.kind).toBe('approval');
    expect(sent[0]?.title).toBe('等你批准');
    expect(sent[0]?.body).toBe(`${TITLE} · 要跑 rm -rf build`);
    expect(sent[0]?.url).toBe(`/chat/${CONVERSATION_ID}`);
    expect(sent[0]?.tag).toBe(`approval:${CONVERSATION_ID}`);
  });

  it('入参里没有 command 就退回工具名', async () => {
    const { sent, transport } = collector();
    notifier(transport).approvalPending({
      conversationId: CONVERSATION_ID,
      userId: 'user-1',
      callId: 'call-1',
      toolName: 'create-pr',
      input: { title: '改排版' },
      timeoutMs: 1_000,
    });
    await flush();
    expect(sent[0]?.body).toBe(`${TITLE} · 要用 create-pr`);
  });

  it('命令过长会截断', async () => {
    const { sent, transport } = collector();
    notifier(transport).approvalPending({
      conversationId: CONVERSATION_ID,
      userId: 'user-1',
      callId: 'call-1',
      toolName: 'bash',
      input: { command: 'x'.repeat(300) },
      timeoutMs: 1_000,
    });
    await flush();
    expect(sent[0]?.body.length).toBeLessThan(200);
    expect(sent[0]?.body).toContain('…');
  });

  it('挂住不消失只给"卡着一轮"的两类：审批/提问 true，一轮结束 false', async () => {
    const { sent, transport } = collector();
    const n = notifier(transport);

    n.approvalPending({
      conversationId: CONVERSATION_ID,
      userId: 'user-1',
      callId: 'call-1',
      toolName: 'bash',
      input: { command: 'ls' },
      timeoutMs: 1_000,
    });
    n.questionPending({
      conversationId: CONVERSATION_ID,
      userId: 'user-1',
      question: 'q',
      timeoutMs: 1_000,
    });
    n.turnSettled({
      conversationId: CONVERSATION_ID,
      userId: 'user-1',
      status: 'completed',
    });
    n.turnSettled({
      conversationId: CONVERSATION_ID,
      userId: 'user-1',
      status: 'failed',
    });
    await flush();

    expect(sent.map((p) => [p.kind, p.sticky])).toEqual([
      ['approval', true],
      ['question', true],
      ['turn-done', false],
      ['turn-failed', false],
    ]);
  });

  it('审批通知带 callId 与三个按钮，且顺序是「允许 / 拒绝 / 本会话都允许」', async () => {
    const { sent, transport } = collector();
    notifier(transport).approvalPending({
      conversationId: CONVERSATION_ID,
      userId: 'user-1',
      callId: 'call-42',
      toolName: 'bash',
      input: { command: 'ls' },
      timeoutMs: 1_000,
    });
    await flush();

    expect(sent[0]?.callId).toBe('call-42');
    // 顺序即取舍：浏览器只渲染前 `Notification.maxActions` 个（Chrome 是 2），
    // 被丢掉的必须是排最后那个纯便利项，不能是「拒绝」。
    expect(sent[0]?.actions).toEqual([
      { id: 'allow', title: '允许', behavior: 'allow' },
      { id: 'deny', title: '拒绝', behavior: 'deny' },
      { id: 'allow-session', title: '本会话都允许', behavior: 'allow-session' },
    ]);
  });

  it('其余三类不带 callId 也不带按钮（没有可裁决的对象）', async () => {
    const { sent, transport } = collector();
    const n = notifier(transport);
    n.questionPending({
      conversationId: CONVERSATION_ID,
      userId: 'user-1',
      question: 'q',
      timeoutMs: 1_000,
    });
    n.turnSettled({
      conversationId: CONVERSATION_ID,
      userId: 'user-1',
      status: 'completed',
    });
    await flush();

    for (const payload of sent) {
      expect(payload.callId).toBeUndefined();
      expect(payload.actions).toBeUndefined();
    }
  });

  it('agent 提问：带问题片段', async () => {
    const { sent, transport } = collector();
    notifier(transport).questionPending({
      conversationId: CONVERSATION_ID,
      userId: 'user-1',
      question: '这两个方案你选哪个？',
      timeoutMs: 240_000,
    });
    await flush();
    expect(sent[0]?.kind).toBe('question');
    expect(sent[0]?.title).toBe('agent 有话问你');
    expect(sent[0]?.body).toBe(`${TITLE} · 这两个方案你选哪个？`);
  });

  it('一轮完成 → 「跑完了」；失败/停止/崩溃 → 「这一轮没跑完」', async () => {
    const { sent, transport } = collector();
    const n = notifier(transport);
    n.turnSettled({
      conversationId: CONVERSATION_ID,
      userId: 'user-1',
      status: 'completed',
    });
    await flush();
    expect(sent[0]?.kind).toBe('turn-done');
    expect(sent[0]?.title).toBe('跑完了');
    expect(sent[0]?.body).toBe(TITLE);

    for (const status of ['failed', 'interrupted', 'crashed'] as const) {
      sent.length = 0;
      n.turnSettled({
        conversationId: CONVERSATION_ID,
        userId: 'user-1',
        status,
      });
      await flush();
      expect(sent[0]?.kind).toBe('turn-failed');
      expect(sent[0]?.title).toBe('这一轮没跑完');
      expect(sent[0]?.tag).toBe(`turn:${CONVERSATION_ID}`);
    }
  });

  it('闸门 1：不在 CHAT_PUSH_EVENTS 白名单里就不发', async () => {
    process.env.CHAT_PUSH_EVENTS = 'approval';
    const { sent, transport } = collector();
    notifier(transport).turnSettled({
      conversationId: CONVERSATION_ID,
      userId: 'user-1',
      status: 'completed',
    });
    await flush();
    expect(sent).toHaveLength(0);
  });

  it('闸门 2（前台抑制）：人正盯着这条会话就一条都不发', async () => {
    markPresent('user-1', CONVERSATION_ID);
    const { sent, transport } = collector();
    notifier(transport).approvalPending({
      conversationId: CONVERSATION_ID,
      userId: 'user-1',
      callId: 'call-1',
      toolName: 'bash',
      input: { command: 'ls' },
      timeoutMs: 1_000,
    });
    await flush();
    expect(sent).toHaveLength(0);
  });

  it('在场是按会话记的：盯着别的会话不影响这一条', async () => {
    markPresent('user-1', 'another-conversation');
    const { sent, transport } = collector();
    notifier(transport).approvalPending({
      conversationId: CONVERSATION_ID,
      userId: 'user-1',
      callId: 'call-1',
      toolName: 'bash',
      input: { command: 'ls' },
      timeoutMs: 1_000,
    });
    await flush();
    expect(sent).toHaveLength(1);
  });

  it('闸门 3（队列抑制）：待发队列非空时不报「跑完了」', async () => {
    enqueueMessage(db, CONVERSATION_ID, {
      userId: 'user-1',
      text: '接着做下一件事',
    });
    const { sent, transport } = collector();
    notifier(transport).turnSettled({
      conversationId: CONVERSATION_ID,
      userId: 'user-1',
      status: 'completed',
    });
    await flush();
    expect(sent).toHaveLength(0);
  });

  it('队列抑制只管一轮结束，不影响审批（队列里有货照样要人批准）', async () => {
    enqueueMessage(db, CONVERSATION_ID, {
      userId: 'user-1',
      text: '接着做下一件事',
    });
    const { sent, transport } = collector();
    notifier(transport).approvalPending({
      conversationId: CONVERSATION_ID,
      userId: 'user-1',
      callId: 'call-1',
      toolName: 'bash',
      input: { command: 'ls' },
      timeoutMs: 1_000,
    });
    await flush();
    expect(sent).toHaveLength(1);
  });

  it('总闸关着（没配 VAPID）时一条都不发', async () => {
    delete process.env.VAPID_PRIVATE_KEY;
    const { sent, transport } = collector();
    notifier(transport).approvalPending({
      conversationId: CONVERSATION_ID,
      userId: 'user-1',
      callId: 'call-1',
      toolName: 'bash',
      input: { command: 'ls' },
      timeoutMs: 1_000,
    });
    await flush();
    expect(sent).toHaveLength(0);
  });

  it('会话不属于这个人（或已删）就不发', async () => {
    const { sent, transport } = collector();
    notifier(transport).turnSettled({
      conversationId: CONVERSATION_ID,
      userId: 'someone-else',
      status: 'completed',
    });
    await flush();
    expect(sent).toHaveLength(0);
  });

  it('投递抛错不会冒泡出来——通知绝不影响一轮', async () => {
    const throwing: PushTransport = () => {
      throw new Error('推送服务炸了');
    };
    expect(() => {
      notifier(throwing).approvalPending({
        conversationId: CONVERSATION_ID,
        userId: 'user-1',
        callId: 'call-1',
        toolName: 'bash',
        input: { command: 'ls' },
        timeoutMs: 1_000,
      });
    }).not.toThrow();
    await flush();
  });

  it('四个方法全部同步返回 undefined（调用点在一轮的关键路径上，不能 await）', () => {
    const { transport } = collector();
    const n = notifier(transport);
    expect(
      n.approvalPending({
        conversationId: CONVERSATION_ID,
        userId: 'user-1',
        callId: 'call-1',
        toolName: 'bash',
        input: {},
        timeoutMs: 1,
      }),
    ).toBeUndefined();
    expect(
      n.questionPending({
        conversationId: CONVERSATION_ID,
        userId: 'user-1',
        question: 'q',
        timeoutMs: 1,
      }),
    ).toBeUndefined();
    expect(
      n.turnSettled({
        conversationId: CONVERSATION_ID,
        userId: 'user-1',
        status: 'completed',
      }),
    ).toBeUndefined();
  });
});
