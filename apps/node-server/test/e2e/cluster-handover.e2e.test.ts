/**
 * **[交权](../../../../docs/terms.md)的集群端到端**：真容器、真 Postgres、真 Redis、nginx 统一入口。
 * 按功能手册 docs/logic/orchestration/features/handover.md §5 的成功标准逐条验，断言一律落在账本上。
 *
 * | 场景 | 部署顺序 | 验什么 |
 * |---|---|---|
 * | A | 先启再停，三个老副本滚动换成三个新副本 | §5 第 1–5 条：没有「已中断」、请求没有 503、账本序号干净、每份对话最多迁移一次、命令跑完、关了页面也跑完、重连够快 |
 * | B | 先停再启分批：同一批两个副本一起下线 | §5 第 7 条：对话落到存活的副本上 |
 * | C | 单副本先停再启：一个存活副本都没有 | 待接手：新进程起来后接着跑完 |
 *
 * §5 第 6 条（接手节点在答应之前挂掉、预留过期后被定时回捞接走）在容器里造不出确定的时序，
 * 由 `@runko/agent` 的单测与仲裁一致性套件钉住（见施工文档 H7 的验收记录）。
 *
 * **门禁**：`RUNKO_TEST_CLUSTER=1` 才跑（`pnpm test:cluster-handover`）。自带起停，独立项目名与端口。
 * 日志在 `apps/node-server/logs/cluster-handover-<时间>/`。
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

import { LOGS_ROOT, mergeTimeline } from '../../scripts/lab-logs.js';
import { formatLogLine } from '../../src/logger.js';

const RUN = process.env.RUNKO_TEST_CLUSTER === '1';
const PROJECT = 'runko-cluster-handover-e2e';
const COMPOSE_FILE = fileURLToPath(
  new URL('../../docker/cluster.compose.yml', import.meta.url),
);
/** 独立端口：跟手动起的那套（3940）与另外两份集群测试（3960 / 3980）都错开。 */
const PORTS = { lb: 4000, pg: 55503, redis: 56409 } as const;
const LB_URL = `http://127.0.0.1:${String(PORTS.lb)}`;
const ORIGIN = `http://localhost:${String(PORTS.lb)}`;
const CHUNK_DELAY_MS = 300;
/** 交权那一刻还在跑的命令要跑多久——它必须完整跑完、结果照常出现（§5 第 3 条的缩短版）。 */
const LONG_COMMAND_S = 20;

const ENV: Record<string, string> = {
  CLUSTER_LB_PORT: String(PORTS.lb),
  CLUSTER_PG_PORT: String(PORTS.pg),
  CLUSTER_REDIS_PORT: String(PORTS.redis),
  CLUSTER_HEARTBEAT_MS: '1000',
  CLUSTER_TAKEOVER_MS: '5000',
  CLUSTER_FORWARD_TIMEOUT_MS: '2000',
  CLUSTER_CHUNK_DELAY_MS: String(CHUNK_DELAY_MS),
  CLUSTER_MEMORY_WINDOW_MS: '3000',
  CLUSTER_TOOL_TIMEOUT_MS: '60000',
  CLUSTER_OFFLINE_GRACE_MS: '10000',
  CLUSTER_RELEASE_SEQ: '1',
  CLUSTER_NEXT_RELEASE_SEQ: '2',
  // 演示模型：不联网、不花钱，时间可控。
  DEEPSEEK_API_BASE_URL: '',
  DEEPSEEK_API_TOKEN: '',
};

const run = promisify(execFile);

async function docker(args: readonly string[]): Promise<string> {
  const { stdout } = await run('docker', [...args], {
    env: { ...process.env, ...ENV },
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

const compose = (...args: string[]): Promise<string> =>
  docker([
    'compose',
    '-p',
    PROJECT,
    '-f',
    COMPOSE_FILE,
    '--profile',
    'release',
    ...args,
  ]);

/** 某个服务此刻全部容器的名字（按编号排好）。 */
async function containersOf(service: 'node' | 'node-next'): Promise<string[]> {
  const out = await docker([
    'ps',
    '-a',
    '--filter',
    `label=com.docker.compose.project=${PROJECT}`,
    '--filter',
    `label=com.docker.compose.service=${service}`,
    '--format',
    '{{.Names}}',
  ]);
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .sort();
}

/** 容器的 hostname——它就是租约里的 `holder`（`http://<hostname>:3900`）。 */
async function holderOf(container: string): Promise<string> {
  const hostname = (
    await docker(['inspect', '-f', '{{.Config.Hostname}}', container])
  ).trim();
  return `http://${hostname}:3900`;
}

/** `docker stop`：阻塞到容器退出，返回用时与退出码。 */
async function stopNode(
  container: string,
  timeoutS = 120,
): Promise<{ ms: number; exitCode: number }> {
  const started = Date.now();
  await docker(['stop', '-t', String(timeoutS), container]);
  const exitCode = Number(
    (await docker(['inspect', '-f', '{{.State.ExitCode}}', container])).trim(),
  );
  return { ms: Date.now() - started, exitCode };
}

// ─── 日志 ──────────────────────────────────────────────────────────────────

let logDir: string | undefined;

function createLogDir(): string {
  const stamp = new Date().toISOString().slice(0, 19).replaceAll(':', '-');
  const dir = join(LOGS_ROOT, `cluster-handover-${stamp}`);
  mkdirSync(dir, { recursive: true });
  const latest = join(LOGS_ROOT, 'cluster-handover-latest');
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
    `${formatLogLine({ at: new Date(), node: 'test', level: 'STEP', scope: scenario, message, fields })}\n`,
  );
}

async function saveLogs(): Promise<void> {
  const dir = logDir;
  if (dir === undefined) {
    return;
  }
  const sources: string[] = [];
  for (const container of [
    ...(await containersOf('node')),
    ...(await containersOf('node-next')),
  ]) {
    const text_ = await docker(['logs', container]).catch(() => undefined);
    if (text_ === undefined) {
      continue;
    }
    writeFileSync(
      join(dir, `${container.replace(`${PROJECT}-`, '')}.log`),
      text_,
    );
    sources.push(text_);
  }
  for (const service of ['lb', 'postgres', 'redis']) {
    const text_ = await compose(
      'logs',
      '--no-color',
      '--no-log-prefix',
      service,
    ).catch(() => undefined);
    if (text_ !== undefined) {
      writeFileSync(join(dir, `${service}.log`), text_);
    }
  }
  const testLog = join(dir, 'test.log');
  if (existsSync(testLog)) {
    sources.push(readFileSync(testLog, 'utf8'));
  }
  writeFileSync(join(dir, 'timeline.log'), mergeTimeline(sources));
}

// ─── JSON 边界 ─────────────────────────────────────────────────────────────

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

function parseJson(raw: string): Json {
  const parsed: Json = JSON.parse(raw);
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
}

let cookie = '';

async function request(url: string, init: RequestInit = {}): Promise<Reply> {
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
  return { status: res.status, body: raw === '' ? null : parseJson(raw) };
}

const postJson = (url: string, payload: JsonObject): Promise<Reply> =>
  request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

async function signUp(): Promise<void> {
  const res = await fetch(`${LB_URL}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({
      email: `cluster-handover-${String(Date.now())}@example.com`,
      password: 'cluster-handover-password-1234',
      name: 'cluster-handover',
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

async function createConversation(title: string): Promise<string> {
  const reply = await postJson(`${LB_URL}/api/chat/conversations`, { title });
  const id = text(field(reply.body, 'id'));
  if (id === undefined) {
    throw new Error(`建会话失败：${JSON.stringify(reply.body)}`);
  }
  return id;
}

async function send(id: string, message: string): Promise<string | undefined> {
  const reply = await postJson(
    `${LB_URL}/api/chat/conversations/${id}/messages`,
    { text: message },
  );
  if (reply.status !== 202) {
    throw new Error(
      `发消息失败：${String(reply.status)} ${JSON.stringify(reply.body)}`,
    );
  }
  return text(field(reply.body, 'mode'));
}

async function activity(
  id: string,
): Promise<{ active: boolean; holder: string | undefined }> {
  const reply = await request(
    `${LB_URL}/api/chat/conversations/${id}/activity`,
  );
  return {
    active: field(reply.body, 'active') === true,
    holder: text(field(reply.body, 'holder')),
  };
}

interface LedgerRow {
  seq: number;
  role: string;
  text: string;
  status: string | undefined;
  raw: string;
}

async function ledger(id: string): Promise<LedgerRow[]> {
  const reply = await request(
    `${LB_URL}/api/chat/conversations/${id}/messages`,
  );
  const frames = field(reply.body, 'frames');
  if (!Array.isArray(frames)) {
    throw new Error(`账本读不出来：${JSON.stringify(reply.body)}`);
  }
  return frames.map((frame) => {
    const message = field(frame, 'message');
    const parts = field(message, 'parts');
    const seq = field(frame, 'seq');
    return {
      seq: typeof seq === 'number' ? seq : Number.NaN,
      role: text(field(message, 'role')) ?? '',
      text:
        Array.isArray(parts) ?
          parts.map((part) => text(field(part, 'text')) ?? '').join('')
        : '',
      status: text(field(field(message, 'metadata'), 'status')),
      raw: JSON.stringify(message),
    };
  });
}

/** 按消息 id 折叠（恢复轮原地改写，同 id 出现两次时以后一次为准）。 */
function folded(rows: readonly LedgerRow[]): LedgerRow[] {
  const byId = new Map<string, LedgerRow>();
  for (const row of rows) {
    const id = text(field(parseJson(row.raw), 'id')) ?? String(row.seq);
    byId.set(id, row);
  }
  return [...byId.values()];
}

/** 账本序号不重、升序。 */
function expectCleanSeqs(rows: readonly LedgerRow[]): void {
  const seqs = rows.map((row) => row.seq);
  expect(new Set(seqs).size).toBe(seqs.length);
  expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
}

/** 这份对话被迁移了几次 = 账本里有几条「已交权」收尾。 */
const migrations = (rows: readonly LedgerRow[]): number =>
  folded(rows).filter((row) => row.status === 'handed-over').length;

/** 一条让演示模型大致跑 `turnMs` 的消息。 */
function textFor(label: string, turnMs: number): string {
  return `${label}${'字'.repeat(Math.ceil(turnMs / CHUNK_DELAY_MS) * 12)}`;
}

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
    await sleep(300);
  }
}

/** 这份对话安静下来了：没有轮在跑，最后一条是某个收尾状态。 */
async function waitSettled(
  id: string,
  statuses: readonly string[],
  timeoutMs: number,
): Promise<LedgerRow[]> {
  let rows: LedgerRow[] = [];
  await waitFor(
    async () => {
      if ((await activity(id)).active) {
        return false;
      }
      rows = folded(await ledger(id));
      const last = rows.at(-1);
      return last?.role === 'assistant' && statuses.includes(last.status ?? '');
    },
    timeoutMs,
    `${id} 收尾成 ${statuses.join('/')}`,
  );
  return rows;
}

// ─── 跟着请重连帧走的 SSE 客户端（浏览器的做法） ─────────────────────────────

interface SseWatcher {
  /** 每次重连：收到请重连帧的时刻 → 新连接第一帧的时刻。 */
  readonly reconnects: { gapMs: number }[];
  readonly text: string;
  stop(): Promise<void>;
}

function parseSseEvents(buffer: string): {
  events: { event: string; data: string }[];
  rest: string;
} {
  const blocks = buffer.split('\n\n');
  const rest = blocks.pop() ?? '';
  const events = blocks
    .map((block) => {
      const lines = block.split('\n');
      const event =
        lines
          .find((line) => line.startsWith('event: '))
          ?.slice('event: '.length) ?? 'message';
      const data =
        lines
          .find((line) => line.startsWith('data: '))
          ?.slice('data: '.length) ?? '';
      return { event, data };
    })
    .filter((entry) => entry.data !== '');
  return { events, rest };
}

function watchSse(id: string): SseWatcher {
  const reconnects: { gapMs: number }[] = [];
  let collected = '';
  let lastSeq = 0;
  let stopped = false;
  const controller = new AbortController();

  const loop = (async () => {
    let reconnectAskedAt: number | undefined;
    while (!stopped) {
      let sawReconnect = false;
      let turnEnded = false;
      try {
        const res = await fetch(
          `${LB_URL}/api/chat/conversations/${id}/stream?after=${String(lastSeq)}`,
          {
            headers: { cookie, origin: ORIGIN },
            signal: controller.signal,
          },
        );
        if (res.body === null || !res.ok) {
          await sleep(250);
          continue;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          const parsed = parseSseEvents(buffer);
          buffer = parsed.rest;
          for (const { event, data } of parsed.events) {
            if (reconnectAskedAt !== undefined) {
              reconnects.push({ gapMs: Date.now() - reconnectAskedAt });
              reconnectAskedAt = undefined;
            }
            const frame = parseJson(data);
            const seq = field(frame, 'seq');
            if (typeof seq === 'number') {
              lastSeq = Math.max(lastSeq, seq);
            }
            const chunk = field(frame, 'chunk');
            if (text(field(chunk, 'type')) === 'text-delta') {
              collected += text(field(chunk, 'delta')) ?? '';
            }
            if (event === 'reconnect') {
              sawReconnect = true;
            }
            if (
              event === 'turn-state' &&
              field(frame, 'turnActive') === false
            ) {
              turnEnded = true;
            }
          }
        }
      } catch {
        if (stopped) {
          return;
        }
      }
      if (sawReconnect) {
        // 请重连帧：立刻重连（浏览器也是这么做的），计时从这一刻开始。
        reconnectAskedAt = Date.now();
        continue;
      }
      if (turnEnded) {
        return;
      }
      await sleep(250);
    }
  })();

  return {
    reconnects,
    get text() {
      return collected;
    },
    async stop() {
      stopped = true;
      controller.abort();
      await loop.catch(() => undefined);
    },
  };
}

// ─── 用例 ──────────────────────────────────────────────────────────────────

describe.skipIf(!RUN)('交权：集群端到端', () => {
  beforeAll(async () => {
    logDir = createLogDir();
    await compose('down', '-v', '--remove-orphans').catch(() => undefined);
    await compose(
      'up',
      '-d',
      '--wait',
      '--build',
      '--scale',
      'node=3',
      'node',
      'lb',
    );
    await signUp();
    step('setup', 'cluster up', {
      nodes: (await containersOf('node')).join(','),
    });
  }, 600_000);

  afterEach(async () => {
    await saveLogs().catch(() => undefined);
  });

  afterAll(async () => {
    await saveLogs().catch(() => undefined);
    await compose('down', '-v', '--remove-orphans').catch(() => undefined);
  }, 120_000);

  it('A 先启再停滚动发布：模型输出、命令、等人、排队四种对话都不中断，命令跑完，请求没有 503，每份对话最多迁移一次，重连够快', async () => {
    const cModel = await createConversation('model');
    const cTool = await createConversation('tool');
    const cAsk = await createConversation('ask');
    const cQueue = await createConversation('queue');

    expect(await send(cModel, textFor('模型', 40_000))).toBe('started');
    // 关了页面：这份对话从头到尾没人看着（§5 第 4 条）。
    expect(
      await send(
        cTool,
        `run: sleep ${String(LONG_COMMAND_S)} && echo tool-finished`,
      ),
    ).toBe('started');
    expect(await send(cAsk, 'ask: 要继续吗？')).toBe('started');
    expect(await send(cQueue, textFor('排队一', 30_000))).toBe('started');
    expect(await send(cQueue, '排队二')).toBe('queued');
    step('A', 'four conversations started', { cModel, cTool, cAsk, cQueue });

    const watcher = watchSse(cModel);
    // 压测环：发布期间不停地经 nginx 请求，记下任何非 2xx（§5 第 1 条：没有一个请求拿到 503）。
    const failures: string[] = [];
    let loadRunning = true;
    const load = (async () => {
      while (loadRunning) {
        for (const id of [cModel, cTool, cAsk, cQueue]) {
          const reply = await request(
            `${LB_URL}/api/chat/conversations/${id}/activity`,
          ).catch((error: unknown) => ({
            status: 0,
            body: String(error),
          }));
          if (reply.status < 200 || reply.status >= 300) {
            failures.push(
              `${String(reply.status)} ${JSON.stringify(reply.body)}`,
            );
          }
        }
        await sleep(200);
      }
    })();

    await sleep(4_000); // 让命令真的跑起来、等人的那一轮进入等人
    const oldNodes = await containersOf('node');
    await compose(
      'up',
      '-d',
      '--wait',
      '--no-recreate',
      '--scale',
      'node-next=3',
      'node-next',
    );
    step('A', 'new release is up', {
      next: (await containersOf('node-next')).join(','),
    });

    for (const container of oldNodes) {
      const result = await stopNode(container);
      step('A', 'old node stopped', {
        container,
        ms: result.ms,
        exitCode: result.exitCode,
      });
      expect(result.exitCode).toBe(0);
    }

    const modelRows = await waitSettled(cModel, ['completed'], 120_000);
    const toolRows = await waitSettled(cTool, ['completed'], 120_000);
    const queueRows = await waitSettled(cQueue, ['completed'], 120_000);

    // 等人的那一轮挂起了，人回来在新节点上答。
    const askRows = folded(await ledger(cAsk));
    const askCall = /"toolCallId":"([^"]+)"/u.exec(
      askRows.at(-1)?.raw ?? '',
    )?.[1];
    expect(askCall).toBeDefined();
    const answered = await postJson(
      `${LB_URL}/api/chat/conversations/${cAsk}/questions/${askCall ?? ''}`,
      { answer: '继续' },
    );
    expect(answered.status).toBe(200);
    const askFinal = await waitSettled(cAsk, ['completed'], 60_000);

    loadRunning = false;
    await load;
    await watcher.stop();

    for (const rows of [modelRows, toolRows, queueRows, askFinal]) {
      expect(rows.filter((row) => row.status === 'interrupted')).toEqual([]);
      expect(migrations(rows)).toBeLessThanOrEqual(1);
    }
    for (const id of [cModel, cTool, cAsk, cQueue]) {
      expectCleanSeqs(await ledger(id));
    }
    // 命令完整跑完，结果照常出现（它在旧节点上跑完、由新节点结清）。
    expect(toolRows.some((row) => row.raw.includes('tool-finished'))).toBe(
      true,
    );
    // 排队的两条按原顺序都跑完了。
    expect(
      queueRows
        .filter((row) => row.role === 'user')
        .map((row) => row.text.replace(/字+$/u, '')),
    ).toEqual(['排队一', '排队二']);
    expect(failures).toEqual([]);
    // 看着的那一份：收到过请重连帧，重连到新节点收到第一帧用时在 2 秒以内（§5 第 5 条）。
    step('A', 'reconnects', {
      gaps: watcher.reconnects.map((entry) => entry.gapMs).join(','),
    });
    expect(watcher.reconnects.length).toBeGreaterThanOrEqual(1);
    for (const { gapMs } of watcher.reconnects) {
      expect(gapMs).toBeLessThan(2_000);
    }
  }, 600_000);

  it('B 先停再启分批：同一批两个副本一起下线，对话落到存活的副本上', async () => {
    const survivors = await containersOf('node-next');
    expect(survivors.length).toBeGreaterThanOrEqual(3);
    const id = await createConversation('batch');
    expect(await send(id, textFor('分批', 30_000))).toBe('started');
    await waitFor(
      async () => (await activity(id)).active,
      20_000,
      'batch 起轮',
    );
    const holder = (await activity(id)).holder;
    const holders = await Promise.all(
      survivors.map(async (container) => ({
        container,
        holder: await holderOf(container),
      })),
    );
    const owner = holders.find((entry) => entry.holder === holder);
    expect(owner).toBeDefined();
    const others = holders.filter((entry) => entry.holder !== holder);
    const peer = others[0];
    const survivor = others[1];
    if (owner === undefined || peer === undefined || survivor === undefined) {
      throw new Error('副本不够');
    }
    step('B', 'stopping a batch of two', {
      owner: owner.container,
      peer: peer.container,
      survivor: survivor.container,
    });

    await Promise.all([stopNode(owner.container), stopNode(peer.container)]);
    const rows = await waitSettled(id, ['completed'], 120_000);
    expect(rows.filter((row) => row.status === 'interrupted')).toEqual([]);
    expect(migrations(rows)).toBeLessThanOrEqual(2);
    expectCleanSeqs(await ledger(id));

    // 收尾那一轮是存活的副本跑的：它的日志里有这份对话的「接着跑」。
    const survivorLog = await docker(['logs', survivor.container]);
    expect(survivorLog).toContain(id);
  }, 300_000);

  it('C 单副本先停再启：挑不到接手节点就标待接手，新进程起来后接着跑完', async () => {
    const remaining = [];
    for (const container of await containersOf('node-next')) {
      const running =
        (
          await docker(['inspect', '-f', '{{.State.Running}}', container])
        ).trim() === 'true';
      if (running) {
        remaining.push(container);
      }
    }
    // 只留一个副本。
    for (const container of remaining.slice(1)) {
      await stopNode(container);
    }
    const last = remaining[0];
    if (last === undefined) {
      throw new Error('没有存活的副本');
    }
    const id = await createConversation('alone');
    expect(await send(id, textFor('独苗', 20_000))).toBe('started');
    await waitFor(
      async () => (await activity(id)).active,
      20_000,
      'alone 起轮',
    );
    await sleep(2_000);
    const stopped = await stopNode(last);
    step('C', 'last node stopped', { ms: stopped.ms });
    expect(stopped.exitCode).toBe(0);

    await docker(['start', last]);
    await waitFor(
      async () => (await fetch(`${LB_URL}/health`)).ok,
      60_000,
      '新进程起来',
    );
    const rows = await waitSettled(id, ['completed'], 120_000);
    expect(rows.filter((row) => row.status === 'interrupted')).toEqual([]);
    expect(migrations(rows)).toBe(1);
  }, 300_000);
});
