import { randomUUID } from 'node:crypto';

import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { HumanDecision, SessionTelemetry } from '@nimbo/core';
import type { LanguageModel } from 'ai';
import type { MiddlewareHandler } from 'hono';
import { streamSSE } from 'hono/streaming';

import type { GitHubRepoRef } from '../agent/github-repo.js';
import { resolveGithubPat, resolveRepo } from '../agent/github-repo.js';
import { resolveModel } from '../agent/model.js';
import type {
  AcquiredSandbox,
  SandboxManager,
} from '../agent/sandbox-manager.js';
import {
  createE2bProvider,
  createSandboxManager,
  createVercelProvider,
  resolveDefaultProvider,
  resolveIdleTimeoutMs,
} from '../agent/sandbox-manager.js';
import {
  loadSkillsFromWorkspace,
  resolveSkillCatalog,
  toSkillSummaries,
} from '../agent/skill-catalog.js';
import type {
  ConversationEventRow,
  ConversationRow,
  Db,
} from '../agent/store.js';
import {
  clearQueuedMessages,
  createConversation,
  enqueueMessage,
  getConversation,
  listConversationEvents,
  listConversations,
  listQueuedMessages,
  MAX_QUEUED_MESSAGES,
  parseAvailableSkills,
  parseQueuedMessages,
  removeQueuedMessage,
  syncAvailableSkills,
} from '../agent/store.js';
import type { TurnLauncherDeps } from '../agent/turn-launcher.js';
import { launchTurn } from '../agent/turn-launcher.js';
import {
  abortTurn,
  broadcastQueue,
  isTurnActive,
  isTurnPreparing,
  resolveReview,
  resolveUserAnswer,
  steerTurn,
  subscribeTurn,
} from '../agent/turn-runner.js';
import { db as defaultDb } from '../db/instance.js';
import { logger as defaultLogger } from '../logger.js';
import { requireAuth } from '../middleware/auth.js';
import { createChatNotifier } from '../push/notifier.js';
import { clearPresent, markPresent } from '../push/presence.js';
import { ErrorSchema } from '../schemas/api.js';
import type { ChatReplayFrame, ConversationDto } from '../schemas/chat.js';
import {
  AbortTurnAckSchema,
  ApprovalAckSchema,
  ChatApprovalParamsSchema,
  ChatQueueParamsSchema,
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
  PresenceInputSchema,
  queueFrameSchema,
  StartTurnAckSchema,
  TurnTelemetryParamsSchema,
  TurnTelemetrySchema,
} from '../schemas/chat.js';
import type { TelemetryStore } from '../telemetry.js';
import { getChatTelemetry, getChatTelemetryStore } from '../telemetry.js';

// ---------------------------------------------------------------------------
// docs/tech/chat-webapp.md §2.2 `routes/chat.ts` (+ §2.2c（审批链）'s
// `POST .../approvals/:callId` and `POST .../questions/:callId`, + the queue
// endpoints of docs/tech/steer-and-queue.md §4.2, + `POST .../abort` of
// docs/tech/turn-abort.md §3.2) — login required on all of them (same
// `requireAuth` middleware as `routes/example.ts`).
// ---------------------------------------------------------------------------

type ChatEnv = { Variables: { userId: string } };

/**
 * `TurnLauncherDeps` 是「起一轮」需要的那一份（db / sandboxManager / resolveModel /
 * telemetry，见 `agent/turn-launcher.ts`）；这里继承它再补路由自己的两项，好让
 * `launchTurn(deps, …)` 直接吃这同一个对象，不必在每个调用点手工挑字段。
 */
export interface ChatRouteDeps extends TurnLauncherDeps {
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
  /**
   * 同一个遥测库的另一个口，两处在用：turn 遥测明细端点用它**查数**
   * （`TelemetryStore.list`），`turn-launcher.ts` 用它**写**起轮装配事件
   * （docs/tech/telemetry.md §2.4，声明在 `TurnLauncherDeps` 上）。缺省 undefined =
   * 端点恒返回空数组、装配事件不采集。
   */
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
    provider: row.provider,
    status: row.status === 'active' && idleElapsed ? 'sleeping' : row.status,
    lastActiveAt: row.lastActiveAt.toISOString(),
    // 直接解析手上这一行已经 select 出来的列，不再查一次库（docs/tech/steer-and-queue.md §4.2）。
    queuedMessages: parseQueuedMessages(row.queuedMessagesJson, row.id),
    // 同上，[skill 清单](../../../../docs/terms.md)缓存（docs/tech/composer-skill-mention.md §2.1）
    // ——读的是库里的快照，这条路径**不碰沙盒**，休眠会话也能列菜单。缓存为空时
    // 退到兜底清单（本功能上线前建的会话就是这一档），否则用户打 `/` 什么都没有。
    availableSkills: resolveSkillCatalog(
      parseAvailableSkills(row.availableSkillsJson, row.id),
    ),
    createdAt: row.createdAt.toISOString(),
  };
}

/** `GET .../events` / `GET .../stream`'s replay: one persisted `conversation_events` row → the wire frame it represents (a `kind = 'message'` row is a finished `NimboUIMessage`; a `kind = 'chunk'` row is a durable `NimboChunk` from the in-progress/crashed turn) — see `schemas/chat.ts`'s file header. */
function rowToReplayFrame(row: ConversationEventRow): ChatReplayFrame {
  const payload: unknown = JSON.parse(row.payloadJson);
  return row.kind === 'message' ?
      messageFrameSchema.parse({ seq: row.seq, message: payload })
    : chunkEnvelopeSchema.parse({ seq: row.seq, chunk: payload });
}

/** The SSE `event:` name for a wire frame — structural, not a shared literal field: the four frame kinds are told apart by which of `chunk`/`queue`/`turnActive`/`message` they actually carry (`schemas/chat.ts`'s own doc comment). */
function frameEventName(
  frame: ChatReplayFrame,
): 'chunk' | 'message' | 'queue' | 'turn-state' {
  if ('chunk' in frame) return 'chunk';
  if ('queue' in frame) return 'queue';
  return 'turnActive' in frame ? 'turn-state' : 'message';
}

/**
 * 一个帧的 `seq`——`QueueFrame` 与 [轮状态快照](../../../../docs/terms.md)`TurnStateFrame`
 * **恒无 seq**（它们是状态快照，不是[账本](../../../../docs/terms.md)事件，
 * docs/tech/steer-and-queue.md §4.3 / docs/tech/chat-webapp.md §5.1），所以在直播流里
 * 它们和 ephemeral chunk 走同一条「不占 seq、不参与续传」的路径。
 */
function frameSeq(frame: ChatReplayFrame): number | undefined {
  if ('queue' in frame || 'turnActive' in frame) return undefined;
  return frame.seq;
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
    const provider = input.provider ?? resolveDefaultProvider();

    let acquired: AcquiredSandbox;
    try {
      acquired = await deps.sandboxManager.acquire({
        conversationId,
        provider,
        sandboxName,
        // Vercel resumes by its upfront-known name (keeps today's get()→404→create on the first acquire); E2B has no sandboxId yet → straight to create.
        resumeToken: provider === 'e2b' ? undefined : sandboxName,
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
      provider,
      // E2B's resume token is the server-assigned sandboxId (known only after create); Vercel resumes by name, so there's nothing to store.
      sandboxId: provider === 'e2b' ? acquired.resumeToken : null,
    });

    // [skill 清单](../../../../docs/terms.md)首次填充（docs/tech/composer-skill-mention.md §2.1）：
    // 沙盒此刻刚 clone 完、刚装完 frontend-design，就地扫一次写库——否则新会话要等
    // 第一轮跑完才有菜单可用。`loadSkillsFromWorkspace` 自身不抛（扫不到就是空数组），
    // 所以这一步不会让建会话失败。
    const availableSkillsJson = syncAvailableSkills(
      deps.db,
      conversationId,
      row.availableSkillsJson,
      toSkillSummaries(
        await loadSkillsFromWorkspace(acquired.workspace, defaultLogger),
      ),
    );

    return c.json(toConversationDto({ ...row, availableSkillsJson }), 201);
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
      'Start a turn, queue this message for the next one, or steer the in-progress turn (docs/tech/steer-and-queue.md §4.1): with no turn running this acquires the sandbox, builds the session and hands off to the in-process turn runner (mode "started"); with one running it either queues `text` onto the conversation’s 待发队列 (mode "queued", the default) or injects it into the running turn via `Session.steer()` (mode "steered", `intent: "steer"`). Either way, events arrive over `GET .../stream`, not this response',
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
          'Accepted — see `mode` ("started" | "steered" | "queued" | "aborted"); poll/stream `GET .../stream` for its events. "aborted" (docs/tech/turn-abort.md §3.3) means the user stopped this turn while it was still being assembled, so it never started running — the stopped-turn frames are on the stream like any other outcome',
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
          'Either the 待发队列 is full (docs/features/steer-and-queue.md §2.3 — nothing is ever silently dropped), or a turn was already in progress and could not be steered either (narrow race — the turn ended between the steer attempt and the fallback start)',
      },
      500: {
        content: { 'application/json': { schema: ErrorSchema } },
        description: 'Model/sandbox configuration or provisioning error',
      },
      503: {
        content: { 'application/json': { schema: ErrorSchema } },
        description:
          'The server is shutting down (docs/tech/graceful-shutdown.md §3.3) — no new turn is accepted during shutdown. Retryable: resend once the new process is up',
      },
    },
  });

  app.openapi(postMessageRoute, async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    const { text, intent } = c.req.valid('json');

    const row = getConversation(deps.db, id, userId);
    if (row === undefined) return c.json({ error: 'Not found' }, 404);

    // 三路分流（docs/tech/steer-and-queue.md §4.1）——**有没有进行中的一轮**是第一
    // 决策位，`intent` 只在有的时候才有意义：没有进行中的一轮时排队毫无意义（排给谁
    // 收尾？），所以两种 intent 都直接起新一轮。判定权完全在服务端，客户端不预判。
    if (isTurnActive(id)) {
      if (intent === 'steer') {
        // STEER-3B: steer 很便宜（不用取沙盒、不用重建 session，`Session.steer()`
        // 只是排进已经在跑的那一轮）。`false` 覆盖「这一轮刚好结束了」的窄竞态——
        // 落到下面的起新一轮是正确回落。本路由不为 steer 的消息合成 echo：与起轮
        // 消息（`turn-runner.ts` 的 `driveTurn` 会合成一条 `MessageFrame`）不同，
        // steer 的用户消息由 core 自己在真实注入点产出完整 chunk 序列
        // （`loop.ts` 的 `drainSteerMessages`），那才是到达 wire 的东西。
        if (steerTurn(id, text)) {
          try {
            await deps.sandboxManager.ensureLifetime(id); // 与新起一轮一样，把沙盒空闲计时往后推
          } catch (error) {
            return c.json({ error: describeError(error) }, 500);
          }
          return c.json({ ok: true as const, mode: 'steered' as const }, 202);
        }
        // steer 报 false 有两种原因，必须分开处理（docs/tech/turn-abort.md §3.3）：
        // 这一轮还卡在[起轮装配](docs/terms.md)里（`preparing`，还没有 session 可插）
        // → 转成[排队](docs/terms.md)，它收尾时会自动[出队](docs/terms.md)，用户的话不会丢。
        // 回落去起新一轮是**错的**：会被这一轮自己的[起轮占位](docs/terms.md)挡成 409。
        // 另一种原因（这一轮刚好结束的窄竞态）才走下面的回落，行为不变。
        if (isTurnPreparing(id)) {
          const result = enqueueMessage(deps.db, id, { text, userId });
          if (!result.ok) {
            return c.json(
              {
                error: `待发队列已满（最多 ${String(MAX_QUEUED_MESSAGES)} 条）`,
              },
              409,
            );
          }
          broadcastQueue(id, result.queue);
          return c.json({ ok: true as const, mode: 'queued' as const }, 202);
        }
      } else {
        // 默认路径：排队到下一轮。入队是纯 DB 读-改-写，不碰沙盒、不碰当前这一轮
        // ——当前轮完全不受影响，这正是排队与 steer 的分野。
        const result = enqueueMessage(deps.db, id, { text, userId });
        if (!result.ok) {
          return c.json(
            {
              error: `待发队列已满（最多 ${String(MAX_QUEUED_MESSAGES)} 条）`,
            },
            409,
          );
        }
        // 多标签同步（§4.3 时机 2）：广播给这一轮的所有订阅者。
        broadcastQueue(id, result.queue);
        try {
          await deps.sandboxManager.ensureLifetime(id); // 用户还在场，沙盒别在这一轮跑完前睡掉
        } catch {
          // 刻意吞掉：消息已经入队了，续期失败不该让这次请求失败——真正的沙盒
          // 可用性问题会在出队起轮时以 `launchTurn` 的错误浮现。
        }
        return c.json({ ok: true as const, mode: 'queued' as const }, 202);
      }
    }

    const outcome = await launchTurn(deps, {
      conversationId: id,
      userId,
      text,
    });
    if (outcome.ok) {
      return c.json({ ok: true as const, mode: 'started' as const }, 202);
    }
    if (outcome.reason === 'not_found') {
      return c.json({ error: 'Not found' }, 404);
    }
    if (outcome.reason === 'busy') {
      return c.json({ error: 'turn already in progress' }, 409);
    }
    if (outcome.reason === 'shutting_down') {
      // 进程正在[优雅关闭](docs/terms.md)（docs/tech/graceful-shutdown.md §3.3）——一个
      // 明确、可恢复的拒绝：刷新重发即可。不能报 409（那是「你已经有一轮在跑」，会误导）。
      return c.json({ error: '服务正在重启，请稍后重试' }, 503);
    }
    if (outcome.reason === 'aborted') {
      // 用户在[起轮装配](docs/terms.md)期间按了[停止](docs/terms.md)
      // （docs/tech/turn-abort.md §3.3）：这一轮从没启动。202 而不是错误——用户要的
      // 结果达成了；收尾那两帧（用户消息 + 「已停止」）已落账本，客户端照常从
      // `GET .../stream` 拿到。
      return c.json({ ok: true as const, mode: 'aborted' as const }, 202);
    }
    return c.json({ error: outcome.message }, 500);
  });

  // ---- POST /api/chat/conversations/{id}/abort (docs/tech/turn-abort.md §3.2) ----

  const abortTurnRoute = createRoute({
    method: 'post',
    path: '/api/chat/conversations/{id}/abort',
    tags: ['Chat'],
    summary:
      '[停止](docs/terms.md)这个会话进行中的那一轮（docs/tech/turn-abort.md）：中止当前轮并清空[待发队列](docs/terms.md)。200 只表示「停止已请求」——真正停下的时刻取决于 agent 当时在做什么（最坏情况是一条 bash 命令响应中断信号的时间），「已停止」这个结果走 `GET .../stream` 上那条 `status: "interrupted"` 的 `message-metadata` chunk 送达',
    request: { params: ConversationParamsSchema },
    responses: {
      200: {
        content: { 'application/json': { schema: AbortTurnAckSchema } },
        description:
          'Stop requested — `queue` is the (now empty) 待发队列 snapshot',
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
          'No turn in progress on this conversation (nothing to stop) — also covers the narrow race where the turn finished on its own between the check and the abort. Nothing is changed in this case, the 待发队列 included',
      },
    },
  });

  app.openapi(abortTurnRoute, (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');

    const row = getConversation(deps.db, id, userId);
    if (row === undefined) return c.json({ error: 'Not found' }, 404);

    // 判定「有没有轮在跑」必须在清队列**之前**：没有轮在跑时清队列会把一次误点
    // 变成一次丢消息（队列本来要等下一次轮收尾才发）。
    if (!isTurnActive(id)) {
      return c.json({ error: 'no turn in progress' }, 409);
    }

    // 清队列必须在 `abortTurn` **之前**（docs/tech/turn-abort.md §3.2）：这一轮收尾时
    // `onTurnSettled` 会自动[出队](docs/terms.md)起下一轮，先 abort 再清存在真实竞态
    // ——abort 解开挂起的审批后这一轮可能立刻收尾，队首那条就被发出去了，而用户刚
    // 按的是「停止」。先清后 abort 则结构上不可能：出队时队列已空。
    //
    // 广播也必须趁这一轮还活着发（`broadcastQueue` 对已结束的轮是无操作），否则
    // 界面待发区要等到下次刷新才清空——轮结束后前端不会再重连。
    const queue = clearQueuedMessages(deps.db, id);
    broadcastQueue(id, queue);

    if (!abortTurn(id)) {
      // 窄竞态：这一轮在上面那次 `isTurnActive` 与这里之间自己结束了。队列已经清了
      // （用户按的就是停止，清掉正是他要的），但没有轮可停，照 409 报。
      return c.json({ error: 'no turn in progress' }, 409);
    }

    return c.json({ ok: true as const, queue }, 200);
  });

  // ---- DELETE /api/chat/conversations/{id}/queue/{messageId} (docs/tech/steer-and-queue.md §4.2) ----

  const deleteQueuedMessageRoute = createRoute({
    method: 'delete',
    path: '/api/chat/conversations/{id}/queue/{messageId}',
    tags: ['Chat'],
    summary:
      '从[待发队列](docs/terms.md)里删掉一条还没发出的消息——返回变更后的完整队列快照（调用方一次往返拿到权威状态，不必删完再查）',
    request: { params: ChatQueueParamsSchema },
    responses: {
      200: {
        content: { 'application/json': { schema: queueFrameSchema } },
        description: 'Queue after the removal',
      },
      401: {
        content: { 'application/json': { schema: ErrorSchema } },
        description: 'Unauthorized',
      },
      404: {
        content: { 'application/json': { schema: ErrorSchema } },
        description:
          'Not found — either this conversation doesn’t exist (or isn’t the caller’s), or `messageId` isn’t in its queue anymore (already dequeued into a turn, already deleted, or never existed)',
      },
    },
  });

  app.openapi(deleteQueuedMessageRoute, (c) => {
    const userId = c.get('userId');
    const { id, messageId } = c.req.valid('param');

    const row = getConversation(deps.db, id, userId);
    if (row === undefined) return c.json({ error: 'Not found' }, 404);

    const { removed, queue } = removeQueuedMessage(deps.db, id, messageId);
    if (!removed) return c.json({ error: 'Not found' }, 404);

    broadcastQueue(id, queue);
    return c.json({ queue }, 200);
  });

  // ---- DELETE /api/chat/conversations/{id}/queue (docs/tech/steer-and-queue.md §4.2) ----

  const clearQueueRoute = createRoute({
    method: 'delete',
    path: '/api/chat/conversations/{id}/queue',
    tags: ['Chat'],
    summary:
      '清空[待发队列](docs/terms.md)——已经出队起轮的消息不受影响（那已经是一条正常的用户消息了）',
    request: { params: ConversationParamsSchema },
    responses: {
      200: {
        content: { 'application/json': { schema: queueFrameSchema } },
        description: 'Queue after clearing (always empty)',
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

  app.openapi(clearQueueRoute, (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');

    const row = getConversation(deps.db, id, userId);
    if (row === undefined) return c.json({ error: 'Not found' }, 404);

    const queue = clearQueuedMessages(deps.db, id);
    broadcastQueue(id, queue);
    return c.json({ queue }, 200);
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
          //
          // 一个 `QueueFrame`（`frameSeq` 恒 undefined，docs/tech/steer-and-queue.md
          // §4.3）走同一条路径，且在这里被丢弃同样无害：回放结束后本连接会主动发
          // 一帧权威队列快照（见下方 `replayDone` 处），它必然比这里丢掉的更新。
          if (frameSeq(envelope) === undefined && !replayDone) return;
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
            const seq = frameSeq(envelope);
            if (seq === undefined) {
              // Ephemeral chunk / `QueueFrame` — forward as-is, no
              // `maxSentSeq` bookkeeping (there's no seq to dedupe or advance
              // by).
              await writeFrame(envelope);
              continue;
            }
            if (seq <= maxSentSeq) continue; // already covered by the replay query below — dedup
            await writeFrame(envelope);
            maxSentSeq = seq;
          }
        }

        const persistedRows = listConversationEvents(deps.db, id, after);
        for (const eventRow of persistedRows) {
          await writeFrame(rowToReplayFrame(eventRow));
          maxSentSeq = eventRow.seq;
        }

        await flushBuffered();

        // [待发队列](docs/terms.md)的权威快照（docs/tech/steer-and-queue.md §4.3 时机 1）：
        // 每条连接在回放之后、进入直播之前都发一帧，因此**任何**时候连上/重连（新标签
        // 页、刷新、断线退避重连、以及上一轮出队后接上来的下一轮）拿到的都是当下的
        // 真实队列——出队恰好发生在上一轮 emitter 即将关闭的时刻，那一次的同步就靠
        // 这里，而不是靠一次注定竞态的广播。放在 `replayDone = true` 之前，避免它被
        // 上面那条「回放期间丢弃无 seq 帧」的规则误伤。
        await writeFrame({ queue: listQueuedMessages(deps.db, id) });

        // [轮状态快照](docs/terms.md)（docs/tech/chat-webapp.md §5.1）：同样每条连接必发
        // 一帧，紧跟队列快照。发的是**订阅那一刻**的 `wasActive`（不是这里重新查一次）
        // ——它与下面「要不要进直播循环」用的是同一个读数，两者必须一致：告诉客户端
        // 「有轮在跑」却立刻关掉连接，或反过来，都会让客户端的重连逻辑做出错误决定。
        //
        // 这一帧存在的理由见 `schemas/chat.ts` 的 `turnStateFrameSchema`：在它之前前端只能
        // 靠「回放最后一帧是不是 chunk」猜，而崩溃残留会让那个猜法长期失准、且永不自愈。
        await writeFrame({ turnActive: wasActive });

        replayDone = true;

        if (wasActive) {
          while (!turnDone && !aborted) {
            // `buffered` 非空就直接冲，不去 `await waitForMore`——`scheduleWake`
            // 是「resolve 当前那个一次性 promise，同时换上新的」，所以一个在本循环
            // **正在 flush**（`flushBuffered` 内部有 `await writeFrame`）时到达的
            // 事件，唤醒的是已经没人等的旧 promise，而本循环下一轮 `await` 的是新
            // 的——那次唤醒就丢了，帧会一直躺在 `buffered` 里直到下一个事件把它顺带
            // 带出来（turn 恰好就此结束的话就永远躺着，tail 挂到超时）。改成「先看
            // 有没有货，没货才等」后这个丢唤醒不再有后果。判空与 `await waitForMore`
            // 之间没有 await，单线程下不会有事件插进来，所以不存在反向的漏等。
            if (buffered.length > 0) {
              await flushBuffered();
              continue;
            }
            await waitForMore;
            await flushBuffered();
          }
        }
      } finally {
        unsubscribe();
      }
    });
  });

  // ---- POST /api/chat/conversations/{id}/presence (在场心跳, docs/tech/push-notification.md §5.2) ----

  const presenceRoute = createRoute({
    method: 'post',
    path: '/api/chat/conversations/{id}/presence',
    tags: ['Chat'],
    summary:
      '上报[在场](../../../../docs/terms.md)：这条会话此刻是否正在调用者眼前（docs/tech/push-notification.md §5.2）。在场期间不向这个人推送本会话的通知',
    request: {
      params: ConversationParamsSchema,
      body: {
        content: { 'application/json': { schema: PresenceInputSchema } },
        required: true,
      },
    },
    responses: {
      200: {
        content: { 'application/json': { schema: ApprovalAckSchema } },
        description: 'Recorded',
      },
      401: {
        content: { 'application/json': { schema: ErrorSchema } },
        description: 'Unauthorized',
      },
      404: {
        content: { 'application/json': { schema: ErrorSchema } },
        description: 'Not found —— 会话不存在，或不属于调用者',
      },
    },
  });

  app.openapi(presenceRoute, (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    const { focused } = c.req.valid('json');

    // 属主校验与本文件其它会话级接口一致（不存在与不属于自己都回 404，不泄露
    // 存在性）。刻意**不** `touch()` 沙盒：心跳每 20 秒一次，让"盯着页面发呆"
    // 无限续沙盒的命，既烧钱又把空闲休眠这套机制架空。
    const row = getConversation(deps.db, id, userId);
    if (row === undefined) return c.json({ error: 'Not found' }, 404);

    if (focused) markPresent(userId, id);
    else clearPresent(userId, id);

    return c.json({ ok: true as const }, 200);
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
        await deps.sandboxManager.ensureLifetime(id);
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
      await deps.sandboxManager.ensureLifetime(id);
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
  sandboxManager: createSandboxManager({
    vercel: createVercelProvider(),
    e2b: createE2bProvider(), // lazy — reads E2B_API_KEY only when an E2B conversation actually acquires (provider selection wired in SP-3)
  }),
  resolveModel,
  authMiddleware: requireAuth,
  // 推送通知（docs/tech/push-notification.md §4）。**不加 vitest 守卫**（与
  // `getChatTelemetry*` 不同）：`createChatNotifier` 只是把 db 存进一个闭包，
  // 不建库、不起定时器、不碰网络；真正要发的时候还有「没配 VAPID 就整体禁用」
  // 那道总闸挡着，测试环境下它恒为关。
  notifier: createChatNotifier({ db: defaultDb }),
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
