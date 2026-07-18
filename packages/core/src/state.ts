/**
 * SessionState（P13-5-2，docs/tech/single-ledger.md §5 单-2）：会话恢复用
 * 的可序列化快照。`messages` 从 AI SDK 的 `ModelMessage[]` 换成 `NimboUIMessage[]`
 * ——"UIMessage 单账本"：loop 的工作状态与 session 的存档是同一份数据，每次调
 * 模型前用官方 `convertToModelMessages()` 现场推导 `ModelMessage[]`，不再单独
 * 存一份模型视图（docs/tech/single-ledger.md §0 TL;DR）。
 *
 * 本文件同时是 `NimboUIMessage`/`NimboChunk`（UIMessageChunk 词汇表，对
 * `NimboUIMessage` 实例化）的唯一定义点——`loop.ts`/`session.ts` 都从这里导入，
 * 不各自重新声明。
 */
import { z } from "zod";
import { validateUIMessages } from "ai";
import type { InferUIMessageChunk, UIMessage } from "ai";
import { jsonValueSchema, type JsonValue } from "./types.js";
import type { NimboError, Usage } from "./events.js";

// ============================================================================
// NimboMessageMetadata（docs/tech/single-ledger.md §5-2 目标架构 1）：
// assistant 收尾元数据（turn/usage/status/error）+ user 消息的 steer 标记。
// metadata 不参与 `convertToModelMessages()`（官方转换器天然丢弃 metadata），
// 因此这些字段只给宿主/界面看，模型永远看不到。
// ============================================================================

const usageMetadataSchema = z.object({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  totalTokens: z.number().optional(),
  cachedInputTokens: z.number().optional(),
});

const nimboErrorMetadataSchema = z.object({
  code: z.enum(["max_turns", "context_overflow", "provider_error", "aborted"]),
  message: z.string(),
});

/**
 * `status: 'completed' | 'failed' | 'interrupted'`——`'interrupted'` 对应
 * `NimboError.code === 'aborted'`（signal abort，宿主主动中断，不是模型/工具
 * 出错），其余三个 `NimboError.code`（max_turns/context_overflow/
 * provider_error）都归 `'failed'`——四态错误码折叠进三态 status 的映射见
 * `loop.ts` 的 `statusForError()`。
 */
export interface NimboMessageMetadata {
  turn?: number;
  usage?: Usage;
  status?: "completed" | "failed" | "interrupted";
  /** 全 turn 墙钟耗时（`runTurn` 入口到收尾，含每一步模型往返与工具执行）——`loop.ts` 的 `finalizeTurn` 统一落点写入，成功/失败/中断皆有。 */
  durationMs?: number;
  /**
   * 本轮工具执行的墙钟总耗时——取自本轮全部 `data-tool-timing` 部件的
   * `[executionStartedAt, completedAt]` **区间并集**（并行批重叠时段只计一次，
   * 保证恒 ≤ `durationMs`；简单相加在并行下会超过墙钟）。与 `durationMs`
   * 同落点写入；`durationMs - toolDurationMs` 即模型/agent 自身的时间。
   */
  toolDurationMs?: number;
  error?: NimboError;
  /** turn 进行中经 `Session.steer()` 注入的 user 消息标记（docs/tech/single-ledger.md §2.2a）。 */
  steered?: boolean;
}

export const nimboMessageMetadataSchema: z.ZodType<NimboMessageMetadata> = z.object({
  turn: z.number().optional(),
  usage: usageMetadataSchema.optional(),
  status: z.enum(["completed", "failed", "interrupted"]).optional(),
  durationMs: z.number().optional(),
  toolDurationMs: z.number().optional(),
  error: nimboErrorMetadataSchema.optional(),
  steered: z.boolean().optional(),
});

// ============================================================================
// NimboDataParts（docs/tech/single-ledger.md §5-2 目标架构 1 / §2.2b，deny 分支已转用 ai 原生审批
// 状态机，`data-approval` 因此作废——见 docs/tech/single-ledger.md §5 引言"§2.2b 相应条目作废"）：
// 五个 data 部件，类型名即 `data-file-change` 等。`tool-progress` 是
// transient——只在写入期经 `emitTransientDataPart`（loop.ts）分流出流，绝不
// 进 `UIMessage.parts`（docs/tech/single-ledger.md §4.1 发现 A：transient 是线协议 chunk 上的
// 属性，不是 `DataUIPart` 的字段，没有"先写后滤"这回事）。`tool-timing`
// 与之相反——是**持久**部件：工具起止时间戳随 `assistantMessage.parts` 一起
// 存档、随会话回放，不因刷新丢失（chat 界面据此渲染每个工具调用卡片的
// 启动/完成时间与耗时）。
// ============================================================================

const fileChangeDataSchema = z.object({
  changes: z.array(z.object({ path: z.string(), kind: z.enum(["add", "update", "delete"]) })),
});
export type FileChangeData = z.infer<typeof fileChangeDataSchema>;

const planUpdateDataSchema = z.object({
  items: z.array(z.object({ text: z.string(), completed: z.boolean() })),
});
export type PlanUpdateData = z.infer<typeof planUpdateDataSchema>;

const errorDataSchema = z.object({ message: z.string() });
export type ErrorData = z.infer<typeof errorDataSchema>;

const toolProgressDataSchema = z.object({ toolCallId: z.string(), text: z.string() });
export type ToolProgressData = z.infer<typeof toolProgressDataSchema>;

/**
 * 单个工具调用的时间戳（epoch ms）——`id` = `toolCallId`（每次调用各一条，
 * 同 id 覆盖，物化方式照 `plan-update` 先例，见 `loop.ts` 的
 * `upsertToolTimingPart`）。三个时刻对应调用的三段生命周期（loop 对同一步的
 * 多个调用默认**串行**结算，仅当整批全部 `Tool.readOnly` 时并行——见
 * `runOneStep` 的 settle 分支；串行批的排队因此真实存在，并行批的
 * `executionStartedAt` 则几乎同刻）：
 *
 * - `startedAt`：调用成形、进入排队/审批管线（`tool-input-available` 产出后
 *   立刻打点）。同一步的多个调用几乎同刻拿到这个戳。
 * - `executionStartedAt`：真正开始执行（`executeToolCall` 前一刻）——排队与
 *   审批等待都已结束。**缺席 = 从未执行**：还在排队/等审批（结合部件状态
 *   判定），或被 deny/一轮中途崩溃永远轮不到。界面展示的"启动时间/耗时"
 *   以它为准（2026-07-16 定案：耗时 = 真实执行时长，不含排队与审批等待；
 *   排队/审批等了多久由 `startedAt` 与 server 日志的 queueMs 承担）。
 * - `completedAt`：结算（output-available / output-error / output-denied，含
 *   审批 deny）时补上；若一轮中途崩溃、没走到结算，`completedAt` 就一直缺席
 *   ——这是可接受的残留态，不是 bug。
 */
const toolTimingDataSchema = z.object({
  toolCallId: z.string(),
  startedAt: z.number(),
  executionStartedAt: z.number().optional(),
  completedAt: z.number().optional(),
});
export type ToolTimingData = z.infer<typeof toolTimingDataSchema>;

/**
 * `type`（非 `interface`）是刻意的：ai 的 `UIDataTypes`（`Record<string,
 * unknown>`）约束要求实参结构性地满足"带字符串索引签名"——`interface` 声明
 * 即便字段形状完全兼容也不会被 TS 判定为满足这个约束（`interface` 与
 * `Record<string,T>` 之间这条已知的结构检查差异），改成 `type` 字面量对象
 * 类型即可，字段集合、精确度不变（不需要显式加一条会放宽未知键的索引签名）。
 */
export type NimboDataParts = {
  "file-change": FileChangeData;
  "plan-update": PlanUpdateData;
  error: ErrorData;
  "tool-progress": ToolProgressData;
  "tool-timing": ToolTimingData;
};

/** `validateUIMessages()`/`safeValidateUIMessages()` 的 `dataSchemas`——按 data 部件名索引。 */
export const nimboDataPartSchemas: { [NAME in keyof NimboDataParts & string]: z.ZodType<NimboDataParts[NAME]> } = {
  "file-change": fileChangeDataSchema,
  "plan-update": planUpdateDataSchema,
  error: errorDataSchema,
  "tool-progress": toolProgressDataSchema,
  "tool-timing": toolTimingDataSchema,
};

// ============================================================================
// NimboUIMessage / NimboChunk（docs/tech/single-ledger.md §5-2 目标架构 1/2）
// ============================================================================

/**
 * TOOLS 类型参数刻意留默认（`UITools` = `Record<string, {input:unknown,
 * output:unknown|undefined}>`）——nimbo 的工具集在编译期是完全动态的
 * （`AgentDefinition.tools?: Record<string, Tool>`，运行时才知道有哪些
 * 工具名，见 `types.ts` 的 `Tool`/`agent.ts` 的 `AgentDefinition.tools`），
 * 没有一个编译期已知的字面量工具名联合可供 `UITools` 精确刻画——这与
 * `model/convert.ts` 的 `convertTool()`/`ToolSet`（同样只能落到"擦除后的
 * 通用工具"）是同一个既有约束，不是本文件新引入的缺口。产生的后果（工具
 * 部件的 `input`/`output` 落在 `unknown`）已按本仓"受控例外"惯例在这里
 * 集中记录一次，不逐处重复。
 */
export type NimboUIMessage = UIMessage<NimboMessageMetadata, NimboDataParts>;

/** ai 的 `UIMessageChunk` 词汇表，对 `NimboUIMessage` 实例化——`session.stream()` 的产出类型。 */
export type NimboChunk = InferUIMessageChunk<NimboUIMessage>;

// ============================================================================
// SessionState + envelope 级 zod 校验（§4.8）：`messages` 深层校验（part/
// metadata/data 部件的具体形状）交给 `validateSessionMessages()`（ai 的
// `validateUIMessages()`，异步）——zod 在这里只做"结构没坏"的浅层判别（同
// `isModelMessage` 此前的既有分工：挡的是"反序列化出来的值长得像不像"，不是
// 重新实现 ai 包的类型系统）。
// ============================================================================

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const UI_MESSAGE_ROLES = new Set(["system", "user", "assistant"]);

/**
 * 浅层结构判别（非深层语义校验，理由见上）：`id` 是字符串、`role` 是三种
 * 合法值之一、`parts` 是数组且每个元素至少有一个字符串 `type` 字段——不深入
 * 校验每种 part 各自的字段形状（那正是 `validateUIMessages()` 的职责）。
 */
function isUIMessageShape(value: unknown): value is NimboUIMessage {
  if (!isRecord(value)) return false;
  const { id, role, parts } = value;
  if (typeof id !== "string") return false;
  if (typeof role !== "string" || !UI_MESSAGE_ROLES.has(role)) return false;
  if (!Array.isArray(parts)) return false;
  return parts.every((part) => isRecord(part) && typeof part.type === "string");
}

const nimboUIMessageEnvelopeSchema: z.ZodType<NimboUIMessage> = z.custom<NimboUIMessage>(isUIMessageShape, {
  message:
    "invalid NimboUIMessage: expected { id: string, role: 'system'|'user'|'assistant', parts: array } — " +
    "deep part/metadata/data-part validation happens via validateSessionMessages() (ai's validateUIMessages()), not this envelope-level check.",
});

export interface SessionState {
  id: string;
  turn: number;
  messages: NimboUIMessage[];
  createdAt: number;
  fsSnapshot?: JsonValue;
}

export const sessionStateSchema: z.ZodType<SessionState> = z.object({
  id: z.string(),
  turn: z.number(),
  messages: z.array(nimboUIMessageEnvelopeSchema),
  createdAt: z.number(),
  fsSnapshot: jsonValueSchema.optional(),
});

/**
 * 恢复校验的深层通路（docs/tech/single-ledger.md §5-2 目标架构 1"恢复校验：用 ai@7 的
 * validateUIMessages 替代现在的 ModelMessage 结构判别"）：`raw` 通常是
 * `sessionStateSchema` 校验后的 `SessionState.messages`（已经过上面的浅层
 * 判别），这里再用 ai 官方校验器做深层语义校验（metadata 形状、data 部件
 * 形状、工具部件状态机形状）并按 `NimboUIMessage` 收窄返回——失败时 reject
 * （`validateUIMessages()` 的既有语义：不合法即 throw），调用方（`session.ts`
 * 的 resume 路径）据此决定如何降级/报错。
 */
export async function validateSessionMessages(raw: unknown): Promise<NimboUIMessage[]> {
  return validateUIMessages<NimboUIMessage>({
    messages: raw,
    // `validateUIMessages()`/`safeValidateUIMessages()` 对每条消息的 metadata
    // 无条件校验，哪怕该消息压根没有 metadata 字段（即 undefined）——单独
    // `.optional()` 一份只给这次调用用，不改 `nimboMessageMetadataSchema`
    // 本身对 `NimboMessageMetadata` 的类型推导（同 examples/13 的既有写法）。
    metadataSchema: nimboMessageMetadataSchema.optional(),
    dataSchemas: nimboDataPartSchemas,
  });
}
