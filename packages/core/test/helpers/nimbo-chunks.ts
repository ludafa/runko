/**
 * 测试专用辅助（P13-5-2/P13-5-5，docs/tech/single-ledger.md）：
 * `runTurn`/`Session.stream()` 现在产出 `NimboChunk`（ai 的 `UIMessageChunk`
 * 词汇表）而不是退役的 `SessionEvent`，"这个 turn/会话发生了什么" 现在读
 * 账本本身（`NimboUIMessage[]` 的部件/metadata）而不是一份平行的 item 列表
 * ——这里集中收纳跨 `loop.test.ts`/`steer.test.ts`/`session.test.ts`/
 * `load-skill.test.ts`/`integration.test.ts`/`e2e-minibash.test.ts` 复用的
 * 提取/断言辅助,不重复各自手写一遍同样的 chunk 过滤逻辑。
 */
import { isToolUIPart } from "ai";
import type { DataUIPart, ToolUIPart, UITools } from "ai";
import type {
  ErrorData,
  FileChangeData,
  NimboChunk,
  NimboUIMessage,
  PlanUpdateData,
  ToolProgressData,
  ToolTimingData,
} from "../../src/state.js";

/** 排空一个 `AsyncGenerator<NimboChunk, T>`，同时收集 chunk 序列与生成器的返回值。 */
export async function drainTurn<T>(gen: AsyncGenerator<NimboChunk, T>): Promise<{ chunks: NimboChunk[]; result: T }> {
  const chunks: NimboChunk[] = [];
  let next = await gen.next();
  while (!next.done) {
    chunks.push(next.value);
    next = await gen.next();
  }
  return { chunks, result: next.value };
}

/** 按 `type` 判别字段筛出某一种 chunk——精确到该变体的字段（`Extract`），不需要逐处重复类型收窄。 */
export function chunksOfType<T extends NimboChunk["type"]>(
  chunks: NimboChunk[],
  type: T,
): Extract<NimboChunk, { type: T }>[] {
  return chunks.filter((chunk): chunk is Extract<NimboChunk, { type: T }> => chunk.type === type);
}

/** 手写 `findLastIndex`——本仓 tsconfig 的 `lib` 锁定 ES2022，`Array.prototype.findLastIndex` 是 ES2023,不能直接用。 */
export function lastIndexOfChunkType(chunks: NimboChunk[], type: NimboChunk["type"]): number {
  for (let i = chunks.length - 1; i >= 0; i--) {
    if (chunks[i]?.type === type) return i;
  }
  return -1;
}

/** 构造一条最简单的纯文本 user `NimboUIMessage`——`runTurn` 单测直接摆进 `messages` 初始账本，不经过 `session.ts` 的 `toUserUIMessage`。 */
export function userTextMessage(id: string, text: string): NimboUIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

/** 一条消息里全部工具部件（`tool-<名字>` 类型，排除理论上不会出现的 `dynamic-tool`——loop.ts 只产出静态命名的工具部件）。 */
export function toolParts(message: NimboUIMessage): ToolUIPart<UITools>[] {
  const result: ToolUIPart<UITools>[] = [];
  for (const part of message.parts) {
    if (isToolUIPart<UITools>(part) && part.type !== "dynamic-tool") result.push(part);
  }
  return result;
}

/** 一条消息里全部工具部件，跨多条消息 flatMap（账本级查找，同一 toolCallId 理应只出现一次——见 docs/tech/single-ledger.md §4.1 实现教训）。 */
export function allToolParts(messages: NimboUIMessage[]): ToolUIPart<UITools>[] {
  return messages.flatMap(toolParts);
}

/**
 * 按 data 部件名筛出某条消息里的 data 部件——四个具名函数而非一个泛型函数：
 * `part.type === "data-file-change"` 这种字面量比较，TS 能沿判别联合把
 * `part` 收窄到对应的 `DataUIPart` 分支；同样的比较换成泛型 `NAME` 参数
 * （`` `data-${NAME}` ``）时 TS 无法跨四分支联合做这个收窄（已知的泛型判别
 * 联合收窄限制），只能靠类型断言绕过——本仓测试代码同样禁止类型断言，因此
 * 这里改为不需要断言的四个具名版本。
 */
export function fileChangeParts(message: NimboUIMessage): DataUIPart<{ "file-change": FileChangeData }>[] {
  return message.parts.filter(
    (part): part is DataUIPart<{ "file-change": FileChangeData }> => part.type === "data-file-change",
  );
}

export function planUpdateParts(message: NimboUIMessage): DataUIPart<{ "plan-update": PlanUpdateData }>[] {
  return message.parts.filter(
    (part): part is DataUIPart<{ "plan-update": PlanUpdateData }> => part.type === "data-plan-update",
  );
}

export function errorDataParts(message: NimboUIMessage): DataUIPart<{ error: ErrorData }>[] {
  return message.parts.filter((part): part is DataUIPart<{ error: ErrorData }> => part.type === "data-error");
}

export function toolProgressParts(message: NimboUIMessage): DataUIPart<{ "tool-progress": ToolProgressData }>[] {
  return message.parts.filter(
    (part): part is DataUIPart<{ "tool-progress": ToolProgressData }> => part.type === "data-tool-progress",
  );
}

/** `data-tool-timing`（持久部件，工具起止时间戳）——同上四个具名筛选器的姿态，理由同注释。 */
export function toolTimingParts(message: NimboUIMessage): DataUIPart<{ "tool-timing": ToolTimingData }>[] {
  return message.parts.filter(
    (part): part is DataUIPart<{ "tool-timing": ToolTimingData }> => part.type === "data-tool-timing",
  );
}

/** 账本级查找：某个 `toolCallId` 对应的 `data-tool-timing` 部件（跨消息扫描，upsert 的落点是"产出这次结算的那条消息"，调用方通常已经知道是哪条，但也提供跨账本版本省得重复写 flatMap）。 */
export function toolTimingPartFor(messages: NimboUIMessage[], toolCallId: string): ToolTimingData | undefined {
  for (const message of messages) {
    for (const part of toolTimingParts(message)) {
      if (part.id === toolCallId) return part.data;
    }
  }
  return undefined;
}

/** 账本里最后一条 assistant 消息（`finalizeTurn`/metadata 的落点）。 */
export function lastAssistantMessage(messages: NimboUIMessage[]): NimboUIMessage | undefined {
  return [...messages].reverse().find((message) => message.role === "assistant");
}

/**
 * 一条消息里全部 `text` 部件拼接（同 `loop.ts` 的 `collectMessageText`，测试
 * 侧独立实现，不 import src 的私有函数）。接受 `undefined`（`lastAssistantMessage`
 * 找不到时的返回值）并给回空串——调用方因此不需要非空断言。
 */
export function collectText(message: NimboUIMessage | undefined): string {
  let text = "";
  if (message === undefined) return text;
  for (const part of message.parts) {
    if (part.type === "text") text += part.text;
  }
  return text;
}

/** 一条消息里全部 `reasoning` 部件拼接，同上接受 `undefined`。 */
export function collectReasoning(message: NimboUIMessage | undefined): string {
  let text = "";
  if (message === undefined) return text;
  for (const part of message.parts) {
    if (part.type === "reasoning") text += part.text;
  }
  return text;
}

function assertNeverChunk(chunk: never): never {
  throw new Error(`unreachable NimboChunk variant: ${JSON.stringify(chunk)}`);
}

/**
 * 结构化指纹化一个 `NimboChunk`，丢掉随机 id（`messageId`/`toolCallId`/
 * `approvalId` 等——`loop.ts` 用 `randomUUID()` 生成，两次独立跑不会相等）
 * 只留语义内容——供"两条独立跑的 chunk 序列结构是否等价"这类比较使用
 * （`steer.test.ts` 的 drainSteers 等价类回归）。`switch` 覆盖 `NimboChunk`
 * 全部 32 个变体（同 `events.test.ts` 的 `describeChunk`，两处独立维护——
 * 都是"漏一个变体编译即炸"的防线，重复正是这个防线的意义所在）。
 *
 * `data-tool-timing` 同样丢掉具体的 `startedAt`/`completedAt` 数值——两者是
 * `Date.now()` 真实墙钟时间戳，两次独立跑不会相等，只留"是否已结算"这一
 * 形状信息（同 `fingerprintPart` 对 data 部件的同一处理，见下）。
 */
export function fingerprintChunk(chunk: NimboChunk): string {
  switch (chunk.type) {
    case "text-start":
      return "text-start";
    case "text-delta":
      return `text-delta:${chunk.delta}`;
    case "text-end":
      return "text-end";
    case "reasoning-start":
      return "reasoning-start";
    case "reasoning-delta":
      return `reasoning-delta:${chunk.delta}`;
    case "reasoning-end":
      return "reasoning-end";
    case "custom":
      return `custom:${chunk.kind}`;
    case "error":
      return `error:${chunk.errorText}`;
    case "tool-input-available":
      return `tool-input-available:${chunk.toolName}:${JSON.stringify(chunk.input)}`;
    case "tool-input-error":
      return `tool-input-error:${chunk.toolName}:${chunk.errorText}`;
    case "tool-approval-request":
      return "tool-approval-request";
    case "tool-approval-response":
      return `tool-approval-response:${String(chunk.approved)}:${chunk.reason ?? ""}`;
    case "tool-output-available":
      return `tool-output-available:${JSON.stringify(chunk.output)}`;
    case "tool-output-error":
      return `tool-output-error:${chunk.errorText}`;
    case "tool-output-denied":
      return "tool-output-denied";
    case "tool-input-start":
      return `tool-input-start:${chunk.toolName}`;
    case "tool-input-delta":
      return `tool-input-delta:${chunk.inputTextDelta}`;
    case "source-url":
      return `source-url:${chunk.url}`;
    case "source-document":
      return `source-document:${chunk.mediaType}`;
    case "file":
      return `file:${chunk.mediaType}`;
    case "reasoning-file":
      return `reasoning-file:${chunk.mediaType}`;
    case "data-file-change":
      return `data-file-change:${JSON.stringify(chunk.data)}`;
    case "data-plan-update":
      return `data-plan-update:${JSON.stringify(chunk.data)}`;
    case "data-error":
      return `data-error:${chunk.data.message}`;
    case "data-tool-progress":
      return `data-tool-progress:${chunk.data.text}:transient=${String(chunk.transient)}`;
    case "data-tool-timing":
      return `data-tool-timing:settled=${String(chunk.data.completedAt !== undefined)}`;
    case "start-step":
      return "start-step";
    case "finish-step":
      return "finish-step";
    case "start":
      return "start";
    case "finish":
      return `finish:${chunk.finishReason ?? ""}`;
    case "abort":
      return `abort:${chunk.reason ?? ""}`;
    case "message-metadata":
      return `message-metadata:${chunk.messageMetadata.status ?? ""}:${chunk.messageMetadata.error?.code ?? ""}`;
    default:
      return assertNeverChunk(chunk);
  }
}

/**
 * 一条 part 的轻量指纹（非穷尽性防线——仅供 `fingerprintMessage` 的结构比较
 * 使用，丢弃随机 toolCallId）。`data-tool-timing` 单独处理，排在通用 data-*
 * 分支之前——它的 `data` 携带真实 `Date.now()` 时间戳，两次独立跑不会相等
 * （同 `fingerprintChunk` 对这个 chunk 类型的同一处理），只保留"是否已结算"
 * 这一形状信息，不落到下面 `JSON.stringify(part.data)` 的通用分支。
 */
function fingerprintPart(part: NimboUIMessage["parts"][number]): string {
  if (part.type === "text") return `text:${part.text}`;
  if (part.type === "reasoning") return `reasoning:${part.text}`;
  if (part.type === "step-start") return "step-start";
  if (part.type === "file") return `file:${part.mediaType}`;
  if (part.type === "data-tool-timing") return `data-tool-timing:settled=${String(part.data.completedAt !== undefined)}`;
  if (part.type.startsWith("data-") && "data" in part) return `${part.type}:${JSON.stringify(part.data)}`;
  if ((part.type.startsWith("tool-") || part.type === "dynamic-tool") && "state" in part) {
    return `${part.type}:${part.state}`;
  }
  return part.type;
}

/** 结构化指纹化一条 `NimboUIMessage`，丢掉随机 `id`——role + parts + metadata(status/error/steered)。 */
export function fingerprintMessage(message: NimboUIMessage): string {
  return JSON.stringify({
    role: message.role,
    parts: message.parts.map(fingerprintPart),
    status: message.metadata?.status,
    error: message.metadata?.error,
    steered: message.metadata?.steered,
  });
}
