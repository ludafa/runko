import type { NimboExec, NimboFS } from '@nimbo/core';
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
import { getChatSession, listAgentEvents } from '../../src/agent/store.js';
import { startTurn } from '../../src/agent/turn-runner.js';
import { createChatApp } from '../../src/routes/chat.js';
import type { ChatSessionDto } from '../../src/schemas/chat.js';
import { createControllableSession } from '../helpers/controllable-session.js';
import type { FakeSandboxManager } from '../helpers/fake-sandbox-manager.js';
import { createFakeSandboxManager } from '../helpers/fake-sandbox-manager.js';
import { stopOnlyModel, toolCallThenStopModel } from '../helpers/mock-model.js';
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

interface SseFrame {
  event?: string;
  data: string;
}

function parseSseFrames(body: string): SseFrame[] {
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

interface ParsedEnvelope {
  seq: number;
  event: { type: string; [key: string]: unknown };
}

function parseEnvelopes(body: string): ParsedEnvelope[] {
  return parseSseFrames(body).map(
    (frame) => JSON.parse(frame.data) as ParsedEnvelope,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
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
      predicate: (envelopes: ParsedEnvelope[]) => boolean,
      maxAttempts = 200,
    ): Promise<ParsedEnvelope[]> {
      for (let i = 0; i < maxAttempts; i += 1) {
        const envelopes = parseEnvelopes(buffer);
        if (predicate(envelopes) || closed) return envelopes;
        await sleep(5);
      }
      throw new Error(
        `timed out waiting for expected envelopes; buffer so far: ${buffer}`,
      );
    },
    async drainToClose(maxAttempts = 200): Promise<ParsedEnvelope[]> {
      for (let i = 0; i < maxAttempts; i += 1) {
        if (closed) return parseEnvelopes(buffer);
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
 * below hold a *real* `write_file` tool_call step open long enough to send a
 * second `POST .../messages` mid-turn, deterministically (no sleep/race).
 * Needed because that test exercises the real `@nimbo/core`/`@nimbo/sdk`
 * `Session.steer()` wiring (not a `ControllableSession` fake) — only a real
 * in-flight tool execution actually produces a real `user_message` item.
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
    async acquire(_input: AcquireInput): Promise<AcquiredSandbox> {
      return { workspace: await workspacePromise, defaultBranch: 'main' };
    },
    async touch(sessionId: string): Promise<void> {
      touchCalls.push(sessionId);
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
    async touch(sessionId: string): Promise<void> {
      touchCalls += 1;
      if (touchCalls === 1) {
        await base.touch(sessionId);
        return;
      }
      throw new Error('sandbox temporarily unavailable');
    },
    release: (sessionId: string) => {
      base.release(sessionId);
    },
  };
}

// ---------------------------------------------------------------------------
// Loosely-typed SSE envelope narrowing helpers (docs/08 §2.2c（审批链）tests
// below) — `ParsedEnvelope.event` is `{ type: string; [key: string]: unknown }`
// (see `parseEnvelopes` above), so pulling a specific field back out needs a
// runtime check rather than a type assertion.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function extractStringField(
  record: Record<string, unknown>,
  field: string,
): string {
  const value = record[field];
  if (typeof value !== 'string') {
    throw new Error(
      `expected field "${field}" to be a string, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** The first `item.completed` tool_call item matching `toolName` (if given), across a set of parsed SSE envelopes. */
function findCompletedToolCall(
  envelopes: ParsedEnvelope[],
  toolName?: string,
): Record<string, unknown> | undefined {
  for (const envelope of envelopes) {
    if (envelope.event.type !== 'item.completed') continue;
    const item = envelope.event.item;
    if (!isRecord(item) || item.type !== 'tool_call') continue;
    if (toolName !== undefined && item.toolName !== toolName) continue;
    return item;
  }
  return undefined;
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
  ): Promise<ChatSessionDto> {
    const response = await app.request('/api/chat/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    return (await response.json()) as ChatSessionDto;
  }

  it('POST /api/chat/sessions provisions a sandbox (via acquire) and persists a chat_sessions row', async () => {
    const app = buildApp(() => stopOnlyModel('hi'));

    const response = await app.request('/api/chat/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'My session' }),
    });
    expect(response.status).toBe(201);
    const created = (await response.json()) as ChatSessionDto;
    expect(created.title).toBe('My session');
    expect(created.repo).toBe('acme/demo');
    expect(created.status).toBe('active');
    expect(created.branchName).toContain(created.id);
    expect(created.sandboxName).toContain(created.id);

    expect(sandboxManager.acquireCalls).toHaveLength(1);
    expect(sandboxManager.acquireCalls[0]?.repoCloneUrl).toBe(
      'https://github.com/acme/demo.git',
    );

    const row = getChatSession(db, created.id, USER_ID);
    expect(row).toBeDefined();
    expect(row?.nimboStateJson).toBeNull();
  });

  it('POST /api/chat/sessions defaults the title and 500s when GITHUB_REPO is unset', async () => {
    const app = buildApp(() => stopOnlyModel('hi'));
    const noTitleResponse = await app.request('/api/chat/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(noTitleResponse.status).toBe(201);
    expect(((await noTitleResponse.json()) as ChatSessionDto).title).toBe(
      'New chat',
    );

    vi.unstubAllEnvs();
    vi.stubEnv('GITHUB_PAT', 'test-pat'); // GITHUB_REPO deliberately left unset
    const response = await app.request('/api/chat/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(500);
  });

  it('GET /api/chat/sessions only lists the current user’s sessions; GET .../:id and .../events and .../stream 404 for another user’s session', async () => {
    const app = buildApp(() => stopOnlyModel('hi'));
    const created = await createSession(app);

    const listResponse = await app.request('/api/chat/sessions');
    expect(listResponse.status).toBe(200);
    expect(
      ((await listResponse.json()) as ChatSessionDto[]).map((s) => s.id),
    ).toEqual([created.id]);

    const otherUserApp = buildApp(() => stopOnlyModel('hi'), 'someone-else');
    expect(
      (await otherUserApp.request(`/api/chat/sessions/${created.id}`)).status,
    ).toBe(404);
    expect(
      (await otherUserApp.request(`/api/chat/sessions/${created.id}/events`))
        .status,
    ).toBe(404);
    expect(
      (await otherUserApp.request(`/api/chat/sessions/${created.id}/stream`))
        .status,
    ).toBe(404);
  });

  it('every route requires authMiddleware to set userId (401 short-circuits before touching the db/sandbox)', async () => {
    const app = createChatApp({
      db,
      sandboxManager,
      resolveModel: () => stopOnlyModel('hi'),
      authMiddleware: unauthorizedMiddleware,
    });
    const response = await app.request('/api/chat/sessions');
    expect(response.status).toBe(401);
    expect(sandboxManager.acquireCalls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // POST .../messages (docs/08 §2.2b: starts a turn, 202, doesn't stream)
  // -------------------------------------------------------------------------

  it('POST .../messages starts a turn and returns 202 { ok: true, mode: "started" } immediately (no SSE body) when no turn is already in progress', async () => {
    const app = buildApp(() => stopOnlyModel('Hello there!'));
    const created = await createSession(app);

    const response = await app.request(
      `/api/chat/sessions/${created.id}/messages`,
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
      '/api/chat/sessions/does-not-exist/messages',
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
      sessionId: created.id,
      session: stuck,
      text: 'first',
    });
    expect(started).toBe(true);

    const response = await app.request(
      `/api/chat/sessions/${created.id}/messages`,
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

    stuck.finish({ items: [], finalResponse: 'ok', usage: {} });
  });

  // -------------------------------------------------------------------------
  // GET .../stream (docs/08 §2.2b: resumable live tail)
  // -------------------------------------------------------------------------

  it('GET .../stream replays persisted history then forwards live events seamlessly — no duplicate/missing seq — and closes once the turn ends', async () => {
    const app = buildApp(() => stopOnlyModel('unused'));
    const created = await createSession(app);

    const fake = createControllableSession();
    const { started } = startTurn({
      db,
      sessionId: created.id,
      session: fake,
      text: '你好',
    });
    expect(started).toBe(true); // user.message (seq 1) already persisted synchronously

    const response = await app.request(
      `/api/chat/sessions/${created.id}/stream`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const reader = createIncrementalReader(response);
    await reader.readUntil((envs) =>
      envs.some((e) => e.event.type === 'user.message'),
    );

    fake.pushEvent({ type: 'session.started', sessionId: created.id });
    await reader.readUntil((envs) =>
      envs.some((e) => e.event.type === 'session.started'),
    );

    fake.pushEvent({ type: 'turn.started', turn: 1 });
    await reader.readUntil((envs) =>
      envs.some((e) => e.event.type === 'turn.started'),
    );

    fake.finish({ items: [], finalResponse: 'done streaming', usage: {} });
    const envelopes = await reader.drainToClose();

    expect(envelopes.map((e) => e.event.type)).toEqual([
      'user.message',
      'session.started',
      'turn.started',
      'turn.result',
    ]);
    expect(envelopes.map((e) => e.seq)).toEqual([1, 2, 3, 4]); // strictly monotonic, no gaps, no repeats
    expect(envelopes[0]?.event.text).toBe('你好');
    expect(envelopes.at(-1)?.event.finalResponse).toBe('done streaming');
  });

  it('GET .../stream supports after=<seq> to skip the already-seen prefix of a live tail', async () => {
    const app = buildApp(() => stopOnlyModel('unused'));
    const created = await createSession(app);

    const fake = createControllableSession();
    startTurn({ db, sessionId: created.id, session: fake, text: 'hi' }); // seq 1: user.message

    const response = await app.request(
      `/api/chat/sessions/${created.id}/stream?after=1`,
    );
    const reader = createIncrementalReader(response);

    fake.finish({ items: [], finalResponse: 'ok', usage: {} });
    const envelopes = await reader.drainToClose();

    expect(envelopes.map((e) => e.event.type)).toEqual(['turn.result']);
    expect(envelopes.map((e) => e.seq)).toEqual([2]);
  });

  it('GET .../stream closes immediately after replay when there is no turn in progress (fresh session, never messaged)', async () => {
    const app = buildApp(() => stopOnlyModel('hi'));
    const created = await createSession(app);

    const response = await app.request(
      `/api/chat/sessions/${created.id}/stream`,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
  });

  it('GET .../stream closes immediately after replaying a since-finished turn’s history (no live wait hangs around)', async () => {
    const app = buildApp(() => stopOnlyModel('unused'));
    const created = await createSession(app);

    const fake = createControllableSession();
    startTurn({ db, sessionId: created.id, session: fake, text: 'hi' });
    fake.finish({ items: [], finalResponse: 'ok', usage: {} });

    // First call: still catches the (already-registered, now-finishing) turn.
    const first = await app.request(`/api/chat/sessions/${created.id}/stream`);
    const firstEnvelopes = parseEnvelopes(await first.text());
    expect(firstEnvelopes.map((e) => e.event.type)).toEqual([
      'user.message',
      'turn.result',
    ]);

    // Second call, after the first has already observed `turn.result`: no
    // turn is active anymore and nothing new was persisted — must close
    // right after an empty replay, not hang waiting for a live event.
    const lastSeq = firstEnvelopes.at(-1)?.seq ?? 0;
    const second = await app.request(
      `/api/chat/sessions/${created.id}/stream?after=${String(lastSeq)}`,
    );
    expect(second.status).toBe(200);
    expect(await second.text()).toBe('');
  });

  it('GET .../stream replays a turn-runner-level turn.failed sentinel (unexpected exception, not a yielded SessionEvent) correctly', async () => {
    const app = buildApp(() => stopOnlyModel('unused'));
    const created = await createSession(app);

    const fake = createControllableSession();
    startTurn({ db, sessionId: created.id, session: fake, text: 'boom' });
    fake.fail(new Error('provider exploded'));

    const response = await app.request(
      `/api/chat/sessions/${created.id}/stream`,
    );
    const envelopes = parseEnvelopes(await response.text());
    expect(envelopes.map((e) => e.event.type)).toEqual([
      'user.message',
      'turn.failed',
    ]);
    expect(envelopes.at(-1)?.event).toEqual({
      type: 'turn.failed',
      code: 'internal_error',
      message: 'provider exploded',
    });

    const row = getChatSession(db, created.id, USER_ID);
    expect(row?.nimboStateJson).toBeNull();
  });

  // -------------------------------------------------------------------------
  // End-to-end (real mock model) — POST to start, GET .../stream to observe
  // the whole turn regardless of whether it had already finished by the time
  // the tail request lands (both paths are exercised by the route the same
  // way — see the dedicated controllable-session tests above for the exact
  // ordering guarantees).
  // -------------------------------------------------------------------------

  it('POST + GET .../stream end-to-end: user.message first, then the turn’s events, ending with turn.result — all persisted with a monotonic seq, replayable via GET .../events', async () => {
    const app = buildApp(() => stopOnlyModel('Hello there!'));
    const created = await createSession(app);

    const postResponse = await app.request(
      `/api/chat/sessions/${created.id}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '你好' }),
      },
    );
    expect(postResponse.status).toBe(202);

    const streamResponse = await app.request(
      `/api/chat/sessions/${created.id}/stream`,
    );
    const body = await streamResponse.text();
    const envelopes = parseEnvelopes(body);
    const types = envelopes.map((e) => e.event.type);

    expect(types[0]).toBe('user.message');
    expect(envelopes[0]?.event.text).toBe('你好');
    expect(types).toContain('session.started');
    expect(types).toContain('turn.started');
    expect(types).toContain('turn.completed');
    expect(types.at(-1)).toBe('turn.result');
    expect(envelopes.map((e) => e.seq)).toEqual(envelopes.map((_, i) => i + 1));

    const turnResult = envelopes.at(-1)?.event;
    expect(turnResult?.finalResponse).toBe('Hello there!');

    // acquire() ran twice total (session creation + this message), touch() once.
    expect(sandboxManager.acquireCalls).toHaveLength(2);
    expect(sandboxManager.touchCalls).toEqual([created.id]);

    const persisted = listAgentEvents(db, created.id);
    expect(persisted.map((row) => row.seq)).toEqual(
      envelopes.map((e) => e.seq),
    );
    expect(persisted.map((row) => row.type)).toEqual(types);

    const replay = (await (
      await app.request(`/api/chat/sessions/${created.id}/events`)
    ).json()) as { events: ParsedEnvelope[] };
    expect(replay.events.map((e) => e.event.type)).toEqual(types);

    const row = getChatSession(db, created.id, USER_ID);
    expect(row?.nimboStateJson).not.toBeNull();
    const state = JSON.parse(row?.nimboStateJson ?? '{}') as {
      turn: number;
      messages: unknown[];
    };
    expect(state.turn).toBe(1);
    expect(state.messages.length).toBeGreaterThan(0);
  });

  it('GET .../events replays exactly what was persisted, and supports after= to page from a given seq', async () => {
    const app = buildApp(() => stopOnlyModel('ok'));
    const created = await createSession(app);

    await app.request(`/api/chat/sessions/${created.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    // Drain the tail to make sure the turn has actually finished landing rows
    // before the assertions below run (same role the old SSE `.text()` drain
    // played pre-P12-4).
    await (await app.request(`/api/chat/sessions/${created.id}/stream`)).text();

    const allEventsResponse = await app.request(
      `/api/chat/sessions/${created.id}/events`,
    );
    expect(allEventsResponse.status).toBe(200);
    const allBody = (await allEventsResponse.json()) as {
      events: ParsedEnvelope[];
    };
    const all = allBody.events;
    expect(all.length).toBeGreaterThan(2);
    expect(all[0]?.event.type).toBe('user.message');

    const afterResponse = await app.request(
      `/api/chat/sessions/${created.id}/events?after=${String(all[0]?.seq)}`,
    );
    const afterBody = (await afterResponse.json()) as {
      events: ParsedEnvelope[];
    };
    expect(afterBody.events).toEqual(all.slice(1));
  });

  it('a second message on the same session resumes message history (turn increments, prior messages retained), seq climbing across turns', async () => {
    const app = buildApp(() => stopOnlyModel('reply'));
    const created = await createSession(app);

    await app.request(`/api/chat/sessions/${created.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'first' }),
    });
    await (await app.request(`/api/chat/sessions/${created.id}/stream`)).text();
    const firstState = JSON.parse(
      getChatSession(db, created.id, USER_ID)?.nimboStateJson ?? '{}',
    ) as { turn: number; messages: unknown[] };

    await app.request(`/api/chat/sessions/${created.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'second' }),
    });
    await (await app.request(`/api/chat/sessions/${created.id}/stream`)).text();
    const secondState = JSON.parse(
      getChatSession(db, created.id, USER_ID)?.nimboStateJson ?? '{}',
    ) as { turn: number; messages: unknown[] };

    expect(secondState.turn).toBe(firstState.turn + 1);
    expect(secondState.messages.length).toBeGreaterThan(
      firstState.messages.length,
    );

    const persisted = listAgentEvents(db, created.id);
    expect(persisted.at(0)?.seq).toBe(1);
    expect(
      persisted.every((row, i) =>
        i === 0 ? true : row.seq === (persisted[i - 1]?.seq ?? 0) + 1,
      ),
    ).toBe(true);
  });

  it('a turn with a tool call also streams/persists a tool_call item.* sequence', async () => {
    const app = buildApp(() =>
      toolCallThenStopModel(
        'write_file',
        { path: '/notes.txt', content: 'hi' },
        'call_1',
        'wrote it',
      ),
    );
    const created = await createSession(app);

    await app.request(`/api/chat/sessions/${created.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'write a file' }),
    });
    const body = await (
      await app.request(`/api/chat/sessions/${created.id}/stream`)
    ).text();
    const envelopes = parseEnvelopes(body);
    const toolCallCompleted = envelopes.find(
      (e) =>
        e.event.type === 'item.completed' &&
        (e.event as { item?: { type?: string } }).item?.type === 'tool_call',
    );
    expect(toolCallCompleted).toBeDefined();
    const fileChangeCompleted = envelopes.find(
      (e) =>
        e.event.type === 'item.completed' &&
        (e.event as { item?: { type?: string } }).item?.type === 'file_change',
    );
    expect(fileChangeCompleted).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // STEER-3B: POST .../messages while a turn is in progress steers it
  // instead of starting a new one. Real mock model + real @nimbo/sdk
  // session (not a ControllableSession fake) — a real `write_file` tool_call
  // step is held open (buildHoldableWorkspace) so the second POST lands
  // squarely mid-turn, exercising the actual Session.steer() wiring that
  // produces a real `user_message` item (packages/core/test/steer.test.ts
  // already covers that wiring in isolation; this is the end-to-end route
  // regression for it).
  // -------------------------------------------------------------------------

  it('a second POST while a turn is in progress steers it (202 mode "steered"): no extra user.message echo, and a real user_message item.completed appears in the stream', async () => {
    const holdableSandboxManager = createHoldableSandboxManager();
    const app = createChatApp({
      db,
      sandboxManager: holdableSandboxManager,
      resolveModel: () =>
        toolCallThenStopModel(
          'write_file',
          { path: '/notes.txt', content: 'hi' },
          'call_1',
          'wrote it and replied',
        ),
      authMiddleware: fakeAuthMiddleware(USER_ID),
    });
    const created = await createSession(app);

    const firstResponse = await app.request(
      `/api/chat/sessions/${created.id}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'explore the repo' }),
      },
    );
    expect(firstResponse.status).toBe(202);
    expect(await firstResponse.json()).toEqual({
      ok: true,
      mode: 'started',
    });

    // Deterministic hold point: the real write_file tool call is now paused
    // inside fs.writeFile() — nothing time-based, no sleep/race.
    await holdableSandboxManager.writeCalled;

    const secondResponse = await app.request(
      `/api/chat/sessions/${created.id}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'also check the API timeout' }),
      },
    );
    expect(secondResponse.status).toBe(202);
    expect(await secondResponse.json()).toEqual({
      ok: true,
      mode: 'steered',
    });

    holdableSandboxManager.releaseWrite();

    const body = await (
      await app.request(`/api/chat/sessions/${created.id}/stream`)
    ).text();
    const envelopes = parseEnvelopes(body);

    // exactly one user.message echo (the turn-starting message) — the
    // steered message is never echoed (docs/08 §2.2 "契约细化" #3: its one
    // persisted record is the user_message item nimbo's own loop produces).
    const userMessageEchoes = envelopes.filter(
      (e) => e.event.type === 'user.message',
    );
    expect(userMessageEchoes).toHaveLength(1);
    expect(userMessageEchoes[0]?.event.text).toBe('explore the repo');

    const steeredItem = envelopes.find(
      (e) =>
        e.event.type === 'item.completed' &&
        (e.event as { item?: { type?: string } }).item?.type === 'user_message',
    );
    expect(steeredItem).toBeDefined();
    expect(
      (steeredItem?.event as { item?: { text?: string } }).item?.text,
    ).toBe('also check the API timeout');

    // both requests still rolled the sandbox's idle timeout forward — the
    // steered branch calls touch() too (routes/chat.ts), not just the
    // normal-start branch.
    expect(holdableSandboxManager.touchCalls).toEqual([created.id, created.id]);
  });

  // -------------------------------------------------------------------------
  // Approval chain + ask_user (docs/08 §2.2c（审批链）) — end-to-end through
  // the real routes, a mock model driving a bash/ask_user tool call, and the
  // in-process turn-runner bridge (no fakes for any of that machinery, only
  // the sandbox/model are mocked, same as the rest of this file).
  // -------------------------------------------------------------------------

  describe('approval chain + ask_user (docs/08 §2.2c（审批链）)', () => {
    it('a safe bash command under the default (dangerous) approval mode runs straight through — no approval.requested is ever emitted', async () => {
      const app = buildApp(() =>
        toolCallThenStopModel(
          'bash',
          { command: 'ls -la' },
          'call_1',
          'listed it',
        ),
      );
      const created = await createSession(app);

      await app.request(`/api/chat/sessions/${created.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'list files' }),
      });
      const body = await (
        await app.request(`/api/chat/sessions/${created.id}/stream`)
      ).text();
      const envelopes = parseEnvelopes(body);

      expect(envelopes.some((e) => e.event.type === 'approval.requested')).toBe(
        false,
      );
      expect(envelopes.some((e) => e.event.type === 'approval.resolved')).toBe(
        false,
      );
      expect(envelopes.at(-1)?.event.type).toBe('turn.result');

      const toolCall = findCompletedToolCall(envelopes, 'bash');
      expect(toolCall?.status).toBe('completed');
    });

    it('a dangerous bash command escalates to a human: approval.requested appears on the stream; allow lets the turn continue through to turn.result', async () => {
      const app = buildApp(() =>
        toolCallThenStopModel(
          'bash',
          { command: 'git push origin main' },
          'call_1',
          'pushed it',
        ),
      );
      const created = await createSession(app);

      await app.request(`/api/chat/sessions/${created.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'push my branch' }),
      });

      const streamResponse = await app.request(
        `/api/chat/sessions/${created.id}/stream`,
      );
      const reader = createIncrementalReader(streamResponse);
      const requested = await reader.readUntil((envs) =>
        envs.some((e) => e.event.type === 'approval.requested'),
      );
      const requestedEvent = requested.find(
        (e) => e.event.type === 'approval.requested',
      );
      expect(requestedEvent).toBeDefined();
      expect(requestedEvent?.event.toolName).toBe('bash');
      const callId = extractStringField(requestedEvent?.event ?? {}, 'callId');

      const approveResponse = await app.request(
        `/api/chat/sessions/${created.id}/approvals/${callId}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ behavior: 'allow' }),
        },
      );
      expect(approveResponse.status).toBe(200);
      expect(await approveResponse.json()).toEqual({ ok: true });

      const envelopes = await reader.drainToClose();
      const resolvedEvent = envelopes.find(
        (e) => e.event.type === 'approval.resolved',
      );
      expect(resolvedEvent?.event).toEqual({
        type: 'approval.resolved',
        callId,
        behavior: 'allow',
      });
      expect(envelopes.at(-1)?.event.type).toBe('turn.result');

      const toolCall = findCompletedToolCall(envelopes, 'bash');
      expect(toolCall?.status).toBe('completed');
    });

    it('a dangerous bash command escalates to a human: deny resolves approval.resolved(deny) and the tool_call item completes with status "denied", the turn still reaching turn.result', async () => {
      const app = buildApp(() =>
        toolCallThenStopModel(
          'bash',
          { command: 'rm -rf /workspace/build' },
          'call_1',
          'ok, skipped that',
        ),
      );
      const created = await createSession(app);

      await app.request(`/api/chat/sessions/${created.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'clean the build dir' }),
      });

      const streamResponse = await app.request(
        `/api/chat/sessions/${created.id}/stream`,
      );
      const reader = createIncrementalReader(streamResponse);
      const requested = await reader.readUntil((envs) =>
        envs.some((e) => e.event.type === 'approval.requested'),
      );
      const requestedEvent = requested.find(
        (e) => e.event.type === 'approval.requested',
      );
      const callId = extractStringField(requestedEvent?.event ?? {}, 'callId');

      const denyResponse = await app.request(
        `/api/chat/sessions/${created.id}/approvals/${callId}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ behavior: 'deny', message: 'too risky' }),
        },
      );
      expect(denyResponse.status).toBe(200);

      const envelopes = await reader.drainToClose();
      const resolvedEvent = envelopes.find(
        (e) => e.event.type === 'approval.resolved',
      );
      expect(resolvedEvent?.event).toEqual({
        type: 'approval.resolved',
        callId,
        behavior: 'deny',
        message: 'too risky',
      });
      expect(envelopes.at(-1)?.event.type).toBe('turn.result');

      const toolCall = findCompletedToolCall(envelopes, 'bash');
      expect(toolCall?.status).toBe('denied');
      expect(toolCall?.output).toBe('too risky');
    });

    it('ask_user: question.asked appears on the stream; POST .../questions/:callId answers it and the turn continues through to turn.result', async () => {
      const app = buildApp(() =>
        toolCallThenStopModel(
          'ask_user',
          {
            question: 'which environment should I target?',
            options: ['staging', 'prod'],
          },
          'call_1',
          'got it, using staging',
        ),
      );
      const created = await createSession(app);

      await app.request(`/api/chat/sessions/${created.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'deploy it' }),
      });

      const streamResponse = await app.request(
        `/api/chat/sessions/${created.id}/stream`,
      );
      const reader = createIncrementalReader(streamResponse);
      const asked = await reader.readUntil((envs) =>
        envs.some((e) => e.event.type === 'question.asked'),
      );
      const askedEvent = asked.find((e) => e.event.type === 'question.asked');
      expect(askedEvent?.event).toEqual({
        type: 'question.asked',
        callId: expect.any(String),
        question: 'which environment should I target?',
        options: ['staging', 'prod'],
      });
      const callId = extractStringField(askedEvent?.event ?? {}, 'callId');

      const answerResponse = await app.request(
        `/api/chat/sessions/${created.id}/questions/${callId}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ answer: 'staging' }),
        },
      );
      expect(answerResponse.status).toBe(200);
      expect(await answerResponse.json()).toEqual({ ok: true });

      const envelopes = await reader.drainToClose();
      const answeredEvent = envelopes.find(
        (e) => e.event.type === 'question.answered',
      );
      expect(answeredEvent?.event).toEqual({
        type: 'question.answered',
        callId,
        outcome: 'answered',
        answer: 'staging',
      });
      expect(envelopes.at(-1)?.event.type).toBe('turn.result');

      const toolCall = findCompletedToolCall(envelopes, 'ask_user');
      expect(toolCall?.status).toBe('completed');
      expect(toolCall?.output).toBe('staging');
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
        `/api/chat/sessions/does-not-exist/approvals/call_1`,
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
        `/api/chat/sessions/${created.id}/approvals/call_1`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ behavior: 'allow' }),
        },
      );
      expect(otherUserResponse.status).toBe(404);

      // 3. callId with no pending approval at all (nothing has been posted yet)
      const noPendingResponse = await app.request(
        `/api/chat/sessions/${created.id}/approvals/never-requested`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ behavior: 'allow' }),
        },
      );
      expect(noPendingResponse.status).toBe(404);

      // 3b. re-deciding an already-resolved callId also 404s
      await app.request(`/api/chat/sessions/${created.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'push it' }),
      });
      const streamResponse = await app.request(
        `/api/chat/sessions/${created.id}/stream`,
      );
      const reader = createIncrementalReader(streamResponse);
      const requested = await reader.readUntil((envs) =>
        envs.some((e) => e.event.type === 'approval.requested'),
      );
      const requestedEvent = requested.find(
        (e) => e.event.type === 'approval.requested',
      );
      const callId = extractStringField(requestedEvent?.event ?? {}, 'callId');

      const firstDecision = await app.request(
        `/api/chat/sessions/${created.id}/approvals/${callId}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ behavior: 'allow' }),
        },
      );
      expect(firstDecision.status).toBe(200);

      const secondDecision = await app.request(
        `/api/chat/sessions/${created.id}/approvals/${callId}`,
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
          'ask_user',
          { question: 'continue?' },
          'call_1',
          'ok',
        ),
      );
      const created = await createSession(app);

      const unknownSessionResponse = await app.request(
        `/api/chat/sessions/does-not-exist/questions/call_1`,
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
        `/api/chat/sessions/${created.id}/questions/call_1`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ answer: 'yes' }),
        },
      );
      expect(otherUserResponse.status).toBe(404);

      const noPendingResponse = await app.request(
        `/api/chat/sessions/${created.id}/questions/never-asked`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ answer: 'yes' }),
        },
      );
      expect(noPendingResponse.status).toBe(404);

      // Empty answer never even reaches resolveUserAnswer — PostAnswerInputSchema requires min(1).
      const emptyAnswerResponse = await app.request(
        `/api/chat/sessions/${created.id}/questions/never-asked`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ answer: '' }),
        },
      );
      expect(emptyAnswerResponse.status).toBe(400);
    });

    it('an approval "allow" decision still succeeds (200 + approval.resolved still emitted) even when sandboxManager.touch rejects', async () => {
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
      await app.request(`/api/chat/sessions/${created.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'push it' }),
      });

      const streamResponse = await app.request(
        `/api/chat/sessions/${created.id}/stream`,
      );
      const reader = createIncrementalReader(streamResponse);
      const requested = await reader.readUntil((envs) =>
        envs.some((e) => e.event.type === 'approval.requested'),
      );
      const requestedEvent = requested.find(
        (e) => e.event.type === 'approval.requested',
      );
      const callId = extractStringField(requestedEvent?.event ?? {}, 'callId');

      // This is the second touch() call — it rejects internally, but the
      // route must swallow it and still resolve the approval.
      const approveResponse = await app.request(
        `/api/chat/sessions/${created.id}/approvals/${callId}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ behavior: 'allow' }),
        },
      );
      expect(approveResponse.status).toBe(200);
      expect(await approveResponse.json()).toEqual({ ok: true });

      const envelopes = await reader.drainToClose();
      const resolvedEvent = envelopes.find(
        (e) => e.event.type === 'approval.resolved',
      );
      expect(resolvedEvent?.event).toEqual({
        type: 'approval.resolved',
        callId,
        behavior: 'allow',
      });
      expect(envelopes.at(-1)?.event.type).toBe('turn.result');
    });
  });
});
