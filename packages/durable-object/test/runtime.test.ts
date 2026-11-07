/**
 * 运行时装进 Durable Object 之后的几条主路：跑一轮、排队、对象重启后的恢复、alarm。
 *
 * 前几条在 `BareObject` 里现造运行时（「重启」= 同一个存储上再造一个，新的实例 id）；
 * alarm 与真回收那两条用 `AgentObject`，它照 README 的写法把运行时装在构造函数里。
 */
import type { AgentRuntime } from "@runko/agent";
import { ABORT_REASON_SHUTDOWN } from "@runko/agent";
import type { RunkoUIMessage } from "@runko/core";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import { kyselyPersistence } from "@runko/persist-kysely";

import type { DurableObjectRuntimeOptions } from "../src/index.js";
import { createDurableObjectRuntime, durableObjectArbitration } from "../src/index.js";
import { freshObject } from "./helpers/cases.js";
import type { FakeSessions } from "./helpers/fake-session.js";
import { createFakeSessionFactory, runOneTurn } from "./helpers/fake-session.js";
import { TEST_AGENT } from "./worker.js";

/** `BareObject` 没有 `alarm()`，所以这里缺省不设 alarm；要测 alarm 的那条自己打开。 */
function bareRuntime(state: DurableObjectState, sessions: FakeSessions, overrides: Partial<DurableObjectRuntimeOptions> = {}) {
  return createDurableObjectRuntime(state, {
    agent: TEST_AGENT,
    prepareTurn: () => ({}),
    sessionFactory: sessions.factory,
    watchdogInterval: 0,
    ...overrides,
  });
}

async function settled(runtime: AgentRuntime, conversationId: string): Promise<void> {
  await vi.waitFor(async () => {
    expect((await runtime.getActivity(conversationId)).active).toBe(false);
  });
}

async function ledger(runtime: AgentRuntime, conversationId: string): Promise<RunkoUIMessage[]> {
  return (await runtime.readLedger(conversationId)).map((row) => row.message);
}

function textOf(message: RunkoUIMessage | undefined): string | undefined {
  const part = message?.parts[0];
  return part?.type === "text" ? part.text : undefined;
}

function agentObject(label: string): DurableObjectStub<import("./worker.js").AgentObject> {
  return env.AGENT.get(env.AGENT.idFromName(`${label}/${crypto.randomUUID()}`));
}

describe("在对象里跑", () => {
  it("起一轮跑完：用户消息与成品消息都进账本，账本落在对象自己的 SQLite 里", async () => {
    await runInDurableObject(freshObject("runtime"), async (_instance, state) => {
      const sessions = createFakeSessionFactory();
      const { runtime, ready } = bareRuntime(state, sessions);
      await ready;

      expect((await runtime.enqueue("c1", { text: "hello" })).mode).toBe("started");
      await runOneTurn(await sessions.next(), "hi there");
      await settled(runtime, "c1");

      const messages = await ledger(runtime, "c1");
      expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
      expect(textOf(messages[0])).toBe("hello");
      expect(textOf(messages[1])).toBe("hi there");
      expect(state.storage.sql.exec("SELECT count(*) AS n FROM agent_ledger").one()).toEqual({ n: 2 });
      // 收尾放手时起轮标记抹掉了：重启后不会被当成没收尾的轮。
      expect(state.storage.sql.exec("SELECT count(*) AS n FROM agent_do_ownership WHERE instance_id IS NOT NULL").one()).toEqual({ n: 0 });
    });
  });

  it("有轮在跑时排队，收尾后自动出队起下一轮", async () => {
    await runInDurableObject(freshObject("runtime"), async (_instance, state) => {
      const sessions = createFakeSessionFactory();
      const { runtime, ready } = bareRuntime(state, sessions);
      await ready;

      await runtime.enqueue("c1", { text: "first" });
      const first = await sessions.next();
      await first.started;
      expect((await runtime.enqueue("c1", { text: "second" })).mode).toBe("queued");
      expect(await runtime.listQueue("c1")).toHaveLength(1);

      await runOneTurn(first, "answer 1", 1);
      const second = await sessions.next();
      expect(await second.started).toBe("second");
      await runOneTurn(second, "answer 2", 2);
      await settled(runtime, "c1");

      expect(await runtime.listQueue("c1")).toEqual([]);
      expect((await ledger(runtime, "c1")).map(textOf)).toEqual(["first", "answer 1", "second", "answer 2"]);
    });
  });

  it("调用方的 hooks 照样被调到，一轮开始时设了 alarm", async () => {
    await runInDurableObject(freshObject("runtime"), async (_instance, state) => {
      const sessions = createFakeSessionFactory();
      const started: string[] = [];
      const { runtime, ready } = bareRuntime(state, sessions, {
        watchdogInterval: "1m",
        hooks: { onTurnStart: (event) => started.push(event.conversationId) },
      });
      await ready;

      const before = Date.now();
      await runtime.enqueue("c1", { text: "hello" });
      const session = await sessions.next();
      await session.started;
      await vi.waitFor(async () => {
        expect(await state.storage.getAlarm()).not.toBeNull();
      });
      expect(started).toEqual(["c1"]);
      expect(await state.storage.getAlarm()).toBeGreaterThanOrEqual(before + 60_000);

      await runOneTurn(session, "hi");
      await settled(runtime, "c1");
      await state.storage.deleteAlarm();
    });
  });

  it("时长写错了构造时就抛", async () => {
    await runInDurableObject(freshObject("runtime"), (_instance, state) => {
      expect(() => bareRuntime(state, createFakeSessionFactory(), { watchdogInterval: "soon" as "1m" })).toThrow(RangeError);
    });
  });
});

describe("对象重启之后", () => {
  it("一轮跑到一半对象没了：新实例 ready 之后账本补上「已中断」，排队的消息被推起来跑", async () => {
    await runInDurableObject(freshObject("restart"), async (_instance, state) => {
      const firstLife = createFakeSessionFactory();
      const before = bareRuntime(state, firstLife, { sweep: { interval: 0 } });
      await before.ready;
      expect((await before.runtime.enqueue("c1", { text: "first" })).mode).toBe("started");
      // 这个 session 卡在这儿，再也不出一个 chunk——就像对象跑到一半被回收。
      await (await firstLife.next()).started;
      expect((await before.runtime.enqueue("c1", { text: "second" })).mode).toBe("queued");

      // 平台重新构造对象：同一个存储，新的实例 id。
      const secondLife = createFakeSessionFactory();
      const after = bareRuntime(state, secondLife);
      await after.ready;

      const resumed = await secondLife.next();
      expect(await resumed.started).toBe("second");
      await runOneTurn(resumed, "answer 2", 2);
      await settled(after.runtime, "c1");

      const messages = await ledger(after.runtime, "c1");
      expect(messages.map(textOf)).toEqual(["first", undefined, "second", "answer 2"]);
      expect(messages[1]?.metadata).toMatchObject({ status: "interrupted", error: { code: "aborted", message: ABORT_REASON_SHUTDOWN } });
      expect(await after.runtime.listQueue("c1")).toEqual([]);
    });
  });

  it("没有残留时 ready 什么都不补", async () => {
    await runInDurableObject(freshObject("restart"), async (_instance, state) => {
      const sessions = createFakeSessionFactory();
      const before = bareRuntime(state, sessions);
      await before.ready;
      await before.runtime.enqueue("c1", { text: "hello" });
      await runOneTurn(await sessions.next(), "hi");
      await settled(before.runtime, "c1");

      const after = bareRuntime(state, createFakeSessionFactory());
      await after.ready;
      expect((await ledger(after.runtime, "c1")).map((m) => m.role)).toEqual(["user", "assistant"]);
    });
  });
});

describe("alarm（AgentObject）", () => {
  it("一轮在跑时设了 alarm，到点还在跑就续设；跑完之后到点不再续设", async () => {
    const stub = agentObject("alarm");
    expect(await stub.send("c1", "hello")).toBe("started");
    await runInDurableObject(stub, async (instance, state) => {
      await (await instance.sessions.next()).started;
      await vi.waitFor(async () => {
        expect(await state.storage.getAlarm()).not.toBeNull();
      });
    });

    // 到点时这一轮还在跑：alarm() 再设一个。
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, async (instance, state) => {
      expect(await state.storage.getAlarm()).not.toBeNull();
      const session = instance.sessions.sessions[0];
      if (session === undefined) {
        throw new Error("expected the running session");
      }
      await runOneTurn(session, "hi");
      await settled(instance.agent.runtime, "c1");
    });

    // 跑完了：这一次到点之后不再续设。
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBeNull();
    });
    expect(await runDurableObjectAlarm(stub)).toBe(false);
  });

  it("对象被真的回收：alarm 把它叫醒，构造函数里的 ready 补上「已中断」，排队的消息接着跑", async () => {
    const stub = agentObject("evict");
    expect(await stub.send("c1", "first")).toBe("started");
    await runInDurableObject(stub, async (instance) => {
      await (await instance.sessions.next()).started;
    });
    expect(await stub.send("c1", "second")).toBe("queued");

    await evictDurableObject(stub);
    // 没有任何请求，只有 alarm 到点：醒来的是一个新实例。
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    await runInDurableObject(stub, async (instance) => {
      const session = await instance.sessions.next();
      expect(await session.started).toBe("second");
      await runOneTurn(session, "answer 2", 2);
      await settled(instance.agent.runtime, "c1");

      const messages = await ledger(instance.agent.runtime, "c1");
      expect(messages.map(textOf)).toEqual(["first", undefined, "second", "answer 2"]);
      expect(messages[1]?.metadata?.status).toBe("interrupted");
    });
  });

  it("alarm 顺带做定时回捞：打了待接手标记、没人在推的对话被推起来，标记随之撤掉", async () => {
    const stub = agentObject("sweep");
    await runInDurableObject(stub, async (instance, state) => {
      await instance.agent.ready;
      // 造一个「队列里有货、打了待接手标记、却没人推」的会话——start() 那一次回捞推失败时就是这样。
      await kyselyPersistence(instance.agent.db, { flavor: "sqlite" }).queue.enqueue("c1", { text: "parked" }, { max: 10, onFull: "reject" });
      await durableObjectArbitration(instance.agent.db).markAwaitingTakeover?.("c1");
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, async (instance, state) => {
      const session = await instance.sessions.next();
      expect(await session.started).toBe("parked");
      await runOneTurn(session, "done");
      await settled(instance.agent.runtime, "c1");
      expect(state.storage.sql.exec("SELECT awaiting_takeover AS a FROM agent_do_ownership WHERE conversation_id = 'c1'").one()).toEqual({ a: 0 });
    });
  });

  it("跑完一轮之后对象回收得掉：运行时不留常驻定时器把它钉在内存里", async () => {
    const stub = agentObject("idle");
    expect(await stub.send("c1", "hello")).toBe("started");
    await runInDurableObject(stub, async (instance) => {
      await runOneTurn(await instance.sessions.next(), "hi");
      await settled(instance.agent.runtime, "c1");
    });
    // 挂着一个 setTimeout / setInterval 的对象在这里会卡到超时（workerd 的行为）。
    await evictDurableObject(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, async (instance) => {
      expect(instance.sessions.sessions).toHaveLength(0);
      expect((await ledger(instance.agent.runtime, "c1")).map((m) => m.role)).toEqual(["user", "assistant"]);
    });
  });
});
