import { randomUUID } from 'node:crypto';

import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type {
  ApprovalDecision,
  ApprovalPolicy,
  SessionState,
} from '@nimbo/core';
import { sessionStateSchema } from '@nimbo/core';
import type { LanguageModel } from 'ai';
import type { MiddlewareHandler } from 'hono';
import { streamSSE } from 'hono/streaming';

import {
  resolveApprovalMode,
  shouldAutoAllow,
} from '../agent/approval-policy.js';
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
import type {
  AskUserOutcome,
  RequestUserAnswerInput,
} from '../agent/turn-runner.js';
import {
  isTurnActive,
  requestApproval,
  requestUserAnswer,
  resolveApproval,
  resolveUserAnswer,
  startTurn,
  steerTurn,
  subscribeTurn,
} from '../agent/turn-runner.js';
import { db as defaultDb } from '../db/instance.js';
import { requireAuth } from '../middleware/auth.js';
import { ErrorSchema } from '../schemas/api.js';
import type { ChatEventEnvelope, ChatSessionDto } from '../schemas/chat.js';
import {
  ApprovalAckSchema,
  ChatApprovalParamsSchema,
  chatEventEnvelopeSchema,
  ChatEventsListSchema,
  ChatEventsQuerySchema,
  ChatSessionParamsSchema,
  ChatSessionSchema,
  chatStreamEventSchema,
  CreateChatSessionInputSchema,
  PostAnswerInputSchema,
  PostApprovalInputSchema,
  PostChatMessageInputSchema,
  StartTurnAckSchema,
} from '../schemas/chat.js';

// ---------------------------------------------------------------------------
// docs/08-chat-agent-webapp.md §2.2 `routes/chat.ts` (+ §2.2c（审批链）'s
// `POST .../approvals/:callId` and `POST .../questions/:callId`) — seven
// endpoints, login required on all of them (same `requireAuth` middleware as
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
      'Start a turn for this message, or steer an in-progress one (STEER-3B): if the session has a turn running, `text` is injected into it via `Session.steer()` (mode "steered"); otherwise this acquires the sandbox, builds the session, and hands off to the in-process turn runner (mode "started"). Either way, events arrive over `GET .../stream`, not this response',
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
          'Accepted — see `mode` ("started" | "steered"); poll/stream `GET .../stream` for its events',
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
        description:
          'A turn is already in progress for this session and could not be steered either (narrow race — the turn ended between the steer attempt and the fallback start)',
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

    // STEER-3B: try steering an in-progress turn first — cheap (no sandbox
    // acquisition/session rebuild needed, `Session.steer()` just queues into
    // the already-running turn). `false` covers both "no turn is active" and
    // the narrow race where the turn just ended; either way, falling through
    // to the normal start-a-new-turn flow below is correct. No `user.message`
    // echo is emitted for a steered message — see docs/08 §2.2 "契约细化" #3:
    // the injected `user_message` item nimbo's loop produces at the real
    // injection point is its one persisted record.
    if (steerTurn(id, text)) {
      try {
        await deps.sandboxManager.touch(id); // still rolls the sandbox's idle timeout forward, same as a fresh turn
      } catch (error) {
        return c.json({ error: describeError(error) }, 500);
      }
      return c.json({ ok: true as const, mode: 'steered' as const }, 202);
    }

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

    // docs/08 §2.2c（审批链）: the session-level `ApprovalPolicy` bridge —
    // `shouldAutoAllow` decides on the spot; anything it doesn't clear is
    // routed to `turn-runner.ts`'s `requestApproval`, which suspends this
    // turn until a human (or a timeout) resolves it via
    // `POST .../approvals/:callId`. Captures `id` (the *chat* session id,
    // this route's own path param) — not `ctx.session.id`, which is
    // `@nimbo/core`'s own internal session id and means nothing to
    // `turn-runner.ts`'s `activeTurns` map.
    const approvalMode = resolveApprovalMode();
    const onApproval: ApprovalPolicy = (input, ctx) =>
      shouldAutoAllow(approvalMode, ctx.toolName, input) ?
        { behavior: 'allow' as const }
      : requestApproval(id, {
          callId: ctx.callId,
          toolName: ctx.toolName,
          input,
        });

    // docs/08 §2.2c（审批链）: the ask_user bridge — same "captures `id`, not
    // an internal id" discipline as `onApproval` above. Always wired in
    // (unlike `onApproval`'s auto-allow branch, there's no "skip asking"
    // mode for `ask_user` — see `chat-agent.ts`'s `BuildSessionOptions.onAskUser`).
    const onAskUser = (req: RequestUserAnswerInput): Promise<AskUserOutcome> =>
      requestUserAnswer(id, req);

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
        onApproval,
        approvalMode,
        onAskUser,
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
    return c.json({ ok: true as const, mode: 'started' as const }, 202);
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
          'SSE stream of `{ seq, event }` frames: replay, then live tail (closes once the turn ends, or immediately after replay if no turn is in progress). Some frames omit `seq` (docs/08 §2.2d) — those are ephemeral `item.updated` typewriter ticks, never persisted and never replayed; every other frame always carries one',
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

      // Flips true once the persisted replay (below) has been fully flushed
      // to this connection — see the ephemeral-drop rule in the `subscribeTurn`
      // callback right below it (docs/08 §2.2d "tail 的回归竞态").
      let replayDone = false;

      const unsubscribe = subscribeTurn(
        id,
        (envelope) => {
          // An ephemeral `item.updated` tick (no `seq`, docs/08 §2.2d) that
          // arrives while we're still replaying persisted history is
          // strictly older than (or a duplicate of) whatever the replay is
          // about to send for that same item — forwarding it would clobber
          // an already-sent `item.completed` with stale, half-written text
          // and no completed marker to follow it (the real completed tick
          // was already replayed). It carries zero replay value on its own
          // (ephemeral frames only matter live), so it's simply dropped —
          // never buffered, never sent. Once the replay is done, any
          // ephemeral tick that arrives necessarily belongs to an item still
          // in progress (its `item.completed`, if any, can only come later),
          // so it's safe to buffer and forward like any other live event.
          if (envelope.seq === undefined && !replayDone) return;
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
            if (envelope.seq === undefined) {
              // Ephemeral (docs/08 §2.2d) — forward as-is, no `maxSentSeq`
              // bookkeeping (there's no seq to dedupe or advance by).
              await stream.writeSSE({
                event: envelope.event.type,
                data: JSON.stringify(envelope),
              });
              continue;
            }
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
        replayDone = true;

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

  // ---- POST /api/chat/sessions/{id}/approvals/{callId} (resolve a pending approval, docs/08 §2.2c（审批链）) ----

  const postApprovalRoute = createRoute({
    method: 'post',
    path: '/api/chat/sessions/{id}/approvals/{callId}',
    tags: ['Chat'],
    summary:
      '批准或拒绝一个待处理的工具调用审批请求（docs/08 §2.2c（审批链））：结果通过 `GET .../stream` 的 `approval.resolved` 事件送达，本响应只是一个 ack',
    request: {
      params: ChatApprovalParamsSchema,
      body: {
        content: { 'application/json': { schema: PostApprovalInputSchema } },
        required: true,
      },
    },
    responses: {
      200: {
        content: { 'application/json': { schema: ApprovalAckSchema } },
        description: 'Resolved',
      },
      401: {
        content: { 'application/json': { schema: ErrorSchema } },
        description: 'Unauthorized',
      },
      404: {
        content: { 'application/json': { schema: ErrorSchema } },
        description:
          'Not found — either this session doesn’t exist (or isn’t the caller’s), or `callId` has no pending approval on it (already resolved, timed out, or never existed)',
      },
    },
  });

  app.openapi(postApprovalRoute, async (c) => {
    const userId = c.get('userId');
    const { id, callId } = c.req.valid('param');
    const { behavior, message } = c.req.valid('json');

    const row = getChatSession(deps.db, id, userId);
    if (row === undefined) return c.json({ error: 'Not found' }, 404);

    if (behavior === 'allow') {
      // Rolls the sandbox's idle timeout forward, same as every other
      // in-turn touch point — but must never block the decision itself: if
      // `touch()` throws (sandbox already gone, transient Vercel error), the
      // pending tool call still needs resolving, or it just hangs until
      // `requestApproval`'s own timeout denies it anyway (worse than letting
      // `exec()` itself surface whatever sandbox-availability problem there
      // is as a normal tool failure).
      try {
        await deps.sandboxManager.touch(id);
      } catch {
        // intentionally swallowed — see comment above
      }
    }

    const decision: ApprovalDecision =
      behavior === 'allow' ?
        { behavior: 'allow' }
      : { behavior: 'deny', ...(message !== undefined ? { message } : {}) }; // no message → core's own default deny text (routes/chat.ts never invents one)

    const resolved = resolveApproval(id, callId, decision);
    if (!resolved) return c.json({ error: 'Not found' }, 404);

    return c.json({ ok: true as const }, 200);
  });

  // ---- POST /api/chat/sessions/{id}/questions/{callId} (answer a pending ask_user question, docs/08 §2.2c（审批链）) ----

  const postAnswerRoute = createRoute({
    method: 'post',
    path: '/api/chat/sessions/{id}/questions/{callId}',
    tags: ['Chat'],
    summary:
      '回答一个待处理的 ask_user 提问（docs/08 §2.2c（审批链））：结果通过 `GET .../stream` 的 `question.answered` 事件送达，本响应只是一个 ack',
    request: {
      params: ChatApprovalParamsSchema,
      body: {
        content: { 'application/json': { schema: PostAnswerInputSchema } },
        required: true,
      },
    },
    responses: {
      200: {
        content: { 'application/json': { schema: ApprovalAckSchema } },
        description: 'Resolved',
      },
      401: {
        content: { 'application/json': { schema: ErrorSchema } },
        description: 'Unauthorized',
      },
      404: {
        content: { 'application/json': { schema: ErrorSchema } },
        description:
          'Not found — either this session doesn’t exist (or isn’t the caller’s), or `callId` has no pending question on it (already answered, timed out, or never existed)',
      },
    },
  });

  app.openapi(postAnswerRoute, async (c) => {
    const userId = c.get('userId');
    const { id, callId } = c.req.valid('param');
    const { answer } = c.req.valid('json');

    const row = getChatSession(deps.db, id, userId);
    if (row === undefined) return c.json({ error: 'Not found' }, 404);

    // Unconditional (unlike the approval route's `allow`-only branch —
    // answering a question always lets the turn continue, there is no "deny"
    // analog here): must never block the answer itself, same rationale as
    // the approval route's own touch-failure comment above.
    try {
      await deps.sandboxManager.touch(id);
    } catch {
      // intentionally swallowed — see comment above
    }

    const resolved = resolveUserAnswer(id, callId, answer);
    if (!resolved) return c.json({ error: 'Not found' }, 404);

    return c.json({ ok: true as const }, 200);
  });

  return app;
}

export const chatApp = createChatApp({
  db: defaultDb,
  sandboxManager: createSandboxManager(createVercelSandboxClient()),
  resolveModel,
  authMiddleware: requireAuth,
});
