/**
 * **[多副本验证环境](../../../../docs/terms.md)的端到端**：三个真容器、一个真 Postgres、真网络故障。
 *
 * `multi-replica.e2e.test.ts` 用「几个进程共用一个库」证明了多副本的核心路径；这里把同一件事
 * 搬到跨容器 + 真 Postgres 上，并补上那边做不到的两种故障：**网络分区**（进程活着、连不上库）
 * 与**数据库卡顿**。场景清单与断言依据见 docs/host/node/tech/multi-replica.md §11.4。
 *
 * **门禁**：没设 `RUNKO_TEST_LAB=1` 整个文件跳过——要 Docker、要构建镜像，不进 `pnpm test` 与 CI。
 *
 *   pnpm --filter @runko-chat/node-server test:lab
 *
 * **自带起停、跑完即退**：独立项目名 + 独立端口，不碰手动起着的那套；`afterAll` 一律 `down -v`。
 *
 * **断言落在账本与租约表上**，不落在日志上——「没写坏」只有账本能证明。
 *
 * **日志留在本地**：`apps/node-server/logs/lab-<时间>/`（`lab-latest` 指向最近一次）。
 */
import { execFile } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { collectLabLogs, createLogDir } from '../../scripts/lab-logs.js';
import { formatLogLine } from '../../src/logger.js';

const RUN = process.env.RUNKO_TEST_LAB === '1';
const PROJECT = 'runko-chat-lab-e2e';
const COMPOSE_FILE = fileURLToPath(
  new URL('../../docker/compose.yml', import.meta.url),
);

/** 与 compose.yml 的缺省值一致，写在这里是为了断言里要用。 */
const HEARTBEAT_MS = 1_000;
const TAKEOVER_MS = 5_000;
const FORWARD_TIMEOUT_MS = 2_000;
/** 演示模型复述时每小段的间隔；一轮多久由消息长度决定（见 `longText`）。 */
const CHUNK_DELAY_MS = 400;
/** 让一轮大致跑这么久——故障要在「一轮还没跑完」的时候注入才算数。 */
const TURN_MS = 10_000;

const PORTS = { lb: 3950, a: 3951, b: 3952, c: 3953, pg: 55453 } as const;

const LAB_ENV = {
  LAB_LB_PORT: String(PORTS.lb),
  LAB_A_PORT: String(PORTS.a),
  LAB_B_PORT: String(PORTS.b),
  LAB_C_PORT: String(PORTS.c),
  LAB_PG_PORT: String(PORTS.pg),
  LAB_HEARTBEAT_MS: String(HEARTBEAT_MS),
  LAB_TAKEOVER_MS: String(TAKEOVER_MS),
  LAB_FORWARD_TIMEOUT_MS: String(FORWARD_TIMEOUT_MS),
  LAB_CHUNK_DELAY_MS: String(CHUNK_DELAY_MS),
};

type ServiceName = 'replica-a' | 'replica-b' | 'replica-c';

interface Replica {
  service: ServiceName;
  /** 从宿主机打它用的地址。 */
  url: string;
  /** 它写进租约表的 holder——容器网络里的地址。 */
  holder: string;
}

const A: Replica = {
  service: 'replica-a',
  url: `http://127.0.0.1:${String(PORTS.a)}`,
  holder: 'http://replica-a:3900',
};
const B: Replica = {
  service: 'replica-b',
  url: `http://127.0.0.1:${String(PORTS.b)}`,
  holder: 'http://replica-b:3900',
};
const C: Replica = {
  service: 'replica-c',
  url: `http://127.0.0.1:${String(PORTS.c)}`,
  holder: 'http://replica-c:3900',
};
const LB_URL = `http://127.0.0.1:${String(PORTS.lb)}`;

/** 与 `@runko/agent` 的 `ABORT_REASON_HOLDER_LOST` / `ABORT_REASON_SHUTDOWN` 同一份文案。 */
const HOLDER_LOST = 'another node took over';
const SHUTDOWN = 'shutting down';

// ─── docker ────────────────────────────────────────────────────────────────

const run = promisify(execFile);

async function docker(args: readonly string[]): Promise<string> {
  const { stdout } = await run('docker', [...args], {
    env: { ...process.env, ...LAB_ENV },
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

const compose = (...args: string[]): Promise<string> =>
  docker(['compose', '-p', PROJECT, '-f', COMPOSE_FILE, ...args]);
const containerOf = (service: ServiceName): string => `${PROJECT}-${service}-1`;
const DB_NETWORK = `${PROJECT}_db`;

// ─── 日志 ──────────────────────────────────────────────────────────────────

/** 本次运行的日志目录；`beforeAll` 里建。 */
let logDir: string | undefined;

/** 记一个测试步骤。与副本日志同一个行格式，所以能合并进同一条时间线。 */
function step(
  scenario: string,
  message: string,
  fields?: Record<string, string | number | boolean | undefined>,
): void {
  if (logDir === undefined) {
    return;
  }
  appendFileSync(
    join(logDir, 'test.log'),
    `${formatLogLine({
      at: new Date(),
      node: 'test',
      level: 'STEP',
      scope: scenario,
      message,
      fields,
    })}\n`,
  );
}

async function saveLogs(): Promise<void> {
  if (logDir === undefined) {
    return;
  }
  await collectLabLogs({
    dir: logDir,
    project: PROJECT,
    composeFile: COMPOSE_FILE,
    env: { ...process.env, ...LAB_ENV },
  }).catch((error: unknown) => {
    step('lab', 'collecting container logs failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

// ─── JSON 边界 ─────────────────────────────────────────────────────────────

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

/** `JSON.parse` 的类型是 `any`，在这里一次性落成 JSON 值类型，后面全靠守卫收窄。 */
function parseJson(text_: string): Json {
  const parsed: Json = JSON.parse(text_);
  return parsed;
}

const isObject = (value: Json | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function field(value: Json | undefined, key: string): Json | undefined {
  return isObject(value) ? value[key] : undefined;
}

function text(value: Json | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

// ─── HTTP（带登录）─────────────────────────────────────────────────────────

interface Reply {
  status: number;
  body: Json;
  ms: number;
  retryAfter: string | null;
}

/**
 * 登录 cookie。**在 A 上注册一次，三个副本通用**——登录态在库里，密钥三个副本相同。
 * 这本身就是多副本的一条前提：换个副本不用重新登录。
 */
let cookie = '';

async function request(url: string, init: RequestInit = {}): Promise<Reply> {
  const started = Date.now();
  const headers = new Headers(init.headers);
  if (cookie !== '') {
    headers.set('cookie', cookie);
  }
  const res = await fetch(url, {
    ...init,
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  const raw = await res.text();
  return {
    status: res.status,
    body: raw === '' ? null : parseJson(raw),
    ms: Date.now() - started,
    retryAfter: res.headers.get('retry-after'),
  };
}

const postJson = (url: string, payload: JsonObject): Promise<Reply> =>
  request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

async function signUp(replica: Replica): Promise<void> {
  const res = await fetch(`${replica.url}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: `lab-${String(Date.now())}@example.com`,
      password: 'lab-password-1234',
      name: 'lab',
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const setCookie = res.headers.getSetCookie().join('; ');
  if (!res.ok || setCookie === '') {
    throw new Error(`注册失败：${String(res.status)} ${await res.text()}`);
  }
  cookie = setCookie;
}

async function createConversation(replica: Replica): Promise<string> {
  const reply = await postJson(`${replica.url}/api/chat/conversations`, {
    title: 'lab',
  });
  const id = text(field(reply.body, 'id'));
  if (id === undefined) {
    throw new Error(`建会话失败：${JSON.stringify(reply.body)}`);
  }
  return id;
}

/**
 * 一条让演示模型大致跑 `TURN_MS` 的消息。
 *
 * 演示模型把话切成 12 个字一段、每段之间停 `CHUNK_DELAY_MS`——所以一轮多久由**消息长度**
 * 决定。故障必须在一轮还没跑完时注入，否则验的是「跑完之后发生了什么」，那是另一回事。
 */
function longText(label: string): string {
  const chunks = Math.ceil(TURN_MS / CHUNK_DELAY_MS);
  return `${label}${'字'.repeat(chunks * 12)}`;
}

const send = (replica: Replica, id: string, message: string): Promise<Reply> =>
  postJson(`${replica.url}/api/chat/conversations/${id}/messages`, {
    text: message,
  });

async function activity(replica: Replica, id: string): Promise<JsonObject> {
  const reply = await request(
    `${replica.url}/api/chat/conversations/${id}/activity`,
  );
  if (!isObject(reply.body)) {
    throw new Error(`activity 不是对象：${JSON.stringify(reply.body)}`);
  }
  return reply.body;
}

interface LedgerRow {
  seq: number;
  role: string;
  text: string | undefined;
  status: string | undefined;
  reason: string | undefined;
}

/** 从一个活着的副本读账本（任何副本都能答——状态在库里）。 */
async function ledger(replica: Replica, id: string): Promise<LedgerRow[]> {
  const reply = await request(
    `${replica.url}/api/chat/conversations/${id}/messages`,
  );
  const frames = field(reply.body, 'frames');
  if (!Array.isArray(frames)) {
    throw new Error(`账本读不出来：${JSON.stringify(reply.body)}`);
  }
  return frames.map((frame) => {
    const message = field(frame, 'message');
    const seq = field(frame, 'seq');
    const parts = field(message, 'parts');
    const metadata = field(message, 'metadata');
    return {
      seq: typeof seq === 'number' ? seq : Number.NaN,
      role: text(field(message, 'role')) ?? '',
      text: Array.isArray(parts) ? text(field(parts[0], 'text')) : undefined,
      status: text(field(metadata, 'status')),
      reason: text(field(field(metadata, 'error'), 'message')),
    };
  });
}

/** 账本没写坏的最低要求：seq 唯一且递增。 */
function expectCleanSeqs(rows: readonly LedgerRow[]): void {
  const seqs = rows.map((row) => row.seq);
  expect(new Set(seqs).size).toBe(seqs.length);
  expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
}

/** 这一轮的用户消息与收尾状态——断言里只关心这两样，正文太长不便直接比。 */
function shape(rows: readonly LedgerRow[]): [string, string][] {
  return rows.map((row) => [
    row.role,
    row.role === 'user' ? (row.text ?? '').slice(0, 4) : (row.status ?? ''),
  ]);
}

// ─── 时间 ──────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check().catch(() => false)) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`等超时了：${what}`);
    }
    await sleep(200);
  }
}

/**
 * 把被 `kill -9` 的副本拉起来。**用 `start` 不用 `up`**：`up` 会重建容器，旧容器的日志随之消失，
 * 时间线里这个副本被杀之前的那一段就全没了。`start` 拉起的是同一个容器，前后两段日志都在。
 */
async function restart(replica: Replica): Promise<void> {
  await compose('start', replica.service);
  await waitFor(
    async () => (await fetch(`${replica.url}/health`)).ok,
    60_000,
    `${replica.service} 重新健康`,
  );
}

const waitActive = (replica: Replica, id: string): Promise<void> =>
  waitFor(
    async () => (await activity(replica, id))['active'] === true,
    15_000,
    `${replica.service} 上 ${id} 起轮`,
  );

const waitIdle = (
  replica: Replica,
  id: string,
  timeoutMs = 45_000,
): Promise<void> =>
  waitFor(
    async () => (await activity(replica, id))['active'] === false,
    timeoutMs,
    `${replica.service} 上 ${id} 收尾`,
  );

interface TurnStateEvent {
  frame: Json;
  /** 收到这一帧的时刻（`Date.now()`）。 */
  at: number;
}

/**
 * 订阅一条 SSE，逐帧吐出 `turn-state`。**时刻是这里要证的东西**：缓冲过的代理要等一轮跑完才吐
 * 第一个字节；一轮是不是「自己停的」要看停下来的那一帧比模型该跑完的时刻早多少。
 */
async function* turnStates(
  url: string,
  signal: AbortSignal,
): AsyncGenerator<TurnStateEvent> {
  const res = await fetch(url, { headers: { cookie }, signal });
  const body = res.body;
  if (body === null) {
    throw new Error('SSE 没有响应体');
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return;
    }
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';
    for (const event of events) {
      const match = /^event: turn-state\ndata: (.+)$/m.exec(event);
      const data = match?.[1];
      if (data !== undefined) {
        yield { frame: parseJson(data), at: Date.now() };
      }
    }
  }
}

/** 第一帧 `turn-state` 与它花了多久。 */
async function firstTurnState(
  url: string,
): Promise<{ frame: Json; ms: number }> {
  const controller = new AbortController();
  const started = Date.now();
  try {
    for await (const event of turnStates(url, controller.signal)) {
      return { frame: event.frame, ms: event.at - started };
    }
    throw new Error('流结束了还没等到 turn-state');
  } finally {
    controller.abort();
  }
}

// ─── 数据库 ────────────────────────────────────────────────────────────────

/** `beforeAll` 失败时它从没被赋值，而 vitest 照样会跑 `afterAll`——所以是可空的。 */
let pool: Pool | undefined;

async function leaseHolder(id: string): Promise<string | null | undefined> {
  if (pool === undefined) {
    throw new Error('数据库连接还没建好');
  }
  const result = await pool.query<{ holder: string | null }>(
    'SELECT holder FROM agent_leases WHERE conversation_id = $1',
    [id],
  );
  return result.rows[0]?.holder;
}

// ─── 用例 ──────────────────────────────────────────────────────────────────

describe.skipIf(!RUN)('多副本验证环境：三个容器 + 真 Postgres + 真故障', () => {
  beforeAll(async () => {
    logDir = createLogDir();
    console.log(`\n多副本验证环境的日志：${join(logDir, 'timeline.log')}\n`);
    await compose('down', '-v', '--remove-orphans');
    step('lab', 'building image and starting postgres + 3 replicas + nginx');
    await compose('up', '-d', '--build', '--wait');
    step('lab', 'environment healthy');
    pool = new Pool({
      host: '127.0.0.1',
      port: PORTS.pg,
      user: 'runko',
      password: 'runko',
      database: 'runko',
    });
    await signUp(A);
    step(
      'lab',
      'signed up once on replica-a; the cookie works on every replica',
    );
  }, 15 * 60_000);

  afterEach(async () => {
    await saveLogs();
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await compose('down', '-v', '--remove-orphans').catch(() => undefined);
  }, 5 * 60_000);

  it('S0 登录态跨副本：在 A 注册的 cookie，B 与 C 直接认', async () => {
    const id = await createConversation(A);
    for (const replica of [B, C]) {
      const reply = await request(
        `${replica.url}/api/chat/conversations/${id}`,
      );
      expect(reply.status).toBe(200);
      expect(text(field(reply.body, 'id'))).toBe(id);
    }
  }, 60_000);

  it('S1 并发抢占：同时打到两个副本，只有一个起轮，另一个经转发排队', async () => {
    const id = await createConversation(A);
    step('S1', '同时往 A、B 发同一份对话', { conversationId: id });
    const [fromA, fromB] = await Promise.all([
      send(A, id, longText('甲')),
      send(B, id, longText('乙')),
    ]);

    expect([fromA.status, fromB.status]).toEqual([202, 202]);
    expect(
      [text(field(fromA.body, 'mode')), text(field(fromB.body, 'mode'))].sort(),
    ).toEqual(['queued', 'started']);
    expect([A.holder, B.holder]).toContain(await leaseHolder(id));

    // 两轮都跑完：排队的那条由持有者收尾时自动出队。
    await waitFor(
      async () =>
        (await ledger(C, id)).filter((row) => row.role === 'user').length === 2,
      60_000,
      '第二条出队起轮',
    );
    await waitIdle(C, id);
    const rows = await ledger(C, id);
    step('S1', '两轮都跑完', { conversationId: id, ledgerRows: rows.length });
    expect(
      rows
        .filter((row) => row.role === 'user')
        .map((row) => (row.text ?? '').slice(0, 1))
        .sort(),
    ).toEqual(['乙', '甲']);
    expectCleanSeqs(rows);
  }, 120_000);

  it('S2 SSE：经非持有者、经 nginx 订阅，第一帧在一轮跑完之前就到', async () => {
    const id = await createConversation(B);
    expect(
      text(field((await send(B, id, longText('看流'))).body, 'mode')),
    ).toBe('started');
    await waitActive(B, id);
    step('S2', 'B 起轮了', { conversationId: id });

    for (const via of [A.url, LB_URL]) {
      const { frame, ms } = await firstTurnState(
        `${via}/api/chat/conversations/${id}/stream`,
      );
      step(
        'S2',
        `经 ${via === A.url ? 'A（非持有者）' : 'nginx'} 订阅，拿到第一帧`,
        {
          conversationId: id,
          ms,
        },
      );
      expect(field(frame, 'turnActive')).toBe(true);
      // 没被缓冲：一轮要跑约 10 秒，缓冲过的代理不会在一半时间内吐出第一帧。
      expect(ms).toBeLessThan(TURN_MS / 2);
    }
    await waitIdle(B, id);
  }, 90_000);

  it('S3 停止打到非持有者：转给持有者，这一轮以 interrupted 收尾', async () => {
    const id = await createConversation(A);
    await send(A, id, longText('停下'));
    await waitActive(A, id);

    step('S3', 'A 起轮了，往 B 发停止', { conversationId: id });
    const stopped = await postJson(
      `${B.url}/api/chat/conversations/${id}/abort`,
      {},
    );
    expect(stopped.status).toBe(200);

    await waitIdle(A, id);
    const rows = await ledger(B, id);
    expect(rows.at(-1)).toMatchObject({
      role: 'assistant',
      status: 'interrupted',
    });
    expectCleanSeqs(rows);
  }, 90_000);

  it('S4 数据库卡顿 1 秒（远短于自我围栏）：这一轮不受影响，照常跑完', async () => {
    const id = await createConversation(C);
    await send(C, id, longText('库卡一下'));
    await waitActive(C, id);

    step('S4', 'C 起轮了，冻住 postgres 1 秒', { conversationId: id });
    await compose('pause', 'postgres');
    await sleep(1_000);
    await compose('unpause', 'postgres');

    await waitIdle(C, id);
    const rows = await ledger(C, id);
    expect(shape(rows)).toEqual([
      ['user', '库卡一下'],
      ['assistant', 'completed'],
    ]);
  }, 90_000);

  it('S5 持有者 kill -9、别的副本先接手：先 503，过接管阈值后起轮，崩溃那一轮补上「已停止」', async () => {
    const id = await createConversation(A);
    await send(A, id, longText('跑一半'));
    await waitActive(A, id);

    step('S5', 'A 起轮了，kill -9 replica-a', { conversationId: id });
    await compose('kill', '-s', 'SIGKILL', A.service);

    // 租约还没过期：B 抢不到，转给 A 又连不上 → 503，而且很快（不是挂着）。
    const early = await send(B, id, '太早了');
    step('S5', '租约未过期时往 B 发', {
      conversationId: id,
      status: early.status,
      ms: early.ms,
    });
    expect(early.status).toBe(503);
    expect(early.retryAfter).toBe('1');
    expect(early.ms).toBeLessThan(FORWARD_TIMEOUT_MS * 2 - 500);

    await sleep(TAKEOVER_MS + 1_000);
    const late = await send(B, id, longText('我来接手'));
    expect(late.status).toBe(202);
    expect(field(late.body, 'mode')).toBe('started');
    await waitIdle(B, id);

    const rows = await ledger(B, id);
    expect(shape(rows)).toEqual([
      ['user', '跑一半'],
      ['assistant', 'interrupted'],
      ['user', '我来接手'],
      ['assistant', 'completed'],
    ]);
    expect(rows[1]?.reason).toContain(HOLDER_LOST);
    expectCleanSeqs(rows);

    step('S5', '拉起 replica-a', { conversationId: id });
    await restart(A);
  }, 180_000);

  it('S6 持有者 kill -9、先重启它：启动扫描补上「已停止」', async () => {
    const id = await createConversation(B);
    await send(B, id, longText('重启我'));
    await waitActive(B, id);

    step('S6', 'B 起轮了，kill -9 replica-b', { conversationId: id });
    await compose('kill', '-s', 'SIGKILL', B.service);
    step('S6', '立刻拉起 replica-b（没人发消息，也不等接管阈值）', {
      conversationId: id,
    });
    await restart(B);

    // **不等接管阈值**：同名副本重启后，启动扫描认得出「这是我上一辈子留下的」，当场收拾。
    const rows = await ledger(A, id);
    expect(shape(rows)).toEqual([
      ['user', '重启我'],
      ['assistant', 'interrupted'],
    ]);
    expect(rows[1]?.reason).toContain(SHUTDOWN);
    expect(await leaseHolder(id)).toBeNull();
  }, 180_000);

  it('S7 持有者被冻住：转发在超时附近回 503；接管后老持有者解冻，账本一行不多（核心）', async () => {
    const id = await createConversation(C);
    await send(C, id, longText('冻住我'));
    await waitActive(C, id);

    step('S7', 'C 起轮了，冻住 replica-c', { conversationId: id });
    await compose('pause', C.service);
    const frozenAt = Date.now();

    // 冻住的进程端口还在，TCP 握手由内核完成——没有转发超时的话这里会挂几分钟。
    const stream = await request(
      `${A.url}/api/chat/conversations/${id}/stream`,
    );
    step('S7', '冻住期间经 A 订阅', {
      conversationId: id,
      status: stream.status,
      ms: stream.ms,
    });
    expect(stream.status).toBe(503);
    expect(field(stream.body, 'holder')).toBe(C.holder);
    expect(stream.ms).toBeGreaterThanOrEqual(FORWARD_TIMEOUT_MS - 200);
    // 上限必须小于**两倍**超时：回 421 时 Fetch 标准客户端会自动重发一遍，用时正好翻倍。
    expect(stream.ms).toBeLessThan(FORWARD_TIMEOUT_MS * 2 - 500);

    await sleep(Math.max(0, frozenAt + TAKEOVER_MS + 1_000 - Date.now()));
    const takeover = await send(A, id, longText('我接管了'));
    expect(field(takeover.body, 'mode')).toBe('started');

    // **趁 A 这一轮还在跑就唤醒 C**：C 的心跳一醒就发现围栏到期、停手；它的收尾要取号写账本、
    // 还要 `release`——取号必须被拒，`release` 必须既擦不掉 A 的归属、也抢不回来。
    step('S7', 'A 的轮还在跑，解冻 replica-c', { conversationId: id });
    await compose('unpause', C.service);
    await sleep(HEARTBEAT_MS * 3);
    expect((await activity(A, id))['local']).toBe(true);
    expect(await leaseHolder(id)).toBe(A.holder);

    await waitIdle(A, id);
    const rows = await ledger(A, id);
    expect(shape(rows)).toEqual([
      ['user', '冻住我'],
      ['assistant', 'interrupted'],
      ['user', '我接管了'],
      ['assistant', 'completed'],
    ]);
    expect(rows[1]?.reason).toContain(HOLDER_LOST);
    expectCleanSeqs(rows);
    await waitFor(
      async () => (await activity(C, id))['local'] !== true,
      15_000,
      'C 不再认为自己在跑',
    );
    // 再等一会儿：C 迟到的写入（如果有）也该落地了。账本必须还是这四行。
    await sleep(2_000);
    expect(await ledger(A, id)).toEqual(rows);
  }, 180_000);

  it('S8 网络分区：持有者连不上库时，没人接管也会在模型跑完之前自己停手；之后别的副本接管，账本没写坏', async () => {
    const id = await createConversation(A);
    const sentAt = Date.now();
    await send(A, id, longText('断网'));
    await waitActive(A, id);

    // 直接订阅 A 自己（它是持有者，答的是本地）。A 连不上库，但照样收得到请求、推得出帧。
    const controller = new AbortController();
    const states = turnStates(
      `${A.url}/api/chat/conversations/${id}/stream`,
      controller.signal,
    );
    const first = await states.next();
    expect(first.done !== true && field(first.value.frame, 'turnActive')).toBe(
      true,
    );
    const stopped = (async (): Promise<number> => {
      for await (const event of states) {
        if (field(event.frame, 'turnActive') === false) {
          return event.at;
        }
      }
      throw new Error('A 的流断了，没等到这一轮停下');
    })().catch(() => Number.POSITIVE_INFINITY);

    step('S8', 'A 起轮了，断开 replica-a 与库之间的网络', {
      conversationId: id,
    });
    await docker(['network', 'disconnect', DB_NETWORK, containerOf(A.service)]);
    const disconnectedAt = Date.now();

    // **这里还没有任何人来接管**——B 一句话都没发。A 若能停，只能是自己停的（自我围栏）。
    const stoppedAt = await Promise.race([
      stopped,
      sleep(TURN_MS + 5_000).then(() => Number.POSITIVE_INFINITY),
    ]);
    controller.abort();
    step('S8', 'A 的流报这一轮停了（此时还没人来接管）', {
      conversationId: id,
      sinceDisconnectMs: stoppedAt - disconnectedAt,
      sinceSentMs: stoppedAt - sentAt,
    });
    expect(stoppedAt - disconnectedAt).toBeGreaterThanOrEqual(
      TAKEOVER_MS - 2 * HEARTBEAT_MS,
    );
    expect(stoppedAt - sentAt).toBeLessThan(TURN_MS - 1_500);

    // 租约过期之后 B 接管：补上「已停止」，照常起轮。
    await sleep(
      Math.max(
        0,
        disconnectedAt + TAKEOVER_MS + HEARTBEAT_MS + 500 - Date.now(),
      ),
    );
    const takeover = await send(B, id, longText('分区后接手'));
    expect(takeover.status).toBe(202);
    await waitIdle(B, id);

    step('S8', 'B 的轮跑完，接回 replica-a 的网络', { conversationId: id });
    await docker(['network', 'connect', DB_NETWORK, containerOf(A.service)]);
    const afterTakeover = await ledger(B, id);
    expect(shape(afterTakeover)).toEqual([
      ['user', '断网'],
      ['assistant', 'interrupted'],
      ['user', '分区后接手'],
      ['assistant', 'completed'],
    ]);
    expect(afterTakeover[1]?.reason).toContain(HOLDER_LOST);

    // 接回网络之后，A 不再认为自己在跑，也没往账本里补写任何东西。
    await waitFor(
      async () => (await activity(A, id))['local'] !== true,
      30_000,
      'A 不再认为自己在跑',
    );
    await sleep(3_000);
    expect(await ledger(B, id)).toEqual(afterTakeover);
    expectCleanSeqs(afterTakeover);
  }, 180_000);
});
