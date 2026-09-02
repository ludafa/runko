/**
 * Server-side counterpart to `packages/core/test/helpers/runko-chunks.ts`
 * (docs/tech/single-ledger.md §5 单-3, P13-5-3/P13-5-5): small
 * factories/extractors for `RunkoChunk`/`RunkoUIMessage` used across
 * `test/agent/turn-runner.test.ts`, `test/agent/chat-agent.test.ts`, and
 * `test/routes/chat.test.ts` — inlined here rather than imported from
 * `@runko/core`'s own test helpers (that file lives under `packages/core/test`,
 * not exported from the package) and trimmed to only what this app's tests
 * actually need (no `fingerprintChunk`/`fingerprintMessage` — this app's
 * tests assert on concrete chunk/message shapes, not structural-equivalence
 * comparisons the way `packages/core/test/steer.test.ts` does).
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
import type { DataUIPart, ToolUIPart, UITools } from 'ai';
import { isToolUIPart } from 'ai';

/** Drains an `AsyncGenerator<RunkoChunk, T>` (`Session.stream()`/`TurnDrivenSession.stream()`'s own shape), collecting both the chunk sequence and the generator's return value. */
export async function drainTurn<T>(
  gen: AsyncGenerator<RunkoChunk, T>,
): Promise<{ chunks: RunkoChunk[]; result: T }> {
  const chunks: RunkoChunk[] = [];
  let next = await gen.next();
  while (!next.done) {
    chunks.push(next.value);
    next = await gen.next();
  }
  return { chunks, result: next.value };
}

/** Filters a chunk sequence down to one `type`, narrowed to that variant's own fields (`Extract`). */
export function chunksOfType<T extends RunkoChunk['type']>(
  chunks: RunkoChunk[],
  type: T,
): Extract<RunkoChunk, { type: T }>[] {
  return chunks.filter(
    (chunk): chunk is Extract<RunkoChunk, { type: T }> => chunk.type === type,
  );
}

/** A minimal plain-text user `RunkoUIMessage` — for hand-assembling a `ControllableSession`'s `SessionState.messages` (prior history + this turn's new messages) without going through a real `@runko/sdk` session. */
export function userTextMessage(id: string, text: string): RunkoUIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] };
}

/** A minimal plain-text assistant `RunkoUIMessage`, optionally carrying turn-result `metadata` (`status`/`usage`/`turn`/`error`) — the shape `finalizeTurn` (`@runko/core`'s `loop.ts`) produces at turn end. */
export function assistantTextMessage(
  id: string,
  text: string,
  metadata?: RunkoMessageMetadata,
): RunkoUIMessage {
  return {
    id,
    role: 'assistant',
    parts: [{ type: 'step-start' }, { type: 'text', text, state: 'done' }],
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

/** Every tool part (`tool-<name>`, excluding the never-produced-by-loop.ts `dynamic-tool`) on one message. */
export function toolParts(message: RunkoUIMessage): ToolUIPart<UITools>[] {
  const result: ToolUIPart<UITools>[] = [];
  for (const part of message.parts) {
    if (isToolUIPart<UITools>(part) && part.type !== 'dynamic-tool') {
      result.push(part);
    }
  }
  return result;
}

/** `toolParts`, flatMapped across a whole message list (ledger-level lookup). */
export function allToolParts(
  messages: RunkoUIMessage[],
): ToolUIPart<UITools>[] {
  return messages.flatMap(toolParts);
}

/** The last assistant message in a message list — where `finalizeTurn`/turn-result metadata lands. */
export function lastAssistantMessage(
  messages: RunkoUIMessage[],
): RunkoUIMessage | undefined {
  return [...messages]
    .reverse()
    .find((message) => message.role === 'assistant');
}

/** Concatenates every `text` part on a message (accepts `undefined` so callers don't need a non-null assertion on `lastAssistantMessage`'s result). */
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

// ---------------------------------------------------------------------------
// Chunk factories — one per `RunkoChunk` variant this app's tests construct
// by hand (durable/ephemeral classification boundary, `ControllableSession`
// scripts). Not exhaustive over all 32 `RunkoChunk` variants (source/file/
// custom/error/tool-input-delta never appear in this app's own coverage —
// `@runko/core`'s own `events.test.ts`/`runko-chunks.ts` already cover the
// full vocabulary at the producing layer).
// ---------------------------------------------------------------------------

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
export function toolInputStartChunk(
  toolCallId: string,
  toolName: string,
): RunkoChunk {
  return { type: 'tool-input-start', toolCallId, toolName };
}
export function toolInputAvailableChunk(
  toolCallId: string,
  toolName: string,
  input: unknown,
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
  output: unknown,
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
/**
 * `data-tool-progress` — `transient` defaults to `true` (the shape
 * `@runko/core`'s loop actually produces, docs/tech/single-ledger.md §2.2b) but is a parameter
 * (not hardcoded) so `turn-runner.test.ts`'s `isDurableChunk` boundary
 * coverage can also construct the *non*-transient edge case (`transient:
 * false`/absent — a shape the real loop never emits for this chunk type, but
 * `isDurableChunk`'s own blanket rule keys off the literal `transient` field,
 * not the chunk's `type`, so this is the one input that actually exercises
 * that rule instead of the type-based shortcuts it happens to agree with).
 */
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
export function startStepChunk(): RunkoChunk {
  return { type: 'start-step' };
}
export function finishStepChunk(): RunkoChunk {
  return { type: 'finish-step' };
}
export function startChunk(messageId: string): RunkoChunk {
  return { type: 'start', messageId };
}
export function finishChunk(): RunkoChunk {
  return { type: 'finish', finishReason: 'stop' };
}
export function messageMetadataChunk(
  messageMetadata: RunkoMessageMetadata,
): RunkoChunk {
  return { type: 'message-metadata', messageMetadata };
}

/**
 * `data-tool-timing`（chat 可观测性：工具起止时间戳，`@runko/core`'s `state.ts`
 * 的 `toolTimingDataSchema`/`loop.ts` 的 `upsertToolTimingPart`）——`id` 恒等于
 * `toolCallId`（每次调用各一个，同 id 覆盖）。`completedAt` 省略时对应
 * `startToolTiming`（只打 `startedAt`）那次更新；传入时对应
 * `completeToolTiming`（补上 `completedAt`）那次——`turn-runner/log.ts`'s
 * `logChunk` 只在后者才落一行"tool call completed/errored/denied"日志。
 */
export function dataToolTimingChunk(
  toolCallId: string,
  startedAt: number,
  completedAt?: number,
  executionStartedAt?: number,
): RunkoChunk {
  const data: ToolTimingData = {
    toolCallId,
    startedAt,
    ...(executionStartedAt !== undefined ? { executionStartedAt } : {}),
    ...(completedAt !== undefined ? { completedAt } : {}),
  };
  return { type: 'data-tool-timing', id: toolCallId, data };
}

/** Every tool part's data part sibling type, for `data-file-change`/`data-plan-update`/`data-error` extraction off a finished message (mirrors `packages/core/test/helpers/runko-chunks.ts`'s four named — not generic — extractors, same non-assertable-generic-narrowing reason documented there). */
export function fileChangeParts(
  message: RunkoUIMessage,
): DataUIPart<{ 'file-change': FileChangeData }>[] {
  return message.parts.filter(
    (part): part is DataUIPart<{ 'file-change': FileChangeData }> =>
      part.type === 'data-file-change',
  );
}
