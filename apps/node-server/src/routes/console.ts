/**
 * [集群控制台](../../../../docs/terms.md) API：节点列表 + 会话挂在哪个节点下 +
 * 下线/上线。挂在登录中间件后面，**不设管理员**——demo 项目登录了就能用（功能手册 §2）。
 * 设计见 docs/host/node/tech/cluster-console.md §8。
 *
 * 这条 API **每个节点都有、不转发**：数据来自共享的数据库与同一个运维容器地址，
 * 哪个节点答都一样，不像 `routes/chat.ts` 那样要把请求转给某个特定的持有者。
 */
import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';

import { resolveTakeoverMs } from '../agent/persistence.js';
import { listActiveLeases } from '../agent/runko-tables.js';
import type { Db } from '../agent/store.js';
import type { OpsClient, OpsClientError } from '../console/ops-client.js';
import { createOpsClient, resolveOpsIdentity } from '../console/ops-client.js';
import { db as defaultDb } from '../db/instance.js';
import type { Logger } from '../logger.js';
import { logger as defaultLogger } from '../logger.js';
import { requireAuth } from '../middleware/auth.js';
import type { OpsNode } from '../ops/schema.js';
import { ErrorSchema } from '../schemas/api.js';
import type { ConsoleConversation, ConsoleNode } from '../schemas/console.js';
import {
  ConsoleNodeParamsSchema,
  ConsoleOfflineAckSchema,
  ConsoleOnlineAckSchema,
  ConsoleOverviewSchema,
} from '../schemas/console.js';
import { resolveNodeIdentity } from './forward.js';

type ConsoleEnv = { Variables: { userId: string } };

const LOG_SCOPE = 'console';

export interface ConsoleRouteDeps {
  db: Db;
  /** [归属仲裁](../../../../docs/terms.md)的接管阈值（毫秒）——判「疑似失联」用同一个数字，见 `agent/persistence.ts` 的 `resolveTakeoverMs`。 */
  takeoverMs: number;
  /** 没配运维容器（`RUNKO_OPS_URL` 为空）时为 `undefined`——`controllable` 据此置 false。 */
  opsClient?: OpsClient;
  /** 没有运维容器时，节点列表用它代表「本进程自己」；与 `forward.ts` 的 `NodeIdentity.url` 同一个值，没配多副本时是 `'local'`。 */
  selfUrl: string;
  /** 与 `ChatRouteDeps.authMiddleware` 同样的理由：测试塞一个固定 userId 的桩。 */
  authMiddleware: MiddlewareHandler<ConsoleEnv>;
  now?: () => number;
  logger?: Logger;
}

function describeOpsClientError(error: OpsClientError): string {
  switch (error.kind) {
    case 'unreachable':
      return `连不上运维容器：${error.message}`;
    case 'invalid_response':
      return `运维容器返回的内容解析失败：${error.message}`;
    case 'http':
      return `运维容器返回了 ${String(error.status)}：${error.message}`;
  }
}

function toConsoleNode(node: OpsNode): ConsoleNode {
  return {
    id: node.id,
    index: node.index,
    url: node.url,
    state: node.state,
    dockerState: node.dockerState,
    offlineDeadline: node.offlineDeadline,
  };
}

/**
 * 没配运维容器、或运维容器够不着时的兜底节点列表：从租约里出现过的 `holder` 去重推出，
 * 外加本进程自己（技术方案 §8）。**没有 Docker 信息**，一律显示成「在线」——这几个
 * holder 手上都握着一条租约，是目前唯一能确认的事实；具体是不是真在下线中无从判断。
 */
function deriveFallbackNodes(
  conversations: readonly ConsoleConversation[],
  selfUrl: string,
): ConsoleNode[] {
  const urls = new Set<string>([selfUrl]);
  for (const conversation of conversations) {
    urls.add(conversation.holder);
  }
  return [...urls].map((url) => ({
    id: url,
    index: null,
    url,
    state: 'online' as const,
    dockerState: null,
    offlineDeadline: null,
  }));
}

export function createConsoleApp(
  deps: ConsoleRouteDeps,
): OpenAPIHono<ConsoleEnv> {
  const app = new OpenAPIHono<ConsoleEnv>();
  const log = deps.logger ?? defaultLogger;
  const now = deps.now ?? Date.now;

  app.use('/api/console/*', deps.authMiddleware);

  // ---- GET /api/console/overview ----

  const overviewRoute = createRoute({
    method: 'get',
    path: '/api/console/overview',
    tags: ['Console'],
    summary: '集群控制台：节点列表 + 每个节点下正在跑的会话（技术方案 §8）',
    responses: {
      200: {
        content: { 'application/json': { schema: ConsoleOverviewSchema } },
        description: 'Overview',
      },
      401: {
        content: { 'application/json': { schema: ErrorSchema } },
        description: 'Unauthorized',
      },
    },
  });

  app.openapi(overviewRoute, async (c) => {
    const nowMs = now();
    // 查库与问运维容器互不依赖，一起发：控制台每 2 秒拉一次，串着跑就是两段延迟相加。
    const [leases, result] = await Promise.all([
      listActiveLeases(deps.db),
      deps.opsClient?.listNodes(),
    ]);
    const conversations: ConsoleConversation[] = leases.map((lease) => ({
      id: lease.conversationId,
      title: lease.title,
      ownerEmail: lease.ownerEmail,
      holder: lease.holder,
      heartbeatAt: lease.heartbeatAt,
      stale: nowMs - lease.heartbeatAt > deps.takeoverMs,
    }));

    if (result === undefined) {
      return c.json(
        {
          controllable: false as const,
          nodes: deriveFallbackNodes(conversations, deps.selfUrl),
          conversations,
          now: nowMs,
        },
        200,
      );
    }

    if (!result.ok) {
      log.warn(LOG_SCOPE, 'ops unreachable, degrading to fallback node list', {
        error: describeOpsClientError(result.error),
      });
      return c.json(
        {
          controllable: false as const,
          nodes: deriveFallbackNodes(conversations, deps.selfUrl),
          conversations,
          now: nowMs,
          opsError: describeOpsClientError(result.error),
        },
        200,
      );
    }

    return c.json(
      {
        controllable: true as const,
        nodes: result.data.map(toConsoleNode),
        conversations,
        now: nowMs,
      },
      200,
    );
  });

  // ---- POST /api/console/nodes/{id}/offline ----

  const offlineRoute = createRoute({
    method: 'post',
    path: '/api/console/nodes/{id}/offline',
    tags: ['Console'],
    summary:
      '让一个节点下线：转给运维容器，它后台跑 `docker stop -t 120`（技术方案 §8）',
    request: { params: ConsoleNodeParamsSchema },
    responses: {
      202: {
        content: { 'application/json': { schema: ConsoleOfflineAckSchema } },
        description: 'Offline requested',
      },
      401: {
        content: { 'application/json': { schema: ErrorSchema } },
        description: 'Unauthorized',
      },
      404: {
        content: { 'application/json': { schema: ErrorSchema } },
        description: 'Unknown node id（运维容器的节点列表里没有它）',
      },
      409: {
        content: { 'application/json': { schema: ErrorSchema } },
        description: '这台服务端没有配置运维容器（单进程跑法），节点没法被控制',
      },
      502: {
        content: { 'application/json': { schema: ErrorSchema } },
        description: '运维容器打不通，或返回了预期之外的内容',
      },
    },
  });

  app.openapi(offlineRoute, async (c) => {
    const { id } = c.req.valid('param');
    if (deps.opsClient === undefined) {
      return c.json(
        { error: '这台服务端没有配置运维容器，单进程跑法下节点无法下线' },
        409,
      );
    }
    const result = await deps.opsClient.offline(id);
    if (result.ok) {
      return c.json(
        { ok: true as const, offlineDeadline: result.data.offlineDeadline },
        202,
      );
    }
    if (result.error.kind === 'http' && result.error.status === 404) {
      return c.json({ error: result.error.message }, 404);
    }
    log.error(LOG_SCOPE, 'offline request to ops failed', {
      id,
      error: describeOpsClientError(result.error),
    });
    return c.json({ error: describeOpsClientError(result.error) }, 502);
  });

  // ---- POST /api/console/nodes/{id}/online ----

  const onlineRoute = createRoute({
    method: 'post',
    path: '/api/console/nodes/{id}/online',
    tags: ['Console'],
    summary:
      '让一个已下线的节点重新上线：转给运维容器，它跑 `docker start`（功能手册 §3.4）',
    request: { params: ConsoleNodeParamsSchema },
    responses: {
      202: {
        content: { 'application/json': { schema: ConsoleOnlineAckSchema } },
        description: 'Online requested',
      },
      401: {
        content: { 'application/json': { schema: ErrorSchema } },
        description: 'Unauthorized',
      },
      404: {
        content: { 'application/json': { schema: ErrorSchema } },
        description: 'Unknown node id（运维容器的节点列表里没有它）',
      },
      409: {
        content: { 'application/json': { schema: ErrorSchema } },
        description: '这台服务端没有配置运维容器（单进程跑法），节点没法被控制',
      },
      502: {
        content: { 'application/json': { schema: ErrorSchema } },
        description: '运维容器打不通，或返回了预期之外的内容',
      },
    },
  });

  app.openapi(onlineRoute, async (c) => {
    const { id } = c.req.valid('param');
    if (deps.opsClient === undefined) {
      return c.json(
        { error: '这台服务端没有配置运维容器，单进程跑法下节点无法上线' },
        409,
      );
    }
    const result = await deps.opsClient.online(id);
    if (result.ok) {
      return c.json({ ok: true as const }, 202);
    }
    if (result.error.kind === 'http' && result.error.status === 404) {
      return c.json({ error: result.error.message }, 404);
    }
    log.error(LOG_SCOPE, 'online request to ops failed', {
      id,
      error: describeOpsClientError(result.error),
    });
    return c.json({ error: describeOpsClientError(result.error) }, 502);
  });

  return app;
}

const defaultOpsIdentity = resolveOpsIdentity();
const defaultOpsClient =
  defaultOpsIdentity === undefined ? undefined : (
    createOpsClient(defaultOpsIdentity)
  );

export const consoleApp = createConsoleApp({
  db: defaultDb,
  takeoverMs: resolveTakeoverMs(),
  ...(defaultOpsClient !== undefined ? { opsClient: defaultOpsClient } : {}),
  selfUrl: resolveNodeIdentity()?.url ?? 'local',
  authMiddleware: requireAuth,
});
