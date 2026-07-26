/**
 * Wire-level schemas for the chat agent API (docs/tech/chat-webapp.md
 * §2.2, docs/tech/single-ledger.md §5/§6 "UIMessage 单账本" — P13-5-4
 * migration). The old `SessionEvent`/`SessionItem` mirror (`sessionItemSchema`/
 * `sessionEventSchema`) plus every server-invented wire sentinel built on top
 * of it (`user.message`, `turn.result`/`turn.failed`,
 * `approval.requested`/`approval.resolved`, `question.asked`/
 * `question.answered`) are retired — `@nimbo/core` no longer exports
 * `SessionEvent`/`SessionItem` at all (see that package's `state.ts`), and
 * `apps/node-server`'s own `schemas/chat.ts` (already migrated, P13-5-3) confirms
 * there's nothing left to mirror them with.
 *
 * The wire is now a stream of `ChatReplayFrame`s — a `ChunkEnvelope`
 * (`{ seq?, chunk }`, `seq` present ⇔ durable/replayable) or a `MessageFrame`
 * (`{ seq, message }`, only ever appears in replay, a finished
 * `NimboUIMessage` verbatim) — see `apps/node-server/src/schemas/chat.ts`'s own
 * file header for the full rationale (this file's frame shapes are a
 * hand-written mirror of that server-side zod, not the kubb-generated
 * `gen/zod/chatChunkEnvelopeSchema.ts`/`chatMessageFrameSchema.ts`: kubb
 * infers `chunk`/`message` as bare `z.any()` from the OpenAPI `{}` schema
 * `apps/node-server` emits for them — see that file's own "controlled exception"
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

// ---- ChatReplayFrame (apps/node-server's `schemas/chat.ts`) ----

/**
 * Controlled exception (same rationale as `apps/node-server/src/schemas/chat.ts`'s
 * own `nimboChunkSchema`/`nimboUIMessageSchema`): `NimboChunk`/`NimboUIMessage`
 * (ai's `UIMessageChunk`/`UIMessage`, instantiated in `@nimbo/core`'s
 * `state.ts`) have no zod schema this file can reuse — `z.any()` is the same
 * escape hatch this file has always used for structurally-unschemaable
 * external types (`jsonValueSchema` above didn't need it, but this repo's
 * `apps/node-server` established the pattern for exactly this case), contained by
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
 * 一条[排队](../../../../../docs/terms.md)中的待发消息（`apps/node-server` 的
 * `schemas/chat.ts` `QueuedMessageSchema` 的手写镜像，docs/tech/steer-and-queue.md §2.2）。
 */
export const queuedMessageSchema = z.object({
  id: z.string(),
  text: z.string(),
  userId: z.string(),
  createdAt: z.number(),
});

export type QueuedMessage = z.infer<typeof queuedMessageSchema>;

/**
 * `{ queue }` — 队列状态快照。两处共用：直播流的第三种帧（每条连接回放后必发一帧，
 * 队列变化时再广播；**没有 `seq`**，因为它是状态快照而非[账本](../../../../../docs/terms.md)
 * 事件，docs/tech/steer-and-queue.md §4.3），以及两个队列端点的响应体。
 */
export const queueFrameSchema = z.object({
  queue: z.array(queuedMessageSchema),
});

export type QueueFrame = z.infer<typeof queueFrameSchema>;

/**
 * `POST .../abort` 的响应（`apps/node-server` 的 `AbortTurnAckSchema` 的手写镜像，
 * docs/tech/turn-abort.md §3.2）：`ok` 只表示[停止](../../../../../docs/terms.md)**已
 * 请求**，「已停止」这个结果照旧走直播流上那条 `status: 'interrupted'` 的
 * `message-metadata`；`queue` 是清空后的队列快照（恒为空数组，停止即清空队列）。
 */
export const abortTurnAckSchema = z.object({
  ok: z.literal(true),
  queue: z.array(queuedMessageSchema),
});

/**
 * Every wire frame this app can ever receive is a `ChunkEnvelope`, a
 * `MessageFrame`, or a `QueueFrame` — told apart structurally (which of
 * `chunk`/`message`/`queue` the object actually carries), same discipline
 * `apps/node-server`'s own `chatReplayFrameSchema` uses (no shared literal
 * discriminant field). 顺序无关紧要：zod v4 里 object schema 缺失的 `z.any()`
 * 字段算校验失败，所以三支互不吞并（服务端同一份注释）。
 */
export const chatReplayFrameSchema = z.union([
  chunkEnvelopeSchema,
  messageFrameSchema,
  queueFrameSchema,
]);

export type ChatReplayFrame = ChunkEnvelope | MessageFrame | QueueFrame;

/** 会进[账本](../../../../../docs/terms.md)物化的两支——`QueueFrame` 不属于账本，由 `use-chat-messages.ts` 在喂给 `MessageLedger` 之前就分流掉。 */
export type LedgerFrame = ChunkEnvelope | MessageFrame;

/** 参数取最宽的 `ChatReplayFrame`（而不是 `LedgerFrame`）——同一个判别在两处都要用：`MessageLedger` 里对已分流的账本帧，和还没分流的原始 wire 帧上。传 `LedgerFrame` 时 false 分支照样收窄到 `ChunkEnvelope`。 */
export function isMessageFrame(frame: ChatReplayFrame): frame is MessageFrame {
  return 'message' in frame;
}

export function isQueueFrame(frame: ChatReplayFrame): frame is QueueFrame {
  return 'queue' in frame;
}

/**
 * 一个帧的 `seq`——`QueueFrame` **恒无 seq**（它是[待发队列](../../../../../docs/terms.md)
 * 的状态快照，不是[账本](../../../../../docs/terms.md)事件，所以不落盘、不参与
 * `after=` 续传；docs/tech/steer-and-queue.md §4.3），于是与 ephemeral chunk 在
 * 去重/续传簿记上走同一条「没有 seq」的路径。
 */
export function frameSeq(frame: ChatReplayFrame): number | undefined {
  return isQueueFrame(frame) ? undefined : frame.seq;
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

// ---- Conversation (apps/node-server's `conversations` row, camelCase over the
// wire — unaffected by the UIMessage-ledger migration) ----

export const conversationStatusSchema = z.enum([
  'active',
  'sleeping',
  'expired',
]);

export type ConversationStatus = z.infer<typeof conversationStatusSchema>;

/** 沙盒 provider（docs/tech/sandbox-provider.md）——这次会话跑在哪家云沙盒上，建会话时选定、1:1 绑定。 */
export const conversationProviderSchema = z.enum(['vercel', 'e2b']);

export type ConversationProvider = z.infer<typeof conversationProviderSchema>;

/**
 * [skill 清单](../../../../../docs/terms.md)的一条（docs/tech/composer-skill-mention.md §5.2）——
 * [composer](../../../../../docs/terms.md) 里打 `/` 时列的就是它：`name` 上屏做
 * [skill 提及](../../../../../docs/terms.md)的字面量，`description` 是菜单里那行灰字。
 */
export const skillSummarySchema = z.object({
  name: z.string(),
  description: z.string(),
});

export type SkillSummary = z.infer<typeof skillSummarySchema>;

export const conversationSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  repo: z.string(),
  branchName: z.string(),
  sandboxName: z.string(),
  provider: conversationProviderSchema,
  status: conversationStatusSchema,
  lastActiveAt: z.string(),
  /** 这个会话的[待发队列](../../../../../docs/terms.md)——页面加载时的初始快照，之后由 `QueueFrame` 与队列端点响应刷新（docs/tech/steer-and-queue.md §4.2）。 */
  queuedMessages: z.array(queuedMessageSchema),
  /**
   * 这个会话当前可选的 [skill 清单](../../../../../docs/terms.md)（docs/tech/composer-skill-mention.md §2.1）。
   *
   * `.default([])` 不是可有可无的宽容：服务端读的是库缓存列，会话建于本功能上线前、
   * 或那一列坏掉时都会给出空清单，前端这边应当照常渲染一个「没有 skill 可选」的
   * composer，而不是整页 parse 失败。
   */
  availableSkills: z.array(skillSummarySchema).default([]),
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
