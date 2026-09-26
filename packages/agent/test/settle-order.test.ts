/**
 * 一轮收尾的两条硬规矩：
 *
 * - **先存好，再说完成**：成品消息帧一定排在收尾帧之前；没写全就改发「系统异常」，不发「完成了」
 *   （docs/logic/orchestration/tech/single-ledger.md §6.1）。
 * - **排队的下一轮不放手**：持有者带着同一个归属接着跑，一条订阅贯穿整个队列，两轮之间没有
 *   `activity:false`（docs/logic/orchestration/tech/steer-and-queue.md §8.3）。
 */
import type { AgentDefinition, RunkoMessageMetadata, RunkoUIMessage } from "@runko/core";
import { describe, expect, it, vi } from "vitest";

import type { AgentRuntime, Arbitration, Frame, Grant, LedgerEntry, Persistence, WriteResult } from "../src/index.js";
import { createAgentRuntime, inProcessArbitration, memoryPersistence } from "../src/index.js";
import type { FakeSession } from "./helpers/fake-session.js";
import { assistantMessage, createFakeSessionFactory, endTurnChunk } from "./helpers/fake-session.js";

const agent: AgentDefinition = { model: "test/model" };

function setup(overrides: Partial<Parameters<typeof createAgentRuntime>[0]> = {}) {
  const sessions = createFakeSessionFactory();
  const persistence = overrides.persistence ?? memoryPersistence();
  const runtime = createAgentRuntime({
    agent,
    persistence,
    sessionFactory: sessions.factory,
    prepareTurn: () => ({}),
    ...overrides,
  });
  return { runtime, sessions, persistence };
}

function collect(runtime: AgentRuntime, conversationId: string): { frames: Frame[]; done: Promise<void> } {
  const frames: Frame[] = [];
  const done = (async () => {
    for await (const frame of runtime.subscribe(conversationId)) {frames.push(frame);}
  })();
  return { frames, done };
}

async function runOneTurn(session: FakeSession, text: string, turn: number): Promise<void> {
  await session.started;
  session.emit({ type: "start", messageId: `m-${String(turn)}` });
  session.emit({ type: "text-start", id: "t1" });
  session.emit({ type: "text-delta", id: "t1", delta: text });
  session.emit({ type: "text-end", id: "t1" });
  session.emit({ type: "finish" });
  session.push(assistantMessage(text, { turn, usage: {}, status: "completed" }));
  session.emit(endTurnChunk(turn));
  session.finish();
}

function metadataOf(frame: Frame): RunkoMessageMetadata | undefined {
  return frame.kind === "chunk" && frame.chunk.type === "message-metadata" ? frame.chunk.messageMetadata : undefined;
}

function isAssistantMessage(frame: Frame): boolean {
  return frame.kind === "message" && frame.message.role === "assistant";
}

function hasText(message: RunkoUIMessage): boolean {
  return message.parts.some((part) => part.type === "text");
}

/** 让 assistant 消息写不进账本：`throw` = 库出错，`reject` = 写入被拒。`markers` 为真时连失败标记也写不进。 */
function faultyPersistence(mode: "throw" | "reject", opts: { markers?: boolean } = {}): Persistence {
  const base = memoryPersistence();
  const append = (entry: LedgerEntry): Promise<WriteResult> => {
    const blocked = entry.message.role === "assistant" && (opts.markers === true || hasText(entry.message));
    if (!blocked) {return base.ledger.append(entry);}
    if (mode === "throw") {return Promise.reject(new Error("connection terminated unexpectedly"));}
    return Promise.resolve({ ok: false, reason: "rejected" });
  };
  return { ...base, ledger: { ...base.ledger, append } };
}

/** 数 `acquire` 与 `release` 各被调了几次的进程内仲裁。 */
function countingArbitration(): { arbitration: Arbitration; counts: { acquire: number; release: number } } {
  const inner = inProcessArbitration();
  const counts = { acquire: 0, release: 0 };
  const wrap = (grant: Grant): Grant => ({
    get conversationId() {
      return grant.conversationId;
    },
    get holder() {
      return grant.holder;
    },
    get signal() {
      return grant.signal;
    },
    get valid() {
      return grant.valid;
    },
    nextSeq: () => grant.nextSeq(),
    release: () => {
      counts.release += 1;
      return grant.release();
    },
  });
  const arbitration: Arbitration = {
    ...inner,
    acquire: async (conversationId, ctx) => {
      counts.acquire += 1;
      const acquired = await inner.acquire(conversationId, ctx);
      return acquired.ok ? { ...acquired, grant: wrap(acquired.grant) } : acquired;
    },
  };
  return { arbitration, counts };
}

describe("收尾顺序：先存好，再说完成", () => {
  it("成品消息帧排在收尾帧之前", async () => {
    const { runtime, sessions } = setup();
    await runtime.enqueue("order-1", { text: "hello" });
    const session = await sessions.next();
    await session.started;
    const sub = collect(runtime, "order-1");

    await runOneTurn(session, "hi", 1);
    await sub.done;

    const saved = sub.frames.findIndex(isAssistantMessage);
    const done = sub.frames.findIndex((frame) => metadataOf(frame) !== undefined);
    expect(saved).toBeGreaterThanOrEqual(0);
    expect(done).toBeGreaterThan(saved);
    expect(metadataOf(sub.frames[done] ?? { kind: "reconnect" })?.status).toBe("completed");
  });

  for (const mode of ["throw", "reject"] as const) {
    it(`写库${mode === "throw" ? "出错" : "被拒"}：改发系统异常，不发「完成了」，也不带存储细节`, async () => {
      const { runtime, sessions } = setup({ persistence: faultyPersistence(mode) });
      await runtime.enqueue(`order-${mode}`, { text: "hello" });
      const session = await sessions.next();
      await session.started;
      const sub = collect(runtime, `order-${mode}`);

      await runOneTurn(session, "hi", 1);
      await sub.done;

      const endings = sub.frames.map(metadataOf).filter((metadata) => metadata !== undefined);
      expect(endings).toHaveLength(1);
      expect(endings[0]?.status).toBe("failed");
      expect(endings[0]?.error?.code).toBe("internal_error");
      expect(endings[0]?.error?.message).not.toContain("connection");
      // 失败标记写进了账本：刷新之后也看得到这一轮出了问题。
      const rows = await runtime.readLedger(`order-${mode}`);
      expect(rows.at(-1)?.message.metadata?.error?.code).toBe("internal_error");
    });
  }

  it("连失败标记也写不进去：不抛，收尾照常跑完，下一条消息还能起轮", async () => {
    const { runtime, sessions } = setup({ persistence: faultyPersistence("throw", { markers: true }) });
    await runtime.enqueue("order-locked", { text: "hello" });
    const first = await sessions.next();
    await runOneTurn(first, "hi", 1);
    await vi.waitFor(async () => {
      expect((await runtime.getActivity("order-locked")).active).toBe(false);
    });

    expect((await runtime.enqueue("order-locked", { text: "again" })).mode).toBe("started");
    const second = await sessions.next();
    await second.started;
  });
});

describe("收尾顺序：归属丢了的时候", () => {
  it("归属丢了、库又卡住：照样马上发出系统异常并收尾，不去碰库", async () => {
    const base = memoryPersistence();
    let hang = false;
    const never = new Promise<never>(() => undefined);
    const persistence: Persistence = {
      ...base,
      ledger: {
        ...base.ledger,
        read: (conversationId, opts) => (hang ? never : base.ledger.read(conversationId, opts)),
        append: (entry) => (hang ? never : base.ledger.append(entry)),
      },
    };
    const lost = new AbortController();
    const inner = inProcessArbitration();
    const arbitration: Arbitration = {
      ...inner,
      acquire: async (conversationId, ctx) => {
        const acquired = await inner.acquire(conversationId, ctx);
        if (!acquired.ok) {return acquired;}
        const grant = acquired.grant;
        const wrapped: Grant = {
          get conversationId() {
            return grant.conversationId;
          },
          get holder() {
            return grant.holder;
          },
          signal: lost.signal,
          get valid() {
            return grant.valid && !lost.signal.aborted;
          },
          nextSeq: () => (lost.signal.aborted ? Promise.resolve({ ok: false, reason: "lost_ownership" }) : grant.nextSeq()),
          release: () => grant.release(),
        };
        return { ...acquired, grant: wrapped };
      },
    };
    const { runtime, sessions } = setup({ persistence, arbitration });
    await runtime.enqueue("lost-1", { text: "hello" });
    const session = await sessions.next();
    await session.started;
    const sub = collect(runtime, "lost-1");
    await vi.waitFor(() => {
      expect(sub.frames.some((frame) => frame.kind === "activity" && frame.active)).toBe(true);
    });

    // 库连不上、自我围栏停手：此后任何读写都卡住。
    hang = true;
    lost.abort();
    session.push(assistantMessage("half", { turn: 1, usage: {}, status: "interrupted" }));
    session.emit(endTurnChunk(1, "interrupted"));
    session.finish();
    await sub.done;

    const endings = sub.frames.map(metadataOf).filter((metadata) => metadata !== undefined);
    expect(endings.map((metadata) => metadata.error?.code)).toEqual(["internal_error"]);
    expect(sub.frames.at(-1)).toEqual({ kind: "activity", active: false });
  });
});

describe("排队的下一轮：不放手，一条流跑完整个队列", () => {
  it("排两条：同一条订阅里看到三轮，只在最后收到一次 activity:false", async () => {
    const { runtime, sessions } = setup();
    await runtime.enqueue("chain-1", { text: "first" });
    const first = await sessions.next();
    await first.started;
    await runtime.enqueue("chain-1", { text: "second" });
    await runtime.enqueue("chain-1", { text: "third" });
    const sub = collect(runtime, "chain-1");

    await runOneTurn(first, "a1", 1);
    await runOneTurn(await sessions.next(), "a2", 2);
    await runOneTurn(await sessions.next(), "a3", 3);
    await sub.done;

    const endings = sub.frames.map(metadataOf).filter((metadata) => metadata !== undefined);
    expect(endings.map((metadata) => metadata.status)).toEqual(["completed", "completed", "completed"]);
    const inactive = sub.frames.filter((frame) => frame.kind === "activity" && !frame.active);
    expect(inactive).toHaveLength(1);
    expect(sub.frames.at(-1)).toEqual({ kind: "activity", active: false });
  });

  it("两轮之间归属不换手：整条队列只抢一次、放一次", async () => {
    const { arbitration, counts } = countingArbitration();
    const { runtime, sessions } = setup({ arbitration });
    await runtime.enqueue("chain-2", { text: "first" });
    const first = await sessions.next();
    await first.started;
    await runtime.enqueue("chain-2", { text: "second" });

    await runOneTurn(first, "a1", 1);
    await runOneTurn(await sessions.next(), "a2", 2);
    await vi.waitFor(async () => {
      expect((await runtime.getActivity("chain-2")).active).toBe(false);
    });

    expect(counts).toEqual({ acquire: 1, release: 1 });
  });

  it("宿主的收尾通知在出队之前：通知那一刻队列里还有那条", async () => {
    const lengths: number[] = [];
    const persistence = memoryPersistence();
    const { runtime, sessions } = setup({
      persistence,
      hooks: {
        onTurnSettled: ({ conversationId }) => {
          void persistence.queue.list(conversationId).then((queue) => lengths.push(queue.length));
        },
      },
    });
    await runtime.enqueue("chain-3", { text: "first" });
    const first = await sessions.next();
    await first.started;
    await runtime.enqueue("chain-3", { text: "second" });

    await runOneTurn(first, "a1", 1);
    await runOneTurn(await sessions.next(), "a2", 2);
    await vi.waitFor(() => {
      expect(lengths).toEqual([1, 0]);
    });
  });

  it("中间一轮装配失败：那一轮以失败收尾，队列剩下的照样接着跑，流不断", async () => {
    const { runtime, sessions } = setup({
      prepareTurn: ({ input }) => {
        if (input.text === "bad") {throw new Error("sandbox unavailable");}
        return {};
      },
    });
    await runtime.enqueue("chain-4", { text: "first" });
    const first = await sessions.next();
    await first.started;
    await runtime.enqueue("chain-4", { text: "bad" });
    await runtime.enqueue("chain-4", { text: "good" });
    const sub = collect(runtime, "chain-4");

    await runOneTurn(first, "a1", 1);
    await runOneTurn(await sessions.next(), "a3", 3);
    await sub.done;

    const endings = sub.frames.map(metadataOf).filter((metadata) => metadata !== undefined);
    expect(endings.map((metadata) => metadata.status)).toEqual(["completed", "failed", "completed"]);
    expect(sub.frames.filter((frame) => frame.kind === "activity" && !frame.active)).toHaveLength(1);
    expect(await runtime.listQueue("chain-4")).toHaveLength(0);
  });

  it("出队前队列被清空：走普通收尾，广播 activity:false 并放手", async () => {
    const { arbitration, counts } = countingArbitration();
    const { runtime, sessions } = setup({ arbitration });
    await runtime.enqueue("chain-5", { text: "first" });
    const first = await sessions.next();
    await first.started;
    await runtime.enqueue("chain-5", { text: "second" });
    await runtime.clearQueue("chain-5");
    const sub = collect(runtime, "chain-5");

    await runOneTurn(first, "a1", 1);
    await sub.done;

    expect(sub.frames.at(-1)).toEqual({ kind: "activity", active: false });
    // 放手排在广播之后。
    await vi.waitFor(() => {
      expect(counts).toEqual({ acquire: 1, release: 1 });
    });
    expect(sessions.sessions).toHaveLength(1);
  });
});
