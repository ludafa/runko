/**
 * L2 运行层：单个 turn 的 step 循环 `runTurn`（tech-spec §4.2 数据流 / §4.3 第
 * 2-3 点事件翻译 / §4.5 审批链集成 / §4.8 终止条件）。session.ts 拥有跨 turn
 * 的持久状态（messages/turn 计数/readState/onceMemory/planStore），本文件只
 * 负责"给定当前状态，把一个 turn 跑到底"——重复调 `runStep`（一次 = 一"步"，
 * 对应模型一次 `streamText`），每步若 `finishReason === "tool-calls"` 就经
 * `executeToolCall`（P4-1 `runtime.ts`）执行并回填，直到 `finishReason` 不是
 * "tool-calls"（成功收尾）或触发下述任一终止条件。
 *
 * ---- 术语澄清（spec 对"turn"这个词有两层复用，工单示例已验证） ----
 *
 * `SessionEvent` 的 `turn.started/turn.completed/turn.failed` 是"一次
 * `session.send()/stream()` 调用"这个粒度（session.ts 的 `turn` 计数器）；
 * `AgentDefinition.maxTurnsPerRun` 里的"turn"却是"一次 `runStep` 调用"这个更
 * 细粒度（工单原文"步1 tool-calls → 执行回填 → 步2 stop"里的"步"）——两次
 * `runStep` 调用可以发生在同一次 `send()` 里。本文件的 `for` 循环变量因此叫
 * `stepIndex`，`opts.maxTurnsPerRun` 是这个循环的上限，不是 session 的 turn
 * 计数——命名沿用 spec 字面（字段名不可改），语义在本注释澄清一次。
 *
 * ---- item 事件翻译的两处必要裁量（P3 `step.ts` 的既有约束下做出） ----
 *
 * 1. **`tool-input-delta` 不独立驱动 `tool_call` 的 `item.*` 事件**：
 *    `SessionItem` 的 `tool_call` 变体要求 `toolName: string`（非可选），但
 *    P3 的 `StepEvent` 只转发 `tool-input-delta`（仅 `id`/`delta`，无
 *    `toolName`——携带 `toolName` 的 `tool-input-start` 边界块被 P3 显式丢弃，
 *    见 `model/step.ts` 头注释），`toolName` 要到同一 `id` 的终态 `tool-call`
 *    事件才揭晓。因此本文件在收到 `tool-input-delta` 时不做任何事（既没有
 *    合法值可填 `toolName`，也不引入占位空串污染事件流）；`tool_call` 的
 *    `item.started` 改为在收到终态 `tool-call` 事件时一次性发出（此时
 *    `toolName`/`input` 均已就绪）。这是本工单在 P3 既有契约下的裁量，不是
 *    对工单"tool-input-delta → item.updated"的忽视——严格实现它需要改
 *    `model/step.ts` 转发 `tool-input-start`，但本工单明确只允许动
 *    `step.ts` 的一处 `fullStream`→`stream` 标识符替换，不在此臆测新增。
 *    如需真正的"输入流式落地为 item 更新"，属于下一个触碰 `model/step.ts`
 *    的工单的扩展点。
 * 2. **`ctx.update()` 的进度先缓冲、后重放**：`ToolContext.update(partial)`
 *    在 `tool.execute()` 内部同步/异步地被调用，但它是一个普通回调，不是
 *    生成器——不能从回调内部 `yield` 到这个 async generator。因此
 *    `executeStepToolCalls` 把 `onProgress` 收到的每个 `partial` 先推进一个
 *    数组，等 `executeToolCall(...)` 的 promise resolve 后再依次把它们回放成
 *    `item.updated`（`output` 字段为累积文本、`status` 仍是 `"in_progress"`），
 *    最后才发真正的 `item.completed`。效果是"进度确实以 `item.updated` 到达
 *    宿主"，但不是与执行过程严格实时交错——这是 async generator 委托模型下
 *    的固有取舍，不是遗漏。
 *
 * ---- 终止条件的实现落点（tech-spec §4.8） ----
 *
 * - `finishReason: "stop"`（或任何非 "tool-calls" 的终态）→ 循环内直接
 *   `turn.completed` 收尾。
 * - `maxTurnsPerRun` 触达 → 循环允许的最后一步仍以 "tool-calls" 收场时，先把
 *   该步的工具调用正常执行完（对应的 `tool_call`/`file_change`/`plan_update`
 *   item 都能正常 completed，不留悬空的 `in_progress` 状态)，再判定"下一步没
 *   有预算了" → `turn.failed`/`max_turns`。不是"到达上限就拒绝执行最后一步的
 *   工具调用"——那样会让宿主看到一堆永远 `in_progress` 的 item。
 * - `signal` abort / 模型错误 → `runStep`（经 P3 文档）在两种情况下都是
 *   reject（abort 的 reject 值是 `abortSignal.reason`），本文件用
 *   `abortSignal.aborted` 是否为真来分流 `"aborted"` vs `"provider_error"`
 *   （见 `describeError` 邻近的两个 `catch` 块）。
 * - 上下文上限（`AgentDefinition.maxContextTokens`，P4-2 施工回填的字段，见
 *   `agent.ts`）→ v1 显式估算："字符数/4"起步，每步用 `StepResult.usage`
 *   回填的真实 `inputTokens` 校准一个乘法因子（`contextCalibration`），检查
 *   点在**每次调用 `runStep` 之前**（含第一步）——超限直接
 *   `turn.failed`/`context_overflow`，不消耗一次模型调用。未配置
 *   `maxContextTokens` 时完全跳过这项检查（opt-in）。
 */
import { randomUUID } from "node:crypto";
import type { LanguageModel, ModelMessage, ToolResultPart } from "ai";
import type { NimboError, SessionEvent, SessionItem, Usage } from "./events.js";
import type { ApprovalPolicy, NimboFS, SkillHandle, Tool, ToolReturn } from "./types.js";
import { runStep } from "./model/step.js";
import type { StepResult, StepToolCall } from "./model/step.js";
import { executeToolCall } from "./runtime.js";
import type { DerivedDataCollector, ToolCallResult, ToolCallStatus } from "./runtime.js";
import type { OnceApprovalMemory } from "./approval.js";
import type { TurnResult } from "./session.js";

function newItemId(): string {
  return randomUUID();
}

/**
 * `catch` 子句里从 `unknown` 安全窄化出可读消息——同款受控例外见
 * `runtime.ts`/`@nimbo/virtual-fs` 的 `describeError`：只用于这一处收窄。
 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sumOptional(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
}

function mergeUsage(acc: Usage, next: StepResult["usage"]): Usage {
  return {
    inputTokens: sumOptional(acc.inputTokens, next.inputTokens),
    outputTokens: sumOptional(acc.outputTokens, next.outputTokens),
    totalTokens: sumOptional(acc.totalTokens, next.totalTokens),
    // AI SDK exposes cached input tokens under inputTokenDetails.cacheReadTokens
    // (optional-chained: a provider may omit inputTokenDetails at runtime).
    cachedInputTokens: sumOptional(
      acc.cachedInputTokens,
      next.inputTokenDetails?.cacheReadTokens,
    ),
  };
}

/** "字符数/4"起步估算：system + 全部消息的 JSON 字符长度之和除以 4，向上取整。 */
function estimateMessagesTokens(messages: ModelMessage[], system: string | undefined): number {
  let charCount = system?.length ?? 0;
  for (const message of messages) charCount += JSON.stringify(message).length;
  return Math.ceil(charCount / 4);
}

function serializeToolReturn(value: ToolReturn): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * `ToolResultOutput` itself lives in `@ai-sdk/provider-utils`, a transitive
 * dependency of `ai` that `@nimbo/core` does not declare directly — same
 * situation `model/step.test.ts` already documents for
 * `LanguageModelV4StreamPart`. `ToolResultPart` (which nests it as `.output`)
 * *is* re-exported from `ai`, so deriving the type via indexed access reaches
 * the same precise discriminated union without an undeclared-module import.
 */
type ToolResultOutput = ToolResultPart["output"];

/**
 * `ToolCallResult` 的三态映射进 AI SDK `ToolResultOutput` 的对应变体
 * （text/error-text/execution-denied）——比统一塞进 `"text"` 更精确地把
 * "失败"和"被拒绝"的语义传给模型，三个变体的字符串化规则相同（string 直传/
 * 对象 `JSON.stringify`，即 orchitector 接缝笔记 c 点名的"回填层的活"）。
 */
function toToolResultOutput(status: ToolCallStatus, output: ToolReturn): ToolResultOutput {
  const text = serializeToolReturn(output);
  if (status === "completed") return { type: "text", value: text };
  if (status === "denied") return { type: "execution-denied", reason: text };
  return { type: "error-text", value: text };
}

// ---- 单步的事件翻译（text/reasoning 增量聚合 + tool-call 识别） ----

interface StepProcessingResult {
  stepResult: StepResult;
  completedItems: SessionItem[];
  /** 本步产生的 agent_message 文本（用于 TurnResult.finalResponse，见 runTurn）。 */
  stepFinalText: string;
  /** StepEvent 的 tool-call id → 本文件生成的 SessionItem id，供后续执行阶段复用同一个 item id。 */
  toolCallNimboIds: Map<string, string>;
}

interface RunOneStepOptions {
  model: LanguageModel;
  system: string | undefined;
  messages: ModelMessage[];
  tools: Record<string, Tool>;
  abortSignal: AbortSignal;
  maxOutputTokens: number | undefined;
}

async function* runOneStep(opts: RunOneStepOptions): AsyncGenerator<SessionEvent, StepProcessingResult> {
  const stepGen = runStep({
    model: opts.model,
    system: opts.system,
    messages: opts.messages,
    tools: opts.tools,
    abortSignal: opts.abortSignal,
    maxOutputTokens: opts.maxOutputTokens,
  });

  const textItems = new Map<string, { nimboId: string; text: string }>();
  const reasoningItems = new Map<string, { nimboId: string; text: string }>();
  const toolCallNimboIds = new Map<string, string>();
  const completedItems: SessionItem[] = [];

  let next = await stepGen.next();
  while (!next.done) {
    const stepEvent = next.value;
    switch (stepEvent.type) {
      case "text-delta": {
        const existing = textItems.get(stepEvent.id);
        if (existing === undefined) {
          const nimboId = newItemId();
          textItems.set(stepEvent.id, { nimboId, text: stepEvent.text });
          yield { type: "item.started", item: { id: nimboId, type: "agent_message", text: stepEvent.text } };
        } else {
          existing.text += stepEvent.text;
          yield { type: "item.updated", item: { id: existing.nimboId, type: "agent_message", text: existing.text } };
        }
        break;
      }
      case "reasoning-delta": {
        const existing = reasoningItems.get(stepEvent.id);
        if (existing === undefined) {
          const nimboId = newItemId();
          reasoningItems.set(stepEvent.id, { nimboId, text: stepEvent.text });
          yield { type: "item.started", item: { id: nimboId, type: "reasoning", text: stepEvent.text } };
        } else {
          existing.text += stepEvent.text;
          yield { type: "item.updated", item: { id: existing.nimboId, type: "reasoning", text: existing.text } };
        }
        break;
      }
      case "tool-input-delta":
        // 不独立驱动 item 事件——理由见本文件头"item 事件翻译的两处必要裁量"第 1 点。
        break;
      case "tool-call": {
        const nimboId = newItemId();
        toolCallNimboIds.set(stepEvent.id, nimboId);
        yield {
          type: "item.started",
          item: { id: nimboId, type: "tool_call", toolName: stepEvent.toolName, input: stepEvent.input, status: "in_progress" },
        };
        break;
      }
      default:
        break;
    }
    next = await stepGen.next();
  }

  for (const { nimboId, text } of textItems.values()) {
    const item: SessionItem = { id: nimboId, type: "agent_message", text };
    completedItems.push(item);
    yield { type: "item.completed", item };
  }
  for (const { nimboId, text } of reasoningItems.values()) {
    const item: SessionItem = { id: nimboId, type: "reasoning", text };
    completedItems.push(item);
    yield { type: "item.completed", item };
  }

  const stepFinalText = [...textItems.values()].map((entry) => entry.text).join("");

  return { stepResult: next.value, completedItems, stepFinalText, toolCallNimboIds };
}

// ---- 一步内全部 tool-call 的执行（审批 + 执行 + 派生数据 + 回填消息组装） ----

interface ToolExecutionResult {
  completedItems: SessionItem[];
  toolResultParts: ToolResultPart[];
}

interface ExecuteStepToolCallsOptions {
  toolCalls: StepToolCall[];
  toolCallNimboIds: Map<string, string>;
  tools: Record<string, Tool>;
  session: { id: string; turn: number };
  fs: NimboFS;
  abortSignal: AbortSignal;
  onApproval: ApprovalPolicy | undefined;
  onceMemory: OnceApprovalMemory;
  derivedData: DerivedDataCollector;
  /** P5：`session.ts` 经 `RunTurnOptions.getSkill` 传下来的真实现，透传给 `executeToolCall`。 */
  getSkill: ((name: string) => SkillHandle) | undefined;
}

/** 模型请求了一个未注册的工具名（幻觉调用）时的兜底结果——不经 `executeToolCall`（没有 `Tool` 对象可传）。 */
function unknownToolResult(toolName: string): ToolCallResult {
  return {
    status: "failed",
    output: `Unknown tool "${toolName}" — it is not registered in this session's tool set. Only call tools that were offered.`,
    derived: { changes: [] },
  };
}

async function* executeStepToolCalls(opts: ExecuteStepToolCallsOptions): AsyncGenerator<SessionEvent, ToolExecutionResult> {
  const completedItems: SessionItem[] = [];
  const toolResultParts: ToolResultPart[] = [];

  for (const call of opts.toolCalls) {
    const nimboId = opts.toolCallNimboIds.get(call.id) ?? newItemId();
    const tool = opts.tools[call.toolName];

    let result: ToolCallResult;
    if (tool === undefined) {
      result = unknownToolResult(call.toolName);
    } else {
      const progressChunks: string[] = [];
      result = await executeToolCall({
        tool,
        toolName: call.toolName,
        callId: call.id,
        input: call.input,
        session: opts.session,
        fs: opts.fs,
        abortSignal: opts.abortSignal,
        onApproval: opts.onApproval,
        onceMemory: opts.onceMemory,
        onProgress: (partial) => progressChunks.push(partial),
        derivedData: opts.derivedData,
        getSkill: opts.getSkill,
      });

      let accumulatedProgress = "";
      for (const chunk of progressChunks) {
        accumulatedProgress += chunk;
        yield {
          type: "item.updated",
          item: {
            id: nimboId,
            type: "tool_call",
            toolName: call.toolName,
            input: call.input,
            output: accumulatedProgress,
            status: "in_progress",
          },
        };
      }
    }

    const item: SessionItem = {
      id: nimboId,
      type: "tool_call",
      toolName: call.toolName,
      input: call.input,
      output: result.output,
      status: result.status,
    };
    completedItems.push(item);
    yield { type: "item.completed", item };

    toolResultParts.push({
      type: "tool-result",
      toolCallId: call.id,
      toolName: call.toolName,
      output: toToolResultOutput(result.status, result.output),
    });

    if (result.derived.changes.length > 0) {
      const changeItem: SessionItem = { id: newItemId(), type: "file_change", changes: result.derived.changes };
      completedItems.push(changeItem);
      yield { type: "item.completed", item: changeItem };
    }
    if (result.derived.items !== undefined) {
      const planItem: SessionItem = { id: newItemId(), type: "plan_update", items: result.derived.items };
      completedItems.push(planItem);
      yield { type: "item.completed", item: planItem };
    }
  }

  return { completedItems, toolResultParts };
}

// ---- runTurn：一个 turn 的完整 step 循环 ----

export interface RunTurnOptions {
  model: LanguageModel;
  system: string | undefined;
  /** session 的持久消息历史，原地 push——runTurn 结束时调用方能直接看到更新后的历史。 */
  messages: ModelMessage[];
  tools: Record<string, Tool>;
  maxTurnsPerRun: number;
  maxContextTokens: number | undefined;
  maxOutputTokens: number | undefined;
  fs: NimboFS;
  session: { id: string; turn: number };
  signal: AbortSignal | undefined;
  onApproval: ApprovalPolicy | undefined;
  onceMemory: OnceApprovalMemory;
  derivedData: DerivedDataCollector;
  /**
   * P5：`session.ts` 构造的真实 `ctx.getSkill` 实现（`skills/registry.js` 的
   * `createGetSkill`），一路透传给 `executeStepToolCalls`/`executeToolCall`。
   * 可选——未提供（如既有单测直接调 `runTurn` 不关心 skills）时，
   * `executeToolCall` 退回它自己的占位实现，行为不变。
   */
  getSkill?: (name: string) => SkillHandle;
}

export async function* runTurn(opts: RunTurnOptions): AsyncGenerator<SessionEvent, TurnResult> {
  const abortSignal = opts.signal ?? new AbortController().signal;
  const allItems: SessionItem[] = [];
  let finalResponse = "";
  let usage: Usage = {};
  let contextCalibration = 1;

  for (let stepIndex = 1; stepIndex <= opts.maxTurnsPerRun; stepIndex++) {
    if (opts.maxContextTokens !== undefined) {
      const estimated = estimateMessagesTokens(opts.messages, opts.system) * contextCalibration;
      if (estimated > opts.maxContextTokens) {
        const error: NimboError = {
          code: "context_overflow",
          message: `Estimated context size (~${Math.round(estimated)} tokens) exceeds maxContextTokens (${opts.maxContextTokens}).`,
        };
        yield { type: "turn.failed", error };
        return { items: allItems, finalResponse, usage };
      }
    }

    let stepOutcome: StepProcessingResult;
    try {
      stepOutcome = yield* runOneStep({
        model: opts.model,
        system: opts.system,
        messages: opts.messages,
        tools: opts.tools,
        abortSignal,
        maxOutputTokens: opts.maxOutputTokens,
      });
    } catch (error) {
      const nimboError: NimboError = abortSignal.aborted
        ? { code: "aborted", message: describeError(error) }
        : { code: "provider_error", message: describeError(error) };
      yield { type: "turn.failed", error: nimboError };
      return { items: allItems, finalResponse, usage };
    }

    allItems.push(...stepOutcome.completedItems);
    if (stepOutcome.stepFinalText !== "") finalResponse = stepOutcome.stepFinalText;
    usage = mergeUsage(usage, stepOutcome.stepResult.usage);

    if (opts.maxContextTokens !== undefined) {
      const rawEstimate = estimateMessagesTokens(opts.messages, opts.system);
      const reportedInputTokens = stepOutcome.stepResult.usage.inputTokens;
      if (reportedInputTokens !== undefined && rawEstimate > 0) {
        contextCalibration = reportedInputTokens / rawEstimate;
      }
    }

    opts.messages.push(...stepOutcome.stepResult.responseMessages);

    if (stepOutcome.stepResult.finishReason !== "tool-calls") {
      yield { type: "turn.completed", usage };
      return { items: allItems, finalResponse, usage };
    }

    let toolOutcome: ToolExecutionResult;
    try {
      toolOutcome = yield* executeStepToolCalls({
        toolCalls: stepOutcome.stepResult.toolCalls,
        toolCallNimboIds: stepOutcome.toolCallNimboIds,
        tools: opts.tools,
        session: opts.session,
        fs: opts.fs,
        abortSignal,
        onApproval: opts.onApproval,
        onceMemory: opts.onceMemory,
        derivedData: opts.derivedData,
        getSkill: opts.getSkill,
      });
    } catch (error) {
      const nimboError: NimboError = abortSignal.aborted
        ? { code: "aborted", message: describeError(error) }
        : { code: "provider_error", message: describeError(error) };
      yield { type: "turn.failed", error: nimboError };
      return { items: allItems, finalResponse, usage };
    }

    allItems.push(...toolOutcome.completedItems);
    opts.messages.push({ role: "tool", content: toolOutcome.toolResultParts });

    if (stepIndex === opts.maxTurnsPerRun) {
      const error: NimboError = {
        code: "max_turns",
        message: `Reached maxTurnsPerRun (${opts.maxTurnsPerRun}) — the model still requested tool calls with no steps left.`,
      };
      yield { type: "turn.failed", error };
      return { items: allItems, finalResponse, usage };
    }
  }

  // 只在 `maxTurnsPerRun <= 0`（零/负预算，连第一步都不允许）时到达此处。
  const error: NimboError = {
    code: "max_turns",
    message: `maxTurnsPerRun (${opts.maxTurnsPerRun}) leaves no steps to run.`,
  };
  yield { type: "turn.failed", error };
  return { items: allItems, finalResponse, usage };
}
