/**
 * L0 模型层：单步 `streamText` 封装 `runStep`（docs/logic/engine/tech/core-sdk.md §4.3 全节 / §4.8）。
 *
 * 「每个 assistant step 调一次 `streamText`，loop 归 runko」——这里**只做一步**：不设置
 * `stopWhen`（默认值就是 `isStepCount(1)`，见 AI SDK 文档），不做多步续跑、不做审批链、
 * 不执行工具。那些都是 L2 的 loop 的职责。
 *
 * `result.stream` 的增量块被映射成下面定义的 `StepEvent` 判别联合，供 loop 消费。
 *
 * 范围裁剪（两条实现取舍，都记在这里）：
 *
 * - **只映射四类增量块**：`text-delta`/`reasoning-delta`/`tool-input-delta`/`tool-call`。
 *   `text-start`/`text-end`/`reasoning-start`/`reasoning-end`/`tool-input-start`/
 *   `tool-input-end` 这些边界块一律忽略——单步的生命周期就是这个 async generator 的
 *   生命周期，调用方可以直接拿「生成器返回」当作这一步内所有条目的收尾时机，不需要
 *   逐条目的起止标记。
 * - **abort 不设专门的 `StepEvent` 分支。** AI SDK 的文档与源码（`stream-text.ts` 的
 *   `pull()`/`flush()`）确认：`abortSignal` 触发后，`result.stream` 会先吐出一个
 *   `{ type: "abort" }` 块，再正常关闭（不 throw）。而只要本步在 abort 发生前还没跑完
 *   （`recordedSteps.length === 0`，单步场景下几乎总是如此），
 *   `result.finishReason`/`usage`/`responseMessages`/`toolCalls` 这几个 promise 会转为
 *   reject，reject 值就是 `abortSignal.reason`。
 *
 *   所以 `runStep` 不特判 `"abort"` 这个 chunk type（它落进下面 switch 的 default 分支被
 *   忽略），让 for-await 循环随流关闭自然结束；随后 `Promise.all([...])` 的 reject 直接
 *   从这个 async generator 的 `next()` 抛出。调用方 `for await` 或 `.next()` 拿到的就是
 *   一次标准的 rejected promise，runko 不必自造一套 abort 语义。
 */
import { streamText } from "ai";
import type {
  AssistantModelMessage,
  FinishReason,
  LanguageModel,
  LanguageModelUsage,
  ModelMessage,
  ToolModelMessage,
} from "ai";
import { jsonValueSchema } from "../types.js";
import type { JsonValue, Tool as RunkoTool } from "../types.js";
import { convertTools } from "./convert.js";

/**
 * `result.stream` 的增量块映射出的判别联合。
 *
 * `id` 在四个变体里统一对应 AI SDK 协议里的关联键（text-delta/reasoning-delta 的 `id`、
 * tool-input-delta 的 `id`、tool-call 的 `toolCallId`）。同一次工具调用的
 * `tool-input-delta*` 与随后的 `tool-call` 共享同一个 `id`，调用方靠它把流式输入拼起来、
 * 并关联到最终那条 tool-call，不需要额外的关联字段。
 */
export type StepEvent =
  | { type: "text-delta"; id: string; text: string }
  | { type: "reasoning-delta"; id: string; text: string }
  | { type: "tool-input-delta"; id: string; delta: string }
  | { type: "tool-call"; id: string; toolName: string; input: JsonValue };

/** 一次 `runStep` 里原样带出的工具调用——这里不执行它，交给调用方的 ToolRuntime 处理。 */
export interface StepToolCall {
  id: string;
  toolName: string;
  input: JsonValue;
}

/**
 * AI SDK 内部把 `result.responseMessages` 的元素类型叫 `ResponseMessage`，
 * 但只导出了它的两个成员类型（`AssistantModelMessage`/`ToolModelMessage`），
 * 没有导出 `ResponseMessage` 这个别名本身——这里按其定义原样重建，不是新造
 * 语义。
 */
export type ResponseMessage = AssistantModelMessage | ToolModelMessage;

/** `runStep` 结束后的汇总（docs/logic/engine/tech/core-sdk.md §4.3 第 3 点）。 */
export interface StepResult {
  finishReason: FinishReason;
  responseMessages: ResponseMessage[];
  usage: LanguageModelUsage;
  toolCalls: StepToolCall[];
}

export interface RunStepInput {
  model: LanguageModel;
  system?: string;
  messages: ModelMessage[];
  tools?: Record<string, RunkoTool>;
  abortSignal?: AbortSignal;
  maxOutputTokens?: number;
}

/**
 * `unknown` → `JsonValue` 的运行时收窄，隔离于此处的唯一调用点：AI SDK 对
 * 未匹配到声明工具集的 tool call（`DynamicToolCall`）把 `input` 类型留成
 * `unknown`（模型可能产生任意畸形/非法调用）。用已导出的 `jsonValueSchema`
 * 做 `safeParse` 而非类型断言——校验失败时以 `null` 承接，不让非法值以
 * 错误的静态类型继续流转。对匹配到声明工具集的调用（`input` 本就是
 * `JsonValue`），safeParse 恒定成功，这里不需要为两条路径分别写代码。
 */
function toJsonValue(input: unknown): JsonValue {
  const parsed = jsonValueSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

/**
 * 单步 `streamText`：消费 `result.stream`，把四类增量块映射成 `StepEvent` 逐个 `yield`，
 * 流结束后提取 `{ finishReason, responseMessages, usage, toolCalls }` 作为返回值。
 *
 * 选 `AsyncGenerator<StepEvent, StepResult>` 而不是「回调 + 单独返回
 * `Promise<StepResult>`」：调用方（loop）天然要一边消费事件一边等最终结果，生成器的
 * `return` 值正好把两者以同样的形状绑在一次调用里，不需要额外的事件总线或 Promise
 * 组合子。
 */
export async function* runStep(input: RunStepInput): AsyncGenerator<StepEvent, StepResult> {
  const { model, system, messages, tools, abortSignal, maxOutputTokens } = input;

  const result = streamText({
    model,
    instructions: system,
    messages,
    tools: tools ? convertTools(tools) : undefined,
    abortSignal,
    maxOutputTokens,
  });

  for await (const part of result.stream) {
    switch (part.type) {
      case "text-delta":
        yield { type: "text-delta", id: part.id, text: part.text };
        break;
      case "reasoning-delta":
        yield { type: "reasoning-delta", id: part.id, text: part.text };
        break;
      case "tool-input-delta":
        yield { type: "tool-input-delta", id: part.id, delta: part.delta };
        break;
      case "tool-call":
        yield {
          type: "tool-call",
          id: part.toolCallId,
          toolName: part.toolName,
          input: toJsonValue(part.input),
        };
        break;
      default:
        break;
    }
  }

  const [finishReason, usage, responseMessages, toolCalls] = await Promise.all([
    result.finishReason,
    result.usage,
    result.responseMessages,
    result.toolCalls,
  ]);

  return {
    finishReason,
    usage,
    responseMessages,
    toolCalls: toolCalls.map((call) => ({
      id: call.toolCallId,
      toolName: call.toolName,
      input: toJsonValue(call.input),
    })),
  };
}
