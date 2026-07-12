import { randomUUID } from 'node:crypto';

import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { SessionState } from '@nimbo/core';
import { sessionStateSchema } from '@nimbo/core';
import type { LanguageModel } from 'ai';
import type { MiddlewareHandler } from 'hono';
import { streamSSE } from 'hono/streaming';

import { buildSession } from '../agent/chat-agent.js';
import type { GitHubRepoRef } from '../agent/github-repo.js';
import { resolveGithubPat, resolveRepo } from '../agent/github-repo.js';
import { resolveModel } from '../agent/model.js';
import type {
  AcquiredSandbox,
  SandboxManager,
} from '../agent/sandbox-manager.js';
import {
  createSandboxManager,
  createVercelSandboxClient,
  resolveIdleTimeoutMs,
} from '../agent/sandbox-manager.js';
import type { ChatSessionRow, Db } from '../agent/store.js';
import {
  createChatSession,
  getChatSession,
  listAgentEvents,
  listChatSessions,
} from '../agent/store.js';
import {
  isTurnActive,
  startTurn,
  subscribeTurn,
} from '../agent/turn-runner.js';
import { db as defaultDb } from '../db/instance.js';
import { requireAuth } from '../middleware/auth.js';
import { ErrorSchema } from '../schemas/api.js';
import type { ChatEventEnvelope, ChatSessionDto } from '../schemas/chat.js';
import {
  chatEventEnvelopeSchema,
  ChatEventsListSchema,
  ChatEventsQuerySchema,
  ChatSessionParamsSchema,
  ChatSessionSchema,
  chatStreamEventSchema,
  CreateChatSessionInputSchema,
  PostChatMessageInputSchema,
  StartTurnAckSchema,
} from '../schemas/chat.js';

// ---------------------------------------------------------------------------
// docs/08-chat-agent-webapp.md §2.2 `routes/chat.ts` — five endpoints, login
// required on all of them (same `requireAuth` middleware as
// `routes/example.ts`).
// ---------------------------------------------------------------------------

type ChatEnv = { Variables: { userId: string } };

export interface ChatRouteDeps {
  db: Db;
  sandboxManager: SandboxManager;
  resolveModel: () => LanguageModel;
  /**
   * Injectable so integration tests can stand in a fixed-`userId` stub
   * instead of exercising real better-auth (which is hardwired to the
   * singleton `db`/`auth` in `middleware/auth.ts`/`auth.ts`, not whatever
   * `Db` a test passes in) — the default export below wires in the real
   * `requireAuth`, so production behavior is unchanged.
   */
  authMiddleware: MiddlewareHandler<ChatEnv>;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toChatSessionDto(row: ChatSessionRow): ChatSessionDto {
  // `sleeping` is derived at read time, never stored: hibernation happens on
  // Vercel's side when the idle timeout elapses (no server-side timer to flip
  // the row — docs/08 §2.2), so a stored `active` whose idle window has passed
  // is presented as `sleeping`. P12-3 live verification caught the stored
  // status going stale exactly this way. The next message's `acquire` resumes
  // the sandbox and `touch` refreshes `lastActiveAt`, flipping it back.
  const idleElapsed =
    Date.now() - row.lastActiveAt.getTime() > resolveIdleTimeoutMs();
  return {
    id: row.id,
    title: row.title,
    repo: row.repo,
    branchName: row.branchName,
    sandboxName: row.sandboxName,
    status: row.status === 'active' && idleElapsed ? 'sleeping' : row.status,
    lastActiveAt: row.lastActiveAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

/** `chat_sessions.nimbo_state_json` round-trip: our own previously-serialized data, validated the same way `@nimbo/core`'s `createSession({ resume })` validates it internally (defense in depth, not redundant — this is the deserialization boundary). */
function parseResumeState(
  nimboStateJson: string | null,
): SessionState | undefined {
  if (nimboStateJson === null) return undefined;
  return sessionStateSchema.parse(JSON.parse(nimboStateJson));
}

function generateSandboxName(sessionId: string): string {
  return `nimbo-chat-${sessionId}`;
}

function generateBranchName(sessionId: string): string {
  return `nimbo/chat-${sessionId}`;
}

export function createChatApp(deps: ChatRouteDeps) {
  const app = new OpenAPIHono<ChatEnv>();
  app.use('/api/chat/*', deps.authMiddleware);

  // ---- POST /api/chat/sessions ----

  const createSessionRoute = createRoute({
    method: 'post',
    path: '/api/chat/sessions',
    tags: ['Chat'],
    summary:
      'Create a chat session (provisions a Vercel sandbox + a dedicated git branch)',
    request: {
      body: {
        content: {
          'application/json': { schema: CreateChatSessionInputSchema },
        },
        required: true,
      },
    },
    responses: {
      201: {
        content: { 'application/json': { schema: ChatSessionSchema } },
        description: 'Created',
      },
      401: {
        content: { 'application/json': { schema: ErrorSchema } },
        description: 'Unauthorized',
      },
      500: {
        content: { 'application/json': { schema: ErrorSchema } },
        description: 'Repo/sandbox configuration or provisioning error',
      },
    },
  });

  app.openapi(createSessionRoute, async (c) => {
    const userId = c.get('userId');
    const input = c.req.valid('json');

    let repoRef: GitHubRepoRef;
    let githubPat: string;
    try {
      repoRef = resolveRepo();
      githubPat = resolveGithubPat();
    } catch (error) {
      return c.json({ error: describeError(error) }, 500);
    }

    const sessionId = randomUUID();
    const sandboxName = generateSandboxName(sessionId);
    const branchName = generateBranchName(sessionId);

    try {
      await deps.sandboxManager.acquire({
        sessionId,
        sandboxName,
        branchName,
        repoCloneUrl: repoRef.cloneUrl,
        repoOwner: repoRef.owner,
        repoName: repoRef.repo,
        githubPat,
      });
    } catch (error) {
      return c.json({ error: describeError(error) }, 500);
    }

    const row = createChatSession(deps.db, {
      id: sessionId,
      userId,
      title: input.title ?? 'New chat',
      repo: `${repoRef.owner}/${repoRef.repo}`,
      branchName,
      sandboxName,
    });
    return c.json(toChatSessionDto(row), 201);
  });

  // ---- GET /api/chat/sessions ----

  const listSessionsRoute = createRoute({
    method: 'get',
    path: '/api/chat/sessions',
    tags: ['Chat'],
    summary: 'List the current user’s chat sessions',
    responses: {
      200: {
        content: { 'application/json': { schema: z.array(ChatSessionSchema) } },
        description: 'Sessions',
      },
      401: {
        content: { 'application/json': { schema: ErrorSchema } },
        description: 'Unauthorized',
      },
    },
  });

  app.openapi(listSessionsRoute, (c) => {
    const userId = c.get('userId');
    const rows = listChatSessions(deps.db, userId);
    return c.json(rows.map(toChatSessionDto), 200);
  });

  // ---- GET /api/chat/sessions/{id} ----

  const getSessionRoute = createRoute({
    method: 'get',
    path: '/api/chat/sessions/{id}',
    tags: ['Chat'],
    summary: 'Get one chat session’s detail (including status)',
    request: { params: ChatSessionParamsSchema },
    responses: {
      200: {
        content: { 'application/json': { schema: ChatSessionSchema } },
        description: 'Session',
      },
      401: {
        content: { 'application/json': { schema: ErrorSchema } },
        description: 'Unauthorized',
      },
      404: {
        content: { 'application/json': { schema: ErrorSchema } },
        description: 'Not found',
      },
    },
  });

  app.openapi(getSessionRoute, (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    const row = getChatSession(deps.db, id, userId);
    if (row === undefined) return c.json({ error: 'Not found' }, 404);
    return c.json(toChatSessionDto(row), 200);
  });

  // ---- GET /api/chat/sessions/{id}/events?after=<seq> ----

  const listEventsRoute = createRoute({
    method: 'get',
    path: '/api/chat/sessions/{id}/events',
    tags: ['Chat'],
    summary: 'Replay a session’s persisted agent events (reconnection/history)',
    request: { params: ChatSessionParamsSchema, query: ChatEventsQuerySchema },
    responses: {
      200: {
        content: {
          'application/json': { schema: ChatEventsListSchema },
        },
        description: 'Events, in seq order',
      },
      401: {
        content: { 'application/json': { schema: ErrorSchema } },
        description: 'Unauthorized',
      },
      404: {
        content: { 'application/json': { schema: ErrorSchema } },
        description: 'Not found',
      },
    },
  });

  app.openapi(listEventsRoute, (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    const { after } = c.req.valid('query');
    const row = getChatSession(deps.db, id, userId);
    if (row === undefined) return c.json({ error: 'Not found' }, 404);

    const rows = listAgentEvents(deps.db, id, after);
    const envelopes: ChatEventEnvelope[] = rows.map((eventRow) => ({
      seq: eventRow.seq,
      event: chatStreamEventSchema.parse(JSON.parse(eventRow.payloadJson)),
    }));
    return c.json({ events: envelopes }, 200);
  });

  // ---- POST /api/chat/sessions/{id}/messages (starts a turn, docs/08 §2.2b) ----

  const postMessageRoute = createRoute({
    method: 'post',
    path: '/api/chat/sessions/{id}/messages',
    tags: ['Chat'],
    summary:
      'Start a turn for this message (docs/08 §2.2b): acquires the sandbox, builds the session, and hands off to the in-process turn runner — the turn’s events arrive over `GET .../stream`, not this response',
    request: {
      params: ChatSessionParamsSchema,
      body: {
        content: { 'application/json': { schema: PostChatMessageInputSchema } },
        required: true,
      },
    },
    responses: {
      202: {
        content: { 'application/json': { schema: StartTurnAckSchema } },
        description:
          'Turn started; poll/stream `GET .../stream` for its events',
      },
      401: {
        content: { 'application/json': { schema: ErrorSchema } },
        description: 'Unauthorized',
      },
      404: {
        content: { 'application/json': { schema: ErrorSchema } },
        description: 'Not found',
      },
      409: {
        content: { 'application/json': { schema: ErrorSchema } },
        description: 'A turn is already in progress for this session',
      },
      500: {
        content: { 'application/json': { schema: ErrorSchema } },
        description: 'Model/sandbox configuration or provisioning error',
      },
    },
  });

  app.openapi(postMessageRoute, async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    const { text } = c.req.valid('json');

    const row = getChatSession(deps.db, id, userId);
    if (row === undefined) return c.json({ error: 'Not found' }, 404);

    let model: LanguageModel;
    let repoRef: GitHubRepoRef;
    let githubPat: string;
    try {
      model = deps.resolveModel();
      repoRef = resolveRepo();
      githubPat = resolveGithubPat();
    } catch (error) {
      return c.json({ error: describeError(error) }, 500);
    }

    let acquired: AcquiredSandbox;
    try {
      acquired = await deps.sandboxManager.acquire({
        sessionId: id,
        sandboxName: row.sandboxName,
        branchName: row.branchName,
        repoCloneUrl: repoRef.cloneUrl,
        repoOwner: repoRef.owner,
        repoName: repoRef.repo,
        githubPat,
      });
      await deps.sandboxManager.touch(id); // every user message rolls the sandbox's idle timeout forward — see docs/08 §2.2
    } catch (error) {
      return c.json({ error: describeError(error) }, 500);
    }

    let session;
    try {
      session = await buildSession({
        model,
        workspace: acquired.workspace,
        repoOwner: repoRef.owner,
        repoName: repoRef.repo,
        defaultBranch: acquired.defaultBranch,
        branchName: row.branchName,
        resume: parseResumeState(row.nimboStateJson),
      });
    } catch (error) {
      return c.json({ error: describeError(error) }, 500);
    }

    const { started } = startTurn({
      db: deps.db,
      sessionId: id,
      session,
      text,
    });
    if (!started) {
      return c.json({ error: 'turn already in progress' }, 409);
    }
    return c.json({ ok: true as const }, 202);
  });

  // ---- GET /api/chat/sessions/{id}/stream?after=<seq> (resumable live tail, docs/08 §2.2b) ----

  const streamTurnRoute = createRoute({
    method: 'get',
    path: '/api/chat/sessions/{id}/stream',
    tags: ['Chat'],
    summary:
      'Resumable live tail of a session’s in-progress turn (docs/08 §2.2b): replays persisted events after `after`, then forwards the turn’s live events until it ends — reconnect-safe (page refresh/HMR/network blip never lose events)',
    request: { params: ChatSessionParamsSchema, query: ChatEventsQuerySchema },
    responses: {
      200: {
        content: { 'text/event-stream': { schema: chatEventEnvelopeSchema } },
        description:
          'SSE stream of `{ seq, event }` frames: replay, then live tail (closes once the turn ends, or immediately after replay if no turn is in progress)',
      },
      401: {
        content: { 'application/json': { schema: ErrorSchema } },
        description: 'Unauthorized',
      },
      404: {
        content: { 'application/json': { schema: ErrorSchema } },
        description: 'Not found',
      },
    },
  });

  app.openapi(streamTurnRoute, async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    const { after } = c.req.valid('query');

    const row = getChatSession(deps.db, id, userId);
    if (row === undefined) return c.json({ error: 'Not found' }, 404);

    return streamSSE(c, async (stream) => {
      // Buffer everything the emitter delivers while we're busy replaying
      // history below — subscribing *before* the replay query (rather than
      // after) is what guarantees nothing lands in the gap between them
      // (docs/08 §2.2b).
      const buffered: ChatEventEnvelope[] = [];
      let turnDone = false;
      let wake: () => void = () => undefined;
      let waitForMore = new Promise<void>((resolve) => {
        wake = resolve;
      });

      function scheduleWake(): void {
        const resolve = wake;
        waitForMore = new Promise((next) => {
          wake = next;
        });
        resolve();
      }

      const unsubscribe = subscribeTurn(
        id,
        (envelope) => {
          buffered.push(envelope);
          scheduleWake();
        },
        () => {
          turnDone = true;
          scheduleWake();
        },
      );
      // Captured once, right after subscribing: if there was nothing to
      // subscribe to, `onDone` above will never fire, so this (not `turnDone`)
      // is what tells the loop below "don't wait, just close after replay".
      const wasActive = isTurnActive(id);

      let aborted = false;
      stream.onAbort(() => {
        aborted = true;
        unsubscribe();
        scheduleWake();
      });

      try {
        let maxSentSeq = after ?? 0;

        async function flushBuffered(): Promise<void> {
          for (;;) {
            const envelope = buffered.shift();
            if (envelope === undefined) break;
            if (envelope.seq <= maxSentSeq) continue; // already covered by the replay query below — dedup
            await stream.writeSSE({
              event: envelope.event.type,
              data: JSON.stringify(envelope),
            });
            maxSentSeq = envelope.seq;
          }
        }

        const persistedRows = listAgentEvents(deps.db, id, after);
        for (const eventRow of persistedRows) {
          const envelope: ChatEventEnvelope = {
            seq: eventRow.seq,
            event: chatStreamEventSchema.parse(
              JSON.parse(eventRow.payloadJson),
            ),
          };
          await stream.writeSSE({
            event: envelope.event.type,
            data: JSON.stringify(envelope),
          });
          maxSentSeq = eventRow.seq;
        }

        await flushBuffered();

        if (wasActive) {
          while (!turnDone && !aborted) {
            await waitForMore;
            await flushBuffered();
          }
        }
      } finally {
        unsubscribe();
      }
    });
  });

  return app;
}

export const chatApp = createChatApp({
  db: defaultDb,
  sandboxManager: createSandboxManager(createVercelSandboxClient()),
  resolveModel,
  authMiddleware: requireAuth,
});
