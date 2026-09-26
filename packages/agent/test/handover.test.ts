/**
 * [交权](../../../docs/terms.md)在轮编排这一层的行为（docs/logic/orchestration/tech/handover.md）。
 *
 * 一个进程里放两个 runtime，共用一份持久化、一张租约表（`helpers/shared-arbitration.ts`）和一张节点登记表，
 * 「请接手」直接调对方的 `takeOver`——就是两个节点共用一个库的样子。真 core + 假模型：阶段划分在 core 里。
 */
import type { Tool } from "@runko/core";
import { MemoryFS } from "@runko/virtual-fs";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { TAIL_UNKNOWN_MESSAGE } from "../src/runtime/handover.js";
import { createAgentRuntime, memoryNodeRegistry, memoryPersistence } from "../src/index.js";
import type { AgentRuntime, Duration, NodeRegistry, Persistence } from "../src/index.js";
import { sharedArbitration } from "./helpers/shared-arbitration.js";
import type { SharedArbitration } from "./helpers/shared-arbitration.js";

type RuntimeOptions = Parameters<typeof createAgentRuntime>[0];
type SettledEvent = Parameters<NonNullable<NonNullable<RuntimeOptions["hooks"]>["onTurnSettled"]>>[0];
type DoStream = NonNullable<ConstructorParameters<typeof MockLanguageModelV4>[0]>["doStream"];

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
} as const;

function toolCallsStep(calls: { toolCallId: string; toolName: string; input: unknown }[]) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        ...calls.map((call) => ({ type: "tool-call" as const, toolCallId: call.toolCallId, toolName: call.toolName, input: JSON.stringify(call.input) })),
        { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: undefined }, usage },
      ],
      initialDelayInMs: null,
      chunkDelayInMs: null,
    }),
  };
}

function textStep(text: string, chunkDelayInMs: number | null = null) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "text-start" as const, id: "t1" },
        ...[...text].map((ch) => ({ type: "text-delta" as const, id: "t1", delta: ch })),
        { type: "text-end" as const, id: "t1" },
        { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage },
      ],
      initialDelayInMs: null,
      chunkDelayInMs,
    }),
  };
}

/** 一条可以从外面决定何时结束的命令——模拟「交权那一刻它还在跑」。 */
function slowCommand() {
  let finish: (output: string) => void = () => undefined;
  let markStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let aborted = false;
  const execute = vi.fn<Tool["execute"]>(
    (_input, ctx) =>
      new Promise<string>((resolve) => {
        finish = resolve;
        ctx.abortSignal?.addEventListener("abort", () => {
          aborted = true;
          resolve("killed");
        });
        markStarted();
      }),
  );
  const tool: Tool = { description: "跑一条命令", inputSchema: z.object({ cmd: z.string() }), execute };
  return {
    tool,
    execute,
    started,
    finish: (output: string) => {
      finish(output);
    },
    get aborted() {
      return aborted;
    },
  };
}

interface Cluster {
  persistence: Persistence;
  arbitration: SharedArbitration;
  nodes: NodeRegistry;
  runtimes: Map<string, AgentRuntime>;
  settled: Map<string, SettledEvent[]>;
  /** 起一个节点。`releaseSeq` 大的是新版本。 */
  node(
    name: string,
    opts: {
      doStream: DoStream;
      tools?: Record<string, Tool>;
      releaseSeq?: number;
      prepareDelayMs?: number;
      /** `false` = 不调 `start()`（不登记、不做首次回捞）。 */
      start?: boolean;
      /** 接着跑的那一轮装配时抛错（模拟沙盒一时取不到）。 */
      failContinuation?: boolean;
      memoryWindow?: Duration;
      toolTimeout?: Duration;
      sweepInterval?: Duration;
      reservationTtl?: Duration;
      /** 替换「请接手」——模拟接手节点答应了试探、却在真正接手之前挂掉。 */
      requestTakeover?: (target: string, conversationIds: string[]) => Promise<boolean>;
    },
  ): Promise<AgentRuntime>;
  messages(conversationId: string): Promise<{ role: string; status?: string | undefined; text: string }[]>;
}

async function cluster(): Promise<Cluster> {
  const persistence = memoryPersistence();
  const arbitration = sharedArbitration();
  const nodes = memoryNodeRegistry();
  const runtimes = new Map<string, AgentRuntime>();
  const settled = new Map<string, SettledEvent[]>();

  return {
    persistence,
    arbitration,
    nodes,
    runtimes,
    settled,
    async node(name, opts) {
      const events: SettledEvent[] = [];
      settled.set(name, events);
      const runtime = createAgentRuntime({
        agent: { model: new MockLanguageModelV4({ doStream: opts.doStream }), tools: opts.tools ?? {} },
        persistence,
        arbitration: arbitration.forNode(name),
        prepareTurn: async (context) => {
          if (opts.failContinuation === true && context.continuation === true) {throw new Error("sandbox unavailable");}
          if (opts.prepareDelayMs !== undefined) {await new Promise((resolve) => setTimeout(resolve, opts.prepareDelayMs));}
          return { fs: new MemoryFS() };
        },
        hooks: { onTurnSettled: (event) => events.push(event) },
        handover: {
          node: name,
          releaseSeq: opts.releaseSeq ?? 1,
          nodes,
          requestTakeover:
            opts.requestTakeover ?? (async (target, conversationIds) => (await runtimes.get(target)?.takeOver(conversationIds)) ?? false),
          ...(opts.reservationTtl !== undefined ? { reservationTtl: opts.reservationTtl } : {}),
        },
        sweep: { interval: opts.sweepInterval ?? 0 },
        ...(opts.memoryWindow !== undefined ? { suspend: { memoryWindow: opts.memoryWindow } } : {}),
        ...(opts.toolTimeout !== undefined ? { toolTimeout: opts.toolTimeout } : {}),
      });
      runtimes.set(name, runtime);
      if (opts.start !== false) {await runtime.start();}
      return runtime;
    },
    async messages(conversationId) {
      const rows = await persistence.ledger.read(conversationId);
      // 同 id 的行只留最新一条（恢复轮原地改写，见 `foldById`）。
      const byId = new Map<string, (typeof rows)[number]["message"]>();
      for (const row of rows) {byId.set(row.message.id, row.message);}
      return [...byId.values()].map((message) => ({
        role: message.role,
        status: message.metadata?.status,
        text: message.parts.map((part) => (part.type === "text" ? part.text : "")).join(""),
      }));
    },
  };
}

async function waitUntilIdle(runtime: AgentRuntime, conversationId: string): Promise<void> {
  await vi.waitFor(
    async () => {
      expect((await runtime.getActivity(conversationId)).active).toBe(false);
    },
    { timeout: 5_000 },
  );
}

describe("工具段交权：命令留在旧节点上跑完，接手节点拿结果接着跑", () => {
  it("命令只执行一次，结果照常出现，新节点接着走下一步；旧节点等命令跑完才返回", async () => {
    const c = await cluster();
    const cmd = slowCommand();
    const a = await c.node("A", { doStream: [toolCallsStep([{ toolCallId: "call_1", toolName: "bash", input: { cmd: "make" } }])], tools: { bash: cmd.tool } });
    const b = await c.node("B", { doStream: [textStep("构建完成")], tools: { bash: cmd.tool }, releaseSeq: 2 });

    await a.enqueue("conv", { text: "构建一下" });
    await cmd.started;
    const shutdown = a.shutdown();
    // 交接几百毫秒就完成：命令还在跑，对话已经不归 A 了。
    await vi.waitFor(() => {
      expect(c.settled.get("A")?.map((event) => event.status)).toEqual(["handed-over"]);
    });
    expect((await b.getActivity("conv")).local).toBe(false);

    cmd.finish("build ok");
    const result = await shutdown;
    expect(result).toMatchObject({ handedOver: 1, target: "B", delegated: true, tails: 1, settled: true });

    await vi.waitFor(() => {
      expect(c.settled.get("B")?.map((event) => event.status)).toEqual(["completed"]);
    });
    expect(cmd.execute).toHaveBeenCalledTimes(1);
    const messages = await c.messages("conv");
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
    expect(messages.at(-1)).toMatchObject({ status: "completed", text: "构建完成" });
    expect(await c.persistence.tails?.get("conv", "call_1")).toMatchObject({ outcome: { kind: "output", output: "build ok" }, runner: "A" });
  });

  it("命令还在收尾时用户按停止：记停止标记，旧节点杀掉命令，结清之后就停，不再调模型", async () => {
    const c = await cluster();
    const cmd = slowCommand();
    const a = await c.node("A", { doStream: [toolCallsStep([{ toolCallId: "call_1", toolName: "bash", input: { cmd: "sleep" } }])], tools: { bash: cmd.tool } });
    const b = await c.node("B", { doStream: [textStep("不该调到模型")], tools: { bash: cmd.tool }, releaseSeq: 2 });

    await a.enqueue("conv", { text: "睡一会" });
    await cmd.started;
    const shutdown = a.shutdown();
    await vi.waitFor(() => {
      expect(c.settled.get("A")).toHaveLength(1);
    });

    expect(await b.abort("conv")).toBe(true);
    await shutdown;
    expect(cmd.aborted).toBe(true);
    await vi.waitFor(() => {
      expect(c.settled.get("B")?.map((event) => event.status)).toEqual(["interrupted"]);
    });
    const messages = await c.messages("conv");
    expect(messages.at(-1)?.status).toBe("interrupted");
  });

  it("旧节点过了截止时间还没写回结果：接手节点记成「结果未知」交给模型", async () => {
    const c = await cluster();
    const b = await c.node("B", { doStream: [textStep("知道了")], tools: {} });
    // 造一个「旧节点交出对话之后就消失了」的现场：账本末尾一个悬空调用，收尾记录的截止时间已过、没有结果。
    await c.persistence.ledger.append({ conversationId: "conv", seq: 1, ts: Date.now(), message: { id: "u1", role: "user", parts: [{ type: "text", text: "跑" }] } });
    await c.persistence.ledger.append({
      conversationId: "conv",
      seq: 2,
      ts: Date.now(),
      message: {
        id: "a1",
        role: "assistant",
        parts: [{ type: "step-start" }, { type: "tool-bash", toolCallId: "call_1", state: "input-available", input: { cmd: "x" } }],
        metadata: { turn: 1, usage: {}, status: "handed-over", handedOver: { callIds: ["call_1"] } },
      },
    });
    await c.persistence.tails?.begin({ conversationId: "conv", toolCallId: "call_1", toolName: "bash", runner: "gone", startedAt: 0, deadline: 1 });

    expect(await b.takeOver(["conv"])).toBe(true);
    await vi.waitFor(() => {
      expect(c.settled.get("B")?.map((event) => event.status)).toEqual(["completed"]);
    });
    expect((await c.persistence.tails?.get("conv", "call_1"))?.outcome).toEqual({ kind: "error", errorText: TAIL_UNKNOWN_MESSAGE });
  });
});

describe("模型输出段交权：这半步扔掉，接手节点从同一份历史重新生成", () => {
  it("账本里没有半截输出，新节点接着调模型", async () => {
    const c = await cluster();
    const a = await c.node("A", { doStream: [textStep("一段很长很长很长的回答被掐断了", 40)] });
    const b = await c.node("B", { doStream: [textStep("完整的回答")], releaseSeq: 2 });

    await a.enqueue("conv", { text: "讲个故事" });
    await vi.waitFor(() => {
      expect(c.runtimes.get("A")).toBeDefined();
    });
    await new Promise((resolve) => setTimeout(resolve, 120)); // 字已经在往外流
    const result = await a.shutdown();
    expect(result).toMatchObject({ handedOver: 1, target: "B", delegated: true, tails: 0 });

    await vi.waitFor(() => {
      expect(c.settled.get("B")?.map((event) => event.status)).toEqual(["completed"]);
    });
    const messages = await c.messages("conv");
    expect(messages.map((m) => [m.role, m.status, m.text])).toEqual([
      ["user", undefined, "讲个故事"],
      ["assistant", "handed-over", ""],
      ["assistant", "completed", "完整的回答"],
    ]);
  });
});

describe("装配阶段交权：什么都不写，输入放回队首，接手节点出队重来", () => {
  it("用户那句话在新节点上正常跑完", async () => {
    const c = await cluster();
    const a = await c.node("A", { doStream: [textStep("不该跑到")], prepareDelayMs: 200 });
    const b = await c.node("B", { doStream: [textStep("你好呀")], releaseSeq: 2 });

    await a.enqueue("conv", { text: "你好" });
    await a.shutdown();
    await vi.waitFor(() => {
      expect(c.settled.get("B")?.map((event) => event.status)).toEqual(["completed"]);
    });
    expect((await c.messages("conv")).map((m) => [m.role, m.text])).toEqual([
      ["user", "你好"],
      ["assistant", "你好呀"],
    ]);
    await waitUntilIdle(b, "conv");
  });
});

describe("附录 B 的三个老洞", () => {
  it("P1 排队的消息：交权之后由接手节点按原顺序跑完，不再「新的插到前面」", async () => {
    const c = await cluster();
    const a = await c.node("A", { doStream: [textStep("第一条的回答被掐断", 40)] });
    const b = await c.node("B", { doStream: [textStep("第一条的回答"), textStep("第二条的回答")], releaseSeq: 2 });

    await a.enqueue("conv", { text: "第一条" });
    expect((await a.enqueue("conv", { text: "第二条" })).mode).toBe("queued");
    await new Promise((resolve) => setTimeout(resolve, 80));
    await a.shutdown();

    await vi.waitFor(() => {
      expect(c.settled.get("B")?.map((event) => event.status)).toEqual(["completed", "completed"]);
    });
    const texts = (await c.messages("conv")).filter((m) => m.status !== "handed-over").map((m) => m.text);
    expect(texts).toEqual(["第一条", "第一条的回答", "第二条", "第二条的回答"]);
  });

  it("P2 下线之后才答审批：答案落库、打待接手标记，定时回捞把恢复轮起起来", async () => {
    const c = await cluster();
    const danger: Tool = { description: "危险", inputSchema: z.object({ cmd: z.string() }), approval: "review", execute: () => "done" };
    const persistence = c.persistence;
    const a = createAgentRuntime({
      agent: { model: new MockLanguageModelV4({ doStream: [toolCallsStep([{ toolCallId: "call_1", toolName: "danger", input: { cmd: "rm" } }])] }), tools: { danger } },
      persistence,
      arbitration: c.arbitration.forNode("A"),
      prepareTurn: () => ({ fs: new MemoryFS(), onApproval: () => "review" }),
      suspend: { memoryWindow: "1m" },
      handover: { node: "A", nodes: c.nodes },
      sweep: { interval: 0 },
    });
    await a.start();
    await a.enqueue("conv", { text: "删掉" });
    await vi.waitFor(async () => {
      expect(await persistence.decisions.listPending("conv")).toHaveLength(1);
    });
    await a.shutdown();
    // 下线之后在 A 上答（入站关得不够快、或者是单进程）：答案要落库，而且不能就此没人管。
    expect(await a.submitDecision("conv", "call_1", { outcome: "allow" })).toBe(true);

    const b = await c.node("B", { doStream: [textStep("删完了")], tools: { danger }, releaseSeq: 2 });
    await vi.waitFor(() => {
      expect(c.settled.get("B")?.map((event) => event.status)).toEqual(["completed"]);
    });
    await waitUntilIdle(b, "conv");
  });

  it("P3 插话在模型输出时交权：没交给模型的插话转进待发队列，接手节点照样处理", async () => {
    const c = await cluster();
    const a = createAgentRuntime({
      agent: { model: new MockLanguageModelV4({ doStream: [textStep("很长很长的第一段回答会被掐断", 40)] }) },
      persistence: c.persistence,
      arbitration: c.arbitration.forNode("A"),
      prepareTurn: () => ({ fs: new MemoryFS() }),
      handover: { node: "A", nodes: c.nodes, requestTakeover: async (target, ids) => (await c.runtimes.get(target)?.takeOver(ids)) ?? false },
      queue: { steer: "always" },
      sweep: { interval: 0 },
    });
    await a.start();
    const b = await c.node("B", { doStream: [textStep("第一段"), textStep("收到插话")], releaseSeq: 2 });

    await a.enqueue("conv", { text: "说点什么" });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect((await a.enqueue("conv", { text: "顺便说一句" })).mode).toBe("steered");
    await a.shutdown();

    await vi.waitFor(() => {
      expect(c.settled.get("B")?.map((event) => event.status)).toEqual(["completed", "completed"]);
    });
    const texts = (await c.messages("conv")).map((m) => m.text);
    expect(texts).toContain("顺便说一句");
    await waitUntilIdle(b, "conv");
  });
});

describe("挑接手节点", () => {
  it("只挑版本更新的；更新的也在下线就拒绝，换下一个", async () => {
    const c = await cluster();
    const a = await c.node("A", { doStream: [textStep("被掐断的回答很长很长", 40)], releaseSeq: 1 });
    const old = await c.node("OLD", { doStream: [], releaseSeq: 0 });
    const leaving = await c.node("LEAVING", { doStream: [], releaseSeq: 3 });
    await c.node("B", { doStream: [textStep("接住了")], releaseSeq: 2 });
    // LEAVING 自己已经收到 SIGTERM，登记表还没来得及改——它会拒绝。
    await leaving.shutdown();
    await c.nodes.register({ node: "LEAVING", releaseSeq: 3 });

    await a.enqueue("conv", { text: "hi" });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const result = await a.shutdown();
    expect(result.target).toBe("B");
    await vi.waitFor(() => {
      expect(c.settled.get("B")?.map((event) => event.status)).toEqual(["completed"]);
    });
    expect(c.settled.get("OLD")).toEqual([]);
    await old.shutdown();
  });

  it("接手节点答应之后就挂了：预留期内谁也抢不走，预留过期后被定时回捞接走（§5 第 6 条）", async () => {
    const c = await cluster();
    // A 的「请接手」：试探时 B 答应了，真正交过去时 B 已经没了（请求石沉大海）。
    const a = await c.node("A", {
      doStream: [textStep("被掐断的回答很长很长", 40)],
      reservationTtl: "400ms",
      requestTakeover: (target, ids) => Promise.resolve(target === "B" && ids.length === 0),
    });
    await c.node("B", { doStream: [], releaseSeq: 2 });
    const sweeper = await c.node("C", { doStream: [textStep("回捞接住了")], releaseSeq: 1, sweepInterval: "100ms" });

    await a.enqueue("conv", { text: "hi" });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const result = await a.shutdown();
    expect(result).toMatchObject({ handedOver: 1, target: "B", delegated: false });
    // 预留期内：C 的回捞不碰它。
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(c.settled.get("C")).toEqual([]);
    expect(c.arbitration.row("conv")?.reservedFor).toBe("B");

    await vi.waitFor(
      () => {
        expect(c.settled.get("C")?.map((event) => event.status)).toEqual(["completed"]);
      },
      { timeout: 3_000 },
    );
    await waitUntilIdle(sweeper, "conv");
  });

  it("一个都挑不到（单副本先停再启）：标待接手，新进程 start() 时接走", async () => {
    const c = await cluster();
    const a = await c.node("A", { doStream: [textStep("被掐断的回答很长很长", 40)] });
    await a.enqueue("conv", { text: "hi" });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const result = await a.shutdown();
    expect(result).toMatchObject({ handedOver: 1, target: undefined, delegated: false, transferred: 1 });
    expect(c.arbitration.row("conv")?.awaiting).toBe(true);

    await c.node("A2", { doStream: [textStep("新进程接着说完")], releaseSeq: 2 });
    await vi.waitFor(() => {
      expect(c.settled.get("A2")?.map((event) => event.status)).toEqual(["completed"]);
    });
    expect(c.arbitration.row("conv")?.awaiting).toBe(false);
  });

  it("关闭时订阅者收到请重连帧，然后收线", async () => {
    const c = await cluster();
    const a = await c.node("A", { doStream: [textStep("被掐断的回答很长很长", 40)] });
    await c.node("B", { doStream: [textStep("接住了")], releaseSeq: 2 });
    await a.enqueue("conv", { text: "hi" });
    const frames: string[] = [];
    const watching = (async () => {
      for await (const frame of a.subscribe("conv")) {frames.push(frame.kind);}
    })();
    await new Promise((resolve) => setTimeout(resolve, 80));
    await a.shutdown();
    await watching;
    expect(frames.at(-1)).toBe("reconnect");
  });
});

describe("代码审查返工", () => {
  it("关闭时正在等人回答提问：挂起而不是交出去；人回来在别的节点上答，接着跑完（#2）", async () => {
    const c = await cluster();
    const a = await c.node("A", {
      doStream: [toolCallsStep([{ toolCallId: "q1", toolName: "ask-user", input: { question: "继续吗？" } }])],
      memoryWindow: "1m",
    });
    const b = await c.node("B", { doStream: [textStep("好的，继续")], releaseSeq: 2 });
    await a.enqueue("conv", { text: "干活" });
    await vi.waitFor(async () => {
      expect(await c.persistence.decisions.listPending("conv")).toHaveLength(1);
    });
    const result = await a.shutdown();
    expect(result).toMatchObject({ suspended: 1, handedOver: 0 });
    expect(c.settled.get("A")?.map((event) => event.status)).toEqual(["suspended"]);
    expect(await c.persistence.tails?.get("conv", "q1")).toBeUndefined();

    expect(await b.submitAnswer("conv", "q1", "继续")).toBe(true);
    await vi.waitFor(() => {
      expect(c.settled.get("B")?.map((event) => event.status)).toEqual(["completed"]);
    });
  });

  it("提问等人不受工具最长执行时间约束：超过时限才回答，照样拿到答案（#1）", async () => {
    const c = await cluster();
    const a = await c.node("A", {
      doStream: [toolCallsStep([{ toolCallId: "q1", toolName: "ask-user", input: { question: "继续吗？" } }]), textStep("收到")],
      memoryWindow: "1m",
      toolTimeout: "50ms",
    });
    await a.enqueue("conv", { text: "干活" });
    await vi.waitFor(async () => {
      expect(await c.persistence.decisions.listPending("conv")).toHaveLength(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await a.submitAnswer("conv", "q1", "继续")).toBe(true);
    await vi.waitFor(() => {
      expect(c.settled.get("A")?.map((event) => event.status)).toEqual(["completed"]);
    });
    const rows = await c.persistence.ledger.read("conv");
    expect(JSON.stringify(rows)).not.toContain("exceeded the maximum execution time");
  });

  it("用户已经按了停止的轮不交出去：照停止收尾，接手节点不重做（#6）", async () => {
    const c = await cluster();
    const cmd = slowCommand();
    const a = await c.node("A", { doStream: [toolCallsStep([{ toolCallId: "call_1", toolName: "bash", input: { cmd: "x" } }])], tools: { bash: cmd.tool } });
    await c.node("B", { doStream: [textStep("不该跑到")], tools: { bash: cmd.tool }, releaseSeq: 2 });
    await a.enqueue("conv", { text: "删掉 release 分支" });
    await cmd.started;
    expect(await a.abort("conv")).toBe(true);
    const result = await a.shutdown();
    expect(result.handedOver).toBe(0);
    expect(c.settled.get("A")?.map((event) => event.status)).toEqual(["interrupted"]);
    expect(c.settled.get("B")).toEqual([]);
  });

  it("交出去的调用没登记上收尾记录：接手节点直接记成「结果未知」接着跑，不卡死（#3）", async () => {
    const c = await cluster();
    const b = await c.node("B", { doStream: [textStep("知道了")], tools: {} });
    await c.persistence.ledger.append({ conversationId: "conv", seq: 1, ts: Date.now(), message: { id: "u1", role: "user", parts: [{ type: "text", text: "跑" }] } });
    await c.persistence.ledger.append({
      conversationId: "conv",
      seq: 2,
      ts: Date.now(),
      message: {
        id: "a1",
        role: "assistant",
        parts: [{ type: "step-start" }, { type: "tool-bash", toolCallId: "call_1", state: "input-available", input: { cmd: "x" } }],
        metadata: { turn: 1, usage: {}, status: "handed-over", handedOver: { callIds: ["call_1"] } },
      },
    });
    expect(await b.takeOver(["conv"])).toBe(true);
    await vi.waitFor(() => {
      expect(c.settled.get("B")?.map((event) => event.status)).toEqual(["completed"]);
    });
    expect(JSON.stringify(await c.persistence.ledger.read("conv"))).toContain("went offline before it reported a result");
  });

  it("并行的几个工具收尾：全部有结果才恢复，一轮里一起结清，不中途冒出「挂起」（#14）", async () => {
    const c = await cluster();
    const b = await c.node("B", { doStream: [textStep("都好了")], tools: {} });
    await c.persistence.ledger.append({ conversationId: "conv", seq: 1, ts: Date.now(), message: { id: "u1", role: "user", parts: [{ type: "text", text: "并行" }] } });
    await c.persistence.ledger.append({
      conversationId: "conv",
      seq: 2,
      ts: Date.now(),
      message: {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "step-start" },
          { type: "tool-search", toolCallId: "k1", state: "input-available", input: { q: "1" } },
          { type: "tool-search", toolCallId: "k2", state: "input-available", input: { q: "2" } },
        ],
        metadata: { turn: 1, usage: {}, status: "handed-over", handedOver: { callIds: ["k1", "k2"] } },
      },
    });
    const far = Date.now() + 60_000;
    await c.persistence.tails?.begin({ conversationId: "conv", toolCallId: "k1", toolName: "search", runner: "A", startedAt: Date.now(), deadline: far });
    await c.persistence.tails?.begin({ conversationId: "conv", toolCallId: "k2", toolName: "search", runner: "A", startedAt: Date.now(), deadline: far });
    await c.persistence.tails?.complete("conv", "k1", { kind: "output", output: "one" }, Date.now());

    await b.takeOver(["conv"]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(c.settled.get("B")).toEqual([]); // k2 还在跑：不恢复

    await c.persistence.tails?.complete("conv", "k2", { kind: "output", output: "two" }, Date.now());
    await b.takeOver(["conv"]);
    await vi.waitFor(() => {
      expect(c.settled.get("B")?.map((event) => event.status)).toEqual(["completed"]);
    });
  });

  it("交权之后还没人接着跑时按停止：补「已停止」、清队列，不再接着跑（#13）", async () => {
    const c = await cluster();
    const a = await c.node("A", { doStream: [textStep("一段很长很长很长的回答被掐断了", 40)] });
    await a.enqueue("conv", { text: "讲个故事" });
    await new Promise((resolve) => setTimeout(resolve, 80));
    await a.shutdown(); // 没有别的节点：标待接手
    // B 还没做首次回捞（没调 start()）：这份对话此刻没人接着跑，用户按停止。
    const b = await c.node("B", { doStream: [textStep("不该跑到")], releaseSeq: 2, start: false });
    expect(await b.abort("conv")).toBe(true);
    const rows = await c.persistence.ledger.read("conv");
    expect(rows.at(-1)?.message.metadata?.status).toBe("interrupted");
  });

  it("接着跑的那一轮装配失败：不写空的用户消息，账本不动，打待接手标记等下次（#8）", async () => {
    const c = await cluster();
    const a = await c.node("A", { doStream: [textStep("一段很长很长很长的回答被掐断了", 40)] });
    await c.node("B", { doStream: [], releaseSeq: 2, failContinuation: true });
    await a.enqueue("conv", { text: "讲个故事" });
    await new Promise((resolve) => setTimeout(resolve, 80));
    await a.shutdown();
    await vi.waitFor(() => {
      expect(c.settled.get("B")?.map((event) => event.status)).toEqual(["crashed"]);
    });
    const rows = await c.persistence.ledger.read("conv");
    expect(rows.map((row) => row.message.role)).toEqual(["user", "assistant"]);
    expect(rows.at(-1)?.message.metadata?.status).toBe("handed-over");
    await vi.waitFor(() => {
      expect(c.arbitration.row("conv")?.awaiting).toBe(true);
    });
  });

  it("节点登记失败一次：后台照样开，心跳那一拍重新登记（#22）", async () => {
    const nodes = memoryNodeRegistry();
    let failOnce = true;
    const flaky = {
      ...nodes,
      register: (self: { node: string; releaseSeq: number }) => {
        if (failOnce) {
          failOnce = false;
          return Promise.reject(new Error("db down"));
        }
        return nodes.register(self);
      },
    };
    const runtime = createAgentRuntime({
      agent: { model: new MockLanguageModelV4({ doStream: [] }) },
      persistence: memoryPersistence(),
      arbitration: sharedArbitration().forNode("A"),
      prepareTurn: () => ({ fs: new MemoryFS() }),
      handover: { node: "A", nodes: flaky, nodeHeartbeat: "50ms" },
      sweep: { interval: 0 },
    });
    await runtime.start();
    await vi.waitFor(async () => {
      expect((await nodes.list()).map((row) => row.node)).toEqual(["A"]);
    });
    await runtime.shutdown();
  });

  it("预留给本节点、还没接上：轮状态算本地的，不转给自己（#26）", async () => {
    const c = await cluster();
    const b = await c.node("B", { doStream: [], releaseSeq: 2 });
    const arbitrationA = c.arbitration.forNode("A");
    const acquired = await arbitrationA.acquire("conv", { seedSeq: () => Promise.resolve(0) });
    if (!acquired.ok || acquired.grant.releaseTo === undefined) {throw new Error("expected a grant with releaseTo");}
    await acquired.grant.releaseTo("B", { ttlMs: 10_000 });
    expect(await b.getActivity("conv")).toMatchObject({ active: true, local: true, holder: "B" });
  });
});
