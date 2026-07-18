import { randomUUID } from 'node:crypto';

import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type {
  ApprovalPolicy,
  ApprovalReviewer,
  HumanDecision,
  SessionState,
  SessionTelemetry,
} from '@nimbo/core';
import { sessionStateSchema } from '@nimbo/core';
import type { LanguageModel } from 'ai';
import type { MiddlewareHandler } from 'hono';
import { streamSSE } from 'hono/streaming';

import {
  classifyApproval,
  resolveApprovalMode,
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
import { hasSessionGrant } from '../agent/session-grants.js';
import type {
  ConversationEventRow,
  ConversationRow,
  Db,
} from '../agent/store.js';
import {
  createConversation,
  getConversation,
  listConversationEvents,
  listConversations,
} from '../agent/store.js';
import type {
  AskUserOutcome,
  RequestUserAnswerInput,
} from '../agent/turn-runner.js';
import {
  isTurnActive,
  requestReview,
  requestUserAnswer,
  resolveReview,
  resolveUserAnswer,
  startTurn,
  steerTurn,
  subscribeTurn,
} from '../agent/turn-runner.js';
import { db as defaultDb } from '../db/instance.js';
import { requireAuth } from '../middleware/auth.js';
import { ErrorSchema } from '../schemas/api.js';
import type { ChatReplayFrame, ConversationDto } from '../schemas/chat.js';
import {
  ApprovalAckSchema,
  ChatApprovalParamsSchema,
  chatReplayFrameSchema,
  chunkEnvelopeSchema,
  ConversationEventsListSchema,
  ConversationEventsQuerySchema,
  ConversationParamsSchema,
  ConversationSchema,
  CreateConversationInputSchema,
  messageFrameSchema,
  PostAnswerInputSchema,
  PostApprovalInputSchema,
  PostChatMessageInputSchema,
  StartTurnAckSchema,
  TurnTelemetryParamsSchema,
  TurnTelemetrySchema,
} from '../schemas/chat.js';
import type { TelemetryStore } from '../telemetry.js';
import { getChatTelemetry, getChatTelemetryStore } from '../telemetry.js';

// ---------------------------------------------------------------------------
// docs/tech/chat-webapp.md §2.2 `routes/chat.ts` (+ §2.2c（审批链）'s
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
  /** telemetry 事件集成（`@nimbo/core` `SessionTelemetry`，docs/tech/chat-webapp.md §11.4）——注入后逐 turn 的模型调用事件落 SQLite；缺省 undefined = 不采集。生产默认装配见文件底部（`getChatTelemetry`）。 */
  telemetry?: SessionTelemetry;
  /** 同上的读侧：turn 遥测明细端点用它查数（`TelemetryStore.list`）；缺省 undefined = 端点恒返回空数组。 */
  telemetryStore?: TelemetryStore;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toConversationDto(row: ConversationRow): ConversationDto {
  // `sleeping` is derived at read time, never stored: hibernation happens on
  // Vercel's side when the idle timeout elapses (no server-side timer to flip
  // the row — docs/tech/chat-webapp.md §2.2), so a stored `active` whose idle window has passed
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

/**
 * Reassembles a `SessionState` from the UIMessage 单账本 (docs/tech/single-ledger.md §5 单-3): the session-scalar header (`row.agentSessionId`/
 * `agentSessionCreatedAt`/`agentSessionTurn`, `db/schema.ts`'s own doc comment) plus every
 * `kind = 'message'` row for this session, in seq order. `row.agentSessionId
 * === null` means this chat session has never completed a turn yet (no
 * nimbo `SessionState` has ever existed for it) — `undefined` here is what
 * tells `chat-agent.ts`'s `buildSession` to let `@nimbo/core` mint a fresh
 * one instead of resuming.
 *
 * Reuses `@nimbo/core`'s own exported `sessionStateSchema` (the same schema
 * `createSession({ resume })` validates against internally, defense in
 * depth, not redundant — this is the deserialization boundary) rather than
 * hand-rolling a `NimboUIMessage[]` validator here — the reassembled object
 * has the exact same shape a single `Session.toJSON()` blob used to, just
 * sourced from separate rows instead of one JSON column.
 */
function loadResumeState(
  db: Db,
  row: ConversationRow,
): SessionState | undefined {
  // Resume off the persisted `kind = 'message'` rows, not the scalar header:
  // the header (`agentSessionId`/`agentSessionTurn`/`agentSessionCreatedAt`) is only written
  // by `finalizeTurnPersistence` on a *graceful* turn finish, but a
  // turn-start user message row (turn-runner.ts) lands the moment a turn
  // begins. So a first turn that *crashed* (driveTurn's `catch`, header never
  // written) still leaves one `kind = 'message'` row — and it's replayed to
  // the UI. Gating resume on `agentSessionId !== null` used to drop exactly
  // that row from the model's context, so the user saw their message but the
  // agent had no memory of it. Gate on "are there any message rows" instead:
  // a crashed turn's user request is remembered (the model retries it next
  // turn) while its half-done assistant work — only ever `kind = 'chunk'`
  // rows, never read here — is not. When the header is absent, fall back to
  // the chat session's own id/createdAt (stable across turns until the first
  // graceful finish pins the real nimbo ids).
  const messages = listConversationEvents(db, row.id)
    .filter((eventRow) => eventRow.kind === 'message')
    .map((eventRow): unknown => JSON.parse(eventRow.payloadJson));
  if (messages.length === 0) return undefined;

  return sessionStateSchema.parse({
    id: row.agentSessionId ?? row.id,
    turn: row.agentSessionTurn ?? 0,
    messages,
    createdAt: (row.agentSessionCreatedAt ?? row.createdAt).getTime(),
  });
}

/** `GET .../events` / `GET .../stream`'s replay: one persisted `conversation_events` row → the wire frame it represents (a `kind = 'message'` row is a finished `NimboUIMessage`; a `kind = 'chunk'` row is a durable `NimboChunk` from the in-progress/crashed turn) — see `schemas/chat.ts`'s file header. */
function rowToReplayFrame(row: ConversationEventRow): ChatReplayFrame {
  const payload: unknown = JSON.parse(row.payloadJson);
  return row.kind === 'message' ?
      messageFrameSchema.parse({ seq: row.seq, message: payload })
    : chunkEnvelopeSchema.parse({ seq: row.seq, chunk: payload });
}

/** The SSE `event:` name for a wire frame — `'message'` for a finished-message replay frame, `'chunk'` for everything else (live or replayed `NimboChunk`s alike). Structural, not a shared literal field: `ChunkEnvelope`/`MessageFrame` are told apart by which of `chunk`/`message` they actually carry (`schemas/chat.ts`'s own doc comment). */
function frameEventName(frame: ChatReplayFrame): 'chunk' | 'message' {
  return 'chunk' in frame ? 'chunk' : 'message';
}

function generateSandboxName(conversationId: string): string {
  return `nimbo-chat-${conversationId}`;
}

function generateBranchName(conversationId: string): string {
  return `nimbo/chat-${conversationId}`;
}

export function createChatApp(deps: ChatRouteDeps) {
  const app = new OpenAPIHono<ChatEnv>();
  app.use('/api/chat/*', deps.authMiddleware);

  // ---- POST /api/chat/conversations ----

  const createSessionRoute = createRoute({
    method: 'post',
    path: '/api/chat/conversations',
    tags: ['Chat'],
    summary:
      'Create a chat session (provisions a Vercel sandbox + a dedicated git branch)',
    request: {
      body: {
        content: {
          'application/json': { schema: CreateConversationInputSchema },
        },
        required: true,
      },
    },
    responses: {
      201: {
        content: { 'application/json': { schema: ConversationSchema } },
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

    const conversationId = randomUUID();
    const sandboxName = generateSandboxName(conversationId);
    const branchName = generateBranchName(conversationId);

    try {
      await deps.sandboxManager.acquire({
        conversationId,
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

    const row = createConversation(deps.db, {
      id: conversationId,
      userId,
      title: input.title ?? 'New chat',
      repo: `${repoRef.owner}/${repoRef.repo}`,
      branchName,
      sandboxName,
    });
    return c.json(toConversationDto(row), 201);
  });

  // ---- GET /api/chat/conversations ----

  const listSessionsRoute = createRoute({
    method: 'get',
    path: '/api/chat/conversations',
    tags: ['Chat'],
    summary: 'List the current user’s chat sessions',
    responses: {
      200: {
        content: {
          'application/json': { schema: z.array(ConversationSchema) },
        },
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
    const rows = listConversations(deps.db, userId);
    return c.json(rows.map(toConversationDto), 200);
  });

  // ---- GET /api/chat/conversations/{id} ----

  const getSessionRoute = createRoute({
    method: 'get',
    path: '/api/chat/conversations/{id}',
    tags: ['Chat'],
    summary: 'Get one chat session’s detail (including status)',
    request: { params: ConversationParamsSchema },
    responses: {
      200: {
        content: { 'application/json': { schema: ConversationSchema } },
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
    const row = getConversation(deps.db, id, userId);
    if (row === undefined) return c.json({ error: 'Not found' }, 404);
    return c.json(toConversationDto(row), 200);
  });

  // ---- GET /api/chat/conversations/{id}/events?after=<seq> ----

  const listEventsRoute = createRoute({
    method: 'get',
    path: '/api/chat/conversations/{id}/events',
    tags: ['Chat'],
    summary: 'Replay a session’s persisted agent events (reconnection/history)',
    request: {
      params: ConversationParamsSchema,
      query: ConversationEventsQuerySchema,
    },
    responses: {
      200: {
        content: {
          'application/json': { schema: ConversationEventsListSchema },
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
    const row = getConversation(deps.db, id, userId);
    if (row === undefined) return c.json({ error: 'Not found' }, 404);

    const rows = listConversationEvents(deps.db, id, after);
    const frames: ChatReplayFrame[] = rows.map(rowToReplayFrame);
    return c.json({ frames }, 200);
  });

  // ---- GET /api/chat/conversations/{id}/turns/{turn}/telemetry (docs/tech/chat-webapp.md §11.4) ----

  const turnTelemetryRoute = createRoute({
    method: 'get',
    path: '/api/chat/conversations/{id}/turns/{turn}/telemetry',
    tags: ['Chat'],
    summary:
      'One turn’s telemetry events (model-call metrics, tool executions) for the stats detail panel — empty when telemetry is disabled or the turn predates it',
    request: { params: TurnTelemetryParamsSchema },
    responses: {
      200: {
        content: { 'application/json': { schema: TurnTelemetrySchema } },
        description: 'Telemetry events for this turn, in write order',
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

  app.openapi(turnTelemetryRoute, (c) => {
    const userId = c.get('userId');
    const { id, turn } = c.req.valid('param');
    const row = getConversation(deps.db, id, userId);
    if (row === undefined) return c.json({ error: 'Not found' }, 404);

    // 遥测按 nimbo 会话 id（functionId 的前半段）落库，不是 chat 行 id——
    // header 在首轮优雅收尾时才写入（store.ts），为 null（尚无完成轮）与
    // 遥测未启用一样按"无数据"处理，空数组不是错误。
    const store = deps.telemetryStore;
    if (store === undefined || row.agentSessionId === null) {
      return c.json({ events: [] }, 200);
    }
    const events = store
      .list(row.agentSessionId, turn)
      .map(({ eventType, ts, payloadJson }) => ({
        eventType,
        ts,
        payloadJson,
      }));
    return c.json({ events }, 200);
  });

  // ---- POST /api/chat/conversations/{id}/messages (starts a turn, docs/tech/chat-webapp.md §2.2b) ----

  const postMessageRoute = createRoute({
    method: 'post',
    path: '/api/chat/conversations/{id}/messages',
    tags: ['Chat'],
    summary:
      'Start a turn for this message, or steer an in-progress one (STEER-3B): if the session has a turn running, `text` is injected into it via `Session.steer()` (mode "steered"); otherwise this acquires the sandbox, builds the session, and hands off to the in-process turn runner (mode "started"). Either way, events arrive over `GET .../stream`, not this response',
    request: {
      params: ConversationParamsSchema,
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

    const row = getConversation(deps.db, id, userId);
    if (row === undefined) return c.json({ error: 'Not found' }, 404);

    // STEER-3B: try steering an in-progress turn first — cheap (no sandbox
    // acquisition/session rebuild needed, `Session.steer()` just queues into
    // the already-running turn). `false` covers both "no turn is active" and
    // the narrow race where the turn just ended; either way, falling through
    // to the normal start-a-new-turn flow below is correct. This route
    // doesn't synthesize a live echo for a steered message itself — but
    // unlike a turn-*starting* message (`turn-runner.ts`'s `driveTurn` does
    // synthesize a `MessageFrame` for that one, this ticket's fix), a steered
    // message doesn't need one: the injected user `NimboUIMessage` core's own
    // loop produces at the real injection point (`loop.ts`'s
    // `drainSteerMessages`, which *does* yield a `start`/`text-*`/`finish`
    // chunk sequence for it) is what actually reaches the wire.
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
        conversationId: id,
        sandboxName: row.sandboxName,
        branchName: row.branchName,
        repoCloneUrl: repoRef.cloneUrl,
        repoOwner: repoRef.owner,
        repoName: repoRef.repo,
        githubPat,
      });
      await deps.sandboxManager.touch(id); // every user message rolls the sandbox's idle timeout forward — see docs/tech/chat-webapp.md §2.2
    } catch (error) {
      return c.json({ error: describeError(error) }, 500);
    }

    // docs/tech/chat-webapp.md §2.2c（审批链）, docs/tech/single-ledger.md §6.2/§6.4: the session-level 审批分类器
    // (`ApprovalPolicy`, three-value) — `classifyApproval` decides on the
    // spot whether a call is `'allow'` or needs a human (`'review'`);
    // `@nimbo/core`'s loop only ever calls `onReview` (below) for the
    // latter, and only *after* it has already yielded a
    // `tool-approval-request` chunk. Captures `id` (the *chat* session id,
    // this route's own path param) — not `ctx.session.id`, which is
    // `@nimbo/core`'s own internal session id and means nothing to
    // `turn-runner.ts`'s `activeTurns` map.
    // 会话级授权先行（session-grants.ts，conversation_grants 表）：这次具体调用
    // （tool + 入参指纹）若已被**本轮发起者**（`userId`）在本会话「会话内都允许」过，
    // 直接放行、不再进危险命令分类——这正是人在卡片上点「会话内都允许」后想要的
    // 效果。按 userId 查（而非全会话），是为将来多用户时「每人管自己的授权」。
    // 未命中才回落到 classifyApproval。
    const approvalMode = resolveApprovalMode();
    const onApproval: ApprovalPolicy = (input, ctx) =>
      hasSessionGrant(deps.db, id, userId, ctx.toolName, input) ? 'allow' : (
        classifyApproval(approvalMode, ctx.toolName, input)
      );

    // docs/tech/single-ledger.md §6.4: the 人审通道 (`ApprovalReviewer`) — `requestReview`
    // registers a pending decision and suspends until a human (or a
    // timeout) resolves it via `POST .../approvals/:callId`. Same "captures
    // `id`, not an internal id" discipline as `onApproval` above.
    const onReview: ApprovalReviewer = (request) =>
      requestReview(id, {
        callId: request.ctx.callId,
        toolName: request.toolName,
        input: request.input,
      });

    // docs/tech/chat-webapp.md §2.2c（审批链）: the ask-user bridge — same "captures `id`, not
    // an internal id" discipline as `onApproval` above. Always wired in
    // (unlike `onApproval`'s auto-allow branch, there's no "skip asking"
    // mode for `ask-user` — see `chat-agent.ts`'s `BuildSessionOptions.onAskUser`).
    const onAskUser = (req: RequestUserAnswerInput): Promise<AskUserOutcome> =>
      requestUserAnswer(id, req);

    // docs/tech/single-ledger.md §5 单-3: this turn's newly-appended messages are found by
    // slicing `session.toJSON().messages` past however many `kind =
    // 'message'` rows already existed for this session — the exact same
    // resumed `SessionState` handed to `buildSession` below, so the count
    // agrees with what the session itself started from.
    const resumeState = loadResumeState(deps.db, row);
    const priorMessageCount = resumeState?.messages.length ?? 0;

    let session;
    try {
      session = await buildSession({
        model,
        workspace: acquired.workspace,
        repoOwner: repoRef.owner,
        repoName: repoRef.repo,
        defaultBranch: acquired.defaultBranch,
        branchName: row.branchName,
        ...(resumeState !== undefined ? { resume: resumeState } : {}),
        onApproval,
        onReview,
        approvalMode,
        onAskUser,
        ...(deps.telemetry !== undefined ? { telemetry: deps.telemetry } : {}),
      });
    } catch (error) {
      return c.json({ error: describeError(error) }, 500);
    }

    const { started } = startTurn({
      db: deps.db,
      conversationId: id,
      session,
      text,
      priorMessageCount,
    });
    if (!started) {
      return c.json({ error: 'turn already in progress' }, 409);
    }
    return c.json({ ok: true as const, mode: 'started' as const }, 202);
  });

  // ---- GET /api/chat/conversations/{id}/stream?after=<seq> (resumable live tail, docs/tech/chat-webapp.md §2.2b) ----

  const streamTurnRoute = createRoute({
    method: 'get',
    path: '/api/chat/conversations/{id}/stream',
    tags: ['Chat'],
    summary:
      'Resumable live tail of a session’s in-progress turn (docs/tech/chat-webapp.md §2.2b): replays persisted frames after `after`, then forwards the turn’s live chunks until it ends — reconnect-safe (page refresh/HMR/network blip never lose events)',
    request: {
      params: ConversationParamsSchema,
      query: ConversationEventsQuerySchema,
    },
    responses: {
      200: {
        content: { 'text/event-stream': { schema: chatReplayFrameSchema } },
        description:
          'SSE stream of `ChatReplayFrame`s (`{seq,message}` or `{seq?,chunk}`): replay, then live tail (closes once the turn ends, or immediately after replay if no turn is in progress). Live `chunk` frames omit `seq` when ephemeral (docs/tech/single-ledger.md §5 单-3 — `text-delta`/`reasoning-delta`/`transient` data parts), never persisted and never replayed; every other frame always carries one',
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

    const row = getConversation(deps.db, id, userId);
    if (row === undefined) return c.json({ error: 'Not found' }, 404);

    return streamSSE(c, async (stream) => {
      // Buffer everything the emitter delivers while we're busy replaying
      // history below — subscribing *before* the replay query (rather than
      // after) is what guarantees nothing lands in the gap between them
      // (docs/tech/chat-webapp.md §2.2b). Almost always `ChunkEnvelope`s (`subscribeTurn`'s
      // own contract, turn-runner.ts); the one exception is a turn's very
      // first live delivery, its synthesized turn-start `MessageFrame`
      // (`turn-runner.ts`'s `driveTurn`) — `envelope.seq` is always defined
      // on that one, so it flows through the exact same durable-frame
      // dedup/forward path as a `seq`-bearing chunk below, no special-casing
      // needed.
      const buffered: ChatReplayFrame[] = [];
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
      // callback right below it (docs/tech/chat-webapp.md §2.2d "tail 的回归竞态", carried over
      // onto the chunk vocabulary per docs/tech/single-ledger.md §5 单-3).
      let replayDone = false;

      const unsubscribe = subscribeTurn(
        id,
        (envelope) => {
          // An ephemeral chunk (no `seq`, docs/tech/single-ledger.md §5 单-3) that arrives while
          // we're still replaying persisted history is strictly older than
          // (or a duplicate of) whatever the replay is about to send for
          // that same in-progress message — forwarding it would clobber an
          // already-sent durable chunk with stale, half-written state and no
          // later durable chunk to follow it (the real one was already
          // replayed). It carries zero replay value on its own (ephemeral
          // chunks only matter live), so it's simply dropped — never
          // buffered, never sent. Once the replay is done, any ephemeral
          // chunk that arrives necessarily belongs to a message still in
          // progress, so it's safe to buffer and forward like any other live
          // chunk.
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

      async function writeFrame(frame: ChatReplayFrame): Promise<void> {
        await stream.writeSSE({
          event: frameEventName(frame),
          data: JSON.stringify(frame),
        });
      }

      try {
        let maxSentSeq = after ?? 0;

        async function flushBuffered(): Promise<void> {
          for (;;) {
            const envelope = buffered.shift();
            if (envelope === undefined) break;
            if (envelope.seq === undefined) {
              // Ephemeral — forward as-is, no `maxSentSeq` bookkeeping
              // (there's no seq to dedupe or advance by).
              await writeFrame(envelope);
              continue;
            }
            if (envelope.seq <= maxSentSeq) continue; // already covered by the replay query below — dedup
            await writeFrame(envelope);
            maxSentSeq = envelope.seq;
          }
        }

        const persistedRows = listConversationEvents(deps.db, id, after);
        for (const eventRow of persistedRows) {
          await writeFrame(rowToReplayFrame(eventRow));
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

  // ---- POST /api/chat/conversations/{id}/approvals/{callId} (resolve a pending approval, docs/tech/chat-webapp.md §2.2c（审批链）) ----

  const postApprovalRoute = createRoute({
    method: 'post',
    path: '/api/chat/conversations/{id}/approvals/{callId}',
    tags: ['Chat'],
    summary:
      '批准或拒绝一个待处理的工具调用审批请求（docs/tech/chat-webapp.md §2.2c（审批链），docs/tech/single-ledger.md §6）：结果通过 `GET .../stream` 的 `tool-approval-response` chunk 送达，本响应只是一个 ack',
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

    const row = getConversation(deps.db, id, userId);
    if (row === undefined) return c.json({ error: 'Not found' }, 404);

    if (behavior !== 'deny') {
      // Rolls the sandbox's idle timeout forward, same as every other
      // in-turn touch point — but must never block the decision itself: if
      // `touch()` throws (sandbox already gone, transient Vercel error), the
      // pending tool call still needs resolving, or it just hangs until
      // `requestReview`'s own timeout denies it anyway (worse than letting
      // `exec()` itself surface whatever sandbox-availability problem there
      // is as a normal tool failure).
      try {
        await deps.sandboxManager.touch(id);
      } catch {
        // intentionally swallowed — see comment above
      }
    }

    // `allow`/`allow-session` both执行本次调用（core 只认 allow）；`allow-session`
    // 额外让 `resolveReview` 持久化一条会话级授权（session-grants.ts，conversation_grants
    // 表，按 (会话, 审批人 userId, tool+入参指纹)），之后**该用户**相同调用经
    // `onApproval` 直接放行。deny 回填 message（或 core 默认文案）。
    const decision: HumanDecision =
      behavior === 'deny' ?
        { behavior: 'deny', ...(message !== undefined ? { message } : {}) }
      : { behavior: 'allow' };

    const resolved = resolveReview(id, callId, decision, {
      ...(behavior === 'allow-session' ?
        { grantSession: { db: deps.db, userId } }
      : {}),
    });
    if (!resolved) return c.json({ error: 'Not found' }, 404);

    return c.json({ ok: true as const }, 200);
  });

  // ---- POST /api/chat/conversations/{id}/questions/{callId} (answer a pending ask-user question, docs/tech/chat-webapp.md §2.2c（审批链）) ----

  const postAnswerRoute = createRoute({
    method: 'post',
    path: '/api/chat/conversations/{id}/questions/{callId}',
    tags: ['Chat'],
    summary:
      '回答一个待处理的 ask-user 提问（docs/tech/chat-webapp.md §2.2c（审批链））：结果通过 `GET .../stream` 的 `tool-ask-user` 部件 output-available 状态送达，本响应只是一个 ack',
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

    const row = getConversation(deps.db, id, userId);
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
  // getChatTelemetry* 自带 vitest 守卫（模块顶层求值——任何 import 本文件的
  // 测试都会走到这里，没有守卫会在仓库里落 telemetry.db），返回 undefined
  // 时条件展开保持 deps 字段缺席。
  ...((): { telemetry?: SessionTelemetry; telemetryStore?: TelemetryStore } => {
    const telemetry = getChatTelemetry();
    const telemetryStore = getChatTelemetryStore();
    return {
      ...(telemetry !== undefined ? { telemetry } : {}),
      ...(telemetryStore !== undefined ? { telemetryStore } : {}),
    };
  })(),
});
