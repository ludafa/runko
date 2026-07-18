/**
 * Wire-level schemas for the chat agent API (docs/tech/chat-webapp.md
 * §2.2, docs/tech/single-ledger.md §5/§6 "UIMessage 单账本" — P13-5-4
 * migration). The old `SessionEvent`/`SessionItem` mirror (`sessionItemSchema`/
 * `sessionEventSchema`) plus every server-invented wire sentinel built on top
 * of it (`user.message`, `turn.result`/`turn.failed`,
 * `approval.requested`/`approval.resolved`, `question.asked`/
 * `question.answered`) are retired — `@nimbo/core` no longer exports
 * `SessionEvent`/`SessionItem` at all (see that package's `state.ts`), and
 * `apps/server`'s own `schemas/chat.ts` (already migrated, P13-5-3) confirms
 * there's nothing left to mirror them with.
 *
 * The wire is now a stream of `ChatReplayFrame`s — a `ChunkEnvelope`
 * (`{ seq?, chunk }`, `seq` present ⇔ durable/replayable) or a `MessageFrame`
 * (`{ seq, message }`, only ever appears in replay, a finished
 * `NimboUIMessage` verbatim) — see `apps/server/src/schemas/chat.ts`'s own
 * file header for the full rationale (this file's frame shapes are a
 * hand-written mirror of that server-side zod, not the kubb-generated
 * `gen/zod/chatChunkEnvelopeSchema.ts`/`chatMessageFrameSchema.ts`: kubb
 * infers `chunk`/`message` as bare `z.any()` from the OpenAPI `{}` schema
 * `apps/server` emits for them — see that file's own "controlled exception"
 * comment for why no schema exists to generate from — with no `seq`/`chunk`
 * `required` list either, which is looser than the real wire shape; this file
 * follows this repo's existing convention of hand-rolling schemas that need
 * more precision than kubb's OpenAPI-derived output can express, same as
 * before this migration).
 */
import type { NimboChunk, NimboUIMessage } from '@nimbo/core';
import { z } from 'zod';

// ---- JsonValue (packages/core/src/types.ts) — still useful client-side for
// narrowing a tool part's `unknown` input/output (see `timeline.ts`'s
// `parseJsonValue`) ----

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

// ---- ChatReplayFrame (apps/server's `schemas/chat.ts`) ----

/**
 * Controlled exception (same rationale as `apps/server/src/schemas/chat.ts`'s
 * own `nimboChunkSchema`/`nimboUIMessageSchema`): `NimboChunk`/`NimboUIMessage`
 * (ai's `UIMessageChunk`/`UIMessage`, instantiated in `@nimbo/core`'s
 * `state.ts`) have no zod schema this file can reuse — `z.any()` is the same
 * escape hatch this file has always used for structurally-unschemaable
 * external types (`jsonValueSchema` above didn't need it, but this repo's
 * `apps/server` established the pattern for exactly this case), contained by
 * a `z.ZodType<T>` annotation so every consumer of the exported schema still
 * sees the precise TypeScript type — `any` never leaks past this one
 * declaration. Both only ever parse a value that has already round-tripped
 * through `JSON.parse()` (an SSE `data:` payload, or a fetched
 * `GET .../events` JSON body) — the server already validated the real
 * `NimboChunk`/`NimboUIMessage` shape before ever serializing it, so this
 * boundary only needs "is this JSON, structurally, in the right envelope
 * shape" — not a redundant re-implementation of `@nimbo/core`'s own
 * `validateSessionMessages()`/ai's `validateUIMessages()`.
 */
const nimboChunkSchema: z.ZodType<NimboChunk> = z.any();

/** Same rationale as `nimboChunkSchema` above, for `NimboUIMessage` (`MessageFrame.message`). */
const nimboUIMessageSchema: z.ZodType<NimboUIMessage> = z.any();

/**
 * `{ seq?, chunk }` — the live tail's own wire shape (`seq` present ⇔
 * durable/replayable, absent ⇔ ephemeral — `text-delta`/`reasoning-delta`/any
 * `transient: true` data part, docs/tech/single-ledger.md §5 单-3), also reused with `seq`
 * always present for a replayed `kind = 'chunk'` row (the in-progress or
 * crashed turn's durable chunks).
 */
export const chunkEnvelopeSchema = z.object({
  seq: z.number().int().optional(),
  chunk: nimboChunkSchema,
});

export type ChunkEnvelope = z.infer<typeof chunkEnvelopeSchema>;

/**
 * `{ seq, message }` — replay-only: a finished `NimboUIMessage`, read back
 * verbatim from a `kind = 'message'` row. Never appears on the live tail's
 * own broadcast path (a message row is only ever written once a turn has
 * already finished).
 */
export const messageFrameSchema = z.object({
  seq: z.number().int(),
  message: nimboUIMessageSchema,
});

export type MessageFrame = z.infer<typeof messageFrameSchema>;

/**
 * Every wire frame this app can ever receive is *either* a `ChunkEnvelope`
 * *or* a `MessageFrame` — told apart structurally (which of `chunk`/`message`
 * the object actually carries), same discipline `apps/server`'s own
 * `chatReplayFrameSchema` uses (no shared literal discriminant field).
 */
export const chatReplayFrameSchema = z.union([
  chunkEnvelopeSchema,
  messageFrameSchema,
]);

export type ChatReplayFrame = ChunkEnvelope | MessageFrame;

export function isMessageFrame(frame: ChatReplayFrame): frame is MessageFrame {
  return 'message' in frame;
}

/** `GET .../events` response shape — `{ frames: ChatReplayFrame[] }`, not a bare array (docs/tech/chat-webapp.md §2.2 "契约细化"). */
export const conversationEventsListSchema = z.object({
  frames: z.array(chatReplayFrameSchema),
});

export type ChatEventsList = z.infer<typeof conversationEventsListSchema>;

/**
 * Parses one SSE `data:` payload's JSON text into a `ChatReplayFrame`.
 * `JSON.parse`'s stdlib return type is `any` — contained to this one
 * expression by assigning straight into a `zod.safeParse()` call rather than
 * a typed variable, so no `any` value ever escapes this function.
 */
export type ParsedFrameResult =
  { ok: true; frame: ChatReplayFrame } | { ok: false; error: string };

export function parseChatReplayFrame(raw: string): ParsedFrameResult {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      error: `invalid JSON in SSE data: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const result = chatReplayFrameSchema.safeParse(parsedJson);
  if (!result.success) {
    return { ok: false, error: result.error.message };
  }
  return { ok: true, frame: result.data };
}

// ---- Conversation (apps/server's `conversations` row, camelCase over the
// wire — unaffected by the UIMessage-ledger migration) ----

export const conversationStatusSchema = z.enum([
  'active',
  'sleeping',
  'expired',
]);

export type ConversationStatus = z.infer<typeof conversationStatusSchema>;

export const conversationSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  repo: z.string(),
  branchName: z.string(),
  sandboxName: z.string(),
  status: conversationStatusSchema,
  lastActiveAt: z.string(),
  createdAt: z.string(),
});

export type Conversation = z.infer<typeof conversationSchema>;

export const conversationListSchema = z.array(conversationSchema);

// ---- turn 遥测明细（docs/tech/chat-webapp.md §11.4，GET .../turns/{turn}/telemetry） ----

/** 一条遥测事件：`payloadJson` 是服务端收敛后的事件 JSON 原文（形状随 ai 小版本演化，前端按需解析、缺字段跳过，不在这里深度建模）。 */
export const turnTelemetryEventSchema = z.object({
  eventType: z.string(),
  ts: z.number(),
  payloadJson: z.string(),
});

export type TurnTelemetryEvent = z.infer<typeof turnTelemetryEventSchema>;

export const turnTelemetrySchema = z.object({
  events: z.array(turnTelemetryEventSchema),
});
