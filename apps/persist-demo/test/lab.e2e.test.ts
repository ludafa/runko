/**
 * **[多副本验证环境](../../../docs/terms.md)的端到端**：三个真容器、一个真 Postgres、真网络故障。
 *
 * `multi-replica.e2e.test.ts` 用「几个进程共用一个 SQLite 文件」证明了多副本的核心路径；这里把
 * 同一件事搬到跨容器 + 真 Postgres 上，并补上那边做不到的两种故障：**网络分区**（进程活着、连不上库）
 * 与**数据库卡顿**。场景清单与断言依据见 docs/host/node/tech/multi-replica.md §11.4。
 *
 * **门禁**：没设 `RUNKO_TEST_LAB=1` 整个文件跳过——要 Docker、要构建镜像，不进 `pnpm test` 与 CI。
 *
 *   pnpm --filter @runko-demo/persist-demo test:lab
 *
 * **自带起停、跑完即退**：独立项目名 + 独立端口，不碰手动起着的那套；`afterAll` 一律 `down -v`。
 *
 * **断言落在账本与租约表上**，不落在日志上——「没写坏」只有账本能证明。
 *
 * **日志留在本地**：`apps/persist-demo/logs/lab-<时间>/`（`lab-latest` 指向最近一次）。每个场景的关键步骤写进
 * `test.log`，每个场景结束都把各容器日志收一次、合并成 `timeline.log`——想看核心路径怎么走的，读那一份。
 */
import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describeError } from "@runko/agent";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { collectLabLogs, createLogDir } from "../scripts/lab-logs.js";
import { formatLogLine } from "../src/logger.js";

const RUN = process.env["RUNKO_TEST_LAB"] === "1";
const PROJECT = "runko-lab-e2e";
const COMPOSE_FILE = fileURLToPath(new URL("../docker/compose.yml", import.meta.url));

/** 与 compose.yml 的缺省值一致，写在这里是为了断言里要用。 */
const HEARTBEAT_MS = 1_000;
const TAKEOVER_MS = 5_000;
const TURN_MS = 10_000;
const FORWARD_TIMEOUT_MS = 2_000;

const PORTS = { lb: 3940, a: 3941, b: 3942, c: 3943, pg: 55443 } as const;

const LAB_ENV = {
  LAB_LB_PORT: String(PORTS.lb),
  LAB_A_PORT: String(PORTS.a),
  LAB_B_PORT: String(PORTS.b),
  LAB_C_PORT: String(PORTS.c),
  LAB_PG_PORT: String(PORTS.pg),
  LAB_HEARTBEAT_MS: String(HEARTBEAT_MS),
  LAB_TAKEOVER_MS: String(TAKEOVER_MS),
  LAB_TURN_MS: String(TURN_MS),
  LAB_FORWARD_TIMEOUT_MS: String(FORWARD_TIMEOUT_MS),
};

type ServiceName = "replica-a" | "replica-b" | "replica-c";

interface Replica {
  service: ServiceName;
  /** 从宿主机打它用的地址。 */
  url: string;
  /** 它写进租约表的 holder——容器网络里的地址。 */
  holder: string;
}

const A: Replica = { service: "replica-a", url: `http://127.0.0.1:${String(PORTS.a)}`, holder: "http://replica-a:3910" };
const B: Replica = { service: "replica-b", url: `http://127.0.0.1:${String(PORTS.b)}`, holder: "http://replica-b:3910" };
const C: Replica = { service: "replica-c", url: `http://127.0.0.1:${String(PORTS.c)}`, holder: "http://replica-c:3910" };
const LB_URL = `http://127.0.0.1:${String(PORTS.lb)}`;

/** 与 `@runko/agent` 的 `ABORT_REASON_HOLDER_LOST` / `ABORT_REASON_SHUTDOWN` 同一份文案（demo 不直接依赖它们）。 */
const HOLDER_LOST = "another node took over";
const SHUTDOWN = "shutting down";

// ─── docker ────────────────────────────────────────────────────────────────

const run = promisify(execFile);

async function docker(args: readonly string[]): Promise<string> {
  const { stdout } = await run("docker", [...args], {
    env: { ...process.env, ...LAB_ENV },
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

const compose = (...args: string[]): Promise<string> => docker(["compose", "-p", PROJECT, "-f", COMPOSE_FILE, ...args]);
const containerOf = (service: ServiceName): string => `${PROJECT}-${service}-1`;
const DB_NETWORK = `${PROJECT}_db`;

// ─── 日志 ──────────────────────────────────────────────────────────────────

/** 本次运行的日志目录；`beforeAll` 里建。 */
let logDir: string | undefined;

/**
 * 记一个测试步骤。与副本日志同一个行格式（`node` 列是 `test`，级别列是 `STEP`），所以能合并进同一条时间线。
 * 值得记的是「做了什么」和「拿到了什么」——读时间线时，它们是副本日志的锚点。
 */
function step(scenario: string, message: string, fields?: Record<string, string | number | boolean | undefined>): void {
  if (logDir === undefined) {return;}
  appendFileSync(
    join(logDir, "test.log"),
    `${formatLogLine({ at: new Date(), node: "test", level: "STEP", scope: scenario, message, fields })}\n`,
  );
}

async function saveLogs(): Promise<void> {
  if (logDir === undefined) {return;}
  await collectLabLogs({ dir: logDir, project: PROJECT, composeFile: COMPOSE_FILE, env: { ...process.env, ...LAB_ENV } }).catch(
    (error: unknown) => {
      step("lab", "collecting container logs failed", { error: describeError(error) });
    },
  );
}

// ─── JSON 边界 ─────────────────────────────────────────────────────────────

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

/**
 * **序列化边界**：`Response.json()` / `JSON.parse` 的类型是 `any`，在这里一次性落成 JSON 值类型，
 * 后面的断言全靠类型守卫收窄，不再出现 `any` 与 `as`。
 */
function parseJson(text: string): Json {
  const parsed: Json = JSON.parse(text);
  return parsed;
}

const isObject = (value: Json | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function field(value: Json | undefined, key: string): Json | undefined {
  return isObject(value) ? value[key] : undefined;
}

function text(value: Json | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

// ─── HTTP ──────────────────────────────────────────────────────────────────

interface Reply {
  status: number;
  body: Json;
  ms: number;
  retryAfter: string | null;
}

async function request(url: string, init: RequestInit = {}): Promise<Reply> {
  const started = Date.now();
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const raw = await res.text();
  return {
    status: res.status,
    body: raw === "" ? null : parseJson(raw),
    ms: Date.now() - started,
    retryAfter: res.headers.get("retry-after"),
  };
}

const postJson = (url: string, payload: JsonObject): Promise<Reply> =>
  request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });

async function createConversation(replica: Replica): Promise<string> {
  const reply = await postJson(`${replica.url}/api/chat/conversations`, { title: "lab" });
  const id = text(field(reply.body, "id"));
  if (id === undefined) {throw new Error(`建会话失败：${JSON.stringify(reply.body)}`);}
  return id;
}

const send = (replica: Replica, id: string, message: string): Promise<Reply> =>
  postJson(`${replica.url}/api/chat/conversations/${id}/messages`, { text: message });

async function activity(replica: Replica, id: string): Promise<JsonObject> {
  const reply = await request(`${replica.url}/api/chat/conversations/${id}/activity`);
  if (!isObject(reply.body)) {throw new Error(`activity 不是对象：${JSON.stringify(reply.body)}`);}
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
  const reply = await request(`${replica.url}/api/chat/conversations/${id}/messages`);
  const frames = field(reply.body, "frames");
  if (!Array.isArray(frames)) {throw new Error(`账本读不出来：${JSON.stringify(reply.body)}`);}
  return frames.map((frame) => {
    const message = field(frame, "message");
    const seq = field(frame, "seq");
    const parts = field(message, "parts");
    const metadata = field(message, "metadata");
    return {
      seq: typeof seq === "number" ? seq : Number.NaN,
      role: text(field(message, "role")) ?? "",
      text: Array.isArray(parts) ? text(field(parts[0], "text")) : undefined,
      status: text(field(metadata, "status")),
      reason: text(field(field(metadata, "error"), "message")),
    };
  });
}

/** 账本没写坏的最低要求：seq 唯一且递增。 */
function expectCleanSeqs(rows: readonly LedgerRow[]): void {
  const seqs = rows.map((row) => row.seq);
  expect(new Set(seqs).size).toBe(seqs.length);
  expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
}

// ─── 时间 ──────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check().catch(() => false)) {return;}
    if (Date.now() > deadline) {throw new Error(`等超时了：${what}`);}
    await sleep(200);
  }
}

/**
 * 把被 `kill -9` 的副本拉起来。**用 `start` 不用 `up`**：`up` 会重建容器，旧容器的日志随之消失，
 * 时间线里这个副本被杀之前的那一段就全没了。`start` 拉起的是同一个容器，前后两段日志都在。
 * `start` 不等健康检查，所以自己等 `/health`——`recover()` 跑在开始服务之前，健康了就说明扫描做完了。
 */
async function restart(replica: Replica): Promise<void> {
  await compose("start", replica.service);
  await waitFor(async () => (await fetch(`${replica.url}/health`)).ok, 60_000, `${replica.service} 重新健康`);
}

const waitActive = (replica: Replica, id: string): Promise<void> =>
  waitFor(async () => (await activity(replica, id))["active"] === true, 15_000, `${replica.service} 上 ${id} 起轮`);

const waitIdle = (replica: Replica, id: string, timeoutMs = 45_000): Promise<void> =>
  waitFor(async () => (await activity(replica, id))["active"] === false, timeoutMs, `${replica.service} 上 ${id} 收尾`);

interface TurnStateEvent {
  frame: Json;
  /** 收到这一帧的时刻（`Date.now()`）。 */
  at: number;
}

/**
 * 订阅一条 SSE，逐帧吐出 `turn-state`。**时刻是这里要证的东西**：缓冲过的代理要等一轮跑完才吐
 * 第一个字节；一轮是不是「自己停的」要看停下来的那一帧比模型该跑完的时刻早多少。
 */
async function* turnStates(url: string, signal: AbortSignal): AsyncGenerator<TurnStateEvent> {
  const res = await fetch(url, { signal });
  const body = res.body;
  if (body === null) {throw new Error("SSE 没有响应体");}
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {return;}
    buffer += decoder.decode(value, { stream: true });
    // SSE 事件以空行分隔；最后一段可能还没收全，留到下一次。
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const event of events) {
      const match = /^event: turn-state\ndata: (.+)$/m.exec(event);
      const data = match?.[1];
      if (data !== undefined) {yield { frame: parseJson(data), at: Date.now() };}
    }
  }
}

/** 第一帧 `turn-state` 与它花了多久。 */
async function firstTurnState(url: string): Promise<{ frame: Json; ms: number }> {
  const controller = new AbortController();
  const started = Date.now();
  try {
    for await (const event of turnStates(url, controller.signal)) {
      return { frame: event.frame, ms: event.at - started };
    }
    throw new Error("流结束了还没等到 turn-state");
  } finally {
    controller.abort();
  }
}

// ─── 数据库 ────────────────────────────────────────────────────────────────

/** `beforeAll` 失败时它从没被赋值，而 vitest 照样会跑 `afterAll`——所以是可空的。 */
let pool: Pool | undefined;

async function leaseHolder(id: string): Promise<string | null | undefined> {
  if (pool === undefined) {throw new Error("数据库连接还没建好");}
  const result = await pool.query<{ holder: string | null }>(
    "SELECT holder FROM agent_leases WHERE conversation_id = $1",
    [id],
  );
  return result.rows[0]?.holder;
}

// ─── 用例 ──────────────────────────────────────────────────────────────────

describe.skipIf(!RUN)("多副本验证环境：三个容器 + 真 Postgres + 真故障", () => {
  beforeAll(async () => {
    logDir = createLogDir();
    // 一开始就打出来：跑的过程中就能 `tail -f` 看。
    console.log(`\n多副本验证环境的日志：${join(logDir, "timeline.log")}\n`);
    // 上次跑崩了留下的同名残留先清掉。
    await compose("down", "-v", "--remove-orphans");
    step("lab", "building image and starting postgres + 3 replicas + nginx");
    await compose("up", "-d", "--build", "--wait");
    step("lab", "environment healthy");
    pool = new Pool({
      host: "127.0.0.1",
      port: PORTS.pg,
      user: "runko",
      password: "runko",
      database: "runko",
    });
  }, 15 * 60_000);

  // 每个场景结束都收一次：测试中途失败或被 Ctrl+C，目录里也留着「到上一个场景为止」的完整日志。
  afterEach(async () => {
    await saveLogs();
  }, 60_000);

  afterAll(async () => {
    await saveLogs();
    if (logDir !== undefined) {console.log(`\n多副本验证环境的日志：${join(logDir, "timeline.log")}\n`);}
    await pool?.end().catch(() => undefined);
    // 冻住的容器 `down` 删不掉，先解冻；断开的网络 `down` 会一起删，不用接回去。
    for (const service of ["replica-a", "replica-b", "replica-c", "postgres"] as const) {
      await compose("unpause", service).catch(() => undefined);
    }
    await compose("down", "-v", "--remove-orphans");
  }, 5 * 60_000);

  it("S1 并发抢占：同时打到两个副本，只有一个起轮，另一个经转发排队", async () => {
    const id = await createConversation(A);
    step("S1", "同时往 A、B 发同一份对话", { conversationId: id });
    const [fromA, fromB] = await Promise.all([send(A, id, "甲"), send(B, id, "乙")]);
    step("S1", "两边都回了", {
      conversationId: id,
      a: `${String(fromA.status)} ${text(field(fromA.body, "mode")) ?? ""} ${String(fromA.ms)}ms`,
      b: `${String(fromB.status)} ${text(field(fromB.body, "mode")) ?? ""} ${String(fromB.ms)}ms`,
    });

    expect([fromA.status, fromB.status]).toEqual([202, 202]);
    expect([text(field(fromA.body, "mode")), text(field(fromB.body, "mode"))].sort()).toEqual(["queued", "started"]);
    // 租约表里只有一个持有者，而且是两个副本之一。
    expect([A.holder, B.holder]).toContain(await leaseHolder(id));

    // 两轮都跑完：排队的那条由持有者收尾时自动出队。
    await waitFor(async () => (await ledger(C, id)).filter((row) => row.role === "user").length === 2, 30_000, "第二条出队起轮");
    await waitIdle(C, id);
    const rows = await ledger(C, id);
    step("S1", "两轮都跑完", { conversationId: id, ledgerRows: rows.length });
    expect(rows.filter((row) => row.role === "user").map((row) => row.text).sort()).toEqual(["乙", "甲"]);
    expectCleanSeqs(rows);
  }, 90_000);

  it("S2 SSE：经非持有者、经 nginx 订阅，第一帧在一轮跑完之前就到", async () => {
    const id = await createConversation(B);
    expect(text(field((await send(B, id, "看流")).body, "mode"))).toBe("started");
    await waitActive(B, id);
    step("S2", "B 起轮了", { conversationId: id });

    for (const via of [A.url, LB_URL]) {
      const { frame, ms } = await firstTurnState(`${via}/api/chat/conversations/${id}/stream`);
      step("S2", `经 ${via === A.url ? "A（非持有者）" : "nginx"} 订阅，拿到第一帧 turn-state`, { conversationId: id, ms });
      // 权威轮状态：有轮在跑，归属在 B。
      expect(field(frame, "active")).toBe(true);
      expect(field(frame, "holder")).toBe(B.holder);
      // 没被缓冲：一轮要跑 10 秒，缓冲过的代理不会在一半时间内吐出第一帧。
      expect(ms).toBeLessThan(TURN_MS / 2);
    }
    await waitIdle(B, id);
  }, 60_000);

  it("S3 停止打到非持有者：转给持有者，这一轮以 interrupted 收尾", async () => {
    const id = await createConversation(A);
    await send(A, id, "停下");
    await waitActive(A, id);

    step("S3", "A 起轮了，往 B 发停止", { conversationId: id });
    const stopped = await postJson(`${B.url}/api/chat/conversations/${id}/abort`, {});
    step("S3", "停止的回应", { conversationId: id, status: stopped.status, ms: stopped.ms });
    expect(stopped.status).toBe(200);
    expect(field(stopped.body, "aborted")).toBe(true);

    await waitIdle(A, id);
    const rows = await ledger(B, id);
    expect(rows.at(-1)).toMatchObject({ role: "assistant", status: "interrupted" });
    expectCleanSeqs(rows);
  }, 60_000);

  it("S4 数据库卡顿 1 秒（远短于自我围栏）：这一轮不受影响，照常跑完", async () => {
    const id = await createConversation(C);
    await send(C, id, "库卡一下");
    await waitActive(C, id);

    // 只卡 1 秒：`pause`/`unpause` 这两个 CLI 自己在 Docker Desktop 上就要几百毫秒，实际冻结会更长。
    // 围栏的判据是「距上次成功心跳 ≥ 阈值 − 一拍」（4 秒），留足余量，免得这条偶发变成 interrupted。
    step("S4", "C 起轮了，冻住 postgres 1 秒", { conversationId: id });
    await compose("pause", "postgres");
    await sleep(1_000);
    await compose("unpause", "postgres");
    step("S4", "postgres 解冻", { conversationId: id });

    await waitIdle(C, id);
    const rows = await ledger(C, id);
    expect(rows.map((row) => row.role)).toEqual(["user", "assistant"]);
    expect(rows.at(-1)?.status).not.toBe("interrupted");
  }, 60_000);

  it("S5 持有者 kill -9、别的副本先接手：先 503，过接管阈值后起轮，崩溃那一轮补上「已停止」", async () => {
    const id = await createConversation(A);
    await send(A, id, "跑一半就死");
    await waitActive(A, id);

    step("S5", "A 起轮了，kill -9 replica-a", { conversationId: id });
    await compose("kill", "-s", "SIGKILL", A.service);

    // 租约还没过期：B 抢不到，转给 A 又连不上 → 503，并且很快（不是挂着，也没被客户端自动重发一遍）。
    const early = await send(B, id, "太早了");
    step("S5", "租约未过期时往 B 发", { conversationId: id, status: early.status, ms: early.ms });
    expect(early.status).toBe(503);
    expect(early.retryAfter).toBe("1");
    expect(field(early.body, "reason")).toBe("holder_unreachable");
    expect(early.ms).toBeLessThan(FORWARD_TIMEOUT_MS * 2 - 500);

    await sleep(TAKEOVER_MS + 1_000);
    const late = await send(B, id, "我来接手");
    step("S5", "过了接管阈值再往 B 发", { conversationId: id, status: late.status, mode: text(field(late.body, "mode")), ms: late.ms });
    expect(late.status).toBe(202);
    expect(field(late.body, "mode")).toBe("started");
    await waitIdle(B, id);

    // 「已停止」夹在崩溃那一轮与新一轮之间；那次 503 什么都没写。
    const rows = await ledger(B, id);
    expect(rows.map((row) => [row.role, row.text ?? row.status])).toEqual([
      ["user", "跑一半就死"],
      ["assistant", "interrupted"],
      ["user", "我来接手"],
      ["assistant", "completed"],
    ]);
    expect(rows[1]?.reason).toContain(HOLDER_LOST);
    expectCleanSeqs(rows);

    step("S5", "拉起 replica-a", { conversationId: id });
    await restart(A);
  }, 120_000);

  it("S6 持有者 kill -9、先重启它：启动扫描补上「已停止」", async () => {
    const id = await createConversation(B);
    await send(B, id, "重启我");
    await waitActive(B, id);

    step("S6", "B 起轮了，kill -9 replica-b", { conversationId: id });
    await compose("kill", "-s", "SIGKILL", B.service);
    await sleep(TAKEOVER_MS + 1_000);
    step("S6", "过了接管阈值，先拉起 replica-b（没人发消息）", { conversationId: id });
    await restart(B);

    const rows = await ledger(A, id);
    expect(rows.map((row) => [row.role, row.text ?? row.status])).toEqual([
      ["user", "重启我"],
      ["assistant", "interrupted"],
    ]);
    step("S6", "replica-b 健康了，读账本", { conversationId: id, ledgerRows: rows.length });
    expect(rows[1]?.reason).toContain(SHUTDOWN);
    expect(await leaseHolder(id)).toBeNull();
  }, 120_000);

  it("S7 持有者被冻住：转发在超时附近回 503；接管后老持有者解冻，账本一行不多（核心）", async () => {
    const id = await createConversation(C);
    await send(C, id, "冻住我");
    await waitActive(C, id);

    step("S7", "C 起轮了，冻住 replica-c", { conversationId: id });
    await compose("pause", C.service);
    const frozenAt = Date.now();

    // 冻住的进程端口还在，TCP 握手由内核完成——没有转发超时的话这里会挂几分钟。
    // 用订阅而不是发消息：发出去的消息会躺在 C 的内核缓冲区里，C 解冻后照样处理，
    // 那是技术方案附录 C 记下的已知限制，不是这条要证的事。
    const stream = await request(`${A.url}/api/chat/conversations/${id}/stream`);
    step("S7", "冻住期间经 A 订阅", { conversationId: id, status: stream.status, ms: stream.ms });
    expect(stream.status).toBe(503);
    expect(field(stream.body, "holder")).toBe(C.holder);
    expect(stream.ms).toBeGreaterThanOrEqual(FORWARD_TIMEOUT_MS - 200);
    // 上限必须小于**两倍**超时：回 421 时 Fetch 标准客户端会自动重发一遍，用时正好翻倍。
    expect(stream.ms).toBeLessThan(FORWARD_TIMEOUT_MS * 2 - 500);

    await sleep(Math.max(0, frozenAt + TAKEOVER_MS + 1_000 - Date.now()));
    const takeover = await send(A, id, "我接管了");
    step("S7", "过了接管阈值往 A 发", { conversationId: id, status: takeover.status, mode: text(field(takeover.body, "mode")) });
    expect(field(takeover.body, "mode")).toBe("started");

    // **趁 A 这一轮还在跑就唤醒 C。** C 的心跳一醒就发现围栏到期、停手；它的收尾要取号写账本、
    // 还要 `release`——取号必须被拒，`release` 必须既擦不掉 A 的归属、也抢不回来。
    // 放在 A 跑完之后再唤醒就验不出 `release` 这一半：那时持有者本来就是空的。
    step("S7", "A 的轮还在跑，解冻 replica-c", { conversationId: id });
    await compose("unpause", C.service);
    await sleep(HEARTBEAT_MS * 3);
    step("S7", "解冻 3 秒后看租约", { conversationId: id, holder: (await leaseHolder(id)) ?? "(none)" });
    expect((await activity(A, id))["local"]).toBe(true);
    expect(await leaseHolder(id)).toBe(A.holder);

    await waitIdle(A, id);
    const rows = await ledger(A, id);
    expect(rows.map((row) => [row.role, row.text ?? row.status])).toEqual([
      ["user", "冻住我"],
      ["assistant", "interrupted"],
      ["user", "我接管了"],
      ["assistant", "completed"],
    ]);
    expect(rows[1]?.reason).toContain(HOLDER_LOST);
    expectCleanSeqs(rows);
    await waitFor(async () => (await activity(C, id))["local"] !== true, 15_000, "C 不再认为自己在跑");
    // 再等一会儿：C 迟到的写入（如果有）也该落地了。账本必须还是这四行。
    await sleep(2_000);
    expect(await ledger(A, id)).toEqual(rows);
  }, 120_000);

  it("S8 网络分区：持有者连不上库时，没人接管也会在模型跑完之前自己停手；之后别的副本接管，账本没写坏", async () => {
    const id = await createConversation(A);
    const sentAt = Date.now();
    await send(A, id, "断网");
    await waitActive(A, id);

    // 直接订阅 A 自己（它是持有者，答的是本地）。A 连不上库，但照样收得到请求、推得出帧。
    const controller = new AbortController();
    const states = turnStates(`${A.url}/api/chat/conversations/${id}/stream`, controller.signal);
    const first = await states.next();
    expect(first.done !== true && field(first.value.frame, "active")).toBe(true);
    const stopped = (async (): Promise<number> => {
      for await (const event of states) {
        if (field(event.frame, "active") === false) {return event.at;}
      }
      throw new Error("A 的流断了，没等到这一轮停下");
    })().catch(() => Number.POSITIVE_INFINITY); // 等超时后 abort 掉流会让它 reject，别变成未处理的 rejection

    step("S8", "A 起轮了，断开 replica-a 与库之间的网络", { conversationId: id });
    await docker(["network", "disconnect", DB_NETWORK, containerOf(A.service)]);
    const disconnectedAt = Date.now();

    // **这里还没有任何人来接管**——B 一句话都没发。A 若能停，只能是自己停的（自我围栏）：
    // 距上次成功心跳 ≥ 阈值 − 一拍（4 秒）时停手。没有围栏的话它要等模型睡满 10 秒才结束，
    // 而且收尾写不进库。所以两条断言：停得不算早（不是别的什么立刻失败），也停得比模型该跑完早。
    const stoppedAt = await Promise.race([
      stopped,
      sleep(TURN_MS + 5_000).then(() => Number.POSITIVE_INFINITY),
    ]);
    controller.abort();
    step("S8", "A 的流报这一轮停了（此时还没人来接管）", {
      conversationId: id,
      sinceDisconnectMs: stoppedAt - disconnectedAt,
      sinceSentMs: stoppedAt - sentAt,
    });
    expect(stoppedAt - disconnectedAt).toBeGreaterThanOrEqual(TAKEOVER_MS - 2 * HEARTBEAT_MS);
    expect(stoppedAt - sentAt).toBeLessThan(TURN_MS - 1_500);

    // 租约过期之后 B 接管：补上「已停止」，照常起轮。
    await sleep(Math.max(0, disconnectedAt + TAKEOVER_MS + HEARTBEAT_MS + 500 - Date.now()));
    const takeover = await send(B, id, "分区后接手");
    step("S8", "过了接管阈值往 B 发", { conversationId: id, status: takeover.status, mode: text(field(takeover.body, "mode")) });
    expect(takeover.status).toBe(202);
    expect(field(takeover.body, "mode")).toBe("started");
    await waitIdle(B, id);

    step("S8", "B 的轮跑完，接回 replica-a 的网络", { conversationId: id });
    await docker(["network", "connect", DB_NETWORK, containerOf(A.service)]);
    const afterTakeover = await ledger(B, id);
    expect(afterTakeover.map((row) => [row.role, row.text ?? row.status])).toEqual([
      ["user", "断网"],
      ["assistant", "interrupted"],
      ["user", "分区后接手"],
      ["assistant", "completed"],
    ]);
    expect(afterTakeover[1]?.reason).toContain(HOLDER_LOST);

    // 接回网络之后，A 不再认为自己在跑，也没往账本里补写任何东西。
    await waitFor(async () => (await activity(A, id))["local"] !== true, 30_000, "A 不再认为自己在跑");
    await sleep(3_000);
    const rows = await ledger(B, id);
    expect(rows).toEqual(afterTakeover);
    expectCleanSeqs(rows);
  }, 120_000);
});
