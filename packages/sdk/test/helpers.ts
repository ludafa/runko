/**
 * Test-only model fixtures — same shape as `@nimbo/core`'s `test/integration.test.ts`
 * (the "host assembly" file this ticket's default wiring formalizes): a `MockLanguageModelV4`
 * scripted via raw AI SDK stream chunks, one `doStream` entry per assistant step.
 */
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { SessionEvent, SessionItem } from "../src/index.js";

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

export async function drainStream(gen: AsyncGenerator<SessionEvent, unknown>): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  let next = await gen.next();
  while (!next.done) {
    events.push(next.value);
    next = await gen.next();
  }
  return events;
}

export function isItemCompleted(event: SessionEvent): event is { type: "item.completed"; item: SessionItem } {
  return event.type === "item.completed";
}
export function isToolCallItem(item: SessionItem): item is Extract<SessionItem, { type: "tool_call" }> {
  return item.type === "tool_call";
}
export function isFileChangeItem(item: SessionItem): item is Extract<SessionItem, { type: "file_change" }> {
  return item.type === "file_change";
}

export function toolCallItems(events: SessionEvent[]): Extract<SessionItem, { type: "tool_call" }>[] {
  return events.filter(isItemCompleted).map((e) => e.item).filter(isToolCallItem);
}
export function fileChangeItems(events: SessionEvent[]): Extract<SessionItem, { type: "file_change" }>[] {
  return events.filter(isItemCompleted).map((e) => e.item).filter(isFileChangeItem);
}
