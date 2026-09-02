import { randomUUID } from 'node:crypto';

import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type {
  AgentRuntime,
  DecisionStore,
  Frame,
  QueuedInput,
} from '@runko/agent';
import type { SessionTelemetry } from '@runko/core';
import type { LanguageModel } from 'ai';
import type { MiddlewareHandler } from 'hono';
import { streamSSE } from 'hono/streaming';

import { grantConversationApproval } from '../agent/conversation-grants.js';
import type { GitHubRepoRef } from '../agent/github-repo.js';
import { resolveGithubPat, resolveRepo } from '../agent/github-repo.js';
import { resolveModel } from '../agent/model.js';
import {
  createChatPersistence,
  parseQueuedInputs,
} from '../agent/persistence.js';
import { createChatRuntime } from '../agent/runtime.js';
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
import type { ConversationRow, Db } from '../agent/store.js';
import {
  createConversation,
  getConversation,
  listConversations,
  parseAvailableSkills,
  syncAvailableSkills,
} from '../agent/store.js';
import { db as defaultDb } from '../db/instance.js';
import { logger as defaultLogger } from '../logger.js';
import { requireAuth } from '../middleware/auth.js';
import { createChatNotifier } from '../push/notifier.js';
import { clearPresent, markPresent } from '../push/presence.js';
import { ErrorSchema } from '../schemas/api.js';
import type {
  ChatReplayFrame,
  ConversationDto,
  QueuedMessage,
} from '../schemas/chat.js';
import {
  AbortTurnAckSchema,
  ApprovalAckSchema,
  ChatApprovalParamsSchema,
  ChatQueueParamsSchema,
  chatReplayFrameSchema,
  ConversationMessagesListSchema,
  ConversationParamsSchema,
  ConversationReplayQuerySchema,
  ConversationSchema,
  CreateConversationInputSchema,
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

export interface ChatRouteDeps {
  db: Db;
  /**
   * [轮编排](../../../../docs/terms.md)运行时（`@runko/agent`）——一轮的一生、
   * [排队](../../../../docs/terms.md)、[停止](../../../../docs/terms.md)、人在回路全归它。
   * 本文件只做 HTTP：把请求翻译成 `runtime.*` 的一次调用，把 `Frame` 序列化成 SSE。
   */
  runtime: AgentRuntime;
  /**
   * 框架的[裁决表](../../../../docs/terms.md)读口。**只为一件事**：用户点「会话内都允许」
   * 时，本文件要拿这次调用的 tool + 原始入参去记一条[会话级授权](../../../../docs/terms.md)
   * ——而路由手上只有 `callId`。裁决表是框架唯一知道这两样的地方。
   */
  decisions: DecisionStore;
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
  /** telemetry 事件集成（`@runko/core` `SessionTelemetry`，docs/tech/chat-webapp.md §11.4）——注入后逐 turn 的模型调用事件落 SQLite；缺省 undefined = 不采集。生产默认装配见文件底部（`getChatTelemetry`）。 */
  telemetry?: SessionTelemetry;
  /**
   * 同一个遥测库的另一个口，两处在用：turn 遥测明细端点用它**查数**
   * （`TelemetryStore.list`），`agent/runtime.ts` 的钩子用它**写**起轮装配事件
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
    queuedMessages: toQueueDto(
      parseQueuedInputs(row.queuedMessagesJson, row.id),
    ),
    // 同上，[skill 清单](../../../../docs/terms.md)缓存（docs/tech/composer-skill-mention.md §2.1）
    // ——读的是库里的快照，这条路径**不碰沙盒**，休眠会话也能列菜单。缓存为空时
    // 退到兜底清单（本功能上线前建的会话就是这一档），否则用户打 `/` 什么都没有。
    availableSkills: resolveSkillCatalog(
      parseAvailableSkills(row.availableSkillsJson, row.id),
    ),
    // [起轮标记](../../../../docs/terms.md)就是答案，手上这一行已经带着它了。
    turnInProgress: row.turnHolder !== null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * 框架的 `QueuedInput` → wire 上的 `QueuedMessage`。
 *
 * 两个形状**刻意不合并**：框架那个是通用的（`input` 里可以带宿主自定义的 `meta`），
 * wire 这个是 chat 应用自己的契约（前端与 OpenAPI 都钉着它）。在这里翻译一次，比让
 * 其中一边迁就另一边划算。
 */
function toQueueDto(queue: readonly QueuedInput[]): QueuedMessage[] {
  return queue.map((item) => ({
    id: item.id,
    text: item.input.text,
    userId: item.input.userId ?? '',
    createdAt: item.createdAt,
  }));
}

/**
 * 框架的 `Frame` → 本应用的 wire 帧。四种帧一一对应，只有队列那种要翻译一下形状。
 *
 * [进行中草稿](../../../../docs/terms.md)搬进内存之后，`chunk` 帧**一律没有 `seq`**
 * ——它们只直播、不落库、不参与 `after=` 续传，与从前的 ephemeral chunk 走同一条路。
 */
function toWireFrame(frame: Frame): ChatReplayFrame {
  switch (frame.kind) {
    case 'message':
      return { seq: frame.seq, message: frame.message };
    case 'chunk':
      return { chunk: frame.chunk };
    case 'queue':
      return { queue: toQueueDto(frame.queue) };
    case 'activity':
      return { turnActive: frame.active };
  }
}

/** The SSE `event:` name for a wire frame — structural, not a shared literal field: the four frame kinds are told apart by which of `chunk`/`queue`/`turnActive`/`message` they actually carry (`schemas/chat.ts`'s own doc comment). */
function frameEventName(
  frame: ChatReplayFrame,
): 'chunk' | 'message' | 'queue' | 'turn-state' {
  if ('chunk' in frame) {
    return 'chunk';
  }
  if ('queue' in frame) {
    return 'queue';
  }
  return 'turnActive' in frame ? 'turn-state' : 'message';
}

function generateSandboxName(conversationId: string): string {
  return `runko-chat-${conversationId}`;
}

function generateBranchName(conversationId: string): string {
  return `runko/chat-${conversationId}`;
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
    if (row === undefined) {
      return c.json({ error: 'Not found' }, 404);
    }
    return c.json(toConversationDto(row), 200);
  });

  // ---- GET /api/chat/conversations/{id}/messages?after=<seq> ----

  const listMessagesRoute = createRoute({
    method: 'get',
    path: '/api/chat/conversations/{id}/messages',
    tags: ['Chat'],
    summary: '回放一个会话落盘的成品消息（历史 / 断线续传）',
    request: {
      params: ConversationParamsSchema,
      query: ConversationReplayQuerySchema,
    },
    responses: {
      200: {
        content: {
          'application/json': { schema: ConversationMessagesListSchema },
        },
        description: 'Messages, in seq order',
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

  app.openapi(listMessagesRoute, async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    const { after } = c.req.valid('query');
    const row = getConversation(deps.db, id, userId);
    if (row === undefined) {
      return c.json({ error: 'Not found' }, 404);
    }

    // [账本](../../../../docs/terms.md)现在只有成品消息——[进行中草稿](../../../../docs/terms.md)
    // 在内存里，只走[直播流](../../../../docs/terms.md)。所以这个端点回放出来的必然全是
    // `MessageFrame`，前端拿到就能直接拼进消息列表。
    const entries = await deps.runtime.readLedger(
      id,
      after !== undefined ? { afterSeq: after } : {},
    );
    const frames: ChatReplayFrame[] = entries.map((entry) => ({
      seq: entry.seq,
      message: entry.message,
    }));
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
    if (row === undefined) {
      return c.json({ error: 'Not found' }, 404);
    }

    // 遥测按 runko 会话 id（functionId 的前半段）落库。迁移到 `@runko/agent` 之后
    // **会话 id 就是 conversationId**（框架从账本重建 `SessionState` 时直接拿它当
    // session id，见 `buildResumeState`），所以这里查的就是 `row.id`。
    //
    // 代价：迁移**之前**那些轮的遥测行是按旧的随机 agent session id 落的，从此查不回来
    // ——遥测是耗材（无持久承诺），换来的是一个跨轮稳定、无需额外落库的关联键。
    const store = deps.telemetryStore;
    if (store === undefined) {
      return c.json({ events: [] }, 200);
    }
    const events = store
      .list(row.id, turn)
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
          'Accepted — see `mode` ("started" | "steered" | "queued"); poll/stream `GET .../stream` for its events. Stopping a turn while it is still being assembled still works, but the ack for that message is "started" — the stopped-turn frames arrive on the stream like any other outcome',
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
    if (row === undefined) {
      return c.json({ error: 'Not found' }, 404);
    }

    // **三路分流全在框架里判一次**（`runtime.enqueue`）：有没有轮在跑、装配中还是真在
    // 跑、该排队还是该插话、以及「查完队列没活儿了到真正释放归属之间用户又发了一条」
    // 那个竞态的兜底。这里只负责把结果翻成 HTTP。
    const outcome = await deps.runtime.enqueue(
      id,
      { text, userId },
      { intent: intent === 'steer' ? 'steer' : 'queue' },
    );

    if (outcome.mode === 'started') {
      return c.json({ ok: true as const, mode: 'started' as const }, 202);
    }
    if (outcome.mode === 'steered') {
      try {
        await deps.sandboxManager.ensureLifetime(id); // 与新起一轮一样，把沙盒空闲计时往后推
      } catch (error) {
        // **刻意吞掉，与下面 `queued` 那支同一个理由**：走到这里时插话已经注入进正在跑
        // 的那一轮了，回 500 会让用户以为没发出去、再发一遍——同一句话进去两次。续期
        // 失败只是沙盒可能提前睡，真正的可用性问题会在这一轮里以一条 failed 收尾帧浮现。
        defaultLogger.warn(
          'chat',
          'failed to extend sandbox lifetime after steer',
          { conversationId: id, error: describeError(error) },
        );
      }
      return c.json({ ok: true as const, mode: 'steered' as const }, 202);
    }
    if (outcome.mode === 'queued') {
      try {
        await deps.sandboxManager.ensureLifetime(id); // 用户还在场，沙盒别在这一轮跑完前睡掉
      } catch {
        // 刻意吞掉：消息已经入队了，续期失败不该让这次请求失败——真正的沙盒可用性
        // 问题会在出队起轮时以一条 failed 收尾帧浮现。
      }
      return c.json({ ok: true as const, mode: 'queued' as const }, 202);
    }

    // 四种拒绝的处置各不相同（`@runko/agent` 的 `EnqueueRejection`）。
    if (outcome.reason === 'shutting_down') {
      // 进程正在[优雅关闭](docs/terms.md)——一个明确、可恢复的拒绝：刷新重发即可。
      // 不能报 409（那是「你已经有一轮在跑」，会误导）。
      return c.json({ error: '服务正在重启，请稍后重试' }, 503);
    }
    if (outcome.reason === 'queue_full' || outcome.reason === 'busy') {
      return c.json({ error: outcome.message }, 409);
    }
    // `held_by_other` 在单进程下走不到（框架只有在归属落在别的节点手上时才报它）；
    // 上多节点后这里要改成「转发给 outcome 里那个 holder」，而不是报错。
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

  app.openapi(abortTurnRoute, async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');

    const row = getConversation(deps.db, id, userId);
    if (row === undefined) {
      return c.json({ error: 'Not found' }, 404);
    }

    // 「先判有没有轮在跑、再清队列、最后 abort」这套顺序在框架里（`runtime.abort`）——
    // 没有轮在跑时它**不动队列**（否则一次误点就是一次丢消息），有轮在跑时它保证清队列
    // 排在 abort 之前（否则 abort 解开挂起的审批后这一轮可能立刻收尾、把队首那条发出去，
    // 而用户刚按的是「停止」）。
    if (!(await deps.runtime.abort(id))) {
      return c.json({ error: 'no turn in progress' }, 409);
    }
    return c.json({ ok: true as const, queue: [] }, 200);
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

  app.openapi(deleteQueuedMessageRoute, async (c) => {
    const userId = c.get('userId');
    const { id, messageId } = c.req.valid('param');

    const row = getConversation(deps.db, id, userId);
    if (row === undefined) {
      return c.json({ error: 'Not found' }, 404);
    }

    // 广播新快照归框架（多标签同步）——这里只翻形状。
    const { removed, queue } = await deps.runtime.removeQueued(id, messageId);
    if (!removed) {
      return c.json({ error: 'Not found' }, 404);
    }

    return c.json({ queue: toQueueDto(queue) }, 200);
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

  app.openapi(clearQueueRoute, async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');

    const row = getConversation(deps.db, id, userId);
    if (row === undefined) {
      return c.json({ error: 'Not found' }, 404);
    }

    const queue = await deps.runtime.clearQueue(id);
    return c.json({ queue: toQueueDto(queue) }, 200);
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
      query: ConversationReplayQuerySchema,
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
    if (row === undefined) {
      return c.json({ error: 'Not found' }, 404);
    }

    return streamSSE(c, async (stream) => {
      // 断线续传、[进行中草稿](../../../../docs/terms.md)快照、队列与
      // [轮状态](../../../../docs/terms.md)两帧权威快照、以及「先挂订阅再回放，中间不留
      // 缝」那套顺序，全在 `runtime.subscribe` 里。本文件只做序列化——框架不碰 HTTP。
      const abort = new AbortController();
      stream.onAbort(() => {
        abort.abort();
      });

      for await (const frame of deps.runtime.subscribe(id, {
        ...(after !== undefined ? { after } : {}),
        signal: abort.signal,
      })) {
        const wire = toWireFrame(frame);
        await stream.writeSSE({
          event: frameEventName(wire),
          data: JSON.stringify(wire),
        });
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
    if (row === undefined) {
      return c.json({ error: 'Not found' }, 404);
    }

    if (focused) {
      markPresent(userId, id);
    } else {
      clearPresent(userId, id);
    }

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
    if (row === undefined) {
      return c.json({ error: 'Not found' }, 404);
    }

    if (behavior !== 'deny') {
      // 把沙盒空闲计时往后推，同其它 in-turn 触点——但**绝不能拦住裁决本身**：
      // `ensureLifetime` 抛了（沙盒已经没了、临时错误），这条挂起的工具调用照样需要被
      // 结掉，否则它一直挂到审批超时才被自动拒绝，比让 `exec()` 自己把沙盒可用性问题
      // 报成一次普通的工具失败更糟。
      try {
        await deps.sandboxManager.ensureLifetime(id);
      } catch {
        // 见上，刻意吞掉
      }
    }

    // 「会话内都允许」= 本次放行 + 记一条[会话级授权](docs/terms.md)。授权是 chat 层
    // 自己的产品概念（core 只认 allow/deny），所以由这里落库；框架侧只在裁决表里记一个
    // `scope: 'conversation'`——那是**范围**，框架记而不执行，放行与否看本层的授权表。
    //
    // 这次调用的 tool + 入参从**框架的裁决表**里取（路由手上只有 callId）。**先读、后
    // 落库**：读要在 `submitDecision` 之前（结清之后这条就不在待定清单里了），但**写必须
    // 在它之后**——`listPending` 读的是库、`submitDecision` 走的是内存里那条挂起 promise，
    // 进程重启会让两者分家（库里的行永远停在 `decidedAt=null`，内存里什么都没有）。顺序
    // 反了的话，用户在没刷新的标签页上点一下会拿到 404，却已经留下一条永久放行规则。
    const grant =
      behavior === 'allow-session' ?
        (await deps.decisions.listPending(id)).find(
          (entry) => entry.toolCallId === callId,
        )
      : undefined;

    const resolved = await deps.runtime.submitDecision(id, callId, {
      outcome: behavior === 'deny' ? 'deny' : 'allow',
      scope: behavior === 'allow-session' ? 'conversation' : 'once',
      decidedBy: userId,
      ...(message !== undefined ? { message } : {}),
    });
    if (!resolved) {
      return c.json({ error: 'Not found' }, 404);
    }

    if (grant?.toolName !== undefined) {
      grantConversationApproval(
        deps.db,
        id,
        userId,
        grant.toolName,
        grant.payload ?? null,
      );
    }

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
    if (row === undefined) {
      return c.json({ error: 'Not found' }, 404);
    }

    // Unconditional (unlike the approval route's `allow`-only branch —
    // answering a question always lets the turn continue, there is no "deny"
    // analog here): must never block the answer itself, same rationale as
    // the approval route's own touch-failure comment above.
    try {
      await deps.sandboxManager.ensureLifetime(id);
    } catch {
      // intentionally swallowed — see comment above
    }

    const resolved = await deps.runtime.submitAnswer(id, callId, answer);
    if (!resolved) {
      return c.json({ error: 'Not found' }, 404);
    }

    return c.json({ ok: true as const }, 200);
  });

  return app;
}

/**
 * 生产装配。三样东西在这里成型：沙盒管理器、`@runko/agent` 运行时（`createChatRuntime`）、
 * 以及路由自己那几个可选外围（推送、遥测）。
 *
 * `chatRuntime` 单独导出，是因为 `index.ts` 还要用它两次：启动时 `recover()` 扫
 * [孤儿轮](../../docs/terms.md)，收到 SIGTERM 时 `shutdown()` [交权](../../docs/terms.md)。
 */
const defaultSandboxManager = createSandboxManager({
  vercel: createVercelProvider(),
  e2b: createE2bProvider(), // lazy — reads E2B_API_KEY only when an E2B conversation actually acquires
});

/** getChatTelemetry* 自带 vitest 守卫（模块顶层求值——任何 import 本文件的测试都会走到这里，没有守卫会在仓库里落 telemetry.db）。 */
const defaultTelemetry: {
  telemetry?: SessionTelemetry;
  telemetryStore?: TelemetryStore;
} = (() => {
  const telemetry = getChatTelemetry();
  const telemetryStore = getChatTelemetryStore();
  return {
    ...(telemetry !== undefined ? { telemetry } : {}),
    ...(telemetryStore !== undefined ? { telemetryStore } : {}),
  };
})();

/**
 * 推送通知（docs/ingress/tech/push-notification.md §4）。**不加 vitest 守卫**（与
 * `getChatTelemetry*` 不同）：`createChatNotifier` 只是把 db 存进一个闭包，不建库、
 * 不起定时器、不碰网络；真正要发的时候还有「没配 VAPID 就整体禁用」那道总闸挡着。
 */
const defaultNotifier = createChatNotifier({ db: defaultDb });

export const chatRuntime = createChatRuntime({
  db: defaultDb,
  sandboxManager: defaultSandboxManager,
  resolveModel,
  notifier: defaultNotifier,
  ...defaultTelemetry,
});

export const chatApp = createChatApp({
  db: defaultDb,
  runtime: chatRuntime,
  decisions: createChatPersistence(defaultDb).decisions,
  sandboxManager: defaultSandboxManager,
  resolveModel,
  authMiddleware: requireAuth,
  ...defaultTelemetry,
});
