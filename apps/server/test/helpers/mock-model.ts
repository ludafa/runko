/**
 * A scripted `MockLanguageModelV4` (`ai/test`), same technique as
 * `packages/sdk/test/helpers.ts`/`packages/core/test/session.test.ts` — raw
 * AI SDK stream chunks, one `doStream` entry per assistant step.
 */
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

const usage = {
  inputTokens: {
    total: 10,
    noCache: 10,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
} as const;

function stopChunk(text: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'stream-start' as const, warnings: [] },
        { type: 'text-start' as const, id: 't1' },
        { type: 'text-delta' as const, id: 't1', delta: text },
        { type: 'text-end' as const, id: 't1' },
        {
          type: 'finish' as const,
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage,
        },
      ],
      initialDelayInMs: null,
      chunkDelayInMs: null,
    }),
  };
}

function toolCallChunk(toolCallId: string, toolName: string, input: unknown) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'stream-start' as const, warnings: [] },
        {
          type: 'tool-call' as const,
          toolCallId,
          toolName,
          input: JSON.stringify(input),
        },
        {
          type: 'finish' as const,
          finishReason: { unified: 'tool-calls' as const, raw: undefined },
          usage,
        },
      ],
      initialDelayInMs: null,
      chunkDelayInMs: null,
    }),
  };
}

/** A one-step turn: the model immediately replies with `text` and stops (no tool calls). */
export function stopOnlyModel(text: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({ doStream: stopChunk(text) });
}

/** A two-step turn: one tool call, then a stop reply — for exercising `tool_call`/`file_change` events. */
export function toolCallThenStopModel(
  toolName: string,
  input: unknown,
  toolCallId: string,
  stopText: string,
): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: [toolCallChunk(toolCallId, toolName, input), stopChunk(stopText)],
  });
}
