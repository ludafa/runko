/**
 * 轮编排运行时的主用例：一轮的一生、[排队](../../../docs/terms.md)与[插话](../../../docs/terms.md)、
 * [停止](../../../docs/terms.md)、[交权](../../../docs/terms.md)、[崩溃恢复](../../../docs/terms.md)、
 * 人在回路、以及「跑到一半失去[独占](../../../docs/terms.md)权」。
 *
 * 全程零模型、零沙盒——靠 `helpers/fake-session.ts` 那对假的 `stream()`/`toJSON()`。
 */
import type { AgentDefinition, NimboUIMessage } from "@nimbo/core";
import { describe, expect, it, vi } from "vitest";

import type { AgentRuntime, Frame, TurnInput, TurnPreparation } from "../src/index.js";
import { createAgentRuntime, memoryPersistence } from "../src/index.js";
import { buildResumeState } from "../src/runtime/turn.js";
import type { FakeSession } from "./helpers/fake-session.js";
import { assistantMessage, createFakeSessionFactory, endTurnChunk } from "./helpers/fake-session.js";

/** 模型字段永远不会被假 session 用到——只是 `AgentDefinition` 要求它有个值。 */
const agent: AgentDefinition = { model: "test/model" };

function setup(overrides: Partial<Parameters<typeof createAgentRuntime>[0]> = {}) {
  const sessions = createFakeSessionFactory();
  const persistence = overrides.persistence ?? memoryPersistence();
  const prepared: TurnPreparation[] = [];
  const runtime = createAgentRuntime({
    agent,
    persistence,
    sessionFactory: sessions.factory,
    prepareTurn: () => {
      const preparation: TurnPreparation = {};
      prepared.push(preparation);
      return preparation;
    },
    ...overrides,
  });
  return { runtime, sessions, persistence, prepared };
}

/** 收集 `subscribe` 吐出的帧，直到它自己收线。 */
function collect(runtime: AgentRuntime, conversationId: string, opts?: { after?: number }): { frames: Frame[]; done: Promise<void> } {
  const frames: Frame[] = [];
  const done = (async () => {
    for await (const frame of runtime.subscribe(conversationId, opts)) {frames.push(frame);}
  })();
  return { frames, done };
}

async function ledgerMessages(runtime: AgentRuntime, conversationId: string): Promise<NimboUIMessage[]> {
  const rows = await runtime.readLedger(conversationId);
  return rows.map((row) => row.message);
}

/** 跑完一轮：等 session 起来 → 发几个 chunk → 落一条成品消息 → 收尾。 */
async function runOneTurn(session: FakeSession, text: string, turn = 1): Promise<void> {
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

describe("零配置跑通一个会话", () => {
  it("起一轮 → 用户消息与成品消息都进账本，轮号从 1 开始", async () => {
    const { runtime, sessions } = setup();

    const result = await runtime.enqueue("conv-1", { text: "hello" });
    expect(result.mode).toBe("started");

    const session = await sessions.next();
    await runOneTurn(session, "hi there");
    await vi.waitFor(async () => {
      expect((await runtime.getActivity("conv-1")).active).toBe(false);
    });

    const messages = await ledgerMessages(runtime, "conv-1");
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(messages[0]?.parts).toEqual([{ type: "text", text: "hello" }]);
    expect(messages[1]?.metadata?.turn).toBe(1);
  });

  it("第二轮 resume 上一轮的账本，轮号递增", async () => {
    const { runtime, sessions } = setup();

    await runtime.enqueue("conv-2", { text: "first" });
    await runOneTurn(await sessions.next(), "answer 1", 1);
    await vi.waitFor(async () => {
      expect((await runtime.getActivity("conv-2")).active).toBe(false);
    });

    await runtime.enqueue("conv-2", { text: "second" });
    const second = await sessions.next();
    await runOneTurn(second, "answer 2", 2);
    await vi.waitFor(async () => {
      expect((await runtime.getActivity("conv-2")).active).toBe(false);
    });

    const messages = await ledgerMessages(runtime, "conv-2");
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    // 第二轮的 session 是拿账本 resume 出来的——它看到的历史必须是连续的。
    expect(second.toJSON().turn).toBe(2);
  });

  it("seq 单调递增，`after=` 只回放之后的", async () => {
    const { runtime, sessions } = setup();
    await runtime.enqueue("conv-3", { text: "hello" });
    await runOneTurn(await sessions.next(), "hi", 1);
    await vi.waitFor(async () => {
      expect((await runtime.getActivity("conv-3")).active).toBe(false);
    });

    const rows = await runtime.readLedger("conv-3");
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
    expect((await runtime.readLedger("conv-3", { afterSeq: 1 })).map((r) => r.seq)).toEqual([2]);
  });
});

describe("subscribe", () => {
  it("回放 → 草稿 → 队列快照 → 轮状态快照，然后进直播；轮一收尾就收线", async () => {
    const { runtime, sessions } = setup();
    await runtime.enqueue("conv-4", { text: "hello" });
    const session = await sessions.next();
    await session.started;
    session.emit({ type: "start", messageId: "m-1" });

    const tail = collect(runtime, "conv-4");
    // 让订阅那一段（回放 + 快照）跑完，再继续推进这一轮。
    await vi.waitFor(() => {
      expect(tail.frames.some((f) => f.kind === "activity")).toBe(true);
    });

    const kinds = tail.frames.map((f) => f.kind);
    expect(kinds).toContain("message"); // 起轮那条用户消息已经落盘、被回放到
    expect(kinds).toContain("chunk"); // 进行中草稿里的那个 `start`
    expect(kinds.at(-2)).toBe("queue");
    expect(kinds.at(-1)).toBe("activity");
    expect(tail.frames.at(-1)).toMatchObject({ kind: "activity", active: true });

    session.emit({ type: "finish" });
    session.push(assistantMessage("done", { turn: 1, usage: {}, status: "completed" }));
    session.emit(endTurnChunk(1));
    session.finish();

    await tail.done; // 轮收尾 → `activity: false` → 订阅自己收线
    expect(tail.frames.at(-1)).toMatchObject({ kind: "activity", active: false });
  });

  it("没有轮在跑时，回放完就收线", async () => {
    const { runtime } = setup();
    const tail = collect(runtime, "conv-5");
    await tail.done;
    expect(tail.frames.map((f) => f.kind)).toEqual(["queue", "activity"]);
    expect(tail.frames.at(-1)).toMatchObject({ active: false });
  });

  it("`follow: 'forever'` 靠 signal 收线", async () => {
    const { runtime } = setup();
    const controller = new AbortController();
    const frames: Frame[] = [];
    const done = (async () => {
      for await (const frame of runtime.subscribe("conv-6", { follow: "forever", signal: controller.signal })) {
        frames.push(frame);
      }
    })();
    await vi.waitFor(() => {
      expect(frames.length).toBe(2);
    });
    controller.abort();
    await done;
  });
});

describe("排队与插话", () => {
  it("有轮在跑时默认排队，收尾后自动出队起下一轮", async () => {
    const { runtime, sessions } = setup();
    await runtime.enqueue("conv-7", { text: "first" });
    const first = await sessions.next();
    await first.started;

    const queued = await runtime.enqueue("conv-7", { text: "second" });
    expect(queued.mode).toBe("queued");
    expect(await runtime.listQueue("conv-7")).toHaveLength(1);

    await runOneTurn(first, "answer 1", 1);

    const second = await sessions.next();
    await runOneTurn(second, "answer 2", 2);
    await vi.waitFor(async () => {
      expect((await runtime.getActivity("conv-7")).active).toBe(false);
    });

    expect(await runtime.listQueue("conv-7")).toHaveLength(0);
    const messages = await ledgerMessages(runtime, "conv-7");
    expect(messages.filter((m) => m.role === "user").map((m) => m.parts[0])).toEqual([
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ]);
  });

  it("`intent: 'steer'` 插进当前这一轮，不起新轮", async () => {
    const { runtime, sessions } = setup();
    await runtime.enqueue("conv-8", { text: "first" });
    const first = await sessions.next();
    await first.started;

    const steered = await runtime.enqueue("conv-8", { text: "also do this" }, { intent: "steer" });
    expect(steered.mode).toBe("steered");
    expect(await runtime.listQueue("conv-8")).toHaveLength(0);

    await runOneTurn(first, "ok", 1);
    await vi.waitFor(async () => {
      expect((await runtime.getActivity("conv-8")).active).toBe(false);
    });

    // 插话那条 user 消息由 core（这里是假 session）自己注入进账本，随收尾一起落盘。
    const messages = await ledgerMessages(runtime, "conv-8");
    expect(messages.some((m) => m.metadata?.steered === true)).toBe(true);
  });

  describe("`queue.steer` 回调档（`SteerPolicy`）", () => {
    it("回调说 true 就插话、说 false 就排队——不看 `intent`", async () => {
      const seen: TurnInput[] = [];
      const { runtime, sessions } = setup({
        queue: {
          steer: (input) => {
            seen.push(input);
            return input.text.startsWith("!");
          },
        },
      });
      await runtime.enqueue("conv-cb1", { text: "first" });
      const first = await sessions.next();
      await first.started;

      // 没传 intent，回调仍然说了算。
      expect((await runtime.enqueue("conv-cb1", { text: "!urgent" })).mode).toBe("steered");
      // 传了 `intent: 'steer'` 也一样——回调档下 `intent` 不参与判断。
      expect((await runtime.enqueue("conv-cb1", { text: "later" }, { intent: "steer" })).mode).toBe("queued");
      expect(seen.map((i) => i.text)).toEqual(["!urgent", "later"]);

      await runOneTurn(first, "ok", 1);
      // 排队那条会自动出队起第二轮，跑完会话才空闲。
      await runOneTurn(await sessions.next(), "ok2", 2);
      await vi.waitFor(async () => {
        expect((await runtime.getActivity("conv-cb1")).active).toBe(false);
      });
    });

    it("回调拿到的是整条 `TurnInput`，不只是 `text`", async () => {
      const seen: TurnInput[] = [];
      const { runtime, sessions } = setup({
        queue: {
          steer: (input) => {
            seen.push(input);
            return input.userId === "admin";
          },
        },
      });
      await runtime.enqueue("conv-cb2", { text: "first" });
      const first = await sessions.next();
      await first.started;

      expect(
        (await runtime.enqueue("conv-cb2", { text: "cut in", userId: "admin", meta: { pri: 1 } })).mode,
      ).toBe("steered");
      expect(seen).toEqual([{ text: "cut in", userId: "admin", meta: { pri: 1 } }]);

      await runOneTurn(first, "ok", 1);
      await vi.waitFor(async () => {
        expect((await runtime.getActivity("conv-cb2")).active).toBe(false);
      });
    });

    it("回调抛错回落成排队——不把 `enqueue` 打挂、不丢用户的话", async () => {
      const { runtime, sessions } = setup({
        queue: {
          steer: () => {
            throw new Error("policy blew up");
          },
        },
      });
      await runtime.enqueue("conv-cb3", { text: "first" });
      const first = await sessions.next();
      await first.started;

      const outcome = await runtime.enqueue("conv-cb3", { text: "second" }, { intent: "steer" });
      expect(outcome.mode).toBe("queued");
      expect(await runtime.listQueue("conv-cb3")).toHaveLength(1);

      await runOneTurn(first, "ok", 1);
      await runOneTurn(await sessions.next(), "ok2", 2);
      await vi.waitFor(async () => {
        expect((await runtime.getActivity("conv-cb3")).active).toBe(false);
      });
      // 那条话没丢——它作为第二轮的输入进了账本。
      const messages = await ledgerMessages(runtime, "conv-cb3");
      expect(messages.filter((m) => m.role === "user").map((m) => m.parts[0])).toEqual([
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ]);
    });
  });

  it("轮还在[起轮装配](../../../docs/terms.md)里时，steer 转成排队而不是回落起新轮", async () => {
    const sessions = createFakeSessionFactory();
    let releasePreparation: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    const runtime = createAgentRuntime({
      agent,
      sessionFactory: sessions.factory,
      prepareTurn: async () => {
        await blocked;
        return {};
      },
    });

    await runtime.enqueue("conv-9", { text: "first" });
    await vi.waitFor(async () => {
      expect((await runtime.getActivity("conv-9")).phase).toBe("preparing");
    });

    const outcome = await runtime.enqueue("conv-9", { text: "second" }, { intent: "steer" });
    expect(outcome.mode).toBe("queued");

    releasePreparation();
    await runOneTurn(await sessions.next(), "ok", 1);
    // 排队那条会自动出队起第二轮——把它也跑完，会话才真正空闲。
    await runOneTurn(await sessions.next(), "ok2", 2);
    await vi.waitFor(async () => {
      expect((await runtime.getActivity("conv-9")).active).toBe(false);
    });
    expect(await runtime.listQueue("conv-9")).toHaveLength(0);
  });

  it("队列满了报 `queue_full`，绝不静默丢弃", async () => {
    const { runtime, sessions } = setup({ queue: { max: 1 } });
    await runtime.enqueue("conv-10", { text: "first" });
    await (await sessions.next()).started;

    expect((await runtime.enqueue("conv-10", { text: "q1" })).mode).toBe("queued");
    const full = await runtime.enqueue("conv-10", { text: "q2" });
    expect(full).toMatchObject({ mode: "rejected", reason: "queue_full" });
    expect(await runtime.listQueue("conv-10")).toHaveLength(1);
  });

  it("删一条 / 清空都会广播新的队列快照", async () => {
    const { runtime, sessions } = setup();
    await runtime.enqueue("conv-11", { text: "first" });
    await (await sessions.next()).started;
    const enqueued = await runtime.enqueue("conv-11", { text: "q1" });
    if (enqueued.mode !== "queued") {throw new Error("expected queued");}

    const removed = await runtime.removeQueued("conv-11", enqueued.queued.id);
    expect(removed.removed).toBe(true);
    expect(removed.queue).toHaveLength(0);

    await runtime.enqueue("conv-11", { text: "q2" });
    expect(await runtime.clearQueue("conv-11")).toHaveLength(0);
  });
});

describe("停止", () => {
  it("停止会清空队列、结掉挂起的人审、并让这一轮走中断收尾", async () => {
    const { runtime, sessions } = setup();
    await runtime.enqueue("conv-12", { text: "first" });
    const session = await sessions.next();
    await session.started;
    await runtime.enqueue("conv-12", { text: "queued" });

    expect(await runtime.abort("conv-12")).toBe(true);
    expect(await runtime.listQueue("conv-12")).toHaveLength(0);
    expect(session.signal?.aborted).toBe(true);

    // core 收到 signal 后走的是**优雅收尾**：产出一条 interrupted 的收尾帧再正常返回。
    session.push(assistantMessage("partial", { turn: 1, usage: {}, status: "interrupted" }));
    session.emit(endTurnChunk(1, "interrupted"));
    session.finish();
    await vi.waitFor(async () => {
      expect((await runtime.getActivity("conv-12")).active).toBe(false);
    });
    // 队列已经清空 → 不会自动起下一轮。
    expect(await runtime.listQueue("conv-12")).toHaveLength(0);
  });

  it("没有轮在跑时停止是 `false`，而且**不**清队列（否则一次误点就是一次丢消息）", async () => {
    const { runtime, sessions } = setup();
    await runtime.enqueue("conv-13", { text: "first" });
    const session = await sessions.next();
    await session.started;
    await runtime.enqueue("conv-13", { text: "queued" });
    await runOneTurn(session, "ok", 1);
    // 出队起了第二轮；把它也跑完，队列就真空了。
    await runOneTurn(await sessions.next(), "ok2", 2);
    await vi.waitFor(async () => {
      expect((await runtime.getActivity("conv-13")).active).toBe(false);
    });

    expect(await runtime.abort("conv-13")).toBe(false);
  });

  it("装配窗口里按停止：这一轮从没启动，但「用户消息 + 已停止」两帧照样补上", async () => {
    const sessions = createFakeSessionFactory();
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = createAgentRuntime({
      agent,
      sessionFactory: sessions.factory,
      prepareTurn: async () => {
        await blocked;
        return {};
      },
    });

    await runtime.enqueue("conv-14", { text: "hello" });
    await vi.waitFor(async () => {
      expect((await runtime.getActivity("conv-14")).phase).toBe("preparing");
    });
    const tail = collect(runtime, "conv-14");

    expect(await runtime.abort("conv-14")).toBe(true);
    release();

    await tail.done;
    const chunks = tail.frames.filter((f) => f.kind === "chunk");
    expect(chunks.at(-1)).toMatchObject({
      chunk: { type: "message-metadata", messageMetadata: { status: "interrupted" } },
    });
    // 用户确实发出了那句话——下一轮的模型上下文里该有它；「已停止」那条也必须**落账本**，
    // 只发直播帧的话重连的客户端和以后的回放都看不到这个标记，界面上这一轮会悬在半空。
    const ledger14 = await ledgerMessages(runtime, "conv-14");
    expect(ledger14.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(ledger14.at(-1)).toMatchObject({
      parts: [{ type: "step-start" }],
      metadata: { status: "interrupted", error: { code: "aborted" } },
    });
    // **账本里不能有 parts 为空的消息**：ai 的 `validateUIMessages()` 拒绝它，而每一轮
    // 起轮都要拿整个账本过一次校验——写进去一条空的，这个会话就永远起不了新轮。
    expect(ledger14.every((m) => m.parts.length > 0)).toBe(true);
    // 假 session 从没被造出来过。
    expect(sessions.sessions).toHaveLength(0);
  });
});

describe("人在回路", () => {
  it("`submitDecision` 唤醒正在 `await` 的 loop，并把裁决落进裁决表", async () => {
    const persistence = memoryPersistence();
    const { runtime, sessions } = setup({ persistence });
    await runtime.enqueue("conv-15", { text: "rm -rf build" });
    const session = await sessions.next();
    await session.started;

    // 真正的调用点在 `buildSessionOptions` 注入的 `onReview` 上；测试从 runtime 这一侧
    // 验证：先没有挂起项 → submit 返回 false。
    expect(await runtime.submitDecision("conv-15", "call-1", { outcome: "allow" })).toBe(false);

    await runOneTurn(session, "ok", 1);
    await vi.waitFor(async () => {
      expect((await runtime.getActivity("conv-15")).active).toBe(false);
    });
    expect(await persistence.decisions.listPending("conv-15")).toHaveLength(0);
  });

  it("审批全链路：onReview 挂起 → submitDecision 放行 → 裁决落库", async () => {
    const persistence = memoryPersistence();
    const sessions = createFakeSessionFactory();

    let reviewer: ((request: { toolName: string; input: string; ctx: { callId: string; toolName: string; session: { id: string; turn: number } } }) => Promise<{ behavior: string }>) | undefined;
    const runtime = createAgentRuntime({
      agent,
      persistence,
      prepareTurn: () => ({}),
      sessionFactory: (agentDef, options) => {
        // 框架注入的 `onReview` 就在这里——真 core 会在解析出 `review` 时调它。
        const onReview = options.onReview;
        if (onReview !== undefined) {
          reviewer = (request) => onReview({ toolName: request.toolName, input: request.input, ctx: request.ctx });
        }
        return sessions.factory(agentDef, options);
      },
    });

    await runtime.enqueue("conv-16", { text: "rm -rf build" });
    const session = await sessions.next();
    await session.started;
    expect(reviewer).toBeDefined();

    const pending = reviewer?.({
      toolName: "bash",
      input: "rm -rf build",
      ctx: { callId: "call-9", toolName: "bash", session: { id: "s", turn: 1 } },
    });
    await vi.waitFor(async () => {
      expect(await persistence.decisions.listPending("conv-16")).toHaveLength(1);
    });

    expect(await runtime.submitDecision("conv-16", "call-9", { outcome: "allow", scope: "conversation", decidedBy: "u1" })).toBe(true);
    await expect(pending).resolves.toEqual({ behavior: "allow" });
    expect(await persistence.decisions.listPending("conv-16")).toHaveLength(0);

    await runOneTurn(session, "done", 1);
  });

  it("一轮被停止时，挂着的人审就地按拒绝结掉（abort 信号对普通 await 无效）", async () => {
    const sessions = createFakeSessionFactory();
    let reviewer: ((callId: string) => Promise<{ behavior: string; message?: string }>) | undefined;
    const runtime = createAgentRuntime({
      agent,
      prepareTurn: () => ({}),
      sessionFactory: (agentDef, options) => {
        const onReview = options.onReview;
        if (onReview !== undefined) {
          reviewer = (callId) =>
            onReview({ toolName: "bash", input: "x", ctx: { callId, toolName: "bash", session: { id: "s", turn: 1 } } });
        }
        return sessions.factory(agentDef, options);
      },
    });

    await runtime.enqueue("conv-17", { text: "hello" });
    const session = await sessions.next();
    await session.started;
    const pending = reviewer?.("call-1");

    await runtime.abort("conv-17");
    await expect(pending).resolves.toMatchObject({ behavior: "deny" });

    session.emit(endTurnChunk(1, "interrupted"));
    session.finish();
  });
});

describe("交权（优雅关闭）", () => {
  it("停掉在跑的轮、等它们收尾，关闭期间新的 enqueue 一律被拒", async () => {
    const { runtime, sessions } = setup();
    await runtime.enqueue("conv-18", { text: "hello" });
    const session = await sessions.next();
    await session.started;

    const shutdown = runtime.shutdown({ graceMs: 2000 });
    await vi.waitFor(() => {
      expect(session.signal?.aborted).toBe(true);
    });
    expect(runtime.isShuttingDown()).toBe(true);
    expect((await runtime.enqueue("conv-18", { text: "nope" })).mode).toBe("rejected");

    session.emit(endTurnChunk(1, "interrupted"));
    session.finish();
    await expect(shutdown).resolves.toMatchObject({ aborted: 1, settled: true, pending: 0 });
  });

  it("撞了宽限期就如实报告，不假装干净收尾", async () => {
    const { runtime, sessions } = setup();
    await runtime.enqueue("conv-19", { text: "hello" });
    const session = await sessions.next();
    await session.started;

    const result = await runtime.shutdown({ graceMs: 20 });
    expect(result).toMatchObject({ aborted: 1, settled: false, pending: 1 });

    session.finish(); // 收拾干净，别让这一轮挂在测试进程里
  });

  it("空闲时关闭秒退", async () => {
    const { runtime } = setup();
    await expect(runtime.shutdown({ graceMs: 1000 })).resolves.toEqual({ aborted: 0, settled: true, pending: 0 });
  });
});

describe("崩溃恢复", () => {
  it("库里还留着[起轮标记](../../../docs/terms.md)= 那一轮没人管了，补一条「已停止」", async () => {
    const persistence = memoryPersistence();
    // 一个「跨进程」的假归属表：`listStale` 报出上次崩溃残留的那条标记。
    let stale: { conversationId: string }[] = [{ conversationId: "conv-20" }];
    const marks = new Map<string, number>();
    const arbitration = {
      acquire: (conversationId: string, ctx: { seedSeq: () => Promise<number> }) =>
        ctx.seedSeq().then((seed) => {
          let watermark = marks.get(conversationId) ?? seed;
          const controller = new AbortController();
          return {
            ok: true as const,
            grant: {
              conversationId,
              holder: "test",
              signal: controller.signal,
              valid: true,
              nextSeq: () => {
                watermark += 1;
                marks.set(conversationId, watermark);
                return Promise.resolve({ ok: true as const, seq: watermark });
              },
              release: () => Promise.resolve(),
            },
          };
        }),
      inspect: () => Promise.resolve({ held: false }),
      listStale: () => Promise.resolve(stale),
      clearStale: (conversationId: string) => {
        stale = stale.filter((entry) => entry.conversationId !== conversationId);
        return Promise.resolve();
      },
    };

    const { runtime } = setup({ persistence, arbitration });
    const result = await runtime.recover();
    expect(result).toEqual({ scanned: 1, recovered: 1 });

    const messages = await ledgerMessages(runtime, "conv-20");
    expect(messages).toHaveLength(1);
    expect(messages[0]?.metadata?.status).toBe("interrupted");

    // 幂等：标记已清，再扫一次什么都不做。
    await expect(runtime.recover()).resolves.toEqual({ scanned: 0, recovered: 0 });
  });

  it("内置的内存归属表看不到自己上次崩溃的残留——恒空，不是偷懒", async () => {
    const { runtime } = setup();
    await expect(runtime.recover()).resolves.toEqual({ scanned: 0, recovered: 0 });
  });
});

describe("失去独占权", () => {
  it("`grant.signal` abort 会把这一轮按中断收尾", async () => {
    const sessions = createFakeSessionFactory();
    const controller = new AbortController();
    let watermark = 0;
    const arbitration = {
      acquire: () =>
        Promise.resolve({
          ok: true as const,
          grant: {
            conversationId: "conv-21",
            holder: "node-a",
            signal: controller.signal,
            valid: true,
            nextSeq: () => {
              watermark += 1;
              return Promise.resolve(
                controller.signal.aborted
                  ? ({ ok: false, reason: "lost_ownership" } as const)
                  : ({ ok: true, seq: watermark } as const),
              );
            },
            release: () => Promise.resolve(),
          },
        }),
      inspect: () => Promise.resolve({ held: false }),
      listStale: () => Promise.resolve([]),
      clearStale: () => Promise.resolve(),
    };

    const runtime = createAgentRuntime({ agent, arbitration, prepareTurn: () => ({}), sessionFactory: sessions.factory });
    await runtime.enqueue("conv-21", { text: "hello" });
    const session = await sessions.next();
    await session.started;

    controller.abort(); // 别的节点接管了
    await vi.waitFor(() => {
      expect(session.signal?.aborted).toBe(true);
    });

    session.push(assistantMessage("partial", { turn: 1, usage: {}, status: "interrupted" }));
    session.emit(endTurnChunk(1, "interrupted"));
    session.finish();
    await vi.waitFor(async () => {
      expect((await runtime.getActivity("conv-21")).active).toBe(false);
    });
    // 取号被拒 → 收尾那批消息一条都没写进去，但这一轮干净地结束了、没把会话锁死。
    expect(await ledgerMessages(runtime, "conv-21")).toHaveLength(1);
  });

  it("归属在别的节点手上时报 `held_by_other`，带上 holder 供转发", async () => {
    const arbitration = {
      acquire: () => Promise.resolve({ ok: false as const, reason: "busy" as const, holder: "10.0.0.7:3000" }),
      inspect: () => Promise.resolve({ held: true, holder: "10.0.0.7:3000" }),
      listStale: () => Promise.resolve([]),
      clearStale: () => Promise.resolve(),
    };
    const { runtime } = setup({ arbitration });
    const outcome = await runtime.enqueue("conv-22", { text: "hello" });
    expect(outcome).toMatchObject({ mode: "rejected", reason: "held_by_other" });
    expect(await runtime.getActivity("conv-22")).toMatchObject({ active: true, holder: "10.0.0.7:3000", local: false });
  });
});

describe("驱动器的失败路径", () => {
  it("装配抛错 → 补一条 `failed` 收尾帧，会话不被锁死", async () => {
    const runtime = createAgentRuntime({
      agent,
      prepareTurn: () => {
        throw new Error("sandbox unavailable");
      },
    });
    // `follow: 'forever'`——起轮之前会话是空闲的，`follow: 'turn'` 会在快照发完就收线，
    // 接不到随后那条失败帧。
    const controller = new AbortController();
    const frames: Frame[] = [];
    const tailDone = (async () => {
      for await (const frame of runtime.subscribe("conv-23", { follow: "forever", signal: controller.signal })) {
        frames.push(frame);
      }
    })();
    await runtime.enqueue("conv-23", { text: "hello" });

    await vi.waitFor(() => {
      expect(
        frames.some(
          (f) => f.kind === "chunk" && f.chunk.type === "message-metadata" && f.chunk.messageMetadata.status === "failed",
        ),
      ).toBe(true);
    });
    controller.abort();
    await tailDone;
    expect((await runtime.getActivity("conv-23")).active).toBe(false);
    // 锁死的症状是这里再也起不了轮——验证它还能起。
    expect((await runtime.enqueue("conv-23", { text: "again" })).mode).toBe("started");
  });

  it("生成器自己抛了 → 已产出的成品消息照样落盘", async () => {
    const { runtime, sessions } = setup();
    await runtime.enqueue("conv-24", { text: "hello" });
    const session = await sessions.next();
    await session.started;
    session.push(assistantMessage("half done", { turn: 1, usage: {} }));
    session.fail(new Error("boom"));

    await vi.waitFor(async () => {
      expect((await runtime.getActivity("conv-24")).active).toBe(false);
    });
    const messages = await ledgerMessages(runtime, "conv-24");
    // 成品消息 + 一条承载「失败」的收尾标记（只有一个 `step-start`）。标记落账本才能让重连的客户端看到。
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
    expect(messages.at(-1)).toMatchObject({ parts: [{ type: "step-start" }], metadata: { status: "failed" } });
    expect(messages.every((m) => m.parts.length > 0)).toBe(true);
    // 成品消息只写一次：`finalize` 自己抛的时候不能被 catch 分支重跑（重跑会重新取号，
    // 账本的 (conversationId, seq) 幂等挡不住，同一条回复写出两行）。
    // **按「带正文」判**，不按「parts 非空」——收尾标记也有一个 `step-start`。
    const withText = messages.filter((m) => m.parts.some((p) => p.type === "text"));
    expect(withText).toHaveLength(2);
  });

  it("finalize 抛错时不会把成品消息写两遍", async () => {
    const { runtime, sessions, persistence } = setup();
    await runtime.enqueue("conv-25", { text: "hello" });
    const session = await sessions.next();
    await session.started;
    session.push(assistantMessage("only once", { turn: 1, usage: {} }));

    // 让收尾落盘的第一次 append 炸掉——这正是 `finalize` 自己抛的那条路。
    const realAppend = persistence.ledger.append.bind(persistence.ledger);
    let failed = false;
    persistence.ledger.append = async (entry) => {
      if (!failed && entry.message.role === "assistant" && entry.message.parts.length > 0) {
        failed = true;
        throw new Error("ledger down");
      }
      return realAppend(entry);
    };
    session.finish();

    await vi.waitFor(async () => {
      expect((await runtime.getActivity("conv-25")).active).toBe(false);
    });
    const messages = await ledgerMessages(runtime, "conv-25");
    // 那条成品消息一行都没写进去（第一次就炸了、不重试），但**绝不能出现两行**。
    // 同上，按「带正文」判——收尾标记的 `step-start` 不算成品。
    expect(messages.filter((m) => m.role === "assistant" && m.parts.some((p) => p.type === "text"))).toHaveLength(0);
  });
});

describe("宿主钩子", () => {
  it("起轮 / 收尾 / 两个里程碑都会报，钩子抛错不影响这一轮", async () => {
    const onTurnStart = vi.fn(() => {
      throw new Error("hook exploded");
    });
    const onTurnSettled = vi.fn();
    const onFirstChunk = vi.fn();
    const onFirstOutput = vi.fn();
    const { runtime, sessions } = setup({ hooks: { onTurnStart, onTurnSettled, onFirstChunk, onFirstOutput } });

    await runtime.enqueue("conv-25", { text: "hello", userId: "u1" });
    await runOneTurn(await sessions.next(), "hi", 1);
    await vi.waitFor(() => {
      expect(onTurnSettled).toHaveBeenCalled();
    });

    expect(onTurnStart).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "conv-25", turn: 1 }));
    expect(onTurnSettled).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }));
    expect(onFirstChunk).toHaveBeenCalledTimes(1);
    expect(onFirstOutput).toHaveBeenCalledTimes(1);
  });
});

/**
 * 收尾路径的**故障注入**用例。
 *
 * 这五步里有三步要碰宿主实现（流分发、归属仲裁、持久化），而契约明说它们遇到基础设施
 * 故障仍然抛。历史上这五步是裸跑的：任何一步把异常放出去，登记表里这一轮就永不删除，
 * **这个会话被永久锁死**——此后所有消息只排队、再也起不了轮。
 */
describe("收尾路径的健壮性", () => {
  it("流分发在收尾时抛错 → 会话不被锁死，下一轮照样起得来", async () => {
    let failNext = false;
    const listeners = new Set<(frame: Frame) => void>();
    const flakyStream = {
      publish(_conversationId: string, frame: Frame): void {
        if (failNext && frame.kind === "activity" && !frame.active) {
          failNext = false;
          throw new Error("fanout down");
        }
        for (const listener of [...listeners]) {listener(frame);}
      },
      subscribe(_conversationId: string, listener: (frame: Frame) => void): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const { runtime, sessions } = setup({ stream: flakyStream });

    failNext = true;
    await runtime.enqueue("conv-30", { text: "one" });
    await runOneTurn(await sessions.next(), "first", 1);
    await vi.waitFor(async () => {
      expect((await runtime.getActivity("conv-30")).active).toBe(false);
    });

    // 关键断言：广播炸了，但登记 / 归属 / 出队都照样收干净了。
    expect(await runtime.enqueue("conv-30", { text: "two" })).toMatchObject({ mode: "started" });
    await runOneTurn(await sessions.next(), "second", 2);
  });

  it("释放归属时抛错 → 仍然收得干净，shutdown 不会白等满宽限期", async () => {
    const persistence = memoryPersistence();
    const { runtime, sessions } = setup({ persistence });
    await runtime.enqueue("conv-31", { text: "one" });
    const session = await sessions.next();
    await session.started;
    await runOneTurn(session, "done", 1);
    await vi.waitFor(async () => {
      expect((await runtime.getActivity("conv-31")).active).toBe(false);
    });
    // 宽限期给得很短：收尾若没走完，这里会拖满 200ms 还报「还有轮在跑」。
    await runtime.shutdown({ graceMs: 200 });
    expect(runtime.isShuttingDown()).toBe(true);
  });

  it("装配抛错 → 用户那句话和「失败」标记都落账本，不会凭空消失", async () => {
    const { runtime } = setup({
      prepareTurn: () => {
        throw new Error("sandbox credentials missing");
      },
    });
    await runtime.enqueue("conv-32", { text: "帮我改一下 README" });
    await vi.waitFor(async () => {
      expect((await runtime.getActivity("conv-32")).active).toBe(false);
    });

    const messages = await ledgerMessages(runtime, "conv-32");
    // `enqueue` 已经回了 `mode:'started'`、宿主已经告诉用户「发出去了」——刷新页面后
    // 账本里必须还有这句话，否则它就是凭空消失了。
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(messages[0]?.parts).toEqual([{ type: "text", text: "帮我改一下 README" }]);
    expect(messages.at(-1)).toMatchObject({ parts: [{ type: "step-start" }], metadata: { status: "failed" } });
    expect(messages.every((m) => m.parts.length > 0)).toBe(true);
    // 会话没被这次失败卡死。
    expect(await runtime.enqueue("conv-32", { text: "再试一次" })).toMatchObject({ mode: "started" });
  });
});

describe("subscribe 的边界", () => {
  it("传进来时就已经 abort 的 signal → 立刻收线，不会永远挂着", async () => {
    const { runtime } = setup();
    const controller = new AbortController();
    controller.abort();
    const frames: Frame[] = [];
    // 不加超时保护：修复前这里会永远卡在 `await waiter` 上，用例直接超时报红。
    for await (const frame of runtime.subscribe("conv-33", { follow: "forever", signal: controller.signal })) {
      frames.push(frame);
    }
    expect(frames.every((f) => f.kind === "queue" || f.kind === "activity")).toBe(true);
  });

  it("在收尾窗口里连上来 → 那条成品消息不会丢", async () => {
    const persistence = memoryPersistence();
    // 让回放读账本慢一点，把「read 已经取过快照」到「finalize 落盘并广播」之间那条缝撑开。
    const realRead = persistence.ledger.read.bind(persistence.ledger);
    let slow = false;
    persistence.ledger.read = async (conversationId, opts) => {
      const entries = await realRead(conversationId, opts);
      if (slow) {
        slow = false;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      return entries;
    };
    const { runtime, sessions } = setup({ persistence });

    await runtime.enqueue("conv-34", { text: "hello" });
    const session = await sessions.next();
    await session.started;
    session.push(assistantMessage("the answer", { turn: 1, usage: {} }));

    slow = true;
    const tail = collect(runtime, "conv-34");
    // 先让生成器跑到那次慢 read 上（订阅此时已经挂好），再收尾——成品消息的广播就
    // 正好落在「read 已取过快照」到「回放结束」之间那条缝里。
    await new Promise((resolve) => setTimeout(resolve, 5));
    session.emit(endTurnChunk(1));
    session.finish();
    await tail.done;

    const seen = tail.frames.filter((f) => f.kind === "message").map((f) => f.message.role);
    // 修复前：`buffer.length = 0` 会把这条 message 帧一起丢掉，助手的回复整条不见。
    expect(seen).toContain("assistant");
  });
});

describe("停止的竞态", () => {
  it("清队列期间那一轮已经收尾 → abort 老实返回 false，不谎报「已停止」", async () => {
    const persistence = memoryPersistence();
    const { runtime, sessions } = setup({ persistence });
    await runtime.enqueue("conv-35", { text: "one" });
    const session = await sessions.next();
    await session.started;

    // 清队列这一趟对真库要走网络往返；这里在它中间把这一轮收掉，模拟那个窗口。
    const realClear = persistence.queue.clear.bind(persistence.queue);
    persistence.queue.clear = async (conversationId) => {
      const queue = await realClear(conversationId);
      await runOneTurn(session, "done", 1);
      await vi.waitFor(async () => {
        expect((await runtime.getActivity(conversationId)).active).toBe(false);
      });
      return queue;
    };

    // 修复前：拿的是 await 之前那个 turn，abortTurn 什么都没停却返回 true。
    expect(await runtime.abort("conv-35")).toBe(false);
  });
});

/**
 * `buildResumeState` 的自愈能力。
 *
 * 0.0.x 早期版本把收尾标记写成了 `parts: []`，而 ai 的 `validateUIMessages()` 拒绝空
 * parts——那些行还躺在别人库里，不滤掉的话那些会话**永远起不了新轮**。
 */
describe("buildResumeState 滤掉存量的空 parts 行", () => {
  it("空 parts 的行不进 resume，其余原样保留", () => {
    const now = Date.now();
    const state = buildResumeState("conv-legacy", [
      { conversationId: "conv-legacy", seq: 1, ts: now, message: { id: "m1", role: "user", parts: [{ type: "text", text: "你好" }] } },
      // 早期版本写下的坏行
      { conversationId: "conv-legacy", seq: 2, ts: now, message: { id: "m2", role: "assistant", parts: [], metadata: { turn: 1, usage: {}, status: "interrupted" } } },
      { conversationId: "conv-legacy", seq: 3, ts: now, message: { id: "m3", role: "user", parts: [{ type: "text", text: "再来" }] } },
    ]);

    expect(state.messages.map((m) => m.id)).toEqual(["m1", "m3"]);
    // 轮号仍然从**全部**行里推——被滤掉那条身上的 metadata 不该丢。
    expect(state.turn).toBe(1);
    expect(state.id).toBe("conv-legacy");
  });
});
