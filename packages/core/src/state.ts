/**
 * SessionState（tech-spec §4.8）：会话恢复用的可序列化快照。
 * messages 直接采用 AI SDK 的 ModelMessage（本身即 JSON 可序列化），
 * zod 校验后恢复；FS 默认不内联，内联时走 fsSnapshot。
 */
import { z } from "zod";
import type { ModelMessage } from "ai";
import { jsonValueSchema, type JsonValue } from "./types.js";

/**
 * ============================================================
 * 受控例外：本文件是本包里唯一允许出现 `unknown` 类型标注的地方。
 * ============================================================
 *
 * ai 的 ModelMessage 是 SystemModelMessage | UserModelMessage |
 * AssistantModelMessage | ToolModelMessage 四支判别联合，content 的
 * part 种类（text/image/file/reasoning/reasoning-file/custom/tool-call/
 * tool-result/tool-approval-request/tool-approval-response）十种以上，
 * 且部分字段类型（如 FilePart.data = DataContent | URL | ProviderReference，
 * DataContent 本身又是 string | Uint8Array | ArrayBuffer | Buffer）会随
 * ai 包大版本演进。逐字段用 zod 精确复刻这个联合体，既做不到与 ai 包
 * 长期结构同步（下个大版本新增一种 part 这里就会假阴性拒绝合法消息），
 * 收益也和 SessionState 反序列化真正要挡的问题不成比例。
 *
 * SessionState 的校验目标是"挡住结构损坏的持久化数据"（缺 role、content
 * 类型对不上、role 不在四个合法值内），不是重新实现 ai 包的类型系统——
 * 这正是 tech-spec §4.8 "messages 直接采用 ModelMessage，zod 校验后恢复"
 * 里"zod 校验"应有的范围。因此这里用 zod 官方支持的 `z.custom<T>` 模式：
 * 对外的类型标注仍是从 `ai` type-only import 的精确 ModelMessage（没有
 * as 桥接、没有向调用方泄漏放宽后的类型），只在这一小片"运行时怎么判断
 * 一个反序列化出来的值长得像不像 ModelMessage"的实现细节里使用 unknown
 * 作为类型守卫函数的入参——这是 TypeScript 官方推荐的类型守卫写法本身
 * 要求的（`(value: unknown) => value is T`），不是绕开类型系统的手段。
 */
type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isContentPart(value: unknown): value is UnknownRecord & { type: string } {
  return isRecord(value) && typeof value.type === "string";
}

function isPartArray(value: unknown, allowedTypes: ReadonlySet<string>): boolean {
  return Array.isArray(value) && value.every((part) => isContentPart(part) && allowedTypes.has(part.type));
}

const USER_CONTENT_PART_TYPES = new Set(["text", "image", "file"]);
const ASSISTANT_CONTENT_PART_TYPES = new Set([
  "text",
  "custom",
  "file",
  "reasoning",
  "reasoning-file",
  "tool-call",
  "tool-result",
  "tool-approval-request",
]);
const TOOL_CONTENT_PART_TYPES = new Set(["tool-result", "tool-approval-response"]);

function isModelMessage(value: unknown): value is ModelMessage {
  if (!isRecord(value)) return false;

  const { role, content } = value;
  if (typeof role !== "string") return false;

  switch (role) {
    case "system":
      return typeof content === "string";
    case "user":
      return typeof content === "string" || isPartArray(content, USER_CONTENT_PART_TYPES);
    case "assistant":
      return typeof content === "string" || isPartArray(content, ASSISTANT_CONTENT_PART_TYPES);
    case "tool":
      return isPartArray(content, TOOL_CONTENT_PART_TYPES);
    default:
      return false;
  }
}

/** ai 的 ModelMessage 联合体的结构级 zod 校验，范围与理由见上方受控例外说明。 */
export const modelMessageSchema: z.ZodType<ModelMessage> = z.custom<ModelMessage>(isModelMessage, {
  message: "invalid ModelMessage: role/content shape mismatch",
});

// ---- SessionState（§4.8） ----

export interface SessionState {
  id: string;
  turn: number;
  messages: ModelMessage[];
  createdAt: number;
  fsSnapshot?: JsonValue;
}

export const sessionStateSchema: z.ZodType<SessionState> = z.object({
  id: z.string(),
  turn: z.number(),
  messages: z.array(modelMessageSchema),
  createdAt: z.number(),
  fsSnapshot: jsonValueSchema.optional(),
});
