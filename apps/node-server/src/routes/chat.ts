/**
 * chat 路由的 Node 版装配。路由本身两个服务端共用（`@runko-chat/shared/routes/chat`）；这里把
 * 进程内的 `@runko/agent` 运行时包成会话后端，再接上只有 Node 才有的三样：多副本转发、
 * 推送的[在场](../../../../docs/terms.md)、遥测库。
 */
import type { AgentRuntime, DecisionStore } from '@runko/agent';
import type { SessionTelemetry } from '@runko/core';
import type { GithubApp } from '@runko-chat/shared/agent/github-app';
import { createLocalProvider } from '@runko-chat/shared/agent/local-sandbox';
import { hasRealModel, resolveModel } from '@runko-chat/shared/agent/model';
import type {
  SandboxManager,
  SandboxProviderId,
} from '@runko-chat/shared/agent/sandbox-manager';
import {
  createSandboxManager,
  resolveIdleTimeoutMs,
} from '@runko-chat/shared/agent/sandbox-manager';
import type { Db } from '@runko-chat/shared/agent/store';
import { getConversation } from '@runko-chat/shared/agent/store';
import { logger as defaultLogger } from '@runko-chat/shared/logger';
import type {
  ChatEnv,
  ChatHostHooks,
  ConversationBackend,
  HeldByOtherOutcome,
} from '@runko-chat/shared/routes/chat';
import {
  createChatRoutes,
  provisionWithSandboxManager,
  readRuntimeLiveState,
} from '@runko-chat/shared/routes/chat';
import { StartTurnAckSchema } from '@runko-chat/shared/schemas/chat';
import type { LanguageModel } from 'ai';
import type { Context, MiddlewareHandler } from 'hono';

import {
  availableProviders,
  createE2bProvider,
  createVercelProvider,
  resolveDefaultProvider,
} from '../agent/cloud-sandboxes.js';
import { defaultGithubApp } from '../agent/github.js';
import {
  createChatNodeRegistry,
  createChatPersistence,
  readReleaseSeq,
  resolveNodeName,
} from '../agent/persistence.js';
import { countPendingDecisions } from '../agent/runko-tables.js';
import { createChatRuntime } from '../agent/runtime.js';
import { createChatStream } from '../agent/stream.js';
import { db as defaultDb } from '../db/instance.js';
import { requireAuth } from '../middleware/auth.js';
import { createNodeOffline } from '../offline.js';
import { createChatNotifier } from '../push/notifier.js';
import { clearPresent, markPresent } from '../push/presence.js';
import type { TelemetryStore } from '../telemetry.js';
import { getChatTelemetry, getChatTelemetryStore } from '../telemetry.js';
import type { Forwarder } from './forward.js';
import {
  createForwarder,
  resolveNodeIdentity,
  RESULT_UNKNOWN_STATUS,
  RETRY_AFTER_SECONDS,
} from './forward.js';
import { createTakeoverApp, createTakeoverRequester } from './takeover.js';

export interface ChatRouteDeps {
  db: Db;
  /**
   * [轮编排](../../../../docs/terms.md)运行时（`@runko/agent`）——一轮的一生、
   * [排队](../../../../docs/terms.md)、[停止](../../../../docs/terms.md)、人在回路全归它。
   */
  runtime: AgentRuntime;
  /**
   * 框架的[裁决表](../../../../docs/terms.md)读口。**只为一件事**：用户点「会话内都允许」
   * 时，路由要拿这次调用的 tool + 原始入参去记一条[会话级授权](../../../../docs/terms.md)
   * ——而路由手上只有 `callId`。裁决表是框架唯一知道这两样的地方。
   */
  decisions: DecisionStore;
  /**
   * 多副本时把请求转给[归属](../../../../docs/terms.md)持有者。不传 = 单进程跑法，
   * 一律本地答。
   */
  forwarder?: Forwarder;
  /**
   * 直播流要不要也转给持有者。
   *
   * **配了 Redis 广播就不转**（`false`）：内容会到每个副本，就地订阅即可——转过去只是
   * 多一跳，持有者一崩连接还跟着断。没有 Redis 时必须转：[进行中草稿](../../../../docs/terms.md)
   * 只在持有者内存里。见 docs/host/node/tech/cluster-lab.md §5。
   */
  forwardStream?: boolean;
  sandboxManager: SandboxManager;
  resolveModel: () => LanguageModel;
  /**
   * GitHub App 客户端（docs/ingress/tech/github-repo-access.md §6）：建会话时核对仓库、
   * 签安装令牌。缺省用生产单例（`defaultGithubApp`）——测试注入一个假的，零网络零凭证。
   */
  githubApp?: GithubApp;
  /**
   * 可注入，集成测试才能塞一个固定 `userId` 的桩，不必走真的 better-auth（它绑死在单例
   * `db`/`auth` 上，不认测试传进来的 `Db`）。生产装配见文件底部，用的是真的 `requireAuth`。
   */
  authMiddleware: MiddlewareHandler<ChatEnv>;
  /** telemetry 事件集成（`@runko/core` `SessionTelemetry`，docs/ingress/tech/chat-webapp.md §11.4）——交给运行时，逐 turn 的模型调用事件落 SQLite；缺省 = 不采集。 */
  telemetry?: SessionTelemetry;
  /**
   * 同一个遥测库的读口：turn 遥测明细端点用它查数（`TelemetryStore.list`）。缺省 =
   * 端点恒返回空数组。
   */
  telemetryStore?: TelemetryStore;
  /**
   * 这台服务端开了哪几档沙盒：`GET /api/chat/config` 报它，建会话只收它里面的。缺省按环境变量算
   * （`availableProviders`）；集成测试的假沙盒不看环境变量，由测试按自己注册的那几档给。
   */
  availableProviders?: () => SandboxProviderId[];
}

/**
 * 这一轮归别人跑吗？归的话把请求原样转过去，返回上游的响应；不归就返回 `undefined`，
 * 由调用方照常在本副本答。
 *
 * **判据只有一条：这件事的状态在库里，还是在持有者的进程内存里。** 前者哪个副本都能答，
 * 后者必须转。带着转发标记进来的一律自己答——那说明已经转过一次，再转就是环路。
 */
async function forwardToHolder(
  c: Context<ChatEnv>,
  deps: ChatRouteDeps,
  conversationId: string,
): Promise<Response | undefined> {
  const forwarder = deps.forwarder;
  if (forwarder === undefined || forwarder.isForwarded(c)) {
    return undefined;
  }
  // 先确认这条会话是调用者自己的，再决定转不转：不是他的就别占着一次跨副本往返，
  // 让本副本照常答 404（持有者那边也会再查一遍，这里只是别白跑一趟）。
  const owned = await getConversation(deps.db, conversationId, c.get('userId'));
  if (owned === undefined) {
    return undefined;
  }
  const activity = await deps.runtime.getActivity(conversationId);
  if (!activity.active || activity.local || activity.holder === undefined) {
    return undefined;
  }
  return await forwarder.forward(c, activity.holder);
}

function createNodeHostHooks(deps: ChatRouteDeps): ChatHostHooks {
  const forwarder = deps.forwarder;
  if (forwarder === undefined) {
    return {};
  }

  /**
   * **要在持有者那边办的事，先转过去。**
   *
   * 写成中间件而不是写在各个处理器里：处理器的返回类型由 OpenAPI 路由定义钉死，而转发
   * 返回的是上游那条原样的响应（含 SSE 流）。会话归属由持有者再查一遍——它跑的是同一份
   * 代码，转过去的请求和用户直连的请求在它眼里没有区别。
   */
  const forwardToHolderMiddleware: MiddlewareHandler<ChatEnv> = async (
    c,
    next,
  ) => {
    const id = c.req.param('id');
    if (id !== undefined) {
      const forwarded = await forwardToHolder(c, deps, id);
      if (forwarded !== undefined) {
        return forwarded;
      }
    }
    await next();
    return undefined;
  };

  return {
    // 副本间令牌闸门。**只拦转发进来的请求**——终端用户的请求不带这个头，也不该被要求带。
    // 它防的是「伪造转发标记、逼这个副本在本地答」，越不过登录（用户身份仍走 cookie）。
    beforeAuth: async (c, next) => {
      const rejected = forwarder.reject(c);
      if (rejected !== undefined) {
        return rejected;
      }
      await next();
      return undefined;
    },
    // 直播流（`…/stream` 与 WebSocket 那条）单独一档：配了 Redis 广播就不转，见 `forwardStream`。
    holderGate: {
      handler: forwardToHolderMiddleware,
      coversStream: deps.forwardStream !== false,
    },
    // 走到这里说明归属**刚刚**易了主：转发中间件问的时候还在本地，等框架真去抢的时候
    // 已经不在了。两个人同时发消息就会撞上，所以不能简单回「稍后再试」——**就地转过去**，
    // 把持有者的回执原样交回。回执只有几十字节、没有流，读出来再照着回一次就行。
    onHeldByOther: async (c, holder): Promise<HeldByOtherOutcome> => {
      if (holder !== undefined && !forwarder.isForwarded(c)) {
        const upstream = await forwarder.forward(c, holder);
        if (upstream.status === RESULT_UNKNOWN_STATUS) {
          return { kind: 'unknown' };
        }
        const ack = StartTurnAckSchema.safeParse(await upstream.json());
        if (ack.success) {
          return { kind: 'ack', ack: ack.data };
        }
      }
      return { kind: 'retry', retryAfterSeconds: RETRY_AFTER_SECONDS };
    },
  };
}

/** 进程内运行时 → 会话后端。 */
function createNodeBackend(deps: ChatRouteDeps): ConversationBackend {
  return {
    runtime: deps.runtime,
    listPendingDecisions: (conversationId) =>
      deps.decisions.listPending(conversationId),
    async liveStates(conversationIds) {
      // 「等你答」一次分组查询数完；队列与「有没有轮在跑」按会话问框架。「有没有轮在跑」
      // 问的是 `getActivity`：它先看本进程的登记册，再看库里的归属——多副本时别的副本
      // 正在跑也算。
      const pending = await countPendingDecisions(deps.db, [
        ...conversationIds,
      ]);
      const entries = await Promise.all(
        conversationIds.map(
          async (id) =>
            [
              id,
              await readRuntimeLiveState(
                deps.runtime,
                id,
                pending.get(id) ?? 0,
              ),
            ] as const,
        ),
      );
      return new Map(entries);
    },
    provision: (input) =>
      provisionWithSandboxManager(deps.sandboxManager, input, defaultLogger),
    extendSandboxLifetime: (conversationId) =>
      deps.sandboxManager.ensureLifetime(conversationId),
  };
}

export function createChatApp(deps: ChatRouteDeps) {
  return createChatRoutes({
    db: deps.db,
    backend: createNodeBackend(deps),
    authMiddleware: deps.authMiddleware,
    githubApp: deps.githubApp ?? defaultGithubApp,
    capabilities: () => ({
      providers: (deps.availableProviders ?? availableProviders)(),
      defaultProvider: resolveDefaultProvider(),
      model: hasRealModel() ? ('deepseek' as const) : ('demo' as const),
      clusterConsole: true,
    }),
    sandboxIdleTimeoutMs: resolveIdleTimeoutMs(),
    ...(deps.telemetryStore !== undefined ?
      { telemetry: deps.telemetryStore }
    : {}),
    presence: {
      mark: (userId, conversationId) =>
        markPresent(deps.db, userId, conversationId),
      clear: (userId, conversationId) =>
        clearPresent(deps.db, userId, conversationId),
    },
    host: createNodeHostHooks(deps),
    onSwallowedError: (where, conversationId, error) => {
      defaultLogger.warn('chat', 'failed to extend sandbox lifetime', {
        where,
        conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });
}

/**
 * 生产装配。三样东西在这里成型：沙盒管理器、`@runko/agent` 运行时（`createChatRuntime`）、
 * 以及路由自己那几个可选外围（推送、遥测）。
 *
 * `chatRuntime` 单独导出，是因为 `index.ts` 还要用它：启动时 `recover()` 扫
 * [孤儿轮](../../../../docs/terms.md)；开始监听后 `start()` 登记节点、扫[待接手](../../../../docs/terms.md)；
 * 收到 SIGTERM 时 `shutdown()` [交权](../../../../docs/terms.md)。
 */
const defaultSandboxManager = createSandboxManager({
  vercel: createVercelProvider(),
  e2b: createE2bProvider(), // lazy — reads E2B_API_KEY only when an E2B conversation actually acquires
  local: createLocalProvider({ db: defaultDb }),
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

const defaultNode = resolveNodeIdentity();

/**
 * [流分发](../../../../docs/terms.md)：配了 `REDIS_URL` 就广播给所有副本。
 * 单独导出是为了让进程退出时收掉那两条连接（`index.ts`）。
 *
 * `nodeId` 直接给 `defaultNode?.url`、**不编兜底值**：没配 `RUNKO_NODE_URL` 时它就是
 * `undefined`，由 `createChatStream` 记一行 error 并退回进程内 fan-out。
 */
export const chatStream = createChatStream({
  url: process.env.REDIS_URL,
  nodeId: defaultNode?.url,
  logger: defaultLogger,
});

export const chatRuntime = createChatRuntime({
  db: defaultDb,
  sandboxManager: defaultSandboxManager,
  resolveModel,
  notifier: defaultNotifier,
  ...(chatStream.fanout !== undefined ? { stream: chatStream.fanout } : {}),
  ...defaultTelemetry,
  // [交权](../../../../docs/terms.md)：多副本时（配了 `RUNKO_NODE_URL`）登记到节点登记表，下线时把对话交给别的副本；
  // 单进程只有节点名，挑不到接手节点，对话打待接手标记，下一个进程起来时接走。
  handover: {
    node: resolveNodeName(),
    releaseSeq: readReleaseSeq(),
    // 请接手要副本间令牌：没配令牌的多副本只登记、不互相请接手（`routes/takeover.ts` 那边也不开端点），
    // 交出去的对话靠待接手标记与定时回捞接走。
    ...(defaultNode !== undefined ?
      {
        nodes: createChatNodeRegistry(defaultDb),
        ...((
          defaultNode.peerToken !== undefined && defaultNode.peerToken !== ''
        ) ?
          {
            requestTakeover: createTakeoverRequester(
              defaultNode,
              defaultLogger,
            ),
          }
        : {}),
      }
    : {}),
  },
});

/** [指定交接](../../../../docs/terms.md)的节点间端点，`app.ts` 挂在鉴权之外。 */
export const takeoverApp = createTakeoverApp({
  runtime: chatRuntime,
  node: defaultNode,
  logger: defaultLogger,
});

const defaultForwarder = createForwarder(defaultNode, defaultLogger);

/**
 * [节点下线](../../../../docs/terms.md)的闸门。`app.ts` 挂上它；`index.ts` 在 SIGTERM 时关闸门，
 * 交接完成后再挡转发来的请求。
 */
export const nodeOffline = createNodeOffline(defaultNode);

export const chatApp = createChatApp({
  db: defaultDb,
  runtime: chatRuntime,
  forwarder: defaultForwarder,
  // 广播到了每个副本，直播流就不必再转给持有者。
  forwardStream: !chatStream.broadcasts,
  decisions: createChatPersistence(defaultDb).decisions,
  sandboxManager: defaultSandboxManager,
  resolveModel,
  authMiddleware: requireAuth,
  ...defaultTelemetry,
});
