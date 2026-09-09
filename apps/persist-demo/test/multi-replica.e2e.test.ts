/**
 * **两个真进程，共用一个库。** 这是多副本这件事**唯一真正的证明**——一个进程里起两个
 * `Arbitration` 实例已经能验令牌 CAS（见 `@runko/persist-kysely` 的仲裁用例），但
 * **进程崩溃、连接池各自独立、被冻住又活过来**这些只有跨进程才有。
 *
 * 用的是 SQLite 文件而不是 Postgres：一个文件对两个进程就是
 * [Node 长驻](../../../docs/host/node/tech/deployment.md)里的「① 同机 cluster」那一档，
 * 走的代码路径与 Postgres 完全相同（同一个 `leaseArbitration`，只是方言不同），而且
 * **不需要任何外部服务**。跨机那一档（真 Postgres）留给 CI，见文末。
 *
 * 时间轴压扁到 心跳 200ms / 判死 900ms（仍满足「阈值 ≥ 3× 心跳」那条硬规矩），
 * 否则「等接管」那两条要各等一分钟。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ENTRY = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const HEARTBEAT_MS = 200;
const TAKEOVER_MS = 900;
/** 一轮故意跑这么久，好让「它还在跑」在另一个进程里是个确定事实。 */
const TURN_MS = 4_000;

interface Replica {
  name: string;
  url: string;
  child: ChildProcess;
}

let dir: string;
const replicas: Replica[] = [];

async function waitFor(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check().catch(() => false)) {return;}
    if (Date.now() > deadline) {throw new Error("等超时了");}
    await sleep(50);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function start(name: string, port: number, dbPath: string): Promise<Replica> {
  const url = `http://127.0.0.1:${String(port)}`;
  // 跟 `pnpm start` 同一条命令：`src/index.ts` 是 TypeScript，得带上 tsx。
  const child = spawn(process.execPath, ["--import", "tsx", ENTRY], {
    env: {
      ...process.env,
      PORT: String(port),
      DEMO_DB: "sqlite",
      DEMO_DB_PATH: dbPath,
      RUNKO_NODE_URL: url,
      RUNKO_HEARTBEAT_MS: String(HEARTBEAT_MS),
      RUNKO_TAKEOVER_MS: String(TAKEOVER_MS),
      DEMO_MODEL_DELAY_MS: String(TURN_MS),
    },
    // 起不来时要看得见原因；正常跑起来之后这些输出不进断言。
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[${name}] ${chunk.toString()}`);
  });
  const replica = { name, url, child };
  replicas.push(replica);
  await waitFor(async () => (await fetch(`${url}/health`)).ok);
  return replica;
}

/** `kill -9` / `SIGSTOP` / `SIGCONT` —— 只有真进程才有这些。 */
function signal(replica: Replica, sig: NodeJS.Signals): void {
  replica.child.kill(sig);
}

const json = async (res: Response): Promise<Record<string, unknown>> =>
  (await res.json()) as Record<string, unknown>;

async function createConversation(replica: Replica): Promise<string> {
  const res = await fetch(`${replica.url}/api/chat/conversations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "多副本" }),
  });
  return String((await json(res))["id"]);
}

async function send(replica: Replica, id: string, text: string): Promise<Response> {
  return await fetch(`${replica.url}/api/chat/conversations/${id}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

async function activity(replica: Replica, id: string): Promise<Record<string, unknown>> {
  return await json(await fetch(`${replica.url}/api/chat/conversations/${id}/activity`));
}

async function ledger(replica: Replica, id: string): Promise<{ seq: number; message: { role: string } }[]> {
  const body = await json(await fetch(`${replica.url}/api/chat/conversations/${id}/messages`));
  return body["frames"] as { seq: number; message: { role: string } }[];
}

let a: Replica;
let b: Replica;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "runko-multi-"));
  const dbPath = join(dir, "demo.db");
  a = await start("A", 3921, dbPath);
  b = await start("B", 3922, dbPath);
}, 60_000);

afterAll(() => {
  for (const replica of replicas) {
    // 冻住的进程要先解冻，否则 SIGTERM 递不进去，vitest 会挂在退出上。
    replica.child.kill("SIGCONT");
    replica.child.kill("SIGKILL");
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("多副本：两个真进程共用一个库", () => {
  it("场景 ①：归属只落在一个副本上，打到另一个副本的请求被转过去", async () => {
    const id = await createConversation(a);

    // A 起轮。慢模型让这一轮在后面几步里一直跑着。
    expect(await json(await send(a, id, "第一条"))).toMatchObject({ mode: "started" });
    await waitFor(async () => (await activity(a, id))["active"] === true);

    // B 上看同一份对话：**权威答案说有轮在跑，而且不在本地**——这正是接入层据以转发的信号。
    expect(await activity(b, id)).toMatchObject({ active: true, local: false, holder: a.url });

    // 同一条会话再往 B 发一句：B 抢不到归属 → 拿着 holder 转给 A → A 排队。
    // 转发没接通的话这里会是 421。
    const second = await send(b, id, "第二条");
    expect(second.status).toBe(202);
    expect(await json(second)).toMatchObject({ mode: "queued" });

    // 两条用户消息各进账本一次，不多不少。
    await waitFor(async () => {
      const rows = await ledger(a, id);
      return rows.filter((r) => r.message.role === "user").length === 2;
    }, 30_000);
    const rows = await ledger(b, id);
    expect(rows.map((r) => r.seq)).toEqual([...rows.map((r) => r.seq)].sort((x, y) => x - y));
    expect(new Set(rows.map((r) => r.seq)).size).toBe(rows.length);
  }, 60_000);

  it("场景 ②：SSE 订阅打到非持有者，也能看到那一轮的内容", async () => {
    const id = await createConversation(b);
    await send(b, id, "看流");
    await waitFor(async () => (await activity(b, id))["active"] === true);

    // 从 A 订阅（A 不是持有者）。它应当把整条流转发给 B，而不是回一句「没有轮在跑」。
    const res = await fetch(`${a.url}/api/chat/conversations/${id}/stream`);
    expect(res.ok).toBe(true);
    const text = await res.text();
    expect(text).toContain("turn-state");
    // 关键：**不是** `"active":false`。那是本地登记表的答案，不是权威答案。
    expect(text).toContain('"active":true');
    expect(text).toContain(`"holder":"${b.url}"`);
  }, 60_000);

  it("场景 ③：持有者被 kill -9，另一个副本在租约过期后接管得了", async () => {
    const id = await createConversation(a);
    await send(a, id, "跑一半就死");
    await waitFor(async () => (await activity(a, id))["active"] === true);

    signal(a, "SIGKILL");
    await waitFor(async () => a.child.killed || a.child.exitCode !== null);

    // 租约过期前 B 抢不到；过期后能。**不是立刻**——那正是「宁可多转一分钟圈，也不要
    // 两个写入方」的代价，这里只是把一分钟压成了 900 毫秒。
    await sleep(TAKEOVER_MS + 300);
    const res = await send(b, id, "我来接手");
    expect(res.status).toBe(202);
    expect(await json(res)).toMatchObject({ mode: "started" });

    // A 没了，只能从 B 读；账本仍然是干净的。
    await waitFor(async () => (await activity(b, id))["active"] === false, 30_000);
    const rows = await ledger(b, id);
    expect(new Set(rows.map((r) => r.seq)).size).toBe(rows.length);
  }, 60_000);

  it("场景 ④：被误判的老持有者活过来之后，写不进账本（这条是核心）", async () => {
    // A 已经在场景 ③ 里死了，这一条用 B 当老持有者、重新起一个 C 当接管方。
    const dbPath = join(dir, "demo.db");
    const c = await start("C", 3923, dbPath);

    const id = await createConversation(b);
    await send(b, id, "冻住我");
    await waitFor(async () => (await activity(b, id))["active"] === true);

    // **冻住 B**：进程还在，只是不跑了——心跳因此停掉，而它自己毫不知情。
    // 这正是「你没法知道远处那个节点是死了还是只是联系不上」的实景。
    signal(b, "SIGSTOP");
    await sleep(TAKEOVER_MS + 400);

    // C 合法接管，跑完自己那一轮。
    expect(await json(await send(c, id, "我接管了"))).toMatchObject({ mode: "started" });
    await waitFor(async () => (await activity(c, id))["active"] === false, 30_000);
    const afterTakeover = await ledger(c, id);

    // 唤醒 B。它的模型这时才吐完，于是它去取号、去写账本——**必须被拒**。
    signal(b, "SIGCONT");
    await sleep(TURN_MS + 1_500);

    const rows = await ledger(c, id);
    // 账本没被写坏：序号唯一、递增，而且**没有多出 B 那一轮的成品消息**。
    expect(new Set(rows.map((r) => r.seq)).size).toBe(rows.length);
    expect(rows.map((r) => r.seq)).toEqual([...rows.map((r) => r.seq)].sort((x, y) => x - y));
    expect(rows.length).toBe(afterTakeover.length);
  }, 90_000);
});
