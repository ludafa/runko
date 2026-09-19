/**
 * 挂起在轮编排这一层的行为——设计见
 * docs/logic/orchestration/tech/suspend-resume.md §4、§5.3、§10。
 *
 * 这一组**不用假 session**：真的 core session、mock 模型、内存持久化，一轮从 `enqueue` 跑到收尾。
 * 挂起牵涉三层（人在回路桥 → core 的 loop → 收尾五步），假 session 会把中间那层整个跳过，
 * 而 S1 在 core 那层发现的几个坑正是只有真跑才会冒出来的。
 *
 * 断言盯三件事，对应挂起的三个承诺：
 *
 * - **那次调用原样留在账本里**（最后一条消息里有一个悬空部件）；
 * - **裁决表那一行不结清**（人回来还要答）；
 * - **机器放掉了**（归属已释放、排队的消息不起轮）。
 */
import type { ApprovalPolicy, Tool } from "@runko/core";
import { MemoryFS } from "@runko/virtual-fs";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createAgentRuntime, memoryPersistence } from "../src/index.js";
import type { Persistence } from "../src/index.js";

type RuntimeOptions = Parameters<typeof createAgentRuntime>[0];
type SettledEvent = Parameters<NonNullable<NonNullable<RuntimeOptions["hooks"]>["onTurnSettled"]>>[0];
type ApprovalPendingEvent = Parameters<NonNullable<NonNullable<RuntimeOptions["hooks"]>["onApprovalPending"]>>[0];

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

function textStep(text: string) {
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

const danger: Tool = {
  description: "危险操作",
  inputSchema: z.object({ cmd: z.string() }),
  approval: "review",
  execute: () => "done",
};

interface Setup {
  model: MockLanguageModelV4;
  tools?: Record<string, Tool>;
  windowMs?: number;
  onApproval?: ApprovalPolicy;
  persistence?: Persistence;
  queue?: RuntimeOptions["queue"];
}

function setup(opts: Setup) {
  const persistence = opts.persistence ?? memoryPersistence();
  const settled: SettledEvent[] = [];
  const approvalsPending: ApprovalPendingEvent[] = [];
  const runtime = createAgentRuntime({
    agent: { model: opts.model, tools: opts.tools ?? { danger } },
    persistence,
    prepareTurn: () => ({ fs: new MemoryFS(), onApproval: opts.onApproval ?? (() => "review") }),
    suspend: { memoryWindow: opts.windowMs ?? 30 },
    hooks: {
      onTurnSettled: (event) => settled.push(event),
      onApprovalPending: (event) => approvalsPending.push(event),
    },
    ...(opts.queue !== undefined ? { queue: opts.queue } : {}),
  });
  const lastLedgerMessage = async (conversationId: string) => {
    const entries = await persistence.ledger.read(conversationId);
    return entries[entries.length - 1]?.message;
  };
  return { runtime, persistence, settled, approvalsPending, lastLedgerMessage };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("内存窗口到点：这一轮挂起", () => {
  it("审批：那次调用原样留在账本末尾、裁决表不结清、归属已释放", async () => {
    const model = new MockLanguageModelV4({ doStream: [toolCallsStep([{ toolCallId: "call_1", toolName: "danger", input: { cmd: "rm -rf build" } }]), textStep("不该走到")] });
    const { runtime, persistence, settled, lastLedgerMessage } = setup({ model });

    await runtime.enqueue("c1", { text: "清理构建产物" });
    await vi.waitFor(() => {
      expect(settled).toHaveLength(1);
    });

    expect(settled[0]?.status).toBe("suspended");
    // 模型只被调用一次——挂起之后绝不进下一步。
    expect(model.doStreamCalls).toHaveLength(1);

    const last = await lastLedgerMessage("c1");
    expect(last?.metadata).toMatchObject({ status: "suspended", suspended: { callIds: ["call_1"], reason: "timeout" } });
    const part = last?.parts.find((p) => "toolCallId" in p && p.toolCallId === "call_1");
    expect(part).toMatchObject({ state: "approval-requested", input: { cmd: "rm -rf build" } });

    // 裁决表那一行**没结清**——人回来答的就是它。
    const pending = await persistence.decisions.listPending("c1");
    expect(pending.map((row) => row.toolCallId)).toEqual(["call_1"]);

    // 机器放掉了。
    expect(await runtime.getActivity("c1")).toMatchObject({ active: false });
  });

  it("ask-user：部件停在 input-available，同样不结裁决表", async () => {
    const model = new MockLanguageModelV4({ doStream: [toolCallsStep([{ toolCallId: "call_1", toolName: "ask-user", input: { question: "A 还是 B？" } }]), textStep("不该走到")] });
    const { runtime, persistence, settled, lastLedgerMessage } = setup({ model, tools: {} });

    await runtime.enqueue("c2", { text: "帮我选" });
    await vi.waitFor(() => {
      expect(settled).toHaveLength(1);
    });

    expect(settled[0]?.status).toBe("suspended");
    const last = await lastLedgerMessage("c2");
    expect(last?.metadata).toMatchObject({ status: "suspended", suspended: { callIds: ["call_1"], reason: "timeout" } });
    const part = last?.parts.find((p) => "toolCallId" in p && p.toolCallId === "call_1");
    expect(part).toMatchObject({ state: "input-available", input: { question: "A 还是 B？" } });
    // 那句英文提示文案再也不会出现在账本里。
    expect(JSON.stringify(last)).not.toContain("did not respond");
    expect(await persistence.decisions.listPending("c2")).toHaveLength(1);
  });

  it("窗口内答了：跟以前一样往下跑，不挂起", async () => {
    const model = new MockLanguageModelV4({ doStream: [toolCallsStep([{ toolCallId: "call_1", toolName: "danger", input: { cmd: "ls" } }]), textStep("好了")] });
    const { runtime, persistence, settled } = setup({ model, windowMs: 5_000 });

    await runtime.enqueue("c3", { text: "列一下" });
    await vi.waitFor(async () => {
      expect(await persistence.decisions.listPending("c3")).toHaveLength(1);
    });
    expect(await runtime.submitDecision("c3", "call_1", { outcome: "allow" })).toBe(true);
    await vi.waitFor(() => {
      expect(settled).toHaveLength(1);
    });

    expect(settled[0]?.status).toBe("completed");
    expect(await persistence.decisions.listPending("c3")).toHaveLength(0);
  });
});

describe("一旦决定挂起，同一轮里后面的等人立刻挂起", () => {
  it("串行两个审批：第一个到点挂起后，第二个不再等人、也不执行——顺序保住，人只需答第一个", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        toolCallsStep([
          { toolCallId: "call_1", toolName: "danger", input: { cmd: "a" } },
          { toolCallId: "call_2", toolName: "danger", input: { cmd: "b" } },
        ]),
        textStep("不该走到"),
      ],
    });
    const { runtime, persistence, settled, approvalsPending, lastLedgerMessage } = setup({ model });

    await runtime.enqueue("c4", { text: "两件事" });
    await vi.waitFor(() => {
      expect(settled).toHaveLength(1);
    });

    // 串行批按书写顺序执行：第一个挂起了，第二个根本没轮到——不弹卡片、不登记、不执行，
    // 只得一个「没有执行」的结果，恢复之后模型需要的话会再发一次。
    expect(approvalsPending.map((event) => event.callId)).toEqual(["call_1"]);
    const last = await lastLedgerMessage("c4");
    expect(last?.metadata).toMatchObject({ status: "suspended", suspended: { callIds: ["call_1"], reason: "timeout" } });
    const second = last?.parts.find((part) => "toolCallId" in part && part.toolCallId === "call_2");
    expect(second).toMatchObject({ state: "output-error" });
    expect((await persistence.decisions.listPending("c4")).map((row) => row.toolCallId)).toEqual(["call_1"]);
  });
});

describe("挂起之后不起普通轮（有悬空调用时模型服务商会 400）", () => {
  it("挂起那一轮收尾时队列里有消息：不交棒，消息留在队列里", async () => {
    const model = new MockLanguageModelV4({ doStream: [toolCallsStep([{ toolCallId: "call_1", toolName: "danger", input: { cmd: "x" } }]), textStep("不该走到")] });
    const { runtime, settled } = setup({ model, windowMs: 60 });

    await runtime.enqueue("c5", { text: "第一条" });
    // 这一轮正在等人时又来一条——排队。
    await vi.waitFor(async () => {
      expect((await runtime.getActivity("c5")).active).toBe(true);
    });
    expect(await runtime.enqueue("c5", { text: "顺便看看 README" })).toMatchObject({ mode: "queued" });

    await vi.waitFor(() => {
      expect(settled).toHaveLength(1);
    });
    await sleep(50);

    expect(settled).toHaveLength(1);
    expect(model.doStreamCalls).toHaveLength(1);
    expect((await runtime.listQueue("c5")).map((item) => item.input.text)).toEqual(["顺便看看 README"]);
  });

  it("挂起期间新来的消息：只入队，不起轮", async () => {
    const model = new MockLanguageModelV4({ doStream: [toolCallsStep([{ toolCallId: "call_1", toolName: "danger", input: { cmd: "x" } }]), textStep("不该走到")] });
    const { runtime, settled, lastLedgerMessage } = setup({ model });

    await runtime.enqueue("c6", { text: "第一条" });
    await vi.waitFor(() => {
      expect(settled).toHaveLength(1);
    });
    const before = await lastLedgerMessage("c6");

    expect(await runtime.enqueue("c6", { text: "在吗" })).toMatchObject({ mode: "queued" });
    await sleep(30);

    expect(settled).toHaveLength(1);
    expect(model.doStreamCalls).toHaveLength(1);
    // 账本一个字没动——用户消息没有被追加在悬空调用后面（那样这份账本就再也恢复不了了）。
    expect(await lastLedgerMessage("c6")).toEqual(before);
    expect((await runtime.listQueue("c6")).map((item) => item.input.text)).toEqual(["在吗"]);
    expect(await runtime.getActivity("c6")).toMatchObject({ active: false });
  });

  it("队列关着时：拒绝，并说清是在等人，不是有轮在跑", async () => {
    const model = new MockLanguageModelV4({ doStream: [toolCallsStep([{ toolCallId: "call_1", toolName: "danger", input: { cmd: "x" } }]), textStep("不该走到")] });
    const { runtime, settled } = setup({ model, queue: { enabled: false } });

    await runtime.enqueue("c7", { text: "第一条" });
    await vi.waitFor(() => {
      expect(settled).toHaveLength(1);
    });

    const result = await runtime.enqueue("c7", { text: "在吗" });
    expect(result).toMatchObject({ mode: "rejected", reason: "busy" });
    expect(result.mode === "rejected" ? result.message : "").toContain("waiting for a person");
  });
});

describe("交权", () => {
  it("关闭时正在等人：挂起而不是中止，理由是 handover，裁决表不结清", async () => {
    const model = new MockLanguageModelV4({ doStream: [toolCallsStep([{ toolCallId: "call_1", toolName: "danger", input: { cmd: "x" } }]), textStep("不该走到")] });
    // 窗口开得很长：关闭那一刻它一定还在等人。
    const { runtime, persistence, settled, lastLedgerMessage } = setup({ model, windowMs: 60_000 });

    await runtime.enqueue("c8", { text: "第一条" });
    await vi.waitFor(async () => {
      expect(await persistence.decisions.listPending("c8")).toHaveLength(1);
    });

    const result = await runtime.shutdown({ graceMs: 2_000 });
    expect(result).toEqual({ aborted: 0, suspended: 1, settled: true, pending: 0 });
    expect(settled[0]?.status).toBe("suspended");
    expect((await lastLedgerMessage("c8"))?.metadata).toMatchObject({ status: "suspended", suspended: { reason: "handover" } });
    expect(await persistence.decisions.listPending("c8")).toHaveLength(1);
  });

  it("对照：用户点停止仍然把等人项结成拒绝，并写进裁决表", async () => {
    const model = new MockLanguageModelV4({ doStream: [toolCallsStep([{ toolCallId: "call_1", toolName: "danger", input: { cmd: "x" } }]), textStep("好的")] });
    const { runtime, persistence, settled } = setup({ model, windowMs: 60_000 });

    await runtime.enqueue("c9", { text: "第一条" });
    await vi.waitFor(async () => {
      expect(await persistence.decisions.listPending("c9")).toHaveLength(1);
    });
    await runtime.abort("c9");
    await vi.waitFor(() => {
      expect(settled).toHaveLength(1);
    });

    expect(settled[0]?.status).toBe("interrupted");
    expect(await persistence.decisions.listPending("c9")).toHaveLength(0);
  });
});

describe("内存窗口里接下的插话：挂起时不能丢", () => {
  // 用户在卡片等人的那几分钟里插了一句话，被告知「插进去了」（steered）。这一轮随后挂起：插话还没
  // 注入（下一步才注入），而它只活在这一轮的内存里。它得转进待发队列，人答完之后照样发出。
  it("插话没来得及注入就挂起了：它进了待发队列，不会消失", async () => {
    const model = new MockLanguageModelV4({
      doStream: [toolCallsStep([{ toolCallId: "call_1", toolName: "danger", input: { cmd: "rm -rf build" } }]), textStep("不该走到")],
    });
    const { runtime, persistence, settled, approvalsPending } = setup({ model, windowMs: 200 });

    await runtime.enqueue("c20", { text: "清理构建产物" });
    await vi.waitFor(() => {
      expect(approvalsPending).toHaveLength(1);
    });
    expect(await runtime.enqueue("c20", { text: "别删，改成移动" }, { intent: "steer" })).toMatchObject({ mode: "steered" });

    await vi.waitFor(() => {
      expect(settled).toHaveLength(1);
    });
    expect(settled[0]?.status).toBe("suspended");
    expect((await persistence.queue.list("c20")).map((item) => item.input.text)).toEqual(["别删，改成移动"]);
  });
});
