/**
 * [恢复](../../../docs/terms.md)在轮编排这一层的行为——设计见
 * docs/logic/orchestration/tech/suspend-resume.md §5.7–§5.9、§11。
 *
 * 与 `suspend.test.ts` 一样**用真的 core session**：恢复轮会走 core 的 `settleAndRun`，假 session
 * 会把最要紧的那层（结清悬空调用、用原封不动的参数执行）整个跳过。
 *
 * 「另一个副本」用**第二个 runtime** 模拟：两个 runtime 共用同一份持久化与同一个仲裁实例，
 * 就像两个进程共用一个数据库。
 */
import type { ApprovalPolicy, RunkoUIMessage, Tool } from "@runko/core";
import { MemoryFS } from "@runko/virtual-fs";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createAgentRuntime, foldById, inProcessArbitration, memoryPersistence } from "../src/index.js";
import type { Arbitration, Persistence, TurnPreparation } from "../src/index.js";
import { appendInterruptedMarker } from "../src/runtime/interrupted-marker.js";
import { settleOrphanedDecisions } from "../src/runtime/orphaned-decisions.js";

type RuntimeOptions = Parameters<typeof createAgentRuntime>[0];
type SettledEvent = Parameters<NonNullable<NonNullable<RuntimeOptions["hooks"]>["onTurnSettled"]>>[0];
type PrepareContext = Parameters<RuntimeOptions["prepareTurn"]>[0];

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
} as const;

/** 模型的一步——`MockLanguageModelV4` 的 `doStream` 返回的东西。两个辅助函数标同一个类型，才能放进一个数组。 */
type Step = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;

function toolCallsStep(calls: { toolCallId: string; toolName: string; input: unknown }[]): Step {
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

function textStep(text: string): Step {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "text-start" as const, id: "t1" },
        { type: "text-delta" as const, id: "t1", delta: text },
        { type: "text-end" as const, id: "t1" },
        { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage },
      ],
      initialDelayInMs: null,
      chunkDelayInMs: null,
    }),
  };
}

/** 按顺序吐出这些步；**每一次调用都记下来**，测试据此看模型收到了什么。 */
function scriptedModel(steps: Step[]): MockLanguageModelV4 {
  let index = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const step = steps[index] ?? textStep(`（没有第 ${String(index + 1)} 步了）`);
      index += 1;
      return step;
    },
  });
}

function dangerTool(execute: Tool["execute"]): Tool {
  return { description: "危险操作", inputSchema: z.object({ cmd: z.string() }), approval: "review", execute };
}

interface Setup {
  model: MockLanguageModelV4;
  tools: Record<string, Tool>;
  persistence?: Persistence;
  arbitration?: Arbitration;
  windowMs?: number;
  onApproval?: ApprovalPolicy;
  prepareTurn?: (context: PrepareContext) => TurnPreparation | Promise<TurnPreparation>;
}

function setup(opts: Setup) {
  const persistence = opts.persistence ?? memoryPersistence();
  const settled: SettledEvent[] = [];
  const runtime = createAgentRuntime({
    agent: { model: opts.model, tools: opts.tools },
    persistence,
    ...(opts.arbitration !== undefined ? { arbitration: opts.arbitration } : {}),
    prepareTurn:
      opts.prepareTurn ?? (() => ({ fs: new MemoryFS(), onApproval: opts.onApproval ?? (() => "review") })),
    suspend: { memoryWindow: opts.windowMs ?? 20 },
    hooks: { onTurnSettled: (event) => settled.push(event) },
  });
  const ledgerMessages = async (conversationId: string): Promise<RunkoUIMessage[]> =>
    foldById(await persistence.ledger.read(conversationId));
  const waitSettled = async (count: number): Promise<void> => {
    await vi.waitFor(() => {
      expect(settled.length).toBeGreaterThanOrEqual(count);
    });
  };
  return { runtime, persistence, settled, ledgerMessages, waitSettled };
}

/** 模型第 n 次被调用时收到的对话，压成「角色:部件」的短串。 */
function promptShape(model: MockLanguageModelV4, call: number): string[] {
  const prompt = model.doStreamCalls[call]?.prompt ?? [];
  return prompt
    .filter((message) => message.role !== "system")
    .map((message) => {
      if (typeof message.content === "string") {return `${message.role}:text`;}
      const parts = message.content.map((part) => ("toolCallId" in part ? `${part.type}(${part.toolCallId})` : part.type));
      return `${message.role}:${parts.join(",")}`;
    });
}

function partOf(messages: RunkoUIMessage[], callId: string) {
  for (const message of messages) {
    for (const part of message.parts) {
      if ("toolCallId" in part && part.toolCallId === callId) {return part;}
    }
  }
  return undefined;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("人回来答了：开一轮恢复，接着干", () => {
  it("允许：用挂起那一刻的参数执行，模型看到配好对的 tool_use / tool_result", async () => {
    const execute = vi.fn<Tool["execute"]>(() => "删掉了 234MB");
    const model = scriptedModel([toolCallsStep([{ toolCallId: "call_1", toolName: "danger", input: { cmd: "rm -rf build" } }]), textStep("清理完了")]);
    const { runtime, persistence, settled, ledgerMessages, waitSettled } = setup({ model, tools: { danger: dangerTool(execute) } });

    await runtime.enqueue("c1", { text: "清理构建产物" });
    await waitSettled(1);
    expect(settled[0]?.status).toBe("suspended");
    expect(execute).not.toHaveBeenCalled();

    expect(await runtime.submitDecision("c1", "call_1", { outcome: "allow", decidedBy: "u1" })).toBe(true);
    await waitSettled(2);

    expect(settled[1]?.status).toBe("completed");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toEqual({ cmd: "rm -rf build" });
    expect(promptShape(model, 1)).toEqual(["user:text", "assistant:tool-call(call_1)", "tool:tool-result(call_1)"]);
    expect(partOf(await ledgerMessages("c1"), "call_1")).toMatchObject({ state: "output-available", output: "删掉了 234MB" });
    expect(await persistence.decisions.listPending("c1")).toHaveLength(0);
    expect(await persistence.decisions.get("c1", "call_1")).toMatchObject({ outcome: "allow", decidedBy: "u1" });
  });

  it("拒绝：不执行，理由回填给模型", async () => {
    const execute = vi.fn<Tool["execute"]>(() => "不该执行");
    const model = scriptedModel([toolCallsStep([{ toolCallId: "call_1", toolName: "danger", input: { cmd: "rm -rf build" } }]), textStep("好的，不删")]);
    const { runtime, settled, ledgerMessages, waitSettled } = setup({ model, tools: { danger: dangerTool(execute) } });

    await runtime.enqueue("c2", { text: "清理构建产物" });
    await waitSettled(1);
    expect(await runtime.submitDecision("c2", "call_1", { outcome: "deny", message: "别动 build" })).toBe(true);
    await waitSettled(2);

    expect(settled[1]?.status).toBe("completed");
    expect(execute).not.toHaveBeenCalled();
    expect(partOf(await ledgerMessages("c2"), "call_1")).toMatchObject({ state: "output-denied", approval: { approved: false, reason: "别动 build" } });
  });

  it("ask-user：答案就是那次调用的输出", async () => {
    const model = scriptedModel([toolCallsStep([{ toolCallId: "call_1", toolName: "ask-user", input: { question: "A 还是 B？" } }]), textStep("那就 B")]);
    const { runtime, settled, ledgerMessages, waitSettled } = setup({ model, tools: {} });

    await runtime.enqueue("c3", { text: "帮我选" });
    await waitSettled(1);
    expect(await runtime.submitAnswer("c3", "call_1", "选 B")).toBe(true);
    await waitSettled(2);

    expect(settled[1]?.status).toBe("completed");
    expect(partOf(await ledgerMessages("c3"), "call_1")).toMatchObject({ state: "output-available", output: "选 B" });
    expect(promptShape(model, 1)).toEqual(["user:text", "assistant:tool-call(call_1)", "tool:tool-result(call_1)"]);
  });

  it("恢复轮交给宿主的装配上下文：空文本、userId 是答复人、带着 resume", async () => {
    const contexts: PrepareContext[] = [];
    const model = scriptedModel([toolCallsStep([{ toolCallId: "call_1", toolName: "danger", input: { cmd: "x" } }]), textStep("ok")]);
    const { runtime, waitSettled } = setup({
      model,
      tools: { danger: dangerTool(() => "ok") },
      prepareTurn: (context) => {
        contexts.push(context);
        return { fs: new MemoryFS(), onApproval: () => "review" };
      },
    });

    await runtime.enqueue("c4", { text: "去做", userId: "alice" });
    await waitSettled(1);
    await runtime.submitDecision("c4", "call_1", { outcome: "allow", decidedBy: "bob" });
    await waitSettled(2);

    expect(contexts[0]).toMatchObject({ input: { text: "去做", userId: "alice" } });
    expect(contexts[0]?.resume).toBeUndefined();
    expect(contexts[1]).toMatchObject({ input: { text: "", userId: "bob" }, resume: { callId: "call_1" } });
  });
});

describe("在另一个副本上恢复", () => {
  it("A 挂起后下线，B 收到答复、恢复并跑完——中间只隔着一份账本和一张裁决表", async () => {
    const persistence = memoryPersistence();
    const arbitration = inProcessArbitration();
    const execute = vi.fn<Tool["execute"]>(() => "done");

    const modelA = scriptedModel([toolCallsStep([{ toolCallId: "call_1", toolName: "danger", input: { cmd: "deploy" } }])]);
    const a = setup({ model: modelA, tools: { danger: dangerTool(execute) }, persistence, arbitration });
    await a.runtime.enqueue("c5", { text: "部署" });
    await a.waitSettled(1);
    await a.runtime.shutdown({ graceMs: 1_000 });

    const modelB = scriptedModel([textStep("部署完了")]);
    const b = setup({ model: modelB, tools: { danger: dangerTool(execute) }, persistence, arbitration });
    expect(await b.runtime.submitDecision("c5", "call_1", { outcome: "allow" })).toBe(true);
    await b.waitSettled(1);

    expect(b.settled[0]?.status).toBe("completed");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toEqual({ cmd: "deploy" });
    expect(modelA.doStreamCalls).toHaveLength(1);
    expect(modelB.doStreamCalls).toHaveLength(1);
  });
});

describe("答案写进来时归属正被别人占着（技术方案 §5.7「为什么不会漏」）", () => {
  // e2e 在压力下偶发撞到的竞态，这里把它钉成确定事实：B 占着归属去读裁决表，读到「还没答」；
  // 就在它放手之前，A 写进答案、推一把，因为 B 占着而抢不到——A 不会再推第二次。
  // 不做「放手之后再看一眼」的话，谁也没接上，这份答案要等到下一次有人推一把。
  it("B 占着归属读到「没答」、A 恰好在这时写进答案：B 放手之后接上，不会漏", async () => {
    const persistence = memoryPersistence();
    const arbitration = inProcessArbitration();
    const execute = vi.fn<Tool["execute"]>(() => "done");

    // 在 B 占着归属、刚读完那一行的时候停住，把「读到的是旧值」这件事固定下来。
    const readDecision = persistence.decisions.get.bind(persistence.decisions);
    let armed = false;
    let entered: () => void = () => undefined;
    const enteredGate = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    persistence.decisions.get = async (conversationId, callId) => {
      const record = await readDecision(conversationId, callId);
      if (armed && (await arbitration.inspect(conversationId)).held) {
        armed = false;
        entered();
        await gate;
      }
      return record;
    };

    const modelA = scriptedModel([toolCallsStep([{ toolCallId: "call_1", toolName: "danger", input: { cmd: "deploy" } }])]);
    const a = setup({ model: modelA, tools: { danger: dangerTool(execute) }, persistence, arbitration });
    await a.runtime.enqueue("c9", { text: "部署" });
    await a.waitSettled(1);
    expect(a.settled[0]?.status).toBe("suspended");

    // B 收到一条新消息：只能排队；排完推一把 → 抢到归属 → 读裁决表 → 停在闸门上。
    const modelB = scriptedModel([textStep("部署完了"), textStep("排着的那条也看了")]);
    const b = setup({ model: modelB, tools: { danger: dangerTool(execute) }, persistence, arbitration });
    armed = true;
    const queued = b.runtime.enqueue("c9", { text: "顺便看看日志" });
    await enteredGate;

    // A 这时答：写进裁决表，推一把——B 占着，抢不到。
    expect(await a.runtime.submitDecision("c9", "call_1", { outcome: "allow" })).toBe(true);
    release();
    expect(await queued).toMatchObject({ mode: "queued" });

    // B 放手之后再看一眼，接上恢复；恢复收尾时排队的那条也跟着跑。
    await b.waitSettled(2);
    expect(b.settled.map((event) => event.status)).toEqual(["completed", "completed"]);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe("挂起期间排队的消息", () => {
  it("恢复轮收尾之后才开始跑", async () => {
    const model = scriptedModel([
      toolCallsStep([{ toolCallId: "call_1", toolName: "danger", input: { cmd: "x" } }]),
      textStep("命令跑完了"),
      textStep("README 看过了"),
    ]);
    const { runtime, settled, waitSettled } = setup({ model, tools: { danger: dangerTool(() => "ok") } });

    await runtime.enqueue("c6", { text: "第一条" });
    await waitSettled(1);
    expect(await runtime.enqueue("c6", { text: "顺便看看 README" })).toMatchObject({ mode: "queued" });
    await sleep(20);
    expect(settled).toHaveLength(1);

    await runtime.submitDecision("c6", "call_1", { outcome: "allow" });
    await waitSettled(3);

    expect(settled.map((event) => event.status)).toEqual(["suspended", "completed", "completed"]);
    expect(settled[2]?.input.text).toBe("顺便看看 README");
    // 第三轮看到的历史：那次调用已经配好对，排队的那条消息接在后面。
    expect(promptShape(model, 2)).toEqual([
      "user:text",
      "assistant:tool-call(call_1)",
      "tool:tool-result(call_1)",
      "assistant:text",
      "user:text",
    ]);
  });
});

describe("答复的边界", () => {
  it("同一张卡片答两次：第二次 false，命令只执行一次", async () => {
    const execute = vi.fn<Tool["execute"]>(() => "ok");
    const model = scriptedModel([toolCallsStep([{ toolCallId: "call_1", toolName: "danger", input: { cmd: "x" } }]), textStep("ok")]);
    const { runtime, waitSettled } = setup({ model, tools: { danger: dangerTool(execute) } });

    await runtime.enqueue("c7", { text: "去做" });
    await waitSettled(1);
    const [first, second] = await Promise.all([
      runtime.submitDecision("c7", "call_1", { outcome: "allow" }),
      runtime.submitDecision("c7", "call_1", { outcome: "deny" }),
    ]);
    expect([first, second].sort()).toEqual([false, true]);
    await waitSettled(2);
    await sleep(20);
    expect(execute.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("从未存在的 callId：false，不起轮", async () => {
    const model = scriptedModel([toolCallsStep([{ toolCallId: "call_1", toolName: "danger", input: { cmd: "x" } }])]);
    const { runtime, settled, waitSettled } = setup({ model, tools: { danger: dangerTool(() => "ok") } });

    await runtime.enqueue("c8", { text: "去做" });
    await waitSettled(1);
    expect(await runtime.submitDecision("c8", "nope", { outcome: "allow" })).toBe(false);
    await sleep(20);
    expect(settled).toHaveLength(1);
  });

  it("种类对不上（拿答案去答审批）：false", async () => {
    const model = scriptedModel([toolCallsStep([{ toolCallId: "call_1", toolName: "danger", input: { cmd: "x" } }])]);
    const { runtime, persistence, waitSettled } = setup({ model, tools: { danger: dangerTool(() => "ok") } });

    await runtime.enqueue("c9", { text: "去做" });
    await waitSettled(1);
    expect(await runtime.submitAnswer("c9", "call_1", "好")).toBe(false);
    expect(await persistence.decisions.listPending("c9")).toHaveLength(1);
  });
});

describe("同一条消息里两个悬空调用", () => {
  // 只读：两个调用同时在等人只会出现在并行批里（串行批里第一个挂起之后，后面的不执行）。
  const ask: Tool = { description: "问", inputSchema: z.object({ q: z.string() }), readOnly: true, execute: (_i, ctx) => ctx.suspend("timeout") };

  it("两个都答了：连着恢复两轮，不需要人再做任何事", async () => {
    const model = scriptedModel([
      toolCallsStep([
        { toolCallId: "call_1", toolName: "ask", input: { q: "一" } },
        { toolCallId: "call_2", toolName: "ask", input: { q: "二" } },
      ]),
      textStep("两个都答了"),
    ]);
    // 自定义工具直接调 ctx.suspend()，裁决表里没有它的行——这里先手工登记，模拟 ask-user 那条路。
    const persistence = memoryPersistence();
    const { runtime, settled, waitSettled } = setup({ model, tools: { ask }, persistence });

    await runtime.enqueue("c10", { text: "两个问题" });
    await waitSettled(1);
    for (const callId of ["call_1", "call_2"]) {
      await persistence.decisions.record({ conversationId: "c10", toolCallId: callId, kind: "question", requestedAt: 1 });
    }

    // 先答第二个：恢复轮结清它，第一个还悬着 → 不调模型，再挂起。
    expect(await runtime.submitAnswer("c10", "call_2", "答二")).toBe(true);
    await waitSettled(2);
    expect(settled[1]?.status).toBe("suspended");
    expect(model.doStreamCalls).toHaveLength(1);

    // 再答第一个：这回两个都有结果了，模型接着干。
    expect(await runtime.submitAnswer("c10", "call_1", "答一")).toBe(true);
    await waitSettled(3);
    expect(settled[2]?.status).toBe("completed");
    expect(promptShape(model, 1)).toEqual([
      "user:text",
      "assistant:tool-call(call_1),tool-call(call_2)",
      "tool:tool-result(call_1),tool-result(call_2)",
    ]);
  });
});

describe("账本：同 id 覆盖", () => {
  it("恢复轮以新 seq、同 id 追加改写后的那条；读的时候折叠成一条", async () => {
    const model = scriptedModel([
      toolCallsStep([{ toolCallId: "call_1", toolName: "danger", input: { cmd: "x" } }]),
      textStep("做完了"),
      textStep("第三轮"),
    ]);
    const { runtime, persistence, waitSettled } = setup({ model, tools: { danger: dangerTool(() => "ok") } });

    await runtime.enqueue("c11", { text: "去做" });
    await waitSettled(1);
    await runtime.submitDecision("c11", "call_1", { outcome: "allow" });
    await waitSettled(2);

    const raw = await persistence.ledger.read("c11");
    const ids = raw.map((entry) => entry.message.id);
    const suspendedId = ids[1];
    expect(ids.filter((id) => id === suspendedId)).toHaveLength(2);
    const folded = foldById(raw);
    expect(folded.map((message) => message.id)).toEqual([ids[0], suspendedId, ids[3]]);

    // 下一个普通轮：模型看到的历史里 call_1 只出现一次（不折叠的话会出现两次，服务商 400）。
    await runtime.enqueue("c11", { text: "再来" });
    await waitSettled(3);
    expect(promptShape(model, 2).join(" ").match(/tool-call\(call_1\)/g)).toHaveLength(1);
  });
});

describe("恢复轮里的停止与失败", () => {
  it("恢复轮装配期间点停止：改成拒绝，不执行，会话回到正常", async () => {
    const execute = vi.fn<Tool["execute"]>(() => "不该执行");
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model = scriptedModel([toolCallsStep([{ toolCallId: "call_1", toolName: "danger", input: { cmd: "x" } }]), textStep("之后的一轮")]);
    const { runtime, settled, ledgerMessages, waitSettled } = setup({
      model,
      tools: { danger: dangerTool(execute) },
      prepareTurn: async (context) => {
        if (context.resume !== undefined) {await gate;}
        return { fs: new MemoryFS(), onApproval: () => "review" };
      },
    });

    await runtime.enqueue("c12", { text: "去做" });
    await waitSettled(1);
    await runtime.submitDecision("c12", "call_1", { outcome: "allow" });
    await vi.waitFor(async () => {
      expect((await runtime.getActivity("c12")).active).toBe(true);
    });
    expect(await runtime.abort("c12")).toBe(true);
    release();
    await waitSettled(2);

    expect(settled[1]?.status).toBe("interrupted");
    expect(execute).not.toHaveBeenCalled();
    expect(partOf(await ledgerMessages("c12"), "call_1")).toMatchObject({ state: "output-denied" });
    // 悬空调用清掉了：普通轮又能起了。
    expect(await runtime.enqueue("c12", { text: "继续" })).toMatchObject({ mode: "started" });
  });

  it("恢复轮装配失败：账本一个字不动，不热循环；用户再发一条消息时重试", async () => {
    let failResume = true;
    const model = scriptedModel([toolCallsStep([{ toolCallId: "call_1", toolName: "danger", input: { cmd: "x" } }]), textStep("恢复成功"), textStep("那条消息")]);
    const { runtime, persistence, settled, waitSettled } = setup({
      model,
      tools: { danger: dangerTool(() => "ok") },
      prepareTurn: (context) => {
        if (context.resume !== undefined && failResume) {throw new Error("沙盒唤不醒");}
        return { fs: new MemoryFS(), onApproval: () => "review" };
      },
    });

    await runtime.enqueue("c13", { text: "去做" });
    await waitSettled(1);
    const before = await persistence.ledger.read("c13");
    await runtime.submitDecision("c13", "call_1", { outcome: "allow" });
    await waitSettled(2);
    await sleep(30);

    expect(settled.map((event) => event.status)).toEqual(["suspended", "crashed"]);
    expect(await persistence.ledger.read("c13")).toEqual(before);

    failResume = false;
    expect(await runtime.enqueue("c13", { text: "在吗" })).toMatchObject({ mode: "queued" });
    await waitSettled(4);
    expect(settled.map((event) => event.status)).toEqual(["suspended", "crashed", "completed", "completed"]);
    expect(settled[3]?.input.text).toBe("在吗");
  });
});

describe("恢复没做成时不能重复执行", () => {
  it("恢复轮执行了命令、但改写后的那条写不进账本：不自动重试——否则命令会被一遍遍执行", async () => {
    const execute = vi.fn<Tool["execute"]>(() => "ok");
    const persistence = memoryPersistence();
    const inner = persistence.ledger;
    let rejectWrites = false;
    persistence.ledger = {
      ...inner,
      append: async (entry) => (rejectWrites ? { ok: false, reason: "rejected" } : await inner.append(entry)),
    };
    const model = scriptedModel([toolCallsStep([{ toolCallId: "call_1", toolName: "danger", input: { cmd: "deploy" } }]), textStep("ok")]);
    const { runtime, settled, waitSettled } = setup({ model, tools: { danger: dangerTool(execute) }, persistence });

    await runtime.enqueue("c18", { text: "部署" });
    await waitSettled(1);
    rejectWrites = true;
    await runtime.submitDecision("c18", "call_1", { outcome: "allow" });
    await waitSettled(2);
    await sleep(60);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(settled).toHaveLength(2);
  });
});

describe("裁决表不漏出永远待定的行", () => {
  it("孤儿行：不在账本末尾悬空调用里的待定行结成 timeout，正经挂起的那一行不动", async () => {
    const persistence = memoryPersistence();
    const suspended: RunkoUIMessage = {
      id: "a1",
      role: "assistant",
      parts: [{ type: "tool-danger", toolCallId: "call_2", state: "approval-requested", input: { cmd: "x" }, approval: { id: "call_2" } }],
    };
    await persistence.ledger.append({ conversationId: "c14", seq: 1, message: suspended, ts: 1 });
    await persistence.decisions.record({ conversationId: "c14", toolCallId: "call_1", kind: "approval", requestedAt: 1 });
    await persistence.decisions.record({ conversationId: "c14", toolCallId: "call_2", kind: "approval", requestedAt: 2 });

    expect(await settleOrphanedDecisions(persistence, "c14")).toBe(1);
    expect(await persistence.decisions.get("c14", "call_1")).toMatchObject({ outcome: "timeout" });
    expect((await persistence.decisions.listPending("c14")).map((row) => row.toolCallId)).toEqual(["call_2"]);
  });

  it("账本末尾有悬空调用时，不补「已停止」——补了这个会话就永久坏了", async () => {
    const persistence = memoryPersistence();
    const arbitration = inProcessArbitration();
    const suspended: RunkoUIMessage = {
      id: "a1",
      role: "assistant",
      parts: [{ type: "tool-ask", toolCallId: "call_1", state: "input-available", input: {} }],
    };
    await persistence.ledger.append({ conversationId: "c15", seq: 1, message: suspended, ts: 1 });
    const acquired = await arbitration.acquire("c15", { seedSeq: () => persistence.ledger.maxSeq("c15") });
    if (!acquired.ok) {throw new Error("acquire failed");}

    const outcome = await appendInterruptedMarker(persistence, acquired.grant, "crashed");
    expect(outcome).toEqual({ written: false, reason: "awaiting_human" });
    expect(await persistence.ledger.read("c15")).toHaveLength(1);
  });

  it("登记先于结清：登记写得慢、人答得快，那一行照样是答过的，不是永远待定", async () => {
    const persistence = memoryPersistence();
    const inner = persistence.decisions;
    persistence.decisions = {
      ...inner,
      record: async (entry) => {
        await sleep(80);
        return await inner.record(entry);
      },
    };
    const model = scriptedModel([toolCallsStep([{ toolCallId: "call_1", toolName: "danger", input: { cmd: "x" } }]), textStep("ok")]);
    const settled: SettledEvent[] = [];
    // 卡片一出现就答——比登记落库（80ms）快得多，正是脚本化客户端的样子。
    const runtime: ReturnType<typeof createAgentRuntime> = createAgentRuntime({
      agent: { model, tools: { danger: dangerTool(() => "ok") } },
      persistence,
      prepareTurn: () => ({ fs: new MemoryFS(), onApproval: () => "review" }),
      suspend: { memoryWindow: 5_000 },
      hooks: {
        onTurnSettled: (event) => settled.push(event),
        onApprovalPending: (event) => {
          void runtime.submitDecision(event.conversationId, event.callId, { outcome: "allow" });
        },
      },
    });

    await runtime.enqueue("c16", { text: "去做" });
    await vi.waitFor(() => {
      expect(settled).toHaveLength(1);
    });
    await sleep(100);

    expect(settled[0]?.status).toBe("completed");
    expect(await persistence.decisions.listPending("c16")).toHaveLength(0);
    expect(await persistence.decisions.get("c16", "call_1")).toMatchObject({ outcome: "allow" });
  });

  it("挂起之后放手之前，登记已经落库——别的副本来恢复时读得到", async () => {
    const persistence = memoryPersistence();
    const inner = persistence.decisions;
    persistence.decisions = {
      ...inner,
      record: async (entry) => {
        await sleep(80);
        return await inner.record(entry);
      },
    };
    const model = scriptedModel([toolCallsStep([{ toolCallId: "call_1", toolName: "danger", input: { cmd: "x" } }])]);
    let pendingAtSettle: Promise<unknown[]> | undefined;
    const runtime = createAgentRuntime({
      agent: { model, tools: { danger: dangerTool(() => "ok") } },
      persistence,
      prepareTurn: () => ({ fs: new MemoryFS(), onApproval: () => "review" }),
      suspend: { memoryWindow: 5 },
      hooks: {
        // 收尾钩子在释放归属**之后**触发：就在这一刻看库里有没有那一行（内存版的 listPending
        // 在调用的那一刻就取好了快照）。
        onTurnSettled: (event) => {
          pendingAtSettle = persistence.decisions.listPending(event.conversationId);
        },
      },
    });

    await runtime.enqueue("c17", { text: "去做" });
    await vi.waitFor(() => {
      expect(pendingAtSettle).toBeDefined();
    });
    expect(await pendingAtSettle).toHaveLength(1);
  });
});

describe("答复的身份、孤儿行、恢复没做成、接管时撤回", () => {
  it("答挂起的提问时带上答复人：恢复那一轮以他的身份跑（推送、钩子靠它找人）", async () => {
    const model = scriptedModel([toolCallsStep([{ toolCallId: "call_1", toolName: "ask-user", input: { question: "A 还是 B？" } }]), textStep("那就 B")]);
    const contexts: PrepareContext[] = [];
    const { runtime, waitSettled } = setup({
      model,
      tools: {},
      prepareTurn: (context) => {
        contexts.push(context);
        return { fs: new MemoryFS() };
      },
    });
    await runtime.enqueue("c30", { text: "帮我选", userId: "u1" });
    await waitSettled(1);

    expect(await runtime.submitAnswer("c30", "call_1", "B", { decidedBy: "u7" })).toBe(true);
    await waitSettled(2);
    expect(contexts[1]?.input.userId).toBe("u7");
  });

  it("孤儿行（那次调用不在账本末尾悬着）：答了也是 false，那一行原样不动", async () => {
    const model = scriptedModel([textStep("随便聊聊")]);
    const { runtime, persistence, waitSettled } = setup({ model, tools: {} });
    await runtime.enqueue("c31", { text: "hi" });
    await waitSettled(1);
    await persistence.decisions.record({ conversationId: "c31", toolCallId: "ghost", kind: "approval", toolName: "danger", requestedAt: 1 });

    expect(await runtime.submitDecision("c31", "ghost", { outcome: "allow" })).toBe(false);
    expect((await persistence.decisions.get("c31", "ghost"))?.decidedAt).toBeUndefined();
  });

  it("答过了但恢复没做成（装配失败）：再点一次报 false，但顺手推一把，这回接上了", async () => {
    let failResume = true;
    const model = scriptedModel([toolCallsStep([{ toolCallId: "call_1", toolName: "danger", input: { cmd: "x" } }]), textStep("恢复成功")]);
    const { runtime, settled, waitSettled } = setup({
      model,
      tools: { danger: dangerTool(() => "ok") },
      prepareTurn: (context) => {
        if (context.resume !== undefined && failResume) {throw new Error("沙盒唤不醒");}
        return { fs: new MemoryFS(), onApproval: () => "review" };
      },
    });
    await runtime.enqueue("c32", { text: "去做" });
    await waitSettled(1);
    await runtime.submitDecision("c32", "call_1", { outcome: "allow" });
    await waitSettled(2);
    expect(settled.map((event) => event.status)).toEqual(["suspended", "crashed"]);

    failResume = false;
    expect(await runtime.submitDecision("c32", "call_1", { outcome: "allow" })).toBe(false);
    await waitSettled(3);
    expect(settled[2]?.status).toBe("completed");
  });

  it("撤回时顶掉了一个过期持有者：替它收拾孤儿行，正经挂起的那一行不动", async () => {
    const persistence = memoryPersistence();
    const base = inProcessArbitration();
    const model = scriptedModel([toolCallsStep([{ toolCallId: "call_1", toolName: "danger", input: { cmd: "x" } }])]);
    const a = setup({ model, tools: { danger: dangerTool(() => "ok") }, persistence, arbitration: base });
    await a.runtime.enqueue("c33", { text: "去做" });
    await a.waitSettled(1);
    // 一个崩掉的恢复轮在账本外登记过的一行：账本里找不到它。
    await persistence.decisions.record({ conversationId: "c33", toolCallId: "crashed-call", kind: "approval", toolName: "danger", requestedAt: 2 });

    // 下一次抢归属报「顶掉了一个过期持有者」。
    let reportTakeover = true;
    const arbitration: Arbitration = {
      ...base,
      acquire: async (conversationId, acquireCtx) => {
        const result = await base.acquire(conversationId, acquireCtx);
        if (!result.ok || !reportTakeover) {return result;}
        reportTakeover = false;
        return { ...result, takeover: { holder: "dead-node" } };
      },
    };
    const b = setup({ model: scriptedModel([]), tools: { danger: dangerTool(() => "ok") }, persistence, arbitration });
    expect(await b.runtime.enqueue("c33", { text: "在吗" })).toMatchObject({ mode: "queued" });

    expect((await persistence.decisions.get("c33", "crashed-call"))?.outcome).toBe("timeout");
    expect((await persistence.decisions.get("c33", "call_1"))?.decidedAt).toBeUndefined();
  });
});
