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
import { startTurn } from '../../src/agent/turn-runner.js';
import { createChatApp } from '../../src/routes/chat.js';
import type {
  ChatReplayFrame,
  ChunkEnvelope,
  ConversationDto,
  MessageFrame,
} from '../../src/schemas/chat.js';
import {
  chatReplayFrameSchema,
  ConversationEventsListSchema,
  ConversationSchema,
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
import { allToolParts, collectText } from '../helpers/nimbo-chunks.js';
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

function chunksOnly(frames: ChatReplayFrame[]): NimboChunk[] {
  return chunkFrames(frames).map((frame) => frame.chunk);
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
      };
    },
    async touch(conversationId: string): Promise<void> {
      touchCalls.push(conversationId);
    },
    release(): void {
      // no-op — this fake only cares about acquire()'s workspace and touch()'s call log.
    },
  };
}

/**
 * A `SandboxManager` whose first `touch()` call succeeds (so `POST .../messages`'s
 * own acquire+touch still lands normally) but every subsequent call rejects —
 * used to exercise `POST .../approvals/:callId`'s "allow" branch swallowing a
 * `touch()` failure instead of letting it block the decision (routes/chat.ts's
 * own comment on that branch).
 */
function createSandboxManagerWithFailingTouchAfterFirst(): SandboxManager {
  const base = createFakeSandboxManager();
  let touchCalls = 0;
  return {
    acquire: (input) => base.acquire(input),
    async touch(conversationId: string): Promise<void> {
      touchCalls += 1;
      if (touchCalls === 1) {
        await base.touch(conversationId);
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

  it('POST .../messages 409s when a turn is already in progress for that session', async () => {
    const app = buildApp(() => stopOnlyModel('hi'));
    const created = await createSession(app);

    // Occupy the turn slot directly (a fake that never finishes on its own)
    // instead of racing a real mock-model turn, which could complete before
    // the second POST below ever runs.
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
        body: JSON.stringify({ text: 'second' }),
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

  it('GET .../stream closes immediately after replay when there is no turn in progress (fresh session, never messaged)', async () => {
    const app = buildApp(() => stopOnlyModel('hi'));
    const created = await createSession(app);

    const response = await app.request(
      `/api/chat/conversations/${created.id}/stream`,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
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
    expect(sandboxManager.touchCalls).toEqual([created.id]);

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

  it('a second POST while a turn is in progress steers it (202 mode "steered"): the steered text streams as its own start(steered:true)…finish sequence, and both messages persist correctly once the turn ends', async () => {
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

    const secondResponse = await app.request(
      `/api/chat/conversations/${created.id}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'also check the API timeout' }),
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
