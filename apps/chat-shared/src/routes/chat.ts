import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type {
  ConversationActivity,
  EnqueueResult,
  Frame,
  QueuedInput,
  SubmittedDecision,
  TurnInput,
} from '@runko/agent';
import type { JsonValue, RunkoUIMessage } from '@runko/core';
import type { Context, MiddlewareHandler } from 'hono';
import { streamSSE } from 'hono/streaming';

import { grantConversationApproval } from '../agent/conversation-grants.js';
import type { GithubApp, GithubRepoRef } from '../agent/github-app.js';
import { classifyGithubError, splitFullName } from '../agent/github-app.js';
import type { SandboxManager } from '../agent/sandbox-manager.js';
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
import type { ConversationProvider } from '../db/schema.js';
import type { Logger } from '../logger.js';
import { ErrorSchema } from '../schemas/api.js';
import type {
  ChatConfigDto,
  ChatReplayFrame,
  ConversationDto,
  QueuedMessage,
  SkillSummaryDto,
  StartTurnAck,
} from '../schemas/chat.js';
import {
  AbortTurnAckSchema,
  ActivitySchema,
  ApprovalAckSchema,
  ChatApprovalParamsSchema,
  ChatConfigSchema,
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

// ---------------------------------------------------------------------------
// chat 应用的会话接口——**两个服务端共用这一份路由**（docs/host/cloudflare/tech/chat-on-cloudflare.md §7）。
//
// 路由只做 HTTP：校验、查归属、把请求翻译成「会话后端」的一次调用、把框架的 `Frame` 序列化成
// SSE。会话里的状态（轮、队列、审批）在哪、怎么到达，由宿主给的 `ConversationBackend` 决定：
// Node 版就是进程里的 `@runko/agent` 运行时；Cloudflare 版把调用交给这个会话的会话对象。
// ---------------------------------------------------------------------------

export type ChatEnv = { Variables: { userId: string } };

/**
 * 路由用到的那几样运行时动作——形状与 `@runko/agent` 的 `AgentRuntime` 一致，所以 Node 版
 * 直接把运行时交进来；Cloudflare 版逐个转给会话对象。
 */
export interface ConversationRuntime {
  enqueue(
    conversationId: string,
    input: TurnInput,
    opts?: { intent?: 'queue' | 'steer' },
  ): Promise<EnqueueResult>;
  abort(conversationId: string): Promise<boolean>;
  removeQueued(
    conversationId: string,
    id: string,
  ): Promise<{ removed: boolean; queue: QueuedInput[] }>;
  clearQueue(conversationId: string): Promise<QueuedInput[]>;
  listQueue(conversationId: string): Promise<QueuedInput[]>;
  getActivity(conversationId: string): Promise<ConversationActivity>;
  readLedger(
    conversationId: string,
    opts?: { afterSeq?: number },
  ): Promise<{ seq: number; message: RunkoUIMessage }[]>;
  subscribe(
    conversationId: string,
    opts?: { after?: number; signal?: AbortSignal },
  ): AsyncIterable<Frame>;
  submitDecision(
    conversationId: string,
    callId: string,
    decision: SubmittedDecision,
  ): Promise<boolean>;
  submitAnswer(
    conversationId: string,
    callId: string,
    answer: string,
    opts?: { decidedBy?: string },
  ): Promise<boolean>;
}

/**
 * 一个会话 DTO 里有三样不在会话表上：排队消息、有没有轮在跑、几处在等人答。
 * 它们都归框架管，所以由会话后端查好了交回来。
 */
export interface ConversationLiveState {
  queuedMessages: QueuedMessage[];
  turnInProgress: boolean;
  pendingDecisions: number;
}

/** 建会话时交给会话后端、让它把沙盒准备好的那些东西。 */
export interface ProvisionInput {
  conversationId: string;
  provider: ConversationProvider;
  sandboxName: string;
  /** 只有用 git 的档（云沙盒）才有，下面三项同。 */
  branchName?: string;
  repo?: GithubRepoRef;
  /** 只对这一个仓库有效的[安装令牌](../../../../docs/terms.md)。 */
  githubToken?: string;
}

export interface ProvisionResult {
  /** 要落进会话表 `sandbox_id` 的值：E2B 是服务端分配的 sandboxId，其余档为 `null`（按名字恢复）。 */
  sandboxId: string | null;
  /** 沙盒刚就绪时扫到的 [skill 清单](../../../../docs/terms.md)。 */
  skills: SkillSummaryDto[];
}

/**
 * 「会话后端」：路由里一切跟会话状态有关的动作。宿主各写一份。
 */
export interface ConversationBackend {
  readonly runtime: ConversationRuntime;
  /**
   * 这个会话还没结清的裁决。**只为一件事**：用户点「会话内都允许」时，路由要拿这次调用的
   * tool + 原始入参去记一条[会话级授权](../../../../docs/terms.md)——而路由手上只有 `callId`。
   */
  listPendingDecisions(conversationId: string): Promise<
    readonly {
      toolCallId: string;
      toolName?: string | undefined;
      payload?: JsonValue | undefined;
    }[]
  >;
  /** 列表与详情要的实时状态。列表一次给全部 id，详情只给一个。 */
  liveStates(
    conversationIds: readonly string[],
  ): Promise<Map<string, ConversationLiveState>>;
  /** 建会话：把沙盒准备好（云沙盒还要克隆仓库、开工作分支）。 */
  provision(input: ProvisionInput): Promise<ProvisionResult>;
  /**
   * 把沙盒空闲计时往后推一次——只用于**轮之外**的时机（插话、排队、审批、答复）。抛了由路由吞掉：
   * 那几处的主动作已经做完了，续期失败不该让请求失败。
   */
  extendSandboxLifetime(conversationId: string): Promise<void>;
}

/** 归属刚被别的副本抢走时，宿主怎么处置（只有 Node 多副本会遇到）。 */
export type HeldByOtherOutcome =
  | { kind: 'ack'; ack: StartTurnAck }
  | { kind: 'unknown' }
  | { kind: 'retry'; retryAfterSeconds: string };

/** 只有部分宿主才有的几处挂接点。Cloudflare 版一个都不用：同一个会话永远只有一个会话对象。 */
export interface ChatHostHooks {
  /** 鉴权之前的一道闸（Node 版：副本间令牌）。返回 Response 即截下。 */
  beforeAuth?: MiddlewareHandler<ChatEnv>;
  /**
   * 鉴权之后，挂在「状态在持有者内存里」的那几条路由上（Node 版：转发给持有者）。
   * `coversStream` 为 `true` 时直播流也挂。
   */
  holderGate?: { handler: MiddlewareHandler<ChatEnv>; coversStream: boolean };
  /** `enqueue` 报 `held_by_other` 时怎么办。不给 = 一律回 503 稍后重试。 */
  onHeldByOther?: (
    c: Context<ChatEnv>,
    holder: string | undefined,
  ) => Promise<HeldByOtherOutcome>;
}

/** 遥测的读口：一轮的事件明细（只有 Node 版有遥测库）。 */
export interface TurnTelemetryReader {
  list(
    sessionId: string,
    turn: number,
  ): readonly { eventType: string; ts: number; payloadJson: string }[];
}

/** [在场](../../../../docs/terms.md)上报落到哪（只有 Node 版的推送用它）。 */
export interface PresenceRecorder {
  mark(userId: string, conversationId: string): Promise<void>;
  clear(userId: string, conversationId: string): Promise<void>;
}

export interface ChatRouteDeps {
  /** 会话表、授权表所在的库：Node 版的共享库，Cloudflare 版的 D1。 */
  db: Db;
  backend: ConversationBackend;
  authMiddleware: MiddlewareHandler<ChatEnv>;
  /** 建会话时核对仓库、签安装令牌。 */
  githubApp: GithubApp;
  /** `GET /api/chat/config` 的答案：这台服务端能做什么。 */
  capabilities: () => ChatConfigDto;
  /** 沙盒空闲多久算休眠——DTO 里的 `sleeping` 是读时推出来的。 */
  sandboxIdleTimeoutMs: number;
  telemetry?: TurnTelemetryReader;
  presence?: PresenceRecorder;
  host?: ChatHostHooks;
  /** 吞掉的续期失败记在哪。 */
  onSwallowedError?: (
    where: string,
    conversationId: string,
    error: unknown,
  ) => void;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const IDLE_LIVE_STATE: ConversationLiveState = {
  queuedMessages: [],
  turnInProgress: false,
  pendingDecisions: 0,
};

function toConversationDto(
  row: ConversationRow,
  live: ConversationLiveState,
  idleTimeoutMs: number,
): ConversationDto {
  // `sleeping` 是读时推的、不落库：休眠发生在沙盒平台那边（空闲超时到了自己停），服务端没有
  // 定时器去翻这一列，所以存着 `active` 但空闲窗口已过的，一律显示成 `sleeping`。下一条消息的
  // `acquire` 会把沙盒叫醒、刷新 `lastActiveAt`，它就翻回来了。
  const idleElapsed = Date.now() - row.lastActiveAt.getTime() > idleTimeoutMs;
  return {
    id: row.id,
    title: row.title,
    repo: row.repo,
    branchName: row.branchName,
    sandboxName: row.sandboxName,
    provider: row.provider,
    status: row.status === 'active' && idleElapsed ? 'sleeping' : row.status,
    lastActiveAt: row.lastActiveAt.toISOString(),
    queuedMessages: live.queuedMessages,
    // [skill 清单](../../../../docs/terms.md)缓存（docs/ingress/tech/composer-skill-mention.md §2.1）
    // ——读的是库里的快照，这条路径**不碰沙盒**，休眠会话也能列菜单。缓存为空时
    // 退到兜底清单（本功能上线前建的会话就是这一档），否则用户打 `/` 什么都没有。
    availableSkills: resolveSkillCatalog(
      parseAvailableSkills(row.availableSkillsJson, row.id),
    ),
    turnInProgress: live.turnInProgress,
    pendingDecisions: live.pendingDecisions,
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
export function toQueueDto(queue: readonly QueuedInput[]): QueuedMessage[] {
  return queue.map((item) => ({
    id: item.id,
    text: item.input.text,
    userId: item.input.userId ?? '',
    createdAt: item.createdAt,
  }));
}

/**
 * 框架的 `Frame` → wire 帧。五种帧一一对应，只有队列那种要翻译一下形状。
 *
 * [进行中草稿](../../../../docs/terms.md)在内存里，所以 `chunk` 帧**一律没有 `seq`**：
 * 它们只直播、不落库、不参与 `after=` 续传。SSE 与 WebSocket 两条通道用的是同一个函数。
 */
export function toWireFrame(frame: Frame): ChatReplayFrame {
  switch (frame.kind) {
    case 'message':
      return { seq: frame.seq, message: frame.message };
    case 'chunk':
      return { chunk: frame.chunk };
    case 'queue':
      return { queue: toQueueDto(frame.queue) };
    case 'activity':
      return { turnActive: frame.active };
    case 'reconnect':
      return { reconnect: true };
  }
}

/** wire 帧的 SSE `event:` 名——五种帧靠「带了哪个字段」区分（见 `schemas/chat.ts`）。 */
function frameEventName(
  frame: ChatReplayFrame,
): 'chunk' | 'message' | 'queue' | 'turn-state' | 'reconnect' {
  if ('chunk' in frame) {
    return 'chunk';
  }
  if ('queue' in frame) {
    return 'queue';
  }
  if ('reconnect' in frame) {
    return 'reconnect';
  }
  return 'turnActive' in frame ? 'turn-state' : 'message';
}

export function generateSandboxName(conversationId: string): string {
  return `runko-chat-${conversationId}`;
}

function generateBranchName(conversationId: string): string {
  return `runko/chat-${conversationId}`;
}

/**
 * 状态在持有者进程内存里的那几条路由：那一轮的 `AbortController`、正在等人的那个 promise、
 * 以及改完队列要广播的那帧快照。多副本的宿主（`ChatHostHooks.holderGate`）要把它们转给持有者。
 *
 * `…/messages` 在列表里只因为它的 **POST**（起轮/插话/排队要在持有者那边发生）；它的
 * GET 是纯回放、哪个副本都能答，但转过去也只是多一跳，不值得为此再拆一条路由。
 */
export const HOLDER_STATE_PATHS = [
  '/api/chat/conversations/:id/messages',
  '/api/chat/conversations/:id/abort',
  '/api/chat/conversations/:id/queue',
  '/api/chat/conversations/:id/queue/:messageId',
  '/api/chat/conversations/:id/approvals/:callId',
  '/api/chat/conversations/:id/questions/:callId',
] as const;

export const STREAM_PATH = '/api/chat/conversations/:id/stream';

export function createChatRoutes(deps: ChatRouteDeps) {
  const app = new OpenAPIHono<ChatEnv>();
  const { backend, githubApp } = deps;
  const runtime = backend.runtime;

  async function touchSandbox(
    where: string,
    conversationId: string,
  ): Promise<void> {
    try {
      await backend.extendSandboxLifetime(conversationId);
    } catch (error) {
      // 刻意吞掉：调用点的主动作（插话、排队、审批、答复）已经做完或必须照做。续期失败
      // 只是沙盒可能提前睡，真正的可用性问题会在这一轮里以一条 failed 收尾帧浮现。
      deps.onSwallowedError?.(where, conversationId, error);
    }
  }

  async function liveStateOf(
    conversationId: string,
  ): Promise<ConversationLiveState> {
    const states = await backend.liveStates([conversationId]);
    return states.get(conversationId) ?? IDLE_LIVE_STATE;
  }

  const beforeAuth = deps.host?.beforeAuth;
  if (beforeAuth !== undefined) {
    app.use('/api/chat/*', beforeAuth);
  }

  app.use('/api/chat/*', deps.authMiddleware);

  const holderGate = deps.host?.holderGate;
  if (holderGate !== undefined) {
    const paths: string[] = [...HOLDER_STATE_PATHS];
    if (holderGate.coversStream) {
      paths.push(STREAM_PATH);
    }
    for (const path of paths) {
      app.use(path, holderGate.handler);
    }
  }

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
      400: {
        content: { 'application/json': { schema: ErrorSchema } },
        description:
          '这台服务端没开这种沙盒；云沙盒 provider 没带 `repo`，或本地沙盒带了 `repo`（docs/ingress/tech/github-repo-access.md §5）',
      },
      401: {
        content: { 'application/json': { schema: ErrorSchema } },
        description: 'Unauthorized',
      },
      403: {
        content: { 'application/json': { schema: ErrorSchema } },
        description: '`github_repo_forbidden`——这个安装里核对不到这个仓库',
      },
      404: {
        content: { 'application/json': { schema: ErrorSchema } },
        description: '`github_not_configured`——服务端没配 GitHub App',
      },
      409: {
        content: { 'application/json': { schema: ErrorSchema } },
        description: '`github_not_linked`——这个用户还没连接 GitHub',
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

    const conversationId = crypto.randomUUID();
    const sandboxName = generateSandboxName(conversationId);
    const capabilities = deps.capabilities();
    const provider = input.provider ?? capabilities.defaultProvider;
    if (!capabilities.providers.includes(provider)) {
      return c.json(
        {
          error: `sandbox provider "${provider}" is not available on this server`,
        },
        400,
      );
    }
    // [本地沙盒](../../../../docs/terms.md)没有 git，也就没有仓库与工作分支——这一档
    // 不接受 `repo`，零配置才起得来。
    const usesGit = provider !== 'local';
    const branchName = usesGit ? generateBranchName(conversationId) : null;

    if (usesGit && input.repo === undefined) {
      return c.json(
        { error: 'repo is required for cloud sandbox providers' },
        400,
      );
    }
    if (!usesGit && input.repo !== undefined) {
      return c.json(
        { error: 'repo is not allowed for the local sandbox provider' },
        400,
      );
    }

    let repoRef: GithubRepoRef | undefined;
    let githubToken: string | undefined;
    let repoFullName: string | undefined;
    if (usesGit && input.repo !== undefined) {
      const selector = {
        userId,
        installationId: input.repo.installationId,
        repoId: input.repo.repoId,
      };
      try {
        // 用用户令牌核对这个安装里真有这个仓库，再签一把只对它有效的安装令牌
        // （docs/ingress/tech/github-repo-access.md §3.2）——两步都在 `getRepoToken` 里。
        const access = await githubApp.getRepoToken(selector);
        repoFullName = access.repo.fullName;
        repoRef = splitFullName(access.repo.fullName);
        githubToken = access.token;
      } catch (error) {
        const kind = classifyGithubError(error);
        if (kind === 'not-configured') {
          return c.json({ error: 'github_not_configured' }, 404);
        }
        if (kind === 'not-linked') {
          return c.json({ error: 'github_not_linked' }, 409);
        }
        if (kind === 'forbidden') {
          return c.json({ error: 'github_repo_forbidden' }, 403);
        }
        return c.json({ error: describeError(error) }, 500);
      }
    }

    let provisioned: ProvisionResult;
    try {
      provisioned = await backend.provision({
        conversationId,
        provider,
        sandboxName,
        ...(branchName !== null ? { branchName } : {}),
        ...(repoRef !== undefined ? { repo: repoRef } : {}),
        ...(githubToken !== undefined ? { githubToken } : {}),
      });
    } catch (error) {
      return c.json({ error: describeError(error) }, 500);
    }

    const row = await createConversation(deps.db, {
      id: conversationId,
      userId,
      title: input.title ?? 'New chat',
      repo: repoFullName ?? null,
      branchName,
      sandboxName,
      provider,
      sandboxId: provisioned.sandboxId,
      githubInstallationId: input.repo?.installationId ?? null,
      githubRepoId: input.repo?.repoId ?? null,
    });

    // [skill 清单](../../../../docs/terms.md)首次填充（docs/ingress/tech/composer-skill-mention.md §2.1）：
    // 沙盒此刻刚就绪，就地写库——否则新会话要等第一轮跑完才有菜单可用。
    const availableSkillsJson = await syncAvailableSkills(
      deps.db,
      conversationId,
      row.availableSkillsJson,
      provisioned.skills,
    );

    // 刚建好的会话：没有排队消息，也还没有轮在跑。
    return c.json(
      toConversationDto(
        { ...row, availableSkillsJson },
        IDLE_LIVE_STATE,
        deps.sandboxIdleTimeoutMs,
      ),
      201,
    );
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
  app.openapi(listSessionsRoute, async (c) => {
    const userId = c.get('userId');
    const rows = await listConversations(deps.db, userId);
    const live = await backend.liveStates(rows.map((row) => row.id));
    return c.json(
      rows.map((row) =>
        toConversationDto(
          row,
          live.get(row.id) ?? IDLE_LIVE_STATE,
          deps.sandboxIdleTimeoutMs,
        ),
      ),
      200,
    );
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
  app.openapi(getSessionRoute, async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    const row = await getConversation(deps.db, id, userId);
    if (row === undefined) {
      return c.json({ error: 'Not found' }, 404);
    }
    return c.json(
      toConversationDto(
        row,
        await liveStateOf(row.id),
        deps.sandboxIdleTimeoutMs,
      ),
      200,
    );
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
    const row = await getConversation(deps.db, id, userId);
    if (row === undefined) {
      return c.json({ error: 'Not found' }, 404);
    }

    // [账本](../../../../docs/terms.md)现在只有成品消息——[进行中草稿](../../../../docs/terms.md)
    // 在内存里，只走[直播流](../../../../docs/terms.md)。所以这个端点回放出来的必然全是
    // `MessageFrame`，前端拿到就能直接拼进消息列表。
    const entries = await runtime.readLedger(
      id,
      after !== undefined ? { afterSeq: after } : {},
    );
    const frames: ChatReplayFrame[] = entries.map((entry) => ({
      seq: entry.seq,
      message: entry.message,
    }));
    return c.json({ frames }, 200);
  });

  // ---- GET /api/chat/conversations/{id}/turns/{turn}/telemetry (docs/ingress/tech/chat-webapp.md §11.4) ----

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
  app.openapi(turnTelemetryRoute, async (c) => {
    const userId = c.get('userId');
    const { id, turn } = c.req.valid('param');
    const row = await getConversation(deps.db, id, userId);
    if (row === undefined) {
      return c.json({ error: 'Not found' }, 404);
    }

    // 遥测按 runko 会话 id（functionId 的前半段）落库，而**会话 id 就是 conversationId**
    // （框架从账本重建 `SessionState` 时直接拿它当 session id），所以这里查的就是 `row.id`。
    const reader = deps.telemetry;
    if (reader === undefined) {
      return c.json({ events: [] }, 200);
    }
    const events = reader
      .list(row.id, turn)
      .map(({ eventType, ts, payloadJson }) => ({
        eventType,
        ts,
        payloadJson,
      }));
    return c.json({ events }, 200);
  });

  // ---- POST /api/chat/conversations/{id}/messages (starts a turn, docs/ingress/tech/chat-webapp.md §2.2b) ----

  const postMessageRoute = createRoute({
    method: 'post',
    path: '/api/chat/conversations/{id}/messages',
    tags: ['Chat'],
    summary:
      'Start a turn, queue this message for the next one, or steer the in-progress turn (docs/logic/orchestration/tech/steer-and-queue.md §4.1): with no turn running this acquires the sandbox, builds the session and hands off to the in-process turn runner (mode "started"); with one running it either queues `text` onto the conversation’s 待发队列 (mode "queued", the default) or injects it into the running turn via `Session.steer()` (mode "steered", `intent: "steer"`). Either way, events arrive over `GET .../stream`, not this response',
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
          'Either the 待发队列 is full (docs/logic/orchestration/features/steer-and-queue.md §2.3 — nothing is ever silently dropped), or a turn was already in progress and could not be steered either (narrow race — the turn ended between the steer attempt and the fallback start)',
      },
      500: {
        content: { 'application/json': { schema: ErrorSchema } },
        description: 'Model/sandbox configuration or provisioning error',
      },
      503: {
        content: { 'application/json': { schema: ErrorSchema } },
        description:
          'Nothing was done; safe to resend. Either the node is going offline and the message could not be queued (queueing is disabled — with queueing on, messages sent during handover are queued and answered 202, docs/logic/orchestration/tech/handover.md §10.2), or the holder of this conversation could not be reached (see `Retry-After`)',
      },
      504: {
        content: { 'application/json': { schema: ErrorSchema } },
        description:
          'Forwarded to the holder, but it did not answer in time — the message may or may not have been accepted. Check the conversation before resending',
      },
    },
  });
  app.openapi(postMessageRoute, async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    const { text, intent } = c.req.valid('json');

    const row = await getConversation(deps.db, id, userId);
    if (row === undefined) {
      return c.json({ error: 'Not found' }, 404);
    }

    // **三路分流全在框架里判一次**（`runtime.enqueue`）：有没有轮在跑、装配中还是真在
    // 跑、该排队还是该插话、以及「查完队列没活儿了到真正释放归属之间用户又发了一条」
    // 那个竞态的兜底。这里只负责把结果翻成 HTTP。
    const outcome = await runtime.enqueue(
      id,
      { text, userId },
      { intent: intent === 'steer' ? 'steer' : 'queue' },
    );

    if (outcome.mode === 'started') {
      return c.json({ ok: true as const, mode: 'started' as const }, 202);
    }
    if (outcome.mode === 'steered') {
      // 与新起一轮一样，把沙盒空闲计时往后推。吞掉失败：插话已经注入进正在跑的那一轮了，
      // 回 500 会让用户以为没发出去、再发一遍——同一句话进去两次。
      await touchSandbox('steer', id);
      return c.json({ ok: true as const, mode: 'steered' as const }, 202);
    }
    if (outcome.mode === 'queued') {
      // 用户还在场，沙盒别在这一轮跑完前睡掉。消息已经入队了，续期失败不该让这次请求失败。
      await touchSandbox('queue', id);
      return c.json({ ok: true as const, mode: 'queued' as const }, 202);
    }

    // 四种拒绝的处置各不相同（`@runko/agent` 的 `EnqueueRejection`）。
    if (outcome.reason === 'shutting_down') {
      // 节点在[交权](docs/terms.md)，而队列关着、排不进去，只能拒。回 503，客户端重发即可。
      // 队列开着时，下线期间的消息照常排队（docs/logic/orchestration/tech/handover.md §10.2）。
      // 不能报 409（那是「你已经有一轮在跑」，会误导）。
      return c.json({ error: '服务正在重启，请稍后重试' }, 503);
    }
    if (outcome.reason === 'queue_full' || outcome.reason === 'busy') {
      return c.json({ error: outcome.message }, 409);
    }
    // `held_by_other`：归属在别的副本手上（只有多副本的宿主会遇到）。框架把地址放在 `holder`
    // 字段里，怎么处置交给宿主——Node 版就地转过去，把持有者的回执原样交回。
    if (outcome.reason === 'held_by_other') {
      const handled = await deps.host?.onHeldByOther?.(c, outcome.holder);
      if (handled?.kind === 'ack') {
        return c.json(handled.ack, 202);
      }
      // 结果未知就照实说：回 503 的话负载均衡会把这条消息换节点再发一遍。
      if (handled?.kind === 'unknown') {
        return c.json({ error: outcome.message }, 504);
      }
      c.header('retry-after', handled?.retryAfterSeconds ?? '1');
      return c.json({ error: outcome.message }, 503);
    }
    return c.json({ error: outcome.message }, 500);
  });

  // ---- POST /api/chat/conversations/{id}/abort (docs/logic/orchestration/tech/turn-abort.md §3.2) ----

  const abortTurnRoute = createRoute({
    method: 'post',
    path: '/api/chat/conversations/{id}/abort',
    tags: ['Chat'],
    summary:
      '[停止](docs/terms.md)这个会话进行中的那一轮（docs/logic/orchestration/tech/turn-abort.md）：中止当前轮并清空[待发队列](docs/terms.md)。200 只表示「停止已请求」——真正停下的时刻取决于 agent 当时在做什么（最坏情况是一条 bash 命令响应中断信号的时间），「已停止」这个结果走 `GET .../stream` 上那条 `status: "interrupted"` 的 `message-metadata` chunk 送达',
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

    const row = await getConversation(deps.db, id, userId);
    if (row === undefined) {
      return c.json({ error: 'Not found' }, 404);
    }

    // 「先判有没有轮在跑、再清队列、最后 abort」这套顺序在框架里（`runtime.abort`）——
    // 没有轮在跑时它**不动队列**（否则一次误点就是一次丢消息），有轮在跑时它保证清队列
    // 排在 abort 之前（否则 abort 解开挂起的审批后这一轮可能立刻收尾、把队首那条发出去，
    // 而用户刚按的是「停止」）。
    if (!(await runtime.abort(id))) {
      return c.json({ error: 'no turn in progress' }, 409);
    }
    return c.json({ ok: true as const, queue: [] }, 200);
  });

  // ---- DELETE /api/chat/conversations/{id}/queue/{messageId} (docs/logic/orchestration/tech/steer-and-queue.md §4.2) ----

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

    const row = await getConversation(deps.db, id, userId);
    if (row === undefined) {
      return c.json({ error: 'Not found' }, 404);
    }

    // 广播新快照归框架（多标签同步）——这里只翻形状。
    const { removed, queue } = await runtime.removeQueued(id, messageId);
    if (!removed) {
      return c.json({ error: 'Not found' }, 404);
    }

    return c.json({ queue: toQueueDto(queue) }, 200);
  });

  // ---- DELETE /api/chat/conversations/{id}/queue (docs/logic/orchestration/tech/steer-and-queue.md §4.2) ----

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

    const row = await getConversation(deps.db, id, userId);
    if (row === undefined) {
      return c.json({ error: 'Not found' }, 404);
    }

    const queue = await runtime.clearQueue(id);
    return c.json({ queue: toQueueDto(queue) }, 200);
  });

  // ---- GET /api/chat/conversations/{id}/stream?after=<seq> (resumable live tail, docs/ingress/tech/chat-webapp.md §2.2b) ----

  const streamTurnRoute = createRoute({
    method: 'get',
    path: '/api/chat/conversations/{id}/stream',
    tags: ['Chat'],
    summary:
      'Resumable live tail of a session’s in-progress turn (docs/ingress/tech/chat-webapp.md §2.2b): replays persisted frames after `after`, then forwards the turn’s live chunks until it ends — reconnect-safe (page refresh/HMR/network blip never lose events)',
    request: {
      params: ConversationParamsSchema,
      query: ConversationReplayQuerySchema,
    },
    responses: {
      200: {
        content: { 'text/event-stream': { schema: chatReplayFrameSchema } },
        description:
          'SSE stream of `ChatReplayFrame`s (`{seq,message}` or `{seq?,chunk}`): replay, then live tail (closes once the turn ends, or immediately after replay if no turn is in progress). Live `chunk` frames omit `seq` when ephemeral (docs/logic/orchestration/tech/single-ledger.md §5 单-3 — `text-delta`/`reasoning-delta`/`transient` data parts), never persisted and never replayed; every other frame always carries one',
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

    const row = await getConversation(deps.db, id, userId);
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
      // [节点下线](../../../../docs/terms.md)时这条流由框架结束：这份对话交接完，最后一帧是请重连帧
      // （`reconnect`），前端收到就立刻重连，落到新的持有者上。
      const signal = abort.signal;

      for await (const frame of runtime.subscribe(id, {
        ...(after !== undefined ? { after } : {}),
        signal,
      })) {
        const wire = toWireFrame(frame);
        await stream.writeSSE({
          event: frameEventName(wire),
          data: JSON.stringify(wire),
        });
      }
    });
  });

  // ---- GET /api/chat/conversations/{id}/activity ----

  const activityRoute = createRoute({
    method: 'get',
    path: '/api/chat/conversations/{id}/activity',
    tags: ['Chat'],
    summary: '这条会话此刻有没有轮在跑、归哪个副本跑（多副本运维与验证用）',
    request: { params: ConversationParamsSchema },
    responses: {
      200: {
        content: { 'application/json': { schema: ActivitySchema } },
        description: 'Activity',
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
  app.openapi(activityRoute, async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    const row = await getConversation(deps.db, id, userId);
    if (row === undefined) {
      return c.json({ error: 'Not found' }, 404);
    }
    const activity = await runtime.getActivity(id);
    return c.json(
      {
        active: activity.active,
        local: activity.local,
        ...(activity.holder !== undefined ? { holder: activity.holder } : {}),
      },
      200,
    );
  });

  // ---- GET /api/chat/config ----

  const chatConfigRoute = createRoute({
    method: 'get',
    path: '/api/chat/config',
    tags: ['Chat'],
    summary:
      '这台服务端能做什么：能选哪几档沙盒、用的是真模型还是演示模型（docs/ingress/tech/unified-demo.md §4.3）',
    responses: {
      200: {
        content: { 'application/json': { schema: ChatConfigSchema } },
        description: 'Capabilities',
      },
      401: {
        content: { 'application/json': { schema: ErrorSchema } },
        description: 'Unauthorized',
      },
    },
  });
  app.openapi(chatConfigRoute, (c) => c.json(deps.capabilities(), 200));

  // ---- POST /api/chat/conversations/{id}/presence (在场心跳, docs/ingress/tech/push-notification.md §5.2) ----

  const presenceRoute = createRoute({
    method: 'post',
    path: '/api/chat/conversations/{id}/presence',
    tags: ['Chat'],
    summary:
      '上报在场（见 docs/terms.md「在场」）：这条会话此刻是否正在调用者眼前（docs/ingress/tech/push-notification.md §5.2）。在场期间不向这个人推送本会话的通知',
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
  app.openapi(presenceRoute, async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    const { focused } = c.req.valid('json');

    // 属主校验与本文件其它会话级接口一致（不存在与不属于自己都回 404，不泄露
    // 存在性）。刻意**不**续沙盒：心跳每 20 秒一次，让"盯着页面发呆"
    // 无限续沙盒的命，既烧钱又把空闲休眠这套机制架空。
    const row = await getConversation(deps.db, id, userId);
    if (row === undefined) {
      return c.json({ error: 'Not found' }, 404);
    }

    // 在场**只用于推送的前台抑制**，不喂给框架的 `reportPresence`（那会把等人的内存窗口往后推）。
    // 沙盒为等人续命只续到审批保活预算（5 分钟）为止；窗口要是被在场一直推着，沙盒会先睡着，
    // 这时点「允许」是在一个睡着的沙盒上跑命令。挂起再恢复则会走起轮装配、先把沙盒叫醒
    // （docs/ingress/tech/chat-webapp.md §6.3）。没有推送的宿主不记。
    const presence = deps.presence;
    if (presence !== undefined) {
      if (focused) {
        await presence.mark(userId, id);
      } else {
        await presence.clear(userId, id);
      }
    }

    return c.json({ ok: true as const }, 200);
  });

  // ---- POST /api/chat/conversations/{id}/approvals/{callId} (resolve a pending approval, docs/ingress/tech/chat-webapp.md §2.2c（审批链）) ----

  const postApprovalRoute = createRoute({
    method: 'post',
    path: '/api/chat/conversations/{id}/approvals/{callId}',
    tags: ['Chat'],
    summary:
      '批准或拒绝一个待处理的工具调用审批请求（docs/ingress/tech/chat-webapp.md §2.2c（审批链），docs/logic/orchestration/tech/single-ledger.md §6）：结果通过 `GET .../stream` 的 `tool-approval-response` chunk 送达，本响应只是一个 ack',
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

    const row = await getConversation(deps.db, id, userId);
    if (row === undefined) {
      return c.json({ error: 'Not found' }, 404);
    }

    if (behavior !== 'deny') {
      // 把沙盒空闲计时往后推，同其它 in-turn 触点——但**绝不能拦住裁决本身**：
      // 续期抛了（沙盒已经没了、临时错误），这条挂起的工具调用照样需要被结掉，否则它一直
      // 挂到审批超时才被自动拒绝，比让 `exec()` 自己把沙盒可用性问题报成一次普通的工具失败更糟。
      await touchSandbox('approval', id);
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
        (await backend.listPendingDecisions(id)).find(
          (entry) => entry.toolCallId === callId,
        )
      : undefined;

    const resolved = await runtime.submitDecision(id, callId, {
      outcome: behavior === 'deny' ? 'deny' : 'allow',
      scope: behavior === 'allow-session' ? 'conversation' : 'once',
      decidedBy: userId,
      ...(message !== undefined ? { message } : {}),
    });
    if (!resolved) {
      return c.json({ error: 'Not found' }, 404);
    }

    if (grant?.toolName !== undefined) {
      await grantConversationApproval(
        deps.db,
        id,
        userId,
        grant.toolName,
        grant.payload ?? null,
      );
    }

    return c.json({ ok: true as const }, 200);
  });

  // ---- POST /api/chat/conversations/{id}/questions/{callId} (answer a pending ask-user question, docs/ingress/tech/chat-webapp.md §2.2c（审批链）) ----

  const postAnswerRoute = createRoute({
    method: 'post',
    path: '/api/chat/conversations/{id}/questions/{callId}',
    tags: ['Chat'],
    summary:
      '回答一个待处理的 ask-user 提问（docs/ingress/tech/chat-webapp.md §2.2c（审批链））：结果通过 `GET .../stream` 的 `tool-ask-user` 部件 output-available 状态送达，本响应只是一个 ack',
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

    const row = await getConversation(deps.db, id, userId);
    if (row === undefined) {
      return c.json({ error: 'Not found' }, 404);
    }

    // 无条件续期（不像审批那支只在放行时续——答复总是让这一轮继续，没有「拒绝」的对应物），
    // 同样绝不能拦住答复本身。
    await touchSandbox('answer', id);

    const resolved = await runtime.submitAnswer(id, callId, answer, {
      decidedBy: userId,
    });
    if (!resolved) {
      return c.json({ error: 'Not found' }, 404);
    }

    return c.json({ ok: true as const }, 200);
  });

  return app;
}

/** 方便宿主写 `liveStates`：一个会话的队列与轮状态都问运行时，待答数由调用方另给。 */
export async function readRuntimeLiveState(
  runtime: Pick<ConversationRuntime, 'listQueue' | 'getActivity'>,
  conversationId: string,
  pendingDecisions: number,
): Promise<ConversationLiveState> {
  const [queue, activity] = await Promise.all([
    runtime.listQueue(conversationId),
    runtime.getActivity(conversationId),
  ]);
  return {
    queuedMessages: toQueueDto(queue),
    turnInProgress: activity.active,
    pendingDecisions,
  };
}

/**
 * 用 `SandboxManager` 把一个新会话的沙盒准备好——两个服务端的 `provision` 都是这几步：
 * 拿沙盒（云沙盒顺带克隆仓库、开工作分支）、扫一遍 skill。
 *
 * `loadSkillsFromWorkspace` 自身不抛（扫不到就是空数组），所以扫 skill 不会让建会话失败。
 */
export async function provisionWithSandboxManager(
  sandboxManager: SandboxManager,
  input: ProvisionInput,
  log: Logger,
): Promise<ProvisionResult> {
  const { provider, sandboxName, repo } = input;
  const acquired = await sandboxManager.acquire({
    conversationId: input.conversationId,
    provider,
    sandboxName,
    // 除 E2B 外都按事先就知道的名字恢复（第一次 acquire 找不到就新建）；E2B 还没有
    // sandboxId，直接走创建。
    resumeToken: provider === 'e2b' ? undefined : sandboxName,
    ...(input.branchName !== undefined ? { branchName: input.branchName } : {}),
    ...(repo !== undefined ?
      {
        repoCloneUrl: repo.cloneUrl,
        repoOwner: repo.owner,
        repoName: repo.repo,
      }
    : {}),
    ...(input.githubToken !== undefined ?
      { githubToken: input.githubToken }
    : {}),
  });
  return {
    // E2B 的重连令牌是创建之后才知道的 sandboxId；其余档按名字恢复，没什么要存。
    sandboxId: provider === 'e2b' ? acquired.resumeToken : null,
    skills: toSkillSummaries(
      await loadSkillsFromWorkspace(acquired.workspace, log),
    ),
  };
}
