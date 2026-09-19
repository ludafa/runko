/**
 * L2 运行层：把**一个 turn 跑到底**的 step 循环 `runTurn`。
 *
 * 分工：`session.ts` 拥有跨 turn 的持久状态（messages、turn 计数、readState、onceMemory、
 * planStore），本文件只管「给定当前账本，跑完这一轮」。
 *
 * 工作态是 `RunkoUIMessage[]`，**不是 `ModelMessage[]`**——每步调模型前用 ai 官方的
 * `convertToModelMessages()` 现场推导，本文件不手拼任何 `ModelMessage`。
 *
 * 方案见[单一数据账本 · 技术方案](../../../docs/logic/orchestration/tech/single-ledger.md)。
 *
 * ## 一个 step = 账本里一条新的 assistant 消息
 *
 * 不是把多步折进一条消息、用内部 `step-start` 分隔。两种组织对
 * `convertToModelMessages()` **完全等价**（它每处理完一条顶层 UIMessage 都会 flush 一次
 * 未完成的 block，效果与消息内部分块相同），选前者只因为它更好读、也更好落库。
 *
 * ## 审批：三值，且**先产出请求、再阻塞等人**
 *
 * `settleToolCall` 把「解析审批」与「执行工具」拆成两步，中间插入审批往返：
 *
 * 1. `resolveToolCallApproval()` 三值解析（`approval.ts` 的 `evaluateApproval`）：
 *    `allow` / `review` / `deny`。
 * 2. `allow` → 直接 `executeToolCall` → `tool-output-available` / `-error`。
 * 3. `deny` → **不执行**，直接 `tool-output-denied`（拒绝理由回填模型）。
 *    注意它**不经过审批请求 / 响应 chunk**——没人需要为一个注定被拒的调用弹卡片。
 * 4. `review` → **先** yield `tool-approval-request` chunk，**再** `await` 人审通道
 *    （`opts.onReview`）。拿到裁决后 `allow` / `deny` 都 yield 一次
 *    `tool-approval-response`，只有 `allow` 才继续 `executeToolCall`。
 *
 * ⚠️ **第 4 步的顺序不能颠倒，这是整段最要紧的一条。** 先阻塞后产出的话，挂起等人审的
 * 那段时间里直播流上**没有任何待审批信号**，客户端据此弹不出卡片——人在环上就形同虚设。
 *
 * 这也正是 `settleToolCall` 写成 `async function*` 的理由：`yield` 是一个真实的挂起点，
 * 消费方（`for await`）在那一刻就能看到这个 chunk，不必等后面的 `await` resolve。返回单个
 * `Promise` 的普通异步函数做不到这件事。
 *
 * 两个边角：`onReview` 没注入时视同无仲裁者，按 `deny` 处理且不产出请求 chunk；
 * `review-once` 且人工放行时调 `onceMemory.markApproved(toolName)`。
 *
 * 工具部件的状态字段沿用 ai@7 原生的审批状态机（`approval-requested` /
 * `approval-responded` / `output-denied`，`ToolUIPart` 的判别联合）。
 */
import { randomUUID } from "node:crypto";
import { convertToModelMessages, getToolName, isToolUIPart, streamText } from "ai";
import type { Telemetry, ToolExecutionEndEvent, ToolExecutionStartEvent } from "ai";
import type {
  DataUIPart,
  FinishReason,
  LanguageModel,
  LanguageModelUsage,
  ReasoningUIPart,
  TextUIPart,
  ToolUIPart,
  UITools,
} from "ai";
import type { RunkoError, Usage } from "./events.js";
import type {
  FileChangeData,
  RunkoChunk,
  RunkoMessageMetadata,
  RunkoUIMessage,
  PlanUpdateData,
  ToolTimingData,
} from "./state.js";
import { jsonValueSchema } from "./types.js";
import type { ApprovalPolicy, ApprovalReviewer, JsonValue, RunkoFS, SkillHandle, Tool, ToolReturn } from "./types.js";
import { convertTools } from "./model/convert.js";
import { executeToolCall, resolveToolCallApproval } from "./runtime.js";
import type { DerivedDataCollector, ToolCallDerivedData, ToolCallResult } from "./runtime.js";
import { DEFAULT_DENY_MESSAGE, noArbiterDenyReason } from "./approval.js";
import type { OnceApprovalMemory } from "./approval.js";
import type { TurnResult } from "./session.js";
import { pendingCallIds, resolveResumeTarget } from "./suspend.js";
import type { ResumeTarget, Settlement } from "./suspend.js";

/**
 * `catch` 子句里从 `unknown` 安全窄化出可读消息——同款受控例外见
 * `runtime.ts`/`@runko/virtual-fs` 的 `describeError`：只用于这一处收窄。
 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `ToolCallResult.output`（`failed`/`denied` 态恒为 string，但类型上是 `ToolReturn`）到 errorText 的防御性收窄。 */
function toErrorText(output: ToolReturn): string {
  return typeof output === "string" ? output : JSON.stringify(output);
}

/**
 * `unknown` → `JsonValue` 的运行时收窄，隔离于此处的唯一调用点（同款受控例外见
 * `model/step.ts` 的 `toJsonValue`——本文件不导入那份私有实现,重写一份，理由
 * 同该文件"绕开 model/step.ts 的手工发块路线"的既有裁量）：`streamText` 对未
 * 匹配到声明工具集的 tool call（`DynamicToolCall`）把 `input` 类型留成
 * `unknown`（模型可能产生任意畸形/非法调用）。用已导出的 `jsonValueSchema` 做
 * `safeParse` 而非类型断言，校验失败以 `null` 承接。
 */
function toJsonValue(input: unknown): JsonValue {
  const parsed = jsonValueSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

function sumOptional(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) {return undefined;}
  return (a ?? 0) + (b ?? 0);
}

function mergeUsage(acc: Usage, next: LanguageModelUsage): Usage {
  return {
    inputTokens: sumOptional(acc.inputTokens, next.inputTokens),
    outputTokens: sumOptional(acc.outputTokens, next.outputTokens),
    totalTokens: sumOptional(acc.totalTokens, next.totalTokens),
    cachedInputTokens: sumOptional(acc.cachedInputTokens, next.inputTokenDetails?.cacheReadTokens),
  };
}

/** "字符数/4"起步估算：system + 全部账本消息的 JSON 字符长度之和除以 4，向上取整。 */
function estimateMessagesTokens(messages: RunkoUIMessage[], system: string | undefined): number {
  let charCount = system?.length ?? 0;
  for (const message of messages) {charCount += JSON.stringify(message).length;}
  return Math.ceil(charCount / 4);
}

/** 一条 assistant 消息里全部 `text` 部件拼接（`TurnResult.finalResponse` 的来源，见 `runTurn`）。 */
function collectMessageText(message: RunkoUIMessage): string {
  let text = "";
  for (const part of message.parts) {
    if (part.type === "text") {text += part.text;}
  }
  return text;
}

/** `RunkoError.code === "aborted"` 归 `"interrupted"`（宿主主动中断，非失败）；其余三个 code 归 `"failed"`。 */
function statusForError(error: RunkoError): "failed" | "interrupted" {
  return error.code === "aborted" ? "interrupted" : "failed";
}

/**
 * 宿主中止时 `RunkoError.message` 用什么——**优先用宿主自己给的理由**
 * （`abortController.abort(reason)`），缺席才回落到 `fallback`。
 *
 * 为什么要透传：`code: "aborted"` 只说了「被宿主中止了」，而**为什么**中止是宿主的
 * 概念——用户按了停止键、进程要关闭、pod 要迁移——core 不该认识这些词，也没必要为
 * 它们各加一个 code。宿主把理由放进 `reason`，它的界面就能如实解释给用户看
 * （chat 应用正是这么区分「已停止」与「服务重启，这一轮已中断」的，见
 * docs/logic/orchestration/tech/graceful-shutdown.md §2）。
 *
 * `abort()` **不带参数**时 `reason` 是运行时自造的 `AbortError`（"This operation was
 * aborted"）——那不是宿主的解释，当作没给：否则收尾消息里会出现这句与调用方无关的
 * 第三方措辞，比原本的默认文案更没信息量。
 */
function abortMessage(signal: AbortSignal, fallback: string): string {
  const { reason } = signal;
  if (typeof reason === "string" && reason.length > 0) {return reason;}
  if (reason instanceof Error && reason.name !== "AbortError" && reason.message.length > 0) {
    return reason.message;
  }
  return fallback;
}

function appendPlaceholderAssistantMessage(messages: RunkoUIMessage[]): RunkoUIMessage {
  const placeholder: RunkoUIMessage = { id: randomUUID(), role: "assistant", parts: [{ type: "step-start" }] };
  messages.push(placeholder);
  return placeholder;
}

/**
 * 本轮工具执行的墙钟总耗时（`RunkoMessageMetadata.toolDurationMs`，语义见
 * state.ts）：收集给定消息里全部已执行完的 `data-tool-timing` 部件的
 * `[executionStartedAt, completedAt]` 区间，按起点排序后合并重叠再求和——
 * 全只读批并行结算时多个调用同时在跑，简单相加会把重叠时段重复计入、
 * 甚至超过整轮墙钟；区间并集才是"这段时间里有工具在执行"的真实时长。
 *
 * **只数 `since` 之后才开始执行的区间**。这是为恢复轮加的：恢复改写的是上一轮的消息，
 * 里面既有上一轮已执行完的调用（不该算进本轮），也有这次被结清、在本轮才执行的那个（该算）。
 * 按「开始执行的时刻」切一刀，三种情形都对——包括 `ctx.suspend()` 挂起的调用：它在上一轮
 * 就「开始执行」了（执行的内容就是等人），所以等人的时间哪一轮都不算。
 * 普通轮不受影响：它的区间本来全在本轮开始之后。见挂起与恢复 · 技术方案 §5.6。
 */
function toolExecutionWallMs(messages: RunkoUIMessage[], since: number): number {
  const intervals: { start: number; end: number }[] = [];
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "data-tool-timing") {continue;}
      const { executionStartedAt, completedAt } = part.data;
      if (executionStartedAt === undefined || completedAt === undefined) {continue;}
      if (executionStartedAt < since) {continue;}
      intervals.push({ start: executionStartedAt, end: completedAt });
    }
  }
  intervals.sort((a, b) => a.start - b.start);
  let total = 0;
  let currentEnd = Number.NEGATIVE_INFINITY;
  for (const { start, end } of intervals) {
    if (end <= currentEnd) {continue;}
    total += end - Math.max(start, currentEnd);
    currentEnd = end;
  }
  return total;
}

/**
 * 轮收尾/轮失败的统一落点：把 `{turn, usage, status, durationMs, error?}` 写进
 * "这个 turn 最后一条 assistant 消息"的 `.metadata`（没有的话——如第一步之前
 * 就 context_overflow——现造一条占位消息承接，保证"assistant 消息 metadata
 * 携带轮结果"这个不变量对每个 turn 恒成立），并返回对应的 `message-metadata`
 * chunk（`send()` 靠这个 chunk 的 `status` 字段判定是否要 throw
 * `RunkoSessionError`，见 session.ts）。`durationMs` 在这里由
 * `turnStartedAt`（`runTurn` 入口的墙钟）现算——收尾路径唯一，全 turn 耗时
 * 因此天然覆盖成功/失败/中断所有出口。
 */
function finalizeTurn(opts: {
  messages: RunkoUIMessage[];
  lastAssistantMessage: RunkoUIMessage | undefined;
  turn: number;
  turnStartedAt: number;
  /** 本轮涉及的消息从这里开始切片（`toolDurationMs` 只统计它们的 timing 部件）。普通轮是入口时的长度；恢复轮往前多一条——被改写的那条上一轮的消息。 */
  turnMessagesStart: number;
  usage: Usage;
  status: "completed" | "failed" | "interrupted" | "suspended";
  error?: RunkoError;
  /** `status: "suspended"` 时带上：哪几次调用还悬着、为什么挂起（见 state.ts 的 `RunkoMessageMetadata.suspended`）。 */
  suspended?: { callIds: string[]; reason?: string };
}): RunkoChunk {
  const durationMs = Date.now() - opts.turnStartedAt;
  const toolDurationMs = toolExecutionWallMs(opts.messages.slice(opts.turnMessagesStart), opts.turnStartedAt);
  const base: RunkoMessageMetadata = { turn: opts.turn, usage: opts.usage, status: opts.status, durationMs, toolDurationMs };
  const metadata: RunkoMessageMetadata = {
    ...base,
    ...(opts.error === undefined ? {} : { error: opts.error }),
    ...(opts.suspended === undefined ? {} : { suspended: opts.suspended }),
  };
  const target = opts.lastAssistantMessage ?? appendPlaceholderAssistantMessage(opts.messages);
  target.metadata = target.metadata === undefined ? metadata : { ...withoutSuspended(target.metadata), ...metadata };
  return { type: "message-metadata", messageMetadata: metadata };
}

/**
 * 恢复轮在第一次调模型之前就收尾时，收尾 metadata 并在上一轮那条消息上（悬空调用只能在最后一条，
 * 不能另起一条）。上一轮挂起时写的 `suspended` 这时得去掉：新状态不是挂起的话，留着就自相矛盾；
 * 是挂起的话，新的那份会覆盖它。
 */
function withoutSuspended(metadata: RunkoMessageMetadata): RunkoMessageMetadata {
  const { suspended: _previous, ...rest } = metadata;
  return rest;
}

// ---- steer（STEER-1）：turn 进行中经 `Session.steer()` 排队的 user 消息 ----

/**
 * `opts.drainSteers` 排空到 `messages`，为每条已经构造好的 `RunkoUIMessage`
 * （`session.ts` 的 `steer()` 已经把 `Input` 转成带 `metadata.steered=true` 的
 * user 消息）发一遍 `start`/`text-*`/`file`/`finish` chunk——消息本身已经是
 * "完整已知"的（不是逐字流式产出的），这里发的 chunk 序列只是让实时消费方
 * 跟着落地，不需要额外的物化步骤（消息已经在 push 时就是完整形态）。
 *
 * **危险窗口不变量**（同旧实现的既有注释）：Anthropic 与 OpenAI 兼容（含
 * DeepSeek）两家 provider 都要求 tool-call 与其 tool-result 严格相邻配对——
 * 这个函数只在 `runTurn` 的两个安全 checkpoint 被调用（for 循环顶部、
 * finishReason 非 tool-calls 的收尾分支），两处都严格落在一步的工具调用
 * 全部结算完之后、下一次 `streamText` 之前，因此永远不会打断一对
 * assistant/tool 消息。
 */
async function* drainSteerMessages(
  drainSteers: (() => RunkoUIMessage[]) | undefined,
  messages: RunkoUIMessage[],
): AsyncGenerator<RunkoChunk, RunkoUIMessage[]> {
  if (drainSteers === undefined) {return [];}
  const drained = drainSteers();
  for (const message of drained) {
    messages.push(message);
    yield { type: "start", messageId: message.id, messageMetadata: message.metadata };
    for (const [index, part] of message.parts.entries()) {
      const partId = `${message.id}-${String(index)}`;
      if (part.type === "text") {
        yield { type: "text-start", id: partId };
        yield { type: "text-delta", id: partId, delta: part.text };
        yield { type: "text-end", id: partId };
      } else if (part.type === "file") {
        yield { type: "file", url: part.url, mediaType: part.mediaType };
      }
    }
    yield { type: "finish", finishReason: "stop" };
  }
  return drained;
}

// ---- 工具部件的构造（每种终态一个精确类型的构造函数，唯一允许出现类型逃逸的地方——见下） ----

/**
 * `type: \`tool-${toolName}\`` 由运行时字符串插值得到——`toolName: string` 的
 * 插值结果本身就是模板字面量类型 `` `tool-${string}` ``（TS 对字符串类型插值
 * 表达式的标准推导，不需要 `as`），与 `ToolUIPart<UITools>`（`RunkoUIMessage`
 * 的 TOOLS 类型参数取默认值 `UITools`，理由见 `state.ts` 的 `RunkoUIMessage`
 * 头注释）的判别字段精确匹配，因此本节全部构造函数都不需要类型断言。
 */
type RunkoToolPart = ToolUIPart<UITools>;

function inputAvailablePart(toolName: string, toolCallId: string, input: JsonValue): RunkoToolPart {
  return { type: `tool-${toolName}`, toolCallId, state: "input-available", input };
}

/**
 * `approval` 参数是可选的（对应 `state:'output-available'` 里 `approval` 字段
 * 本身可选的 ai@7 类型）：`review` 通过之后再执行的调用把 `{id, approved:
 * true}` 带进来，保留"这次调用经过人工审批"的可追溯性；未经审批直接放行的
 * 快速路径（per-tool/session 都是 `allow`）不传，字段就是 `undefined`。
 */
function outputAvailablePart(
  toolName: string,
  toolCallId: string,
  input: JsonValue,
  output: ToolReturn,
  approval?: { id: string; approved: true },
): RunkoToolPart {
  return { type: `tool-${toolName}`, toolCallId, state: "output-available", input, output, approval };
}

/** `approval` 同 `outputAvailablePart`——ai@7 的类型把 `output-error` 态的 `approval.approved` 钉死为字面量 `true`（这一态永远不会是"因被拒绝而失败"，拒绝有自己的 `output-denied` 态）。 */
function outputErrorPart(
  toolName: string,
  toolCallId: string,
  input: JsonValue | undefined,
  errorText: string,
  approval?: { id: string; approved: true },
): RunkoToolPart {
  return { type: `tool-${toolName}`, toolCallId, state: "output-error", input, errorText, approval };
}

function approvalRequestedPart(toolName: string, toolCallId: string, input: JsonValue, approvalId: string): RunkoToolPart {
  return { type: `tool-${toolName}`, toolCallId, state: "approval-requested", input, approval: { id: approvalId } };
}

/** `review` 之后人工裁决的回填——`approved` 区分 allow/deny，`reason` 只在 deny 时有意义（ai@7 类型允许两态都带，这里 allow 恒不传）。 */
function approvalRespondedPart(
  toolName: string,
  toolCallId: string,
  input: JsonValue,
  approvalId: string,
  approved: boolean,
  reason?: string,
): RunkoToolPart {
  return { type: `tool-${toolName}`, toolCallId, state: "approval-responded", input, approval: { id: approvalId, approved, reason } };
}

function outputDeniedPart(
  toolName: string,
  toolCallId: string,
  input: JsonValue,
  approvalId: string,
  reason: string,
): RunkoToolPart {
  return {
    type: `tool-${toolName}`,
    toolCallId,
    state: "output-denied",
    input,
    approval: { id: approvalId, approved: false, reason },
  };
}

// ---- data 部件（file-change：每次工具执行各一条；plan-update：同 id 覆盖） ----

function pushFileChangePart(message: RunkoUIMessage, id: string, data: FileChangeData): DataUIPart<{ "file-change": FileChangeData }> {
  const part: DataUIPart<{ "file-change": FileChangeData }> = { type: "data-file-change", id, data };
  message.parts.push(part);
  return part;
}

const PLAN_UPDATE_ID = "plan-update";

function upsertPlanUpdatePart(message: RunkoUIMessage, data: PlanUpdateData): DataUIPart<{ "plan-update": PlanUpdateData }> {
  const part: DataUIPart<{ "plan-update": PlanUpdateData }> = { type: "data-plan-update", id: PLAN_UPDATE_ID, data };
  const index = message.parts.findIndex((p) => p.type === "data-plan-update" && "id" in p && p.id === PLAN_UPDATE_ID);
  if (index === -1) {message.parts.push(part);}
  else {message.parts[index] = part;}
  return part;
}

// ---- data-tool-timing（持久部件，工具起止时间戳；docs/logic/orchestration/tech/single-ledger.md §2.2b 之后
// 补充，state.ts 的 `toolTimingDataSchema` 头注释有完整语义）：id = toolCallId，
// 同 id 覆盖，物化方式照 `upsertPlanUpdatePart` 先例，唯一差别是每个工具调用
// 各一个 id（不是单例）。----

function upsertToolTimingPart(message: RunkoUIMessage, data: ToolTimingData): DataUIPart<{ "tool-timing": ToolTimingData }> {
  const part: DataUIPart<{ "tool-timing": ToolTimingData }> = { type: "data-tool-timing", id: data.toolCallId, data };
  const index = message.parts.findIndex((p) => p.type === "data-tool-timing" && "id" in p && p.id === data.toolCallId);
  if (index === -1) {message.parts.push(part);}
  else {message.parts[index] = part;}
  return part;
}

function findToolTimingPart(message: RunkoUIMessage, toolCallId: string): DataUIPart<{ "tool-timing": ToolTimingData }> | undefined {
  return message.parts.find(
    (part): part is DataUIPart<{ "tool-timing": ToolTimingData }> => part.type === "data-tool-timing" && "id" in part && part.id === toolCallId,
  );
}

/** `tool-input-available` 之后立刻打点：调用成形、进入排队/审批管线的时刻——不是执行起点（那是 `executionStartedAt`），三个时刻的分工见 state.ts 的 `toolTimingDataSchema` 头注释。 */
function startToolTiming(message: RunkoUIMessage, toolCallId: string): RunkoChunk {
  const part = upsertToolTimingPart(message, { toolCallId, startedAt: Date.now() });
  return { type: "data-tool-timing", id: part.id, data: part.data };
}

/**
 * `executeToolCall` 前一刻打点：排队/审批都已结束、真正要执行了——deny 路径
 * 永远不经过这里，其部件因此恒无 `executionStartedAt`（"缺席 = 从未执行"，
 * state.ts）。`startedAt` 读回已物化的部件，缺失兜底同 `completeToolTiming`。
 */
function markToolExecutionStart(message: RunkoUIMessage, toolCallId: string): RunkoChunk {
  const existing = findToolTimingPart(message, toolCallId);
  const startedAt = existing?.data.startedAt ?? Date.now();
  const part = upsertToolTimingPart(message, { toolCallId, startedAt, executionStartedAt: Date.now() });
  return { type: "data-tool-timing", id: part.id, data: part.data };
}

/**
 * 每个结算 chunk（output-available/output-error/output-denied，含审批 deny）
 * 之后立刻补 `completedAt`——`startedAt`/`executionStartedAt` 读自已物化的
 * 部件原样保留（deny 路径本就没有后者，保留其缺席），`startedAt` 找不到
 * （理论上不会发生：本函数只在 `settleToolCall`/`settleExecution` 里跟在
 * `startToolTiming` 之后调用）时退化为 `Date.now()`，不让整条时间线因缺失
 * 而 throw。
 */
function completeToolTiming(message: RunkoUIMessage, toolCallId: string): RunkoChunk {
  const existing = findToolTimingPart(message, toolCallId);
  const startedAt = existing?.data.startedAt ?? Date.now();
  const executionStartedAt = existing?.data.executionStartedAt;
  const part = upsertToolTimingPart(message, {
    toolCallId,
    startedAt,
    ...(executionStartedAt !== undefined ? { executionStartedAt } : {}),
    completedAt: Date.now(),
  });
  return { type: "data-tool-timing", id: part.id, data: part.data };
}

/**
 * 并行驱动多个结算 generator，把它们的 chunk 按"谁先产出谁先出流"合并成单
 * 通道（外层 `runOneStep` 仍是一个顺序 generator，没法直接 `yield*` 多路）。
 * 仅用于全只读批（见 `runOneStep` 的 settle 分支）：
 *
 * - 无界缓冲是刻意的——单个工具结算产出的 chunk 数量很小（状态迁移 + timing
 *   + 至多几条派生数据），不值得为背压引入复杂度。
 * - 共享的 `derivedData` 收集器在并行下理论上会串味（drain 交错），但只读
 *   工具按 `Tool.readOnly` 契约不产生任何派生数据，此路径下收集器恒空。
 * - 任一分支抛错（settleToolCall 把工具错误都收敛为 output-error chunk，真
 *   抛出意味着 bug）：先把已产出的 chunk 放完、等全部分支停机，再重抛第一
 *   个错误——与串行路径"错误冒泡中断 turn"同语义，不留未观察的 rejection。
 */
async function* mergeSettleStreams(
  streams: AsyncGenerator<RunkoChunk, SuspendedCall | undefined>[],
): AsyncGenerator<RunkoChunk, (SuspendedCall | undefined)[]> {
  const queue: RunkoChunk[] = [];
  // 按**入参下标**写回，不用 push——并行结算的完成顺序是不确定的，而挂起 callId 的顺序
  // 要跟模型发出调用的顺序一致（它会进账本 metadata，顺序飘会让同一份历史产出不同的记录）。
  const outcomes: (SuspendedCall | undefined)[] = Array.from({ length: streams.length });
  let running = streams.length;
  let failure: { error: unknown } | undefined;
  let wake: (() => void) | undefined;
  const notify = (): void => {
    wake?.();
    wake = undefined;
  };
  for (const [index, stream] of streams.entries()) {
    void (async () => {
      try {
        // 手工迭代而不是 `for await`——后者拿不到生成器的 return 值，而这里正需要它。
        let step = await stream.next();
        while (!step.done) {
          queue.push(step.value);
          notify();
          step = await stream.next();
        }
        outcomes[index] = step.value;
      } catch (error) {
        failure ??= { error };
      } finally {
        running -= 1;
        notify();
      }
    })();
  }
  while (running > 0 || queue.length > 0) {
    const next = queue.shift();
    if (next !== undefined) {
      yield next;
      continue;
    }
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
  }
  if (failure !== undefined) {throw failure.error;}
  return outcomes;
}

// ---- 单个工具调用的结算（审批→执行→部件/chunk 编码，见文件头"审批：三值 + 阻塞前显式产出"） ----

/**
 * 一次调用要求[挂起](../../../docs/terms.md)本轮——`settleToolCall` 的返回值，`undefined` 表示
 * 正常结算完了。
 *
 * 它**走返回值而不是异常**：挂起在 loop 这一层是一个需要逐级汇总的正常结局（一步里可能有
 * 好几个调用同时挂起），异常通道表达不了「汇总」，而且会让正常路径被当故障——同
 * `Grant.nextSeq` 不抛 `OwnershipLostError` 的理由。
 *
 * （工具那一侧相反，`ctx.suspend()` 确实是抛的：那里要穿透工具自己的包装层，见 `suspend.ts`。
 * 两层的选择不同，因为要解决的问题不同。）
 */
interface SuspendedCall {
  callId: string;
  reason: string | undefined;
}

interface PendingToolCall {
  toolCallId: string;
  toolName: string;
  input: JsonValue;
  /** `assistantMessage.parts` 里 input-available 占位部件的下标——结算时原地替换，不新增数组项（docs/logic/orchestration/tech/single-ledger.md §4.1 实现教训：占位+结算双记会被服务商 400）。 */
  partIndex: number;
}

interface SettleToolCallOptions {
  call: PendingToolCall;
  assistantMessage: RunkoUIMessage;
  tools: Record<string, Tool>;
  session: { id: string; turn: number };
  fs: RunkoFS;
  abortSignal: AbortSignal;
  onApproval: ApprovalPolicy | undefined;
  /** 人审通道（§types.ts `ApprovalReviewer`）——`review` 结果先 yield 请求 chunk 再 `await` 这个；未注入时 `review` 视同无仲裁者 deny，见 `settleToolCall`。 */
  onReview: ApprovalReviewer | undefined;
  onceMemory: OnceApprovalMemory;
  derivedData: DerivedDataCollector;
  getSkill: ((name: string) => SkillHandle) | undefined;
  /** telemetry 集成透传（`SessionTelemetry`）——`settleExecution` 在真实执行前后补发 onToolExecutionStart/End，见 `notifyToolExecution*` 注释。 */
  telemetry: SessionTelemetry | undefined;
}

// ---- 工具执行遥测（补发）：runko 的 loop 自己结算工具，AI SDK 没有机会触发
// onToolExecutionStart/End——由 settleExecution 在 executeToolCall 前后替它
// 补发给注入的集成，事件形状用 ai 的 widened 联合（ToolExecutionStart/EndEvent），
// 并带上与其余事件一致的 functionId 关联键。deny/未知工具/畸形调用从未执行，
// 不发（与 data-tool-timing 的 executionStartedAt "缺席 = 从未执行"同语义）。
// messages 字段（"发起该调用的上下文消息"）刻意置空数组：落库侧本就把大块
// 正文收敛掉，这里不为遥测多留一份账本引用。回调异常一律就地吞掉，遥测
// 永不影响 turn。----

function notifyIntegrations<E>(telemetry: SessionTelemetry, callback: (integration: Telemetry) => ((event: E) => void | PromiseLike<void>) | undefined, event: E): void {
  for (const integration of telemetry.integrations) {
    try {
      const handler = callback(integration);
      const result = handler?.(event);
      if (result !== undefined) {void Promise.resolve(result).catch(() => {});}
    } catch {
      // 遥测永不影响 turn。
    }
  }
}

function notifyToolExecutionStart(opts: SettleToolCallOptions, input: JsonValue): void {
  if (opts.telemetry === undefined) {return;}
  const event: ToolExecutionStartEvent & { functionId: string } = {
    callId: opts.call.toolCallId,
    messages: [],
    toolCall: { type: "tool-call", toolCallId: opts.call.toolCallId, toolName: opts.call.toolName, input },
    toolContext: undefined,
    functionId: `${opts.session.id}#${String(opts.session.turn)}`,
  };
  notifyIntegrations(opts.telemetry, (integration) => integration.onToolExecutionStart, event);
}

function notifyToolExecutionEnd(opts: SettleToolCallOptions, input: JsonValue, outcome: { status: "completed"; output: unknown } | { status: "failed"; errorText: string }, toolExecutionMs: number): void {
  if (opts.telemetry === undefined) {return;}
  const base = { toolCallId: opts.call.toolCallId, toolName: opts.call.toolName, input };
  const event: ToolExecutionEndEvent & { functionId: string } = {
    callId: opts.call.toolCallId,
    toolExecutionMs,
    messages: [],
    toolCall: { type: "tool-call", ...base },
    toolContext: undefined,
    toolOutput:
      outcome.status === "completed" ? { type: "tool-result", ...base, output: outcome.output } : { type: "tool-error", ...base, error: outcome.errorText },
    functionId: `${opts.session.id}#${String(opts.session.turn)}`,
  };
  notifyIntegrations(opts.telemetry, (integration) => integration.onToolExecutionEnd, event);
}

/**
 * 派生数据（file-change / plan-update）落部件 + 出 chunk。
 *
 * 三条路共用：执行成功、执行失败、[挂起](../../../docs/terms.md)。**挂起也要走**——工具在
 * 停下来等人之前可能已经真的改了文件，那些是已发生的事实，跟这次调用有没有结果无关。
 */
async function* emitDerivedData(opts: SettleToolCallOptions, derived: ToolCallDerivedData): AsyncGenerator<RunkoChunk, void> {
  const { call, assistantMessage } = opts;
  if (derived.changes.length > 0) {
    const data: FileChangeData = { changes: derived.changes };
    const id = `file-change-${call.toolCallId}`;
    const part = pushFileChangePart(assistantMessage, id, data);
    yield { type: "data-file-change", id: part.id, data: part.data };
  }
  if (derived.items !== undefined) {
    const part = upsertPlanUpdatePart(assistantMessage, { items: derived.items });
    yield { type: "data-plan-update", id: part.id, data: part.data };
  }
}

/**
 * 第 2 步（`runtime.ts` 的 `executeToolCall`）+ 落 output 部件/chunk + 派生数据
 * chunk——`allow` 快速路径与 `review` 人工批准之后共用这一段尾巴，`approval`
 * 非空时（后者）把 `{id, approved:true}` 带进 output 部件（见
 * `outputAvailablePart`/`outputErrorPart` 注释），前者不带（`undefined`）。
 *
 * 返回非 `undefined` = 这次调用要求挂起本轮（工具调了 `ctx.suspend()`）。
 */
async function* settleExecution(
  opts: SettleToolCallOptions,
  tool: Tool,
  input: JsonValue,
  approval: { id: string; approved: true } | undefined,
): AsyncGenerator<RunkoChunk, SuspendedCall | undefined> {
  const { call, assistantMessage } = opts;
  yield markToolExecutionStart(assistantMessage, call.toolCallId);
  const executionStartedAt = Date.now();
  notifyToolExecutionStart(opts, input);
  const progressChunks: string[] = [];
  const result = await executeToolCall({
    tool,
    toolName: call.toolName,
    callId: call.toolCallId,
    input,
    session: opts.session,
    fs: opts.fs,
    abortSignal: opts.abortSignal,
    onProgress: (partial) => progressChunks.push(partial),
    derivedData: opts.derivedData,
    getSkill: opts.getSkill,
  });

  // transient `data-tool-progress`：只出流,绝不 push 进 assistantMessage.parts
  // （docs/logic/orchestration/tech/single-ledger.md §4.1 发现 A）。`ctx.update()` 是同步回调，生成器不能从回调内部
  // yield，因此先缓冲、`executeToolCall` resolve 后按到达顺序重放——效果是
  // "进度确实以 chunk 到达"，但不与执行过程严格实时交错（既有取舍，
  // 迁移前的 `executeStepToolCalls` 就是这个姿态，原样保留）。`text` 字段是
  // 累积文本（docs/logic/orchestration/tech/single-ledger.md §2.2b"text（累积）"）。
  let accumulated = "";
  for (const chunk of progressChunks) {
    accumulated += chunk;
    yield {
      type: "data-tool-progress",
      id: call.toolCallId,
      data: { toolCallId: call.toolCallId, text: accumulated },
      transient: true,
    };
  }

  // 挂起：**什么都不写**。工具部件停在 `input-available`（带着完整入参），不发 output chunk、
  // 不 complete timing（那条 timing 因此只有 executionStartedAt——「开始过、没结束」，与工具
  // 执行中崩溃同形，`toolExecutionWallMs` 会跳过它）。这次调用原样留在账本里等人。
  //
  // 派生数据（file-change / plan-update）照常产出：挂起之前工具可能已经真的改了文件，那些是
  // **已发生的事实**，跟这次调用有没有结果无关。
  if (result.status === "suspended") {
    yield* emitDerivedData(opts, result.derived);
    return { callId: call.toolCallId, reason: result.reason };
  }

  if (result.status === "completed") {
    assistantMessage.parts[call.partIndex] = outputAvailablePart(call.toolName, call.toolCallId, input, result.output, approval);
    yield { type: "tool-output-available", toolCallId: call.toolCallId, output: result.output };
    yield completeToolTiming(assistantMessage, call.toolCallId);
    notifyToolExecutionEnd(opts, input, { status: "completed", output: result.output }, Date.now() - executionStartedAt);
  } else {
    const errorText = toErrorText(result.output);
    assistantMessage.parts[call.partIndex] = outputErrorPart(call.toolName, call.toolCallId, input, errorText, approval);
    yield { type: "tool-output-error", toolCallId: call.toolCallId, errorText };
    yield completeToolTiming(assistantMessage, call.toolCallId);
    notifyToolExecutionEnd(opts, input, { status: "failed", errorText }, Date.now() - executionStartedAt);
  }

  yield* emitDerivedData(opts, result.derived);
  return undefined;
}

/**
 * 单个工具调用的结算——第 1 步（审批解析）+（`review` 时）先产出后阻塞的人工
 * 裁决 + 第 2 步（执行），逐段说明见文件头"审批：三值 + 阻塞前显式产出"一节。
 *
 * 返回非 `undefined` = 这次调用要求[挂起](../../../docs/terms.md)本轮。两个来源：人审通道答了
 * `suspend`，或者工具自己调了 `ctx.suspend()`。
 */
async function* settleToolCall(opts: SettleToolCallOptions): AsyncGenerator<RunkoChunk, SuspendedCall | undefined> {
  const { call, assistantMessage } = opts;
  const tool = opts.tools[call.toolName];

  if (tool === undefined) {
    const errorText = `Unknown tool "${call.toolName}" — it is not registered in this session's tool set. Only call tools that were offered.`;
    assistantMessage.parts[call.partIndex] = outputErrorPart(call.toolName, call.toolCallId, call.input, errorText);
    yield { type: "tool-output-error", toolCallId: call.toolCallId, errorText };
    yield completeToolTiming(assistantMessage, call.toolCallId);
    return undefined;
  }

  const approval = await resolveToolCallApproval({
    tool,
    toolName: call.toolName,
    callId: call.toolCallId,
    input: call.input,
    session: opts.session,
    onApproval: opts.onApproval,
    onceMemory: opts.onceMemory,
  });

  if (approval.status === "invalid") {
    assistantMessage.parts[call.partIndex] = outputErrorPart(call.toolName, call.toolCallId, call.input, approval.message);
    yield { type: "tool-output-error", toolCallId: call.toolCallId, errorText: approval.message };
    yield completeToolTiming(assistantMessage, call.toolCallId);
    return undefined;
  }

  if (approval.status === "deny") {
    assistantMessage.parts[call.partIndex] = outputDeniedPart(call.toolName, call.toolCallId, call.input, call.toolCallId, approval.reason);
    yield { type: "tool-output-denied", toolCallId: call.toolCallId };
    yield completeToolTiming(assistantMessage, call.toolCallId);
    return undefined;
  }

  if (approval.status === "allow") {
    return yield* settleExecution(opts, tool, approval.input, undefined);
  }

  // approval.status === "review"：先产出请求 chunk，再 await 人审通道——
  // 这是本次返工要修的顺序，理由见文件头。未接人审通道时视同无仲裁者，
  // 不产出请求 chunk（没人能回应它）。
  if (opts.onReview === undefined) {
    const reason = noArbiterDenyReason(call.toolName);
    assistantMessage.parts[call.partIndex] = outputDeniedPart(call.toolName, call.toolCallId, approval.input, call.toolCallId, reason);
    yield { type: "tool-output-denied", toolCallId: call.toolCallId };
    yield completeToolTiming(assistantMessage, call.toolCallId);
    return undefined;
  }

  assistantMessage.parts[call.partIndex] = approvalRequestedPart(call.toolName, call.toolCallId, approval.input, call.toolCallId);
  yield { type: "tool-approval-request", approvalId: call.toolCallId, toolCallId: call.toolCallId };

  const decision = await opts.onReview({
    toolName: call.toolName,
    input: approval.input,
    ctx: { toolName: call.toolName, callId: call.toolCallId, session: opts.session },
  });

  // 挂起：**一个字都不改**。上面那行已经把部件写成了 `approval-requested`——那正是我们要留在
  // 账本里的东西：一次带着完整入参、等着人答的调用。不发响应 chunk（没有响应）、不 complete
  // timing（没执行过）、不动 once 记忆（没人批准过）。本轮就此收尾。
  //
  // ⚠️ **这里不能走「resolve 成 deny 再靠 abort 收尾」那条近路。** 上面 `await` 醒来之后是
  // 立刻按 behavior 分支的，不检查 abort 信号——deny 分支会把部件改写成 `output-denied`。
  // 于是人几小时后回来点「允许」时，账本里那次调用早就是拒绝态了，审批闸门形同虚设。
  // 完整推演见 docs/logic/orchestration/tech/suspend-resume.md §2。
  if (decision.behavior === "suspend") {
    return { callId: call.toolCallId, reason: decision.reason };
  }

  if (decision.behavior === "deny") {
    yield* settleHumanDenial(opts, approval.input, decision.message ?? DEFAULT_DENY_MESSAGE);
    return undefined;
  }

  if (approval.markOnceOnApprove) {opts.onceMemory.markApproved(call.toolName);}

  return yield* settleHumanApproval(opts, tool, approval.input);
}

/**
 * 人审**拒绝**之后的写入：部件先改成 `approval-responded`（approved: false）并发响应 chunk，
 * 再改成 `output-denied`，理由回填给模型。当场裁决与恢复轮的 `approval / deny` 共用。
 */
async function* settleHumanDenial(opts: SettleToolCallOptions, input: JsonValue, reason: string): AsyncGenerator<RunkoChunk, void> {
  const { call, assistantMessage } = opts;
  assistantMessage.parts[call.partIndex] = approvalRespondedPart(call.toolName, call.toolCallId, input, call.toolCallId, false, reason);
  yield { type: "tool-approval-response", approvalId: call.toolCallId, approved: false, reason };

  assistantMessage.parts[call.partIndex] = outputDeniedPart(call.toolName, call.toolCallId, input, call.toolCallId, reason);
  yield { type: "tool-output-denied", toolCallId: call.toolCallId };
  yield completeToolTiming(assistantMessage, call.toolCallId);
}

/**
 * 人审**批准**之后：部件改成 `approval-responded`（approved: true）、发响应 chunk、执行。
 * 当场裁决与恢复轮的 `approval / allow` 共用。返回值同 `settleExecution`（执行时工具可能又挂起）。
 */
async function* settleHumanApproval(opts: SettleToolCallOptions, tool: Tool, input: JsonValue): AsyncGenerator<RunkoChunk, SuspendedCall | undefined> {
  const { call, assistantMessage } = opts;
  assistantMessage.parts[call.partIndex] = approvalRespondedPart(call.toolName, call.toolCallId, input, call.toolCallId, true);
  yield { type: "tool-approval-response", approvalId: call.toolCallId, approved: true };
  return yield* settleExecution(opts, tool, input, { id: call.toolCallId, approved: true });
}

/**
 * 一步半路失败（停止、模型服务出错）时，半成品消息里可能已经有模型发出、还没轮到结算的调用。
 * 它们没执行，也不会再执行——这一轮就此收尾。给每个一个「没有执行」的错误结果。
 *
 * 不收的话账本末尾留着悬空调用：下一轮会被当成[挂起](../../../docs/terms.md)（等一个根本没人
 * 能答的答复），交给模型也会 400。
 */
function* closeNeverRunCalls(message: RunkoUIMessage, cause: string): Generator<RunkoChunk, void> {
  const dangling = new Set(pendingCallIds([message]));
  for (const [index, part] of message.parts.entries()) {
    if (!isToolUIPart(part) || !dangling.has(part.toolCallId)) {continue;}
    const errorText = `Not run: this step ended early (${cause}) before the call was carried out.`;
    message.parts[index] = outputErrorPart(getToolName(part), part.toolCallId, toJsonValue(part.input), errorText);
    yield { type: "tool-output-error", toolCallId: part.toolCallId, errorText };
  }
}

/**
 * 串行批里排在一个挂起调用后面的调用：**不执行**，直接给一个错误结果，告诉模型为什么没跑。
 * 不留成悬空调用——那样恢复时既没有裁决表的行可读，也分不清它是在等人还是被跳过了。
 */
async function* skipBehindSuspended(opts: SettleToolCallOptions, blockedBy: PendingToolCall): AsyncGenerator<RunkoChunk, void> {
  const { call, assistantMessage } = opts;
  const errorText =
    `Not run: the earlier call "${blockedBy.toolName}" (${blockedBy.toolCallId}) in this step is waiting for a person, ` +
    "and calls in one step run in the order you wrote them. If you still need this call once that one has a result, make it again.";
  assistantMessage.parts[call.partIndex] = outputErrorPart(call.toolName, call.toolCallId, call.input, errorText);
  yield { type: "tool-output-error", toolCallId: call.toolCallId, errorText };
  yield completeToolTiming(assistantMessage, call.toolCallId);
}

// ---- 恢复轮的开场：结清一次悬空调用（挂起与恢复 · 技术方案 §5.2） ----

/**
 * 恢复轮第一件事：把那条悬空部件**原地**结清——它在上一轮的消息里（恒为最后一条，§5.3），
 * 改写后 id 不变，调用方以新 seq 追加它，读账本时按 id 折叠（§5.4）。
 *
 * 三种结清方式：
 *
 * - `approval / allow`：**不再走审批链**（人已经批准；重跑分类器可能又判 review、再挂起一次），
 *   但**重新过 `inputSchema`**——「原封不动」是说不让模型重新生成参数，不是绕过校验；恢复前工具
 *   可能换了版本。然后执行，执行时工具还可能再挂起一次。
 * - `approval / deny`：与当场拒绝同一套写入，理由回填给模型。
 * - `output`：外部给的值就是这次调用的输出。声明了 `outputSchema` 就校验，不过就是 `output-error`。
 *
 * 部件与 `Settlement` 对不对得上，`resolveResumeTarget` 已经在开轮前查过了。
 */
async function* settleResumedCall(
  base: Omit<SettleToolCallOptions, "call" | "assistantMessage">,
  target: ResumeTarget,
  settlement: Settlement,
): AsyncGenerator<RunkoChunk, SuspendedCall | undefined> {
  const { message, partIndex, part } = target;
  const toolName = getToolName(part);
  const toolCallId = part.toolCallId;

  // 账本里的 input 在 ai 的类型里是 `unknown`。它来自模型产出、又经过一次 JSON 落盘，按理总是
  // 合法 JSON；真不合法说明账本坏了，这时记一次 output-error 让本轮继续，比抛错把会话卡死好。
  const parsedInput = jsonValueSchema.safeParse(part.input);
  if (!parsedInput.success) {
    const errorText = `Cannot resume tool call "${toolName}": its stored input is not valid JSON.`;
    message.parts[partIndex] = outputErrorPart(toolName, toolCallId, undefined, errorText);
    yield { type: "tool-output-error", toolCallId, errorText };
    yield completeToolTiming(message, toolCallId);
    return undefined;
  }
  const input = parsedInput.data;
  const opts: SettleToolCallOptions = { ...base, call: { toolCallId, toolName, input, partIndex }, assistantMessage: message };
  const tool = opts.tools[toolName];

  if (settlement.kind === "approval") {
    if (settlement.behavior === "deny") {
      yield* settleHumanDenial(opts, input, settlement.message ?? DEFAULT_DENY_MESSAGE);
      return undefined;
    }
    if (tool === undefined) {
      const errorText = `Unknown tool "${toolName}" — it is no longer registered in this session's tool set, so the approved call cannot run.`;
      message.parts[partIndex] = outputErrorPart(toolName, toolCallId, input, errorText);
      yield { type: "tool-output-error", toolCallId, errorText };
      yield completeToolTiming(message, toolCallId);
      return undefined;
    }
    const reparsed = tool.inputSchema.safeParse(input);
    if (!reparsed.success) {
      const errorText =
        `The approved call to "${toolName}" can no longer run: its stored input does not match the tool's current ` +
        `input schema (${reparsed.error.message}). The tool may have changed since the call was approved.`;
      message.parts[partIndex] = outputErrorPart(toolName, toolCallId, input, errorText, { id: toolCallId, approved: true });
      yield { type: "tool-approval-response", approvalId: toolCallId, approved: true };
      yield { type: "tool-output-error", toolCallId, errorText };
      yield completeToolTiming(message, toolCallId);
      return undefined;
    }
    return yield* settleHumanApproval(opts, tool, reparsed.data);
  }

  // settlement.kind === "output"。审批过后才挂起的那种，保留审批痕迹。
  const approval: { id: string; approved: true } | undefined =
    part.state === "approval-responded" && part.approval.approved === true ? { id: part.approval.id, approved: true } : undefined;
  let output = settlement.output;
  if (tool?.outputSchema !== undefined) {
    const parsedOutput = tool.outputSchema.safeParse(output);
    if (!parsedOutput.success) {
      const errorText = `The value supplied to resume tool call "${toolName}" does not match its outputSchema: ${parsedOutput.error.message}`;
      message.parts[partIndex] = outputErrorPart(toolName, toolCallId, input, errorText, approval);
      yield { type: "tool-output-error", toolCallId, errorText };
      yield completeToolTiming(message, toolCallId);
      return undefined;
    }
    output = parsedOutput.data;
  }
  message.parts[partIndex] = outputAvailablePart(toolName, toolCallId, input, output, approval);
  yield { type: "tool-output-available", toolCallId, output };
  yield completeToolTiming(message, toolCallId);
  return undefined;
}

// ---- 单步：一次 `streamText` = 账本里新增一条 assistant 消息（见文件头） ----

export interface StepOutcome {
  finishReason: FinishReason;
  usage: LanguageModelUsage;
  assistantMessage: RunkoUIMessage;
  /**
   * 本步有调用要求[挂起](../../../docs/terms.md)本轮时才有。`runTurn` 见到它就以
   * `suspended` 收尾，**不进下一步**——那些调用还没有结果，拿这份历史去调模型是错的。
   */
  suspended?: { callIds: string[]; reason?: string };
}

/**
 * session 级 telemetry 透传（ai@7 已转正的 `Telemetry` 事件集成接口，
 * `streamText` 的 `telemetry.integrations`）：宿主注入集成对象接收模型调用
 * 生命周期事件（每步 start/end、每次 model call 的 usage/performance 等）。
 * 关联键不由宿主管——`runOneStep` 恒在 `telemetry.functionId` 注入
 * `"<sessionId>#<turn>"`，每个事件都自带（ai 的 `InferTelemetryEvent` 把
 * TelemetryOptions 字段并进事件），集成端按它归档/查询。注意：runko 的工具
 * 由 loop 自己结算（settleToolCall），AI SDK 的 onToolExecutionStart/End
 * 事件在这里**永远不会触发**——工具维度的数据走 `data-tool-timing` 部件。
 */
export interface SessionTelemetry {
  integrations: Telemetry[];
  /** 事件是否携带模型输入（完整 messages）——默认跟随 ai 的缺省（true）；体积/敏感性考量下宿主可关。 */
  recordInputs?: boolean;
  /** 事件是否携带模型输出正文——同上。 */
  recordOutputs?: boolean;
}

interface RunOneStepOptions {
  model: LanguageModel;
  system: string | undefined;
  ledger: RunkoUIMessage[];
  tools: Record<string, Tool>;
  maxOutputTokens: number | undefined;
  session: { id: string; turn: number };
  fs: RunkoFS;
  abortSignal: AbortSignal;
  onApproval: ApprovalPolicy | undefined;
  onReview: ApprovalReviewer | undefined;
  onceMemory: OnceApprovalMemory;
  derivedData: DerivedDataCollector;
  getSkill: ((name: string) => SkillHandle) | undefined;
  telemetry: SessionTelemetry | undefined;
}

/**
 * **不复用 `model/step.ts` 的 `runStep`**，改为手工发块：`runStep` 只转发四类增量块
 * （text-delta/reasoning-delta/tool-input-delta/tool-call），丢弃
 * text-start/text-end/reasoning-start/reasoning-end 等边界块——UIMessage 的
 * `TextUIPart`/`ReasoningUIPart` 需要这些边界来维护 `state:'streaming'|'done'`
 * 与 ai 官方 chunk 词汇表的 `text-start`/`text-end` 对应，因此本文件直接消费
 * `streamText()` 的 `result.stream`（同 `runStep` 内部一样是 `fullStream` 的
 * 非弃用别名），按 examples/13 `runOneStep` 的已验证姿态手工翻译。
 */
async function* runOneStep(opts: RunOneStepOptions): AsyncGenerator<RunkoChunk, StepOutcome> {
  const requestMessages = await convertToModelMessages(opts.ledger);
  const result = streamText({
    model: opts.model,
    instructions: opts.system,
    messages: requestMessages,
    tools: convertTools(opts.tools),
    abortSignal: opts.abortSignal,
    maxOutputTokens: opts.maxOutputTokens,
    // functionId 恒注入（见 SessionTelemetry 注释）：没注册任何集成时这里是
    // 纯元数据、零开销；注入了集成，事件就自带 "<sessionId>#<turn>" 关联键。
    telemetry: {
      functionId: `${opts.session.id}#${String(opts.session.turn)}`,
      ...(opts.telemetry?.recordInputs !== undefined ? { recordInputs: opts.telemetry.recordInputs } : {}),
      ...(opts.telemetry?.recordOutputs !== undefined ? { recordOutputs: opts.telemetry.recordOutputs } : {}),
      ...(opts.telemetry !== undefined ? { integrations: opts.telemetry.integrations } : {}),
    },
  });

  const assistantMessage: RunkoUIMessage = { id: randomUUID(), role: "assistant", parts: [{ type: "step-start" }] };
  opts.ledger.push(assistantMessage);
  yield { type: "start", messageId: assistantMessage.id };
  yield { type: "start-step" };

  const openText = new Map<string, TextUIPart>();
  const openReasoning = new Map<string, ReasoningUIPart>();
  const pending: PendingToolCall[] = [];

  for await (const part of result.stream) {
    switch (part.type) {
      case "text-start": {
        const textPart: TextUIPart = { type: "text", text: "", state: "streaming" };
        openText.set(part.id, textPart);
        assistantMessage.parts.push(textPart);
        yield { type: "text-start", id: part.id };
        break;
      }
      case "text-delta": {
        const textPart = openText.get(part.id);
        if (textPart !== undefined) {textPart.text += part.text;}
        yield { type: "text-delta", id: part.id, delta: part.text };
        break;
      }
      case "text-end": {
        const textPart = openText.get(part.id);
        if (textPart !== undefined) {textPart.state = "done";}
        yield { type: "text-end", id: part.id };
        break;
      }
      case "reasoning-start": {
        const reasoningPart: ReasoningUIPart = { type: "reasoning", text: "", state: "streaming" };
        openReasoning.set(part.id, reasoningPart);
        assistantMessage.parts.push(reasoningPart);
        yield { type: "reasoning-start", id: part.id };
        break;
      }
      case "reasoning-delta": {
        const reasoningPart = openReasoning.get(part.id);
        if (reasoningPart !== undefined) {reasoningPart.text += part.text;}
        yield { type: "reasoning-delta", id: part.id, delta: part.text };
        break;
      }
      case "reasoning-end": {
        const reasoningPart = openReasoning.get(part.id);
        if (reasoningPart !== undefined) {reasoningPart.state = "done";}
        yield { type: "reasoning-end", id: part.id };
        break;
      }
      case "tool-call": {
        // `part.dynamic === true` 是真正的判别字段——`DynamicToolCall.toolName`
        // 是宽泛的 `string`（非字面量），单靠 `switch(part.toolName)` 排不掉这一
        // 支（TS 不能证明一个宽 string 一定不等于某个字面量），这是 examples/13
        // 已经踩过并记录的同一个 TS 窄化坑，这里同款处理。`invalid` 专指"不可
        // 解析的调用/未知工具名"（parse 失败，AI SDK 自己判定，见 ai@7 d.ts
        // `DynamicToolCall.invalid` 注释）——直接落 output-error，不进入
        // input-available/执行流程（没有可用的 input 可供执行）。
        if (part.dynamic === true && part.invalid === true) {
          const errorText = `Malformed tool call for "${part.toolName}": ${describeError(part.error)}`;
          assistantMessage.parts.push(outputErrorPart(part.toolName, part.toolCallId, undefined, errorText));
          yield { type: "tool-input-error", toolCallId: part.toolCallId, toolName: part.toolName, input: part.input, errorText };
          break;
        }

        const input = toJsonValue(part.input);
        const partIndex = assistantMessage.parts.length;
        assistantMessage.parts.push(inputAvailablePart(part.toolName, part.toolCallId, input));
        yield { type: "tool-input-available", toolCallId: part.toolCallId, toolName: part.toolName, input };
        yield startToolTiming(assistantMessage, part.toolCallId);
        pending.push({ toolCallId: part.toolCallId, toolName: part.toolName, input, partIndex });
        break;
      }
      default:
        break;
    }
  }

  yield { type: "finish-step" };
  const finalStep = await result.finalStep;

  const settleOptsFor = (call: PendingToolCall): SettleToolCallOptions => ({
    call,
    assistantMessage,
    tools: opts.tools,
    session: opts.session,
    fs: opts.fs,
    abortSignal: opts.abortSignal,
    onApproval: opts.onApproval,
    onReview: opts.onReview,
    onceMemory: opts.onceMemory,
    derivedData: opts.derivedData,
    getSkill: opts.getSkill,
    telemetry: opts.telemetry,
  });

  // 全只读批并行结算（2026-07-16 定案）：同一 step 的多个 tool call 是模型在
  // 看到任何结果之前一次性写出的——参数彼此不可能依赖，模型/API 契约
  // （parallel tool use）本就把同批调用定义为可并行的独立操作；串行只是审批
  // 链 + 共享沙盒下的保守实现，模型并不知道也不依赖它。只读工具
  // （`Tool.readOnly`，types.ts）承诺无副作用，整批全只读时没有写冲突可言
  // → 并行。混入任何非只读调用则**整批**退回串行：模型偶发的"同批隐含顺序
  // 依赖"坏批次（如先 write-file 再 bash cat 同一文件）只可能涉及写操作，
  // 串行按书写顺序执行把它兜住。
  const settled: (SuspendedCall | undefined)[] = [];
  if (pending.length > 1 && pending.every((call) => opts.tools[call.toolName]?.readOnly === true)) {
    settled.push(...(yield* mergeSettleStreams(pending.map((call) => settleToolCall(settleOptsFor(call))))));
  } else {
    // 串行路径保的是「按模型书写的顺序执行」。所以前一个调用挂起之后，**后面的一个都不执行**：
    // 否则它们会先于被挂起的那个跑完，人几小时后批准时，被批准的那个反而最后才执行
    // （docs/logic/orchestration/tech/suspend-resume.md §3.3）。它们各得一个「没有执行」的结果，
    // 账本里不留悬空调用；模型恢复之后看得到，需要的话会再发一次。
    let blockedBy: PendingToolCall | undefined;
    for (const call of pending) {
      if (blockedBy !== undefined) {
        yield* skipBehindSuspended(settleOptsFor(call), blockedBy);
        settled.push(undefined);
        continue;
      }
      const outcome = yield* settleToolCall(settleOptsFor(call));
      settled.push(outcome);
      if (outcome !== undefined) {blockedBy = call;}
    }
  }

  yield { type: "finish", finishReason: finalStep.finishReason };

  // 汇总挂起：只要有**任何一个**调用要求挂起，本轮就挂起。callIds 按模型发出调用的顺序，
  // reason 取第一个给了理由的（多个同时挂起时它们通常同源，都是同一个内存窗口到点）。
  const suspendedCalls = settled.filter((outcome): outcome is SuspendedCall => outcome !== undefined);
  if (suspendedCalls.length === 0) {
    return { finishReason: finalStep.finishReason, usage: finalStep.usage, assistantMessage };
  }
  const reason = suspendedCalls.find((entry) => entry.reason !== undefined)?.reason;
  return {
    finishReason: finalStep.finishReason,
    usage: finalStep.usage,
    assistantMessage,
    suspended: {
      callIds: suspendedCalls.map((entry) => entry.callId),
      ...(reason === undefined ? {} : { reason }),
    },
  };
}

// ---- runTurn：一个 turn 的完整 step 循环（终止条件同 docs/logic/engine/tech/core-sdk.md §4.8，未变） ----

export interface RunTurnOptions {
  model: LanguageModel;
  system: string | undefined;
  /** session 的持久账本，原地 push——runTurn 结束时调用方能直接看到更新后的历史。 */
  messages: RunkoUIMessage[];
  tools: Record<string, Tool>;
  maxTurnsPerRun: number;
  maxContextTokens: number | undefined;
  maxOutputTokens: number | undefined;
  fs: RunkoFS;
  session: { id: string; turn: number };
  signal: AbortSignal | undefined;
  onApproval: ApprovalPolicy | undefined;
  /** 人审通道（`ApprovalReviewer`，types.ts）——`review` 结果先产出请求 chunk 再 await 这个，见文件头"审批：三值 + 阻塞前显式产出"一节。 */
  onReview: ApprovalReviewer | undefined;
  onceMemory: OnceApprovalMemory;
  derivedData: DerivedDataCollector;
  getSkill?: (name: string) => SkillHandle;
  /** STEER-1：`session.ts` 持有的 turn 作用域 steer 队列排空器，返回已经构造好的 user `RunkoUIMessage[]`。 */
  drainSteers?: () => RunkoUIMessage[];
  /** telemetry 透传（`SessionTelemetry`，见 `runOneStep` 区块注释）——未注入时只剩 functionId 元数据，零行为差异。 */
  telemetry?: SessionTelemetry;
  /**
   * 恢复轮（`Session.settleAndRun`）：开场先结清这次悬空调用，再进入正常的 step 循环。
   * 不传就是普通轮。设计见挂起与恢复 · 技术方案 §5。
   */
  resume?: { callId: string; settlement: Settlement };
}

export async function* runTurn(opts: RunTurnOptions): AsyncGenerator<RunkoChunk, TurnResult> {
  // 恢复轮在开轮前就校验完：用错了直接抛，一个 chunk 都不出（`Session` 那层同样先查一遍，
  // 这里是给直接调 `runTurn` 的人兜底）。
  const resumeTarget = opts.resume === undefined ? undefined : resolveResumeTarget(opts.messages, opts.resume.callId, opts.resume.settlement);
  const turnStartedAt = Date.now();
  // 恢复轮往前多算一条：被改写的那条上一轮的消息，恢复时执行的工具 timing 在它里面。
  const turnMessagesStart = resumeTarget === undefined ? opts.messages.length : opts.messages.length - 1;
  const abortSignal = opts.signal ?? new AbortController().signal;
  let finalResponse = "";
  let usage: Usage = {};
  let contextCalibration = 1;
  let lastAssistantMessage: RunkoUIMessage | undefined;

  // Step 0（恢复轮）：先结清那次悬空调用。**不调模型**——恢复的第一步是执行（或拒绝、或填输出），
  // 模型要等看到结果才上场。所以模型在这一步里想改参数也无从改起：执行的就是账本里那条。
  if (resumeTarget !== undefined && opts.resume !== undefined) {
    lastAssistantMessage = resumeTarget.message;
    const resuspended = yield* settleResumedCall(
      {
        tools: opts.tools,
        session: opts.session,
        fs: opts.fs,
        abortSignal,
        onApproval: opts.onApproval,
        onReview: opts.onReview,
        onceMemory: opts.onceMemory,
        derivedData: opts.derivedData,
        getSkill: opts.getSkill,
        telemetry: opts.telemetry,
      },
      resumeTarget,
      opts.resume.settlement,
    );
    // 结清之后这条消息里还有悬空调用（一步里有多个同时挂起，或者刚结清的这个执行时又挂起了）：
    // **不能调模型**——还有不配对的 tool_use，provider 会 400。直接以 suspended 收尾，人答下一个
    // 再开一轮（技术方案 §5.2）。理由沿用：这次又挂起了就用这次的，否则沿用上一轮挂起时记下的。
    const remaining = pendingCallIds([resumeTarget.message]);
    if (remaining.length > 0) {
      const reason = resuspended?.reason ?? resumeTarget.message.metadata?.suspended?.reason;
      const suspended = { callIds: remaining, ...(reason === undefined ? {} : { reason }) };
      yield finalizeTurn({
        messages: opts.messages,
        lastAssistantMessage,
        turn: opts.session.turn, turnStartedAt, turnMessagesStart,
        usage,
        status: "suspended",
        suspended,
      });
      return { finalResponse, usage, suspended };
    }
  }

  for (let stepIndex = 1; stepIndex <= opts.maxTurnsPerRun; stepIndex++) {
    // Checkpoint 0（宿主中止，docs/logic/orchestration/tech/turn-abort.md §2）：**绝不开始新的一步**。
    // 一步*之内*的中止不靠这里——`abortSignal` 已经透传给 `streamText`（模型流被
    // 掐断、其 promise reject）与 `ToolContext.abortSignal`（工具自己收尾），两者
    // 都落进下面那个 catch，`abortSignal.aborted` 为真时同样归成
    // `code: "aborted"`；这里补的是 catch 覆盖不到的一种情形：工具执行被中止后
    // 本步是**正常收尾**的（"失败即 ExecResult"，工具不抛），于是循环会照常进入
    // 下一步、白打一次模型调用，直到那次调用因 already-aborted 才抛错停下。有了
    // 这个检查，停止时机就是 runko 自己的确定性行为（"下一步绝不开始"），不再
    // 依赖第三方库对已 abort signal 的处理细节，也不多花那一次调用。
    if (abortSignal.aborted) {
      const error: RunkoError = {
        code: "aborted",
        // 宿主给了理由就用它（见 `abortMessage`）——它比这句通用文案能解释得多。
        message: abortMessage(abortSignal, "Turn aborted by the host before this step began."),
      };
      yield finalizeTurn({ messages: opts.messages, lastAssistantMessage, turn: opts.session.turn, turnStartedAt, turnMessagesStart, usage, status: statusForError(error), error });
      return { finalResponse, usage };
    }

    // Checkpoint A：先 drain steer 队列再估算上下文，保证注入的消息计入预算。
    yield* drainSteerMessages(opts.drainSteers, opts.messages);

    if (opts.maxContextTokens !== undefined) {
      const estimated = estimateMessagesTokens(opts.messages, opts.system) * contextCalibration;
      if (estimated > opts.maxContextTokens) {
        const error: RunkoError = {
          code: "context_overflow",
          message: `Estimated context size (~${Math.round(estimated)} tokens) exceeds maxContextTokens (${opts.maxContextTokens}).`,
        };
        yield finalizeTurn({ messages: opts.messages, lastAssistantMessage, turn: opts.session.turn, turnStartedAt, turnMessagesStart, usage, status: statusForError(error), error });
        return { finalResponse, usage };
      }
    }

    // `runOneStep` pushes its placeholder assistant message onto `opts.messages`
    // as its very first mutation (before it ever `await`s/consumes `result.stream`,
    // where a `doStream` throw or an already-aborted signal actually surfaces) —
    // so if it throws, that placeholder can already be sitting in the ledger.
    // `ledgerLengthBeforeStep` lets the `catch` below tell "this failed step did
    // push one" from "it threw before ever pushing" (e.g. `convertToModelMessages`
    // itself throwing, or `maxTurnsPerRun <= 0` never calling `runOneStep` at all).
    const ledgerLengthBeforeStep = opts.messages.length;
    let stepOutcome: StepOutcome;
    try {
      const stepGen = runOneStep({
        model: opts.model,
        system: opts.system,
        ledger: opts.messages,
        tools: opts.tools,
        maxOutputTokens: opts.maxOutputTokens,
        session: opts.session,
        fs: opts.fs,
        abortSignal,
        onApproval: opts.onApproval,
        onReview: opts.onReview,
        onceMemory: opts.onceMemory,
        derivedData: opts.derivedData,
        getSkill: opts.getSkill,
        telemetry: opts.telemetry,
      });
      let next = await stepGen.next();
      while (!next.done) {
        yield next.value;
        next = await stepGen.next();
      }
      stepOutcome = next.value;
    } catch (error) {
      const runkoError: RunkoError = abortSignal.aborted
        ? // 这条路上 `error` 通常是 AI SDK 自己抛的 `AbortError`（"This operation was
          // aborted"）——宿主给了理由就优先用它，回落才是那句第三方措辞。
          { code: "aborted", message: abortMessage(abortSignal, describeError(error)) }
        : { code: "provider_error", message: describeError(error) };
      // 不能只靠 `lastAssistantMessage`——它
      // only ever assigned *after* `runOneStep` returns successfully (see below),
      // so on this failure path it's still whatever the *previous* step (or turn)
      // left it as, possibly `undefined`, even though the *current*, half-built
      // step already pushed its own placeholder assistant message onto the ledger
      // (see the comment above `ledgerLengthBeforeStep`). Blindly falling back to
      // `finalizeTurn`'s own placeholder-creation in that case produced a second,
      // orphaned, metadata-less assistant message — `finalizeTurn`'s own header
      // comment's invariant ("each turn lands metadata on exactly one assistant
      // message") broken by this file's own code.
      //
      // `partiallyBuiltAssistantMessage` (found by comparing the ledger length)
      // takes priority over `lastAssistantMessage` when both exist — it's this
      // *failing* step's own placeholder, strictly more specific/recent than
      // whatever a prior *successful* step in the same turn left `lastAssistantMessage`
      // pointing at; attaching the failure to that stale prior message instead
      // would leave the current step's placeholder orphaned just the same (only
      // multi-step turns that fail on step 2+ can reach this: `lastAssistantMessage`
      // is still `undefined` the first time any step in a turn fails, which is
      // the case the pinned regression tests exercise).
      const partiallyBuiltAssistantMessage =
        opts.messages.length > ledgerLengthBeforeStep ? opts.messages[opts.messages.length - 1] : undefined;
      if (partiallyBuiltAssistantMessage !== undefined) {
        yield* closeNeverRunCalls(partiallyBuiltAssistantMessage, runkoError.message);
      }
      yield finalizeTurn({
        messages: opts.messages,
        lastAssistantMessage: partiallyBuiltAssistantMessage ?? lastAssistantMessage,
        turn: opts.session.turn, turnStartedAt, turnMessagesStart,
        usage,
        status: statusForError(runkoError),
        error: runkoError,
      });
      return { finalResponse, usage };
    }

    lastAssistantMessage = stepOutcome.assistantMessage;
    usage = mergeUsage(usage, stepOutcome.usage);
    const stepText = collectMessageText(stepOutcome.assistantMessage);
    if (stepText !== "") {finalResponse = stepText;}

    // Checkpoint S（挂起，docs/logic/orchestration/tech/suspend-resume.md）：本步有调用停在
    // 「等人」上，本轮就此收尾——**必须拦在这里**。挂起时 finishReason 恒为 "tool-calls"，
    // 不拦就会往下走进 `continue`，拿着一份「有 tool_use、没有对应 tool_result」的历史去调
    // 模型，两家 provider 都会 400。
    //
    // **不 drain steer 队列**：那是「取出来就没了」的动作，而挂起不清空待发队列——排队的消息
    // 留给下一轮（恢复轮或新轮）自然消费。这与 `turn-abort` 的停止语义刻意不同，停止会清空。
    if (stepOutcome.suspended !== undefined) {
      yield finalizeTurn({
        messages: opts.messages,
        lastAssistantMessage,
        turn: opts.session.turn, turnStartedAt, turnMessagesStart,
        usage,
        status: "suspended",
        suspended: stepOutcome.suspended,
      });
      return { finalResponse, usage, suspended: stepOutcome.suspended };
    }

    if (opts.maxContextTokens !== undefined) {
      const rawEstimate = estimateMessagesTokens(opts.messages, opts.system);
      if (stepOutcome.usage.inputTokens !== undefined && rawEstimate > 0) {
        contextCalibration = stepOutcome.usage.inputTokens / rawEstimate;
      }
    }

    if (stepOutcome.finishReason !== "tool-calls") {
      // Checkpoint B：turn 即将收尾——先 drain，保证排队中的 steer 不被吞掉。
      const drainedAtFinish = yield* drainSteerMessages(opts.drainSteers, opts.messages);
      if (drainedAtFinish.length === 0) {
        yield finalizeTurn({ messages: opts.messages, lastAssistantMessage, turn: opts.session.turn, turnStartedAt, turnMessagesStart, usage, status: "completed" });
        return { finalResponse, usage };
      }
      if (stepIndex === opts.maxTurnsPerRun) {
        const error: RunkoError = {
          code: "max_turns",
          message:
            `Reached maxTurnsPerRun (${opts.maxTurnsPerRun}) — steer() queued a message after the model ` +
            "finished responding and it needs one more step to see it, but no steps remain.",
        };
        yield finalizeTurn({
          messages: opts.messages,
          lastAssistantMessage,
          turn: opts.session.turn, turnStartedAt, turnMessagesStart,
          usage,
          status: statusForError(error),
          error,
        });
        return { finalResponse, usage };
      }
      // 队列非空且还有步数预算——不收尾，让模型在下一步看到 steer 内容。
      continue;
    }

    // finishReason === "tool-calls"：本步全部工具调用已经在 runOneStep 内部
    // 结算完毕（settleToolCall 在 runOneStep 返回前跑完，账本里不会留下任何
    // "in_progress" 占位——即便下面判定预算耗尽，工具调用本身也已正常完成，
    // 不是"到达上限就拒绝执行最后一步的工具调用"，docs/logic/engine/tech/core-sdk.md §4.8 的既有语义
    // 保持不变，只是不再需要在这里另起一段"先执行完再判定"的特殊分支）。
    if (stepIndex === opts.maxTurnsPerRun) {
      // STEER-1F：预算耗尽、即将失败之前也要 drain 一次——工具执行期间
      // （settleToolCall 运行时）调用的 steer() 不能被这里静默吞掉。
      yield* drainSteerMessages(opts.drainSteers, opts.messages);
      const error: RunkoError = {
        code: "max_turns",
        message: `Reached maxTurnsPerRun (${opts.maxTurnsPerRun}) — the model still requested tool calls with no steps left.`,
      };
      yield finalizeTurn({
        messages: opts.messages,
        lastAssistantMessage,
        turn: opts.session.turn, turnStartedAt, turnMessagesStart,
        usage,
        status: statusForError(error),
        error,
      });
      return { finalResponse, usage };
    }
  }

  // 只在 `maxTurnsPerRun <= 0`（零/负预算，连第一步都不允许）时到达此处。
  yield* drainSteerMessages(opts.drainSteers, opts.messages);
  const error: RunkoError = {
    code: "max_turns",
    message: `maxTurnsPerRun (${opts.maxTurnsPerRun}) leaves no steps to run.`,
  };
  yield finalizeTurn({ messages: opts.messages, lastAssistantMessage, turn: opts.session.turn, turnStartedAt, turnMessagesStart, usage, status: statusForError(error), error });
  return { finalResponse, usage };
}
