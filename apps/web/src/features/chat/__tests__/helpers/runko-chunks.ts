/**
 * Web-side counterpart to `apps/node-server/test/helpers/runko-chunks.ts` /
 * `packages/core/test/helpers/runko-chunks.ts` (docs/tech/single-ledger.md §5/§6, P13-5-5): small factories for `RunkoChunk`s and the wire's
 * `ChatReplayFrame` envelopes around them, trimmed to what this package's own
 * tests need (`MessageLedger`/`useChatMessages`/component fixtures) — no
 * `drainTurn`/`fingerprintChunk` (nothing here drives a real `@runko/core`
 * generator or needs structural-equivalence comparisons that ignore random
 * ids; this package's tests assign every id by hand instead of getting one
 * from `randomUUID()`, so plain `toEqual` already works for the replay-vs-
 * live-materialization equivalence check in `timeline.test.ts`).
 */
import type {
  ErrorData,
  FileChangeData,
  PlanUpdateData,
  RunkoChunk,
  RunkoMessageMetadata,
  RunkoUIMessage,
  ToolTimingData,
} from '@runko/core';
import type { ToolUIPart, UITools } from 'ai';
import { isToolUIPart } from 'ai';

import type {
  ChatReplayFrame,
  ChunkEnvelope,
  JsonValue,
  MessageFrame,
} from '../../schema';

// ---------------------------------------------------------------------------
// Chunk factories — one per `RunkoChunk` variant these tests construct by
// hand, mirroring the shapes `@runko/core`'s `loop.ts` actually produces
// (`runOneStep`/`settleToolCall`/`drainSteerMessages`/`finalizeTurn`, see
// that file's own doc comments for the exact sequencing this mirrors).
// ---------------------------------------------------------------------------

export function startChunk(
  messageId: string,
  messageMetadata?: RunkoMessageMetadata,
): RunkoChunk {
  return {
    type: 'start',
    messageId,
    ...(messageMetadata !== undefined ? { messageMetadata } : {}),
  };
}

export function startStepChunk(): RunkoChunk {
  return { type: 'start-step' };
}

export function finishStepChunk(): RunkoChunk {
  return { type: 'finish-step' };
}

export function finishChunk(
  finishReason: 'stop' | 'tool-calls' = 'stop',
): RunkoChunk {
  return { type: 'finish', finishReason };
}

export function textStartChunk(id: string): RunkoChunk {
  return { type: 'text-start', id };
}
export function textDeltaChunk(id: string, delta: string): RunkoChunk {
  return { type: 'text-delta', id, delta };
}
export function textEndChunk(id: string): RunkoChunk {
  return { type: 'text-end', id };
}

export function reasoningStartChunk(id: string): RunkoChunk {
  return { type: 'reasoning-start', id };
}
export function reasoningDeltaChunk(id: string, delta: string): RunkoChunk {
  return { type: 'reasoning-delta', id, delta };
}
export function reasoningEndChunk(id: string): RunkoChunk {
  return { type: 'reasoning-end', id };
}

export function fileChunk(url: string, mediaType: string): RunkoChunk {
  return { type: 'file', url, mediaType };
}

export function toolInputAvailableChunk(
  toolCallId: string,
  toolName: string,
  input: JsonValue,
): RunkoChunk {
  return { type: 'tool-input-available', toolCallId, toolName, input };
}

export function toolApprovalRequestChunk(callId: string): RunkoChunk {
  return {
    type: 'tool-approval-request',
    approvalId: callId,
    toolCallId: callId,
  };
}

export function toolApprovalResponseChunk(
  callId: string,
  approved: boolean,
  reason?: string,
): RunkoChunk {
  return {
    type: 'tool-approval-response',
    approvalId: callId,
    approved,
    ...(reason !== undefined ? { reason } : {}),
  };
}

export function toolOutputAvailableChunk(
  toolCallId: string,
  output: JsonValue,
): RunkoChunk {
  return { type: 'tool-output-available', toolCallId, output };
}

export function toolOutputErrorChunk(
  toolCallId: string,
  errorText: string,
): RunkoChunk {
  return { type: 'tool-output-error', toolCallId, errorText };
}

export function toolOutputDeniedChunk(toolCallId: string): RunkoChunk {
  return { type: 'tool-output-denied', toolCallId };
}

export function dataFileChangeChunk(
  id: string,
  data: FileChangeData,
): RunkoChunk {
  return { type: 'data-file-change', id, data };
}

export function dataPlanUpdateChunk(data: PlanUpdateData): RunkoChunk {
  return { type: 'data-plan-update', id: 'plan-update', data };
}

export function dataErrorChunk(data: ErrorData): RunkoChunk {
  return { type: 'data-error', id: 'turn-error', data };
}

/** `transient` defaults to `true` — the only shape `@runko/core`'s loop actually produces for this chunk type (docs/tech/single-ledger.md §2.2b). */
export function dataToolProgressChunk(
  toolCallId: string,
  text: string,
  transient = true,
): RunkoChunk {
  return {
    type: 'data-tool-progress',
    id: toolCallId,
    data: { toolCallId, text },
    ...(transient ? { transient: true as const } : {}),
  };
}

export function messageMetadataChunk(
  messageMetadata: RunkoMessageMetadata,
): RunkoChunk {
  return { type: 'message-metadata', messageMetadata };
}

/**
 * `data-tool-timing`（chat 可观测性：工具起止时间戳，`@runko/core`'s
 * `state.ts`/`loop.ts`）——`id` 恒等于 `toolCallId`（同 id 覆盖）。
 * `completedAt` 省略时对应"只打 `startedAt`"那次更新（`startToolTiming`）。
 */
export function dataToolTimingChunk(
  toolCallId: string,
  startedAt: number,
  completedAt?: number,
): RunkoChunk {
  const data: ToolTimingData =
    completedAt === undefined ?
      { toolCallId, startedAt }
    : { toolCallId, startedAt, completedAt };
  return { type: 'data-tool-timing', id: toolCallId, data };
}

// ---------------------------------------------------------------------------
// Frame envelopes — `ChatReplayFrame` wrapping around the chunk factories
// above, plus the durable/ephemeral seq-assignment rule `apps/node-server`'s
// `turn-runner/persistence.ts` (`isDurableChunk`) actually applies, so a hand-assembled
// chunk sequence can be turned into a realistic wire frame sequence (`seq`
// only on durable chunks) in one call.
// ---------------------------------------------------------------------------

export function chunkFrame(chunk: RunkoChunk, seq?: number): ChunkEnvelope {
  return seq === undefined ? { chunk } : { seq, chunk };
}

export function messageFrame(
  seq: number,
  message: RunkoUIMessage,
): MessageFrame {
  return { seq, message };
}

/**
 * `apps/node-server/src/agent/turn-runner/persistence.ts`'s `isDurableChunk`: `text-delta`/
 * `reasoning-delta` and anything `transient: true` never consume a `seq`;
 * every other chunk does.
 */
export function isDurableChunk(chunk: RunkoChunk): boolean {
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
    return false;
  }
  return !('transient' in chunk && chunk.transient === true);
}

/** Assigns sequential `seq`s to only the durable chunks in order, starting after `startSeq` — mirrors the server's own persist-then-broadcast numbering (`turn-runner/persistence.ts`'s `createEmitWire`). */
export function toChunkEnvelopes(
  chunks: readonly RunkoChunk[],
  startSeq = 0,
): ChunkEnvelope[] {
  let seq = startSeq;
  return chunks.map((chunk) => {
    if (!isDurableChunk(chunk)) {
      return chunkFrame(chunk);
    }
    seq += 1;
    return chunkFrame(chunk, seq);
  });
}

// ---------------------------------------------------------------------------
// Higher-level step builders — one runko "step" = one assistant
// `RunkoUIMessage`'s worth of chunks (`loop.ts`'s own file header), composed
// from the factories above in the exact order `runOneStep`/`settleToolCall`
// actually yield them.
// ---------------------------------------------------------------------------

/** A single-text-part assistant step: `start` → `start-step` → text → `finish-step` → `finish`. */
export function textStepChunks(opts: {
  messageId: string;
  textId: string;
  text: string;
  finishReason?: 'stop' | 'tool-calls';
}): RunkoChunk[] {
  return [
    startChunk(opts.messageId),
    startStepChunk(),
    textStartChunk(opts.textId),
    textDeltaChunk(opts.textId, opts.text),
    textEndChunk(opts.textId),
    finishStepChunk(),
    finishChunk(opts.finishReason ?? 'stop'),
  ];
}

/** A step whose only content is one tool call that resolves without ever needing approval (`ApprovalOutcome === 'allow'`): `tool-input-available` → `tool-output-available`/`-error`. */
export function toolAllowedStepChunks(opts: {
  messageId: string;
  toolCallId: string;
  toolName: string;
  input: JsonValue;
  output: JsonValue;
  finishReason?: 'stop' | 'tool-calls';
}): RunkoChunk[] {
  return [
    startChunk(opts.messageId),
    startStepChunk(),
    toolInputAvailableChunk(opts.toolCallId, opts.toolName, opts.input),
    finishStepChunk(),
    toolOutputAvailableChunk(opts.toolCallId, opts.output),
    finishChunk(opts.finishReason ?? 'tool-calls'),
  ];
}

/** A step whose tool call is gated (`ApprovalOutcome === 'review'`), split into two halves so a test can feed the "pending" half, assert the card renders, then feed the "resolved" half — mirrors the real timing (`settleToolCall` `await`s the human decision between the two). */
export function toolReviewPendingChunks(opts: {
  messageId: string;
  toolCallId: string;
  toolName: string;
  input: JsonValue;
}): RunkoChunk[] {
  return [
    startChunk(opts.messageId),
    startStepChunk(),
    toolInputAvailableChunk(opts.toolCallId, opts.toolName, opts.input),
    finishStepChunk(),
    toolApprovalRequestChunk(opts.toolCallId),
  ];
}

export function toolReviewAllowedChunks(opts: {
  toolCallId: string;
  output: JsonValue;
  finishReason?: 'stop' | 'tool-calls';
}): RunkoChunk[] {
  return [
    toolApprovalResponseChunk(opts.toolCallId, true),
    toolOutputAvailableChunk(opts.toolCallId, opts.output),
    finishChunk(opts.finishReason ?? 'tool-calls'),
  ];
}

export function toolReviewDeniedChunks(opts: {
  toolCallId: string;
  reason: string;
  finishReason?: 'stop' | 'tool-calls';
}): RunkoChunk[] {
  return [
    toolApprovalResponseChunk(opts.toolCallId, false, opts.reason),
    toolOutputDeniedChunk(opts.toolCallId),
    finishChunk(opts.finishReason ?? 'tool-calls'),
  ];
}

/** A step whose tool call is denied outright (`ApprovalOutcome === 'deny'`, or no arbiter): no approval-request/-response, straight to `output-denied` (docs/tech/single-ledger.md §6.1). */
export function toolDirectDeniedStepChunks(opts: {
  messageId: string;
  toolCallId: string;
  toolName: string;
  input: JsonValue;
  finishReason?: 'stop' | 'tool-calls';
}): RunkoChunk[] {
  return [
    startChunk(opts.messageId),
    startStepChunk(),
    toolInputAvailableChunk(opts.toolCallId, opts.toolName, opts.input),
    finishStepChunk(),
    toolOutputDeniedChunk(opts.toolCallId),
    finishChunk(opts.finishReason ?? 'tool-calls'),
  ];
}

/** A steer-injected user message (`loop.ts`'s `drainSteerMessages`) — already fully known up front, no `start-step`/`finish-step` (that function never yields either). */
export function steerTextMessageChunks(opts: {
  messageId: string;
  text: string;
}): RunkoChunk[] {
  const partId = `${opts.messageId}-0`;
  return [
    startChunk(opts.messageId, { steered: true }),
    textStartChunk(partId),
    textDeltaChunk(partId, opts.text),
    textEndChunk(partId),
    finishChunk('stop'),
  ];
}

/** The turn-ending standalone `message-metadata` chunk (`loop.ts`'s `finalizeTurn`) — not wrapped in any `start`/`finish` of its own. */
export function turnEndChunk(metadata: RunkoMessageMetadata): RunkoChunk {
  return messageMetadataChunk(metadata);
}

/** Plain assistant `RunkoUIMessage` — for constructing a `MessageFrame` (replay-only, a message already fully finished server-side) without going through chunk materialization. */
export function assistantMessage(
  id: string,
  parts: RunkoUIMessage['parts'],
  metadata?: RunkoMessageMetadata,
): RunkoUIMessage {
  return {
    id,
    role: 'assistant',
    parts,
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

export function userMessage(id: string, text: string): RunkoUIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] };
}

/** Every `ChatReplayFrame` this test helper module can produce, flattened + seq-assigned in one call — the common case of "feed this whole scenario into a ledger/hook". */
export function toReplayFrames(
  chunks: readonly RunkoChunk[],
  startSeq = 0,
): ChatReplayFrame[] {
  return toChunkEnvelopes(chunks, startSeq);
}

// ---------------------------------------------------------------------------
// Message extractors — reading a materialized `RunkoUIMessage` back out
// (mirrors `apps/node-server/test/helpers/runko-chunks.ts`'s own extractor set).
// ---------------------------------------------------------------------------

/** Every tool part on one message (excludes the never-produced-by-runko `dynamic-tool`). */
export function toolPartsOf(message: RunkoUIMessage): ToolUIPart<UITools>[] {
  const result: ToolUIPart<UITools>[] = [];
  for (const part of message.parts) {
    if (isToolUIPart<UITools>(part) && part.type !== 'dynamic-tool') {
      result.push(part);
    }
  }
  return result;
}

/** The one tool part on `message` with this `toolCallId`, if any. */
export function toolPartById(
  message: RunkoUIMessage,
  toolCallId: string,
): ToolUIPart<UITools> | undefined {
  return toolPartsOf(message).find((part) => part.toolCallId === toolCallId);
}

/** Concatenates every `text` part on a message. */
export function collectText(message: RunkoUIMessage | undefined): string {
  let text = '';
  if (message === undefined) {
    return text;
  }
  for (const part of message.parts) {
    if (part.type === 'text') {
      text += part.text;
    }
  }
  return text;
}

/**
 * Yields control past one full macrotask turn — `MessageLedger`'s per-message
 * materialization (`readUIMessageStream()`) is fed through a `ReadableStream`
 * piped through a `TransformStream`; queued `enqueue()`s don't drain
 * synchronously (confirmed empirically: not even after two microtask ticks —
 * only a real macrotask boundary flushes the pipe), so any test that applies
 * chunks and then immediately inspects the ledger's latest snapshot needs to
 * await this (usually more than once for a multi-step turn) first.
 */
export async function flushLedger(times = 5): Promise<void> {
  let chain = Promise.resolve();
  for (let i = 0; i < times; i++) {
    chain = chain.then(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        }),
    );
  }
  await chain;
}
