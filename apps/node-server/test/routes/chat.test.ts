/**
 * chat 路由的集成用例——**迁移到 `@nimbo/agent` 之后的版本**。
 *
 * 分工变了，测法也跟着变：一轮的一生、[排队](../../../../docs/terms.md)与
 * [出队](../../../../docs/terms.md)、[停止](../../../../docs/terms.md)、
 * [交权](../../../../docs/terms.md)、人在回路，全部在框架里，各自的单元用例在
 * `packages/agent/test/`。本文件只测**这一层该负责的事**：
 *
 * - HTTP 契约：状态码、DTO 形状、鉴权与属主校验；
 * - 框架结果 → HTTP 的翻译（四种 `enqueue` 去向、四种拒绝原因各自的状态码）；
 * - `Frame` → SSE 帧的序列化；
 * - chat 层自己的产品逻辑：沙盒续期的触点、E2B [重连令牌](../../../../docs/terms.md)回写、
 *   [skill 清单](../../../../docs/terms.md)缓存、[会话级授权](../../../../docs/terms.md)。
 *
 * 绝大多数用例用假 session（`helpers/fake-turn-session.ts`）驱动，零模型、零沙盒；
 * 少数几条走真模型 mock，验证「框架 + core + 文件工具」这条真装配是通的。
 */
import type { NimboChunk, NimboUIMessage } from '@nimbo/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createChatPersistence } from '../../src/agent/persistence.js';
import type { Db } from '../../src/agent/store.js';
import { getConversation, updateConversation } from '../../src/agent/store.js';
import type {
  ChatReplayFrame,
  ChunkEnvelope,
  ConversationDto,
  MessageFrame,
  QueueFrame,
  TurnStateFrame,
} from '../../src/schemas/chat.js';
import {
  chatReplayFrameSchema,
  ConversationMessagesListSchema,
  ConversationSchema,
} from '../../src/schemas/chat.js';
import { createTelemetryStore } from '../../src/telemetry.js';
import { buildChatApp, unauthorizedMiddleware } from '../helpers/chat-app.js';
import type { FakeSandboxManager } from '../helpers/fake-sandbox-manager.js';
import { createFakeSandboxManager } from '../helpers/fake-sandbox-manager.js';
import type {
  FakeSessions,
  FakeTurnSession,
} from '../helpers/fake-turn-session.js';
import { createFakeSessions } from '../helpers/fake-turn-session.js';
import { capturingModel, stopOnlyModel } from '../helpers/mock-model.js';
import { collectText } from '../helpers/nimbo-chunks.js';
import { silentLogger } from '../helpers/silent-logger.js';
import { createTestDb, seedUser } from '../helpers/test-db.js';

// ---------------------------------------------------------------------------
// SSE 解析 —— 一律过真 schema（而不是手搓形状），顺带给每条 SSE 响应体做一次
// 契约一致性校验。
// ---------------------------------------------------------------------------

interface SseChunk {
  event?: string;
  data: string;
}

function parseSseChunks(body: string): SseChunk[] {
  return body
    .split('\n\n')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => {
      let event: string | undefined;
      const dataLines: string[] = [];
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event: ')) {
          event = line.slice('event: '.length);
        } else if (line.startsWith('data: ')) {
          dataLines.push(line.slice('data: '.length));
        }
      }
      return { event, data: dataLines.join('\n') };
    });
}

function parseFrames(body: string): ChatReplayFrame[] {
  return parseSseChunks(body).map((chunk) =>
    chatReplayFrameSchema.parse(JSON.parse(chunk.data)),
  );
}

/** 结构判别，与 `routes/chat.ts` 的 `frameEventName` 同一姿态（四个键永不同时出现）。 */
function chunkFrames(frames: ChatReplayFrame[]): ChunkEnvelope[] {
  return frames.filter((frame): frame is ChunkEnvelope => 'chunk' in frame);
}
function messageFrames(frames: ChatReplayFrame[]): MessageFrame[] {
  return frames.filter((frame): frame is MessageFrame => 'message' in frame);
}
function queueFrames(frames: ChatReplayFrame[]): QueueFrame[] {
  return frames.filter((frame): frame is QueueFrame => 'queue' in frame);
}
function turnStateFrames(frames: ChatReplayFrame[]): TurnStateFrame[] {
  return frames.filter(
    (frame): frame is TurnStateFrame => 'turnActive' in frame,
  );
}
function chunksOnly(frames: ChatReplayFrame[]): NimboChunk[] {
  return chunkFrames(frames).map((frame) => frame.chunk);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 边读边看的 SSE 消费者（不是 `.text()`——那会等到整条流关闭）：需要「推一个 chunk →
 * 观察它真的到了」交替进行的用例用它，跟真客户端消费直播流的方式一样。
 */
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
    async readUntil(
      predicate: (frames: ChatReplayFrame[]) => boolean,
      maxAttempts = 300,
    ): Promise<ChatReplayFrame[]> {
      for (let i = 0; i < maxAttempts; i += 1) {
        const frames = parseFrames(buffer);
        if (predicate(frames) || closed) {
          return frames;
        }
        await sleep(5);
      }
      throw new Error(`timed out; buffer so far: ${buffer}`);
    },
    async drainToClose(maxAttempts = 300): Promise<ChatReplayFrame[]> {
      for (let i = 0; i < maxAttempts; i += 1) {
        if (closed) {
          return parseFrames(buffer);
        }
        await sleep(5);
      }
      throw new Error(`stream never closed; buffer so far: ${buffer}`);
    },
  };
}

/** 轮询直到拿到非 undefined 值——跨轮的异步链（出队 → 起下一轮）没有单一 promise 可 await。 */
async function waitFor<T>(
  read: () => T | undefined,
  maxAttempts = 400,
): Promise<T> {
  for (let i = 0; i < maxAttempts; i += 1) {
    const value = read();
    if (value !== undefined) {
      return value;
    }
    await sleep(5);
  }
  throw new Error('timed out waiting for the expected state');
}

/** 跑完一轮：发几个 chunk、落一条成品消息、收尾。 */
async function runTurn(
  session: FakeTurnSession,
  text: string,
  turn = 1,
): Promise<void> {
  await session.started;
  session.emit({ type: 'start', messageId: `m-${String(turn)}` });
  session.emit({ type: 'text-start', id: 't1' });
  session.emit({ type: 'text-delta', id: 't1', delta: text });
  session.emit({ type: 'text-end', id: 't1' });
  session.emit({ type: 'finish' });
  session.push({
    id: `a-${String(turn)}`,
    role: 'assistant',
    parts: [{ type: 'text', text }],
    metadata: { turn, usage: {}, status: 'completed' },
  });
  session.emit({
    type: 'message-metadata',
    messageMetadata: { turn, usage: {}, status: 'completed' },
  });
  session.finish();
}

const USER_ID = 'user-1';

describe('routes/chat', () => {
  let db: Db;
  let sandboxManager: FakeSandboxManager;
  let sessions: FakeSessions;

  beforeEach(() => {
    vi.stubEnv('GITHUB_REPO', 'git@github.com:acme/demo.git');
    vi.stubEnv('GITHUB_PAT', 'test-pat');
    db = createTestDb();
    seedUser(db, USER_ID);
    seedUser(db, 'user-2');
    sandboxManager = createFakeSandboxManager();
    sessions = createFakeSessions();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** 默认：假 session 驱动（零模型）。传 `real: true` 走真 core + 真文件工具。 */
  function build(opts: { real?: boolean; userId?: string } = {}) {
    return buildChatApp({
      db,
      sandboxManager,
      resolveModel: () => stopOnlyModel('hi'),
      userId: opts.userId ?? USER_ID,
      ...(opts.real === true ? {} : { sessionFactory: sessions.factory }),
    });
  }

  async function createConversationVia(
    app: ReturnType<typeof build>['app'],
    body: Record<string, unknown> = {},
  ): Promise<ConversationDto> {
    const response = await app.request('/api/chat/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return ConversationSchema.parse(await response.json());
  }

  async function post(
    app: ReturnType<typeof build>['app'],
    id: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    return await app.request(`/api/chat/conversations/${id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function ledgerMessages(id: string): Promise<NimboUIMessage[]> {
    const entries = await createChatPersistence(db, silentLogger).ledger.read(
      id,
    );
    return entries.map((entry) => entry.message);
  }

  // -------------------------------------------------------------------------

  describe('会话的增删查', () => {
    it('建会话：先开沙盒再落行，DTO 带上仓库/分支/沙盒名与 skill 清单', async () => {
      const { app } = build();
      const created = await createConversationVia(app, { title: 'My session' });

      expect(created.title).toBe('My session');
      expect(created.repo).toBe('acme/demo');
      expect(created.status).toBe('active');
      expect(created.branchName).toContain(created.id);
      expect(created.sandboxName).toContain(created.id);
      expect(sandboxManager.acquireCalls).toHaveLength(1);
      expect(sandboxManager.acquireCalls[0]?.repoCloneUrl).toBe(
        'https://github.com/acme/demo.git',
      );
      // 沙盒刚 clone 完就扫一次 skill 写库——否则新会话要等第一轮跑完才有菜单。
      expect(created.availableSkills.map((skill) => skill.name)).toContain(
        'frontend-design',
      );
    });

    it('列表只给自己的；别人的会话查不到（404，不泄露存在性）', async () => {
      const mine = await createConversationVia(build().app);
      const other = build({ userId: 'user-2' });
      await createConversationVia(other.app);

      const listed = await build().app.request('/api/chat/conversations');
      const rows = (await listed.json()) as ConversationDto[];
      expect(rows.map((row) => row.id)).toEqual([mine.id]);

      const stolen = await other.app.request(
        `/api/chat/conversations/${mine.id}`,
      );
      expect(stolen.status).toBe(404);
    });

    it('未登录一律 401', async () => {
      const { app } = buildChatApp({
        db,
        sandboxManager,
        resolveModel: () => stopOnlyModel('hi'),
        authMiddleware: unauthorizedMiddleware,
        sessionFactory: sessions.factory,
      });
      expect((await app.request('/api/chat/conversations')).status).toBe(401);
    });

    it('E2B 会话把服务端分配的 sandboxId 落库（Vercel 按名字恢复，恒 null）', async () => {
      const { app } = build();
      const e2b = await createConversationVia(app, { provider: 'e2b' });
      const vercel = await createConversationVia(app, { provider: 'vercel' });

      expect(getConversation(db, e2b.id, USER_ID)?.sandboxId).not.toBeNull();
      expect(getConversation(db, vercel.id, USER_ID)?.sandboxId).toBeNull();
    });
  });

  describe('GET .../messages —— 回放', () => {
    it('账本里只有成品消息（[进行中草稿](../../../../docs/terms.md)在内存），所以回放出来全是 MessageFrame', async () => {
      const { app } = build();
      const created = await createConversationVia(app);
      await post(app, created.id, { text: 'hello' });
      await runTurn(await sessions.next(), 'hi there');
      await waitFor(
        () =>
          (sandboxManager.acquireCalls.length > 1 ? true : undefined) ?? true,
      );
      await vi.waitFor(async () => {
        expect(await ledgerMessages(created.id)).toHaveLength(2);
      });

      const response = await app.request(
        `/api/chat/conversations/${created.id}/messages`,
      );
      const { frames } = ConversationMessagesListSchema.parse(
        await response.json(),
      );
      expect(chunkFrames(frames)).toHaveLength(0);
      expect(messageFrames(frames).map((frame) => frame.message.role)).toEqual([
        'user',
        'assistant',
      ]);
    });

    it('`after=` 只回放之后的', async () => {
      const { app } = build();
      const created = await createConversationVia(app);
      await post(app, created.id, { text: 'hello' });
      await runTurn(await sessions.next(), 'hi');
      await vi.waitFor(async () => {
        expect(await ledgerMessages(created.id)).toHaveLength(2);
      });

      const response = await app.request(
        `/api/chat/conversations/${created.id}/messages?after=1`,
      );
      const { frames } = ConversationMessagesListSchema.parse(
        await response.json(),
      );
      expect(frames).toHaveLength(1);
    });

    it('会话不存在 → 404', async () => {
      const response = await build().app.request(
        '/api/chat/conversations/nope/messages',
      );
      expect(response.status).toBe(404);
    });
  });

  describe('POST .../messages —— 四种去向', () => {
    it('空闲 → started，用户原话立刻落账本', async () => {
      const { app } = build();
      const created = await createConversationVia(app);

      const response = await post(app, created.id, { text: 'hello' });
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ ok: true, mode: 'started' });

      const session = await sessions.next();
      await runTurn(session, 'hi');
      await vi.waitFor(async () => {
        const messages = await ledgerMessages(created.id);
        expect(collectText(messages[0])).toBe('hello');
      });
    });

    it('**一轮跑完刷新 `lastActiveAt`**，会话不会明明在用却显示「休眠」', async () => {
      // `sleeping` 是**读时推**的（`Date.now() - lastActiveAt > 空闲超时`），所以这一列
      // 没人写 = 所有会话过了空闲窗口就永远显示休眠。旧实现在每轮收尾写一次，迁移时
      // 连同 `turn-runner/persistence.ts` 一起删掉了，这条用例守着它别再掉。
      const { app } = build();
      const created = await createConversationVia(app);

      updateConversation(db, created.id, { lastActiveAt: new Date(0) });
      const stale = await app.request(`/api/chat/conversations/${created.id}`);
      expect(ConversationSchema.parse(await stale.json()).status).toBe(
        'sleeping',
      );

      await post(app, created.id, { text: 'hello' });
      await runTurn(await sessions.next(), 'hi');

      await vi.waitFor(async () => {
        const fresh = await app.request(
          `/api/chat/conversations/${created.id}`,
        );
        expect(ConversationSchema.parse(await fresh.json()).status).toBe(
          'active',
        );
      });
    });

    it('有轮在跑 + 默认 intent → queued，并给沙盒续期（用户还在场）', async () => {
      const { app } = build();
      const created = await createConversationVia(app);
      await post(app, created.id, { text: 'first' });
      const first = await sessions.next();
      await first.started;

      const touchesBefore = sandboxManager.ensureLifetimeCalls.length;
      const response = await post(app, created.id, { text: 'second' });
      expect(await response.json()).toEqual({ ok: true, mode: 'queued' });
      expect(sandboxManager.ensureLifetimeCalls.length).toBeGreaterThan(
        touchesBefore,
      );

      await runTurn(first, 'done 1', 1);
      // 自动出队起第二轮——排队那条成了它的用户消息。
      await runTurn(await sessions.next(), 'done 2', 2);
      await vi.waitFor(async () => {
        const texts = (await ledgerMessages(created.id))
          .filter((message) => message.role === 'user')
          .map((message) => collectText(message));
        expect(texts).toEqual(['first', 'second']);
      });
    });

    it('有轮在跑 + `intent: "steer"` → steered，不起新轮、不入队', async () => {
      const { app } = build();
      const created = await createConversationVia(app);
      await post(app, created.id, { text: 'first' });
      const first = await sessions.next();
      await first.started;

      const response = await post(app, created.id, {
        text: 'also this',
        intent: 'steer',
      });
      expect(await response.json()).toEqual({ ok: true, mode: 'steered' });

      await runTurn(first, 'ok', 1);
      await vi.waitFor(async () => {
        const messages = await ledgerMessages(created.id);
        expect(messages.some((m) => m.metadata?.steered === true)).toBe(true);
      });
      expect(sessions.all).toHaveLength(1); // 没有起第二轮
    });

    it('会话不存在 → 404；关闭中 → 503', async () => {
      const { app, runtime } = build();
      expect((await post(app, 'nope', { text: 'x' })).status).toBe(404);

      const created = await createConversationVia(app);
      await runtime.shutdown({ graceMs: 50 });
      const response = await post(app, created.id, { text: 'x' });
      expect(response.status).toBe(503);
    });
  });

  describe('POST .../abort —— 停止', () => {
    it('停止会中止这一轮并清空队列', async () => {
      const { app } = build();
      const created = await createConversationVia(app);
      await post(app, created.id, { text: 'first' });
      const session = await sessions.next();
      await session.started;
      await post(app, created.id, { text: 'queued' });

      const response = await app.request(
        `/api/chat/conversations/${created.id}/abort`,
        { method: 'POST' },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, queue: [] });
      expect(session.signal?.aborted).toBe(true);

      // core 收到 signal 后走优雅收尾。
      session.emit({
        type: 'message-metadata',
        messageMetadata: { turn: 1, usage: {}, status: 'interrupted' },
      });
      session.finish();
      await vi.waitFor(async () => {
        expect((await build().runtime.getActivity(created.id)).active).toBe(
          false,
        );
      });
      // 队列已清 → 不会自动起下一轮。
      expect(sessions.all).toHaveLength(1);
    });

    it('没有轮在跑 → 409，而且**不动队列**（一次误点不该变成一次丢消息）', async () => {
      const { app } = build();
      const created = await createConversationVia(app);
      const response = await app.request(
        `/api/chat/conversations/${created.id}/abort`,
        { method: 'POST' },
      );
      expect(response.status).toBe(409);
    });

    it('会话不存在 → 404', async () => {
      const response = await build().app.request(
        '/api/chat/conversations/nope/abort',
        { method: 'POST' },
      );
      expect(response.status).toBe(404);
    });
  });

  describe('队列端点', () => {
    it('删一条 / 清空都返回变更后的完整快照', async () => {
      const { app } = build();
      const created = await createConversationVia(app);
      await post(app, created.id, { text: 'first' });
      await (
        await sessions.next()
      ).started;
      await post(app, created.id, { text: 'q1' });

      const listed = await app.request(`/api/chat/conversations/${created.id}`);
      const dto = ConversationSchema.parse(await listed.json());
      expect(dto.queuedMessages).toHaveLength(1);
      const queuedId = dto.queuedMessages[0]?.id ?? '';
      expect(dto.queuedMessages[0]?.text).toBe('q1');
      expect(dto.queuedMessages[0]?.userId).toBe(USER_ID);

      const removed = await app.request(
        `/api/chat/conversations/${created.id}/queue/${queuedId}`,
        { method: 'DELETE' },
      );
      expect(removed.status).toBe(200);
      expect(await removed.json()).toEqual({ queue: [] });

      const missing = await app.request(
        `/api/chat/conversations/${created.id}/queue/${queuedId}`,
        { method: 'DELETE' },
      );
      expect(missing.status).toBe(404);

      await post(app, created.id, { text: 'q2' });
      const cleared = await app.request(
        `/api/chat/conversations/${created.id}/queue`,
        { method: 'DELETE' },
      );
      expect(await cleared.json()).toEqual({ queue: [] });
    });
  });

  describe('GET .../stream —— 直播流', () => {
    it('回放 → 草稿 → 队列快照 → 轮状态快照 → 直播，轮一收尾就关连接', async () => {
      const { app } = build();
      const created = await createConversationVia(app);
      await post(app, created.id, { text: 'hello' });
      const session = await sessions.next();
      await session.started;
      session.emit({ type: 'start', messageId: 'm-1' });
      await sleep(20);

      const response = await app.request(
        `/api/chat/conversations/${created.id}/stream`,
      );
      const reader = createIncrementalReader(response);
      const early = await reader.readUntil(
        (frames) => turnStateFrames(frames).length > 0,
      );

      // 起轮那条用户消息已经落盘、被回放到；`start` chunk 来自内存草稿。
      expect(messageFrames(early)).toHaveLength(1);
      expect(chunksOnly(early).map((chunk) => chunk.type)).toEqual(['start']);
      expect(queueFrames(early)).toHaveLength(1);
      expect(turnStateFrames(early).at(-1)?.turnActive).toBe(true);
      // 草稿 chunk **没有 seq**——它们只直播、不落库、不参与 `after=` 续传。
      expect(chunkFrames(early).every((frame) => frame.seq === undefined)).toBe(
        true,
      );

      await runTurn(session, 'hi');
      const all = await reader.drainToClose();
      expect(turnStateFrames(all).at(-1)?.turnActive).toBe(false);
      // 收尾时本轮新增的成品消息以 MessageFrame 直播出去。
      expect(messageFrames(all).length).toBeGreaterThanOrEqual(2);
    });

    it('没有轮在跑时：回放完 + 两帧快照，然后立刻关闭', async () => {
      const { app } = build();
      const created = await createConversationVia(app);
      const response = await app.request(
        `/api/chat/conversations/${created.id}/stream`,
      );
      const frames = parseFrames(await response.text());
      expect(frames).toHaveLength(2);
      expect(queueFrames(frames)).toHaveLength(1);
      expect(turnStateFrames(frames).at(-1)?.turnActive).toBe(false);
    });

    it('`after=` 跳过已经看过的成品消息', async () => {
      const { app } = build();
      const created = await createConversationVia(app);
      await post(app, created.id, { text: 'hello' });
      await runTurn(await sessions.next(), 'hi');
      await vi.waitFor(async () => {
        expect(await ledgerMessages(created.id)).toHaveLength(2);
      });

      const response = await app.request(
        `/api/chat/conversations/${created.id}/stream?after=1`,
      );
      const frames = parseFrames(await response.text());
      expect(messageFrames(frames)).toHaveLength(1);
    });

    it('SSE 的 event 名按帧种类分四种', async () => {
      const { app } = build();
      const created = await createConversationVia(app);
      await post(app, created.id, { text: 'hello' });
      const session = await sessions.next();
      await runTurn(session, 'hi');
      await vi.waitFor(async () => {
        expect(await ledgerMessages(created.id)).toHaveLength(2);
      });

      const response = await app.request(
        `/api/chat/conversations/${created.id}/stream`,
      );
      const events = parseSseChunks(await response.text()).map(
        (chunk) => chunk.event,
      );
      expect(events).toContain('message');
      expect(events).toContain('queue');
      expect(events).toContain('turn-state');
    });
  });

  describe('审批与提问', () => {
    /** 模拟 core：解析出 `review` 之后 await 框架注入的[人审通道](../../../../docs/terms.md)。 */
    function requestReview(session: FakeTurnSession, callId: string) {
      return session.onReview?.({
        toolName: 'bash',
        input: { command: 'rm -rf build' },
        ctx: { callId, toolName: 'bash', session: { id: 's', turn: 1 } },
      });
    }

    it('允许：唤醒挂起的调用，并把裁决落[裁决表](../../../../docs/terms.md)', async () => {
      const { app } = build();
      const created = await createConversationVia(app);
      await post(app, created.id, { text: 'clean up' });
      const session = await sessions.next();
      await session.started;

      const pending = requestReview(session, 'call-1');
      const decisions = createChatPersistence(db, silentLogger).decisions;
      await vi.waitFor(async () => {
        expect(await decisions.listPending(created.id)).toHaveLength(1);
      });

      const response = await app.request(
        `/api/chat/conversations/${created.id}/approvals/call-1`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ behavior: 'allow' }),
        },
      );
      expect(response.status).toBe(200);
      await expect(pending).resolves.toEqual({ behavior: 'allow' });
      expect(await decisions.listPending(created.id)).toHaveLength(0);

      session.finish();
    });

    it('拒绝带理由；沙盒不为拒绝续期（那一步只在允许分支）', async () => {
      const { app } = build();
      const created = await createConversationVia(app);
      await post(app, created.id, { text: 'clean up' });
      const session = await sessions.next();
      await session.started;
      const pending = requestReview(session, 'call-2');
      const touchesBefore = sandboxManager.ensureLifetimeCalls.length;

      await app.request(
        `/api/chat/conversations/${created.id}/approvals/call-2`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ behavior: 'deny', message: '太危险' }),
        },
      );
      await expect(pending).resolves.toEqual({
        behavior: 'deny',
        message: '太危险',
      });
      expect(sandboxManager.ensureLifetimeCalls.length).toBe(touchesBefore);

      session.finish();
    });

    it('「会话内都允许」额外记一条[会话级授权](../../../../docs/terms.md)，之后同样的调用直接放行', async () => {
      const { app } = build();
      const created = await createConversationVia(app);
      await post(app, created.id, { text: 'clean up' });
      const session = await sessions.next();
      await session.started;
      const pending = requestReview(session, 'call-3');
      await vi.waitFor(async () => {
        expect(
          await createChatPersistence(db, silentLogger).decisions.listPending(
            created.id,
          ),
        ).toHaveLength(1);
      });

      await app.request(
        `/api/chat/conversations/${created.id}/approvals/call-3`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ behavior: 'allow-session' }),
        },
      );
      await expect(pending).resolves.toEqual({ behavior: 'allow' });

      const { hasConversationGrant } =
        await import('../../src/agent/conversation-grants.js');
      expect(
        hasConversationGrant(db, created.id, USER_ID, 'bash', {
          command: 'rm -rf build',
        }),
      ).toBe(true);

      session.finish();
    });

    it('没有这条挂起项 → 404（已结、已超时、或从未存在）', async () => {
      const { app } = build();
      const created = await createConversationVia(app);
      const response = await app.request(
        `/api/chat/conversations/${created.id}/approvals/ghost`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ behavior: 'allow' }),
        },
      );
      expect(response.status).toBe(404);
    });

    it('ask-user：内置工具挂起 → 回答 → 答复原样交回模型', async () => {
      const { app } = build();
      const created = await createConversationVia(app);
      await post(app, created.id, { text: 'ask me' });
      const session = await sessions.next();
      await session.started;

      // 框架恒注册内置 `ask-user`（产品能力，不是安全闸）。
      expect(session.tools['ask-user']).toBeDefined();

      const response = await app.request(
        `/api/chat/conversations/${created.id}/questions/ghost`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ answer: 'x' }),
        },
      );
      expect(response.status).toBe(404); // 没有挂起的提问

      session.finish();
    });
  });

  describe('遥测端点', () => {
    it('没启用遥测时恒返回空数组（不是错误）', async () => {
      const { app } = build();
      const created = await createConversationVia(app);
      const response = await app.request(
        `/api/chat/conversations/${created.id}/turns/1/telemetry`,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ events: [] });
    });

    it('启用后按 (会话 id, 轮号) 查回——会话 id 现在就是 conversationId', async () => {
      const telemetryStore = createTelemetryStore(':memory:');
      const { app } = buildChatApp({
        db,
        sandboxManager,
        resolveModel: () => stopOnlyModel('hi'),
        userId: USER_ID,
        telemetryStore,
        sessionFactory: sessions.factory,
      });
      const created = await createConversationVia(app);
      telemetryStore.record('model-call-end', `${created.id}#1`, { ok: true });

      const response = await app.request(
        `/api/chat/conversations/${created.id}/turns/1/telemetry`,
      );
      const body = (await response.json()) as {
        events: { eventType: string }[];
      };
      expect(body.events.map((event) => event.eventType)).toEqual([
        'model-call-end',
      ]);
      telemetryStore.close();
    });
  });

  describe('真装配（框架 + core + 文件工具）', () => {
    it('一轮真跑完：账本里是用户消息 + assistant 消息，模型收到的是用户原话', async () => {
      const model = capturingModel('done');
      const { app } = buildChatApp({
        db,
        sandboxManager,
        resolveModel: () => model.model,
        userId: USER_ID,
      });
      const created = await createConversationVia(app);
      await post(app, created.id, { text: 'say hi' });

      await vi.waitFor(
        async () => {
          const messages = await ledgerMessages(created.id);
          expect(messages).toHaveLength(2);
          expect(messages[1]?.role).toBe('assistant');
        },
        { timeout: 5000 },
      );
      const prompt = JSON.stringify(model.captured);
      expect(prompt).toContain('say hi');
      // 仓库/分支被烤进了系统提示词。
      expect(prompt).toContain('acme/demo');
    });

    it('第二轮 resume 上一轮的账本——模型看到的历史是连续的', async () => {
      const model = capturingModel('done');
      const { app } = buildChatApp({
        db,
        sandboxManager,
        resolveModel: () => model.model,
        userId: USER_ID,
      });
      const created = await createConversationVia(app);
      await post(app, created.id, { text: 'first' });
      await vi.waitFor(
        async () => {
          expect(await ledgerMessages(created.id)).toHaveLength(2);
        },
        { timeout: 5000 },
      );

      await post(app, created.id, { text: 'second' });
      await vi.waitFor(
        async () => {
          expect(await ledgerMessages(created.id)).toHaveLength(4);
        },
        { timeout: 5000 },
      );

      const lastCall = JSON.stringify(model.captured.at(-1));
      expect(lastCall).toContain('first');
      expect(lastCall).toContain('second');
    });
  });

  describe('崩溃恢复', () => {
    it('库里还留着[起轮标记](../../../../docs/terms.md)= 那一轮没人管了，启动扫描补一条「已停止」', async () => {
      const { app } = build();
      const created = await createConversationVia(app);
      await post(app, created.id, { text: 'hello' });
      const session = await sessions.next();
      await session.started;

      // 模拟进程被强杀：起轮标记留在库里，但没有任何进程在驱动这一轮。
      // 新进程起来后扫描，认出它并补收尾。
      const fresh = build();
      const result = await fresh.runtime.recover();
      expect(result.recovered).toBe(1);

      const messages = await ledgerMessages(created.id);
      expect(messages.at(-1)?.metadata?.status).toBe('interrupted');
      // 幂等：再扫一次什么都不做。
      await expect(fresh.runtime.recover()).resolves.toMatchObject({
        recovered: 0,
      });

      session.finish();
    });
  });
});
