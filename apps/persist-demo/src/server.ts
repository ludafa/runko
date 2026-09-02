/**
 * HTTP 层。**本文件只做翻译**：把请求变成 `runtime.*` 的一次调用，把 `Frame` 序列化
 * 成 SSE。排队、插话、竞态、崩溃恢复全在 `@runko/agent` 里，这里一行都没有。
 *
 * 端点形状**刻意对齐 `apps/node-server`**（去掉认证/沙盒/推送/遥测这些跟持久化无关的）：
 *
 * | 方法 | 路径 | 干什么 |
 * |---|---|---|
 * | POST | `/api/chat/conversations` | 建会话 |
 * | GET | `/api/chat/conversations` | 列会话 |
 * | GET | `/api/chat/conversations/:id/messages` | 回放[账本](../../../docs/terms.md)（`?after=<seq>` 续传） |
 * | POST | `/api/chat/conversations/:id/messages` | 起轮 / 排队 / 插话 |
 * | GET | `/api/chat/conversations/:id/stream` | SSE：先回放再直播 |
 * | GET | `/api/chat/conversations/:id/queue` | 看[待发队列](../../../docs/terms.md) |
 * | DELETE | `/api/chat/conversations/:id/queue/:messageId` | 删队列里某条 |
 * | POST | `/api/chat/conversations/:id/abort` | [停止](../../../docs/terms.md)这一轮 |
 * | POST | `/api/chat/conversations/:id/approvals/:callId` | 人做裁决 |
 * | POST | `/api/chat/conversations/:id/questions/:callId` | 回答 `ask-user` |
 *
 * 对齐一个**已经写死的**契约是刻意的：demo 是我们自己写的，天然有「不自觉迁就包的
 * 能力」的风险；照着别人定好的形状写，包做不到的地方会当场暴露。
 */
import type { AgentRuntime, Frame } from "@runko/agent";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import type { DemoStore } from "./store.js";

export interface ServerDeps {
  runtime: AgentRuntime;
  store: DemoStore;
}

/** `Frame` → SSE 的 event 名。四种帧靠自己带的字段区分，跟 node-server 同款。 */
function eventName(frame: Frame): string {
  switch (frame.kind) {
    case "message":
      return "message";
    case "chunk":
      return "chunk";
    case "queue":
      return "queue";
    case "activity":
      return "turn-state";
  }
}

export function createServer(deps: ServerDeps): Hono {
  const app = new Hono();
  const { runtime, store } = deps;

  /** 会话不存在就 404——这是 demo 自己的产品数据，框架不知道会话存不存在。 */
  const requireConversation = async (id: string): Promise<boolean> =>
    (await store.get(id)) !== undefined;

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/api/chat/conversations", async (c) => {
    const body = await c.req.json<{ title?: string }>().catch(() => ({}) as { title?: string });
    const row = await store.create(body.title?.trim() ?? "新会话");
    return c.json(row, 201);
  });

  app.get("/api/chat/conversations", async (c) => c.json({ conversations: await store.list() }));

  app.get("/api/chat/conversations/:id/messages", async (c) => {
    const id = c.req.param("id");
    if (!(await requireConversation(id))) {
      return c.json({ error: "Not found" }, 404);
    }
    const after = c.req.query("after");
    const entries = await runtime.readLedger(
      id,
      after === undefined ? {} : { afterSeq: Number(after) },
    );
    return c.json({ frames: entries.map((e) => ({ seq: e.seq, message: e.message })) });
  });

  app.post("/api/chat/conversations/:id/messages", async (c) => {
    const id = c.req.param("id");
    if (!(await requireConversation(id))) {
      return c.json({ error: "Not found" }, 404);
    }
    const body = await c.req.json<{ text?: string; userId?: string; intent?: "queue" | "steer" }>();
    const text = body.text?.trim();
    if (text === undefined || text.length === 0) {
      return c.json({ error: "text is required" }, 400);
    }

    const result = await runtime.enqueue(
      id,
      { text, ...(body.userId !== undefined ? { userId: body.userId } : {}) },
      body.intent !== undefined ? { intent: body.intent } : {},
    );
    if (result.mode === "rejected") {
      // 四种拒绝原因处置不同：队列满 409、正在关闭 503、归属在别的节点 421。
      const status = result.reason === "queue_full" ? 409 : result.reason === "shutting_down" ? 503 : 421;
      return c.json({ mode: result.mode, reason: result.reason, message: result.message }, status);
    }
    return c.json({ mode: result.mode }, 202);
  });

  app.get("/api/chat/conversations/:id/stream", async (c) => {
    const id = c.req.param("id");
    if (!(await requireConversation(id))) {
      return c.json({ error: "Not found" }, 404);
    }
    const after = c.req.query("after");
    const follow = c.req.query("follow") === "forever" ? "forever" : "turn";

    return streamSSE(c, async (sse) => {
      // 客户端断开就把 `subscribe` 收掉——不然这个生成器会一直挂着。
      const controller = new AbortController();
      sse.onAbort(() => {
        controller.abort();
      });
      for await (const frame of runtime.subscribe(id, {
        ...(after === undefined ? {} : { after: Number(after) }),
        follow,
        signal: controller.signal,
      })) {
        await sse.writeSSE({ event: eventName(frame), data: JSON.stringify(frame) });
      }
    });
  });

  app.get("/api/chat/conversations/:id/queue", async (c) =>
    c.json({ queue: await runtime.listQueue(c.req.param("id")) }),
  );

  app.delete("/api/chat/conversations/:id/queue/:messageId", async (c) => {
    const result = await runtime.removeQueued(c.req.param("id"), c.req.param("messageId"));
    return result.removed ? c.json({ queue: result.queue }) : c.json({ error: "Not found" }, 404);
  });

  app.delete("/api/chat/conversations/:id/queue", async (c) =>
    c.json({ queue: await runtime.clearQueue(c.req.param("id")) }),
  );

  app.post("/api/chat/conversations/:id/abort", async (c) => {
    const aborted = await runtime.abort(c.req.param("id"), "user");
    return c.json({ aborted });
  });

  app.get("/api/chat/conversations/:id/activity", async (c) =>
    c.json(await runtime.getActivity(c.req.param("id"))),
  );

  app.post("/api/chat/conversations/:id/approvals/:callId", async (c) => {
    const body = await c.req.json<{ behavior?: "allow" | "allow-session" | "deny"; message?: string }>();
    const behavior = body.behavior ?? "allow";
    const resolved = await runtime.submitDecision(c.req.param("id"), c.req.param("callId"), {
      outcome: behavior === "deny" ? "deny" : "allow",
      // wire 上说的是「用户点了哪个按钮」，框架记的是**范围**——两层各用各的词。
      scope: behavior === "allow-session" ? "conversation" : "once",
      ...(body.message !== undefined ? { message: body.message } : {}),
    });
    return resolved ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404);
  });

  app.post("/api/chat/conversations/:id/questions/:callId", async (c) => {
    const body = await c.req.json<{ answer?: string }>();
    const resolved = await runtime.submitAnswer(
      c.req.param("id"),
      c.req.param("callId"),
      body.answer ?? "",
    );
    return resolved ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404);
  });

  return app;
}
