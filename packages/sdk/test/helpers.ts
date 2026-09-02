/**
 * Test-only model fixtures — same shape as `@runko/core`'s `test/integration.test.ts`
 * (the "host assembly" file this ticket's default wiring formalizes): a `MockLanguageModelV4`
 * scripted via raw AI SDK stream chunks, one `doStream` entry per assistant step.
 *
 * P13-5-2（docs/tech/single-ledger.md）迁移：`drainStream` 改收集
 * `RunkoChunk`（`session.stream()` 的产出类型，SessionEvent 已退役）；
 * `isItemCompleted`/`toolCallItems`/`fileChangeItems` 改为从最终账本
 * （`session.toJSON().messages`）的部件里取——同一 toolCallId 在账本里只记
 * 结算态（docs/tech/single-ledger.md §4.1 实现教训），因此按工具部件类型/data 部件类型 flatMap
 * 全部消息即可，不需要再从 chunk 流里筛"completed"事件。
 */
import { isToolUIPart, simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { DataUIPart, ToolUIPart, UITools } from "ai";
import type { FileChangeData, RunkoChunk, RunkoUIMessage, TurnResult } from "../src/index.js";

export function mockModel(buildOptions: () => ConstructorParameters<typeof MockLanguageModelV4>[0]): MockLanguageModelV4 {
  return new MockLanguageModelV4(buildOptions());
}

export const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
} as const;

export function toolCallChunk(toolCallId: string, toolName: string, input: unknown) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "tool-call" as const, toolCallId, toolName, input: JSON.stringify(input) },
        { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: undefined }, usage },
      ],
      initialDelayInMs: null,
      chunkDelayInMs: null,
    }),
  };
}

export function stopChunk(text: string) {
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

/** 排空一个 `session.stream(...)` 生成器，收集其 `RunkoChunk` 序列并保留最终 `TurnResult`。 */
export async function drainStream(gen: AsyncGenerator<RunkoChunk, TurnResult>): Promise<RunkoChunk[]> {
  const chunks: RunkoChunk[] = [];
  let next = await gen.next();
  while (!next.done) {
    chunks.push(next.value);
    next = await gen.next();
  }
  return chunks;
}

/** 同上，但连生成器的返回值（`TurnResult`）一起要——需要 `finalResponse`/`usage` 的用例用这个。 */
export async function drainStreamFull(gen: AsyncGenerator<RunkoChunk, TurnResult>): Promise<{ chunks: RunkoChunk[]; result: TurnResult }> {
  const chunks: RunkoChunk[] = [];
  let next = await gen.next();
  while (!next.done) {
    chunks.push(next.value);
    next = await gen.next();
  }
  return { chunks, result: next.value };
}

/** 一条消息里全部工具部件（`tool-<名字>`，排除理论上不会出现的 `dynamic-tool`）。 */
export function toolPartsOf(message: RunkoUIMessage): ToolUIPart<UITools>[] {
  const result: ToolUIPart<UITools>[] = [];
  for (const part of message.parts) {
    if (isToolUIPart<UITools>(part) && part.type !== "dynamic-tool") {result.push(part);}
  }
  return result;
}

/** 账本级查找：全部消息里的全部工具部件 flatMap——同一 toolCallId 只记结算态,理应各出现一次。 */
export function toolCallItems(messages: RunkoUIMessage[]): ToolUIPart<UITools>[] {
  return messages.flatMap(toolPartsOf);
}

/** 账本级查找：全部消息里的全部 `data-file-change` 部件（每次工具执行各一条，不 upsert）。 */
export function fileChangeItems(messages: RunkoUIMessage[]): DataUIPart<{ "file-change": FileChangeData }>[] {
  const result: DataUIPart<{ "file-change": FileChangeData }>[] = [];
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "data-file-change") {result.push(part);}
    }
  }
  return result;
}
