/**
 * 活动信号（`NimboActivityAware.onActivity`）验收测试 —— KA-1。
 *
 * 规格见 docs/tech/sandbox-keepalive.md §5.2，验收清单见
 * docs/plans/sandbox-keepalive.md KA-1。
 *
 * 这里只测 core 侧的**信号产出**：什么时候发、发什么 reason、节流怎么走、
 * 没实现的工作区是不是完全不受影响。信号发出去之后适配器拿它干什么
 * （续期闸门、审批预算）属于适配器包的测试，不在本文件。
 *
 * 时间由 `vi.useFakeTimers()` 接管——节流是纯 `Date.now()` 比较（core 侧刻意
 * 零定时器），所以假时钟就能完全确定地驱动它。模型流全部用
 * `initialDelayInMs: null` / `chunkDelayInMs: null`，不涉及真实定时器。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { defineAgent } from "../src/agent.js";
import { createSession } from "../src/session.js";
import type {
  ActivitySignal,
  ApprovalPolicy,
  ApprovalReviewer,
  ExecResult,
  NimboActivityAware,
  NimboExec,
  NimboFS,
} from "../src/types.js";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
} as const;

function mockModel(buildOptions: () => ConstructorParameters<typeof MockLanguageModelV4>[0]): MockLanguageModelV4 {
  return new MockLanguageModelV4(buildOptions());
}

function chattyStream(deltaCount: number) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "text-start" as const, id: "t1" },
        ...Array.from({ length: deltaCount }, () => ({ type: "text-delta" as const, id: "t1", delta: "x" })),
        { type: "text-end" as const, id: "t1" },
        { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage },
      ],
      initialDelayInMs: null,
      chunkDelayInMs: null,
    }),
  };
}

/** 一步就停，正文拆成 `deltaCount` 个增量——用来制造「一轮里很多 chunk」。`turns` 是这个 mock 能服务几轮。 */
function chattyModel(deltaCount: number, turns = 1): MockLanguageModelV4 {
  return mockModel(() => ({
    doStream: Array.from({ length: turns }, () => chattyStream(deltaCount)),
  }));
}

/** 第一步调工具、第二步收尾——审批场景要它。 */
function toolThenStopModel(toolName: string): MockLanguageModelV4 {
  return mockModel(() => ({
    doStream: [
      {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "tool-call", toolCallId: "call_1", toolName, input: "{}" },
            { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      },
      {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "done" },
            { type: "text-end", id: "t1" },
            { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      },
    ],
  }));
}

const bareFs: NimboFS = {
  readFile: async () => new Uint8Array(),
  writeFile: async () => {},
  rm: async () => {},
  mkdir: async () => {},
  readdir: async () => [],
  stat: async () => ({ type: "file" }),
  glob: async () => [],
};

const okExec: ExecResult = { exitCode: 0, stdout: "", stderr: "", durationMs: 0 };

interface RecordingWorkspace extends NimboFS, NimboExec, NimboActivityAware {
  readonly signals: ActivitySignal[];
}

/** [模式 A（同源工作区）](../../../docs/terms.md)形态的记录器：一个对象同时是 fs、exec 和信号接收方。 */
function recordingWorkspace(): RecordingWorkspace {
  const signals: ActivitySignal[] = [];
  return {
    ...bareFs,
    exec: async () => okExec,
    signals,
    onActivity(signal) {
      signals.push(signal);
    },
  };
}

const agent = () => defineAgent({ model: chattyModel(1) });

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("KA-1 活动信号：可选性（工作区没实现就什么都不发生）", () => {
  it("普通 fs + 无 exec：一轮正常跑完，没有任何信号相关的报错", async () => {
    const session = createSession(defineAgent({ model: chattyModel(3) }), { fs: bareFs });
    const result = await session.send("hi");
    expect(result.finalResponse).toBe("xxx");
  });

  it("工作区实现了 onActivity：一轮至少收到一个信号", async () => {
    const workspace = recordingWorkspace();
    const session = createSession(defineAgent({ model: chattyModel(3) }), { workspace });
    await session.send("hi");
    expect(workspace.signals.length).toBeGreaterThan(0);
  });

  it("同源工作区（同一个对象既当 fs 又当 exec）只被通知一次，不重复", async () => {
    const workspace = recordingWorkspace();
    const session = createSession(defineAgent({ model: chattyModel(1) }), { workspace });
    await session.send("hi");
    // 一轮内时间不推进 → 节流只放行第一个 chunk。若 fs/exec 被当成两个接收方，这里会是 2。
    expect(workspace.signals).toHaveLength(1);
  });
});

describe("KA-1 活动信号：节流（leading-edge，5 秒）", () => {
  it("一轮里密集产出 chunk、时钟不动 → 只发一次", async () => {
    const workspace = recordingWorkspace();
    const session = createSession(defineAgent({ model: chattyModel(50) }), { workspace });
    await session.send("hi");
    expect(workspace.signals).toHaveLength(1);
    expect(workspace.signals[0]?.reason).toBe("progress");
  });

  it("leading-edge：第一个 chunk 立刻发，不等窗口结束", async () => {
    const workspace = recordingWorkspace();
    const session = createSession(defineAgent({ model: chattyModel(10) }), { workspace });
    const gen = session.stream("hi");
    await gen.next(); // 只取第一个 chunk
    expect(workspace.signals).toHaveLength(1);
    await gen.return(undefined as never);
  });

  it("时钟推进超过 5 秒后再产出 chunk → 再发一次", async () => {
    const workspace = recordingWorkspace();
    const session = createSession(defineAgent({ model: chattyModel(10) }), { workspace });

    const gen = session.stream("hi");
    await gen.next();
    expect(workspace.signals).toHaveLength(1);

    vi.setSystemTime(Date.now() + 6_000);
    await gen.next();
    expect(workspace.signals).toHaveLength(2);

    // 紧接着的下一个 chunk 又被窗口挡住
    await gen.next();
    expect(workspace.signals).toHaveLength(2);

    await gen.return(undefined as never);
  });

  it("每轮重置：第二轮的第一个 chunk 必定发信号，不受第一轮窗口影响", async () => {
    const workspace = recordingWorkspace();
    const session = createSession(defineAgent({ model: chattyModel(3, 2) }), { workspace });
    await session.send("first");
    const afterFirst = workspace.signals.length;
    await session.send("second"); // 时钟没动过
    expect(workspace.signals.length).toBe(afterFirst + 1);
    expect(workspace.signals.at(-1)?.session.turn).toBe(2);
  });

  it("信号带着会话 id 与轮号", async () => {
    const workspace = recordingWorkspace();
    const session = createSession(defineAgent({ model: chattyModel(1) }), { workspace });
    await session.send("hi");
    expect(workspace.signals[0]?.session).toEqual({ id: session.id, turn: 1 });
  });
});

describe("KA-1 活动信号：审批边沿（绕过节流）", () => {
  /**
   * 一个必过人审的工具 + 受控的人审通道。
   *
   * `approval: "review"` 挂在**工具**上：[审批链](../../../docs/terms.md)是两级求值，
   * per-tool 策略先行，session 级 `onApproval` 只接升级请求——工具不声明的话
   * 这次调用根本走不到人审那一步（施工中实测：会直接 `tool-output-available`）。
   */
  function approvalScenario(onReview: ApprovalReviewer) {
    const workspace = recordingWorkspace();
    const onApproval: ApprovalPolicy = () => "review";
    const session = createSession(
      defineAgent({
        model: toolThenStopModel("danger"),
        tools: { danger: { description: "d", inputSchema: z.object({}), approval: "review", execute: () => "ran" } },
      }),
      { workspace, onApproval, onReview },
    );
    return { workspace, session };
  }

  it("tool-approval-request 立刻发 awaiting-approval，即使还在节流窗口内", async () => {
    const { workspace, session } = approvalScenario(async () => ({ behavior: "allow" }));
    await session.send("do it");

    const reasons = workspace.signals.map((s) => s.reason);
    expect(reasons).toContain("awaiting-approval");

    // 窗口内本来只该有第一个 progress；awaiting-approval 是额外挤进来的边沿。
    const approvalIndex = reasons.indexOf("awaiting-approval");
    expect(approvalIndex).toBeGreaterThan(0);
  });

  it("裁决之后的第一个 chunk 立刻发 progress（这是实现方停掉审批保活的依据）", async () => {
    const { workspace, session } = approvalScenario(async () => ({ behavior: "allow" }));
    await session.send("do it");

    const reasons = workspace.signals.map((s) => s.reason);
    const approvalIndex = reasons.indexOf("awaiting-approval");
    expect(approvalIndex).toBeGreaterThanOrEqual(0); // 否则下一行会在 reasons[0] 上假通过
    expect(reasons[approvalIndex + 1]).toBe("progress");
  });

  it("拒绝路径同样能等到收尾的 progress 边沿", async () => {
    const { workspace, session } = approvalScenario(async () => ({ behavior: "deny", message: "no" }));
    await session.send("do it");

    const reasons = workspace.signals.map((s) => s.reason);
    const approvalIndex = reasons.indexOf("awaiting-approval");
    expect(approvalIndex).toBeGreaterThanOrEqual(0);
    expect(reasons[approvalIndex + 1]).toBe("progress");
  });
});

describe("KA-1 活动信号：两条消费路径都覆盖", () => {
  it("session.send() 有信号（内部 drain stream()）", async () => {
    const workspace = recordingWorkspace();
    const session = createSession(agent(), { workspace });
    await session.send("hi");
    expect(workspace.signals.length).toBeGreaterThan(0);
  });

  it("session.stream() 有信号", async () => {
    const workspace = recordingWorkspace();
    const session = createSession(agent(), { workspace });
    for await (const _ of session.stream("hi")) void _;
    expect(workspace.signals.length).toBeGreaterThan(0);
  });
});
