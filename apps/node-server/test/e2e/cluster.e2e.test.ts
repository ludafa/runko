/**
 * **[集群实验环境](../../../../docs/terms.md)的端到端**：nginx 统一入口 + 五个副本 + 真
 * Postgres + 真 Redis，直播流走 WebSocket。
 *
 * 覆盖的是功能手册 §4 那张清单（docs/host/node/features/cluster-lab.md）：租约五条、
 * WebSocket 三条。与[多副本验证环境](../../../../docs/terms.md)那份（`lab.e2e.test.ts`）的分工见
 * docs/host/node/tech/cluster-lab.md §7——那边是三个写死的副本、流靠转发；这边副本数可变、
 * 流靠 Redis 广播。
 *
 * **门禁**：没设 `RUNKO_TEST_CLUSTER=1` 整个文件跳过——要 Docker、要构建镜像，不进
 * `pnpm test` 与 CI。
 *
 *   pnpm --filter @runko-chat/node-server test:cluster
 *
 * **自带起停、跑完即退**：独立项目名 + 独立端口，不碰手动起着的那套（`cluster:up`）；
 * `afterAll` 一律 `down -v`。
 *
 * **断言落在账本、租约表与连接收到的帧上**，不落在日志文本上——日志会变，这三样是事实。
 *
 * **日志留在本地**：`apps/node-server/logs/cluster-<时间>/`（`cluster-latest` 指向最近一次）。
 */
import { execFile } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { LOGS_ROOT, mergeTimeline } from '../../scripts/lab-logs.js';
import { formatLogLine } from '../../src/logger.js';

const RUN = process.env.RUNKO_TEST_CLUSTER === '1';
const PROJECT = 'runko-cluster-e2e';
const COMPOSE_FILE = fileURLToPath(
  new URL('../../docker/cluster.compose.yml', import.meta.url),
);

/** 这组用例跑在几个副本上。§4.5 那条会把它缩到 1 再扩回来。 */
const REPLICAS = 5;

/** 与 cluster.compose.yml 的缺省值一致，写在这里是为了断言里要用。 */
const HEARTBEAT_MS = 1_000;
const TAKEOVER_MS = 5_000;
const FORWARD_TIMEOUT_MS = 2_000;
/** 演示模型复述时每小段的间隔；一轮多久由消息长度决定（见 `textFor`）。 */
const CHUNK_DELAY_MS = 400;

/**
 * 独立端口，跟手动起的那套（`cluster:up` 缺省 3940 / 55443 / 56379）错开，两套可以同时在跑。
 */
const PORTS = { lb: 3960, pg: 55463, redis: 56389 } as const;

const CLUSTER_ENV = {
  CLUSTER_LB_PORT: String(PORTS.lb),
  CLUSTER_PG_PORT: String(PORTS.pg),
  CLUSTER_REDIS_PORT: String(PORTS.redis),
  CLUSTER_HEARTBEAT_MS: String(HEARTBEAT_MS),
  CLUSTER_TAKEOVER_MS: String(TAKEOVER_MS),
  CLUSTER_FORWARD_TIMEOUT_MS: String(FORWARD_TIMEOUT_MS),
  CLUSTER_CHUNK_DELAY_MS: String(CHUNK_DELAY_MS),
  // **这套用例只认[演示模型](../../../../docs/terms.md)**：断言全建立在「一轮跑多久由
  // 消息长度决定」上（见 `textFor`），换成真模型就既不确定、又要花钱。
  //
  // compose 做变量替换时也会读 shell 里的变量，所以光靠「仓库根 .env 没被喂进来」不够——
  // 谁在自己 shell 里 export 过 DEEPSEEK_API_TOKEN，这套用例就会莫名其妙地去调真模型。
  // 这里显式清空，把那条路堵死。
  DEEPSEEK_API_BASE_URL: '',
  DEEPSEEK_API_TOKEN: '',
  RUNKO_MODEL: '',
  // 同理只认[本地沙盒](../../../../docs/terms.md)：云沙盒的 key 一旦有值，建会话不点名
  // provider 时默认档就变成云沙盒，一轮要去外部开机器。
  E2B_API_KEY: '',
  VERCEL_TOKEN: '',
};

const LB_URL = `http://127.0.0.1:${String(PORTS.lb)}`;

/**
 * 请求带的来源。容器里 `NODE_ENV=production`，better-auth 在这一档**要求带 Origin 且必须在
 * 信任列表里**（列表就是副本的 `CLIENT_URL`，也就是 nginx 那个地址）——浏览器永远会带，
 * 这里手动补上。
 */
const ORIGIN = `http://localhost:${String(PORTS.lb)}`;

/** 与 `@runko/agent` 的 `ABORT_REASON_HOLDER_LOST` 同一份文案。 */
const HOLDER_LOST = 'another node took over';

// ─── docker ────────────────────────────────────────────────────────────────

const run = promisify(execFile);

async function docker(args: readonly string[]): Promise<string> {
  const { stdout } = await run('docker', [...args], {
    env: { ...process.env, ...CLUSTER_ENV },
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

const compose = (...args: string[]): Promise<string> =>
  docker(['compose', '-p', PROJECT, '-f', COMPOSE_FILE, ...args]);

/**
 * 起/改副本数。**`up --scale` 而不是写死的服务**——副本数可变正是这套环境与
 * [多副本验证环境](../../../../docs/terms.md)最大的不同（技术方案 §3）。
 */
const scaleTo = (count: number, build = false): Promise<string> =>
  compose(
    'up',
    '-d',
    '--wait',
    ...(build ? ['--build'] : []),
    '--scale',
    `node=${String(count)}`,
  );

// ─── 副本 ──────────────────────────────────────────────────────────────────

interface Replica {
  /** compose 给的序号（1 起），也是 `--index=` 要的那个数。 */
  index: number;
  container: string;
  /** 从宿主机打它用的地址。 */
  url: string;
  /** 它写进租约表的 holder——容器网络里的地址。 */
  holder: string;
}

let replicas: Replica[] = [];

/**
 * 问一个副本的两件事：宿主机端口、以及它写进租约的 holder。
 *
 * **两样都不能写死，也不能缓存太久**：
 *
 * - 端口是 compose 随机分的（`ports: ["3900"]`，技术方案 §3 的代价）。容器被重建、被
 *   `docker start` 拉起、甚至只是重连一次网络，端口都会换一个。
 * - holder 里那个主机名是**容器自己的短 id**（compose 不会把服务名写成 hostname），副本
 *   启动时 `RUNKO_NODE_URL=http://$(hostname):3900` 把它原样写进租约。
 */
async function inspectReplica(index: number): Promise<Replica> {
  const container = `${PROJECT}-node-${String(index)}`;
  const hostname = (
    await docker(['inspect', '-f', '{{.Config.Hostname}}', container])
  ).trim();
  const mapping = (
    await compose('port', `--index=${String(index)}`, 'node', '3900')
  )
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '');
  const port = mapping?.split(':').at(-1);
  if (port === undefined || port === '') {
    throw new Error(
      `问不出副本 ${String(index)} 的宿主机端口：${String(mapping)}`,
    );
  }
  return {
    index,
    container,
    url: `http://127.0.0.1:${port}`,
    holder: `http://${hostname}:3900`,
  };
}

/** 重新认一遍这些副本（容器重建/重启/重连网络之后必须做）。 */
async function discover(indices: readonly number[]): Promise<void> {
  const found = await Promise.all(indices.map(inspectReplica));
  replicas = found;
}

/** 第 `index` 个副本（1 起）。 */
function node(index: number): Replica {
  const found = replicas.find((replica) => replica.index === index);
  if (found === undefined) {
    throw new Error(`副本 ${String(index)} 还没被认出来`);
  }
  return found;
}

// ─── 日志 ──────────────────────────────────────────────────────────────────

/** 本次运行的日志目录；`beforeAll` 里建。 */
let logDir: string | undefined;

function createClusterLogDir(): string {
  // 文件名里不放冒号：2026-09-22T06-30-52
  const stamp = new Date().toISOString().slice(0, 19).replaceAll(':', '-');
  const dir = join(LOGS_ROOT, `cluster-${stamp}`);
  mkdirSync(dir, { recursive: true });
  const latest = join(LOGS_ROOT, 'cluster-latest');
  // 旧的 `cluster-latest` 是指向目录的软链接：`rmSync` 会把它当目录拒删，只能 `unlink`。
  const existing = lstatSync(latest, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink() === true) {
    unlinkSync(latest);
  }
  if (existing === undefined || existing.isSymbolicLink()) {
    symlinkSync(basename(dir), latest);
  }
  return dir;
}

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

/**
 * 把每个副本的日志存下来，并与 `test.log` 合并成一条时间线。
 *
 * **按容器取而不是按服务取**：`node` 是一个 scale 出来的服务，`compose logs node` 会把五个
 * 副本混成一份、还认不出哪行是谁的。
 */
async function saveLogs(): Promise<void> {
  const dir = logDir;
  if (dir === undefined) {
    return;
  }
  try {
    const sources: string[] = [];
    for (let index = 1; index <= REPLICAS; index += 1) {
      const name = `${PROJECT}-node-${String(index)}`;
      // 被缩掉或还没起的副本没有日志可取，跳过它而不是让整次收集失败。
      const text = await docker(['logs', name]).catch(() => undefined);
      if (text === undefined) {
        continue;
      }
      writeFileSync(join(dir, `node-${String(index)}.log`), text);
      sources.push(text);
    }
    for (const service of ['lb', 'postgres', 'redis']) {
      const text = await compose(
        'logs',
        '--no-color',
        '--no-log-prefix',
        service,
      ).catch(() => undefined);
      if (text !== undefined) {
        writeFileSync(join(dir, `${service}.log`), text);
      }
    }
    const testLog = join(dir, 'test.log');
    if (existsSync(testLog)) {
      sources.push(readFileSync(testLog, 'utf8'));
    }
    writeFileSync(join(dir, 'timeline.log'), mergeTimeline(sources));
  } catch (error: unknown) {
    step('cluster', 'collecting container logs failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
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

function count(value: Json | undefined): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

// ─── HTTP（带登录）─────────────────────────────────────────────────────────

interface Reply {
  status: number;
  body: Json;
  ms: number;
  retryAfter: string | null;
}

/**
 * 登录 cookie。**在一个副本上注册一次，五个副本通用**——登录态在库里，密钥五个副本相同。
 * 这本身就是多副本的一条前提：换个副本不用重新登录。
 */
let cookie = '';

async function request(url: string, init: RequestInit = {}): Promise<Reply> {
  const started = Date.now();
  const headers = new Headers(init.headers);
  headers.set('origin', ORIGIN);
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
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({
      email: `cluster-${String(Date.now())}@example.com`,
      password: 'cluster-password-1234',
      name: 'cluster',
    }),
    signal: AbortSignal.timeout(30_000),
  });
  // 只留 `name=value`：`Path`/`HttpOnly`/`SameSite` 是说给浏览器听的，不属于 cookie 值。
  const pairs = res.headers
    .getSetCookie()
    .map((raw) => raw.split(';')[0])
    .filter((pair): pair is string => pair !== undefined && pair.length > 0);
  if (!res.ok || pairs.length === 0) {
    throw new Error(`注册失败：${String(res.status)} ${await res.text()}`);
  }
  cookie = pairs.join('; ');
}

async function createConversation(replica: Replica): Promise<string> {
  const reply = await postJson(`${replica.url}/api/chat/conversations`, {
    title: 'cluster',
  });
  const id = text(field(reply.body, 'id'));
  if (id === undefined) {
    throw new Error(`建会话失败：${JSON.stringify(reply.body)}`);
  }
  return id;
}

/**
 * 一条让演示模型大致跑 `turnMs` 的消息。
 *
 * 演示模型把话切成 12 个字一段、每段之间停 `CHUNK_DELAY_MS`——所以一轮多久由**消息长度**
 * 决定。故障必须在一轮还没跑完时注入，否则验的是「跑完之后发生了什么」，那是另一回事。
 */
function textFor(label: string, turnMs: number): string {
  return `${label}${'字'.repeat(Math.ceil(turnMs / CHUNK_DELAY_MS) * 12)}`;
}

const send = (replica: Replica, id: string, message: string): Promise<Reply> =>
  postJson(`${replica.url}/api/chat/conversations/${id}/messages`, {
    text: message,
  });

/** 这次请求被怎么处理了：`started` / `queued` / `steered`。 */
const mode = (reply: Reply): string | undefined =>
  text(field(reply.body, 'mode'));

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
    const parts = field(message, 'parts');
    const metadata = field(message, 'metadata');
    return {
      seq: count(field(frame, 'seq')) ?? Number.NaN,
      role: text(field(message, 'role')) ?? '',
      // **取第一个带正文的部件，不是第一个部件**：assistant 那条的 parts 开头是
      // `step-start`（没有 text），正文排在它后面；user 那条就一个 text 部件。
      text:
        Array.isArray(parts) ?
          parts
            .map((part) => text(field(part, 'text')))
            .find((value) => value !== undefined)
        : undefined,
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

/**
 * 这一轮的用户消息与收尾状态——断言里只关心这两样。
 *
 * 用户消息尾部那串填充（`textFor` 加的，用来把一轮撑到足够久）在这里去掉，留下开头那个标签。
 */
function shape(rows: readonly LedgerRow[]): [string, string][] {
  return rows.map((row) => [
    row.role,
    row.role === 'user' ?
      (row.text ?? '').replace(/字+$/u, '')
    : (row.status ?? ''),
  ]);
}

const userLabels = (rows: readonly LedgerRow[]): string[] =>
  shape(rows)
    .filter(([role]) => role === 'user')
    .map(([, label]) => label);

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

const waitActive = (replica: Replica, id: string): Promise<void> =>
  waitFor(
    async () => (await activity(replica, id))['active'] === true,
    20_000,
    `副本 ${String(replica.index)} 上 ${id} 起轮`,
  );

const waitIdle = (
  replica: Replica,
  id: string,
  timeoutMs = 60_000,
): Promise<void> =>
  waitFor(
    async () => (await activity(replica, id))['active'] === false,
    timeoutMs,
    `副本 ${String(replica.index)} 上 ${id} 收尾`,
  );

const waitHealthy = (replica: Replica): Promise<void> =>
  waitFor(
    async () => (await fetch(`${replica.url}/health`)).ok,
    60_000,
    `副本 ${String(replica.index)} 重新健康`,
  );

// ─── WebSocket ─────────────────────────────────────────────────────────────

interface Watcher {
  readonly frames: readonly Json[];
  readonly closed: boolean;
  close(): void;
}

/**
 * 连一条[直播流](../../../../docs/terms.md)的 WebSocket，把收到的帧原样攒起来。
 *
 * `after` 就是断线续传的游标（「我看到第几条了」）——重连时带上它，服务端只回放它之后的行。
 */
function watch(base: string, id: string, after?: number): Watcher {
  const query = after === undefined ? '' : `?after=${String(after)}`;
  const socket = new WebSocket(
    `${base}/api/chat/conversations/${id}/ws${query}`,
    { headers: { cookie, origin: ORIGIN } },
  );
  const frames: Json[] = [];
  let closed = false;
  socket.on('message', (data: WebSocket.RawData) => {
    frames.push(parseJson(data.toString()));
  });
  socket.on('close', () => {
    closed = true;
  });
  // 副本被杀时这条连接会以 ECONNRESET 收场——那正是这组用例要造的故障，不能让它变成
  // 未捕获异常把整个测试进程带走。
  socket.on('error', () => {
    closed = true;
  });
  return {
    frames,
    get closed() {
      return closed;
    },
    close() {
      socket.close();
    },
  };
}

/** 连接收到的直播正文（`text-delta` 拼起来）。 */
function liveText(frames: readonly Json[]): string {
  return frames
    .map((frame) => {
      const chunk = field(frame, 'chunk');
      return text(field(chunk, 'type')) === 'text-delta' ?
          (text(field(chunk, 'delta')) ?? '')
        : '';
    })
    .join('');
}

/** 连接收到的带 seq 的帧（账本帧）——断线续传「不重不漏」验的就是它。 */
const frameSeqs = (frames: readonly Json[]): number[] =>
  frames
    .map((frame) => count(field(frame, 'seq')))
    .filter((seq): seq is number => seq !== undefined);

/** 连接有没有收到过「这个会话有轮在跑」那一帧。 */
const sawTurnActive = (frames: readonly Json[]): boolean =>
  frames.some((frame) => field(frame, 'turnActive') === true);

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

describe.skipIf(!RUN)(
  '集群实验环境：nginx + 五个副本 + Postgres + Redis',
  () => {
    beforeAll(async () => {
      logDir = createClusterLogDir();
      console.log(`\n集群实验环境的日志：${join(logDir, 'timeline.log')}\n`);
      await compose('down', '-v', '--remove-orphans');
      step(
        'cluster',
        'building image and starting postgres + redis + 5 nodes + nginx',
      );
      await scaleTo(REPLICAS, true);
      await discover([1, 2, 3, 4, 5]);
      step('cluster', 'environment healthy', {
        nodes: replicas.map((replica) => replica.url).join(' '),
      });
      pool = new Pool({
        host: '127.0.0.1',
        port: PORTS.pg,
        user: 'runko',
        password: 'runko',
        database: 'runko',
      });
      await signUp(node(1));
      step('cluster', 'signed up once; the cookie works on every node');
    }, 15 * 60_000);

    afterEach(async () => {
      await saveLogs();
    }, 120_000);

    afterAll(async () => {
      await pool?.end();
      await compose('down', '-v', '--remove-orphans').catch(() => undefined);
    }, 5 * 60_000);

    it('§4.1 五个副本同时收到同一条会话的消息：只有一个起轮，其余被转走排队，账本不交错', async () => {
      const id = await createConversation(node(1));
      step('4.1', '同时往五个副本发同一条会话', { conversationId: id });

      const acks = await Promise.all(
        replicas.map((replica) =>
          send(replica, id, textFor(String(replica.index), 4_000)),
        ),
      );
      expect(acks.map((ack) => ack.status)).toEqual([202, 202, 202, 202, 202]);
      // **起轮的只能有一个**，其余四条都被转给持有者、进了待发队列。多一个 `started`
      // 就意味着同一条会话上有两轮在跑——两个执行同时改同一个沙盒，正是租约要挡的事。
      expect(acks.map(mode).sort()).toEqual([
        'queued',
        'queued',
        'queued',
        'queued',
        'started',
      ]);
      expect(replicas.map((replica) => replica.holder)).toContain(
        await leaseHolder(id),
      );

      // 五轮都跑完：排队的那几条由持有者收尾时依次出队。
      await waitFor(
        async () =>
          (await ledger(node(2), id)).filter((row) => row.role === 'user')
            .length === REPLICAS,
        180_000,
        '五条消息全部起过轮',
      );
      await waitIdle(node(2), id);

      const rows = await ledger(node(2), id);
      step('4.1', '五轮都跑完', {
        conversationId: id,
        ledgerRows: rows.length,
      });
      // **一问一答严格交替**：两轮交错的话这里会出现连着两条 user 或两条 assistant。
      expect(rows.map((row) => row.role)).toEqual([
        'user',
        'assistant',
        'user',
        'assistant',
        'user',
        'assistant',
        'user',
        'assistant',
        'user',
        'assistant',
      ]);
      expect(
        rows.filter((row) => row.role === 'assistant').map((row) => row.status),
      ).toEqual([
        'completed',
        'completed',
        'completed',
        'completed',
        'completed',
      ]);
      // 出队顺序不作要求（队列按入队 seq 排，不按到达副本的顺序），但五条一条都不能丢。
      expect(userLabels(rows).sort()).toEqual(['1', '2', '3', '4', '5']);
      expectCleanSeqs(rows);
    }, 300_000);

    it('§4.6 连到任意副本（含非持有者）与 nginx 都能看到这一轮的直播——靠 Redis 广播，不靠转发', async () => {
      const id = await createConversation(node(1));
      expect(mode(await send(node(1), id, textFor('直播', 16_000)))).toBe(
        'started',
      );
      await waitActive(node(1), id);
      // 先确认 3 号真的不是持有者——不然「非持有者也看得到」就没被验到。
      expect((await activity(node(3), id))['local']).toBe(false);
      step('4.6', '1 号在跑，分别从 1 号 / 3 号 / nginx 连 WebSocket', {
        conversationId: id,
      });

      const watchers = [
        { label: 'holder', watcher: watch(node(1).url, id) },
        { label: 'other', watcher: watch(node(3).url, id) },
        { label: 'nginx', watcher: watch(LB_URL, id) },
      ];
      try {
        await waitFor(
          () =>
            Promise.resolve(
              watchers.every(({ watcher }) => liveText(watcher.frames) !== ''),
            ),
          30_000,
          '三条连接都收到直播正文',
        );
        await waitIdle(node(1), id);
        // 收尾那一帧要走完最后一跳，多等一下再看。
        await sleep(1_500);

        const rows = await ledger(node(1), id);
        const last = rows.at(-1);
        const answer = last?.text ?? '';
        expect(answer).not.toBe('');
        for (const { label, watcher } of watchers) {
          const seen = liveText(watcher.frames);
          step('4.6', `${label} 收到的直播正文`, {
            conversationId: id,
            chars: seen.length,
            frames: watcher.frames.length,
          });
          expect(sawTurnActive(watcher.frames)).toBe(true);
          // 中途连上的人只看得到「此刻往后」那一段（技术方案 §6 的已知限制），所以断言
          // 的是「它是最终答案里连续的一段」，不是「它等于最终答案」。
          expect(seen).not.toBe('');
          expect(answer).toContain(seen);
          // 收尾的那条成品消息谁都收得到——它是账本帧，带 seq。
          expect(frameSeqs(watcher.frames)).toContain(last?.seq);
        }
      } finally {
        for (const { watcher } of watchers) {
          watcher.close();
        }
      }
    }, 300_000);

    // 设计见 docs/logic/orchestration/tech/single-ledger.md §6.1 与
    // docs/logic/orchestration/tech/steer-and-queue.md §8.3。
    it('排队的下一轮：持有者不放手、接着跑，非持有者上的同一条直播连接一路看完整个队列', async () => {
      const id = await createConversation(node(1));
      expect(mode(await send(node(1), id, textFor('第一件', 6_000)))).toBe(
        'started',
      );
      await waitActive(node(1), id);
      const holder = await leaseHolder(id);
      const watcher = watch(node(3).url, id);
      try {
        // 消息打到 2 号：转给持有者，进待发队列。
        expect(mode(await send(node(2), id, textFor('第二件', 4_000)))).toBe(
          'queued',
        );
        step('queue', '1 号在跑、2 号收的排队消息、3 号上连着直播', {
          conversationId: id,
        });

        // 两轮都写进账本之前，归属一直在同一个副本手上——两轮之间没有「放手再抢」。
        const holders = new Set<string | null | undefined>();
        await waitFor(
          async () => {
            const rows = await ledger(node(1), id);
            const done =
              rows.filter((row) => row.role === 'assistant').length === 2;
            if (!done) {
              holders.add(await leaseHolder(id));
            }
            return done;
          },
          120_000,
          '两轮都跑完',
        );
        expect([...holders]).toEqual([holder]);

        await waitIdle(node(1), id);
        // 收尾那一帧要走完 Redis 这一跳，多等一下再看。
        await sleep(1_500);
        const endings = watcher.frames
          .map((frame) => field(field(frame, 'chunk'), 'messageMetadata'))
          .map((metadata) => text(field(metadata, 'status')))
          .filter((status) => status !== undefined);
        const inactive = watcher.frames.filter(
          (frame) => field(frame, 'turnActive') === false,
        );
        step('queue', '3 号那条连接看到的收尾', {
          conversationId: id,
          endings: endings.join(','),
          inactive: inactive.length,
        });
        expect(endings).toEqual(['completed', 'completed']);
        expect(inactive).toHaveLength(1);
        expect(shape(await ledger(node(1), id))).toEqual([
          ['user', '第一件'],
          ['assistant', 'completed'],
          ['user', '第二件'],
          ['assistant', 'completed'],
        ]);
      } finally {
        watcher.close();
      }
    }, 180_000);

    it('§4.7 连接所在的副本挂掉：带 after 重连到别的副本能接着看，不重不漏', async () => {
      const id = await createConversation(node(1));
      expect(mode(await send(node(1), id, textFor('续传', 20_000)))).toBe(
        'started',
      );
      await waitActive(node(1), id);

      // 连的是 2 号（**不是**持有者）：轮跑在 1 号上，内容靠广播过来。
      const first = watch(node(2).url, id);
      await waitFor(
        () => Promise.resolve(liveText(first.frames) !== ''),
        30_000,
        '2 号上的连接收到直播正文',
      );
      const before = frameSeqs(first.frames);
      const cursor = Math.max(0, ...before);
      step('4.7', '2 号上的连接看到了，现在杀掉 2 号', {
        conversationId: id,
        seenSeqs: before.join(','),
      });

      await docker(['kill', '-s', 'SIGKILL', node(2).container]);
      await waitFor(
        () => Promise.resolve(first.closed),
        30_000,
        '2 号被杀之后连接断开',
      );

      // 重连到 3 号，带上「我看到第几条了」。这一轮还在 1 号上跑着。
      const second = watch(node(3).url, id, cursor);
      try {
        await waitIdle(node(1), id);
        await sleep(1_500);
        const after = frameSeqs(second.frames);
        step('4.7', '重连之后收到的账本帧', {
          conversationId: id,
          cursor,
          seqs: after.join(','),
        });

        // **不重**：带了游标就绝不该再收到游标以前的行。
        expect(after.every((seq) => seq > cursor)).toBe(true);
        // **不漏**：断开前后两段拼起来，正好是账本的全部行，一行不多一行不少。
        const rows = await ledger(node(1), id);
        expect([...before, ...after]).toEqual(rows.map((row) => row.seq));
        expect(shape(rows)).toEqual([
          ['user', '续传'],
          ['assistant', 'completed'],
        ]);
        // **接着看**：重连之后仍然是直播，不是只等一条收尾消息。
        expect(liveText(second.frames)).not.toBe('');
      } finally {
        second.close();
      }

      step('4.7', '把 2 号拉起来', {});
      await docker(['start', node(2).container]);
      // 重启过的容器会换一个宿主机端口，重新认一遍。
      await discover([1, 2, 3, 4, 5]);
      await waitHealthy(node(2));
    }, 300_000);

    it('§4.2 持有者被 kill -9：接管阈值之前先 504，之后别的副本接手，崩掉那一轮补上「已停止」', async () => {
      const id = await createConversation(node(1));
      expect(mode(await send(node(1), id, textFor('跑一半', 20_000)))).toBe(
        'started',
      );
      await waitActive(node(1), id);

      step('4.2', '1 号在跑，kill -9 掉它', { conversationId: id });
      await docker(['kill', '-s', 'SIGKILL', node(1).container]);

      // 租约还没过期：2 号抢不到，转给 1 号。`docker kill` 之后它的 IP 从网络里消失，连接既不被拒也没人应，
      // 只能等满转发超时 → 504（是死是冻分不出来，请求送没送到未知，见 `forward.ts` 的 `RESULT_UNKNOWN_STATUS`）。
      // 用时要在一次超时附近，不能翻倍（翻倍说明被自动重发了）。
      const early = await send(node(2), id, '太早了');
      step('4.2', '租约未过期时往 2 号发', {
        conversationId: id,
        status: early.status,
        ms: early.ms,
      });
      expect(early.status).toBe(504);
      expect(early.retryAfter).toBe('1');
      expect(early.ms).toBeLessThan(FORWARD_TIMEOUT_MS * 2 - 500);

      await sleep(TAKEOVER_MS + 1_000);
      const late = await send(node(2), id, textFor('我来接手', 4_000));
      expect(late.status).toBe(202);
      expect(mode(late)).toBe('started');
      await waitIdle(node(2), id);

      const rows = await ledger(node(2), id);
      expect(shape(rows)).toEqual([
        ['user', '跑一半'],
        ['assistant', 'interrupted'],
        ['user', '我来接手'],
        ['assistant', 'completed'],
      ]);
      expect(rows[1]?.reason).toContain(HOLDER_LOST);
      expectCleanSeqs(rows);

      step('4.2', '把 1 号拉起来', { conversationId: id });
      await docker(['start', node(1).container]);
      await discover([1, 2, 3, 4, 5]);
      await waitHealthy(node(1));
    }, 300_000);

    it('§4.3 持有者被冻住：转发在超时附近回 504；接管之后它醒来，账本一行不多', async () => {
      const id = await createConversation(node(1));
      expect(mode(await send(node(1), id, textFor('冻住我', 24_000)))).toBe(
        'started',
      );
      await waitActive(node(1), id);

      step('4.3', '1 号在跑，冻住它', { conversationId: id });
      await docker(['pause', node(1).container]);
      const frozenAt = Date.now();

      // **冻结期间只发这一条**，而且挑一条不改任何状态的转发请求（队列本来就是空的）：
      // 冻住的进程端口还在、TCP 握手由内核完成，请求会堆在内核缓冲里，解冻之后一起被
      // 处理——这时候再发消息，等于在接管之后又往老持有者塞了一遍。
      const drop = await request(
        `${node(2).url}/api/chat/conversations/${id}/queue`,
        { method: 'DELETE' },
      );
      step('4.3', '冻住期间经 2 号清队列（要转给 1 号）', {
        conversationId: id,
        status: drop.status,
        ms: drop.ms,
      });
      expect(drop.status).toBe(504);
      expect(field(drop.body, 'holder')).toBe(node(1).holder);
      expect(drop.ms).toBeGreaterThanOrEqual(FORWARD_TIMEOUT_MS - 200);
      // 上限必须小于**两倍**超时：回 421 时 Fetch 标准客户端会自动重发一遍，用时正好翻倍。
      expect(drop.ms).toBeLessThan(FORWARD_TIMEOUT_MS * 2 - 500);

      await sleep(Math.max(0, frozenAt + TAKEOVER_MS + 1_000 - Date.now()));
      const takeover = await send(node(2), id, textFor('我接管了', 8_000));
      expect(mode(takeover)).toBe('started');

      // **趁 2 号这一轮还在跑就唤醒 1 号**：它的心跳一醒就发现围栏到期、停手；它的收尾要
      // 取号写账本、还要 `release`——取号必须被拒，`release` 必须既擦不掉 2 号的归属、
      // 也抢不回来。
      step('4.3', '2 号的轮还在跑，解冻 1 号', { conversationId: id });
      await docker(['unpause', node(1).container]);
      await sleep(HEARTBEAT_MS * 3);
      expect((await activity(node(2), id))['local']).toBe(true);
      expect(await leaseHolder(id)).toBe(node(2).holder);

      await waitIdle(node(2), id);
      const rows = await ledger(node(2), id);
      expect(shape(rows)).toEqual([
        ['user', '冻住我'],
        ['assistant', 'interrupted'],
        ['user', '我接管了'],
        ['assistant', 'completed'],
      ]);
      expect(rows[1]?.reason).toContain(HOLDER_LOST);
      expectCleanSeqs(rows);

      await waitFor(
        async () => (await activity(node(1), id))['local'] !== true,
        20_000,
        '1 号不再认为自己在跑',
      );
      // 再等一会儿：1 号迟到的写入（如果有）也该落地了。账本必须还是这四行。
      await sleep(2_000);
      expect(await ledger(node(2), id)).toEqual(rows);
    }, 300_000);

    it('§4.4 持有者连不上库：没人来接管它也自我围栏、自己停手', async () => {
      // 这一轮要撑得足够久，好让「它在模型跑完之前就停了」成为可验的事实。
      const turnMs = 36_000;
      const id = await createConversation(node(1));
      const sentAt = Date.now();
      expect(mode(await send(node(1), id, textFor('断库', turnMs)))).toBe(
        'started',
      );
      await waitActive(node(1), id);

      step('4.4', '1 号在跑，把它从网络里摘掉（库、Redis、同伴一起断）', {
        conversationId: id,
      });
      const network = `${PROJECT}_cluster`;
      await docker(['network', 'disconnect', network, node(1).container]);

      // 等过接管阈值。**这段时间里没有任何人来接管**——别的副本一句话都没收到。
      await sleep(TAKEOVER_MS + HEARTBEAT_MS + 500);
      expect(await leaseHolder(id)).toBe(node(1).holder);
      step('4.4', '接管阈值已过，租约仍记在 1 号名下（确实没人接管过）', {
        conversationId: id,
      });

      // 现在才让 2 号接手：租约心跳早停了，它接得下来，并替那一轮补上「已停止」。
      const takeover = await send(node(2), id, textFor('分区后接手', 4_000));
      expect(takeover.status).toBe(202);
      expect(mode(takeover)).toBe('started');
      await waitIdle(node(2), id);

      const rows = await ledger(node(2), id);
      expect(shape(rows)).toEqual([
        ['user', '断库'],
        ['assistant', 'interrupted'],
        ['user', '分区后接手'],
        ['assistant', 'completed'],
      ]);
      expect(rows[1]?.reason).toContain(HOLDER_LOST);
      expectCleanSeqs(rows);

      step('4.4', '接回 1 号的网络', { conversationId: id });
      await docker(['network', 'connect', network, node(1).container]);
      // 重连网络会让容器换一个宿主机端口，重新认一遍才问得到它。
      await discover([1, 2, 3, 4, 5]);
      await waitHealthy(node(1));

      // **自我围栏的证据**：1 号手里没有这一轮了。它被摘掉期间既查不到库、也收不到任何
      // 请求，能停手只可能是自己停的。
      await waitFor(
        async () => (await activity(node(1), id))['local'] !== true,
        20_000,
        '1 号不再认为自己在跑',
      );
      const stoppedBy = Date.now() - sentAt;
      step('4.4', '1 号已经不认为自己在跑', {
        conversationId: id,
        sinceSentMs: stoppedBy,
        modelWouldRunMs: turnMs,
      });
      // 而且停得比模型跑完早得多——不是「跑完了才发现」。
      expect(stoppedBy).toBeLessThan(turnMs - 5_000);

      // 迟到的写入一行都没有。
      await sleep(3_000);
      expect(await ledger(node(2), id)).toEqual(rows);
    }, 360_000);

    it('§4.8 Redis 挂掉：这一轮照常跑完、照常进账本（跨副本直播看不到是已知限制）', async () => {
      step('4.8', '停掉 redis');
      await compose('stop', 'redis');

      const id = await createConversation(node(1));
      expect(mode(await send(node(1), id, textFor('红断了', 8_000)))).toBe(
        'started',
      );
      await waitActive(node(1), id);
      const onHolder = watch(node(1).url, id);
      const onOther = watch(node(3).url, id);
      try {
        await waitIdle(node(1), id);
        await sleep(1_500);

        const rows = await ledger(node(2), id);
        step('4.8', 'redis 停着，这一轮的账本', {
          conversationId: id,
          ledgerRows: rows.length,
          holderChars: liveText(onHolder.frames).length,
          otherChars: liveText(onOther.frames).length,
        });
        // **账本照常写、轮照常收尾**——Redis 只做广播，不是一轮能不能跑的前提。
        expect(shape(rows)).toEqual([
          ['user', '红断了'],
          ['assistant', 'completed'],
        ]);
        expectCleanSeqs(rows);
        // 连在持有者身上的人照样看得到：发布先走本进程的回环，不经 Redis。
        expect(liveText(onHolder.frames)).not.toBe('');
        // 连在别的副本上的人这时看不到（技术方案 §6 的已知限制），所以这里不断言它。
        // 它顺带证明了 §4.6 的「看得到」确实来自广播，而不是被偷偷转发给了持有者。
      } finally {
        onHolder.close();
        onOther.close();
      }

      step('4.8', '把 redis 拉起来');
      await compose('start', 'redis');
      // 广播恢复之后，跨副本又看得到直播了——后面的用例也指望着这一点。
      const back = await createConversation(node(1));
      expect(mode(await send(node(1), back, textFor('红回来', 16_000)))).toBe(
        'started',
      );
      await waitActive(node(1), back);
      const again = watch(node(3).url, back);
      try {
        await waitFor(
          () => Promise.resolve(liveText(again.frames) !== ''),
          60_000,
          'redis 回来之后跨副本又收得到直播',
        );
      } finally {
        again.close();
      }
      await postJson(`${node(1).url}/api/chat/conversations/${back}/abort`, {});
      await waitIdle(node(1), back);
    }, 300_000);

    it('§4.5 副本数 1 → 5：缩到一个照样跑；扩回来的新副本转得动、也接得了管', async () => {
      step('4.5', '缩到 1 个副本');
      // 先把 2–5 号删掉再缩：compose 缩容时留下哪一个不固定，下面认定留下的是 1 号。
      await docker([
        'rm',
        '-f',
        ...[2, 3, 4, 5].map((index) => node(index).container),
      ]);
      await scaleTo(1);
      await discover([1]);
      await waitHealthy(node(1));

      const solo = await createConversation(node(1));
      expect(mode(await send(node(1), solo, textFor('只剩一个', 4_000)))).toBe(
        'started',
      );
      await waitIdle(node(1), solo);
      expect(shape(await ledger(node(1), solo))).toEqual([
        ['user', '只剩一个'],
        ['assistant', 'completed'],
      ]);

      step('4.5', '扩回 5 个副本（2–5 号是全新的容器）');
      await scaleTo(REPLICAS);
      await discover([1, 2, 3, 4, 5]);
      for (const replica of replicas) {
        await waitHealthy(replica);
      }

      // ① 新副本转得动：轮起在 1 号上，消息打到刚扩出来的 5 号。
      const forwarded = await createConversation(node(5));
      expect(
        mode(await send(node(1), forwarded, textFor('老副本起轮', 8_000))),
      ).toBe('started');
      await waitActive(node(1), forwarded);
      expect(
        mode(await send(node(5), forwarded, textFor('新副本转发', 4_000))),
      ).toBe('queued');
      await waitFor(
        async () =>
          (await ledger(node(5), forwarded)).filter(
            (row) => row.role === 'user',
          ).length === 2,
        120_000,
        '排队的那条出队起轮',
      );
      await waitIdle(node(5), forwarded);
      expect(shape(await ledger(node(5), forwarded))).toEqual([
        ['user', '老副本起轮'],
        ['assistant', 'completed'],
        ['user', '新副本转发'],
        ['assistant', 'completed'],
      ]);

      // ② 新副本接得了管：1 号崩掉，刚扩出来的 4 号在接管阈值之后接手。
      const over = await createConversation(node(1));
      expect(
        mode(await send(node(1), over, textFor('新副本接管', 20_000))),
      ).toBe('started');
      await waitActive(node(1), over);
      step('4.5', '1 号在跑，kill -9 掉它，等 4 号接手', {
        conversationId: over,
      });
      await docker(['kill', '-s', 'SIGKILL', node(1).container]);
      await sleep(TAKEOVER_MS + 1_000);

      const late = await send(node(4), over, textFor('我是新来的', 4_000));
      expect(mode(late)).toBe('started');
      // 趁这一轮还在跑，看一眼租约确实换到了新副本名下。
      expect(await leaseHolder(over)).toBe(node(4).holder);
      await waitIdle(node(4), over);

      const rows = await ledger(node(4), over);
      expect(shape(rows)).toEqual([
        ['user', '新副本接管'],
        ['assistant', 'interrupted'],
        ['user', '我是新来的'],
        ['assistant', 'completed'],
      ]);
      expect(rows[1]?.reason).toContain(HOLDER_LOST);
      expectCleanSeqs(rows);
    }, 420_000);
  },
);
