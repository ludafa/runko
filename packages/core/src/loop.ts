/**
 * L2 运行层：单个 turn 的 step 循环 `runTurn`（docs/tech/single-ledger.md
 * §5 单-2，"UIMessage 单账本"迁移）。session.ts 拥有跨 turn 的持久状态
 * （messages/turn 计数/readState/onceMemory/planStore），本文件只负责"给定
 * 当前账本，把一个 turn 跑到底"——工作态是 `NimboUIMessage[]`（不再是
 * `ModelMessage[]`），每步调模型前用 ai 官方 `convertToModelMessages()` 现场
 * 推导，loop 自己不再手拼任何 `ModelMessage`（docs/tech/single-ledger.md §0 TL;DR）。
 *
 * ---- 与迁移前的对应关系（语义映射表，供 tester / P13-5-3 参考） ----
 *
 * | 旧（SessionEvent/SessionItem，已退役） | 新 |
 * |---|---|
 * | `session.started` | 不需要部件/chunk（session.ts 不再发它，见其文件头） |
 * | `turn.started` | 不需要部件/chunk（turn 边界由调用方发起 `stream()` 本身体现） |
 * | `item.started/updated/completed`（`agent_message`） | `text-start`/`text-delta`/`text-end` chunk + `TextUIPart` |
 * | `item.started/updated/completed`（`reasoning`） | `reasoning-start`/`reasoning-delta`/`reasoning-end` chunk + `ReasoningUIPart` |
 * | `item.started/updated/completed`（`user_message`，steer） | `start`/`text-*`/`finish` chunk + 一条 `metadata.steered=true` 的 user `NimboUIMessage`（见 `drainSteerMessages`） |
 * | `item.started/updated/completed`（`tool_call`，in_progress/completed/failed） | `tool-input-available` → `tool-output-available`/`tool-output-error` chunk + 工具部件（同一 toolCallId 原地覆盖，只记结算态——docs/tech/single-ledger.md §4.1 实现教训） |
 * | `item.started/updated/completed`（`tool_call`，denied，无 review） | `tool-input-available` → `tool-output-denied` chunk：`deny` 结果直接拒绝，不经审批请求/响应（docs/tech/single-ledger.md §6.1"deny：直接拒绝，output-denied"，P13-5-2c） |
 * | `item.started/updated/completed`（`tool_call`，review） | `tool-input-available` → `tool-approval-request`（先产出，见下）→ `await` 人审通道 → `tool-approval-response`（allow/deny 都发）→ `tool-output-available`/`tool-output-error`/`tool-output-denied` chunk + 工具部件状态迁移（ai 原生审批状态机字段形状，P13-5-2c 重构） |
 * | `item.completed`（`file_change`） | `data-file-change` chunk + 部件（每次工具执行各一条，不 upsert） |
 * | `item.completed`（`plan_update`） | `data-plan-update` chunk + 部件（同 id 覆盖，见 `upsertPlanUpdatePart`） |
 * | `item.completed`（`error`） | `data-error`（本文件当前无实际生产者，同旧实现——旧 `SessionItem.error` 变体此前也从未被 loop.ts 实际产出过，见 `state.ts`/`events.ts` 头注释） |
 * | `ctx.update()` 进度 | `data-tool-progress` chunk，**transient：只出流不物化**（docs/tech/single-ledger.md §4.1 发现 A，见 `settleToolCall`） |
 * | （新增，无旧对应）工具时间戳 | `data-tool-timing` chunk + **持久**部件（id = toolCallId，同 id 覆盖，见 `upsertToolTimingPart`）：`tool-input-available` 后立刻打 `startedAt`（入队），`executeToolCall` 前一刻打 `executionStartedAt`（真实执行起点；deny 路径恒缺席），每个结算 chunk（output-available/output-error/output-denied，含审批 deny）后立刻补 `completedAt`——三个时刻的语义见 `state.ts` 的 `toolTimingDataSchema` |
 * | `turn.completed`（`usage`） | `message-metadata` chunk，`messageMetadata: {turn, usage, status:'completed'}`，写在该轮最后一条 assistant 消息的 `.metadata` 上 |
 * | `turn.failed`（`error`） | 同上，`status: 'failed'`（`NimboError.code !== 'aborted'`）或 `'interrupted'`（`code === 'aborted'`）+ `error` |
 *
 * ---- 一个 nimbo step = 一条 assistant `NimboUIMessage`（裁量，见工单回报） ----
 *
 * single-ledger 参考实现（原 `examples/13-uimessage-single-ledger.e2e.test.ts`——已随
 * examples 梳理移除：其离线结构断言迁至
 * `apps/node-server/test/agent/uimessage-single-ledger.test.ts`，手写真机 loop 见 git 历史）里每次
 * `runOneStep` 都新建一条 assistant 消息 push 进账本，不是把多步折进一条消息
 * 用内部 `step-start` 分隔——`convertToModelMessages()` 按 `step-start` 分块产出
 * `assistant → tool → assistant → …` 的方式对两种账本组织完全等价（每条
 * 顶层 UIMessage 处理完都会 flush 一次未完成的 block，效果与消息内部
 * step-start 分块相同），因此本文件延续这个已证实的姿态：一次 `runOneStep`
 * 调用 = 账本里新增一条 assistant 消息。
 *
 * ---- 审批：三值 + 阻塞前显式产出（docs/tech/single-ledger.md §6，P13-5-2c 返工，取代 §5 引言
 * 定案的"事后补记"编码） ----
 *
 * P13-5-2 交付的版本把 `tool-approval-request` chunk 编码在"人已经做完决定
 * 之后"（`executeToolCall` 是原子调用，审批在其内部同步/异步 resolve 完才
 * 返回），导致挂起等人审期间直播流里没有待审批信号——客户端无法据此弹卡片，
 * 人在环上功能实质失效（docs/tech/single-ledger.md §6 引言）。本次返工把审批解析
 * （`resolveToolCallApproval`，runtime.ts）与工具执行（`executeToolCall`）
 * 拆成两个独立步骤（`settleToolCall` 下方），loop 在两者之间插入
 * "先 yield 审批请求 chunk、再 await 人工裁决"这一步：
 *
 *   1. `outcome = resolveToolCallApproval(...)`（`approval.ts` 的
 *      `evaluateApproval` 三值解析——`allow`/`review`/`deny`，两层组合语义
 *      不变，见该文件头注释）。
 *   2. `allow` → 直接 `executeToolCall` → `tool-output-available`/`-error`。
 *   3. `deny` → 不执行，直接 `tool-output-denied`（拒绝理由 = 无仲裁者指导
 *      文案或分类器 `deny` 的默认文案，回填模型）——不经过审批请求/响应
 *      chunk（docs/tech/single-ledger.md §6.1"deny：直接拒绝"，与旧实现"denied 恒三态编码"的
 *      关键差异）。
 *   4. `review` → **先** `assistantMessage.parts` 落 `approval-requested` +
 *      yield `tool-approval-request` chunk，**再** `await`
 *      `opts.onReview`（`ApprovalReviewer`，session 的人审通道，见
 *      `RunTurnOptions.onReview`/`types.ts`）拿到 `HumanDecision`——这个
 *      顺序（先产出、后阻塞）是本次返工要修的根本问题，也是这个函数体是
 *      `async function*`（而非 runtime.ts 里返回单个 `Promise` 的普通异步
 *      函数）能够做到、旧的原子 `executeToolCall` 做不到的事：generator 的
 *      `yield` 是一个真实的挂起点，消费方（`for await`）在这一刻已经能看到
 *      这个 chunk，而不必等这次 `await` 完全 resolve。`onReview` 未注入时
 *      （`SessionOptions` 没接人审通道）视同无仲裁者——直接按 `deny` +
 *      同一份指导文案处理，不产出请求 chunk（见 `settleToolCall` 顶部的
 *      `opts.onReview === undefined` 分支）。拿到裁决后 `allow`/`deny` 都
 *      yield 一次 `tool-approval-response`（`approved` 字段区分，deny 带
 *      `reason`），`allow` 才继续 `executeToolCall`；`review-once` 且人工
 *      `allow` 时调 `onceMemory.markApproved(toolName)`（`resolveToolCallApproval`
 *      的 `markOnceOnApprove` 字段决定要不要调，见 approval.ts 头注释"once
 *      记忆的标记时机"）。
 *
 * 工具部件状态字段形状沿用 ai@7 原生审批状态机（`approval-requested`/
 * `approval-responded`/`output-denied`，`ToolUIPart` 的判别联合，见
 * `node_modules/ai` 的 `UIToolInvocation` 类型）——只是这次真正做到"物化的
 * 状态迁移顺序 = 实际发生顺序"，不再是把三态编码事后拼出来。
 */
import { randomUUID } from "node:crypto";
import { convertToModelMessages, streamText } from "ai";
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
import type { NimboError, Usage } from "./events.js";
import type {
  FileChangeData,
  NimboChunk,
  NimboMessageMetadata,
  NimboUIMessage,
  PlanUpdateData,
  ToolTimingData,
} from "./state.js";
import { jsonValueSchema } from "./types.js";
import type { ApprovalPolicy, ApprovalReviewer, JsonValue, NimboFS, SkillHandle, Tool, ToolReturn } from "./types.js";
import { convertTools } from "./model/convert.js";
import { executeToolCall, resolveToolCallApproval } from "./runtime.js";
import type { DerivedDataCollector, ToolCallResult } from "./runtime.js";
import { DEFAULT_DENY_MESSAGE, noArbiterDenyReason } from "./approval.js";
import type { OnceApprovalMemory } from "./approval.js";
import type { TurnResult } from "./session.js";

/**
 * `catch` 子句里从 `unknown` 安全窄化出可读消息——同款受控例外见
 * `runtime.ts`/`@nimbo/virtual-fs` 的 `describeError`：只用于这一处收窄。
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
  if (a === undefined && b === undefined) return undefined;
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
function estimateMessagesTokens(messages: NimboUIMessage[], system: string | undefined): number {
  let charCount = system?.length ?? 0;
  for (const message of messages) charCount += JSON.stringify(message).length;
  return Math.ceil(charCount / 4);
}

/** 一条 assistant 消息里全部 `text` 部件拼接（`TurnResult.finalResponse` 的来源，见 `runTurn`）。 */
function collectMessageText(message: NimboUIMessage): string {
  let text = "";
  for (const part of message.parts) {
    if (part.type === "text") text += part.text;
  }
  return text;
}

/** `NimboError.code === "aborted"` 归 `"interrupted"`（宿主主动中断，非失败）；其余三个 code 归 `"failed"`。 */
function statusForError(error: NimboError): "failed" | "interrupted" {
  return error.code === "aborted" ? "interrupted" : "failed";
}

function appendPlaceholderAssistantMessage(messages: NimboUIMessage[]): NimboUIMessage {
  const placeholder: NimboUIMessage = { id: randomUUID(), role: "assistant", parts: [{ type: "step-start" }] };
  messages.push(placeholder);
  return placeholder;
}

/**
 * 本轮工具执行的墙钟总耗时（`NimboMessageMetadata.toolDurationMs`，语义见
 * state.ts）：收集给定消息里全部已执行完的 `data-tool-timing` 部件的
 * `[executionStartedAt, completedAt]` 区间，按起点排序后合并重叠再求和——
 * 全只读批并行结算时多个调用同时在跑，简单相加会把重叠时段重复计入、
 * 甚至超过整轮墙钟；区间并集才是"这段时间里有工具在执行"的真实时长。
 */
function toolExecutionWallMs(messages: NimboUIMessage[]): number {
  const intervals: { start: number; end: number }[] = [];
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "data-tool-timing") continue;
      const { executionStartedAt, completedAt } = part.data;
      if (executionStartedAt === undefined || completedAt === undefined) continue;
      intervals.push({ start: executionStartedAt, end: completedAt });
    }
  }
  intervals.sort((a, b) => a.start - b.start);
  let total = 0;
  let currentEnd = Number.NEGATIVE_INFINITY;
  for (const { start, end } of intervals) {
    if (end <= currentEnd) continue;
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
 * `NimboSessionError`，见 session.ts）。`durationMs` 在这里由
 * `turnStartedAt`（`runTurn` 入口的墙钟）现算——收尾路径唯一，全 turn 耗时
 * 因此天然覆盖成功/失败/中断所有出口。
 */
function finalizeTurn(opts: {
  messages: NimboUIMessage[];
  lastAssistantMessage: NimboUIMessage | undefined;
  turn: number;
  turnStartedAt: number;
  /** `runTurn` 入口时 `opts.messages` 的长度——本轮新增的消息从这里开始切片，`toolDurationMs` 只统计本轮的 timing 部件。 */
  turnMessagesStart: number;
  usage: Usage;
  status: "completed" | "failed" | "interrupted";
  error?: NimboError;
}): NimboChunk {
  const durationMs = Date.now() - opts.turnStartedAt;
  const toolDurationMs = toolExecutionWallMs(opts.messages.slice(opts.turnMessagesStart));
  const metadata: NimboMessageMetadata =
    opts.error === undefined
      ? { turn: opts.turn, usage: opts.usage, status: opts.status, durationMs, toolDurationMs }
      : { turn: opts.turn, usage: opts.usage, status: opts.status, durationMs, toolDurationMs, error: opts.error };
  const target = opts.lastAssistantMessage ?? appendPlaceholderAssistantMessage(opts.messages);
  target.metadata = target.metadata === undefined ? metadata : { ...target.metadata, ...metadata };
  return { type: "message-metadata", messageMetadata: metadata };
}

// ---- steer（STEER-1）：turn 进行中经 `Session.steer()` 排队的 user 消息 ----

/**
 * `opts.drainSteers` 排空到 `messages`，为每条已经构造好的 `NimboUIMessage`
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
  drainSteers: (() => NimboUIMessage[]) | undefined,
  messages: NimboUIMessage[],
): AsyncGenerator<NimboChunk, NimboUIMessage[]> {
  if (drainSteers === undefined) return [];
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
 * 表达式的标准推导，不需要 `as`），与 `ToolUIPart<UITools>`（`NimboUIMessage`
 * 的 TOOLS 类型参数取默认值 `UITools`，理由见 `state.ts` 的 `NimboUIMessage`
 * 头注释）的判别字段精确匹配，因此本节全部构造函数都不需要类型断言。
 */
type NimboToolPart = ToolUIPart<UITools>;

function inputAvailablePart(toolName: string, toolCallId: string, input: JsonValue): NimboToolPart {
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
): NimboToolPart {
  return { type: `tool-${toolName}`, toolCallId, state: "output-available", input, output, approval };
}

/** `approval` 同 `outputAvailablePart`——ai@7 的类型把 `output-error` 态的 `approval.approved` 钉死为字面量 `true`（这一态永远不会是"因被拒绝而失败"，拒绝有自己的 `output-denied` 态）。 */
function outputErrorPart(
  toolName: string,
  toolCallId: string,
  input: JsonValue | undefined,
  errorText: string,
  approval?: { id: string; approved: true },
): NimboToolPart {
  return { type: `tool-${toolName}`, toolCallId, state: "output-error", input, errorText, approval };
}

function approvalRequestedPart(toolName: string, toolCallId: string, input: JsonValue, approvalId: string): NimboToolPart {
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
): NimboToolPart {
  return { type: `tool-${toolName}`, toolCallId, state: "approval-responded", input, approval: { id: approvalId, approved, reason } };
}

function outputDeniedPart(
  toolName: string,
  toolCallId: string,
  input: JsonValue,
  approvalId: string,
  reason: string,
): NimboToolPart {
  return {
    type: `tool-${toolName}`,
    toolCallId,
    state: "output-denied",
    input,
    approval: { id: approvalId, approved: false, reason },
  };
}

// ---- data 部件（file-change：每次工具执行各一条；plan-update：同 id 覆盖） ----

function pushFileChangePart(message: NimboUIMessage, id: string, data: FileChangeData): DataUIPart<{ "file-change": FileChangeData }> {
  const part: DataUIPart<{ "file-change": FileChangeData }> = { type: "data-file-change", id, data };
  message.parts.push(part);
  return part;
}

const PLAN_UPDATE_ID = "plan-update";

function upsertPlanUpdatePart(message: NimboUIMessage, data: PlanUpdateData): DataUIPart<{ "plan-update": PlanUpdateData }> {
  const part: DataUIPart<{ "plan-update": PlanUpdateData }> = { type: "data-plan-update", id: PLAN_UPDATE_ID, data };
  const index = message.parts.findIndex((p) => p.type === "data-plan-update" && "id" in p && p.id === PLAN_UPDATE_ID);
  if (index === -1) message.parts.push(part);
  else message.parts[index] = part;
  return part;
}

// ---- data-tool-timing（持久部件，工具起止时间戳；docs/tech/single-ledger.md §2.2b 之后
// 补充，state.ts 的 `toolTimingDataSchema` 头注释有完整语义）：id = toolCallId，
// 同 id 覆盖，物化方式照 `upsertPlanUpdatePart` 先例，唯一差别是每个工具调用
// 各一个 id（不是单例）。----

function upsertToolTimingPart(message: NimboUIMessage, data: ToolTimingData): DataUIPart<{ "tool-timing": ToolTimingData }> {
  const part: DataUIPart<{ "tool-timing": ToolTimingData }> = { type: "data-tool-timing", id: data.toolCallId, data };
  const index = message.parts.findIndex((p) => p.type === "data-tool-timing" && "id" in p && p.id === data.toolCallId);
  if (index === -1) message.parts.push(part);
  else message.parts[index] = part;
  return part;
}

function findToolTimingPart(message: NimboUIMessage, toolCallId: string): DataUIPart<{ "tool-timing": ToolTimingData }> | undefined {
  return message.parts.find(
    (part): part is DataUIPart<{ "tool-timing": ToolTimingData }> => part.type === "data-tool-timing" && "id" in part && part.id === toolCallId,
  );
}

/** `tool-input-available` 之后立刻打点：调用成形、进入排队/审批管线的时刻——不是执行起点（那是 `executionStartedAt`），三个时刻的分工见 state.ts 的 `toolTimingDataSchema` 头注释。 */
function startToolTiming(message: NimboUIMessage, toolCallId: string): NimboChunk {
  const part = upsertToolTimingPart(message, { toolCallId, startedAt: Date.now() });
  return { type: "data-tool-timing", id: part.id, data: part.data };
}

/**
 * `executeToolCall` 前一刻打点：排队/审批都已结束、真正要执行了——deny 路径
 * 永远不经过这里，其部件因此恒无 `executionStartedAt`（"缺席 = 从未执行"，
 * state.ts）。`startedAt` 读回已物化的部件，缺失兜底同 `completeToolTiming`。
 */
function markToolExecutionStart(message: NimboUIMessage, toolCallId: string): NimboChunk {
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
function completeToolTiming(message: NimboUIMessage, toolCallId: string): NimboChunk {
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
async function* mergeSettleStreams(streams: AsyncGenerator<NimboChunk, void>[]): AsyncGenerator<NimboChunk, void> {
  const queue: NimboChunk[] = [];
  let running = streams.length;
  let failure: { error: unknown } | undefined;
  let wake: (() => void) | undefined;
  const notify = (): void => {
    wake?.();
    wake = undefined;
  };
  for (const stream of streams) {
    void (async () => {
      try {
        for await (const chunk of stream) {
          queue.push(chunk);
          notify();
        }
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
  if (failure !== undefined) throw failure.error;
}

// ---- 单个工具调用的结算（审批→执行→部件/chunk 编码，见文件头"审批：三值 + 阻塞前显式产出"） ----

interface PendingToolCall {
  toolCallId: string;
  toolName: string;
  input: JsonValue;
  /** `assistantMessage.parts` 里 input-available 占位部件的下标——结算时原地替换，不新增数组项（docs/tech/single-ledger.md §4.1 实现教训：占位+结算双记会被服务商 400）。 */
  partIndex: number;
}

interface SettleToolCallOptions {
  call: PendingToolCall;
  assistantMessage: NimboUIMessage;
  tools: Record<string, Tool>;
  session: { id: string; turn: number };
  fs: NimboFS;
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

// ---- 工具执行遥测（补发）：nimbo 的 loop 自己结算工具，AI SDK 没有机会触发
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
      if (result !== undefined) void Promise.resolve(result).catch(() => {});
    } catch {
      // 遥测永不影响 turn。
    }
  }
}

function notifyToolExecutionStart(opts: SettleToolCallOptions, input: JsonValue): void {
  if (opts.telemetry === undefined) return;
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
  if (opts.telemetry === undefined) return;
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
 * 第 2 步（`runtime.ts` 的 `executeToolCall`）+ 落 output 部件/chunk + 派生数据
 * chunk——`allow` 快速路径与 `review` 人工批准之后共用这一段尾巴，`approval`
 * 非空时（后者）把 `{id, approved:true}` 带进 output 部件（见
 * `outputAvailablePart`/`outputErrorPart` 注释），前者不带（`undefined`）。
 */
async function* settleExecution(
  opts: SettleToolCallOptions,
  tool: Tool,
  input: JsonValue,
  approval: { id: string; approved: true } | undefined,
): AsyncGenerator<NimboChunk, void> {
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
  // （docs/tech/single-ledger.md §4.1 发现 A）。`ctx.update()` 是同步回调，生成器不能从回调内部
  // yield，因此先缓冲、`executeToolCall` resolve 后按到达顺序重放——效果是
  // "进度确实以 chunk 到达"，但不与执行过程严格实时交错（P13-1 既有取舍，
  // 迁移前的 `executeStepToolCalls` 就是这个姿态，原样保留）。`text` 字段是
  // 累积文本（docs/tech/single-ledger.md §2.2b"text（累积）"）。
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

  if (result.derived.changes.length > 0) {
    const data: FileChangeData = { changes: result.derived.changes };
    const id = `file-change-${call.toolCallId}`;
    const part = pushFileChangePart(assistantMessage, id, data);
    yield { type: "data-file-change", id: part.id, data: part.data };
  }
  if (result.derived.items !== undefined) {
    const part = upsertPlanUpdatePart(assistantMessage, { items: result.derived.items });
    yield { type: "data-plan-update", id: part.id, data: part.data };
  }
}

/**
 * 单个工具调用的结算——第 1 步（审批解析）+（`review` 时）先产出后阻塞的人工
 * 裁决 + 第 2 步（执行），逐段说明见文件头"审批：三值 + 阻塞前显式产出"一节。
 */
async function* settleToolCall(opts: SettleToolCallOptions): AsyncGenerator<NimboChunk, void> {
  const { call, assistantMessage } = opts;
  const tool = opts.tools[call.toolName];

  if (tool === undefined) {
    const errorText = `Unknown tool "${call.toolName}" — it is not registered in this session's tool set. Only call tools that were offered.`;
    assistantMessage.parts[call.partIndex] = outputErrorPart(call.toolName, call.toolCallId, call.input, errorText);
    yield { type: "tool-output-error", toolCallId: call.toolCallId, errorText };
    yield completeToolTiming(assistantMessage, call.toolCallId);
    return;
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
    return;
  }

  if (approval.status === "deny") {
    assistantMessage.parts[call.partIndex] = outputDeniedPart(call.toolName, call.toolCallId, call.input, call.toolCallId, approval.reason);
    yield { type: "tool-output-denied", toolCallId: call.toolCallId };
    yield completeToolTiming(assistantMessage, call.toolCallId);
    return;
  }

  if (approval.status === "allow") {
    yield* settleExecution(opts, tool, approval.input, undefined);
    return;
  }

  // approval.status === "review"：先产出请求 chunk，再 await 人审通道——
  // 这是本次返工要修的顺序，理由见文件头。未接人审通道时视同无仲裁者，
  // 不产出请求 chunk（没人能回应它）。
  if (opts.onReview === undefined) {
    const reason = noArbiterDenyReason(call.toolName);
    assistantMessage.parts[call.partIndex] = outputDeniedPart(call.toolName, call.toolCallId, approval.input, call.toolCallId, reason);
    yield { type: "tool-output-denied", toolCallId: call.toolCallId };
    yield completeToolTiming(assistantMessage, call.toolCallId);
    return;
  }

  assistantMessage.parts[call.partIndex] = approvalRequestedPart(call.toolName, call.toolCallId, approval.input, call.toolCallId);
  yield { type: "tool-approval-request", approvalId: call.toolCallId, toolCallId: call.toolCallId };

  const decision = await opts.onReview({
    toolName: call.toolName,
    input: approval.input,
    ctx: { toolName: call.toolName, callId: call.toolCallId, session: opts.session },
  });

  if (decision.behavior === "deny") {
    const reason = decision.message ?? DEFAULT_DENY_MESSAGE;
    assistantMessage.parts[call.partIndex] = approvalRespondedPart(
      call.toolName,
      call.toolCallId,
      approval.input,
      call.toolCallId,
      false,
      reason,
    );
    yield { type: "tool-approval-response", approvalId: call.toolCallId, approved: false, reason };

    assistantMessage.parts[call.partIndex] = outputDeniedPart(call.toolName, call.toolCallId, approval.input, call.toolCallId, reason);
    yield { type: "tool-output-denied", toolCallId: call.toolCallId };
    yield completeToolTiming(assistantMessage, call.toolCallId);
    return;
  }

  if (approval.markOnceOnApprove) opts.onceMemory.markApproved(call.toolName);

  assistantMessage.parts[call.partIndex] = approvalRespondedPart(call.toolName, call.toolCallId, approval.input, call.toolCallId, true);
  yield { type: "tool-approval-response", approvalId: call.toolCallId, approved: true };

  yield* settleExecution(opts, tool, approval.input, { id: call.toolCallId, approved: true });
}

// ---- 单步：一次 `streamText` = 账本里新增一条 assistant 消息（见文件头） ----

export interface StepOutcome {
  finishReason: FinishReason;
  usage: LanguageModelUsage;
  assistantMessage: NimboUIMessage;
}

/**
 * session 级 telemetry 透传（ai@7 已转正的 `Telemetry` 事件集成接口，
 * `streamText` 的 `telemetry.integrations`）：宿主注入集成对象接收模型调用
 * 生命周期事件（每步 start/end、每次 model call 的 usage/performance 等）。
 * 关联键不由宿主管——`runOneStep` 恒在 `telemetry.functionId` 注入
 * `"<sessionId>#<turn>"`，每个事件都自带（ai 的 `InferTelemetryEvent` 把
 * TelemetryOptions 字段并进事件），集成端按它归档/查询。注意：nimbo 的工具
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
  ledger: NimboUIMessage[];
  tools: Record<string, Tool>;
  maxOutputTokens: number | undefined;
  session: { id: string; turn: number };
  fs: NimboFS;
  abortSignal: AbortSignal;
  onApproval: ApprovalPolicy | undefined;
  onReview: ApprovalReviewer | undefined;
  onceMemory: OnceApprovalMemory;
  derivedData: DerivedDataCollector;
  getSkill: ((name: string) => SkillHandle) | undefined;
  telemetry: SessionTelemetry | undefined;
}

/**
 * `model/step.ts` 的 `runStep` 不复用（工单允许的"手工发块"路线，见 docs/tech/single-ledger.md §5
 * 单-2 工单原文"两条路线你按实现干净程度定"）：`runStep` 只转发四类增量块
 * （text-delta/reasoning-delta/tool-input-delta/tool-call），丢弃
 * text-start/text-end/reasoning-start/reasoning-end 等边界块——UIMessage 的
 * `TextUIPart`/`ReasoningUIPart` 需要这些边界来维护 `state:'streaming'|'done'`
 * 与 ai 官方 chunk 词汇表的 `text-start`/`text-end` 对应，因此本文件直接消费
 * `streamText()` 的 `result.stream`（同 `runStep` 内部一样是 `fullStream` 的
 * 非弃用别名），按 examples/13 `runOneStep` 的已验证姿态手工翻译。
 */
async function* runOneStep(opts: RunOneStepOptions): AsyncGenerator<NimboChunk, StepOutcome> {
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

  const assistantMessage: NimboUIMessage = { id: randomUUID(), role: "assistant", parts: [{ type: "step-start" }] };
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
        if (textPart !== undefined) textPart.text += part.text;
        yield { type: "text-delta", id: part.id, delta: part.text };
        break;
      }
      case "text-end": {
        const textPart = openText.get(part.id);
        if (textPart !== undefined) textPart.state = "done";
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
        if (reasoningPart !== undefined) reasoningPart.text += part.text;
        yield { type: "reasoning-delta", id: part.id, delta: part.text };
        break;
      }
      case "reasoning-end": {
        const reasoningPart = openReasoning.get(part.id);
        if (reasoningPart !== undefined) reasoningPart.state = "done";
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
  if (pending.length > 1 && pending.every((call) => opts.tools[call.toolName]?.readOnly === true)) {
    yield* mergeSettleStreams(pending.map((call) => settleToolCall(settleOptsFor(call))));
  } else {
    for (const call of pending) {
      yield* settleToolCall(settleOptsFor(call));
    }
  }

  yield { type: "finish", finishReason: finalStep.finishReason };
  return { finishReason: finalStep.finishReason, usage: finalStep.usage, assistantMessage };
}

// ---- runTurn：一个 turn 的完整 step 循环（终止条件同 docs/tech/core-sdk.md §4.8，未变） ----

export interface RunTurnOptions {
  model: LanguageModel;
  system: string | undefined;
  /** session 的持久账本，原地 push——runTurn 结束时调用方能直接看到更新后的历史。 */
  messages: NimboUIMessage[];
  tools: Record<string, Tool>;
  maxTurnsPerRun: number;
  maxContextTokens: number | undefined;
  maxOutputTokens: number | undefined;
  fs: NimboFS;
  session: { id: string; turn: number };
  signal: AbortSignal | undefined;
  onApproval: ApprovalPolicy | undefined;
  /** 人审通道（`ApprovalReviewer`，types.ts）——`review` 结果先产出请求 chunk 再 await 这个，见文件头"审批：三值 + 阻塞前显式产出"一节。 */
  onReview: ApprovalReviewer | undefined;
  onceMemory: OnceApprovalMemory;
  derivedData: DerivedDataCollector;
  getSkill?: (name: string) => SkillHandle;
  /** STEER-1：`session.ts` 持有的 turn 作用域 steer 队列排空器，返回已经构造好的 user `NimboUIMessage[]`。 */
  drainSteers?: () => NimboUIMessage[];
  /** telemetry 透传（`SessionTelemetry`，见 `runOneStep` 区块注释）——未注入时只剩 functionId 元数据，零行为差异。 */
  telemetry?: SessionTelemetry;
}

export async function* runTurn(opts: RunTurnOptions): AsyncGenerator<NimboChunk, TurnResult> {
  const turnStartedAt = Date.now();
  const turnMessagesStart = opts.messages.length;
  const abortSignal = opts.signal ?? new AbortController().signal;
  let finalResponse = "";
  let usage: Usage = {};
  let contextCalibration = 1;
  let lastAssistantMessage: NimboUIMessage | undefined;

  for (let stepIndex = 1; stepIndex <= opts.maxTurnsPerRun; stepIndex++) {
    // Checkpoint A：先 drain steer 队列再估算上下文，保证注入的消息计入预算。
    yield* drainSteerMessages(opts.drainSteers, opts.messages);

    if (opts.maxContextTokens !== undefined) {
      const estimated = estimateMessagesTokens(opts.messages, opts.system) * contextCalibration;
      if (estimated > opts.maxContextTokens) {
        const error: NimboError = {
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
      const nimboError: NimboError = abortSignal.aborted
        ? { code: "aborted", message: describeError(error) }
        : { code: "provider_error", message: describeError(error) };
      // Bug fix (P13-5-2 返工): don't rely on `lastAssistantMessage` alone — it's
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
      yield finalizeTurn({
        messages: opts.messages,
        lastAssistantMessage: partiallyBuiltAssistantMessage ?? lastAssistantMessage,
        turn: opts.session.turn, turnStartedAt, turnMessagesStart,
        usage,
        status: statusForError(nimboError),
        error: nimboError,
      });
      return { finalResponse, usage };
    }

    lastAssistantMessage = stepOutcome.assistantMessage;
    usage = mergeUsage(usage, stepOutcome.usage);
    const stepText = collectMessageText(stepOutcome.assistantMessage);
    if (stepText !== "") finalResponse = stepText;

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
        const error: NimboError = {
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
    // 不是"到达上限就拒绝执行最后一步的工具调用"，docs/tech/core-sdk.md §4.8 的既有语义
    // 保持不变，只是不再需要在这里另起一段"先执行完再判定"的特殊分支）。
    if (stepIndex === opts.maxTurnsPerRun) {
      // STEER-1F：预算耗尽、即将失败之前也要 drain 一次——工具执行期间
      // （settleToolCall 运行时）调用的 steer() 不能被这里静默吞掉。
      yield* drainSteerMessages(opts.drainSteers, opts.messages);
      const error: NimboError = {
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
  const error: NimboError = {
    code: "max_turns",
    message: `maxTurnsPerRun (${opts.maxTurnsPerRun}) leaves no steps to run.`,
  };
  yield finalizeTurn({ messages: opts.messages, lastAssistantMessage, turn: opts.session.turn, turnStartedAt, turnMessagesStart, usage, status: statusForError(error), error });
  return { finalResponse, usage };
}
