import type {
  NimboChunk,
  NimboExec,
  NimboFS,
  NimboUIMessage,
} from '@nimbo/core';
import { MemoryFS } from '@nimbo/sdk';
import type { MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AcquiredSandbox,
  AcquireInput,
  SandboxManager,
} from '../../src/agent/sandbox-manager.js';
import type { Db } from '../../src/agent/store.js';
import {
  getConversation,
  listConversationEvents,
  updateConversation,
} from '../../src/agent/store.js';
import {
  __resetShutdownForTests,
  isTurnActive,
  shutdownTurns,
  startTurn,
} from '../../src/agent/turn-runner/index.js';
import { createChatApp } from '../../src/routes/chat.js';
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
  ConversationEventsListSchema,
  ConversationSchema,
  messageFrameSchema,
} from '../../src/schemas/chat.js';
import { createTelemetryStore } from '../../src/telemetry.js';
import { createControllableSession } from '../helpers/controllable-session.js';
import type { FakeSandboxManager } from '../helpers/fake-sandbox-manager.js';
import { createFakeSandboxManager } from '../helpers/fake-sandbox-manager.js';
import {
  capturingModel,
  stopOnlyModel,
  toolCallThenStopModel,
} from '../helpers/mock-model.js';
import {
  allToolParts,
  collectText,
  startChunk,
} from '../helpers/nimbo-chunks.js';
import { silentLogger } from '../helpers/silent-logger.js';
import { createTestDb, seedUser } from '../helpers/test-db.js';

type ChatEnv = { Variables: { userId: string } };

function fakeAuthMiddleware(userId: string): MiddlewareHandler<ChatEnv> {
  return createMiddleware<ChatEnv>(async (c, next) => {
    c.set('userId', userId);
    await next();
  });
}

const unauthorizedMiddleware: MiddlewareHandler<ChatEnv> =
  createMiddleware<ChatEnv>(async (c) =>
    c.json({ error: 'Unauthorized' }, 401),
  );

// ---------------------------------------------------------------------------
// SSE parsing (docs/tech/single-ledger.md §5 单-3): every frame this
// app's SSE endpoints can ever send is a `ChatReplayFrame` — either a
// `ChunkEnvelope` (`{seq?, chunk}`, live or replayed) or a `MessageFrame`
// (`{seq, message}`, replay-only). Parsing through the real
// `chatReplayFrameSchema` (rather than a hand-rolled/`as`-asserted shape)
// gives every test a properly-typed `NimboChunk`/`NimboUIMessage` for free,
// and doubles as live schema-conformance coverage on every SSE body this
// file reads.
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
        if (line.startsWith('event: ')) event = line.slice('event: '.length);
        else if (line.startsWith('data: '))
          dataLines.push(line.slice('data: '.length));
      }
      return { event, data: dataLines.join('\n') };
    });
}

function parseFrames(body: string): ChatReplayFrame[] {
  return parseSseChunks(body).map((chunk) =>
    chatReplayFrameSchema.parse(JSON.parse(chunk.data)),
  );
}

/** Narrows a frame list to its `ChunkEnvelope`s — structural discrimination (`'chunk' in frame`), same as `routes/chat.ts`'s own `frameEventName`. */
function chunkFrames(frames: ChatReplayFrame[]): ChunkEnvelope[] {
  return frames.filter((frame): frame is ChunkEnvelope => 'chunk' in frame);
}

/** Narrows a frame list to its `MessageFrame`s. */
function messageFrames(frames: ChatReplayFrame[]): MessageFrame[] {
  return frames.filter((frame): frame is MessageFrame => 'message' in frame);
}

/** Narrows a frame list to its `QueueFrame`s（[待发队列](docs/terms.md)快照，docs/tech/steer-and-queue.md §4.3）——同样是结构判别（`'queue' in frame`）。 */
function queueFrames(frames: ChatReplayFrame[]): QueueFrame[] {
  return frames.filter((frame): frame is QueueFrame => 'queue' in frame);
}

/** Narrows a frame list to its `TurnStateFrame`s（[轮状态快照](docs/terms.md)，docs/tech/chat-webapp.md §5.1）——同样是结构判别（`'turnActive' in frame`）。 */
function turnStateFrames(frames: ChatReplayFrame[]): TurnStateFrame[] {
  return frames.filter(
    (frame): frame is TurnStateFrame => 'turnActive' in frame,
  );
}

function chunksOnly(frames: ChatReplayFrame[]): NimboChunk[] {
  return chunkFrames(frames).map((frame) => frame.chunk);
}

/** 账本里已落盘的消息，按 seq 序（`kind = 'message'` 行原样解析回 `NimboUIMessage`）。 */
function persistedMessages(db: Db, conversationId: string): NimboUIMessage[] {
  return listConversationEvents(db, conversationId)
    .filter((row) => row.kind === 'message')
    .map(
      (row) =>
        // `JSON.parse` 的 `any` 直接喂进 zod、不落进具名变量——与本文件 `parseFrames`
        // 同一姿态，`any` 不逃出这个表达式。
        messageFrameSchema.parse({
          seq: row.seq,
          message: JSON.parse(row.payloadJson),
        }).message,
    );
}

/** 账本里已落盘的用户消息文本，按 seq 序——自动出队用例据此确认「排队的那条真的成了下一轮的用户消息」。 */
function persistedUserTexts(db: Db, conversationId: string): string[] {
  return persistedMessages(db, conversationId)
    .filter((message) => message.role === 'user')
    .map((message) => collectText(message));
}

/** 已落盘的每一轮收尾状态，按 seq 序（`completed` / `failed` / `interrupted`）——停止用例据此确认这一轮是**被停止**收尾的，不是失败也不是正常完成。 */
function persistedTurnStatuses(
  db: Db,
  conversationId: string,
): (string | undefined)[] {
  return persistedMessages(db, conversationId)
    .filter((message) => message.metadata?.status !== undefined)
    .map((message) => message.metadata?.status);
}

/**
 * 轮询直到 `read()` 给出一个非 undefined 的值（默认 ~2s 上限）——自动出队是**跨轮**的
 * 异步链（上一轮 `finally` → 出队 → 起下一轮 → 下一轮跑完），没有单一的 promise 可
 * `await`，所以这里按 `sleep(5)` 轮询已落盘的结果，与本文件既有的 `readUntil` 同风格。
 */
async function waitFor<T>(
  read: () => T | undefined,
  maxAttempts = 400,
): Promise<T> {
  for (let i = 0; i < maxAttempts; i += 1) {
    const value = read();
    if (value !== undefined) return value;
    await sleep(5);
  }
  throw new Error('timed out waiting for the expected state');
}

function messagesOnly(frames: ChatReplayFrame[]): NimboUIMessage[] {
  return messageFrames(frames).map((frame) => frame.message);
}

/** The `tool-approval-request`/`tool-output-*` etc. chunk carrying a given `toolCallId`, across a chunk sequence — most tool-lifecycle chunk variants share this field, letting a single lookup correlate them. */
function findByToolCallId(
  chunks: NimboChunk[],
  type: NimboChunk['type'],
  toolCallId: string,
): NimboChunk | undefined {
  return chunks.find(
    (chunk) =>
      chunk.type === type &&
      'toolCallId' in chunk &&
      chunk.toolCallId === toolCallId,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Same role as turn-runner.test.ts's own `flushMicrotasks` — draining a
 * `ControllableSession`'s wake/queue dance (promise-resolution-driven, no
 * timers) after a `pushChunk`, so a subsequent synchronous assertion (or DB
 * read) sees its effects landed.
 */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * Reads a `GET .../stream` response's body incrementally (not `.text()`,
 * which would block until the whole stream closes) — used by the tests that
 * need to interleave "push another event onto the fake session" with
 * "observe it having actually arrived over SSE", the same way a real client
 * would consume the tail live.
 *
 * The underlying `TransformStream` only relieves a pending `write()`'s
 * backpressure once *another* `read()` has already been issued on the
 * consumer side (verified in isolation: a write's `await` doesn't resolve
 * until the reader has requested the *next* chunk, not merely consumed the
 * current one) — so this keeps one background `read()` loop running
 * continuously, decoupled from whatever the test is doing, and `readUntil`/
 * `drainToClose` just poll that loop's buffer on a real timer (not a
 * same-microtask-chain wakeup, which races the loop's own continuation).
 */
function createIncrementalReader(response: Response) {
  if (response.body === null) throw new Error('response has no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let closed = false;

  void (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (value !== undefined)
        buffer += decoder.decode(value, { stream: true });
      if (done) {
        closed = true;
        return;
      }
    }
  })();

  return {
    async readUntil(
      predicate: (frames: ChatReplayFrame[]) => boolean,
      maxAttempts = 200,
    ): Promise<ChatReplayFrame[]> {
      for (let i = 0; i < maxAttempts; i += 1) {
        const frames = parseFrames(buffer);
        if (predicate(frames) || closed) return frames;
        await sleep(5);
      }
      throw new Error(
        `timed out waiting for expected frames; buffer so far: ${buffer}`,
      );
    },
    async drainToClose(maxAttempts = 200): Promise<ChatReplayFrame[]> {
      for (let i = 0; i < maxAttempts; i += 1) {
        if (closed) return parseFrames(buffer);
        await sleep(5);
      }
      throw new Error(`stream never closed; buffer so far: ${buffer}`);
    },
  };
}

const FRONTEND_DESIGN_SKILL_STUB = `---
description: Make one focused, non-generic visual/interaction improvement to an existing web UI without rewriting it.
---
# frontend-design (test stub)
`;

/**
 * Same fake workspace shape as helpers/fake-sandbox-manager.ts's
 * `buildFakeWorkspace()` (a `MemoryFS` pre-seeded with the frontend-design
 * skill stub, plus a trivial `NimboExec`), except `writeFile` pauses on a
 * manually-released gate — this is what lets the STEER-3B integration test
 * below hold a *real* `write-file` tool_call step open long enough to send a
 * second `POST .../messages` mid-turn, deterministically (no sleep/race).
 * Needed because that test exercises the real `@nimbo/core`/`@nimbo/sdk`
 * `Session.steer()` wiring (not a `ControllableSession` fake) — only a real
 * in-flight tool execution actually produces a real steered user message.
 */
function buildHoldableWorkspace(): {
  workspacePromise: Promise<NimboFS & NimboExec>;
  writeCalled: Promise<void>;
  releaseWrite: () => void;
} {
  let releaseWrite: () => void = () => undefined;
  const holdGate = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  let notifyWriteCalled: () => void = () => undefined;
  const writeCalled = new Promise<void>((resolve) => {
    notifyWriteCalled = resolve;
  });

  const workspacePromise = (async (): Promise<NimboFS & NimboExec> => {
    const fs = new MemoryFS();
    await fs.writeFile(
      '/.agents/skills/frontend-design/SKILL.md',
      FRONTEND_DESIGN_SKILL_STUB,
    );
    const originalWriteFile = fs.writeFile.bind(fs);
    const exec: NimboExec = {
      async exec() {
        return { exitCode: 0, stdout: '', stderr: '', durationMs: 0 };
      },
    };
    return Object.assign(fs, exec, {
      async writeFile(path: string, data: Uint8Array | string): Promise<void> {
        notifyWriteCalled();
        await holdGate;
        return originalWriteFile(path, data);
      },
    });
  })();

  return { workspacePromise, writeCalled, releaseWrite };
}

function createHoldableSandboxManager(): SandboxManager & {
  writeCalled: Promise<void>;
  releaseWrite: () => void;
  readonly touchCalls: string[];
} {
  const { workspacePromise, writeCalled, releaseWrite } =
    buildHoldableWorkspace();
  const touchCalls: string[] = [];
  return {
    writeCalled,
    releaseWrite,
    touchCalls,
    async acquire(input: AcquireInput): Promise<AcquiredSandbox> {
      return {
        workspace: await workspacePromise,
        defaultBranch: 'main',
        resumeToken: input.resumeToken ?? input.sandboxName,
        mode: 'resume',
      };
    },
    async ensureLifetime(conversationId: string): Promise<void> {
      touchCalls.push(conversationId);
    },
    release(): void {
      // no-op — 这个假件只关心 acquire() 的工作区与 ensureLifetime() 的调用记录。
    },
  };
}

/**
 * 一个 `SandboxManager`：第一次 `ensureLifetime()` 成功（让 `POST .../messages` 自己那次
 * acquire + 续期正常落地），之后每次都拒绝——用来验证 `POST .../approvals/:callId` 的
 * 「允许」分支会吞掉续期失败而不是让它挡住裁决（见 routes/chat.ts 该分支的注释）。
 */
function createSandboxManagerWithFailingTouchAfterFirst(): SandboxManager {
  const base = createFakeSandboxManager();
  let calls = 0;
  return {
    acquire: (input) => base.acquire(input),
    async ensureLifetime(conversationId: string): Promise<void> {
      calls += 1;
      if (calls === 1) {
        await base.ensureLifetime(conversationId);
        return;
      }
      throw new Error('sandbox temporarily unavailable');
    },
    release: (conversationId: string) => {
      base.release(conversationId);
    },
  };
}

describe('routes/chat: sessions + turn start/stream endpoints', () => {
  const USER_ID = 'user-1';
  let db: Db;
  let sandboxManager: FakeSandboxManager;

  beforeEach(() => {
    vi.stubEnv('GITHUB_REPO', 'git@github.com:acme/demo.git');
    vi.stubEnv('GITHUB_PAT', 'test-pat');
    db = createTestDb();
    seedUser(db, USER_ID);
    sandboxManager = createFakeSandboxManager();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function buildApp(
    resolveModel: () => ReturnType<typeof stopOnlyModel>,
    userId: string = USER_ID,
  ) {
    return createChatApp({
      db,
      sandboxManager,
      resolveModel,
      authMiddleware: fakeAuthMiddleware(userId),
    });
  }

  async function createSession(
    app: ReturnType<typeof buildApp>,
  ): Promise<ConversationDto> {
    const response = await app.request('/api/chat/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    return ConversationSchema.parse(await response.json());
  }

  async function createE2bSession(
    app: ReturnType<typeof buildApp>,
  ): Promise<ConversationDto> {
    const response = await app.request('/api/chat/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'e2b' }),
    });
    return ConversationSchema.parse(await response.json());
  }

  it('POST /api/chat/conversations provisions a sandbox (via acquire) and persists a conversations row with a null nimbo header (never turned yet)', async () => {
    const app = buildApp(() => stopOnlyModel('hi'));

    const response = await app.request('/api/chat/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'My session' }),
    });
    expect(response.status).toBe(201);
    const created = ConversationSchema.parse(await response.json());
    expect(created.title).toBe('My session');
    expect(created.repo).toBe('acme/demo');
    expect(created.status).toBe('active');
    expect(created.branchName).toContain(created.id);
    expect(created.sandboxName).toContain(created.id);

    expect(sandboxManager.acquireCalls).toHaveLength(1);
    expect(sandboxManager.acquireCalls[0]?.repoCloneUrl).toBe(
      'https://github.com/acme/demo.git',
    );

    const row = getConversation(db, created.id, USER_ID);
    expect(row).toBeDefined();
    expect(row?.agentSessionId).toBeNull();
    expect(row?.agentSessionCreatedAt).toBeNull();
    expect(row?.agentSessionTurn).toBeNull();
  });

  it('POST /api/chat/conversations defaults provider to vercel (no SANDBOX_PROVIDER) and carries it through acquire + DTO; no sandboxId stored', async () => {
    const app = buildApp(() => stopOnlyModel('hi'));

    const created = await createSession(app);

    expect(created.provider).toBe('vercel');
    expect(sandboxManager.acquireCalls[0]?.provider).toBe('vercel');
    // Vercel resumes by its stable name, so first acquire still carries the name as the resume token.
    expect(sandboxManager.acquireCalls[0]?.resumeToken).toBe(
      created.sandboxName,
    );

    const row = getConversation(db, created.id, USER_ID);
    expect(row?.provider).toBe('vercel');
    expect(row?.sandboxId).toBeNull(); // Vercel has no sandboxId — it resumes by name
  });

  it('POST /api/chat/conversations honors provider:"e2b": acquires with no prior resume token and persists the E2B sandboxId', async () => {
    const app = buildApp(() => stopOnlyModel('hi'));

    const response = await app.request('/api/chat/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'e2b' }),
    });
    expect(response.status).toBe(201);
    const created = ConversationSchema.parse(await response.json());
    expect(created.provider).toBe('e2b');

    const acq = sandboxManager.acquireCalls[0];
    expect(acq?.provider).toBe('e2b');
    expect(acq?.resumeToken).toBeUndefined(); // brand-new E2B conversation → straight to create, no id yet

    const row = getConversation(db, created.id, USER_ID);
    expect(row?.provider).toBe('e2b');
    // The fake acquire returns the sandbox name as the resume token; the route persists it as the E2B sandboxId.
    expect(row?.sandboxId).toBe(row?.sandboxName);
  });

  it('POST /api/chat/conversations defaults the title and 500s when GITHUB_REPO is unset', async () => {
    const app = buildApp(() => stopOnlyModel('hi'));
    const noTitleResponse = await app.request('/api/chat/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(noTitleResponse.status).toBe(201);
    expect(ConversationSchema.parse(await noTitleResponse.json()).title).toBe(
      'New chat',
    );

    vi.unstubAllEnvs();
    vi.stubEnv('GITHUB_PAT', 'test-pat'); // GITHUB_REPO deliberately left unset
    const response = await app.request('/api/chat/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(500);
  });

  // -------------------------------------------------------------------------
  // E2B resumeToken rebuild persistence (docs/tech/sandbox-provider.md §3.1,
  // §5 "E2B 令牌落库时机"): a resume-unavailable→re-create acquire mints a
  // *new* sandboxId; POST .../messages must rewrite it back to
  // `conversations.sandbox_id` so the next message resumes the right
  // sandbox. `sandboxManager.nextResumeToken` (fake-sandbox-manager.ts) lets
  // these tests force that exact acquire() outcome without a real/fake
  // `SandboxProvider`.
  // -------------------------------------------------------------------------

  describe('E2B resumeToken rebuild — POST .../messages persists a new sandbox_id (docs/tech/sandbox-provider.md §3.1)', () => {
    it('a rebuilt E2B sandbox (acquire() returns a resumeToken different from the stored one) is persisted back to conversations.sandbox_id', async () => {
      const app = buildApp(() => stopOnlyModel('hi'));
      const created = await createE2bSession(app);
      const tokenA = created.sandboxName;
      // First acquire (brand-new E2B conversation) had no prior resumeToken —
      // the fake echoed back sandboxName, which the route persisted as the
      // initial sandboxId (already asserted by the "honors provider:e2b" test
      // above; re-confirmed here as this test's own starting state).
      expect(getConversation(db, created.id, USER_ID)?.sandboxId).toBe(tokenA);

      // Force the *next* acquire (this message) to report a brand-new token —
      // simulating "resume(tokenA) unavailable → create() minted sbx_rebuilt".
      sandboxManager.nextResumeToken = 'sbx_rebuilt';

      const response = await app.request(
        `/api/chat/conversations/${created.id}/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: 'hi' }),
        },
      );
      expect(response.status).toBe(202);

      // acquire() was asked to resume the previously-persisted token...
      const messageAcquire = sandboxManager.acquireCalls.at(-1);
      expect(messageAcquire?.provider).toBe('e2b');
      expect(messageAcquire?.resumeToken).toBe(tokenA);

      // ...but the route persists whatever acquire() actually came back with.
      const row = getConversation(db, created.id, USER_ID);
      expect(row?.sandboxId).toBe('sbx_rebuilt');
    });

    it('a Vercel session never rewrites sandbox_id even when acquire() returns a different resumeToken — the rewrite is gated on provider === "e2b"', async () => {
      const app = buildApp(() => stopOnlyModel('hi'));
      const created = await createSession(app); // no provider → defaults to vercel
      expect(created.provider).toBe('vercel');
      expect(getConversation(db, created.id, USER_ID)?.sandboxId).toBeNull();

      // Same "different token" stimulus as the E2B test above — irrelevant
      // for Vercel, since the route only ever reads acquired.resumeToken for
      // an 'e2b' row.
      sandboxManager.nextResumeToken = 'some-other-name';

      const response = await app.request(
        `/api/chat/conversations/${created.id}/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: 'hi' }),
        },
      );
      expect(response.status).toBe(202);

      const row = getConversation(db, created.id, USER_ID);
      expect(row?.sandboxId).toBeNull(); // untouched
    });

    it('an E2B session whose resumeToken is unchanged issues no DB write for it (no-op — avoids a redundant updateConversation call)', async () => {
      const app = buildApp(() => stopOnlyModel('hi'));
      const created = await createE2bSession(app);
      const tokenA = created.sandboxName;
      expect(getConversation(db, created.id, USER_ID)?.sandboxId).toBe(tokenA);
      // sandboxManager.nextResumeToken deliberately left unset — the fake's
      // default acquire() echoes back the resumeToken it was handed, which
      // equals the stored sandboxId (tokenA): acquired.resumeToken ===
      // row.sandboxId, so routes/chat.ts's rewrite branch must not fire.

      // `conversations` has exactly one writer method on this `Db` instance
      // (store.ts's `updateConversation`, via `db.update`) — spying on it
      // catches *any* write, not just this specific patch. Checked
      // immediately after the POST's own promise resolves, before the
      // turn's background completion (finalizeTurnPersistence's own header
      // write) has had a chance to run — same ordering this file's other
      // tests rely on when they explicitly drain the stream first to
      // observe turn-completion writes (e.g. the "second message... resumes"
      // test above waits on `GET .../stream` before reading the row).
      const updateSpy = vi.spyOn(db, 'update');

      const response = await app.request(
        `/api/chat/conversations/${created.id}/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: 'hi' }),
        },
      );
      expect(response.status).toBe(202);
      expect(updateSpy).not.toHaveBeenCalled();

      const row = getConversation(db, created.id, USER_ID);
      expect(row?.sandboxId).toBe(tokenA); // unchanged

      updateSpy.mockRestore();
      // Drain the tail so the background turn doesn't leak past this test.
      await (
        await app.request(`/api/chat/conversations/${created.id}/stream`)
      ).text();
    });
  });

  it('GET /api/chat/conversations only lists the current user’s sessions; GET .../:id and .../events and .../stream 404 for another user’s session', async () => {
    const app = buildApp(() => stopOnlyModel('hi'));
    const created = await createSession(app);

    const listResponse = await app.request('/api/chat/conversations');
    expect(listResponse.status).toBe(200);
    const listBody = await listResponse.json();
    const list =
      Array.isArray(listBody) ?
        listBody.map((r) => ConversationSchema.parse(r))
      : [];
    expect(list.map((s) => s.id)).toEqual([created.id]);

    const otherUserApp = buildApp(() => stopOnlyModel('hi'), 'someone-else');
    expect(
      (await otherUserApp.request(`/api/chat/conversations/${created.id}`))
        .status,
    ).toBe(404);
    expect(
      (
        await otherUserApp.request(
          `/api/chat/conversations/${created.id}/events`,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await otherUserApp.request(
          `/api/chat/conversations/${created.id}/stream`,
        )
      ).status,
    ).toBe(404);
  });

  it('every route requires authMiddleware to set userId (401 short-circuits before touching the db/sandbox)', async () => {
    const app = createChatApp({
      db,
      sandboxManager,
      resolveModel: () => stopOnlyModel('hi'),
      authMiddleware: unauthorizedMiddleware,
    });
    const response = await app.request('/api/chat/conversations');
    expect(response.status).toBe(401);
    expect(sandboxManager.acquireCalls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // POST .../messages (docs/tech/chat-webapp.md §2.2b: starts a turn, 202, doesn't stream)
  // -------------------------------------------------------------------------

  it('POST .../messages starts a turn and returns 202 { ok: true, mode: "started" } immediately (no SSE body) when no turn is already in progress', async () => {
    const app = buildApp(() => stopOnlyModel('Hello there!'));
    const created = await createSession(app);

    const response = await app.request(
      `/api/chat/conversations/${created.id}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '你好' }),
      },
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, mode: 'started' });
  });

  it('POST .../messages 404s for an unknown session id', async () => {
    const app = buildApp(() => stopOnlyModel('hi'));
    const response = await app.request(
      '/api/chat/conversations/does-not-exist/messages',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      },
    );
    expect(response.status).toBe(404);
  });

  it('POST .../messages with intent "steer" 409s when the in-progress turn can’t actually be steered (its session has no steer capability) and the fallback start finds the slot still occupied', async () => {
    const app = buildApp(() => stopOnlyModel('hi'));
    const created = await createSession(app);

    // Occupy the turn slot directly (a fake that never finishes on its own)
    // instead of racing a real mock-model turn, which could complete before
    // the second POST below ever runs. `ControllableSession` deliberately has
    // no `steer` (turn-runner/session.ts's `TurnDrivenSession.steer` is optional), so
    // `steerTurn` returns false and the route falls back to starting a new
    // turn — which `startTurn`'s own guard then rejects. That fallback path is
    // the only way a 409 "turn already in progress" is still reachable now
    // that the default intent queues instead (docs/tech/steer-and-queue.md §4.1).
    const stuck = createControllableSession();
    const { started } = startTurn({
      db,
      conversationId: created.id,
      session: stuck,
      text: 'first',
      priorMessageCount: 0,
    });
    expect(started).toBe(true);

    const response = await app.request(
      `/api/chat/conversations/${created.id}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'second', intent: 'steer' }),
      },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'turn already in progress',
    });

    stuck.finish({ finalResponse: 'ok', usage: {} });
  });

  // -------------------------------------------------------------------------
  // GET .../stream (docs/tech/chat-webapp.md §2.2b: resumable live tail; docs/tech/single-ledger.md §5 单-3):
  // startTurn synthesizes+persists+broadcasts the turn-start user
  // MessageFrame synchronously, before it ever returns (this ticket's fix) —
  // a connection opened *after* startTurn already ran (every test/real usage
  // below) always sees that message via replay (its very first frame), then
  // the turn's subsequent chunks live, closing the instant the turn ends.
  // -------------------------------------------------------------------------

  it('GET .../stream replays the turn-start user MessageFrame first (already persisted+broadcast synchronously by startTurn, before this connection ever opened), then observes the live turn as a chunk feed — durable chunks carry seq, and the connection closes the instant the turn ends', async () => {
    const app = buildApp(() => stopOnlyModel('unused'));
    const created = await createSession(app);

    const fake = createControllableSession();
    const { started } = startTurn({
      db,
      conversationId: created.id,
      session: fake,
      text: '你好',
      priorMessageCount: 0,
    });
    expect(started).toBe(true);

    const response = await app.request(
      `/api/chat/conversations/${created.id}/stream`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const reader = createIncrementalReader(response);

    // The turn-start user MessageFrame already landed (persisted+broadcast
    // synchronously inside startTurn, above) — this connection only ever
    // sees it via replay, as its very first frame.
    const afterReplay = await reader.readUntil(
      (frames) => messageFrames(frames).length > 0,
    );
    expect(messageFrames(afterReplay)).toHaveLength(1);
    expect(messageFrames(afterReplay)[0]?.seq).toBe(1);
    expect(messageFrames(afterReplay)[0]?.message.role).toBe('user');
    expect(collectText(messageFrames(afterReplay)[0]?.message)).toBe('你好');

    fake.pushChunk({ type: 'start', messageId: 'm1' });
    await reader.readUntil((frames) =>
      chunksOnly(frames).some((c) => c.type === 'start'),
    );

    fake.pushChunk({ type: 'start-step' });
    await reader.readUntil((frames) =>
      chunksOnly(frames).some((c) => c.type === 'start-step'),
    );

    fake.setState({
      id: 'nimbo-sess-1',
      turn: 1,
      createdAt: 1000,
      messages: [],
    });
    fake.finish({ finalResponse: 'done streaming', usage: {} });
    const frames = await reader.drainToClose();

    expect(chunksOnly(frames).map((c) => c.type)).toEqual([
      'start',
      'start-step',
    ]);
    // seq 1 was the turn-start message; the chunks continue from seq 2.
    expect(chunkFrames(frames).map((f) => f.seq)).toEqual([2, 3]); // strictly monotonic, no gaps, no repeats
    expect(messageFrames(frames)).toHaveLength(1); // still just the turn-start message — finalize appended no further messages (state.messages was empty)
  });

  it('GET .../stream supports after=<seq> to skip the already-seen prefix of a still-in-progress turn’s replay', async () => {
    const app = buildApp(() => stopOnlyModel('unused'));
    const created = await createSession(app);

    const fake = createControllableSession();
    startTurn({
      db,
      conversationId: created.id,
      session: fake,
      text: 'hi',
      priorMessageCount: 0,
    });
    // seq 1: the turn-start user MessageFrame (persisted synchronously by
    // startTurn, above); seq 2: this chunk, still persisted (turn not
    // finished yet).
    fake.pushChunk({ type: 'start', messageId: 'm1' });
    await flushMicrotasks();

    const response = await app.request(
      `/api/chat/conversations/${created.id}/stream?after=2`,
    );
    const reader = createIncrementalReader(response);

    fake.setState({
      id: 'nimbo-sess-1',
      turn: 1,
      createdAt: 1000,
      messages: [],
    });
    fake.finish({ finalResponse: 'ok', usage: {} });
    const frames = await reader.drainToClose();

    // Both the message row (seq 1) and the chunk row (seq 2) are skipped by
    // after=2 — then the chunk row is GC'd on finish (empty message slice),
    // so there's nothing new past it besides live chunks that arrived after
    // this connection opened (none, in this test).
    expect(chunksOnly(frames)).toEqual([]);
    expect(messageFrames(frames)).toEqual([]);
  });

  it('GET .../stream closes immediately after replay when there is no turn in progress (fresh session, never messaged) — 它仍发两帧状态快照：待发队列 + 轮状态', async () => {
    const app = buildApp(() => stopOnlyModel('hi'));
    const created = await createSession(app);

    const response = await app.request(
      `/api/chat/conversations/${created.id}/stream`,
    );
    expect(response.status).toBe(200);
    // 两帧都是「每条连接回放后必发」的状态快照，**包括**没有进行中那一轮的这种
    // 「连上即关」的连接：
    //
    // - 队列快照（docs/tech/steer-and-queue.md §4.3 时机 1）——前端因此不必为「刚起的
    //   会话」单独查一次队列。空队列也照发（空≠不发）。
    // - [轮状态快照](docs/terms.md)（docs/tech/chat-webapp.md §5.1）——`turnActive: false`
    //   正是这条连接要告诉前端的关键事实：别再靠「回放最后一帧是不是 chunk」猜了。
    expect(await response.text()).toBe(
      'event: queue\ndata: {"queue":[]}\n\n' +
        'event: turn-state\ndata: {"turnActive":false}\n\n',
    );
  });

  // 崩溃残留的会话（docs/tech/chat-webapp.md §5.1）：账本最后一行是 chunk，但服务端
  // 那边**没有**轮在跑。这一条钉住的正是「前端不该再靠回放猜」——它靠这一帧知道真相。
  it('GET .../stream 对崩溃残留的会话报 turnActive:false——即便回放的最后一帧是 chunk', async () => {
    const app = buildApp(() => stopOnlyModel('unused'));
    const created = await createSession(app);

    // 模拟一轮崩溃：chunk 行留在账本里（`finalizeTurnPersistence` 从没跑，所以它们
    // 也从没被 GC），而 `activeTurns` 里什么都没有。
    const fake = createControllableSession();
    startTurn({
      db,
      conversationId: created.id,
      session: fake,
      text: '崩溃前发的',
      priorMessageCount: 0,
    });
    await flushMicrotasks();
    fake.pushChunk(startChunk('m1'));
    await flushMicrotasks();
    fake.fail(new Error('provider exploded')); // driveTurn 的 catch 分支：chunk 行不 GC
    await flushMicrotasks();

    const rows = listConversationEvents(db, created.id);
    expect(rows.at(-1)?.kind).toBe('chunk'); // 前提成立：最后一帧确实是 chunk
    expect(isTurnActive(created.id)).toBe(false); // 但服务端并没有轮在跑

    const response = await app.request(
      `/api/chat/conversations/${created.id}/stream`,
    );
    const frames = parseFrames(await response.text());
    expect(turnStateFrames(frames).at(-1)?.turnActive).toBe(false);
  });

  it('GET .../stream 在一轮真在跑时报 turnActive:true（另一个标签页起的轮，本端靠这一帧进入流式态）', async () => {
    const app = buildApp(() => stopOnlyModel('unused'));
    const created = await createSession(app);
    const fake = createControllableSession();
    startTurn({
      db,
      conversationId: created.id,
      session: fake,
      text: 'first',
      priorMessageCount: 0,
    });
    await flushMicrotasks();

    const response = await app.request(
      `/api/chat/conversations/${created.id}/stream`,
    );
    const reader = createIncrementalReader(response);
    const seen = await reader.readUntil(
      (frames) => turnStateFrames(frames).length > 0,
    );
    expect(turnStateFrames(seen).at(-1)?.turnActive).toBe(true);

    fake.finish({ finalResponse: '', usage: {} });
    await reader.drainToClose();
  });

  it('GET .../stream called while a turn is active replays the turn-start user MessageFrame (already persisted before the connection opened) plus the live chunk feed; a later GET .../stream (after the turn has finished) instead replays all its messages as MessageFrames, the now-GC’d chunk frames gone', async () => {
    const app = buildApp(() => stopOnlyModel('unused'));
    const created = await createSession(app);

    const fake = createControllableSession();
    startTurn({
      db,
      conversationId: created.id,
      session: fake,
      text: 'hi',
      priorMessageCount: 0,
    });

    // First call: opened *while the turn is still active* — startTurn
    // already ran (above), so this connection's own replay picks up the
    // turn-start user MessageFrame it missed live; its live tail then sees
    // the chunk, and closes once the turn ends.
    const first = await app.request(
      `/api/chat/conversations/${created.id}/stream`,
    );
    const reader = createIncrementalReader(first);
    fake.pushChunk({ type: 'start', messageId: 'm1' });
    await reader.readUntil((frames) =>
      chunksOnly(frames).some((c) => c.type === 'start'),
    );
    fake.setState({
      id: 'nimbo-sess-1',
      turn: 1,
      createdAt: 1000,
      messages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
        {
          id: 'm1',
          role: 'assistant',
          parts: [{ type: 'text', text: 'ok', state: 'done' }],
        },
      ],
    });
    fake.finish({ finalResponse: 'ok', usage: {} });
    const firstFrames = await reader.drainToClose();
    expect(chunksOnly(firstFrames).map((c) => c.type)).toEqual(['start']);
    expect(messageFrames(firstFrames)).toHaveLength(1);
    expect(messageFrames(firstFrames)[0]?.message.role).toBe('user');

    // Second call: a brand-new connection, opened only now that turn-runner
    // has finished — this is a pure replay, and the chunk row from above has
    // been GC'd, replaced by the finalized message rows (the turn-start user
    // message plus the assistant reply).
    const second = await app.request(
      `/api/chat/conversations/${created.id}/stream`,
    );
    const secondFrames = parseFrames(await second.text());
    expect(chunksOnly(secondFrames)).toEqual([]);
    expect(messagesOnly(secondFrames).map((m) => m.role)).toEqual([
      'user',
      'assistant',
    ]);
  });

  it('GET .../stream replays the turn-start user MessageFrame plus the turn-runner’s synthetic failed message-metadata chunk after an unexpected exception — the chunk is crash residue, never GC’d (finalizeTurnPersistence never ran, so it never got the chance); the conversations nimbo header stays untouched', async () => {
    const app = buildApp(() => stopOnlyModel('unused'));
    const created = await createSession(app);

    const fake = createControllableSession();
    startTurn({
      db,
      conversationId: created.id,
      session: fake,
      text: 'boom',
      priorMessageCount: 0,
    });
    fake.fail(new Error('provider exploded'));

    const response = await app.request(
      `/api/chat/conversations/${created.id}/stream`,
    );
    const frames = parseFrames(await response.text());
    expect(chunksOnly(frames)).toEqual([
      {
        type: 'message-metadata',
        messageMetadata: {
          turn: 1,
          usage: {},
          status: 'failed',
          error: { code: 'provider_error', message: 'provider exploded' },
        },
      },
    ]);
    // The turn-start user message survives the crash — driveTurn's catch
    // branch never runs finalizeTurnPersistence, so nothing GCs it.
    expect(messageFrames(frames)).toHaveLength(1);
    expect(messageFrames(frames)[0]?.message.role).toBe('user');
    expect(collectText(messageFrames(frames)[0]?.message)).toBe('boom');

    const row = getConversation(db, created.id, USER_ID);
    expect(row?.agentSessionId).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Durable/ephemeral split (docs/tech/single-ledger.md §5 单-3) — the stream route's own half
  // of `createEmitWire`'s split: the `replayDone` guard in `subscribeTurn`'s
  // callback (drop an ephemeral tick that arrives before the replay has
  // finished flushing) and `flushBuffered`'s no-`maxSentSeq` forwarding for
  // ephemeral frames once it has.
  // -------------------------------------------------------------------------

  describe('durable/ephemeral split — GET .../stream', () => {
    it('an ephemeral text-delta that arrives before the replay has finished flushing is dropped — it never reaches this connection’s SSE output', async () => {
      const app = buildApp(() => stopOnlyModel('unused'));
      const created = await createSession(app);

      const fake = createControllableSession();
      startTurn({
        db,
        conversationId: created.id,
        session: fake,
        text: 'hi',
        priorMessageCount: 0,
      });
      fake.pushChunk({ type: 'text-start', id: 't1' }); // seq 2 (seq 1 is the turn-start user message, persisted synchronously by startTurn above)
      await flushMicrotasks();
      // A second already-persisted durable row (so the replay loop below has
      // to write *multiple* times — the underlying TransformStream's default
      // queuing strategy lets exactly one write buffer without a reader
      // present, so a single-row replay would already be "done" by the time
      // this test gets to push the ephemeral tick below; several rows is
      // what actually exercises the backpressure window).
      fake.pushChunk({ type: 'reasoning-start', id: 'r1' }); // seq 3
      await flushMicrotasks();
      expect(
        listConversationEvents(db, created.id).map((row) =>
          row.kind === 'message' ?
            'message'
          : (JSON.parse(row.payloadJson) as { type?: string }).type,
        ),
      ).toEqual(['message', 'text-start', 'reasoning-start']);

      // Open the stream but deliberately don't read its body yet. The route's
      // replay loop writes each persisted row via `stream.writeSSE()`, which
      // is backed by a `TransformStream` whose default queuing strategy means
      // a `write()` doesn't resolve until *some* `read()` has been issued on
      // the consumer side (verified empirically for this exact helper stack —
      // see `createIncrementalReader`'s own doc comment above). So at this
      // point `subscribeTurn` has already registered (it runs synchronously,
      // before the replay loop's first `await`), but the replay loop itself —
      // and therefore `replayDone` — is still stuck partway through its two
      // persisted-row writes.
      const response = await app.request(
        `/api/chat/conversations/${created.id}/stream`,
      );

      // This lands squarely in that window: the route's subscribeTurn
      // callback runs synchronously off this emit, sees `replayDone` still
      // false, and drops it before it's ever buffered.
      fake.pushChunk({
        type: 'text-delta',
        id: 't1',
        delta: 'stale half-typed text',
      });
      await flushMicrotasks();

      // Now actually drain the response — this is what relieves the
      // backpressure and lets the replay (and then the live tail) proceed.
      const reader = createIncrementalReader(response);
      fake.pushChunk({ type: 'text-end', id: 't1' }); // seq 4
      await reader.readUntil((frames) =>
        chunksOnly(frames).some((c) => c.type === 'text-end'),
      );
      fake.setState({
        id: 'nimbo-sess-1',
        turn: 1,
        createdAt: 1000,
        messages: [],
      });
      fake.finish({ finalResponse: 'done', usage: {} });
      const frames = await reader.drainToClose();

      expect(chunksOnly(frames).some((c) => c.type === 'text-delta')).toBe(
        false,
      );
      expect(chunksOnly(frames).map((c) => c.type)).toEqual([
        'text-start',
        'reasoning-start',
        'text-end',
      ]);
      expect(messageFrames(frames)).toHaveLength(1); // the turn-start message, replayed first
      expect(chunkFrames(frames).map((f) => f.seq)).toEqual([2, 3, 4]);
    });

    it('a live-phase ephemeral text-delta (after the replay has fully flushed) is forwarded with no `seq` field, and the surrounding durable frames still dedupe correctly — the ephemeral frame never bumps maxSentSeq', async () => {
      const app = buildApp(() => stopOnlyModel('unused'));
      const created = await createSession(app);

      const fake = createControllableSession();
      startTurn({
        db,
        conversationId: created.id,
        session: fake,
        text: 'hi',
        priorMessageCount: 0,
      });
      fake.pushChunk({ type: 'text-start', id: 't1' }); // seq 2 (seq 1 is the turn-start user message)

      const response = await app.request(
        `/api/chat/conversations/${created.id}/stream`,
      );
      const reader = createIncrementalReader(response);
      await reader.readUntil((frames) =>
        chunksOnly(frames).some((c) => c.type === 'text-start'),
      );
      // The single persisted row has now been flushed and acknowledged by the
      // reader above — `replayDone` is true and the route is in its live-wait
      // loop from here on.

      fake.pushChunk({ type: 'text-delta', id: 't1', delta: 'typing...' });
      const afterDelta = await reader.readUntil((frames) =>
        chunksOnly(frames).some((c) => c.type === 'text-delta'),
      );
      const deltaFrame = chunkFrames(afterDelta).find(
        (f) => f.chunk.type === 'text-delta',
      );
      expect(deltaFrame).toBeDefined();
      expect(deltaFrame !== undefined && 'seq' in deltaFrame).toBe(false);

      fake.pushChunk({ type: 'text-end', id: 't1' }); // seq 3
      await reader.readUntil((frames) =>
        chunksOnly(frames).some((c) => c.type === 'text-end'),
      );

      fake.setState({
        id: 'nimbo-sess-1',
        turn: 1,
        createdAt: 1000,
        messages: [],
      });
      fake.finish({ finalResponse: 'done', usage: {} });
      const frames = await reader.drainToClose();

      expect(chunksOnly(frames).map((c) => c.type)).toEqual([
        'text-start',
        'text-delta',
        'text-end',
      ]);
      const durableFrames = chunkFrames(frames).filter(
        (f) => f.chunk.type !== 'text-delta',
      );
      expect(durableFrames.map((f) => f.seq)).toEqual([2, 3]); // no gaps/dups
    });
  });

  // -------------------------------------------------------------------------
  // End-to-end (real mock model) — POST to start, GET .../stream to observe
  // the live chunk feed, GET .../events (post-hoc) to observe the finished
  // messages.
  // -------------------------------------------------------------------------

  it('POST + GET .../stream end-to-end: the live tail is a pure durable-chunk sequence (start…finish…message-metadata), monotonically seq’d, ephemeral text-delta unseq’d; GET .../events afterward replays the finished user+assistant messages instead', async () => {
    const app = buildApp(() => stopOnlyModel('Hello there!'));
    const created = await createSession(app);

    const postResponse = await app.request(
      `/api/chat/conversations/${created.id}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '你好' }),
      },
    );
    expect(postResponse.status).toBe(202);

    const streamResponse = await app.request(
      `/api/chat/conversations/${created.id}/stream`,
    );
    const frames = parseFrames(await streamResponse.text());
    const chunks = chunksOnly(frames);
    const types = chunks.map((c) => c.type);

    expect(types).toEqual([
      'start',
      'start-step',
      'text-start',
      'text-delta',
      'text-end',
      'finish-step',
      'finish',
      'message-metadata',
    ]);
    const last = chunks.at(-1);
    expect(
      last?.type === 'message-metadata' ?
        last.messageMetadata.status
      : undefined,
    ).toBe('completed');

    // This connection's very first frame is the turn-start user MessageFrame
    // (POST .../messages already ran startTurn, which persisted+broadcast it
    // synchronously before ever returning the 202 — this GET call only ever
    // catches it via replay).
    expect(messageFrames(frames)).toHaveLength(1);
    expect(messageFrames(frames)[0]?.seq).toBe(1);

    // durable frames carry a strictly-increasing seq (continuing from seq 2,
    // past the turn-start message's own seq 1); the ephemeral text-delta
    // carries none.
    const durable = chunkFrames(frames).filter(
      (f) => f.chunk.type !== 'text-delta',
    );
    expect(durable.map((f) => f.seq)).toEqual(durable.map((_, i) => i + 2));
    const deltaFrame = chunkFrames(frames).find(
      (f) => f.chunk.type === 'text-delta',
    );
    expect(deltaFrame !== undefined && 'seq' in deltaFrame).toBe(false);

    // acquire() ran twice total (session creation + this message), touch() once.
    expect(sandboxManager.acquireCalls).toHaveLength(2);
    expect(sandboxManager.ensureLifetimeCalls).toEqual([created.id]);

    // Now GET .../events (post-hoc): the durable chunk rows this turn wrote
    // have all been GC'd, replaced by 2 message rows.
    const eventsResponse = await app.request(
      `/api/chat/conversations/${created.id}/events`,
    );
    const replay = ConversationEventsListSchema.parse(
      await eventsResponse.json(),
    );
    const messages = messagesOnly(replay.frames);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(collectText(messages[0])).toBe('你好');
    expect(collectText(messages[1])).toBe('Hello there!');

    const row = getConversation(db, created.id, USER_ID);
    expect(row?.agentSessionId).not.toBeNull();
    expect(row?.agentSessionTurn).toBe(1);
  });

  it('GET .../events replays exactly what was persisted (message rows, post-hoc), and supports after= to page from a given seq', async () => {
    const app = buildApp(() => stopOnlyModel('ok'));
    const created = await createSession(app);

    await app.request(`/api/chat/conversations/${created.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    // Drain the tail to make sure the turn has actually finished landing rows
    // before the assertions below run.
    await (
      await app.request(`/api/chat/conversations/${created.id}/stream`)
    ).text();

    const allEventsResponse = await app.request(
      `/api/chat/conversations/${created.id}/events`,
    );
    expect(allEventsResponse.status).toBe(200);
    const all = ConversationEventsListSchema.parse(
      await allEventsResponse.json(),
    ).frames;
    expect(all.length).toBe(2);
    expect(chunkFrames(all)).toEqual([]); // both this turn's chunk rows were GC'd — only message rows remain
    expect(messagesOnly(all)[0]?.role).toBe('user');

    const afterSeq = messageFrames(all)[0]?.seq;
    expect(afterSeq).toBeDefined();

    const afterResponse = await app.request(
      `/api/chat/conversations/${created.id}/events?after=${String(afterSeq)}`,
    );
    const after = ConversationEventsListSchema.parse(
      await afterResponse.json(),
    ).frames;
    expect(after).toEqual(all.slice(1));
  });

  it('a second message on the same session resumes message history (turn increments, prior messages retained)', async () => {
    const app = buildApp(() => stopOnlyModel('reply'));
    const created = await createSession(app);

    await app.request(`/api/chat/conversations/${created.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'first' }),
    });
    await (
      await app.request(`/api/chat/conversations/${created.id}/stream`)
    ).text();
    const firstRow = getConversation(db, created.id, USER_ID);
    const firstMessageCount = listConversationEvents(db, created.id).filter(
      (r) => r.kind === 'message',
    ).length;

    await app.request(`/api/chat/conversations/${created.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'second' }),
    });
    await (
      await app.request(`/api/chat/conversations/${created.id}/stream`)
    ).text();
    const secondRow = getConversation(db, created.id, USER_ID);
    const secondMessageCount = listConversationEvents(db, created.id).filter(
      (r) => r.kind === 'message',
    ).length;

    expect(secondRow?.agentSessionTurn).toBe(
      (firstRow?.agentSessionTurn ?? 0) + 1,
    );
    expect(secondMessageCount).toBeGreaterThan(firstMessageCount);

    const persisted = listConversationEvents(db, created.id);
    expect(persisted.every((r) => r.kind === 'message')).toBe(true); // both turns' chunk rows are GC'd
  });

  it('a first turn that CRASHED (user message row persisted, nimbo header never written) still resumes its user message into the next turn’s model context — UI and model agree, no "user sees it but agent forgot it" split (loadResumeState regression)', async () => {
    // Turn 1 crashes: drive a controllable session straight through
    // turn-runner and fail it — the turn-start 'boom' user message lands as a
    // `kind='message'` row, but `finalizeTurnPersistence` never runs so the
    // `agent_session_id` header stays null (the exact state the old
    // `agentSessionId === null` short-circuit dropped from resume).
    const { model, captured } = capturingModel('reply');
    const app = buildApp(() => model);
    const created = await createSession(app);

    const fake = createControllableSession();
    startTurn({
      db,
      conversationId: created.id,
      session: fake,
      text: 'boom',
      priorMessageCount: 0,
    });
    fake.fail(new Error('provider exploded'));
    await (
      await app.request(`/api/chat/conversations/${created.id}/stream`)
    ).text();

    const crashedRow = getConversation(db, created.id, USER_ID);
    expect(crashedRow?.agentSessionId).toBeNull(); // header never written
    expect(
      listConversationEvents(db, created.id).filter(
        (r) => r.kind === 'message',
      ),
    ).toHaveLength(1); // but the crashed user message is persisted

    // Turn 2 runs a real turn through the route — its model must have been
    // handed the crashed 'boom' message as prior context.
    await app.request(`/api/chat/conversations/${created.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'second' }),
    });
    await (
      await app.request(`/api/chat/conversations/${created.id}/stream`)
    ).text();

    expect(captured.length).toBeGreaterThan(0);
    const promptText = JSON.stringify(captured[0]);
    expect(promptText).toContain('boom'); // model saw the crashed turn's request
    expect(promptText).toContain('second');
  });

  it('after two sequential turns, GET .../events replays [user, assistant, user, assistant] in strict send order, with seq strictly increasing throughout (no reordering, no duplicates — numeric gaps from GC’d chunk rows are expected and fine)', async () => {
    const app = buildApp(() => stopOnlyModel('reply'));
    const created = await createSession(app);

    await app.request(`/api/chat/conversations/${created.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'first' }),
    });
    await (
      await app.request(`/api/chat/conversations/${created.id}/stream`)
    ).text();

    await app.request(`/api/chat/conversations/${created.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'second' }),
    });
    await (
      await app.request(`/api/chat/conversations/${created.id}/stream`)
    ).text();

    const eventsResponse = await app.request(
      `/api/chat/conversations/${created.id}/events`,
    );
    const replay = ConversationEventsListSchema.parse(
      await eventsResponse.json(),
    );
    expect(chunkFrames(replay.frames)).toEqual([]); // both turns' chunk rows are fully GC'd

    const messages = messagesOnly(replay.frames);
    expect(messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(collectText(messages[0])).toBe('first');
    expect(collectText(messages[1])).toBe('reply');
    expect(collectText(messages[2])).toBe('second');
    expect(collectText(messages[3])).toBe('reply');

    const seqs = messageFrames(replay.frames).map((f) => f.seq);
    expect(seqs).toHaveLength(4);
    expect(seqs.every((s, i) => i === 0 || s > (seqs[i - 1] ?? 0))).toBe(true); // strictly increasing send order, no gaps in delivery (even though the underlying integers skip over GC'd chunk seqs)
  });

  it('a turn with a tool call streams tool-input-available → tool-output-available (plus data-file-change) on the live tail, and both the tool_call and file-change data part show up on the finished assistant message', async () => {
    const app = buildApp(() =>
      toolCallThenStopModel(
        'write-file',
        { path: '/notes.txt', content: 'hi' },
        'call_1',
        'wrote it',
      ),
    );
    const created = await createSession(app);

    await app.request(`/api/chat/conversations/${created.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'write a file' }),
    });
    const body = await (
      await app.request(`/api/chat/conversations/${created.id}/stream`)
    ).text();
    const frames = parseFrames(body);
    const chunks = chunksOnly(frames);

    expect(
      findByToolCallId(chunks, 'tool-input-available', 'call_1'),
    ).toBeDefined();
    expect(
      findByToolCallId(chunks, 'tool-output-available', 'call_1'),
    ).toBeDefined();
    expect(chunks.some((c) => c.type === 'data-file-change')).toBe(true);

    const eventsResponse = await app.request(
      `/api/chat/conversations/${created.id}/events`,
    );
    const replay = ConversationEventsListSchema.parse(
      await eventsResponse.json(),
    );
    const assistantMessage = messagesOnly(replay.frames).find(
      (m) => m.role === 'assistant',
    );
    expect(assistantMessage).toBeDefined();
    const toolPart =
      assistantMessage !== undefined ?
        allToolParts([assistantMessage]).find(
          (part) => part.type === 'tool-write-file',
        )
      : undefined;
    expect(toolPart?.state).toBe('output-available');
  });

  // -------------------------------------------------------------------------
  // STEER-3B: POST .../messages while a turn is in progress steers it
  // instead of starting a new one. Real mock model + real @nimbo/sdk
  // session (not a ControllableSession fake) — a real `write-file` tool_call
  // step is held open (buildHoldableWorkspace) so the second POST lands
  // squarely mid-turn, exercising the actual Session.steer() wiring
  // (packages/core/test/steer.test.ts already covers that wiring in
  // isolation; this is the end-to-end route regression for it).
  // -------------------------------------------------------------------------

  it('a second POST with intent "steer" while a turn is in progress steers it (202 mode "steered"): the steered text streams as its own start(steered:true)…finish sequence, and both messages persist correctly once the turn ends', async () => {
    const holdableSandboxManager = createHoldableSandboxManager();
    const app = createChatApp({
      db,
      sandboxManager: holdableSandboxManager,
      resolveModel: () =>
        toolCallThenStopModel(
          'write-file',
          { path: '/notes.txt', content: 'hi' },
          'call_1',
          'wrote it and replied',
        ),
      authMiddleware: fakeAuthMiddleware(USER_ID),
    });
    const created = await createSession(app);

    const firstResponse = await app.request(
      `/api/chat/conversations/${created.id}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'explore the repo' }),
      },
    );
    expect(firstResponse.status).toBe(202);
    expect(await firstResponse.json()).toEqual({ ok: true, mode: 'started' });

    // Deterministic hold point: the real write-file tool call is now paused
    // inside fs.writeFile() — nothing time-based, no sleep/race.
    await holdableSandboxManager.writeCalled;

    // `intent: 'steer'` 是**显式**的——默认（省略 intent）现在是排队到下一轮
    // （docs/tech/steer-and-queue.md §4.1），排队路径的覆盖见本文件的队列用例组。
    const secondResponse = await app.request(
      `/api/chat/conversations/${created.id}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: 'also check the API timeout',
          intent: 'steer',
        }),
      },
    );
    expect(secondResponse.status).toBe(202);
    expect(await secondResponse.json()).toEqual({ ok: true, mode: 'steered' });

    holdableSandboxManager.releaseWrite();

    const body = await (
      await app.request(`/api/chat/conversations/${created.id}/stream`)
    ).text();
    const chunks = chunksOnly(parseFrames(body));

    // The steered message's own start/text/finish sequence, distinguishable
    // by messageMetadata.steered (loop.ts's drainSteerMessages) — this GET
    // .../stream call typically lands late enough (several real async hops
    // after releaseWrite()) that it only ever *replays* this bracket from
    // already-persisted durable rows; the steered text's own text-delta is
    // ephemeral (never persisted, live-only, docs/tech/single-ledger.md §5 单-3) and — by the
    // same "只直播不落盘" design P13-1 already established — is simply gone
    // for a connection that wasn't listening live at the moment it streamed.
    // The bracket (start…text-start…text-end…finish) still proves the loop
    // treated it as a steer injection rather than silently dropping it; the
    // actual *content* is verified below via the durable, replay-safe
    // GET .../events (the finished NimboUIMessage's own `parts`).
    const steeredStartIndex = chunks.findIndex(
      (c) => c.type === 'start' && c.messageMetadata?.steered === true,
    );
    expect(steeredStartIndex).toBeGreaterThanOrEqual(0);

    // Both requests still rolled the sandbox's idle timeout forward — the
    // steered branch calls touch() too (routes/chat.ts), not just the
    // normal-start branch.
    expect(holdableSandboxManager.touchCalls).toEqual([created.id, created.id]);

    const eventsResponse = await app.request(
      `/api/chat/conversations/${created.id}/events`,
    );
    const replay = ConversationEventsListSchema.parse(
      await eventsResponse.json(),
    );
    const messages = messagesOnly(replay.frames);
    const userMessages = messages.filter((m) => m.role === 'user');
    expect(userMessages).toHaveLength(2);
    expect(collectText(userMessages[0])).toBe('explore the repo');
    expect(collectText(userMessages[1])).toBe('also check the API timeout');
    expect(userMessages[1]?.metadata?.steered).toBe(true);
    expect(userMessages[0]?.metadata?.steered).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Approval chain + ask-user (docs/tech/chat-webapp.md §2.2c（审批链）, docs/tech/single-ledger.md §6) —
  // end-to-end through the real routes, a mock model driving a bash/ask-user
  // tool call, and the in-process turn-runner bridge (no fakes for any of
  // that machinery, only the sandbox/model are mocked, same as the rest of
  // this file). `tool-approval-request` carries only `approvalId`/`toolCallId`
  // (no toolName/input, unlike the retired `approval.requested` event) — a
  // real client correlates it against the earlier `tool-input-available`
  // chunk sharing the same `toolCallId`; these tests use the mock model's
  // fixed `toolCallId` ('call_1') directly, same as a client that already
  // tracked it from that earlier chunk.
  // -------------------------------------------------------------------------

  describe('approval chain + ask-user (docs/tech/single-ledger.md §6)', () => {
    it('a safe bash command under the default (dangerous) approval mode runs straight through — no tool-approval-request/-response chunk is ever emitted', async () => {
      const app = buildApp(() =>
        toolCallThenStopModel(
          'bash',
          { command: 'ls -la' },
          'call_1',
          'listed it',
        ),
      );
      const created = await createSession(app);

      await app.request(`/api/chat/conversations/${created.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'list files' }),
      });
      const body = await (
        await app.request(`/api/chat/conversations/${created.id}/stream`)
      ).text();
      const chunks = chunksOnly(parseFrames(body));

      expect(chunks.some((c) => c.type === 'tool-approval-request')).toBe(
        false,
      );
      expect(chunks.some((c) => c.type === 'tool-approval-response')).toBe(
        false,
      );
      expect(chunks.at(-1)?.type).toBe('message-metadata');
      expect(
        findByToolCallId(chunks, 'tool-output-available', 'call_1'),
      ).toBeDefined();
    });

    it('a dangerous bash command escalates to a human: tool-approval-request appears on the live tail; allow lets the turn continue through to a completed message-metadata', async () => {
      const app = buildApp(() =>
        toolCallThenStopModel(
          'bash',
          { command: 'git push origin main' },
          'call_1',
          'pushed it',
        ),
      );
      const created = await createSession(app);

      await app.request(`/api/chat/conversations/${created.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'push my branch' }),
      });

      const streamResponse = await app.request(
        `/api/chat/conversations/${created.id}/stream`,
      );
      const reader = createIncrementalReader(streamResponse);
      const requested = await reader.readUntil((frames) =>
        chunksOnly(frames).some((c) => c.type === 'tool-approval-request'),
      );
      const requestChunk = chunksOnly(requested).find(
        (c) => c.type === 'tool-approval-request',
      );
      expect(
        requestChunk?.type === 'tool-approval-request' ?
          requestChunk.approvalId
        : undefined,
      ).toBe('call_1');

      const approveResponse = await app.request(
        `/api/chat/conversations/${created.id}/approvals/call_1`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ behavior: 'allow' }),
        },
      );
      expect(approveResponse.status).toBe(200);
      expect(await approveResponse.json()).toEqual({ ok: true });

      const frames = await reader.drainToClose();
      const chunks = chunksOnly(frames);
      const responseChunk = chunks.find(
        (c) => c.type === 'tool-approval-response',
      );
      expect(responseChunk).toEqual({
        type: 'tool-approval-response',
        approvalId: 'call_1',
        approved: true,
      });
      expect(chunks.at(-1)?.type).toBe('message-metadata');
      expect(
        findByToolCallId(chunks, 'tool-output-available', 'call_1'),
      ).toBeDefined();
    });

    it('allow-session 记会话级授权：批准后同一会话内完全相同的调用直接放行，第二轮不再出 tool-approval-request（docs/terms.md §四）', async () => {
      // 每轮发同一条危险命令；toolCallId 逐轮不同（call_1 / call_2）。
      let turn = 0;
      const app = buildApp(() => {
        turn += 1;
        return toolCallThenStopModel(
          'bash',
          { command: 'git push origin main' },
          `call_${String(turn)}`,
          'pushed',
        );
      });
      const created = await createSession(app);

      // ---- 第 1 轮：危险 bash → 弹审批 → allow-session ----
      await app.request(`/api/chat/conversations/${created.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'push my branch' }),
      });
      const stream1 = await app.request(
        `/api/chat/conversations/${created.id}/stream`,
      );
      const reader1 = createIncrementalReader(stream1);
      await reader1.readUntil((frames) =>
        chunksOnly(frames).some((c) => c.type === 'tool-approval-request'),
      );
      const grantResponse = await app.request(
        `/api/chat/conversations/${created.id}/approvals/call_1`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ behavior: 'allow-session' }),
        },
      );
      expect(grantResponse.status).toBe(200);
      await reader1.drainToClose(); // 第 1 轮跑完

      // ---- 第 2 轮：完全相同的命令 → 直接放行、不再弹审批 ----
      await app.request(`/api/chat/conversations/${created.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'push again' }),
      });
      const stream2 = await app.request(
        `/api/chat/conversations/${created.id}/stream`,
      );
      const chunks2 = chunksOnly(parseFrames(await stream2.text()));
      // 会话级授权命中 → onApproval 短路成 allow → 全程无审批请求/响应。
      expect(chunks2.some((c) => c.type === 'tool-approval-request')).toBe(
        false,
      );
      expect(chunks2.some((c) => c.type === 'tool-approval-response')).toBe(
        false,
      );
      // 工具照常执行到有输出（call_2 是第 2 轮的调用）。
      expect(
        findByToolCallId(chunks2, 'tool-output-available', 'call_2'),
      ).toBeDefined();
    });

    it('一轮跑完只在起轮时补一次存活时长——轮内保活归适配器了（docs/tech/sandbox-keepalive.md）', async () => {
      const app = buildApp(() => stopOnlyModel('done'));
      const created = await createSession(app);
      const before = sandboxManager.ensureLifetimeCalls.length;

      await app.request(`/api/chat/conversations/${created.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      });
      const stream = await app.request(
        `/api/chat/conversations/${created.id}/stream`,
      );
      await stream.text(); // 直播流关闭 = 这一轮收尾完毕

      // 起轮那一次仍在（轮真正开跑前那段归宿主）；轮内的续期不再经过 manager，
      // 由 e2bWorkspace/vercelWorkspace 自己按活动信号与 exec 状态做。
      const calls = sandboxManager.ensureLifetimeCalls.slice(before);
      expect(calls).toEqual([created.id]);
    });

    it('分段授权：allow-session 一条复合命令后，「其中一段」直接放行，「含新段」仍弹审批（docs/features/approval-grant-split.md）', async () => {
      // 三轮各发一条命令：授权复合命令 → 只发其中一段 → 发含新段的命令。
      const commands = [
        'cd /home/user/repo && git push origin main',
        'git push origin main', // 段是第 1 轮的子集 → 应直接放行
        'cd /home/user/repo && git push origin main && rm -rf /tmp/scratch', // 多一段没批过的
      ];
      let turn = 0;
      const app = buildApp(() => {
        const command = commands[turn] ?? '';
        turn += 1;
        return toolCallThenStopModel(
          'bash',
          { command },
          `call_${String(turn)}`,
          'ok',
        );
      });
      const created = await createSession(app);

      const runTurn = async (text: string): Promise<void> => {
        await app.request(`/api/chat/conversations/${created.id}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        });
      };

      // ---- 第 1 轮：复合危险命令 → 弹审批 → allow-session（记两段）----
      await runTurn('push my branch');
      const stream1 = await app.request(
        `/api/chat/conversations/${created.id}/stream`,
      );
      const reader1 = createIncrementalReader(stream1);
      await reader1.readUntil((frames) =>
        chunksOnly(frames).some((c) => c.type === 'tool-approval-request'),
      );
      const grantResponse = await app.request(
        `/api/chat/conversations/${created.id}/approvals/call_1`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ behavior: 'allow-session' }),
        },
      );
      expect(grantResponse.status).toBe(200);
      await reader1.drainToClose();

      // ---- 第 2 轮：只发其中一段 → 段已记过 → 不弹审批 ----
      // 注意 `git push` 本身在危险清单里：这里能直接跑，靠的正是分段授权命中
      // 短路了危险命令分类（整串指纹时代这条命令与第 1 轮指纹不同，会重新弹卡片）。
      await runTurn('push again');
      const stream2 = await app.request(
        `/api/chat/conversations/${created.id}/stream`,
      );
      const chunks2 = chunksOnly(parseFrames(await stream2.text()));
      expect(chunks2.some((c) => c.type === 'tool-approval-request')).toBe(
        false,
      );
      expect(
        findByToolCallId(chunks2, 'tool-output-available', 'call_2'),
      ).toBeDefined();

      // ---- 第 3 轮：含一段没批过的 → 仍然弹审批 ----
      await runTurn('cleanup and push');
      const stream3 = await app.request(
        `/api/chat/conversations/${created.id}/stream`,
      );
      const reader3 = createIncrementalReader(stream3);
      await reader3.readUntil((frames) =>
        chunksOnly(frames).some((c) => c.type === 'tool-approval-request'),
      );
      await app.request(
        `/api/chat/conversations/${created.id}/approvals/call_3`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ behavior: 'deny' }),
        },
      );
      await reader3.drainToClose();
    });

    it('a dangerous bash command escalates to a human: deny resolves tool-approval-response(approved:false) and the tool_call settles output-denied, the turn still reaching a completed message-metadata', async () => {
      const app = buildApp(() =>
        toolCallThenStopModel(
          'bash',
          { command: 'rm -rf /workspace/build' },
          'call_1',
          'ok, skipped that',
        ),
      );
      const created = await createSession(app);

      await app.request(`/api/chat/conversations/${created.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'clean the build dir' }),
      });

      const streamResponse = await app.request(
        `/api/chat/conversations/${created.id}/stream`,
      );
      const reader = createIncrementalReader(streamResponse);
      await reader.readUntil((frames) =>
        chunksOnly(frames).some((c) => c.type === 'tool-approval-request'),
      );

      const denyResponse = await app.request(
        `/api/chat/conversations/${created.id}/approvals/call_1`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ behavior: 'deny', message: 'too risky' }),
        },
      );
      expect(denyResponse.status).toBe(200);

      const frames = await reader.drainToClose();
      const chunks = chunksOnly(frames);
      const responseChunk = chunks.find(
        (c) => c.type === 'tool-approval-response',
      );
      expect(responseChunk).toEqual({
        type: 'tool-approval-response',
        approvalId: 'call_1',
        approved: false,
        reason: 'too risky',
      });
      const deniedChunk = findByToolCallId(
        chunks,
        'tool-output-denied',
        'call_1',
      );
      expect(deniedChunk).toBeDefined();
      expect(chunks.at(-1)?.type).toBe('message-metadata');

      const eventsResponse = await app.request(
        `/api/chat/conversations/${created.id}/events`,
      );
      const replay = ConversationEventsListSchema.parse(
        await eventsResponse.json(),
      );
      const assistantMessage = messagesOnly(replay.frames).find(
        (m) => m.role === 'assistant',
      );
      const toolPart =
        assistantMessage !== undefined ?
          allToolParts([assistantMessage]).find(
            (part) => part.type === 'tool-bash',
          )
        : undefined;
      expect(toolPart?.state).toBe('output-denied');
      expect(
        toolPart?.state === 'output-denied' ?
          toolPart.approval.reason
        : undefined,
      ).toBe('too risky');
    });

    it('ask-user: tool-input-available (state input-available) appears on the stream; POST .../questions/:callId answers it and the turn continues through to a completed message-metadata', async () => {
      const app = buildApp(() =>
        toolCallThenStopModel(
          'ask-user',
          {
            question: 'which environment should I target?',
            options: ['staging', 'prod'],
          },
          'call_1',
          'got it, using staging',
        ),
      );
      const created = await createSession(app);

      await app.request(`/api/chat/conversations/${created.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'deploy it' }),
      });

      const streamResponse = await app.request(
        `/api/chat/conversations/${created.id}/stream`,
      );
      const reader = createIncrementalReader(streamResponse);
      const asked = await reader.readUntil((frames) =>
        chunksOnly(frames).some(
          (c) => c.type === 'tool-input-available' && c.toolName === 'ask-user',
        ),
      );
      const inputChunk = chunksOnly(asked).find(
        (c) => c.type === 'tool-input-available' && c.toolName === 'ask-user',
      );
      expect(
        inputChunk?.type === 'tool-input-available' ?
          inputChunk.toolCallId
        : undefined,
      ).toBe('call_1');

      const answerResponse = await app.request(
        `/api/chat/conversations/${created.id}/questions/call_1`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ answer: 'staging' }),
        },
      );
      expect(answerResponse.status).toBe(200);
      expect(await answerResponse.json()).toEqual({ ok: true });

      const frames = await reader.drainToClose();
      const chunks = chunksOnly(frames);
      const outputChunk = findByToolCallId(
        chunks,
        'tool-output-available',
        'call_1',
      );
      expect(
        outputChunk?.type === 'tool-output-available' ?
          outputChunk.output
        : undefined,
      ).toBe('staging');
      expect(chunks.at(-1)?.type).toBe('message-metadata');
    });

    it('POST .../approvals/:callId 404s: an unknown session id, another user’s session, and a callId with no pending approval (including re-deciding an already-resolved callId)', async () => {
      const app = buildApp(() =>
        toolCallThenStopModel(
          'bash',
          { command: 'git push' },
          'call_1',
          'pushed',
        ),
      );
      const created = await createSession(app);

      // 1. unknown session id
      const unknownSessionResponse = await app.request(
        `/api/chat/conversations/does-not-exist/approvals/call_1`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ behavior: 'allow' }),
        },
      );
      expect(unknownSessionResponse.status).toBe(404);

      // 2. another user's session
      const otherUserApp = buildApp(
        () => stopOnlyModel('unused'),
        'someone-else',
      );
      const otherUserResponse = await otherUserApp.request(
        `/api/chat/conversations/${created.id}/approvals/call_1`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ behavior: 'allow' }),
        },
      );
      expect(otherUserResponse.status).toBe(404);

      // 3. callId with no pending approval at all (nothing has been posted yet)
      const noPendingResponse = await app.request(
        `/api/chat/conversations/${created.id}/approvals/never-requested`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ behavior: 'allow' }),
        },
      );
      expect(noPendingResponse.status).toBe(404);

      // 3b. re-deciding an already-resolved callId also 404s
      await app.request(`/api/chat/conversations/${created.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'push it' }),
      });
      const streamResponse = await app.request(
        `/api/chat/conversations/${created.id}/stream`,
      );
      const reader = createIncrementalReader(streamResponse);
      await reader.readUntil((frames) =>
        chunksOnly(frames).some((c) => c.type === 'tool-approval-request'),
      );

      const firstDecision = await app.request(
        `/api/chat/conversations/${created.id}/approvals/call_1`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ behavior: 'allow' }),
        },
      );
      expect(firstDecision.status).toBe(200);

      const secondDecision = await app.request(
        `/api/chat/conversations/${created.id}/approvals/call_1`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ behavior: 'deny' }),
        },
      );
      expect(secondDecision.status).toBe(404);

      await reader.drainToClose();
    });

    it('POST .../questions/:callId 404s the same three ways (unknown session, another user’s session, no pending question); an empty answer 400s at the zod validation layer', async () => {
      const app = buildApp(() =>
        toolCallThenStopModel(
          'ask-user',
          { question: 'continue?' },
          'call_1',
          'ok',
        ),
      );
      const created = await createSession(app);

      const unknownSessionResponse = await app.request(
        `/api/chat/conversations/does-not-exist/questions/call_1`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ answer: 'yes' }),
        },
      );
      expect(unknownSessionResponse.status).toBe(404);

      const otherUserApp = buildApp(
        () => stopOnlyModel('unused'),
        'someone-else',
      );
      const otherUserResponse = await otherUserApp.request(
        `/api/chat/conversations/${created.id}/questions/call_1`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ answer: 'yes' }),
        },
      );
      expect(otherUserResponse.status).toBe(404);

      const noPendingResponse = await app.request(
        `/api/chat/conversations/${created.id}/questions/never-asked`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ answer: 'yes' }),
        },
      );
      expect(noPendingResponse.status).toBe(404);

      // Empty answer never even reaches resolveUserAnswer — PostAnswerInputSchema requires min(1).
      const emptyAnswerResponse = await app.request(
        `/api/chat/conversations/${created.id}/questions/never-asked`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ answer: '' }),
        },
      );
      expect(emptyAnswerResponse.status).toBe(400);
    });

    it('an approval "allow" decision still succeeds (200 + tool-approval-response still emitted) even when sandboxManager.touch rejects', async () => {
      const failingTouchSandboxManager =
        createSandboxManagerWithFailingTouchAfterFirst();
      const app = createChatApp({
        db,
        sandboxManager: failingTouchSandboxManager,
        resolveModel: () =>
          toolCallThenStopModel(
            'bash',
            { command: 'git push' },
            'call_1',
            'pushed',
          ),
        authMiddleware: fakeAuthMiddleware(USER_ID),
      });
      const created = await createSession(app);

      // This first message-triggered touch() call succeeds (see the fake's
      // own doc comment) — otherwise session creation itself would 500.
      await app.request(`/api/chat/conversations/${created.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'push it' }),
      });

      const streamResponse = await app.request(
        `/api/chat/conversations/${created.id}/stream`,
      );
      const reader = createIncrementalReader(streamResponse);
      await reader.readUntil((frames) =>
        chunksOnly(frames).some((c) => c.type === 'tool-approval-request'),
      );

      // This is the second touch() call — it rejects internally, but the
      // route must swallow it and still resolve the approval.
      const approveResponse = await app.request(
        `/api/chat/conversations/${created.id}/approvals/call_1`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ behavior: 'allow' }),
        },
      );
      expect(approveResponse.status).toBe(200);
      expect(await approveResponse.json()).toEqual({ ok: true });

      const frames = await reader.drainToClose();
      const chunks = chunksOnly(frames);
      expect(chunks.find((c) => c.type === 'tool-approval-response')).toEqual({
        type: 'tool-approval-response',
        approvalId: 'call_1',
        approved: true,
      });
      expect(chunks.at(-1)?.type).toBe('message-metadata');
    });
  });

  // -------------------------------------------------------------------------
  // 待发队列（[排队](docs/terms.md)，docs/tech/steer-and-queue.md）：默认 intent 的
  // 入队、队列管理端点、tail 上的 QueueFrame，以及一轮收尾后的自动出队。
  // -------------------------------------------------------------------------

  describe('待发队列 / 排队（docs/tech/steer-and-queue.md）', () => {
    /** 占住这个会话的 turn 槽位（一个自己不会结束的 fake），好让 POST 走「有进行中的一轮」那条分支。 */
    function occupyTurn(conversationId: string) {
      const stuck = createControllableSession();
      const { started } = startTurn({
        db,
        conversationId,
        session: stuck,
        text: 'first',
        priorMessageCount: 0,
      });
      expect(started).toBe(true);
      return stuck;
    }

    async function postMessage(
      app: ReturnType<typeof buildApp>,
      conversationId: string,
      body: { text: string; intent?: 'queue' | 'steer' },
    ): Promise<Response> {
      return app.request(`/api/chat/conversations/${conversationId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    async function readQueue(
      app: ReturnType<typeof buildApp>,
      conversationId: string,
    ): Promise<{ id: string; text: string }[]> {
      const response = await app.request(
        `/api/chat/conversations/${conversationId}`,
      );
      return ConversationSchema.parse(await response.json()).queuedMessages;
    }

    // 进程正在[优雅关闭](docs/terms.md)时不接新的轮（docs/tech/graceful-shutdown.md §3.3）。
    // 关闭闸门是模块级状态，所以这条用例自己负责复位，否则会连累后面全部用例。
    it('优雅关闭期间 POST .../messages 报 503（可恢复的拒绝，不是 409）', async () => {
      const app = buildApp(() => stopOnlyModel('hi'));
      const created = await createSession(app);

      await shutdownTurns({ timeoutMs: 1000, logger: silentLogger });
      try {
        const response = await postMessage(app, created.id, {
          text: '重启期间',
        });
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({
          error: '服务正在重启，请稍后重试',
        });
      } finally {
        __resetShutdownForTests();
      }

      // 复位后照常起轮——闸门是关闭流程的一部分，不是永久拒绝。
      const after = await postMessage(app, created.id, { text: '重启之后' });
      expect(after.status).toBe(202);
    });

    it('默认 intent：有进行中的一轮时消息入队（202 "queued"），当前轮不受影响，队列在会话详情里可见', async () => {
      const app = buildApp(() => stopOnlyModel('hi'));
      const created = await createSession(app);
      const stuck = occupyTurn(created.id);

      const response = await postMessage(app, created.id, {
        text: '做完A再做B',
      });
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ ok: true, mode: 'queued' });

      const queue = await readQueue(app, created.id);
      expect(queue).toHaveLength(1);
      expect(queue[0]?.text).toBe('做完A再做B');
      // 入队是纯 DB 操作：这一轮的账本一条没多（只有 startTurn 自己那条起轮消息）。
      expect(
        listConversationEvents(db, created.id).filter(
          (r) => r.kind === 'message',
        ),
      ).toHaveLength(1);

      stuck.finish({ finalResponse: 'ok', usage: {} });
    });

    it('没有进行中的一轮时 intent 不起作用：queue 与 steer 都直接起新一轮（202 "started"）', async () => {
      const app = buildApp(() => stopOnlyModel('hi'));
      const created = await createSession(app);

      const response = await postMessage(app, created.id, {
        text: 'hello',
        intent: 'queue',
      });
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ ok: true, mode: 'started' });
      expect(await readQueue(app, created.id)).toEqual([]);
    });

    it('队列满（10 条）时第 11 条被明确拒绝（409），队列不被截断也不静默丢弃', async () => {
      const app = buildApp(() => stopOnlyModel('hi'));
      const created = await createSession(app);
      const stuck = occupyTurn(created.id);

      for (let i = 0; i < 10; i += 1) {
        const ok = await postMessage(app, created.id, {
          text: `queued ${String(i)}`,
        });
        expect(ok.status).toBe(202);
      }

      const overflow = await postMessage(app, created.id, { text: '第 11 条' });
      expect(overflow.status).toBe(409);
      expect(await overflow.json()).toEqual({
        error: '待发队列已满（最多 10 条）',
      });

      const queue = await readQueue(app, created.id);
      expect(queue).toHaveLength(10);
      expect(queue.map((m) => m.text)).toEqual(
        Array.from({ length: 10 }, (_, i) => `queued ${String(i)}`),
      );

      stuck.finish({ finalResponse: 'ok', usage: {} });
    });

    it('DELETE .../queue/{messageId} 删一条并返回变更后的快照；重复删同一条 404', async () => {
      const app = buildApp(() => stopOnlyModel('hi'));
      const created = await createSession(app);
      const stuck = occupyTurn(created.id);

      for (const text of ['一', '二', '三']) {
        await postMessage(app, created.id, { text });
      }
      const queue = await readQueue(app, created.id);
      const middleId = queue[1]?.id ?? '';

      const response = await app.request(
        `/api/chat/conversations/${created.id}/queue/${middleId}`,
        { method: 'DELETE' },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { queue: { text: string }[] };
      // 剩下的保持原有顺序（先到先发），不因删中间一条而重排。
      expect(body.queue.map((m) => m.text)).toEqual(['一', '三']);

      const again = await app.request(
        `/api/chat/conversations/${created.id}/queue/${middleId}`,
        { method: 'DELETE' },
      );
      expect(again.status).toBe(404);

      stuck.finish({ finalResponse: 'ok', usage: {} });
    });

    it('DELETE .../queue 清空整个队列', async () => {
      const app = buildApp(() => stopOnlyModel('hi'));
      const created = await createSession(app);
      const stuck = occupyTurn(created.id);

      await postMessage(app, created.id, { text: '一' });
      await postMessage(app, created.id, { text: '二' });

      const response = await app.request(
        `/api/chat/conversations/${created.id}/queue`,
        { method: 'DELETE' },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ queue: [] });
      expect(await readQueue(app, created.id)).toEqual([]);

      stuck.finish({ finalResponse: 'ok', usage: {} });
    });

    it('队列端点对不属于自己的会话 404（鉴权先于队列操作）', async () => {
      const app = buildApp(() => stopOnlyModel('hi'));
      const created = await createSession(app);
      const otherApp = buildApp(() => stopOnlyModel('hi'), 'someone-else');

      expect(
        (
          await otherApp.request(
            `/api/chat/conversations/${created.id}/queue`,
            { method: 'DELETE' },
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await otherApp.request(
            `/api/chat/conversations/${created.id}/queue/whatever`,
            { method: 'DELETE' },
          )
        ).status,
      ).toBe(404);
    });

    it('直播流：回放之后先发一帧队列快照（时机 1），队列随后变化再广播一帧（时机 2）', async () => {
      const app = buildApp(() => stopOnlyModel('hi'));
      const created = await createSession(app);
      const stuck = occupyTurn(created.id);

      const response = await app.request(
        `/api/chat/conversations/${created.id}/stream`,
      );
      const reader = createIncrementalReader(response);

      // 时机 1：连上就有一帧权威快照（此刻还是空队列）。
      const afterReplay = await reader.readUntil(
        (frames) => queueFrames(frames).length > 0,
      );
      expect(queueFrames(afterReplay)[0]?.queue).toEqual([]);

      // 时机 2：入队后广播——多标签一致靠的就是这一帧。
      await postMessage(app, created.id, { text: '排一条' });
      const afterEnqueue = await reader.readUntil(
        (frames) => queueFrames(frames).length > 1,
      );
      expect(
        queueFrames(afterEnqueue)
          .at(-1)
          ?.queue.map((m) => m.text),
      ).toEqual(['排一条']);

      stuck.finish({ finalResponse: 'ok', usage: {} });
      await reader.drainToClose();
    });

    it('一轮收尾后自动出队起下一轮：排队的消息成为下一轮的用户消息，队列随之清空', async () => {
      const holdableSandboxManager = createHoldableSandboxManager();
      let modelCalls = 0;
      const app = createChatApp({
        db,
        sandboxManager: holdableSandboxManager,
        resolveModel: () => {
          modelCalls += 1;
          // 第一轮用会真的调 write-file 的模型（好在工具执行处挂住这一轮）；
          // 自动出队起的第二轮用纯文本模型，跑完即止。
          return modelCalls === 1 ?
              toolCallThenStopModel(
                'write-file',
                { path: '/notes.txt', content: 'hi' },
                'call_1',
                'wrote it',
              )
            : stopOnlyModel('第二轮答复');
        },
        authMiddleware: fakeAuthMiddleware(USER_ID),
      });
      const created = await createSession(app);

      const first = await postMessage(app, created.id, { text: '第一件事' });
      expect(await first.json()).toEqual({ ok: true, mode: 'started' });

      // 确定性挂起点：第一轮此刻停在 write-file 里。
      await holdableSandboxManager.writeCalled;

      const queued = await postMessage(app, created.id, { text: '第二件事' });
      expect(await queued.json()).toEqual({ ok: true, mode: 'queued' });

      holdableSandboxManager.releaseWrite();

      // 第一轮收尾 → onTurnSettled → 出队 → 起第二轮 → 第二轮跑完。
      const userTexts = await waitFor(() => {
        const texts = persistedUserTexts(db, created.id);
        return texts.length >= 2 ? texts : undefined;
      });

      expect(userTexts).toEqual(['第一件事', '第二件事']);
      expect(await readQueue(app, created.id)).toEqual([]);
      expect(modelCalls).toBe(2); // 第二轮确实是**新起的一轮**，不是被塞进第一轮
    });

    // -----------------------------------------------------------------------
    // 停止本轮（docs/tech/turn-abort.md §3.2）——`POST .../abort`。停止与队列在这里
    // 交汇：定案是「停止 = 全停」，所以这一组用例放在队列组里，正是为了钉住那个
    // 顺序（清队列**先于** abort，否则出队会抢跑）。
    // -----------------------------------------------------------------------

    describe('POST .../abort（停止本轮，docs/tech/turn-abort.md）', () => {
      async function postAbort(
        app: ReturnType<typeof buildApp>,
        conversationId: string,
      ): Promise<Response> {
        return app.request(`/api/chat/conversations/${conversationId}/abort`, {
          method: 'POST',
        });
      }

      it('中止进行中的那一轮并清空待发队列，200 带回清空后的快照', async () => {
        const app = buildApp(() => stopOnlyModel('hi'));
        const created = await createSession(app);
        const stuck = occupyTurn(created.id);

        await postMessage(app, created.id, { text: '排一条' });
        await postMessage(app, created.id, { text: '再排一条' });
        expect(await readQueue(app, created.id)).toHaveLength(2);

        const response = await postAbort(app, created.id);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true, queue: [] });

        // 队列真清了（服务端权威），而这一轮的 signal 也真被 abort 了。
        expect(await readQueue(app, created.id)).toEqual([]);
        expect(stuck.turnSignal?.aborted).toBe(true);

        stuck.finish({ finalResponse: '', usage: {} });
      });

      it('停止后这一轮收尾时不再自动出队（清队列先于 abort，出队时队列必然已空）', async () => {
        const app = buildApp(() => stopOnlyModel('hi'));
        const created = await createSession(app);
        const stuck = occupyTurn(created.id);

        await postMessage(app, created.id, { text: '别自己发出去' });
        await postAbort(app, created.id);

        // 这一轮按 core 的优雅收尾方式结束（停止走的就是这条路）。
        stuck.finish({ finalResponse: '', usage: {} });
        await flushMicrotasks();

        // 起轮只发生过一次（第一轮），排队那条既没被发出、也没留在队列里。
        expect(persistedUserTexts(db, created.id)).toEqual(['first']);
        expect(await readQueue(app, created.id)).toEqual([]);
      });

      it('真链路（真 core loop + 自动出队接线）：停止后这一轮以 interrupted 收尾，排队那条既不被自动发出也不留在队列里', async () => {
        // 这条用例刻意走 `POST .../messages` → `launchTurn` 起轮（而不是直接
        // `startTurn`），因为要验的正是[出队](docs/terms.md)那条 `onTurnSettled` 链条
        // 在停止后不抢跑——只有 `launchTurn` 会接上它。模型/沙盒是 fake，但 loop 是
        // 真的：于是这里同时验证了 core 的 step 边界 abort 检查（第二次模型调用不
        // 发生），以及「工具执行中被停止」那一档（docs/features/turn-abort.md §2.3）。
        const holdableSandboxManager = createHoldableSandboxManager();
        let modelCalls = 0;
        const app = createChatApp({
          db,
          sandboxManager: holdableSandboxManager,
          resolveModel: () => {
            modelCalls += 1;
            return toolCallThenStopModel(
              'write-file',
              { path: '/notes.txt', content: 'hi' },
              'call_1',
              'wrote it',
            );
          },
          authMiddleware: fakeAuthMiddleware(USER_ID),
        });
        const created = await createSession(app);

        await postMessage(app, created.id, { text: '第一件事' });
        // 确定性挂起点：这一轮此刻停在 write-file 里。
        await holdableSandboxManager.writeCalled;

        await postMessage(app, created.id, { text: '第二件事' });
        expect((await postAbort(app, created.id)).status).toBe(200);

        holdableSandboxManager.releaseWrite();

        // 收尾状态由真 loop 给出：这一轮最后一条 assistant 消息带 interrupted。
        const lastStatus = await waitFor(() =>
          persistedTurnStatuses(db, created.id).at(-1),
        );
        expect(lastStatus).toBe('interrupted');

        // 排队那条既没起轮（模型只被要过一次），也没留在队列里。
        expect(persistedUserTexts(db, created.id)).toEqual(['第一件事']);
        expect(await readQueue(app, created.id)).toEqual([]);
        expect(modelCalls).toBe(1);
      });

      it('没有进行中的一轮时 409，且**什么都不动**——误点停止不该变成丢消息', async () => {
        const app = buildApp(() => stopOnlyModel('hi'));
        const created = await createSession(app);

        // 队列里有一条（自动出队失败等情形下会出现「无进行中的轮 + 非空队列」）。
        const stuck = occupyTurn(created.id);
        await postMessage(app, created.id, { text: '还没发的一条' });
        stuck.finish({ finalResponse: 'ok', usage: {} });
        await flushMicrotasks();

        const response = await postAbort(app, created.id);
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({ error: 'no turn in progress' });
      });

      it('不属于自己的会话 404（鉴权先于任何副作用）', async () => {
        const app = buildApp(() => stopOnlyModel('hi'));
        const created = await createSession(app);
        const otherApp = buildApp(() => stopOnlyModel('hi'), 'someone-else');
        const stuck = occupyTurn(created.id);
        await postMessage(app, created.id, { text: '排一条' });

        const response = await postAbort(otherApp, created.id);
        expect(response.status).toBe(404);
        // 别人的停止请求既没有停掉这一轮，也没有清掉这个会话的队列。
        expect(stuck.turnSignal?.aborted).toBe(false);
        expect(await readQueue(app, created.id)).toHaveLength(1);

        stuck.finish({ finalResponse: 'ok', usage: {} });
      });

      it('直播流上先到一帧空队列快照（趁这一轮 emitter 还开着广播——轮结束后前端不会再重连）', async () => {
        const app = buildApp(() => stopOnlyModel('hi'));
        const created = await createSession(app);
        const stuck = occupyTurn(created.id);
        await postMessage(app, created.id, { text: '排一条' });

        const response = await app.request(
          `/api/chat/conversations/${created.id}/stream`,
        );
        const reader = createIncrementalReader(response);
        // 时机 1 的那帧（回放后必发）：此刻队列里还有一条。
        const afterReplay = await reader.readUntil(
          (frames) => queueFrames(frames).length > 0,
        );
        expect(queueFrames(afterReplay).at(-1)?.queue).toHaveLength(1);

        await postAbort(app, created.id);
        const afterAbort = await reader.readUntil(
          (frames) => queueFrames(frames).length > 1,
        );
        expect(queueFrames(afterAbort).at(-1)?.queue).toEqual([]);

        stuck.finish({ finalResponse: '', usage: {} });
        await reader.drainToClose();
      });

      // ---------------------------------------------------------------------
      // 起轮装配窗口里的停止（docs/tech/turn-abort.md §3.3）——用户实测报的
      // 「发完消息立刻点停止，没有任何反应」。窗口靠 `nextAcquireGate` 撑开：
      // `acquire()` 挂住 = 这一轮正卡在装配里，与真实的冷启动沙盒同形。
      // ---------------------------------------------------------------------

      describe('起轮装配窗口（docs/tech/turn-abort.md §3.3）', () => {
        /** 起一轮并把它卡在 `acquire()` 里；返回「放行装配」的开关与那个还没 await 的 POST。 */
        async function startTurnHeldInAssembly(
          app: ReturnType<typeof buildApp>,
          conversationId: string,
          body: { text: string; intent?: 'queue' | 'steer' } = {
            text: '发错了',
          },
        ): Promise<{ releaseAssembly: () => void; posted: Promise<Response> }> {
          let releaseAssembly = (): void => undefined;
          sandboxManager.nextAcquireGate = new Promise<void>((resolve) => {
            releaseAssembly = resolve;
          });
          const acquiresBefore = sandboxManager.acquireCalls.length;
          const posted = postMessage(app, conversationId, body);
          // 装配确实进去了（`acquire` 已被调用、正挂在 gate 上）才算窗口张开。
          await waitFor(() =>
            sandboxManager.acquireCalls.length > acquiresBefore ?
              true
            : undefined,
          );
          return { releaseAssembly, posted };
        }

        it('装配窗口里按停止：这一轮从没启动，POST .../messages 回 202 mode "aborted"', async () => {
          const app = buildApp(() => stopOnlyModel('这句话不该被生成'));
          const created = await createSession(app);
          const { releaseAssembly, posted } = await startTurnHeldInAssembly(
            app,
            created.id,
          );

          // 用户此刻按下停止——以前这里是 409、界面毫无反应，这一轮照样跑起来。
          const abortResponse = await postAbort(app, created.id);
          expect(abortResponse.status).toBe(200);

          releaseAssembly();
          const postResponse = await posted;
          expect(postResponse.status).toBe(202);
          expect(await postResponse.json()).toEqual({
            ok: true,
            mode: 'aborted',
          });

          await flushMicrotasks();
          // 「从没启动」的证据：账本里只有用户那条消息，没有任何 assistant 内容。
          // （不看 `resolveModel` 的调用数：它在装配的第一行就被调过一次，那只是
          // 「解析出一个模型对象」，不是一次模型调用。）
          expect(persistedMessages(db, created.id).map((m) => m.role)).toEqual([
            'user',
          ]);

          // 占位也确实撤干净了：紧接着发下一条消息能正常起新一轮，会话没被锁死。
          const next = await postMessage(app, created.id, { text: '重新发' });
          expect(next.status).toBe(202);
          expect(await next.json()).toEqual({ ok: true, mode: 'started' });
        });

        it('装配窗口里按停止：时间线上留着用户那条消息 + 一条 interrupted 收尾（与跑到中途按停止长得一样）', async () => {
          const app = buildApp(() => stopOnlyModel('unused'));
          const created = await createSession(app);
          const { releaseAssembly, posted } = await startTurnHeldInAssembly(
            app,
            created.id,
            { text: '发错了，撤回' },
          );

          await postAbort(app, created.id);
          releaseAssembly();
          await posted;
          await flushMicrotasks();

          // 落账本的两帧：用户原话 + `status: 'interrupted'` 的收尾。
          expect(persistedUserTexts(db, created.id)).toEqual(['发错了，撤回']);
          const chunkRow = listConversationEvents(db, created.id)
            .filter((row) => row.kind === 'chunk')
            .at(-1);
          expect(chunkRow).toBeDefined();
          // 与 `persistedMessages` 同一姿态：把行还原成它代表的那个信封再过 zod，
          // `JSON.parse` 的 any 不落进具名变量。
          const frame = chatReplayFrameSchema.parse({
            seq: chunkRow?.seq,
            chunk: JSON.parse(chunkRow?.payloadJson ?? '{}'),
          });
          expect('chunk' in frame && frame.chunk.type).toBe('message-metadata');
          expect(
            'chunk' in frame && frame.chunk.type === 'message-metadata' ?
              frame.chunk.messageMetadata
            : undefined,
          ).toMatchObject({
            status: 'interrupted',
            error: { code: 'aborted' },
          });
        });

        it('装配失败（沙盒起不来）后下一条消息仍能起轮——占位必须被撤掉，否则会话永久锁死', async () => {
          let acquireCalls = 0;
          const flakySandboxManager: SandboxManager = {
            ...sandboxManager,
            async acquire(input: AcquireInput): Promise<AcquiredSandbox> {
              acquireCalls += 1;
              // 建会话那次（第一次）要成功，之后第一条消息那次失败。
              if (acquireCalls === 2) {
                throw new Error('sandbox unavailable');
              }
              return sandboxManager.acquire(input);
            },
          };
          const app = createChatApp({
            db,
            sandboxManager: flakySandboxManager,
            resolveModel: () => stopOnlyModel('hi'),
            authMiddleware: fakeAuthMiddleware(USER_ID),
          });
          const created = await createSession(app);

          const failed = await postMessage(app, created.id, { text: '第一次' });
          expect(failed.status).toBe(500);

          // 关键回归：装配失败没有把这个会话卡在「一直有轮在跑」的状态里。
          const retried = await postMessage(app, created.id, {
            text: '第二次',
          });
          expect(retried.status).toBe(202);
          expect(await retried.json()).toEqual({ ok: true, mode: 'started' });
        });

        it('装配窗口里再发一条消息：入队（不再触发第二次完整装配）', async () => {
          const app = buildApp(() => stopOnlyModel('hi'));
          const created = await createSession(app);
          const acquiresAfterCreate = sandboxManager.acquireCalls.length;
          const { releaseAssembly, posted } = await startTurnHeldInAssembly(
            app,
            created.id,
            { text: '第一件事' },
          );

          const second = await postMessage(app, created.id, {
            text: '第二件事',
          });
          expect(second.status).toBe(202);
          expect(await second.json()).toEqual({ ok: true, mode: 'queued' });
          // 第二条没有自己再走一遍装配：acquire 仍然只多了第一条那一次。
          expect(sandboxManager.acquireCalls.length).toBe(
            acquiresAfterCreate + 1,
          );
          expect(await readQueue(app, created.id)).toHaveLength(1);

          releaseAssembly();
          await posted;
        });

        it('装配窗口里插话：转成排队（那一轮还没有 session 可插），不报 409', async () => {
          const app = buildApp(() => stopOnlyModel('hi'));
          const created = await createSession(app);
          const { releaseAssembly, posted } = await startTurnHeldInAssembly(
            app,
            created.id,
            { text: '第一件事' },
          );

          const steered = await postMessage(app, created.id, {
            text: '顺便也做这个',
            intent: 'steer',
          });
          expect(steered.status).toBe(202);
          expect(await steered.json()).toEqual({ ok: true, mode: 'queued' });

          releaseAssembly();
          await posted;
        });
      });
    });
  });

  describe('GET /api/chat/conversations/{id}/turns/{turn}/telemetry (docs/tech/chat-webapp.md §11.4)', () => {
    it('404s for a session the user does not own / does not exist', async () => {
      const app = buildApp(() => stopOnlyModel('hi'));
      const response = await app.request(
        '/api/chat/conversations/nope/turns/1/telemetry',
      );
      expect(response.status).toBe(404);
    });

    it('returns an empty list (not an error) when no telemetryStore is configured', async () => {
      const app = buildApp(() => stopOnlyModel('hi'));
      const session = await createSession(app);
      const response = await app.request(
        `/api/chat/conversations/${session.id}/turns/1/telemetry`,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ events: [] });
    });

    it('returns an empty list while the session has no nimbo header yet (no gracefully-finished turn)', async () => {
      const store = createTelemetryStore(':memory:');
      const app = createChatApp({
        db,
        sandboxManager,
        resolveModel: () => stopOnlyModel('hi'),
        authMiddleware: fakeAuthMiddleware(USER_ID),
        telemetryStore: store,
      });
      const session = await createSession(app);
      const response = await app.request(
        `/api/chat/conversations/${session.id}/turns/1/telemetry`,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ events: [] });
      store.close();
    });

    it('maps the chat row to its nimbo session id (functionId 前半段) and returns that turn’s events in write order', async () => {
      const store = createTelemetryStore(':memory:');
      const app = createChatApp({
        db,
        sandboxManager,
        resolveModel: () => stopOnlyModel('hi'),
        authMiddleware: fakeAuthMiddleware(USER_ID),
        telemetryStore: store,
      });
      const session = await createSession(app);
      // 首轮优雅收尾会写 nimbo header（turn-runner 的 finalizeTurnPersistence）
      // ——这里直接落 header，避免测试依赖后台 turn 的时序。
      updateConversation(db, session.id, {
        status: 'active',
        lastActiveAt: new Date(),
        agentSessionHeader: {
          conversationId: 'nimbo-s1',
          createdAt: new Date(),
          turn: 1,
        },
      });
      store.record('model-call-end', 'nimbo-s1#1', {
        usage: { inputTokens: 5 },
      });
      store.record('end', 'nimbo-s1#1', {});
      store.record('model-call-end', 'nimbo-s1#2', {}); // 别的 turn，不该出现

      const response = await app.request(
        `/api/chat/conversations/${session.id}/turns/1/telemetry`,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        events: { eventType: string; ts: number; payloadJson: string }[];
      };
      expect(body.events.map((e) => e.eventType)).toEqual([
        'model-call-end',
        'end',
      ]);
      expect(JSON.parse(body.events[0]?.payloadJson ?? '{}')).toMatchObject({
        usage: { inputTokens: 5 },
      });
      store.close();
    });
  });
});
