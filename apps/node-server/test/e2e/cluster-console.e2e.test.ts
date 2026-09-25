/**
 * **[集群控制台](../../../../docs/terms.md)的端到端**：真 Docker、真运维容器、真 nginx。
 *
 * 覆盖 docs/host/node/features/cluster-console.md §5 的四条成功标准，外加 §3.3 时间线与
 * docs/host/node/tech/cluster-console.md §6 的 nginx 重试——拆成六个场景，见各 `it` 的注释。
 *
 * **跟 `cluster.e2e.test.ts` 的分工**：那一份测的是[集群实验环境](../../../../docs/terms.md)本身
 * （租约仲裁、直播广播），不碰下线；这一份专测控制台——运维容器、下线闸门、`shutdown` 的
 * `finishWindowMs` 窗口、nginx 的 `proxy_next_upstream`。两份文件都基于同一个 `docker/cluster.compose.yml`，
 * 起停方式、`request`/`send`/`ledger` 这类 HTTP 小工具照抄同款写法（同一个作者、同一份约定），
 * 独立成一个文件不共享是照抄 `cluster.e2e.test.ts` 自己的选择——它也没有拆共享 helper。
 *
 * **门禁**：没设 `RUNKO_TEST_CLUSTER=1` 整个文件跳过——要 Docker、要构建镜像，不进
 * `pnpm test` 与 CI。
 *
 *   RUNKO_TEST_CLUSTER=1 pnpm --filter @runko-chat/node-server vitest run test/e2e/cluster-console.e2e.test.ts
 *
 * **自带起停、跑完即退，项目名与端口都是自己专属的一套**（`runko-cluster-console-e2e`，
 * 3980/55483/56399），既不碰手动起着的那套（`cluster:up` 缺省 3940/55443/56379），也不碰
 * `cluster.e2e.test.ts` 自己那套（`runko-cluster-e2e`，3960/55463/56389）——三套可以同时在跑。
 * 每个 `describe` 各自 `afterAll` 一律 `down -v`。
 *
 * **两组场景、两次起停**：下线的时间预算（让轮跑完的窗口 `finishWindowMs`、收尾宽限 `graceMs`、
 * 强杀期限）都是启动时通过环境变量焊死进容器的，改不了就得重开一套集群。「正常下线」那组
 * （场景 1/2/4/5/6）用 `window=8s / grace=3s / kill=15s`（`window+grace < kill`，节点自己来得及
 * 退出）；「强杀」那组（场景 3）单独开一套 `window=60s`（远大于 kill）、`kill=8s`，逼它非被
 * SIGKILL 不可。
 *
 * **日志留在本地**：`apps/node-server/logs/cluster-console-<时间>/`（`cluster-console-latest`
 * 指向最近一次）。
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

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { LOGS_ROOT, mergeTimeline } from '../../scripts/lab-logs.js';
import { formatLogLine } from '../../src/logger.js';

const RUN = process.env.RUNKO_TEST_CLUSTER === '1';
const PROJECT = 'runko-cluster-console-e2e';
const COMPOSE_FILE = fileURLToPath(
  new URL('../../docker/cluster.compose.yml', import.meta.url),
);

/** 独立端口：跟手动起的那套（3940/55443/56379）与 `cluster.e2e.test.ts`（3960/55463/56389）都错开。 */
const PORTS = { lb: 3980, pg: 55483, redis: 56399 } as const;
const LB_URL = `http://127.0.0.1:${String(PORTS.lb)}`;
/** better-auth 在容器的 production 档要求带 Origin 且在信任列表里，见 `cluster.e2e.test.ts` 同款注释。 */
const ORIGIN = `http://localhost:${String(PORTS.lb)}`;

const HEARTBEAT_MS = 1_000;
const TAKEOVER_MS = 5_000;
const FORWARD_TIMEOUT_MS = 2_000;
/** 演示模型复述每小段的间隔；一轮多久由消息长度决定，见 `textFor`。 */
const CHUNK_DELAY_MS = 400;

/** 「正常下线」那组：节点自己在 kill 期限之前退出。 */
const NORMAL_FINISH_WINDOW_MS = 8_000;
const NORMAL_GRACE_MS = 3_000;
const NORMAL_KILL_S = 15;

/** 「强杀」那组：等待窗口远大于 kill，节点来不及自己退出，只能被 SIGKILL。 */
const KILL_FINISH_WINDOW_MS = 60_000;
const KILL_GRACE_MS = 3_000;
const KILL_KILL_S = 8;

/** 与 `packages/agent/src/runtime/reasons.ts` 的 `ABORT_REASON_SHUTDOWN` 同一份文案。 */
const ABORT_REASON_SHUTDOWN =
  'Server is shutting down; this turn was interrupted.';

// ─── docker ────────────────────────────────────────────────────────────────

const run = promisify(execFile);

/** 当前生效的环境变量（每个 `describe` 的 `beforeAll` 会换一套下线时间预算）。 */
let activeEnv: Record<string, string> = {};

async function docker(args: readonly string[]): Promise<string> {
  const { stdout } = await run('docker', [...args], {
    env: { ...process.env, ...activeEnv },
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

const compose = (...args: string[]): Promise<string> =>
  docker(['compose', '-p', PROJECT, '-f', COMPOSE_FILE, ...args]);

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
  index: number;
  container: string;
  url: string;
}

let replicas: Replica[] = [];

async function inspectReplica(index: number): Promise<Replica> {
  const container = `${PROJECT}-node-${String(index)}`;
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
  return { index, container, url: `http://127.0.0.1:${port}` };
}

async function discover(indices: readonly number[]): Promise<void> {
  const found = await Promise.all(indices.map(inspectReplica));
  replicas = found;
}

function node(index: number): Replica {
  const found = replicas.find((replica) => replica.index === index);
  if (found === undefined) {
    throw new Error(`副本 ${String(index)} 还没被认出来`);
  }
  return found;
}

/** `docker inspect` 出容器现在还在不在跑、以及它的退出码。 */
async function containerExitInfo(
  container: string,
): Promise<{ running: boolean; exitCode: number }> {
  const out = (
    await docker([
      'inspect',
      '-f',
      '{{.State.Running}} {{.State.ExitCode}}',
      container,
    ])
  ).trim();
  const [runningRaw, exitRaw] = out.split(' ');
  return {
    running: runningRaw === 'true',
    exitCode: Number(exitRaw ?? Number.NaN),
  };
}

// ─── 日志 ──────────────────────────────────────────────────────────────────

let logDir: string | undefined;
/** `saveLogs` 要知道当前这一组开了几个副本，才能挨个把日志捞出来。 */
let currentReplicas = 0;

function createClusterLogDir(): string {
  const stamp = new Date().toISOString().slice(0, 19).replaceAll(':', '-');
  const dir = join(LOGS_ROOT, `cluster-console-${stamp}`);
  mkdirSync(dir, { recursive: true });
  const latest = join(LOGS_ROOT, 'cluster-console-latest');
  const existing = lstatSync(latest, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink() === true) {
    unlinkSync(latest);
  }
  if (existing === undefined || existing.isSymbolicLink()) {
    symlinkSync(basename(dir), latest);
  }
  return dir;
}

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
  const dir = logDir;
  if (dir === undefined) {
    return;
  }
  try {
    const sources: string[] = [];
    for (let index = 1; index <= Math.max(currentReplicas, 1); index += 1) {
      const name = `${PROJECT}-node-${String(index)}`;
      const text = await docker(['logs', name]).catch(() => undefined);
      if (text === undefined) {
        continue;
      }
      writeFileSync(join(dir, `node-${String(index)}.log`), text);
      sources.push(text);
    }
    for (const service of ['lb', 'ops', 'postgres', 'redis']) {
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
    step('cluster-console', 'collecting container logs failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ─── JSON 边界 ─────────────────────────────────────────────────────────────

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

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

function optionalText(value: Json | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

function count(value: Json | undefined): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function optionalNumber(value: Json | undefined): number | null {
  return typeof value === 'number' ? value : null;
}

// ─── HTTP（带登录）─────────────────────────────────────────────────────────

interface Reply {
  status: number;
  body: Json;
  ms: number;
  retryAfter: string | null;
}

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

async function signUp(baseUrl: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({
      email: `cluster-console-${String(Date.now())}@example.com`,
      password: 'cluster-console-password-1234',
      name: 'cluster-console',
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const pairs = res.headers
    .getSetCookie()
    .map((raw) => raw.split(';')[0])
    .filter((pair): pair is string => pair !== undefined && pair.length > 0);
  if (!res.ok || pairs.length === 0) {
    throw new Error(`注册失败：${String(res.status)} ${await res.text()}`);
  }
  cookie = pairs.join('; ');
}

async function createConversation(baseUrl: string): Promise<string> {
  const reply = await postJson(`${baseUrl}/api/chat/conversations`, {
    title: 'cluster-console',
  });
  const id = text(field(reply.body, 'id'));
  if (id === undefined) {
    throw new Error(`建会话失败：${JSON.stringify(reply.body)}`);
  }
  return id;
}

const send = (baseUrl: string, id: string, message: string): Promise<Reply> =>
  postJson(`${baseUrl}/api/chat/conversations/${id}/messages`, {
    text: message,
  });

const mode = (reply: Reply): string | undefined =>
  text(field(reply.body, 'mode'));

async function activity(baseUrl: string, id: string): Promise<JsonObject> {
  const reply = await request(
    `${baseUrl}/api/chat/conversations/${id}/activity`,
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

async function ledger(baseUrl: string, id: string): Promise<LedgerRow[]> {
  const reply = await request(
    `${baseUrl}/api/chat/conversations/${id}/messages`,
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

function expectCleanSeqs(rows: readonly LedgerRow[]): void {
  const seqs = rows.map((row) => row.seq);
  expect(new Set(seqs).size).toBe(seqs.length);
  expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
}

function shape(rows: readonly LedgerRow[]): [string, string][] {
  return rows.map((row) => [
    row.role,
    row.role === 'user' ?
      (row.text ?? '').replace(/字+$/u, '')
    : (row.status ?? ''),
  ]);
}

/** 一条让演示模型大致跑 `turnMs` 的消息，写法与 `cluster.e2e.test.ts` 的 `textFor` 一致。 */
function textFor(label: string, turnMs: number): string {
  return `${label}${'字'.repeat(Math.ceil(turnMs / CHUNK_DELAY_MS) * 12)}`;
}

// ─── 控制台 API ────────────────────────────────────────────────────────────

interface NodeView {
  id: string;
  index: number | null;
  url: string | null;
  state: string;
  dockerState: string | null;
  offlineDeadline: number | null;
}

function parseNodeView(value: Json | undefined): NodeView {
  const id = text(field(value, 'id'));
  const state = text(field(value, 'state'));
  if (id === undefined || state === undefined) {
    throw new Error(`节点视图缺字段：${JSON.stringify(value)}`);
  }
  return {
    id,
    index: optionalNumber(field(value, 'index')),
    url: optionalText(field(value, 'url')),
    state,
    dockerState: optionalText(field(value, 'dockerState')),
    offlineDeadline: optionalNumber(field(value, 'offlineDeadline')),
  };
}

interface OverviewView {
  controllable: boolean;
  nodes: NodeView[];
  opsError: string | undefined;
}

async function overview(baseUrl: string): Promise<OverviewView> {
  const reply = await request(`${baseUrl}/api/console/overview`);
  if (reply.status !== 200) {
    throw new Error(
      `overview 失败：${String(reply.status)} ${JSON.stringify(reply.body)}`,
    );
  }
  const nodesField = field(reply.body, 'nodes');
  if (!Array.isArray(nodesField)) {
    throw new Error(`overview.nodes 不是数组：${JSON.stringify(reply.body)}`);
  }
  return {
    controllable: field(reply.body, 'controllable') === true,
    nodes: nodesField.map(parseNodeView),
    opsError: text(field(reply.body, 'opsError')),
  };
}

function findNode(view: OverviewView, index: number): NodeView {
  const found = view.nodes.find((candidate) => candidate.index === index);
  if (found === undefined) {
    throw new Error(
      `overview 里找不到副本 ${String(index)}（现有 index：${view.nodes.map((n) => String(n.index)).join(',')}）`,
    );
  }
  return found;
}

async function consoleOffline(
  baseUrl: string,
  id: string,
): Promise<{ status: number; offlineDeadline: number | undefined }> {
  const reply = await postJson(
    `${baseUrl}/api/console/nodes/${encodeURIComponent(id)}/offline`,
    {},
  );
  return {
    status: reply.status,
    offlineDeadline: count(field(reply.body, 'offlineDeadline')),
  };
}

async function consoleOnline(
  baseUrl: string,
  id: string,
): Promise<{ status: number }> {
  const reply = await postJson(
    `${baseUrl}/api/console/nodes/${encodeURIComponent(id)}/online`,
    {},
  );
  return { status: reply.status };
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

const waitActive = (baseUrl: string, id: string): Promise<void> =>
  waitFor(
    async () => (await activity(baseUrl, id))['active'] === true,
    20_000,
    `${id} 起轮`,
  );

const waitIdle = (
  baseUrl: string,
  id: string,
  timeoutMs = 30_000,
): Promise<void> =>
  waitFor(
    async () => (await activity(baseUrl, id))['active'] === false,
    timeoutMs,
    `${id} 收尾`,
  );

const waitHealthy = (baseUrl: string): Promise<void> =>
  waitFor(
    async () => (await fetch(`${baseUrl}/health`)).ok,
    60_000,
    `${baseUrl} 重新健康`,
  );

const waitNodeState = (
  index: number,
  state: string,
  timeoutMs = 30_000,
): Promise<void> =>
  waitFor(
    async () => findNode(await overview(LB_URL), index).state === state,
    timeoutMs,
    `overview 里副本 ${String(index)} 变成 ${state}`,
  );

const waitExited = (container: string, timeoutMs: number): Promise<void> =>
  waitFor(
    async () => !(await containerExitInfo(container)).running,
    timeoutMs,
    `${container} 退出`,
  );

// ─── WebSocket ─────────────────────────────────────────────────────────────

interface Watcher {
  readonly frames: readonly Json[];
  readonly closed: boolean;
  readonly closeCode: number | undefined;
  close(): void;
}

function watch(base: string, id: string, after?: number): Watcher {
  const query = after === undefined ? '' : `?after=${String(after)}`;
  const socket = new WebSocket(
    `${base}/api/chat/conversations/${id}/ws${query}`,
    { headers: { cookie, origin: ORIGIN } },
  );
  const frames: Json[] = [];
  let closed = false;
  let closeCode: number | undefined;
  socket.on('message', (data: WebSocket.RawData) => {
    frames.push(parseJson(data.toString()));
  });
  socket.on('close', (code: number) => {
    closed = true;
    closeCode = code;
  });
  // 副本被下线/强杀时这条连接可能以 ECONNRESET 收场——那正是要造的故障，不能让它变成
  // 未捕获异常把整个测试进程带走。
  socket.on('error', () => {
    closed = true;
  });
  return {
    frames,
    get closed() {
      return closed;
    },
    get closeCode() {
      return closeCode;
    },
    close() {
      socket.close();
    },
  };
}

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

const frameSeqs = (frames: readonly Json[]): number[] =>
  frames
    .map((frame) => count(field(frame, 'seq')))
    .filter((seq): seq is number => seq !== undefined);

// ─── 用例 ──────────────────────────────────────────────────────────────────

describe.skipIf(!RUN)(
  '集群控制台：正常下线（跑完 / 中止 / 上线 / WS / nginx 重试）',
  () => {
    beforeAll(async () => {
      activeEnv = {
        CLUSTER_LB_PORT: String(PORTS.lb),
        CLUSTER_PG_PORT: String(PORTS.pg),
        CLUSTER_REDIS_PORT: String(PORTS.redis),
        CLUSTER_HEARTBEAT_MS: String(HEARTBEAT_MS),
        CLUSTER_TAKEOVER_MS: String(TAKEOVER_MS),
        CLUSTER_FORWARD_TIMEOUT_MS: String(FORWARD_TIMEOUT_MS),
        CLUSTER_CHUNK_DELAY_MS: String(CHUNK_DELAY_MS),
        CLUSTER_OFFLINE_FINISH_WINDOW_MS: String(NORMAL_FINISH_WINDOW_MS),
        CLUSTER_OFFLINE_GRACE_MS: String(NORMAL_GRACE_MS),
        CLUSTER_OFFLINE_KILL_S: String(NORMAL_KILL_S),
        // 这套用例只认演示模型与本地沙盒，见 `cluster.e2e.test.ts` 同款注释：显式清空，
        // 免得谁在自己 shell 里 export 过真 key，测试莫名其妙去调外部服务。
        DEEPSEEK_API_BASE_URL: '',
        DEEPSEEK_API_TOKEN: '',
        RUNKO_MODEL: '',
        E2B_API_KEY: '',
        VERCEL_TOKEN: '',
      };
      currentReplicas = 3;
      logDir = createClusterLogDir();
      console.log(
        `\n集群控制台（正常下线）的日志：${join(logDir, 'timeline.log')}\n`,
      );
      await compose('down', '-v', '--remove-orphans');
      step(
        'cluster-console',
        'building image and starting 3 nodes + ops + lb',
        {
          finishWindowMs: NORMAL_FINISH_WINDOW_MS,
          graceMs: NORMAL_GRACE_MS,
          killS: NORMAL_KILL_S,
        },
      );
      await scaleTo(3, true);
      await discover([1, 2, 3]);
      await signUp(node(1).url);
      step('cluster-console', 'environment healthy; signed up once');
    }, 10 * 60_000);

    afterEach(async () => {
      await saveLogs();
    }, 120_000);

    afterAll(async () => {
      await compose('down', '-v', '--remove-orphans').catch(() => undefined);
    }, 5 * 60_000);

    it('场景 1（含场景 6）：节点 A 上一轮短于等待窗口 的；下线后正常跑完；下线期间经 lb 的请求全部成功，直连它拿 503、经 lb 拿 2xx；A 在 window+grace 内退出', async () => {
      const conversationId = await createConversation(node(1).url);
      step('S1', '在节点 1 上起一轮（短于等待窗口）', { conversationId });
      expect(
        mode(await send(node(1).url, conversationId, textFor('跑完', 4_000))),
      ).toBe('started');
      await waitActive(LB_URL, conversationId);

      const before = await overview(LB_URL);
      expect(before.controllable).toBe(true);
      expect(before.opsError).toBeUndefined();
      const nodeA = findNode(before, 1);
      expect(nodeA.state).toBe('online');

      const ack = await consoleOffline(LB_URL, nodeA.id);
      step('S1', '经控制台 API 下线节点 1', {
        nodeId: nodeA.id,
        status: ack.status,
        offlineDeadline: ack.offlineDeadline,
      });
      expect(ack.status).toBe(202);
      expect(ack.offlineDeadline).toBeDefined();

      // 立刻看一眼：节点已经是「下线中」，带着强杀倒计时（§3.3 的 0 秒那一行）。
      const during = await overview(LB_URL);
      const goingOffline = findNode(during, 1);
      expect(goingOffline.state).toBe('going_offline');
      expect(goingOffline.offlineDeadline).not.toBeNull();

      // 场景 6：同一条 POST，直连被下线节点拿 503（+ Retry-After），经 lb 拿 2xx。
      const direct = await postJson(`${node(1).url}/api/chat/conversations`, {
        title: 'direct-during-offline',
      });
      expect(direct.status).toBe(503);
      expect(direct.retryAfter).toBe('1');
      const viaLb = await postJson(`${LB_URL}/api/chat/conversations`, {
        title: 'via-lb-during-offline',
      });
      expect(viaLb.status).toBe(201);

      // 下线期间连续发一批请求（建会话 / 列会话 / overview），全部经 lb：一个 5xx 都不该有。
      const burstStatuses: number[] = [];
      const burstDeadline = Date.now() + 3_000;
      while (Date.now() < burstDeadline) {
        const [created, listed, ov] = await Promise.all([
          postJson(`${LB_URL}/api/chat/conversations`, { title: 'burst' }),
          request(`${LB_URL}/api/chat/conversations`),
          request(`${LB_URL}/api/console/overview`),
        ]);
        burstStatuses.push(created.status, listed.status, ov.status);
        await sleep(400);
      }
      step('S1', '下线期间经 lb 的一批请求', {
        statuses: burstStatuses.join(','),
      });
      expect(burstStatuses.length).toBeGreaterThan(0);
      expect(burstStatuses.every((status) => status < 500)).toBe(true);

      // 这一轮正常跑完，不是被中止。
      await waitIdle(LB_URL, conversationId);
      const rows = await ledger(LB_URL, conversationId);
      expect(shape(rows)).toEqual([
        ['user', '跑完'],
        ['assistant', 'completed'],
      ]);
      expectCleanSeqs(rows);

      // A 在 窗口 + grace 内自己退出，退出码 0。
      await waitExited(
        node(1).container,
        NORMAL_FINISH_WINDOW_MS + NORMAL_GRACE_MS + 8_000,
      );
      const exitInfo = await containerExitInfo(node(1).container);
      step('S1', 'A 已退出', exitInfo);
      expect(exitInfo.exitCode).toBe(0);

      await waitNodeState(1, 'offline');
    }, 120_000);

    it('场景 2：节点 B 上一轮长于等待窗口 的；下线后到等待窗口结束时刻被中止（ABORT_REASON_SHUTDOWN），B 在 kill 期限前自己退出', async () => {
      const conversationId = await createConversation(node(2).url);
      step('S2', '在节点 2 上起一轮（长于等待窗口）', { conversationId });
      expect(
        mode(await send(node(2).url, conversationId, textFor('中止', 14_000))),
      ).toBe('started');
      await waitActive(LB_URL, conversationId);

      const before = await overview(LB_URL);
      const nodeB = findNode(before, 2);
      expect(nodeB.state).toBe('online');

      const offlineCalledAt = Date.now();
      const ack = await consoleOffline(LB_URL, nodeB.id);
      step('S2', '经控制台 API 下线节点 2', {
        nodeId: nodeB.id,
        status: ack.status,
      });
      expect(ack.status).toBe(202);

      await waitExited(node(2).container, NORMAL_KILL_S * 1_000 + 5_000);
      const exitedAt = Date.now();
      const exitInfo = await containerExitInfo(node(2).container);
      const elapsedMs = exitedAt - offlineCalledAt;
      step('S2', 'B 已退出', { ...exitInfo, elapsedMs });
      // 自己在 kill 期限（15s）之前退出，不是被强杀——这是它跟场景 3 的分野。
      expect(exitInfo.exitCode).toBe(0);
      expect(elapsedMs).toBeLessThan(NORMAL_KILL_S * 1_000);
      // 到 等待窗口（8s）才中止，不是一收到下线信号就立刻中止。
      expect(elapsedMs).toBeGreaterThanOrEqual(NORMAL_FINISH_WINDOW_MS - 1_000);

      const rows = await ledger(LB_URL, conversationId);
      expect(shape(rows)).toEqual([
        ['user', '中止'],
        ['assistant', 'interrupted'],
      ]);
      expect(rows[1]?.reason).toBe(ABORT_REASON_SHUTDOWN);
      expectCleanSeqs(rows);

      await waitNodeState(2, 'offline');
    }, 60_000);

    it('场景 4：重新上线场景 1 里下线的节点；它重新健康、overview 变 online，新会话能落到它上面', async () => {
      const before = await overview(LB_URL);
      const nodeA = findNode(before, 1);
      expect(nodeA.state).toBe('offline');

      const ack = await consoleOnline(LB_URL, nodeA.id);
      step('S4', '重新上线节点 1', { nodeId: nodeA.id, status: ack.status });
      expect(ack.status).toBe(202);

      // `docker start` 拉起同一个容器，id/hostname 不变，但宿主机端口是重新随机分配的
      // （`ports: ["3900"]` 没写死），跟 `cluster.e2e.test.ts` 里「重启过的容器要重新
      // discover」是同一条坑：先等它真的 running，再问一遍新端口，不能沿用旧的 `node(1).url`。
      await waitFor(
        async () => (await containerExitInfo(node(1).container)).running,
        30_000,
        '节点 1 重新变成 running',
      );
      await discover([1]);
      await waitHealthy(node(1).url);
      await waitNodeState(1, 'online');

      // 新会话能落到它上面：直接打它，起轮、活着的持有者就是它自己。
      const conversationId = await createConversation(node(1).url);
      expect(
        mode(await send(node(1).url, conversationId, textFor('刚上线', 3_000))),
      ).toBe('started');
      await waitActive(LB_URL, conversationId);
      expect((await activity(node(1).url, conversationId))['local']).toBe(true);
      await waitIdle(LB_URL, conversationId);
      expect(shape(await ledger(LB_URL, conversationId))).toEqual([
        ['user', '刚上线'],
        ['assistant', 'completed'],
      ]);
    }, 60_000);

    it('场景 5：WebSocket 连在将被下线节点上的一条连接收到 1012；经 lb 重连能接着看完这一轮', async () => {
      // 复用场景 4 重新上线的节点 1：它这会儿是在线的，再下线一次。
      const conversationId = await createConversation(node(1).url);
      expect(
        mode(await send(node(1).url, conversationId, textFor('直连ws', 4_000))),
      ).toBe('started');
      await waitActive(LB_URL, conversationId);

      const first = watch(node(1).url, conversationId);
      await waitFor(
        () => Promise.resolve(liveText(first.frames) !== ''),
        15_000,
        '直连节点 1 的连接收到直播正文',
      );
      const cursor = Math.max(0, ...frameSeqs(first.frames));
      step('S5', '直连节点 1 的连接已收到直播，现在下线节点 1', {
        conversationId,
        cursor,
      });

      const before = await overview(LB_URL);
      const nodeA = findNode(before, 1);
      const ack = await consoleOffline(LB_URL, nodeA.id);
      expect(ack.status).toBe(202);

      await waitFor(
        () => Promise.resolve(first.closed),
        15_000,
        '节点下线后连接被关闭',
      );
      step('S5', '连接已关闭', { code: first.closeCode });
      // 1012：标准里的「服务重启」（docs/host/node/tech/cluster-console.md §4.2）。
      expect(first.closeCode).toBe(1012);

      // 经 lb 重连，带上游标：这一轮还在跑（等待窗口 8s > 这一轮 4s），应该能接着看到收尾。
      const second = watch(LB_URL, conversationId, cursor);
      try {
        await waitIdle(LB_URL, conversationId);
        await sleep(1_500);
        const rows = await ledger(LB_URL, conversationId);
        expect(shape(rows)).toEqual([
          ['user', '直连ws'],
          ['assistant', 'completed'],
        ]);
        const last = rows.at(-1);
        step('S5', '重连之后收到的帧', {
          conversationId,
          frames: second.frames.length,
          chars: liveText(second.frames).length,
        });
        // 接着看：重连之后收到过收尾那条账本帧（带 seq），不是断在半路。
        expect(frameSeqs(second.frames)).toContain(last?.seq);
      } finally {
        second.close();
      }

      await waitExited(
        node(1).container,
        NORMAL_FINISH_WINDOW_MS + NORMAL_GRACE_MS + 8_000,
      );
      expect((await containerExitInfo(node(1).container)).exitCode).toBe(0);
    }, 60_000);
  },
);

describe.skipIf(!RUN)('集群控制台：强杀（等待窗口远大于 kill）', () => {
  beforeAll(async () => {
    activeEnv = {
      CLUSTER_LB_PORT: String(PORTS.lb),
      CLUSTER_PG_PORT: String(PORTS.pg),
      CLUSTER_REDIS_PORT: String(PORTS.redis),
      CLUSTER_HEARTBEAT_MS: String(HEARTBEAT_MS),
      CLUSTER_TAKEOVER_MS: String(TAKEOVER_MS),
      CLUSTER_FORWARD_TIMEOUT_MS: String(FORWARD_TIMEOUT_MS),
      CLUSTER_CHUNK_DELAY_MS: String(CHUNK_DELAY_MS),
      CLUSTER_OFFLINE_FINISH_WINDOW_MS: String(KILL_FINISH_WINDOW_MS),
      CLUSTER_OFFLINE_GRACE_MS: String(KILL_GRACE_MS),
      CLUSTER_OFFLINE_KILL_S: String(KILL_KILL_S),
      DEEPSEEK_API_BASE_URL: '',
      DEEPSEEK_API_TOKEN: '',
      RUNKO_MODEL: '',
      E2B_API_KEY: '',
      VERCEL_TOKEN: '',
    };
    currentReplicas = 2;
    logDir = createClusterLogDir();
    console.log(
      `\n集群控制台（强杀）的日志：${join(logDir, 'timeline.log')}\n`,
    );
    await compose('down', '-v', '--remove-orphans');
    step('cluster-console-kill', 'starting 2 nodes + ops + lb', {
      finishWindowMs: KILL_FINISH_WINDOW_MS,
      graceMs: KILL_GRACE_MS,
      killS: KILL_KILL_S,
    });
    await scaleTo(2, true);
    await discover([1, 2]);
    await signUp(node(1).url);
    step('cluster-console-kill', 'environment healthy; signed up once');
  }, 10 * 60_000);

  afterEach(async () => {
    await saveLogs();
  }, 120_000);

  afterAll(async () => {
    await compose('down', '-v', '--remove-orphans').catch(() => undefined);
  }, 5 * 60_000);

  it('场景 3：等待窗口远大于 kill；节点 C 上一轮长的；下线后到 kill 期限被 SIGKILL（137），时长约等于 kill 期限', async () => {
    const conversationId = await createConversation(node(1).url);
    step('S3', '在节点 1 上起一轮（远长于 kill）', { conversationId });
    expect(
      mode(await send(node(1).url, conversationId, textFor('强杀', 30_000))),
    ).toBe('started');
    await waitActive(LB_URL, conversationId);

    const before = await overview(LB_URL);
    const nodeC = findNode(before, 1);
    expect(nodeC.state).toBe('online');

    const offlineCalledAt = Date.now();
    const ack = await consoleOffline(LB_URL, nodeC.id);
    step('S3', '经控制台 API 下线节点 1', {
      nodeId: nodeC.id,
      status: ack.status,
    });
    expect(ack.status).toBe(202);

    // 强杀倒计时就是这次调用的 offlineDeadline：约等于 now + kill 秒数。
    expect(ack.offlineDeadline).toBeDefined();
    const deadline = ack.offlineDeadline ?? Number.NaN;
    expect(deadline - offlineCalledAt).toBeGreaterThan(
      KILL_KILL_S * 1_000 - 1_000,
    );
    expect(deadline - offlineCalledAt).toBeLessThan(
      KILL_KILL_S * 1_000 + 1_000,
    );

    await waitExited(node(1).container, KILL_KILL_S * 1_000 + 7_000);
    const exitedAt = Date.now();
    const exitInfo = await containerExitInfo(node(1).container);
    const elapsedMs = exitedAt - offlineCalledAt;
    step('S3', 'C 已退出', { ...exitInfo, elapsedMs });
    // 137 = 128 + 9（SIGKILL）：它没能力在等待窗口结束前自己收尾，只能被强杀。
    expect(exitInfo.exitCode).toBe(137);
    expect(elapsedMs).toBeGreaterThanOrEqual(KILL_KILL_S * 1_000 - 1_500);
    expect(elapsedMs).toBeLessThan(KILL_KILL_S * 1_000 + 6_000);
  }, 60_000);
});
