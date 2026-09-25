/**
 * [集群控制台](../../../../docs/terms.md) API（`src/routes/console.ts`）。设计见
 * docs/host/node/tech/cluster-console.md §2、§8；施工验收见
 * docs/host/node/plans/cluster-console.md O4。
 *
 * `opsClient` 全程注入假实现——这里不测「怎么打运维容器」（那是
 * `test/console/ops-client.test.ts` 的事），只测路由自己怎么把
 * `OpsClientResult` 翻成响应、以及会话/节点怎么从库里拼出来。
 */
import type { MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../../src/agent/store.js';
import { createConversation } from '../../src/agent/store.js';
import type {
  OpsClient,
  OpsClientResult,
} from '../../src/console/ops-client.js';
import type { OpsNodesResponse } from '../../src/ops/schema.js';
import { createConsoleApp } from '../../src/routes/console.js';
import { silentLogger } from '../helpers/silent-logger.js';
import { createTestDb, seedUser } from '../helpers/test-db.js';

type ConsoleEnv = { Variables: { userId: string } };

const NOW = 1_700_000_000_000;
const TAKEOVER_MS = 15_000;

function authAs(userId: string): MiddlewareHandler<ConsoleEnv> {
  return createMiddleware<ConsoleEnv>(async (c, next) => {
    c.set('userId', userId);
    await next();
  });
}

const unauthorized: MiddlewareHandler<ConsoleEnv> =
  createMiddleware<ConsoleEnv>(async (c) =>
    c.json({ error: 'Unauthorized' }, 401),
  );

/** 记下每次调用的入参，返回值由测试逐个指定——`ok`/`error` 两态都能造。 */
function fakeOpsClient(overrides: Partial<OpsClient> = {}): OpsClient & {
  offlineCalls: string[];
  onlineCalls: string[];
} {
  const offlineCalls: string[] = [];
  const onlineCalls: string[] = [];
  return {
    offlineCalls,
    onlineCalls,
    listNodes:
      overrides.listNodes ??
      (() =>
        Promise.resolve({
          ok: true,
          data: [],
        } as OpsClientResult<OpsNodesResponse>)),
    offline:
      overrides.offline ??
      ((id: string) => {
        offlineCalls.push(id);
        return Promise.resolve({
          ok: true,
          data: { ok: true, offlineDeadline: NOW + 120_000 },
        });
      }),
    online:
      overrides.online ??
      ((id: string) => {
        onlineCalls.push(id);
        return Promise.resolve({ ok: true, data: { ok: true } });
      }),
  };
}

interface BuildOpts {
  opsClient?: OpsClient;
  selfUrl?: string;
  authMiddleware?: MiddlewareHandler<ConsoleEnv>;
}

function buildApp(db: Db, opts: BuildOpts = {}) {
  return createConsoleApp({
    db,
    takeoverMs: TAKEOVER_MS,
    selfUrl: opts.selfUrl ?? 'http://self-node:3900',
    authMiddleware: opts.authMiddleware ?? authAs('user-1'),
    now: () => NOW,
    logger: silentLogger,
    ...(opts.opsClient !== undefined ? { opsClient: opts.opsClient } : {}),
  });
}

async function insertLease(
  db: Db,
  input: {
    conversationId: string;
    holder: string | null;
    leaseToken: string | null;
    heartbeatAt?: number;
  },
): Promise<void> {
  await db
    .insertInto('agent_leases')
    .values({
      conversation_id: input.conversationId,
      holder: input.holder,
      lease_token: input.leaseToken,
      seq_watermark: 0,
      heartbeat_at: input.heartbeatAt ?? NOW,
      acquired_at: NOW,
    })
    .execute();
}

async function seedConversation(
  db: Db,
  opts: { id: string; userId: string; title: string },
): Promise<void> {
  await createConversation(db, {
    id: opts.id,
    userId: opts.userId,
    title: opts.title,
    repo: 'acme/demo',
    branchName: `runko/chat-${opts.id}`,
    sandboxName: `runko-chat-${opts.id}`,
  });
}

interface OverviewBody {
  controllable: boolean;
  nodes: {
    id: string;
    index: number | null;
    url: string | null;
    state: string;
    dockerState: string | null;
    offlineDeadline: number | null;
  }[];
  conversations: {
    id: string;
    title: string;
    ownerEmail: string;
    holder: string;
    heartbeatAt: number;
    stale: boolean;
  }[];
  now: number;
  opsError?: string;
}

describe('GET /api/console/overview', () => {
  let db: Db;

  beforeEach(async () => {
    db = await createTestDb();
    await seedUser(db, 'user-1');
    await seedUser(db, 'user-2');
  });

  it('未配运维容器：controllable=false，节点 = holder 去重 + 自身', async () => {
    await seedConversation(db, {
      id: 'conv-a',
      userId: 'user-1',
      title: '会话 A',
    });
    await seedConversation(db, {
      id: 'conv-b',
      userId: 'user-2',
      title: '会话 B',
    });
    await insertLease(db, {
      conversationId: 'conv-a',
      holder: 'http://node-a:3900',
      leaseToken: 'token-a',
    });
    await insertLease(db, {
      conversationId: 'conv-b',
      holder: 'http://node-b:3900',
      leaseToken: 'token-b',
    });

    const app = buildApp(db, { selfUrl: 'http://self-node:3900' });
    const res = await app.request('http://localhost/api/console/overview');
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewBody;

    expect(body.controllable).toBe(false);
    expect(body.opsError).toBeUndefined();
    const nodeUrls = new Set(body.nodes.map((n) => n.url));
    expect(nodeUrls).toEqual(
      new Set([
        'http://self-node:3900',
        'http://node-a:3900',
        'http://node-b:3900',
      ]),
    );
    for (const node of body.nodes) {
      expect(node.state).toBe('online');
      expect(node.index).toBeNull();
      expect(node.dockerState).toBeNull();
      expect(node.offlineDeadline).toBeNull();
      expect(node.id).toBe(node.url);
    }

    const holders = body.conversations.map((c) => c.holder).sort();
    expect(holders).toEqual(['http://node-a:3900', 'http://node-b:3900']);
  });

  it('运维容器正常：controllable=true，节点数据来自 ops，url 与租约 holder 对得上', async () => {
    await seedConversation(db, {
      id: 'conv-a',
      userId: 'user-1',
      title: '会话 A',
    });
    await insertLease(db, {
      conversationId: 'conv-a',
      holder: 'http://abc123456789:3900',
      leaseToken: 'token-a',
    });

    const opsNodes: OpsNodesResponse = [
      {
        id: 'abc123456789'.padEnd(64, '0'),
        shortId: 'abc123456789',
        index: 1,
        url: 'http://abc123456789:3900',
        state: 'online',
        dockerState: 'running',
        offlineDeadline: null,
      },
      {
        id: 'def987654321'.padEnd(64, '0'),
        shortId: 'def987654321',
        index: 2,
        url: 'http://def987654321:3900',
        state: 'going_offline',
        dockerState: 'running',
        offlineDeadline: NOW + 60_000,
      },
    ];
    const ops = fakeOpsClient({
      listNodes: () => Promise.resolve({ ok: true, data: opsNodes }),
    });

    const app = buildApp(db, { opsClient: ops });
    const res = await app.request('http://localhost/api/console/overview');
    const body = (await res.json()) as OverviewBody;

    expect(body.controllable).toBe(true);
    expect(body.opsError).toBeUndefined();
    expect(body.nodes).toHaveLength(2);
    expect(body.nodes[0]).toMatchObject({
      id: opsNodes[0]?.id,
      index: 1,
      url: 'http://abc123456789:3900',
      state: 'online',
    });
    expect(body.nodes[1]).toMatchObject({
      state: 'going_offline',
      offlineDeadline: NOW + 60_000,
    });

    // 会话按 holder 记录的地址，正好命中 ops 返回的某个节点的 url——前端据此分组。
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0]?.holder).toBe(body.nodes[0]?.url);
  });

  it('运维容器打不通：退化成 controllable=false + opsError，会话部分照常返回', async () => {
    await seedConversation(db, {
      id: 'conv-a',
      userId: 'user-1',
      title: '会话 A',
    });
    await insertLease(db, {
      conversationId: 'conv-a',
      holder: 'http://node-a:3900',
      leaseToken: 'token-a',
    });

    const ops = fakeOpsClient({
      listNodes: () =>
        Promise.resolve({
          ok: false,
          error: { kind: 'unreachable', message: 'ECONNREFUSED' },
        }),
    });

    const app = buildApp(db, { opsClient: ops, selfUrl: 'http://self:3900' });
    const res = await app.request('http://localhost/api/console/overview');
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewBody;

    expect(body.controllable).toBe(false);
    expect(body.opsError).toContain('ECONNREFUSED');
    // 会话部分没受影响：还是从库里拼出来的。
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0]?.holder).toBe('http://node-a:3900');
  });

  it('stale 边界：心跳差恰好等于阈值不算 stale，多 1 毫秒就算', async () => {
    await seedConversation(db, {
      id: 'conv-eq',
      userId: 'user-1',
      title: '恰好等于阈值',
    });
    await seedConversation(db, {
      id: 'conv-over',
      userId: 'user-1',
      title: '超过阈值',
    });
    await insertLease(db, {
      conversationId: 'conv-eq',
      holder: 'http://node-a:3900',
      leaseToken: 'token-eq',
      heartbeatAt: NOW - TAKEOVER_MS,
    });
    await insertLease(db, {
      conversationId: 'conv-over',
      holder: 'http://node-a:3900',
      leaseToken: 'token-over',
      heartbeatAt: NOW - TAKEOVER_MS - 1,
    });

    const app = buildApp(db);
    const res = await app.request('http://localhost/api/console/overview');
    const body = (await res.json()) as OverviewBody;

    const byId = new Map(body.conversations.map((c) => [c.id, c]));
    expect(byId.get('conv-eq')?.stale).toBe(false);
    expect(byId.get('conv-over')?.stale).toBe(true);
  });

  it('lease_token 为空的行不出现在会话列表里', async () => {
    await seedConversation(db, {
      id: 'conv-released',
      userId: 'user-1',
      title: '已释放的租约',
    });
    await insertLease(db, {
      conversationId: 'conv-released',
      holder: null,
      leaseToken: null,
    });

    const app = buildApp(db);
    const res = await app.request('http://localhost/api/console/overview');
    const body = (await res.json()) as OverviewBody;

    expect(body.conversations).toHaveLength(0);
  });

  it('未登录 → 401', async () => {
    const app = buildApp(db, { authMiddleware: unauthorized });
    const res = await app.request('http://localhost/api/console/overview');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/console/nodes/{id}/offline', () => {
  let db: Db;

  beforeEach(async () => {
    db = await createTestDb();
  });

  it('没配运维容器 → 409', async () => {
    const app = buildApp(db);
    const res = await app.request(
      'http://localhost/api/console/nodes/node-a/offline',
      { method: 'POST' },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('运维容器');
  });

  it('ops 返回 404（未知节点）原样透传', async () => {
    const ops = fakeOpsClient({
      offline: () =>
        Promise.resolve({
          ok: false,
          error: { kind: 'http', status: 404, message: 'unknown node id' },
        }),
    });
    const app = buildApp(db, { opsClient: ops });
    const res = await app.request(
      'http://localhost/api/console/nodes/no-such-node/offline',
      { method: 'POST' },
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'unknown node id' });
  });

  it('ops 打不通 → 502', async () => {
    const ops = fakeOpsClient({
      offline: () =>
        Promise.resolve({
          ok: false,
          error: { kind: 'unreachable', message: 'ECONNREFUSED' },
        }),
    });
    const app = buildApp(db, { opsClient: ops });
    const res = await app.request(
      'http://localhost/api/console/nodes/node-a/offline',
      { method: 'POST' },
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('ECONNREFUSED');
  });

  it('ops 正常 → 202，带 offlineDeadline，且转发了正确的 id', async () => {
    const ops = fakeOpsClient();
    const app = buildApp(db, { opsClient: ops });
    const res = await app.request(
      'http://localhost/api/console/nodes/node-a/offline',
      { method: 'POST' },
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      ok: true,
      offlineDeadline: NOW + 120_000,
    });
    expect(ops.offlineCalls).toEqual(['node-a']);
  });

  it('未登录 → 401', async () => {
    const app = buildApp(db, { authMiddleware: unauthorized });
    const res = await app.request(
      'http://localhost/api/console/nodes/node-a/offline',
      { method: 'POST' },
    );
    expect(res.status).toBe(401);
  });
});

describe('POST /api/console/nodes/{id}/online', () => {
  let db: Db;

  beforeEach(async () => {
    db = await createTestDb();
  });

  it('没配运维容器 → 409', async () => {
    const app = buildApp(db);
    const res = await app.request(
      'http://localhost/api/console/nodes/node-a/online',
      { method: 'POST' },
    );
    expect(res.status).toBe(409);
  });

  it('ops 返回 404 原样透传', async () => {
    const ops = fakeOpsClient({
      online: () =>
        Promise.resolve({
          ok: false,
          error: { kind: 'http', status: 404, message: 'unknown node id' },
        }),
    });
    const app = buildApp(db, { opsClient: ops });
    const res = await app.request(
      'http://localhost/api/console/nodes/no-such-node/online',
      { method: 'POST' },
    );
    expect(res.status).toBe(404);
  });

  it('ops 打不通 → 502', async () => {
    const ops = fakeOpsClient({
      online: () =>
        Promise.resolve({
          ok: false,
          error: { kind: 'unreachable', message: 'ECONNREFUSED' },
        }),
    });
    const app = buildApp(db, { opsClient: ops });
    const res = await app.request(
      'http://localhost/api/console/nodes/node-a/online',
      { method: 'POST' },
    );
    expect(res.status).toBe(502);
  });

  it('ops 正常 → 202，转发了正确的 id', async () => {
    const ops = fakeOpsClient();
    const app = buildApp(db, { opsClient: ops });
    const res = await app.request(
      'http://localhost/api/console/nodes/node-a/online',
      { method: 'POST' },
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(ops.onlineCalls).toEqual(['node-a']);
  });

  it('未登录 → 401', async () => {
    const app = buildApp(db, { authMiddleware: unauthorized });
    const res = await app.request(
      'http://localhost/api/console/nodes/node-a/online',
      { method: 'POST' },
    );
    expect(res.status).toBe(401);
  });
});
