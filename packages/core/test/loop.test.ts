/**
 * P13-5-2（docs/tech/single-ledger.md）迁移：`runTurn` 的工作态/产出
 * 从 `ModelMessage[]`/`SessionEvent` 换成 `NimboUIMessage[]`/`NimboChunk`——
 * 这个文件按 `loop.ts` 文件头的语义映射表逐条对照重写：断言 chunk 序列
 * （`tool-input-available`/`tool-output-available`/`tool-approval-*`/
 * `data-*`/`message-metadata` 等）与账本落地形态（`messages` 参数原地
 * push，测试结束后直接读取），不再有平行的 item 列表。
 */
import { describe, expect, it, vi } from "vitest";
import { convertToModelMessages, simulateReadableStream } from "ai";
import type { Telemetry } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { runTurn } from "../src/loop.js";
import type { RunTurnOptions } from "../src/loop.js";
import { createOnceApprovalMemory } from "../src/approval.js";
import { createDerivedDataCollector } from "../src/runtime.js";
import { createPlanStore, createUpdatePlanTool } from "../src/tools/builtin/update-plan.js";
import type { ApprovalOutcome, ApprovalPolicy, ApprovalReviewer, HumanDecision, NimboFS, Tool } from "../src/types.js";
import type { NimboUIMessage } from "../src/state.js";
import {
  allToolParts,
  chunksOfType,
  collectReasoning,
  collectText,
  drainTurn,
  fileChangeParts,
  lastAssistantMessage,
  planUpdateParts,
  toolProgressParts,
  toolTimingPartFor,
  userTextMessage,
} from "./helpers/nimbo-chunks.js";

/**
 * Same helper shape as `model/step.test.ts` (see that file's header comment for why
 * `mockModel` takes a callback rather than a `chunks` array parameter — the callback
 * form keeps each chunk literal's discriminated `type` field narrow).
 */
function mockModel(buildOptions: () => ConstructorParameters<typeof MockLanguageModelV4>[0]): MockLanguageModelV4 {
  return new MockLanguageModelV4(buildOptions());
}

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
} as const;

function fakeFs(): NimboFS {
  return {
    readFile: async () => new Uint8Array(),
    writeFile: async () => {},
    rm: async () => {},
    mkdir: async () => {},
    readdir: async () => [],
    stat: async () => ({ type: "file" }),
    glob: async () => [],
  };
}

function turnOptions(model: MockLanguageModelV4, overrides: Partial<RunTurnOptions> = {}): RunTurnOptions {
  return {
    model,
    system: undefined,
    messages: [],
    tools: {},
    maxTurnsPerRun: 40,
    maxContextTokens: undefined,
    maxOutputTokens: undefined,
    fs: fakeFs(),
    session: { id: "sess_1", turn: 1 },
    signal: undefined,
    onApproval: undefined,
    onReview: undefined,
    onceMemory: createOnceApprovalMemory(),
    derivedData: createDerivedDataCollector(),
    ...overrides,
  };
}

describe("runTurn", () => {
  it("multi-step tool-use: step 1 tool-calls (update-plan) executed & settles in place, step 2 stops with the final text", async () => {
    const store = createPlanStore();
    const derivedData = createDerivedDataCollector();
    const tool = createUpdatePlanTool({ store, onPlanUpdate: (items) => derivedData.recordPlanUpdate(items) });

    const model = mockModel(() => ({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              {
                type: "tool-call",
                toolCallId: "call_1",
                toolName: "update-plan",
                input: JSON.stringify({ items: [{ text: "write tests", completed: false }] }),
              },
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

    const messages: NimboUIMessage[] = [userTextMessage("u1", "please plan")];
    const { chunks, result } = await drainTurn(
      runTurn(turnOptions(model, { messages, tools: { "update-plan": tool }, derivedData })),
    );

    expect(chunksOfType(chunks, "tool-input-available")).toEqual([
      {
        type: "tool-input-available",
        toolCallId: "call_1",
        toolName: "update-plan",
        input: { items: [{ text: "write tests", completed: false }] },
      },
    ]);

    const outputAvailable = chunksOfType(chunks, "tool-output-available");
    expect(outputAvailable).toHaveLength(1);
    expect(outputAvailable[0]?.toolCallId).toBe("call_1");
    expect(String(outputAvailable[0]?.output)).toContain("Plan updated");

    expect(chunksOfType(chunks, "data-plan-update")).toEqual([
      { type: "data-plan-update", id: "plan-update", data: { items: [{ text: "write tests", completed: false }] } },
    ]);

    expect(result.finalResponse).toBe("done");
    expect(store.getItems()).toEqual([{ text: "write tests", completed: false }]);

    // docs/tech/single-ledger.md §4.1 实现教训：同一 toolCallId 在账本里只记结算态，不会残留
    // input-available 占位（否则服务商对重复 tool_call_id 400）。
    const settled = allToolParts(messages);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ toolCallId: "call_1", state: "output-available" });

    expect(model.doStreamCalls).toHaveLength(2);
  });

  it("regression: two steps, two tool calls each — every toolCallId appears exactly once in the ledger, all settled (no duplicate tool_call_id)", async () => {
    const toolA: Tool = { description: "d", inputSchema: z.object({}), execute: () => "a-done" };
    const toolB: Tool = { description: "d", inputSchema: z.object({}), execute: () => "b-done" };

    const model = mockModel(() => ({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "tool-call", toolCallId: "call_1", toolName: "tool-a", input: "{}" },
              { type: "tool-call", toolCallId: "call_2", toolName: "tool-b", input: "{}" },
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
              { type: "tool-call", toolCallId: "call_3", toolName: "tool-a", input: "{}" },
              { type: "tool-call", toolCallId: "call_4", toolName: "tool-b", input: "{}" },
              { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
            ],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [{ type: "stream-start", warnings: [] }, { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage }],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        },
      ],
    }));

    const messages: NimboUIMessage[] = [userTextMessage("u1", "go")];
    await drainTurn(runTurn(turnOptions(model, { messages, tools: { "tool-a": toolA, "tool-b": toolB } })));

    const settled = allToolParts(messages);
    expect(settled.map((part) => part.toolCallId).sort()).toEqual(["call_1", "call_2", "call_3", "call_4"]);
    expect(settled.every((part) => part.state === "output-available")).toBe(true);
    // exactly one part per toolCallId — no leftover input-available duplicate.
    expect(new Set(settled.map((part) => part.toolCallId)).size).toBe(settled.length);
  });

  it("data-plan-update 同 id 覆盖 vs data-file-change 逐条追加 (docs/tech/single-ledger.md §2.2b / 关键语义 3)", async () => {
    const store = createPlanStore();
    const derivedData = createDerivedDataCollector();
    const planTool = createUpdatePlanTool({ store, onPlanUpdate: (items) => derivedData.recordPlanUpdate(items) });
    const writeFileTool: Tool = {
      description: "d",
      inputSchema: z.object({ path: z.string() }),
      // `Tool.execute`'s `input` is raw `JsonValue` (types.ts) — the zod `inputSchema` only
      // validates at runtime (runtime.ts's `executeToolCall`), it doesn't narrow the static
      // type here — so `path` is pulled out with a manual structural guard, no cast.
      execute: (input) => {
        const path = typeof input === "object" && input !== null && !Array.isArray(input) && typeof input.path === "string" ? input.path : "";
        derivedData.recordFileChange({ path, kind: "add" });
        return "written";
      },
    };

    const model = mockModel(() => ({
      doStream: [
        {
          // step 1: two update-plan calls AND two write-file calls in the SAME step/message.
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "tool-call", toolCallId: "call_1", toolName: "update-plan", input: JSON.stringify({ items: [{ text: "step a", completed: false }] }) },
              { type: "tool-call", toolCallId: "call_2", toolName: "write-file", input: JSON.stringify({ path: "a.txt" }) },
              { type: "tool-call", toolCallId: "call_3", toolName: "update-plan", input: JSON.stringify({ items: [{ text: "step a", completed: true }] }) },
              { type: "tool-call", toolCallId: "call_4", toolName: "write-file", input: JSON.stringify({ path: "b.txt" }) },
              { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
            ],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        },
        {
          // step 2: one more update-plan call — lands in a DIFFERENT message.
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "tool-call", toolCallId: "call_5", toolName: "update-plan", input: JSON.stringify({ items: [{ text: "step b", completed: false }] }) },
              { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
            ],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [{ type: "stream-start", warnings: [] }, { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage }],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        },
      ],
    }));

    const messages: NimboUIMessage[] = [userTextMessage("u1", "plan and write")];
    await drainTurn(
      runTurn(turnOptions(model, { messages, tools: { "update-plan": planTool, "write-file": writeFileTool }, derivedData })),
    );

    const emptyMessage: NimboUIMessage = { id: "", role: "system", parts: [] };
    const step1Message = messages[1];
    const step2Message = messages[2];
    expect(step1Message).toBeDefined();
    expect(step2Message).toBeDefined();

    // data-plan-update: 同 id 覆盖，但覆盖的作用域是"这一条消息"（ai 的
    // DataUIPart id 更新语义本就是消息内 find/replace，upsertPlanUpdatePart
    // 只在 assistantMessage.parts 里找同 id——见 loop.ts）。step 1 两次
    // update-plan 调用因此在同一条消息里折叠成一个部件，后写覆盖先写。
    const step1PlanParts = planUpdateParts(step1Message ?? emptyMessage);
    expect(step1PlanParts).toHaveLength(1);
    expect(step1PlanParts[0]?.data).toEqual({ items: [{ text: "step a", completed: true }] });

    // data-file-change: 逐条追加，不 upsert——同一条消息里两次 write-file
    // 调用各自产生独立的一条 data-file-change 部件。
    const step1FileParts = fileChangeParts(step1Message ?? emptyMessage);
    expect(step1FileParts.map((part) => part.data)).toEqual([
      { changes: [{ path: "a.txt", kind: "add" }] },
      { changes: [{ path: "b.txt", kind: "add" }] },
    ]);

    // step 2 的 update-plan 调用落在一条新消息里，得到它自己独立的一个
    // data-plan-update 部件（同 id 覆盖的作用域不跨消息）——宿主要拿到"当前
    // 计划"，必须扫描整个账本取最后一次出现的 data-plan-update 部件，不能
    // 假设整个账本只有唯一一个 id="plan-update" 的部件。
    const step2PlanParts = planUpdateParts(step2Message ?? emptyMessage);
    expect(step2PlanParts).toHaveLength(1);
    expect(step2PlanParts[0]?.data).toEqual({ items: [{ text: "step b", completed: false }] });
  });

  it("text-delta chunks accumulate incrementally, and the ledger holds one done text part with the full text", async () => {
    const model = mockModel(() => ({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "Hello, " },
            { type: "text-delta", id: "t1", delta: "world" },
            { type: "text-delta", id: "t1", delta: "!" },
            { type: "text-end", id: "t1" },
            { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      },
    }));

    const messages: NimboUIMessage[] = [userTextMessage("u1", "hi")];
    const { chunks, result } = await drainTurn(runTurn(turnOptions(model, { messages })));

    expect(chunksOfType(chunks, "text-start")).toHaveLength(1);
    expect(chunksOfType(chunks, "text-delta").map((c) => c.delta)).toEqual(["Hello, ", "world", "!"]);
    expect(chunksOfType(chunks, "text-end")).toHaveLength(1);

    const assistant = lastAssistantMessage(messages);
    expect(collectText(assistant)).toBe("Hello, world!");
    expect(assistant?.parts).toContainEqual({ type: "text", text: "Hello, world!", state: "done" });
    expect(result.finalResponse).toBe("Hello, world!");
  });

  it("reasoning-delta accumulates the same way as text-delta, under a distinct part type", async () => {
    const model = mockModel(() => ({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "reasoning-start", id: "r1" },
            { type: "reasoning-delta", id: "r1", delta: "step 1. " },
            { type: "reasoning-delta", id: "r1", delta: "step 2." },
            { type: "reasoning-end", id: "r1" },
            { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      },
    }));

    const messages: NimboUIMessage[] = [userTextMessage("u1", "hi")];
    const { chunks, result } = await drainTurn(runTurn(turnOptions(model, { messages })));

    expect(chunksOfType(chunks, "reasoning-delta").map((c) => c.delta)).toEqual(["step 1. ", "step 2."]);

    const assistant = lastAssistantMessage(messages);
    expect(collectReasoning(assistant)).toBe("step 1. step 2.");
    expect(assistant?.parts).toContainEqual({ type: "reasoning", text: "step 1. step 2.", state: "done" });
    // reasoning text doesn't count toward finalResponse (that's text-part-only)
    expect(result.finalResponse).toBe("");
  });

  /**
   * P13-5-2c 返工（docs/tech/single-ledger.md §6.1/§6.4）：审批三值化后 "denied tool call" 不再是
   * 单一场景——`deny` 结果（策略/分类器直接判定）与 `review` 结果（先产出
   * 请求 chunk、再等真人裁决）走完全不同的 chunk 序列，因此分成下面几个独立
   * 用例，而不是原来那一个混在一起的 "denied tool call" 测试。
   */
  describe("deny outcome (evaluateApproval resolves 'deny' directly — not 'review'): straight to output-denied, no approval-request/response chunks at all (docs/tech/single-ledger.md §6.1)", () => {
    it("per-tool 'deny' policy: no execute(), reason backfilled via both tool-approval-response.reason and the tool-result error-text (docs/tech/single-ledger.md §5 关键语义 10)", async () => {
      const execute = vi.fn(() => "should not run");
      const tool: Tool = { description: "d", inputSchema: z.object({}), approval: "deny", execute };

      const model = mockModel(() => ({
        doStream: [
          {
            stream: simulateReadableStream({
              chunks: [
                { type: "stream-start", warnings: [] },
                { type: "tool-call", toolCallId: "call_1", toolName: "danger", input: "{}" },
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
                { type: "text-delta", id: "t1", delta: "ok, skipping" },
                { type: "text-end", id: "t1" },
                { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
              ],
              initialDelayInMs: null,
              chunkDelayInMs: null,
            }),
          },
        ],
      }));

      const messages: NimboUIMessage[] = [userTextMessage("u1", "do the dangerous thing")];
      const { chunks } = await drainTurn(runTurn(turnOptions(model, { messages, tools: { danger: tool } })));

      expect(chunksOfType(chunks, "tool-approval-request")).toHaveLength(0);
      expect(chunksOfType(chunks, "tool-approval-response")).toHaveLength(0);
      expect(chunksOfType(chunks, "tool-output-denied")).toEqual([{ type: "tool-output-denied", toolCallId: "call_1" }]);
      expect(execute).not.toHaveBeenCalled();

      const settled = allToolParts(messages);
      expect(settled).toHaveLength(1);
      expect(settled[0]).toMatchObject({
        toolCallId: "call_1",
        state: "output-denied",
        approval: { approved: false, reason: "Tool call denied." },
      });

      // 关键语义 10：构造含 deny 的账本 → 官方 convertToModelMessages() → deny 理由
      // 完整可见——即便这条路径从未产出过 approval-request/response chunk，落地
      // 的 UIMessage 终态本身就带着 approval 字段，转换器据此渲染两条内容
      // (tool-approval-response.reason 与 tool-result 的 error-text)。
      const modelMessages = await convertToModelMessages(messages);
      const toolRoleMessage = modelMessages.find((m) => m.role === "tool");
      expect(toolRoleMessage).toBeDefined();
      const approvalResponse = toolRoleMessage?.content.find((c) => c.type === "tool-approval-response");
      expect(approvalResponse).toMatchObject({ approved: false, reason: "Tool call denied." });
      const toolResult = toolRoleMessage?.content.find((c) => c.type === "tool-result");
      expect(toolResult).toMatchObject({ toolCallId: "call_1", output: { type: "error-text", value: "Tool call denied." } });
    });

    it("session classifier resolves 'deny' after per-tool 'review' escalation: still a direct output-denied, no approval-request/response chunks", async () => {
      const execute = vi.fn(() => "should not run");
      const tool: Tool = { description: "d", inputSchema: z.object({}), approval: "review", execute };
      const onApproval: ApprovalPolicy = () => "deny";

      const model = mockModel(() => ({
        doStream: [
          {
            stream: simulateReadableStream({
              chunks: [
                { type: "stream-start", warnings: [] },
                { type: "tool-call", toolCallId: "call_1", toolName: "danger", input: "{}" },
                { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
              ],
              initialDelayInMs: null,
              chunkDelayInMs: null,
            }),
          },
          {
            stream: simulateReadableStream({
              chunks: [{ type: "stream-start", warnings: [] }, { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage }],
              initialDelayInMs: null,
              chunkDelayInMs: null,
            }),
          },
        ],
      }));

      const messages: NimboUIMessage[] = [userTextMessage("u1", "do the dangerous thing")];
      const { chunks } = await drainTurn(runTurn(turnOptions(model, { messages, tools: { danger: tool }, onApproval })));

      expect(chunksOfType(chunks, "tool-approval-request")).toHaveLength(0);
      expect(chunksOfType(chunks, "tool-approval-response")).toHaveLength(0);
      expect(chunksOfType(chunks, "tool-output-denied")).toEqual([{ type: "tool-output-denied", toolCallId: "call_1" }]);
      expect(execute).not.toHaveBeenCalled();
    });
  });

  describe("review resolved but no human reviewer is wired up (SessionOptions.onReview not configured): no-arbiter deny, and no tool-approval-request chunk is ever produced (docs/tech/single-ledger.md §6.4)", () => {
    it("a per-tool callback that itself resolves to 'review' has nobody to ask — denies with the no-arbiter guidance text, no approval-request chunk", async () => {
      const execute = vi.fn(() => "should not run");
      const tool: Tool = { description: "d", inputSchema: z.object({}), approval: (): ApprovalOutcome => "review", execute };

      const model = mockModel(() => ({
        doStream: [
          {
            stream: simulateReadableStream({
              chunks: [
                { type: "stream-start", warnings: [] },
                { type: "tool-call", toolCallId: "call_1", toolName: "danger", input: "{}" },
                { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
              ],
              initialDelayInMs: null,
              chunkDelayInMs: null,
            }),
          },
          {
            stream: simulateReadableStream({
              chunks: [{ type: "stream-start", warnings: [] }, { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage }],
              initialDelayInMs: null,
              chunkDelayInMs: null,
            }),
          },
        ],
      }));

      const messages: NimboUIMessage[] = [userTextMessage("u1", "do the dangerous thing")];
      // Note: no `onReview` passed at all.
      const { chunks } = await drainTurn(runTurn(turnOptions(model, { messages, tools: { danger: tool } })));

      expect(chunksOfType(chunks, "tool-approval-request")).toHaveLength(0);
      expect(chunksOfType(chunks, "tool-output-denied")).toEqual([{ type: "tool-output-denied", toolCallId: "call_1" }]);
      expect(execute).not.toHaveBeenCalled();

      const settled = allToolParts(messages);
      expect(settled[0]).toMatchObject({ toolCallId: "call_1", state: "output-denied" });
      expect(settled[0]?.approval?.reason).toContain("no approver configured");
    });
  });

  describe("review resolved AND a human reviewer (onReview) is wired up: approval-request chunk first, then await onReview, then approval-response (docs/tech/single-ledger.md §6.1/§6.4 P13-5-2c '先产出后阻塞')", () => {
    function reviewScenario(tool: Tool, onReview: ApprovalReviewer) {
      const onApproval: ApprovalPolicy = () => "review"; // session classifier: this call needs a human
      const model = mockModel(() => ({
        doStream: [
          {
            stream: simulateReadableStream({
              chunks: [
                { type: "stream-start", warnings: [] },
                { type: "tool-call", toolCallId: "call_1", toolName: "danger", input: "{}" },
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
                { type: "text-delta", id: "t1", delta: "ok" },
                { type: "text-end", id: "t1" },
                { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
              ],
              initialDelayInMs: null,
              chunkDelayInMs: null,
            }),
          },
        ],
      }));
      const messages: NimboUIMessage[] = [userTextMessage("u1", "do the dangerous thing")];
      return { messages, turnOpts: turnOptions(model, { messages, tools: { danger: tool }, onApproval, onReview }) };
    }

    it("onReview allows: tool-approval-request → tool-approval-response(approved:true) → executes → output-available", async () => {
      const execute = vi.fn(() => "ran");
      const tool: Tool = { description: "d", inputSchema: z.object({}), approval: "review", execute };
      const onReview = vi.fn(async (): Promise<HumanDecision> => ({ behavior: "allow" }));

      const { messages, turnOpts } = reviewScenario(tool, onReview);
      const { chunks } = await drainTurn(runTurn(turnOpts));

      expect(onReview).toHaveBeenCalledTimes(1);
      expect(onReview).toHaveBeenCalledWith({ toolName: "danger", input: {}, ctx: { toolName: "danger", callId: "call_1", session: { id: "sess_1", turn: 1 } } });
      expect(chunksOfType(chunks, "tool-approval-request")).toEqual([
        { type: "tool-approval-request", approvalId: "call_1", toolCallId: "call_1" },
      ]);
      expect(chunksOfType(chunks, "tool-approval-response")).toEqual([
        { type: "tool-approval-response", approvalId: "call_1", approved: true },
      ]);
      expect(chunksOfType(chunks, "tool-output-available")).toHaveLength(1);
      expect(execute).toHaveBeenCalledTimes(1);

      const settled = allToolParts(messages);
      expect(settled).toHaveLength(1);
      expect(settled[0]).toMatchObject({
        toolCallId: "call_1",
        state: "output-available",
        approval: { approved: true },
      });
    });

    it("onReview denies with a message: tool-approval-request → tool-approval-response(approved:false, reason) → output-denied, no execute(); reason backfilled to the model (docs/tech/single-ledger.md §5 关键语义 10)", async () => {
      const execute = vi.fn(() => "should not run");
      const tool: Tool = { description: "d", inputSchema: z.object({}), approval: "review", execute };
      const onReview = vi.fn(async (): Promise<HumanDecision> => ({ behavior: "deny", message: "not allowed in prod" }));

      const { messages, turnOpts } = reviewScenario(tool, onReview);
      const { chunks } = await drainTurn(runTurn(turnOpts));

      expect(chunksOfType(chunks, "tool-approval-request")).toEqual([
        { type: "tool-approval-request", approvalId: "call_1", toolCallId: "call_1" },
      ]);
      expect(chunksOfType(chunks, "tool-approval-response")).toEqual([
        { type: "tool-approval-response", approvalId: "call_1", approved: false, reason: "not allowed in prod" },
      ]);
      expect(chunksOfType(chunks, "tool-output-denied")).toEqual([{ type: "tool-output-denied", toolCallId: "call_1" }]);
      expect(execute).not.toHaveBeenCalled();

      const settled = allToolParts(messages);
      expect(settled[0]).toMatchObject({
        toolCallId: "call_1",
        state: "output-denied",
        approval: { approved: false, reason: "not allowed in prod" },
      });

      const modelMessages = await convertToModelMessages(messages);
      const toolRoleMessage = modelMessages.find((m) => m.role === "tool");
      const approvalResponse = toolRoleMessage?.content.find((c) => c.type === "tool-approval-response");
      expect(approvalResponse).toMatchObject({ approved: false, reason: "not allowed in prod" });
      const toolResult = toolRoleMessage?.content.find((c) => c.type === "tool-result");
      expect(toolResult).toMatchObject({ toolCallId: "call_1", output: { type: "error-text", value: "not allowed in prod" } });
    });

    it("onReview denies without a message: falls back to the default deny text (docs/tech/single-ledger.md §6.3 message is optional)", async () => {
      const tool: Tool = { description: "d", inputSchema: z.object({}), approval: "review", execute: () => "should not run" };
      const onReview = vi.fn(async (): Promise<HumanDecision> => ({ behavior: "deny" }));

      const { chunks } = await drainTurn(runTurn(reviewScenario(tool, onReview).turnOpts));

      expect(chunksOfType(chunks, "tool-approval-response")).toEqual([
        { type: "tool-approval-response", approvalId: "call_1", approved: false, reason: "Tool call denied." },
      ]);
    });

    it("chunk ordering: tool-approval-request reaches the stream consumer before onReview is ever invoked (the 'yield-then-await' fix this rework is about — see loop.ts file header)", async () => {
      const execute = vi.fn(() => "ran");
      const tool: Tool = { description: "d", inputSchema: z.object({}), approval: "review", execute };

      let reviewInvoked = false;
      let resolveReview: ((decision: HumanDecision) => void) | undefined;
      const onReview: ApprovalReviewer = () => {
        reviewInvoked = true;
        return new Promise<HumanDecision>((resolve) => {
          resolveReview = resolve;
        });
      };

      const { turnOpts } = reviewScenario(tool, onReview);
      const gen = runTurn(turnOpts);

      let next = await gen.next();
      while (!next.done && next.value.type !== "tool-approval-request") {
        next = await gen.next();
      }
      expect(next.done).toBe(false);
      // The generator is suspended exactly at the `yield` — the statement that calls
      // `onReview(...)` comes *after* it, so it hasn't run yet at this instant.
      expect(reviewInvoked).toBe(false);

      // Resuming the generator runs synchronously up to (and including) the `onReview(...)`
      // call, then suspends again on the still-pending promise it returned — so `reviewInvoked`
      // flips to `true` as soon as `.next()` is called, with no need to await it first.
      const pendingNext = gen.next();
      expect(reviewInvoked).toBe(true);

      resolveReview?.({ behavior: "allow" });
      await pendingNext;
      let rest = await gen.next();
      while (!rest.done) {rest = await gen.next();}

      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("review-once via onReview (docs/tech/single-ledger.md §6.1 review-once + P13-5-2c once-memory 标记时机): the human's decision — not the classifier's — controls whether once-memory gets marked", () => {
    function reviewOnceScenario(execute: () => string, onReview: ApprovalReviewer) {
      const tool: Tool = { description: "d", inputSchema: z.object({}), approval: "review-once", execute };
      const onApproval: ApprovalPolicy = () => "review"; // session classifier always defers to a human
      const model = mockModel(() => ({
        doStream: [
          {
            stream: simulateReadableStream({
              chunks: [
                { type: "stream-start", warnings: [] },
                { type: "tool-call", toolCallId: "call_1", toolName: "gated", input: "{}" },
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
                { type: "tool-call", toolCallId: "call_2", toolName: "gated", input: "{}" },
                { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
              ],
              initialDelayInMs: null,
              chunkDelayInMs: null,
            }),
          },
          {
            stream: simulateReadableStream({
              chunks: [{ type: "stream-start", warnings: [] }, { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage }],
              initialDelayInMs: null,
              chunkDelayInMs: null,
            }),
          },
        ],
      }));
      const messages: NimboUIMessage[] = [userTextMessage("u1", "go")];
      return turnOptions(model, { messages, tools: { gated: tool }, onApproval, onReview });
    }

    it("first call: onReview allow → marks once-memory → second call for the same tool is a direct allow (no approval-request, no onReview)", async () => {
      const execute = vi.fn(() => "ok");
      const onReview = vi.fn(async (): Promise<HumanDecision> => ({ behavior: "allow" }));

      const { chunks } = await drainTurn(runTurn(reviewOnceScenario(execute, onReview)));

      expect(chunksOfType(chunks, "tool-approval-request")).toHaveLength(1);
      expect(onReview).toHaveBeenCalledTimes(1);
      expect(chunksOfType(chunks, "tool-output-available")).toHaveLength(2);
      expect(execute).toHaveBeenCalledTimes(2);
    });

    it("first call: onReview deny → does NOT mark once-memory → second call for the same tool still goes through approval-request again", async () => {
      const execute = vi.fn(() => "ok");
      const onReview = vi
        .fn<() => Promise<HumanDecision>>()
        .mockResolvedValueOnce({ behavior: "deny", message: "no, not this time" })
        .mockResolvedValueOnce({ behavior: "allow" });

      const { chunks } = await drainTurn(runTurn(reviewOnceScenario(execute, onReview)));

      expect(chunksOfType(chunks, "tool-approval-request")).toHaveLength(2);
      expect(onReview).toHaveBeenCalledTimes(2);
      expect(chunksOfType(chunks, "tool-output-denied")).toHaveLength(1);
      expect(chunksOfType(chunks, "tool-output-available")).toHaveLength(1);
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  it("allows via the default 'allow' policy without consulting onApproval", async () => {
    const execute = vi.fn(() => "ok");
    const tool: Tool = { description: "d", inputSchema: z.object({}), execute };
    const onApproval = vi.fn();

    const model = mockModel(() => ({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "tool-call", toolCallId: "call_1", toolName: "safe", input: "{}" },
              { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
            ],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [{ type: "stream-start", warnings: [] }, { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage }],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        },
      ],
    }));

    const messages: NimboUIMessage[] = [userTextMessage("u1", "go")];
    const { chunks } = await drainTurn(runTurn(turnOptions(model, { messages, tools: { safe: tool }, onApproval })));

    expect(chunksOfType(chunks, "tool-approval-request")).toHaveLength(0);
    expect(chunksOfType(chunks, "tool-output-available")).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(onApproval).not.toHaveBeenCalled();
  });

  it("'review-once' approval memory persists across steps within the same turn — a session classifier that itself resolves synchronously to 'allow' asks only once, and never touches onReview at all (docs/tech/single-ledger.md §6.1 once-memory timing)", async () => {
    const execute = vi.fn(() => "ok");
    const tool: Tool = { description: "d", inputSchema: z.object({}), approval: "review-once", execute };
    const onApproval = vi.fn((): ApprovalOutcome => "allow");

    const model = mockModel(() => ({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "tool-call", toolCallId: "call_1", toolName: "gated", input: "{}" },
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
              { type: "tool-call", toolCallId: "call_2", toolName: "gated", input: "{}" },
              { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
            ],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [{ type: "stream-start", warnings: [] }, { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage }],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        },
      ],
    }));

    const messages: NimboUIMessage[] = [userTextMessage("u1", "go")];
    // Deliberately no `onReview` — resolveToolCallApproval must resolve straight to "allow"
    // (never "review") since the classifier itself answers synchronously.
    const { chunks } = await drainTurn(runTurn(turnOptions(model, { messages, tools: { gated: tool }, onApproval })));

    expect(chunksOfType(chunks, "tool-output-available")).toHaveLength(2);
    expect(chunksOfType(chunks, "tool-approval-request")).toHaveLength(0);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(onApproval).toHaveBeenCalledTimes(1);
  });

  /**
   * 两条失败路径（docs/tech/single-ledger.md §5 关键语义 8）——实测确认（见工单回报"发现的 src
   * 真实缺陷"）：模型调用一个完全未声明的工具名，与模型对一个已声明工具给出
   * 不可解析/不满足 schema 的输入，在当前实现下走的是**同一个**机制：AI SDK
   * 自己的 `parseToolCall`（`NoSuchToolError`/`InvalidToolInputError` 都被同一个
   * `catch` 收敛成 `dynamic:true, invalid:true`）在 `streamText()` 内部就拦下了
   * 调用，`runOneStep` 据此直接落 `tool-input-error`/`output-error`,**不会**先
   * 产出 `tool-input-available`——`settleToolCall` 自己的"Unknown tool"分支
   * （`opts.tools[toolName] === undefined`）在这条调用路径上不可达，见下方
   * 两个测试各自的行内注释。
   */
  it("unknown tool name (hallucinated call, never declared to the model): fails gracefully as a direct output-error, no tool-input-available first", async () => {
    const model = mockModel(() => ({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "tool-call", toolCallId: "call_1", toolName: "does_not_exist", input: "{}" },
              { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
            ],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [{ type: "stream-start", warnings: [] }, { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage }],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        },
      ],
    }));

    const messages: NimboUIMessage[] = [userTextMessage("u1", "go")];
    const { chunks, result } = await drainTurn(runTurn(turnOptions(model, { messages, tools: {} })));

    // AI SDK intercepts the call before it ever becomes a pending tool execution —
    // no tool-input-available chunk for this toolCallId at all.
    expect(chunksOfType(chunks, "tool-input-available")).toHaveLength(0);
    const errorChunks = chunksOfType(chunks, "tool-input-error");
    expect(errorChunks).toHaveLength(1);
    expect(errorChunks[0]?.toolCallId).toBe("call_1");
    expect(errorChunks[0]?.errorText).toContain("does_not_exist");

    const settled = allToolParts(messages);
    expect(settled).toEqual([
      { type: "tool-does_not_exist", toolCallId: "call_1", state: "output-error", errorText: errorChunks[0]?.errorText },
    ]);

    expect(chunksOfType(chunks, "message-metadata")[0]?.messageMetadata.status).toBe("completed");
    expect(result.finalResponse).toBe("");
  });

  it("malformed dynamic call: unparseable/schema-invalid input for a *registered* tool also fails as a direct output-error, no intermediate state (same mechanism as the unknown-name case above)", async () => {
    const execute = vi.fn(() => "should not run");
    const tool: Tool = { description: "d", inputSchema: z.object({ q: z.string() }), execute };

    const model = mockModel(() => ({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "tool-call", toolCallId: "call_1", toolName: "search", input: "not valid json{{{" },
              { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
            ],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [{ type: "stream-start", warnings: [] }, { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage }],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        },
      ],
    }));

    const messages: NimboUIMessage[] = [userTextMessage("u1", "search")];
    const { chunks } = await drainTurn(runTurn(turnOptions(model, { messages, tools: { search: tool } })));

    expect(chunksOfType(chunks, "tool-input-available")).toHaveLength(0);
    const errorChunks = chunksOfType(chunks, "tool-input-error");
    expect(errorChunks).toHaveLength(1);
    expect(errorChunks[0]?.errorText).toContain("search");
    expect(execute).not.toHaveBeenCalled();

    const settled = allToolParts(messages);
    expect(settled).toEqual([{ type: "tool-search", toolCallId: "call_1", state: "output-error", errorText: errorChunks[0]?.errorText }]);
  });

  it("abort: an already-aborted signal ends the turn with message-metadata status:'interrupted', error.code:'aborted'", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop now"));

    const model = mockModel(() => ({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "hi" },
            { type: "text-end", id: "t1" },
            { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      }),
    }));

    const messages: NimboUIMessage[] = [userTextMessage("u1", "hi")];
    const { chunks } = await drainTurn(runTurn(turnOptions(model, { messages, signal: controller.signal })));

    const metadataChunks = chunksOfType(chunks, "message-metadata");
    expect(metadataChunks).toHaveLength(1);
    expect(metadataChunks[0]?.messageMetadata.status).toBe("interrupted");
    expect(metadataChunks[0]?.messageMetadata.error?.code).toBe("aborted");

    // 关键语义 6：即便还没跑过任何一步，也要有一条 assistant 消息承接失败 metadata。
    const assistant = lastAssistantMessage(messages);
    expect(assistant?.metadata?.status).toBe("interrupted");

    // 发现的 src 缺陷（见工单回报，未修复）：`runOneStep` 在调用
    // `streamText()` 之后、消费 `result.stream` 之前就把占位 assistant 消息
    // push 进了 `opts.ledger`（loop.ts 444-445 行）；abort 导致 `for await`
    // 抛出时，`runTurn` 的 catch 块（609-622 行）并不知道这条已经 push 的
    // 半成品消息——它自己的 `lastAssistantMessage` 局部变量只在 `runOneStep`
    // 成功 return 后才更新，仍是 `undefined`，于是 `finalizeTurn` 又新造一条
    // 占位消息承接 metadata。账本里因此残留两条 assistant 消息：一条空的
    // （只有 `step-start`，没有 metadata，是孤儿）+ 一条真正携带失败
    // metadata 的。正确应恰好一条。下面这个断言按"应有行为"编写，当前会失败。
    expect(messages).toHaveLength(2);
  });

  it("abort during a tool execution: the turn stops at the next step boundary without another model call (docs/tech/turn-abort.md §2)", async () => {
    const controller = new AbortController();

    // 「用户在工具跑到一半时按了停止」：工具自己以成功/失败**正常收尾**（"失败即
    // ExecResult"，不抛），所以这一步是正常结束的——若没有 step 边界的 abort 检查，
    // loop 会照常进入第二步、白打一次模型调用。
    const tool: Tool = {
      description: "d",
      inputSchema: z.object({}),
      execute: () => {
        controller.abort(new Error("stopped by the user"));
        return "partial output";
      },
    };

    const model = mockModel(() => ({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "tool-call", toolCallId: "call_1", toolName: "slow", input: "{}" },
              { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
            ],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        },
      ],
    }));
    const doStreamSpy = vi.spyOn(model, "doStream");

    const messages: NimboUIMessage[] = [userTextMessage("u1", "hi")];
    const { chunks } = await drainTurn(
      runTurn(turnOptions(model, { messages, tools: { slow: tool }, signal: controller.signal })),
    );

    // 只调过一次模型——第二步从未开始（本检查的全部意义）。`doStream` 的 mock 也只
    // 配了一份响应，所以真跑第二步会以另一种方式炸掉，双重保险。
    expect(doStreamSpy).toHaveBeenCalledTimes(1);

    const metadataChunks = chunksOfType(chunks, "message-metadata");
    expect(metadataChunks).toHaveLength(1);
    expect(metadataChunks[0]?.messageMetadata.status).toBe("interrupted");
    expect(metadataChunks[0]?.messageMetadata.error?.code).toBe("aborted");

    // 已产出的东西全部留着（停止不是撤销）：那次工具调用照常结算成 output-available，
    // 收尾 metadata 落在这一步自己的 assistant 消息上，不新造孤儿占位消息。
    expect(allToolParts(messages)).toEqual([
      { type: "tool-slow", toolCallId: "call_1", state: "output-available", input: {}, output: "partial output" },
    ]);
    expect(messages).toHaveLength(2);
    expect(lastAssistantMessage(messages)?.metadata?.status).toBe("interrupted");
  });

  // 宿主给的中止理由要透传进收尾 message（docs/tech/graceful-shutdown.md §2）——
  // 宿主靠它区分「用户按了停止」和「进程要关闭了」，core 自己不认识这些概念。
  it("abort reason: the host's own `abort(reason)` message is what lands in NimboError.message", async () => {
    const controller = new AbortController();
    controller.abort(new Error("The server shut down while this turn was running."));

    const model = mockModel(() => ({
      doStream: async () => {
        throw new Error("unreachable — the step boundary check fires first");
      },
    }));

    const messages: NimboUIMessage[] = [userTextMessage("u1", "hi")];
    const { chunks } = await drainTurn(runTurn(turnOptions(model, { messages, signal: controller.signal })));

    const metadataChunks = chunksOfType(chunks, "message-metadata");
    expect(metadataChunks[0]?.messageMetadata.error).toEqual({
      code: "aborted",
      message: "The server shut down while this turn was running.",
    });
  });

  it("abort reason: a bare `abort()` falls back to the default wording (the runtime's own AbortError is not the host's explanation)", async () => {
    const controller = new AbortController();
    controller.abort(); // reason 是运行时自造的 AbortError

    const model = mockModel(() => ({
      doStream: async () => {
        throw new Error("unreachable — the step boundary check fires first");
      },
    }));

    const messages: NimboUIMessage[] = [userTextMessage("u1", "hi")];
    const { chunks } = await drainTurn(runTurn(turnOptions(model, { messages, signal: controller.signal })));

    const metadataChunks = chunksOfType(chunks, "message-metadata");
    expect(metadataChunks[0]?.messageMetadata.error?.code).toBe("aborted");
    // 不是 "This operation was aborted"（那是运行时的措辞，与调用方无关）。
    expect(metadataChunks[0]?.messageMetadata.error?.message).toBe(
      "Turn aborted by the host before this step began.",
    );
  });

  it("provider error (not abort-related): message-metadata status:'failed', error.code:'provider_error' carries the underlying message", async () => {
    const model = mockModel(() => ({
      doStream: async () => {
        throw new Error("network exploded");
      },
    }));

    const messages: NimboUIMessage[] = [userTextMessage("u1", "hi")];
    const { chunks } = await drainTurn(runTurn(turnOptions(model, { messages })));

    const metadataChunks = chunksOfType(chunks, "message-metadata");
    expect(metadataChunks[0]?.messageMetadata.status).toBe("failed");
    expect(metadataChunks[0]?.messageMetadata.error?.code).toBe("provider_error");
    // AI SDK's retry layer re-wraps a synchronous doStream throw (its own message doesn't
    // necessarily survive verbatim) — assert the failure surfaced as a non-empty message
    // rather than pin to `ai`'s internal wording, which isn't nimbo's contract to test.
    expect(typeof metadataChunks[0]?.messageMetadata.error?.message).toBe("string");
    expect(metadataChunks[0]?.messageMetadata.error?.message.length).toBeGreaterThan(0);

    // 发现的 src 缺陷（同上一个测试"abort"里的行内注释，同一处根因）：
    // doStream 抛出时账本里同样残留一条孤儿占位 assistant 消息——正确应恰好
    // 一条（user + 携带失败 metadata 的 assistant）。下面这个断言按"应有
    // 行为"编写，当前会失败。
    expect(messages).toHaveLength(2);
  });

  it("maxTurnsPerRun: the last allowed step's tool calls still execute to completion (settled, not left dangling), then message-metadata status:'failed'/max_turns", async () => {
    const tool: Tool = { description: "d", inputSchema: z.object({}), execute: () => "ok" };

    const model = mockModel(() => ({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "tool-call", toolCallId: "call_1", toolName: "loop_tool", input: "{}" },
              { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
            ],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        },
      ],
    }));

    const messages: NimboUIMessage[] = [userTextMessage("u1", "go forever")];
    const { chunks } = await drainTurn(runTurn(turnOptions(model, { messages, tools: { loop_tool: tool }, maxTurnsPerRun: 1 })));

    // 关键语义 6：预算耗尽且末步仍 tool-calls 时结算态不悬空——工具已经正常
    // 结算到 output-available，不是"到达上限就拒绝执行"。
    const settled = allToolParts(messages);
    expect(settled).toEqual([{ type: "tool-loop_tool", toolCallId: "call_1", state: "output-available", input: {}, output: "ok" }]);

    const metadataChunks = chunksOfType(chunks, "message-metadata");
    expect(metadataChunks[0]?.messageMetadata.status).toBe("failed");
    expect(metadataChunks[0]?.messageMetadata.error?.code).toBe("max_turns");
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it("context_overflow: fails before ever calling the model when the estimate already exceeds maxContextTokens, with a placeholder assistant message carrying the failure metadata", async () => {
    const doStream = vi.fn(() => {
      throw new Error("must not be called — context already exceeds maxContextTokens");
    });
    const model = mockModel(() => ({ doStream }));

    const messages: NimboUIMessage[] = [userTextMessage("u1", "x".repeat(1000))];
    const { chunks } = await drainTurn(runTurn(turnOptions(model, { messages, maxContextTokens: 1 })));

    const metadataChunks = chunksOfType(chunks, "message-metadata");
    expect(metadataChunks[0]?.messageMetadata.status).toBe("failed");
    expect(metadataChunks[0]?.messageMetadata.error?.code).toBe("context_overflow");
    expect(doStream).not.toHaveBeenCalled();

    // 关键语义 6：maxContextTokens pre-flight 失败时没有任何 assistant 消息
    // （从未进入一步）——loop.ts 的 finalizeTurn 现造一条占位消息承接。
    const assistant = lastAssistantMessage(messages);
    expect(assistant).toBeDefined();
    expect(assistant?.parts).toEqual([{ type: "step-start" }]);
    expect(assistant?.metadata?.status).toBe("failed");
    expect(assistant?.metadata?.error?.code).toBe("context_overflow");
  });

  it("does not check context when maxContextTokens is left undefined (opt-in)", async () => {
    const model = mockModel(() => ({
      doStream: {
        stream: simulateReadableStream({
          chunks: [{ type: "stream-start", warnings: [] }, { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage }],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      },
    }));

    const messages: NimboUIMessage[] = [userTextMessage("u1", "x".repeat(1000))];
    const { chunks } = await drainTurn(runTurn(turnOptions(model, { messages, maxContextTokens: undefined })));

    const metadataChunks = chunksOfType(chunks, "message-metadata");
    expect(metadataChunks).toHaveLength(1);
    expect(metadataChunks[0]?.messageMetadata.status).toBe("completed");
  });

  it("maxTurnsPerRun <= 0 leaves no steps to run: message-metadata status:'failed'/max_turns without ever calling the model", async () => {
    const model = mockModel(() => ({
      doStream: vi.fn(() => {
        throw new Error("must not be called — zero step budget");
      }),
    }));

    const messages: NimboUIMessage[] = [userTextMessage("u1", "go")];
    const { chunks } = await drainTurn(runTurn(turnOptions(model, { messages, maxTurnsPerRun: 0 })));

    const metadataChunks = chunksOfType(chunks, "message-metadata");
    expect(metadataChunks[0]?.messageMetadata.status).toBe("failed");
    expect(metadataChunks[0]?.messageMetadata.error?.code).toBe("max_turns");
    expect(model.doStreamCalls).toHaveLength(0);
  });

  it("context estimate stays within budget across steps: calibration from step 1's usage doesn't false-positive on step 2", async () => {
    const tool: Tool = { description: "d", inputSchema: z.object({}), execute: () => "ok" };

    const model = mockModel(() => ({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "tool-call", toolCallId: "call_1", toolName: "t", input: "{}" },
              { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
            ],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [{ type: "stream-start", warnings: [] }, { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage }],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        },
      ],
    }));

    const messages: NimboUIMessage[] = [userTextMessage("u1", "go")];
    const { chunks } = await drainTurn(runTurn(turnOptions(model, { messages, tools: { t: tool }, maxContextTokens: 100_000 })));

    const metadataChunks = chunksOfType(chunks, "message-metadata");
    expect(metadataChunks[0]?.messageMetadata.status).toBe("completed");
    expect(model.doStreamCalls).toHaveLength(2);
  });

  it("ctx.update() progress ticks replay as accumulating transient data-tool-progress chunks — they reach the stream but never land in the ledger", async () => {
    const tool: Tool = {
      description: "d",
      inputSchema: z.object({}),
      execute: async (_input, ctx) => {
        ctx.update("step 1... ");
        ctx.update("step 2... ");
        ctx.update("done.");
        return "final result";
      },
    };

    const model = mockModel(() => ({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "tool-call", toolCallId: "call_1", toolName: "slow_tool", input: "{}" },
              { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
            ],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [{ type: "stream-start", warnings: [] }, { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage }],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        },
      ],
    }));

    const messages: NimboUIMessage[] = [userTextMessage("u1", "go slowly")];
    const { chunks } = await drainTurn(runTurn(turnOptions(model, { messages, tools: { slow_tool: tool } })));

    const progressChunks = chunksOfType(chunks, "data-tool-progress");
    expect(progressChunks.map((c) => c.data.text)).toEqual(["step 1... ", "step 1... step 2... ", "step 1... step 2... done."]);
    expect(progressChunks.every((c) => c.transient === true)).toBe(true);

    const settled = allToolParts(messages);
    expect(settled).toEqual([{ type: "tool-slow_tool", toolCallId: "call_1", state: "output-available", input: {}, output: "final result" }]);

    // docs/tech/single-ledger.md §4.1 发现 A：transient 只出流，绝不进 UIMessage.parts/序列化存档——
    // 没有任何 data-tool-progress 部件残留在账本里。
    const assistant = messages.find((m) => allToolParts([m]).some((p) => p.toolCallId === "call_1"));
    expect(assistant).toBeDefined();
    if (assistant !== undefined) {expect(toolProgressParts(assistant)).toHaveLength(0);}
  });

  it("tool-input-delta chunks are consumed without independently driving tool-input-available (see loop.ts file header)", async () => {
    const model = mockModel(() => ({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "tool-input-start", id: "call_1", toolName: "search" },
            { type: "tool-input-delta", id: "call_1", delta: '{"q":' },
            { type: "tool-input-delta", id: "call_1", delta: '"nimbo"}' },
            { type: "tool-input-end", id: "call_1" },
            { type: "tool-call", toolCallId: "call_1", toolName: "search", input: '{"q":"nimbo"}' },
            { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      },
    }));

    const tool: Tool = { description: "d", inputSchema: z.object({ q: z.string() }), execute: () => "ok" };
    const messages: NimboUIMessage[] = [userTextMessage("u1", "search")];
    const { chunks } = await drainTurn(runTurn(turnOptions(model, { messages, tools: { search: tool }, maxTurnsPerRun: 1 })));

    // exactly one tool-input-available chunk for call_1 (the deltas produced none), with the
    // fully parsed input from the terminal tool-call event.
    const available = chunksOfType(chunks, "tool-input-available");
    expect(available).toHaveLength(1);
    expect(available[0]?.input).toEqual({ q: "nimbo" });
  });

  it("aggregates usage across steps into TurnResult.usage / message-metadata", async () => {
    const tool: Tool = { description: "d", inputSchema: z.object({}), execute: () => "ok" };

    const model = mockModel(() => ({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "tool-call", toolCallId: "call_1", toolName: "t", input: "{}" },
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: undefined },
                usage: { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } },
              },
            ],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: undefined },
                usage: { inputTokens: { total: 20, noCache: 20, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 3, text: 3, reasoning: undefined } },
              },
            ],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        },
      ],
    }));

    const messages: NimboUIMessage[] = [userTextMessage("u1", "go")];
    const { chunks, result } = await drainTurn(runTurn(turnOptions(model, { messages, tools: { t: tool } })));

    // `LanguageModelUsage.totalTokens` is computed by the AI SDK per step (input+output for
    // that step) even though the raw mock usage chunks here only supply input/output — the two
    // per-step totals (15 and 23) sum to 38, which `mergeUsage` then aggregates like the other fields.
    expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 8, totalTokens: 38 });
    const metadataChunks = chunksOfType(chunks, "message-metadata");
    expect(metadataChunks[0]?.messageMetadata.usage).toEqual(result.usage);
  });

  /**
   * chat 可观测性（工单："nimbo chat server 加 step / tool call 级别日志；
   * chat web 给每个 tool call 卡片展示启动时间、完成时间、耗时"）：`state.ts`
   * 的 `toolTimingDataSchema` + `loop.ts` 的 `startToolTiming`/
   * `completeToolTiming`——每个工具调用一条 `data-tool-timing` 持久部件，
   * `tool-input-available` 后立刻打 `startedAt`，每条结算 chunk 之后立刻补
   * `completedAt`。时间断言全部用 `vi.useFakeTimers()`/`vi.setSystemTime()`
   * 钉死具体数值，不用宽容区间碰运气。
   */
  describe("telemetry 透传（SessionTelemetry）", () => {
    function stopOnlyStream(): MockLanguageModelV4 {
      return mockModel(() => ({
        doStream: [
          {
            stream: simulateReadableStream({
              chunks: [
                { type: "stream-start", warnings: [] },
                { type: "text-start", id: "t1" },
                { type: "text-delta", id: "t1", delta: "ok" },
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

    it("injected integrations receive model-call lifecycle events, each carrying functionId '<sessionId>#<turn>'", async () => {
      const seen: { hook: string; functionId: string | undefined }[] = [];
      const integration: Telemetry = {
        onLanguageModelCallStart: (event) => {
          seen.push({ hook: "call-start", functionId: event.functionId });
        },
        onLanguageModelCallEnd: (event) => {
          seen.push({ hook: "call-end", functionId: event.functionId });
        },
      };

      const messages: NimboUIMessage[] = [userTextMessage("u1", "go")];
      await drainTurn(
        runTurn(turnOptions(stopOnlyStream(), { messages, session: { id: "sess_42", turn: 7 }, telemetry: { integrations: [integration] } })),
      );

      const hooks = seen.map((entry) => entry.hook);
      expect(hooks).toContain("call-start");
      expect(hooks).toContain("call-end");
      // 关联键：每个事件都自带 "<sessionId>#<turn>"，集成端据此归档/按 turn 查询。
      for (const entry of seen) {expect(entry.functionId).toBe("sess_42#7");}
    });

    it("no telemetry injected: the turn runs identically (functionId alone is inert metadata)", async () => {
      const messages: NimboUIMessage[] = [userTextMessage("u1", "go")];
      const { chunks } = await drainTurn(runTurn(turnOptions(stopOnlyStream(), { messages })));
      expect(chunksOfType(chunks, "message-metadata").at(-1)?.messageMetadata).toMatchObject({ status: "completed" });
    });

    it("loop 替 AI SDK 补发 onToolExecutionStart/End（nimbo 自己执行工具，SDK 没机会发），带同款 functionId 关联键与 toolExecutionMs", async () => {
      const started: unknown[] = [];
      const ended: { toolExecutionMs: number; toolOutput: { type: string }; functionId?: string }[] = [];
      const integration: Telemetry = {
        onToolExecutionStart: (event) => {
          started.push(event);
        },
        onToolExecutionEnd: (event) => {
          ended.push({ toolExecutionMs: event.toolExecutionMs, toolOutput: event.toolOutput, functionId: event.functionId });
        },
      };
      const model = mockModel(() => ({
        doStream: [
          {
            stream: simulateReadableStream({
              chunks: [
                { type: "stream-start", warnings: [] },
                { type: "tool-call", toolCallId: "call_1", toolName: "t", input: "{}" },
                { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
              ],
              initialDelayInMs: null,
              chunkDelayInMs: null,
            }),
          },
          {
            stream: simulateReadableStream({
              chunks: [{ type: "stream-start", warnings: [] }, { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage }],
              initialDelayInMs: null,
              chunkDelayInMs: null,
            }),
          },
        ],
      }));
      const tool: Tool = { description: "d", inputSchema: z.object({}), execute: () => "ok" };

      const messages: NimboUIMessage[] = [userTextMessage("u1", "go")];
      await drainTurn(
        runTurn(turnOptions(model, { messages, session: { id: "sess_9", turn: 2 }, tools: { t: tool }, telemetry: { integrations: [integration] } })),
      );

      expect(started).toHaveLength(1);
      expect(ended).toHaveLength(1);
      expect(ended[0]?.functionId).toBe("sess_9#2");
      expect(ended[0]?.toolOutput.type).toBe("tool-result");
      expect(typeof ended[0]?.toolExecutionMs).toBe("number");
    });

    it("deny 路径从未执行——不补发任何工具执行遥测（与 executionStartedAt 缺席同语义）", async () => {
      const toolEvents: string[] = [];
      const integration: Telemetry = {
        onToolExecutionStart: () => {
          toolEvents.push("start");
        },
        onToolExecutionEnd: () => {
          toolEvents.push("end");
        },
      };
      const model = mockModel(() => ({
        doStream: [
          {
            stream: simulateReadableStream({
              chunks: [
                { type: "stream-start", warnings: [] },
                { type: "tool-call", toolCallId: "call_1", toolName: "t", input: "{}" },
                { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
              ],
              initialDelayInMs: null,
              chunkDelayInMs: null,
            }),
          },
          {
            stream: simulateReadableStream({
              chunks: [{ type: "stream-start", warnings: [] }, { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage }],
              initialDelayInMs: null,
              chunkDelayInMs: null,
            }),
          },
        ],
      }));
      const tool: Tool = { description: "d", inputSchema: z.object({}), approval: "deny", execute: () => "never" };

      const messages: NimboUIMessage[] = [userTextMessage("u1", "go")];
      const { chunks } = await drainTurn(runTurn(turnOptions(model, { messages, tools: { t: tool }, telemetry: { integrations: [integration] } })));

      expect(chunksOfType(chunks, "tool-output-denied")).toHaveLength(1);
      expect(toolEvents).toEqual([]);
    });
  });

  describe("data-tool-timing (工具调用起止时间戳)", () => {
    /** A model that emits one `tool-call` for "call_1"/"t" then, next step, stops with no text — the real `Tool` (with its own `execute`) is supplied separately via `turnOptions({ tools: { t: ... } })`. */
    function singleToolCallModel(): MockLanguageModelV4 {
      return mockModel(() => ({
        doStream: [
          {
            stream: simulateReadableStream({
              chunks: [
                { type: "stream-start", warnings: [] },
                { type: "tool-call", toolCallId: "call_1", toolName: "t", input: "{}" },
                { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
              ],
              initialDelayInMs: null,
              chunkDelayInMs: null,
            }),
          },
          {
            stream: simulateReadableStream({
              chunks: [{ type: "stream-start", warnings: [] }, { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage }],
              initialDelayInMs: null,
              chunkDelayInMs: null,
            }),
          },
        ],
      }));
    }

    /** 同上，但一步里发两个 tool-call：call_1 → 工具 "a"、call_2 → 工具 "b"（并行/串行结算分支的公用底座）。 */
    function twoToolCallModel(): MockLanguageModelV4 {
      return mockModel(() => ({
        doStream: [
          {
            stream: simulateReadableStream({
              chunks: [
                { type: "stream-start", warnings: [] },
                { type: "tool-call", toolCallId: "call_1", toolName: "a", input: "{}" },
                { type: "tool-call", toolCallId: "call_2", toolName: "b", input: "{}" },
                { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
              ],
              initialDelayInMs: null,
              chunkDelayInMs: null,
            }),
          },
          {
            stream: simulateReadableStream({
              chunks: [{ type: "stream-start", warnings: [] }, { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage }],
              initialDelayInMs: null,
              chunkDelayInMs: null,
            }),
          },
        ],
      }));
    }

    it("output-available: exactly one data-tool-timing part per toolCallId (upsert, not three), all three timestamps present, startedAt <= executionStartedAt <= completedAt — pinned via fake timers, not a race with the real clock", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(1_700_000_000_000);
        const tool: Tool = {
          description: "d",
          inputSchema: z.object({}),
          execute: () => {
            // Fake timers advance Date.now() too (vitest's default fakeTimers
            // config includes 'Date') — this simulates real elapsed time
            // between the start and complete timestamps without an actual
            // `await`/sleep.
            vi.advanceTimersByTime(1234);
            return "ok";
          },
        };

        const messages: NimboUIMessage[] = [userTextMessage("u1", "go")];
        const { chunks } = await drainTurn(runTurn(turnOptions(singleToolCallModel(), { messages, tools: { t: tool } })));

        // Three data-tool-timing chunks stream out for this one call (queued,
        // then execution start, then complete — state.ts 的三段生命周期)...
        const timingChunks = chunksOfType(chunks, "data-tool-timing");
        expect(timingChunks).toHaveLength(3);
        expect(timingChunks[0]?.data).toEqual({ toolCallId: "call_1", startedAt: 1_700_000_000_000 });
        expect(timingChunks[1]?.data).toEqual({ toolCallId: "call_1", startedAt: 1_700_000_000_000, executionStartedAt: 1_700_000_000_000 });
        expect(timingChunks[2]?.data).toEqual({
          toolCallId: "call_1",
          startedAt: 1_700_000_000_000,
          executionStartedAt: 1_700_000_000_000,
          completedAt: 1_700_000_001_234,
        });

        // ...but the ledger holds exactly one part for it (upsert by toolCallId, not three entries).
        const timing = toolTimingPartFor(messages, "call_1");
        expect(timing).toEqual({
          toolCallId: "call_1",
          startedAt: 1_700_000_000_000,
          executionStartedAt: 1_700_000_000_000,
          completedAt: 1_700_000_001_234,
        });
        expect(timing?.startedAt).toBeLessThanOrEqual(timing?.executionStartedAt ?? Number.NEGATIVE_INFINITY);
        expect(timing?.executionStartedAt).toBeLessThanOrEqual(timing?.completedAt ?? Number.NEGATIVE_INFINITY);
      } finally {
        vi.useRealTimers();
      }
    });

    it("message-metadata carries the whole-turn durationMs (runTurn entry → finalize), pinned via fake timers", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(1_700_000_000_000);
        const tool: Tool = {
          description: "d",
          inputSchema: z.object({}),
          execute: () => {
            vi.advanceTimersByTime(2500);
            return "ok";
          },
        };
        const messages: NimboUIMessage[] = [userTextMessage("u1", "go")];
        const { chunks } = await drainTurn(runTurn(turnOptions(singleToolCallModel(), { messages, tools: { t: tool } })));

        const metadataChunks = chunksOfType(chunks, "message-metadata");
        // 全 turn 墙钟 = 唯一推进过时钟的工具执行那 2500ms（fake timers 下其余
        // 环节零耗时）；toolDurationMs 也恰是这一个执行区间。
        expect(metadataChunks.at(-1)?.messageMetadata).toMatchObject({ status: "completed", durationMs: 2500, toolDurationMs: 2500 });
      } finally {
        vi.useRealTimers();
      }
    });

    it("serial settle queue is visible in the stamps: two calls in one step share (almost) the same startedAt, but call_2's executionStartedAt only begins where call_1's completedAt left off", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(1_700_000_000_000);
        const tool: Tool = {
          description: "d",
          inputSchema: z.object({}),
          execute: () => {
            vi.advanceTimersByTime(1000);
            return "ok";
          },
        };
        const model = mockModel(() => ({
          doStream: [
            {
              stream: simulateReadableStream({
                chunks: [
                  { type: "stream-start", warnings: [] },
                  { type: "tool-call", toolCallId: "call_1", toolName: "t", input: "{}" },
                  { type: "tool-call", toolCallId: "call_2", toolName: "t", input: "{}" },
                  { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
                ],
                initialDelayInMs: null,
                chunkDelayInMs: null,
              }),
            },
            {
              stream: simulateReadableStream({
                chunks: [{ type: "stream-start", warnings: [] }, { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage }],
                initialDelayInMs: null,
                chunkDelayInMs: null,
              }),
            },
          ],
        }));

        const messages: NimboUIMessage[] = [userTextMessage("u1", "go")];
        const { chunks } = await drainTurn(runTurn(turnOptions(model, { messages, tools: { t: tool } })));

        const first = toolTimingPartFor(messages, "call_1");
        const second = toolTimingPartFor(messages, "call_2");
        // 两个调用在流消费阶段同刻成形入队……
        expect(first?.startedAt).toBe(1_700_000_000_000);
        expect(second?.startedAt).toBe(1_700_000_000_000);
        // ……但结算是串行的：call_2 的真实执行起点 = call_1 结算完的时刻，
        // 排队等待（executionStartedAt - startedAt）如实可见，不混进执行耗时。
        expect(first?.executionStartedAt).toBe(1_700_000_000_000);
        expect(first?.completedAt).toBe(1_700_000_001_000);
        expect(second?.executionStartedAt).toBe(1_700_000_001_000);
        expect(second?.completedAt).toBe(1_700_000_002_000);

        // 轮级汇总：两个首尾相接的执行区间并集 = 2000ms = 全轮墙钟。
        const metadataChunks = chunksOfType(chunks, "message-metadata");
        expect(metadataChunks.at(-1)?.messageMetadata).toMatchObject({ durationMs: 2000, toolDurationMs: 2000 });
      } finally {
        vi.useRealTimers();
      }
    });

    it("all-readOnly batch settles in parallel: call_1's execute blocks until call_2's execute releases it — would deadlock under serial settle", async () => {
      // 握手死锁证明：a 等一个只有 b 执行时才会 resolve 的门闩。串行结算下
      // a 的 settleToolCall 必须整个跑完才轮到 b（b 永远没机会开门）→ 挂死；
      // 并行结算下 b 与 a 同时在跑、开门放行。测试能跑完本身就是并行的证据。
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const a: Tool = {
        description: "d",
        inputSchema: z.object({}),
        readOnly: true,
        execute: async () => {
          await gate;
          return "a-done";
        },
      };
      const b: Tool = {
        description: "d",
        inputSchema: z.object({}),
        readOnly: true,
        execute: () => {
          release?.();
          return "b-done";
        },
      };

      const messages: NimboUIMessage[] = [userTextMessage("u1", "go")];
      const { chunks } = await drainTurn(runTurn(turnOptions(twoToolCallModel(), { messages, tools: { a, b } })));

      const outputs = chunksOfType(chunks, "tool-output-available");
      expect(outputs).toHaveLength(2);
      expect(new Set(outputs.map((c) => c.toolCallId))).toEqual(new Set(["call_1", "call_2"]));
      // 两个调用的 timing 部件都完整结算（并行合并不丢 chunk/不丢戳）。
      const first = toolTimingPartFor(messages, "call_1");
      const second = toolTimingPartFor(messages, "call_2");
      expect(first?.completedAt).toBeDefined();
      expect(second?.completedAt).toBeDefined();

      // 轮级汇总取区间**并集**：并行重叠的两个执行区间不重复计入，
      // toolDurationMs 恒 ≤ 全轮墙钟（简单相加在并行下会破坏这一不变量）。
      const metadataChunks = chunksOfType(chunks, "message-metadata");
      const metadata = metadataChunks.at(-1)?.messageMetadata;
      expect(metadata?.toolDurationMs).toBeDefined();
      expect(metadata?.toolDurationMs ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(metadata?.durationMs ?? 0);
    });

    it("mixed batch (one call not readOnly) falls back to strictly serial settle in emission order", async () => {
      const events: string[] = [];
      const a: Tool = {
        description: "d",
        inputSchema: z.object({}),
        readOnly: true,
        execute: async () => {
          events.push("a:start");
          // 微任务让位：若误走并行，b:start 会插到 a:end 之前，下面的断言抓住它。
          await Promise.resolve();
          events.push("a:end");
          return "ok";
        },
      };
      const b: Tool = {
        description: "d",
        inputSchema: z.object({}),
        execute: () => {
          events.push("b:start");
          return "ok";
        },
      };

      const messages: NimboUIMessage[] = [userTextMessage("u1", "go")];
      await drainTurn(runTurn(turnOptions(twoToolCallModel(), { messages, tools: { a, b } })));

      expect(events).toEqual(["a:start", "a:end", "b:start"]);
    });

    it("chunk ordering: data-tool-timing(start) immediately follows tool-input-available, and data-tool-timing(complete) immediately follows the settling tool-output-available chunk", async () => {
      const tool: Tool = { description: "d", inputSchema: z.object({}), execute: () => "ok" };
      const messages: NimboUIMessage[] = [userTextMessage("u1", "go")];
      const { chunks } = await drainTurn(runTurn(turnOptions(singleToolCallModel(), { messages, tools: { t: tool } })));

      const inputAvailableIndex = chunks.findIndex((c) => c.type === "tool-input-available");
      const outputAvailableIndex = chunks.findIndex((c) => c.type === "tool-output-available");
      expect(inputAvailableIndex).toBeGreaterThanOrEqual(0);
      expect(outputAvailableIndex).toBeGreaterThan(inputAvailableIndex);
      expect(chunks[inputAvailableIndex + 1]?.type).toBe("data-tool-timing");
      expect(chunks[outputAvailableIndex + 1]?.type).toBe("data-tool-timing");
      // Not batched at the very end — the completing chunk lands right after its own settlement, not after every other chunk.
      expect(outputAvailableIndex + 1).toBeLessThan(chunks.length - 1);
    });

    it("output-error (tool.execute throws): data-tool-timing(complete) immediately follows tool-output-error", async () => {
      const tool: Tool = {
        description: "d",
        inputSchema: z.object({}),
        execute: () => {
          throw new Error("tool blew up");
        },
      };
      const messages: NimboUIMessage[] = [userTextMessage("u1", "go")];
      const { chunks } = await drainTurn(runTurn(turnOptions(singleToolCallModel(), { messages, tools: { t: tool } })));

      const errorIndex = chunks.findIndex((c) => c.type === "tool-output-error");
      expect(errorIndex).toBeGreaterThanOrEqual(0);
      expect(chunks[errorIndex + 1]?.type).toBe("data-tool-timing");

      const timing = toolTimingPartFor(messages, "call_1");
      expect(timing?.completedAt).toBeDefined();
      expect(timing?.startedAt).toBeLessThanOrEqual(timing?.completedAt ?? Number.NEGATIVE_INFINITY);
    });

    it("output-denied (direct deny via per-tool 'deny' policy — no approval-request/response at all): data-tool-timing(complete) immediately follows tool-output-denied", async () => {
      const execute = vi.fn(() => "should not run");
      const tool: Tool = { description: "d", inputSchema: z.object({}), approval: "deny", execute };
      const messages: NimboUIMessage[] = [userTextMessage("u1", "do the dangerous thing")];
      const { chunks } = await drainTurn(runTurn(turnOptions(singleToolCallModel(), { messages, tools: { t: tool } })));

      const deniedIndex = chunks.findIndex((c) => c.type === "tool-output-denied");
      expect(deniedIndex).toBeGreaterThanOrEqual(0);
      expect(chunks[deniedIndex + 1]?.type).toBe("data-tool-timing");
      expect(chunksOfType(chunks, "tool-approval-request")).toHaveLength(0);

      const timing = toolTimingPartFor(messages, "call_1");
      expect(timing?.completedAt).toBeDefined();
    });

    it("output-denied (no-arbiter: escalated to 'review' but no onReview wired up): data-tool-timing(complete) immediately follows tool-output-denied", async () => {
      const execute = vi.fn(() => "should not run");
      const tool: Tool = { description: "d", inputSchema: z.object({}), approval: (): ApprovalOutcome => "review", execute };
      const messages: NimboUIMessage[] = [userTextMessage("u1", "do the dangerous thing")];
      // Deliberately no onReview passed.
      const { chunks } = await drainTurn(runTurn(turnOptions(singleToolCallModel(), { messages, tools: { t: tool } })));

      const deniedIndex = chunks.findIndex((c) => c.type === "tool-output-denied");
      expect(deniedIndex).toBeGreaterThanOrEqual(0);
      expect(chunks[deniedIndex + 1]?.type).toBe("data-tool-timing");

      const timing = toolTimingPartFor(messages, "call_1");
      expect(timing?.completedAt).toBeDefined();
    });

    it("output-denied (onReview explicit deny): data-tool-timing(complete) immediately follows tool-output-denied, itself after tool-approval-request/tool-approval-response — startedAt is stamped BEFORE the human decision, so duration includes the approval wait", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(2_000_000_000_000);
        const tool: Tool = { description: "d", inputSchema: z.object({}), approval: "review", execute: () => "should not run" };
        const onApproval: ApprovalPolicy = () => "review";
        const onReview: ApprovalReviewer = async () => {
          vi.advanceTimersByTime(5000); // simulated human deliberation time
          return { behavior: "deny", message: "not today" };
        };

        const messages: NimboUIMessage[] = [userTextMessage("u1", "do the dangerous thing")];
        const { chunks } = await drainTurn(
          runTurn(turnOptions(singleToolCallModel(), { messages, tools: { t: tool }, onApproval, onReview })),
        );

        const requestIndex = chunks.findIndex((c) => c.type === "tool-approval-request");
        const responseIndex = chunks.findIndex((c) => c.type === "tool-approval-response");
        const deniedIndex = chunks.findIndex((c) => c.type === "tool-output-denied");
        expect(requestIndex).toBeGreaterThanOrEqual(0);
        expect(responseIndex).toBeGreaterThan(requestIndex);
        expect(deniedIndex).toBeGreaterThan(responseIndex);
        expect(chunks[deniedIndex + 1]?.type).toBe("data-tool-timing");

        const timing = toolTimingPartFor(messages, "call_1");
        // startedAt is stamped when tool-input-available fires — strictly before the
        // 5s of simulated approval-waiting time — so completedAt - startedAt >= 5000.
        expect(timing?.startedAt).toBe(2_000_000_000_000);
        expect(timing?.completedAt).toBe(2_000_000_005_000);
      } finally {
        vi.useRealTimers();
      }
    });

    it("onReview allows: data-tool-timing(complete) immediately follows tool-output-available, itself after tool-approval-request/tool-approval-response", async () => {
      const execute = vi.fn(() => "ran");
      const tool: Tool = { description: "d", inputSchema: z.object({}), approval: "review", execute };
      const onApproval: ApprovalPolicy = () => "review";
      const onReview = vi.fn(async (): Promise<HumanDecision> => ({ behavior: "allow" }));

      const messages: NimboUIMessage[] = [userTextMessage("u1", "do the dangerous thing")];
      const { chunks } = await drainTurn(runTurn(turnOptions(singleToolCallModel(), { messages, tools: { t: tool }, onApproval, onReview })));

      const responseIndex = chunks.findIndex((c) => c.type === "tool-approval-response");
      const availableIndex = chunks.findIndex((c) => c.type === "tool-output-available");
      expect(availableIndex).toBeGreaterThan(responseIndex);
      expect(chunks[availableIndex + 1]?.type).toBe("data-tool-timing");

      const timing = toolTimingPartFor(messages, "call_1");
      expect(timing?.completedAt).toBeDefined();
    });

    it("two tool calls in the same step get independent data-tool-timing parts — upsert is scoped by toolCallId, one call's completion never overwrites the other's", async () => {
      const toolA: Tool = { description: "d", inputSchema: z.object({}), execute: () => "a-done" };
      const toolB: Tool = { description: "d", inputSchema: z.object({}), execute: () => "b-done" };

      const model = mockModel(() => ({
        doStream: [
          {
            stream: simulateReadableStream({
              chunks: [
                { type: "stream-start", warnings: [] },
                { type: "tool-call", toolCallId: "call_1", toolName: "tool-a", input: "{}" },
                { type: "tool-call", toolCallId: "call_2", toolName: "tool-b", input: "{}" },
                { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
              ],
              initialDelayInMs: null,
              chunkDelayInMs: null,
            }),
          },
          {
            stream: simulateReadableStream({
              chunks: [{ type: "stream-start", warnings: [] }, { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage }],
              initialDelayInMs: null,
              chunkDelayInMs: null,
            }),
          },
        ],
      }));

      const messages: NimboUIMessage[] = [userTextMessage("u1", "go")];
      await drainTurn(runTurn(turnOptions(model, { messages, tools: { "tool-a": toolA, "tool-b": toolB } })));

      const timingA = toolTimingPartFor(messages, "call_1");
      const timingB = toolTimingPartFor(messages, "call_2");
      expect(timingA?.toolCallId).toBe("call_1");
      expect(timingB?.toolCallId).toBe("call_2");
      expect(timingA?.completedAt).toBeDefined();
      expect(timingB?.completedAt).toBeDefined();
    });

    it("unknown tool name (hallucinated call, never declared to the model): produces no data-tool-timing chunk/part at all — the call never entered tool-input-available/the timing pipeline", async () => {
      const model = mockModel(() => ({
        doStream: [
          {
            stream: simulateReadableStream({
              chunks: [
                { type: "stream-start", warnings: [] },
                { type: "tool-call", toolCallId: "call_1", toolName: "does_not_exist", input: "{}" },
                { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
              ],
              initialDelayInMs: null,
              chunkDelayInMs: null,
            }),
          },
          {
            stream: simulateReadableStream({
              chunks: [{ type: "stream-start", warnings: [] }, { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage }],
              initialDelayInMs: null,
              chunkDelayInMs: null,
            }),
          },
        ],
      }));

      const messages: NimboUIMessage[] = [userTextMessage("u1", "go")];
      const { chunks } = await drainTurn(runTurn(turnOptions(model, { messages, tools: {} })));

      expect(chunksOfType(chunks, "data-tool-timing")).toHaveLength(0);
      expect(toolTimingPartFor(messages, "call_1")).toBeUndefined();
    });

    it("crash residual: a synchronously-throwing session-level approval classifier leaves a started-but-never-completed data-tool-timing part (startedAt only, no completedAt) for BOTH pending calls in that step, while the turn still finalizes gracefully with message-metadata status 'failed'", async () => {
      const onApproval: ApprovalPolicy = () => {
        throw new Error("classifier exploded");
      };
      const tool: Tool = { description: "d", inputSchema: z.object({}), approval: "review", execute: () => "should not run" };

      const model = mockModel(() => ({
        doStream: {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "tool-call", toolCallId: "call_1", toolName: "t", input: "{}" },
              { type: "tool-call", toolCallId: "call_2", toolName: "t", input: "{}" },
              { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
            ],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        },
      }));

      const messages: NimboUIMessage[] = [userTextMessage("u1", "go")];
      const { chunks } = await drainTurn(runTurn(turnOptions(model, { messages, tools: { t: tool }, onApproval })));

      // Both calls got their tool-input-available (and therefore startToolTiming) —
      // settleToolCall then threw synchronously evaluating call_1's approval, before
      // either call ever reached a settlement chunk, so neither gets completeToolTiming.
      const timing1 = toolTimingPartFor(messages, "call_1");
      const timing2 = toolTimingPartFor(messages, "call_2");
      expect(timing1).toBeDefined();
      expect(timing1?.completedAt).toBeUndefined();
      expect(timing2).toBeDefined();
      expect(timing2?.completedAt).toBeUndefined();

      // The turn still ends gracefully (runTurn's own catch/finalizeTurn), not an
      // unhandled rejection — this is the "acceptable residual state" the design
      // calls out, not a bug.
      const metadataChunks = chunksOfType(chunks, "message-metadata");
      expect(metadataChunks).toHaveLength(1);
      expect(metadataChunks[0]?.messageMetadata.status).toBe("failed");
    });
  });
});
