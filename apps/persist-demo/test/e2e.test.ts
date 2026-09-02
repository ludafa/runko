/**
 * 端到端：**从 HTTP 请求打到库里**，两种方言各跑一遍同一套。
 *
 * 这一套跟 `@runko/conformance` 那套是**两回事**，各管一段：
 *
 * | | 一致性套件 | 本文件 |
 * |---|---|---|
 * | 打在哪 | `Persistence` 接口 | HTTP 端点 |
 * | 证明什么 | 三个 Store 的承诺各自成立 | 装起来之后**整条链路**真的跑得通 |
 * | 覆盖 | 单个方法的不变量 | 起轮 → 落盘 → 回放 → 排队 → 出队 → 重启 |
 *
 * 接口全对不代表装起来能用——中间还有装配、`recover()`、SSE 序列化、以及「重启之后
 * 换一个连接还读不读得回来」。那些只有 e2e 能证。
 *
 * **不起真端口**：直接对 `app.request()` 打（Hono 原生能力）。快，而且没有端口冲突。
 */
import type { RunkoUIMessage } from "@runko/core";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";

import type { DemoApp } from "../src/app.js";
import { createDemoApp } from "../src/app.js";
import type { DriverKind } from "../src/driver.js";
import { gatedModel, scriptedModel } from "../src/model.js";

/**
 * 四种库跑同一套用例——**含一个非关系型的**——「换实现不改行为」这个承诺在**整条链路**上也要成立。
 *
 * SQLite 永远跑（`:memory:`，零外部依赖）；Postgres / MySQL 给了连接串才跑，没给就
 * 只跑 SQLite 那一档——不是静默跳过，这里写清楚了怎么带上它们：
 *
 * ```sh
 * RUNKO_TEST_POSTGRES_URL=postgres://runko:runko@127.0.0.1:5433/runko \
 * RUNKO_TEST_MYSQL_URL=mysql://root:runko@127.0.0.1:3307/runko \
 *   pnpm --filter @runko-demo/persist-demo test
 * ```
 */
const DIALECTS: { name: string; kind: DriverKind; url?: string }[] = [
  { name: "sqlite (:memory:)", kind: "memory" },
  ...(process.env["RUNKO_TEST_POSTGRES_URL"] !== undefined
    ? [{ name: "postgres (真库)", kind: "postgres" as const, url: process.env["RUNKO_TEST_POSTGRES_URL"] }]
    : []),
  ...(process.env["RUNKO_TEST_MYSQL_URL"] !== undefined
    ? [{ name: "mysql (真库)", kind: "mysql" as const, url: process.env["RUNKO_TEST_MYSQL_URL"] }]
    : []),
  ...(process.env["RUNKO_TEST_MONGO_URL"] !== undefined
    ? [{ name: "mongo (真库)", kind: "mongo" as const, url: `${process.env["RUNKO_TEST_MONGO_URL"]}/persist_demo_e2e` }]
    : []),
];

interface Conversation {
  id: string;
  title: string;
}

interface MessagesBody {
  frames: { seq: number; message: RunkoUIMessage }[];
}

function textOf(message: RunkoUIMessage): string {
  return message.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

/**
 * 等到这个会话不再有轮在跑。假模型是同步的，但收尾仍是异步的。
 *
 * ⚠️ **只在「就一轮」的场景下够用。** 有[排队](../../../docs/terms.md)时它不可靠：
 * 第一轮收尾到自动出队起第二轮之间有一个空窗，那一瞬 `active` 就是 `false`，这个
 * 函数会提前返回。走网络的 Postgres/MySQL 上那个窗更宽，必踩。
 * 那种场景用下面的 `waitForMessages` —— **断言最终状态，别断言中间信号**。
 */
async function settle(demo: DemoApp, id: string): Promise<void> {
  await expect
    .poll(async () => (await demo.runtime.getActivity(id)).active, { timeout: 5_000 })
    .toBe(false);
}

/** 等账本攒够 `count` 条。多轮场景下用它替代 `settle`，理由见上。 */
async function waitForMessages(demo: DemoApp, id: string, count: number): Promise<void> {
  await expect
    .poll(
      async () => {
        const res = await demo.app.request(`/api/chat/conversations/${id}/messages`);
        return ((await res.json()) as MessagesBody).frames.length;
      },
      { timeout: 10_000 },
    )
    .toBe(count);
}

describe.each(DIALECTS)("persist-demo e2e · $name", ({ kind, url }) => {
  const open = async (
    opts: { queueMax?: number; reply?: string; createModel?: () => LanguageModel } = {},
  ): Promise<DemoApp> =>
    await createDemoApp({
      kind,
      ...(url !== undefined ? { url } : {}),
      createModel: opts.createModel ?? (() => scriptedModel(opts.reply ?? "好的，我记下了。")),
      ...(opts.queueMax !== undefined ? { queueMax: opts.queueMax } : {}),
    });

  const opened: DemoApp[] = [];
  const openTracked = async (opts?: Parameters<typeof open>[0]): Promise<DemoApp> => {
    const demo = await open(opts);
    opened.push(demo);
    return demo;
  };

  afterEach(async () => {
    for (const demo of opened.splice(0)) {
      await demo.close();
    }
  });

  const createConversation = async (demo: DemoApp, title = "测试会话"): Promise<string> => {
    const res = await demo.app.request("/api/chat/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as Conversation).id;
  };

  const postMessage = async (
    demo: DemoApp,
    id: string,
    text: string,
    intent?: "queue" | "steer",
  ): Promise<Response> =>
    await demo.app.request(`/api/chat/conversations/${id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, ...(intent !== undefined ? { intent } : {}) }),
    });

  const readMessages = async (demo: DemoApp, id: string, after?: number): Promise<MessagesBody> => {
    const query = after === undefined ? "" : `?after=${String(after)}`;
    const res = await demo.app.request(`/api/chat/conversations/${id}/messages${query}`);
    expect(res.status).toBe(200);
    return (await res.json()) as MessagesBody;
  };

  // -------------------------------------------------------------------------

  it("建会话 → 起轮 → 账本里既有用户消息也有 assistant 回复", async () => {
    const demo = await openTracked();
    const id = await createConversation(demo);

    const started = await postMessage(demo, id, "你好");
    expect(started.status).toBe(202);
    expect(await started.json()).toEqual({ mode: "started" });

    await settle(demo, id);

    const { frames } = await readMessages(demo, id);
    const roles = frames.map((f) => f.message.role);
    expect(roles).toEqual(["user", "assistant"]);
    expect(textOf(frames[0]!.message)).toBe("你好");
    expect(textOf(frames[1]!.message)).toBe("好的，我记下了。");
    // seq 单调递增。
    expect(frames.map((f) => f.seq)).toEqual([1, 2]);
  });

  it("`?after=<seq>` 断线续传——不含自身", async () => {
    const demo = await openTracked();
    const id = await createConversation(demo);
    await postMessage(demo, id, "第一句");
    await settle(demo, id);

    const all = await readMessages(demo, id);
    const firstSeq = all.frames[0]!.seq;
    const rest = await readMessages(demo, id, firstSeq);

    expect(rest.frames.map((f) => f.seq)).toEqual(all.frames.slice(1).map((f) => f.seq));
  });

  it("会话不存在时回 404（这是 demo 自己的产品数据，框架不知道）", async () => {
    const demo = await openTracked();
    expect((await demo.app.request("/api/chat/conversations/根本没有/messages")).status).toBe(404);
    expect((await postMessage(demo, "根本没有", "喂")).status).toBe(404);
  });

  it("列会话读得到刚建的那条", async () => {
    const demo = await openTracked();
    const id = await createConversation(demo, "起个名字");

    const res = await demo.app.request("/api/chat/conversations");
    const body = (await res.json()) as { conversations: Conversation[] };
    expect(body.conversations.map((c) => c.id)).toContain(id);
    expect(body.conversations.find((c) => c.id === id)?.title).toBe("起个名字");
  });

  it("SSE 先回放历史再收线（follow=turn，没有轮在跑时回放完即收）", async () => {
    const demo = await openTracked();
    const id = await createConversation(demo);
    await postMessage(demo, id, "先说一句");
    await settle(demo, id);

    const res = await demo.app.request(`/api/chat/conversations/${id}/stream`);
    expect(res.status).toBe(200);
    const body = await res.text();

    // 两条成品消息各一帧，外加队列快照与轮状态快照各一帧。
    expect(body).toContain("event: message");
    expect(body).toContain("event: queue");
    expect(body).toContain("event: turn-state");
    expect(body).toContain("先说一句");
  });

  it("队列：满了回 409 且不吞消息", async () => {
    // max=1 让第二条必定排队、第三条必定满。
    //
    // **闸门模型是必需的**：这条用例要求后两条消息到达时第一轮**仍在跑**。靠「假模型
    // 很快」是侥幸——走网络的 Postgres/MySQL 上，往返延迟足够让第一轮先跑完，第二条
    // 就去起新轮了。闸门把「还在跑」变成确定事实。
    const gate = gatedModel("好的，我记下了。");
    const demo = await openTracked({ queueMax: 1, createModel: () => gate.model });
    const id = await createConversation(demo);

    await postMessage(demo, id, "起轮的这条");
    const queued = await postMessage(demo, id, "排队的这条");
    expect(queued.status).toBe(202);
    expect(await queued.json()).toEqual({ mode: "queued" });

    const overflow = await postMessage(demo, id, "溢出的这条");
    expect(overflow.status).toBe(409);
    expect(await overflow.json()).toMatchObject({ mode: "rejected", reason: "queue_full" });

    gate.release();
    // 两轮 × (user + assistant) = 4 条。**等这个，不等 `active === false`**——见 `settle` 上的注释。
    await waitForMessages(demo, id, 4);
    const { frames } = await readMessages(demo, id);
    expect(frames.map((f) => textOf(f.message))).toEqual([
      "起轮的这条",
      "好的，我记下了。",
      "排队的这条",
      "好的，我记下了。",
    ]);
    // 溢出那条**没被吞掉也没进账本**——它是被明确拒绝的。
    expect(frames.map((f) => textOf(f.message))).not.toContain("溢出的这条");
  });

  it("队列可读可删", async () => {
    // 同上：不卡住第一轮的话，「排队甲」可能已经被自动出队起了第二轮，删就 404 了。
    const gate = gatedModel("好的，我记下了。");
    const demo = await openTracked({ queueMax: 5, createModel: () => gate.model });
    const id = await createConversation(demo);
    await postMessage(demo, id, "起轮");
    await postMessage(demo, id, "排队甲");

    const listed = await demo.app.request(`/api/chat/conversations/${id}/queue`);
    const body = (await listed.json()) as { queue: { id: string; input: { text: string } }[] };
    expect(body.queue.map((q) => q.input.text)).toEqual(["排队甲"]);

    const removed = await demo.app.request(
      `/api/chat/conversations/${id}/queue/${body.queue[0]!.id}`,
      { method: "DELETE" },
    );
    expect(removed.status).toBe(200);
    expect((await removed.json() as { queue: unknown[] }).queue).toEqual([]);

    // 删不存在的给 404。
    const missing = await demo.app.request(
      `/api/chat/conversations/${id}/queue/根本没有这个`,
      { method: "DELETE" },
    );
    expect(missing.status).toBe(404);

    gate.release();
    await settle(demo, id);
  });

  it("裁决端点：没有这条挂起项时回 404（不是 500）", async () => {
    const demo = await openTracked();
    const id = await createConversation(demo);

    const res = await demo.app.request(`/api/chat/conversations/${id}/approvals/根本没有`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ behavior: "allow" }),
    });
    expect(res.status).toBe(404);
  });

  it("activity 是服务端的权威答案，不是前端猜的", async () => {
    const demo = await openTracked();
    const id = await createConversation(demo);
    await postMessage(demo, id, "跑一下");
    await settle(demo, id);

    const res = await demo.app.request(`/api/chat/conversations/${id}/activity`);
    expect(await res.json()).toMatchObject({ active: false });
  });
});

// ---------------------------------------------------------------------------
// 跨进程：持久化这三个字的全部意义
// ---------------------------------------------------------------------------

describe("persist-demo e2e · 重启之后还在", () => {
  it("换一个进程（新连接、新 runtime）仍读得回账本与会话", async () => {
    const file = `${String(process.env["TMPDIR"] ?? "/tmp")}/persist-demo-${crypto.randomUUID()}.db`;

    // ---- 第一个「进程」----
    const first = await createDemoApp({
      kind: "sqlite",
      path: file,
      createModel: () => scriptedModel("重启前说的话"),
    });
    const created = await first.app.request("/api/chat/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "跨重启" }),
    });
    const { id } = (await created.json()) as Conversation;

    await first.app.request(`/api/chat/conversations/${id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "重启前发的" }),
    });
    await expect
      .poll(async () => (await first.runtime.getActivity(id)).active, { timeout: 5_000 })
      .toBe(false);
    await first.close();

    // ---- 第二个「进程」：同一个库文件，全新的连接与 runtime ----
    const second = await createDemoApp({
      kind: "sqlite",
      path: file,
      createModel: () => scriptedModel("重启后说的话"),
    });

    // 会话还在（demo 自己那张表）。
    const listed = await second.app.request("/api/chat/conversations");
    const conversations = ((await listed.json()) as { conversations: Conversation[] }).conversations;
    expect(conversations.map((c) => c.id)).toContain(id);

    // 账本还在（runko 的那三张表）。
    const res = await second.app.request(`/api/chat/conversations/${id}/messages`);
    const { frames } = (await res.json()) as MessagesBody;
    expect(frames.map((f) => textOf(f.message))).toEqual(["重启前发的", "重启前说的话"]);

    // 而且能接着往下写——新的一轮的 seq 从旧的最大值往后排，不覆盖历史。
    await second.app.request(`/api/chat/conversations/${id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "重启后发的" }),
    });
    await expect
      .poll(async () => (await second.runtime.getActivity(id)).active, { timeout: 5_000 })
      .toBe(false);

    const after = (await (
      await second.app.request(`/api/chat/conversations/${id}/messages`)
    ).json()) as MessagesBody;
    expect(after.frames.map((f) => textOf(f.message))).toEqual([
      "重启前发的",
      "重启前说的话",
      "重启后发的",
      "重启后说的话",
    ]);
    expect(after.frames.map((f) => f.seq)).toEqual([1, 2, 3, 4]);

    await second.close();
  });
});
