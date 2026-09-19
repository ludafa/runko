/**
 * **[挂起](../../../docs/terms.md)与[恢复](../../../docs/terms.md)的核心验收：两个真进程，共用一个库。**
 *
 * 副本 A 起一轮 → 模型要跑一条命令 → 等人审批 → 等满[内存窗口](../../../docs/terms.md) → 挂起、放手
 * → **A 被 `kill -9`** → 人把「允许」发给副本 B → B 从账本与裁决表里接上，执行的正是 A 那一轮
 * 请求批准的那条命令，然后跑完。
 *
 * 为什么非得两个进程：挂起的承诺是「人回来**在任意节点**接着干」。一个进程里怎么测，答案都还在
 * 同一块内存里，证明不了它真的只靠库。A 被 `kill -9` 就是把「靠内存」这条退路堵死。
 *
 * 四档库都跑：SQLite 文件永远跑；Postgres / MySQL / Mongo 给了连接串才跑，没给就 skip 并在标题里
 * 写明（设计见 docs/logic/orchestration/tech/suspend-resume.md §5.7、§9.1）。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { mongoUrlWithDb } from "./helpers/mongo-url.js";

const ENTRY = fileURLToPath(new URL("../src/index.ts", import.meta.url));
/** 内存窗口压到半秒：等人半秒没人答就挂起。 */
const MEMORY_WINDOW = "500ms";

interface Replica {
  name: string;
  url: string;
  child: ChildProcess;
}

interface ToolPart {
  type: string;
  toolCallId: string;
  state: string;
  input?: unknown;
  output?: unknown;
}

interface LedgerMessage {
  id: string;
  role: string;
  parts: (ToolPart | { type: string })[];
  metadata?: { status?: string; suspended?: { callIds: string[]; reason?: string } };
}

const replicas: Replica[] = [];
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check().catch(() => false)) {return;}
    if (Date.now() > deadline) {throw new Error("等超时了");}
    await sleep(50);
  }
}

async function start(name: string, port: number, env: Record<string, string>): Promise<Replica> {
  const url = `http://127.0.0.1:${String(port)}`;
  const child = spawn(process.execPath, ["--import", "tsx", ENTRY], {
    env: {
      ...process.env,
      ...env,
      PORT: String(port),
      RUNKO_NODE_URL: url,
      RUNKO_HEARTBEAT_MS: "200",
      RUNKO_TAKEOVER_MS: "900",
      RUNKO_LOG_LEVEL: "warn",
    },
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

async function kill(replica: Replica): Promise<void> {
  replica.child.kill("SIGKILL");
  await waitFor(() => Promise.resolve(replica.child.exitCode !== null || replica.child.signalCode !== null));
}

async function post(replica: Replica, path: string, body: unknown): Promise<Response> {
  return await fetch(`${replica.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * 答复要像真客户端那样**遇到 503 就按 `Retry-After` 重试**。
 *
 * A 挂起、放手之后会立刻再推一把（收尾第⑤步），短暂地重新占住归属去查有没有答案。`kill -9`
 * 要是恰好落在这一小段里，库里的租约就挂在一个死掉的持有者名下，直到接管阈值过去——这期间
 * B 按规矩把答复转给 A、连不上，回 503 让客户端稍后再试。租约过期后 B 接管，答复照常落地。
 */
async function postUntilAccepted(replica: Replica, path: string, body: unknown): Promise<Response> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const res = await post(replica, path, body);
    if (res.status !== 503 || Date.now() > deadline) {return res;}
    await sleep(Number(res.headers.get("retry-after") ?? "1") * 300);
  }
}

async function createConversation(replica: Replica): Promise<string> {
  const res = await post(replica, "/api/chat/conversations", { title: "挂起与恢复" });
  const body = (await res.json()) as { id: string };
  return body.id;
}

/** 读账本，**按消息 id 折叠**：位置取第一次出现，内容取最后一次（恢复轮以新 seq 追加同 id 的那一条）。 */
async function foldedLedger(replica: Replica, id: string): Promise<LedgerMessage[]> {
  const res = await fetch(`${replica.url}/api/chat/conversations/${id}/messages`);
  const body = (await res.json()) as { frames: { seq: number; message: LedgerMessage }[] };
  const order: string[] = [];
  const latest = new Map<string, LedgerMessage>();
  for (const frame of body.frames) {
    if (!latest.has(frame.message.id)) {order.push(frame.message.id);}
    latest.set(frame.message.id, frame.message);
  }
  return order.flatMap((messageId) => {
    const message = latest.get(messageId);
    return message === undefined ? [] : [message];
  });
}

function lastTurnEnd(messages: LedgerMessage[]): LedgerMessage | undefined {
  return [...messages].reverse().find((message) => message.metadata?.status !== undefined);
}

function toolPart(message: LedgerMessage | undefined, callId: string): ToolPart | undefined {
  return message?.parts.find((part): part is ToolPart => "toolCallId" in part && part.toolCallId === callId);
}

async function activity(replica: Replica, id: string): Promise<{ active: boolean; local?: boolean; holder?: string }> {
  const res = await fetch(`${replica.url}/api/chat/conversations/${id}/activity`);
  return (await res.json()) as { active: boolean; local?: boolean; holder?: string };
}

/** 等这一轮以挂起收尾，交回那次悬着的调用。 */
async function waitSuspended(replica: Replica, id: string): Promise<{ callId: string; message: LedgerMessage }> {
  let suspended: LedgerMessage | undefined;
  await waitFor(async () => {
    suspended = lastTurnEnd(await foldedLedger(replica, id));
    return suspended?.metadata?.status === "suspended";
  });
  const callId = suspended?.metadata?.suspended?.callIds[0];
  if (suspended === undefined || callId === undefined) {throw new Error("挂起那一轮没记下悬着的调用");}
  return { callId, message: suspended };
}

afterAll(() => {
  for (const replica of replicas) {
    replica.child.kill("SIGKILL");
  }
});

interface Backend {
  label: string;
  /** 两个副本共用的选库环境变量；`undefined` = 没给连接串，这一档跳过。 */
  env: () => Record<string, string> | undefined;
  cleanup?: () => Promise<void>;
}

const sqliteDir = mkdtempSync(join(tmpdir(), "runko-suspend-"));
afterAll(() => {
  rmSync(sqliteDir, { recursive: true, force: true });
});

const MONGO_URL = process.env["RUNKO_TEST_MONGO_URL"];
const mongoDb = `persist_demo_sr_${crypto.randomUUID().slice(0, 8)}`;

const backends: Backend[] = [
  { label: "SQLite 文件", env: () => ({ DEMO_DB: "sqlite", DEMO_DB_PATH: join(sqliteDir, "demo.db") }) },
  {
    label: "Postgres（RUNKO_TEST_POSTGRES_URL）",
    env: () => {
      const url = process.env["RUNKO_TEST_POSTGRES_URL"];
      return url === undefined ? undefined : { DEMO_DB: "postgres", DATABASE_URL: url };
    },
  },
  {
    label: "MySQL（RUNKO_TEST_MYSQL_URL）",
    env: () => {
      const url = process.env["RUNKO_TEST_MYSQL_URL"];
      return url === undefined ? undefined : { DEMO_DB: "mysql", DATABASE_URL: url };
    },
  },
  {
    label: "MongoDB（RUNKO_TEST_MONGO_URL）",
    env: () => (MONGO_URL === undefined ? undefined : { DEMO_DB: "mongo", DATABASE_URL: mongoUrlWithDb(MONGO_URL, mongoDb) }),
    cleanup: async () => {
      if (MONGO_URL === undefined) {return;}
      const { MongoClient } = await import("mongodb");
      const client = new MongoClient(MONGO_URL);
      await client.connect();
      await client.db(mongoDb).dropDatabase();
      await client.close();
    },
  },
];

let nextPort = 3940;

for (const backend of backends) {
  const dbEnv = backend.env();
  describe.skipIf(dbEnv === undefined)(`挂起与恢复 · 两个真进程 · ${backend.label}`, () => {
    afterAll(async () => {
      await backend.cleanup?.();
    });

    /** 两个副本：bash 要审批、窗口半秒。`script` 决定模型第一步调什么工具。 */
    async function pair(script: "bash" | "ask-user"): Promise<[Replica, Replica]> {
      const env = { ...dbEnv, DEMO_SCRIPT: script, DEMO_APPROVAL: "review", RUNKO_MEMORY_WINDOW: MEMORY_WINDOW };
      const first = await start(`${backend.label}·A`, nextPort++, env);
      const second = await start(`${backend.label}·B`, nextPort++, env);
      return [first, second];
    }

    it("审批：A 挂起后被 kill -9，人把「允许」发给 B，B 执行的正是账本里那条命令", async () => {
      const [a, b] = await pair("bash");
      const id = await createConversation(a);

      expect(await (await post(a, `/api/chat/conversations/${id}/messages`, { text: "跑一下" })).json()).toMatchObject({
        mode: "started",
      });
      const { callId, message } = await waitSuspended(a, id);

      // 挂起的三个承诺：调用原样留在账本末尾、归属放掉了、理由是窗口到点。
      expect(toolPart(message, callId)).toMatchObject({
        state: "approval-requested",
        input: { command: "echo resumed-from-ledger" },
      });
      expect(message.metadata?.suspended?.reason).toBe("timeout");
      await waitFor(async () => !(await activity(b, id)).active);

      // 堵死「靠内存」这条退路。
      await kill(a);

      // 答复打到 B：没有持有者 → B 自己答 → 写裁决表 → 推一把 → 恢复。
      const answered = await postUntilAccepted(b, `/api/chat/conversations/${id}/approvals/${callId}`, { behavior: "allow" });
      expect(answered.status).toBe(200);

      let messages: LedgerMessage[] = [];
      await waitFor(async () => {
        messages = await foldedLedger(b, id);
        return lastTurnEnd(messages)?.metadata?.status === "completed";
      });

      // 那次调用在**原位**有了结果：同一个 id 的消息被改写，而不是在末尾多出一份。
      const resumed = messages.find((candidate) => candidate.id === message.id);
      const part = toolPart(resumed, callId);
      expect(part).toMatchObject({ state: "output-available", input: { command: "echo resumed-from-ledger" } });
      expect(JSON.stringify(part?.output)).toContain("resumed-from-ledger");
      expect(messages.filter((candidate) => candidate.id === message.id)).toHaveLength(1);
      // 恢复那一轮没有用户消息：人没说话，只是答了一张卡片。
      expect(messages.filter((candidate) => candidate.role === "user")).toHaveLength(1);
      // 成品消息落盘在放手之前，所以账本说「做完了」时归属可能还没放——等它放掉。
      await waitFor(async () => !(await activity(b, id)).active);

      // 同一张卡片再答一次：那一行已经答过了。
      const again = await post(b, `/api/chat/conversations/${id}/approvals/${callId}`, { behavior: "deny" });
      expect(again.status).toBe(404);
      await kill(b);
    }, 90_000);

    it("ask-user：A 挂起后被 kill -9，答案发给 B，B 把它当工具结果接着跑", async () => {
      const [a, b] = await pair("ask-user");
      const id = await createConversation(a);

      await post(a, `/api/chat/conversations/${id}/messages`, { text: "问我一句" });
      const { callId, message } = await waitSuspended(a, id);
      expect(toolPart(message, callId)).toMatchObject({ state: "input-available" });
      await waitFor(async () => !(await activity(b, id)).active);
      await kill(a);

      const answered = await postUntilAccepted(b, `/api/chat/conversations/${id}/questions/${callId}`, { answer: "要，继续" });
      expect(answered.status).toBe(200);

      let messages: LedgerMessage[] = [];
      await waitFor(async () => {
        messages = await foldedLedger(b, id);
        return lastTurnEnd(messages)?.metadata?.status === "completed";
      });
      const part = toolPart(
        messages.find((candidate) => candidate.id === message.id),
        callId,
      );
      expect(part).toMatchObject({ state: "output-available", output: "要，继续" });
      await kill(b);
    }, 90_000);

    it("挂起期间发来的消息：先排队，人答完、恢复那一轮收尾后才跑", async () => {
      const [a, b] = await pair("bash");
      const id = await createConversation(a);

      await post(a, `/api/chat/conversations/${id}/messages`, { text: "跑一下" });
      const { callId } = await waitSuspended(a, id);

      // 这时候不能起普通轮（悬空调用后面接用户消息，模型服务商会拒），只能排队。
      const queued = await post(b, `/api/chat/conversations/${id}/messages`, { text: "顺便看看 README" });
      expect(await queued.json()).toMatchObject({ mode: "queued" });

      await post(a, `/api/chat/conversations/${id}/approvals/${callId}`, { behavior: "allow" });

      // 恢复那一轮收尾时推一把，排队的那条接着跑。脚本模型对新的一句话又会调一次 bash，所以
      // 那一轮会**再挂起一次**——这里只看它起来了、收尾了，不看它怎么收尾。
      let messages: LedgerMessage[] = [];
      await waitFor(async () => {
        messages = await foldedLedger(b, id);
        const queuedAt = messages.findIndex((candidate) => JSON.stringify(candidate.parts).includes("顺便看看 README"));
        const turnEnd = lastTurnEnd(messages);
        const endedAt = turnEnd === undefined ? -1 : messages.indexOf(turnEnd);
        return queuedAt >= 0 && endedAt > queuedAt && !(await activity(b, id)).active;
      }, 30_000);
      const texts = messages
        .filter((candidate) => candidate.role === "user")
        .map((candidate) => JSON.stringify(candidate.parts));
      expect(texts[1]).toContain("顺便看看 README");
      // 排队那条一定排在那次调用的结果之后——它从没被插进悬空调用与结果之间。
      const resumedIndex = messages.findIndex((candidate) => toolPart(candidate, callId)?.state === "output-available");
      const queuedIndex = messages.findIndex((candidate) => JSON.stringify(candidate.parts).includes("顺便看看 README"));
      expect(resumedIndex).toBeGreaterThanOrEqual(0);
      expect(queuedIndex).toBeGreaterThan(resumedIndex);
      await kill(a);
      await kill(b);
    }, 90_000);

    it("窗口内的答复打到非持有者：照旧转发给持有者，在内存里直接接上，不挂起", async () => {
      const env = { ...dbEnv, DEMO_SCRIPT: "bash", DEMO_APPROVAL: "review", RUNKO_MEMORY_WINDOW: "30s" };
      const a = await start(`${backend.label}·A`, nextPort++, env);
      const b = await start(`${backend.label}·B`, nextPort++, env);
      const id = await createConversation(a);

      await post(a, `/api/chat/conversations/${id}/messages`, { text: "跑一下" });
      // 等卡片出现：账本里还没有（成品消息收尾才落盘），但持有者的直播流上有。用轮状态判——
      // 持有者是 A、这一轮在等人。再从裁决表的角度，拿 callId 只能读流，这里读一次 SSE。
      await waitFor(async () => (await activity(b, id)).holder === a.url);
      const stream = await fetch(`${a.url}/api/chat/conversations/${id}/stream`, { signal: AbortSignal.timeout(3_000) });
      let callId: string | undefined;
      const reader = stream.body?.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      while (callId === undefined && reader !== undefined) {
        const { done, value } = await reader.read();
        if (done) {break;}
        buffered += decoder.decode(value, { stream: true });
        callId = /"type":"tool-approval-request"[^}]*"toolCallId":"([^"]+)"/.exec(buffered)?.[1];
      }
      await reader?.cancel();
      expect(callId).toBeDefined();

      const answered = await post(b, `/api/chat/conversations/${id}/approvals/${String(callId)}`, { behavior: "allow" });
      expect(answered.status).toBe(200);

      let messages: LedgerMessage[] = [];
      await waitFor(async () => {
        messages = await foldedLedger(b, id);
        return lastTurnEnd(messages)?.metadata?.status === "completed";
      });
      // 一次都没挂起：整个会话里没有任何一条 suspended 收尾。
      expect(messages.some((candidate) => candidate.metadata?.status === "suspended")).toBe(false);
      await kill(a);
      await kill(b);
    }, 90_000);
  });
}
