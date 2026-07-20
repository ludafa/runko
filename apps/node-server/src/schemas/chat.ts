import { z } from '@hono/zod-openapi';
import type { NimboChunk, NimboUIMessage } from '@nimbo/core';

// ---------------------------------------------------------------------------
// Wire vocabulary for the chat app's SSE stream + replay endpoints
// (docs/tech/chat-webapp.md §2.2, docs/tech/single-ledger.md §5
// 单-3 "UIMessage 单账本" / §6 三值审批).
//
// The old `SessionEvent`/`SessionItem` mirror unions, the `user.message`/
// `turn.result`/`turn.failed` sentinels, and the `approval.requested`/
// `approval.resolved`/`question.asked`/`question.answered` bridge-event pairs
// are ALL gone (docs/tech/single-ledger.md §5 单-3 施工要点):
//
// - `session.stream()` now yields `NimboChunk` (ai's `UIMessageChunk`
//   vocabulary, instantiated for `NimboUIMessage` — `@nimbo/core`'s
//   `state.ts`) directly — the wire's live tail forwards these verbatim
//   (`turn-runner.ts`'s `driveTurn`), no server-invented wrapper events left.
// - Approval visibility is now a `tool-approval-request`/
//   `tool-approval-response` chunk pair `@nimbo/core`'s own loop produces
//   (docs/tech/single-ledger.md §6.1) — the server no longer emits its own `approval.*` events
//   (`turn-runner.ts`'s 人审通道 bridge, `requestReview`/`resolveReview`, is
//   pure in-memory promise routing now, no `TurnEmitter` calls at all).
// - `ask-user` visibility is the `tool-ask-user` part's own
//   `input-available`/`output-available` states (already a normal tool call
//   as far as the loop is concerned) — no `question.*` events either.
// - The turn-starting user message now has a real wire position of its own
//   (closing what used to be a known gap inherited from `@nimbo/core`'s
//   `Session.stream()`, which pushes it onto its own internal ledger but
//   never yields anything for it): `turn-runner.ts`'s `driveTurn` synthesizes
//   a user `NimboUIMessage` (its own `id`, a single `text` part — chat input
//   is always plain text) *before* it ever starts consuming
//   `session.stream()`, persists it as a `kind = 'message'` row, and
//   broadcasts it as a `MessageFrame` — sharing the exact same monotonic
//   `seq` counter the turn's subsequent chunks use
//   (`turn-runner.ts`'s `createTurnEmitter`), so any listener sees it
//   strictly before anything else from that turn. `finalizeTurnPersistence`
//   skips over `@nimbo/core`'s own (structurally-identical, different-`id`)
//   copy of that same message when persisting the turn's newly-appended
//   messages, so it's written exactly once, under the synthesized `id` (see
//   that function's own doc comment). `steer()`'s queued messages are
//   unaffected by this — they still only ever reach the wire via their own
//   real `start`/`text-*`/`finish` chunk sequence (`loop.ts`'s
//   `drainSteerMessages`), never a `MessageFrame`.
//
// What replaces them, over the wire:
//
// - **Live tail** (`GET .../stream`, its non-replay portion): mostly a
//   stream of `ChunkEnvelope`s (`{ seq?, chunk }`) — `seq` present ⇔ this
//   chunk was durable (persisted, replayable — `turn-runner.ts`'s
//   `isDurableChunk`); absent ⇔ ephemeral (`text-delta`/`reasoning-delta`/any
//   `transient: true` data part — P13-1's durable/ephemeral split, carried
//   over verbatim) — plus exactly one `MessageFrame` per turn, its very
//   first frame: the synthesized turn-start user message (see above).
// - **Replay** (`GET .../events`, and `GET .../stream`'s replay-before-tail
//   portion): a sequence of `ChatReplayFrame`s, each *either* a
//   `ChunkEnvelope` (a still-`kind = 'chunk'` row — the in-progress or
//   crashed turn's durable chunks) *or* a `MessageFrame` (`{ seq, message }`
//   — a `kind = 'message'` row, one finished `NimboUIMessage` verbatim).
//   Finished history never needs chunk replay at all: a `NimboUIMessage` is
//   already exactly the shape a chat UI's message list holds, so the client
//   splices `MessageFrame`s straight in; only the (at most one) turn still
//   in progress needs its `ChunkEnvelope`s fed through the official
//   incremental UIMessage-from-chunks builder (ai's `readUIMessageStream` or
//   equivalent) to materialize on top of that history. See this ticket's
//   report for why this two-frame-kind design was chosen over synthesizing
//   a fake chunk sequence for every finished message.
// ---------------------------------------------------------------------------

/**
 * ============================================================
 * Controlled exception (same rationale/pattern as this file always used for
 * `@nimbo/core`'s recursive `JsonValue`, before the SessionEvent/SessionItem
 * era retired that usage): `NimboChunk`/`NimboUIMessage` (ai's
 * `UIMessageChunk`/`UIMessage`, instantiated in `@nimbo/core`'s `state.ts`)
 * have no zod schema this file can reuse for `@asteasolutions/zod-to-openapi`
 * generation (this file's `createRoute` machinery, via `request`/`responses`).
 * ============================================================
 *
 * ai@7 *does* export a runtime schema for the base (non-instantiated)
 * `UIMessageChunk` — `uiMessageChunkSchema` — but it's a `LazySchema` (a
 * `@ai-sdk/provider-utils` "standard schema" wrapper, built for ai's own
 * internal validation, not a zod schema `zod-to-openapi` can walk), and it's
 * parameterized over the *generic* `UIMessageChunk<unknown, UIDataTypes>`
 * shape anyway (`messageMetadata: unknown`, arbitrary `data-${string}`
 * parts) — not nimbo's own `NimboMessageMetadata`/`NimboDataParts`
 * instantiation, and there's no way to hand it those without reimplementing
 * it. `@nimbo/core`'s own `state.ts` hit the identical wall for
 * `NimboUIMessage` and settled on "shallow structural `z.custom` + delegate
 * deep validation to `validateUIMessages()`" — but that's a *validator*, not
 * an OpenAPI-documentable schema shape either.
 *
 * `z.any()` is the same escape hatch this file already used for
 * `JsonValue` pre-migration: the one zod primitive `zod-to-openapi`
 * explicitly treats as "no constraint" (documenting "any ai SDK chunk/
 * message" honestly, not a workaround-shaped approximation), contained by a
 * `z.ZodType<T>` annotation so every consumer of the exported schema still
 * sees the precise TypeScript type — `any` never actually leaks past this
 * one declaration. The two places these appear (`ChunkEnvelope.chunk`,
 * `MessageFrame.message`) only ever parse a value that has already
 * round-tripped through `JSON.parse()` (reading `conversation_events.payload_json`
 * back, or `session.stream()`'s own already-typed `NimboChunk` output),
 * exactly the same "post-`JSON.parse`, already `JsonValue`-shaped" position
 * this file's old `openApiSafeJsonValueSchema` lived at.
 */
const nimboChunkSchema: z.ZodType<NimboChunk> = z.any();

/** Same rationale as `nimboChunkSchema` above, for `NimboUIMessage` (`MessageFrame.message`). */
const nimboUIMessageSchema: z.ZodType<NimboUIMessage> = z.any();

/**
 * `{ seq?, chunk }` — the live tail's own wire shape (docs/tech/chat-webapp.md §2.2d's
 * durable/ephemeral split, carried over verbatim per docs/tech/single-ledger.md §5 单-3's
 * "写入时序": every chunk either persists-then-broadcasts (`seq` present) or
 * only-ever-broadcasts (`seq` absent)) — also reused, with `seq` always
 * present, for a replayed `kind = 'chunk'` row (see file header).
 */
export const chunkEnvelopeSchema = z
  .object({
    seq: z.number().int().optional(),
    chunk: nimboChunkSchema,
  })
  .openapi('ChatChunkEnvelope');

export type ChunkEnvelope = z.infer<typeof chunkEnvelopeSchema>;

/**
 * `{ seq, message }` — usually replay-only (see file header): a finished
 * `NimboUIMessage`, read back verbatim from a `kind = 'message'` row. Most
 * `kind = 'message'` rows are only ever written once a turn has already
 * finished (`turn-runner.ts`'s `finalizeTurnPersistence`), by which point
 * there's no "live" activity left for that turn to broadcast — the one
 * exception is the turn-start synthesized user message, which *is*
 * broadcast live (as the turn's very first frame, `turn-runner.ts`'s
 * `driveTurn`) the same instant it's persisted, precisely so a client never
 * has to guess at its own just-sent message's final wire shape.
 */
export const messageFrameSchema = z
  .object({
    seq: z.number().int(),
    message: nimboUIMessageSchema,
  })
  .openapi('ChatMessageFrame');

export type MessageFrame = z.infer<typeof messageFrameSchema>;

/**
 * Coverage enforcement (same discipline this file has always used for its
 * discriminated unions): every wire frame this app can ever produce is
 * *either* a `ChunkEnvelope` *or* a `MessageFrame` — distinguished by which
 * of `chunk`/`message` the object actually carries (no shared literal
 * discriminant field the way the old `SessionEvent`/`SessionItem` unions had
 * one; a `chunk` key and a `message` key never both appear on the same
 * frame, so structural presence is enough).
 */
export const chatReplayFrameSchema = z.union([
  chunkEnvelopeSchema,
  messageFrameSchema,
]);

export type ChatReplayFrame = ChunkEnvelope | MessageFrame;

/**
 * `GET .../events` response shape (docs/tech/chat-webapp.md §2.2 "契约细化", front-end-consumed
 * contract — NOT a bare array): every persisted row for the session, in seq
 * order — thanks to `store.ts`'s `deleteChunkEventsAfter` GC running at the
 * end of every gracefully-finished turn, this is already exactly "finished
 * message history + the in-progress (or crashed) turn's durable chunks"
 * (docs/tech/single-ledger.md §5 单-3's replay algorithm) with no extra filtering needed on the
 * way out.
 */
export const ConversationEventsListSchema = z
  .object({ frames: z.array(chatReplayFrameSchema) })
  .openapi('ConversationEventsList');

export type ConversationEventsListDto = z.infer<
  typeof ConversationEventsListSchema
>;

// ---------------------------------------------------------------------------
// Request/response schemas for routes/chat.ts
// ---------------------------------------------------------------------------

export const ConversationSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    repo: z.string(),
    branchName: z.string(),
    sandboxName: z.string(),
    /** 沙盒 provider（docs/tech/sandbox-provider.md）——前端据此渲染 provider 徽标。 */
    provider: z.enum(['vercel', 'e2b']),
    status: z.enum(['active', 'sleeping', 'expired']),
    lastActiveAt: z.string(),
    createdAt: z.string(),
  })
  .openapi('Conversation');

export type ConversationDto = z.infer<typeof ConversationSchema>;

export const CreateConversationInputSchema = z
  .object({
    title: z.string().min(1).max(255).optional(),
    /** 这次会话用哪家沙盒；省略时落服务端默认 `SANDBOX_PROVIDER`（未配则 `vercel`）。docs/tech/sandbox-provider.md §6。 */
    provider: z.enum(['vercel', 'e2b']).optional(),
  })
  .openapi('CreateConversationInput');

export const PostChatMessageInputSchema = z
  .object({
    text: z.string().min(1),
  })
  .openapi('PostChatMessageInput');

/**
 * `POST .../messages`'s 202 body (docs/tech/chat-webapp.md §2.2b): the turn only starts or
 * the steer only lands here — events arrive over `GET .../stream`, not this
 * response. `mode` (STEER-3B) distinguishes the two ways this request could
 * have been handled: `'started'` — no turn was active for this session, so
 * this kicked off a new one; `'steered'` — a turn was already in progress
 * and `text` was injected into it (`Session.steer`) instead of starting
 * another.
 */
export const StartTurnAckSchema = z
  .object({ ok: z.literal(true), mode: z.enum(['started', 'steered']) })
  .openapi('StartTurnAck');

export type StartTurnAck = z.infer<typeof StartTurnAckSchema>;

export const ConversationParamsSchema = z.object({
  id: z
    .string()
    .openapi({ param: { name: 'id', in: 'path' }, examples: ['3f1b2c4d-...'] }),
});

export const ConversationEventsQuerySchema = z.object({
  after: z.coerce
    .number()
    .int()
    .nonnegative()
    .optional()
    .openapi({ param: { name: 'after', in: 'query' } }),
});

/**
 * `POST .../approvals/{callId}`'s path params (docs/tech/chat-webapp.md §2.2c（审批链）): `id`
 * is the chat session, `callId` the pending tool call's own id
 * (`@nimbo/core`'s `ApprovalContext.callId`, carried on the
 * `tool-approval-request` chunk as `approvalId`). Also reused as-is for
 * `POST .../questions/{callId}` (identical id+callId shape, same `callId`
 * namespace — `ToolContext.callId` — just for the `ask-user` tool call
 * instead of a gated one); no naming/param conflict, since each
 * `createRoute` renders its own inline parameter list (same pattern
 * `ConversationParamsSchema` already sets across four other routes).
 */
export const ChatApprovalParamsSchema = z.object({
  id: z
    .string()
    .openapi({ param: { name: 'id', in: 'path' }, examples: ['3f1b2c4d-...'] }),
  callId: z
    .string()
    .openapi({ param: { name: 'callId', in: 'path' }, examples: ['call_1'] }),
});

/**
 * `POST .../approvals/{callId}`'s body (docs/tech/chat-webapp.md §2.2c（审批链）, docs/tech/single-ledger.md §6.3
 * 人工裁决): a human's decision on a pending tool call — `message` is only
 * meaningful (and optional) on `deny` (the rejection reason, 回填模型), ignored
 * on `allow`/`allow-session`.
 *
 * `allow-session` = 会话级授权（docs/terms.md §四）：放行本次 **并且** 记住这次
 * 具体调用 (tool + 入参指纹)，本会话内相同调用后续直接放行、不再弹卡片。对
 * `@nimbo/core` 而言它和 `allow` 无异（都映射成 `HumanDecision.{behavior:'allow'}`）
 * ——「会话内记住」是纯 chat 层概念（`session-grants.ts`），core 不感知。
 */
export const PostApprovalInputSchema = z
  .object({
    behavior: z.enum(['allow', 'allow-session', 'deny']),
    message: z.string().optional(),
  })
  .openapi('PostApprovalInput');

/**
 * `POST .../approvals/{callId}`'s 200 body — the decision itself now only
 * ever reaches the client via the live tail's own `tool-approval-response`
 * chunk (`@nimbo/core`'s loop produces it once `onReview` resolves — the
 * server no longer emits a bridge event of its own, see file header), so
 * this is purely an ack. Also reused for `POST .../questions/{callId}`'s 200
 * (its own outcome likewise now only ever surfaces as the `ask-user` tool
 * part's `output-available` state) — same "just an ack, `{ ok: true }`"
 * shape, no reason for a second identical schema.
 */
export const ApprovalAckSchema = z
  .object({ ok: z.literal(true) })
  .openapi('ApprovalAck');

export type ApprovalAck = z.infer<typeof ApprovalAckSchema>;

/** `POST .../questions/{callId}`'s body (docs/tech/chat-webapp.md §2.2c（审批链）): a human's free-text answer to a pending `ask-user` question — always required (unlike `PostApprovalInputSchema`'s optional deny `message`, there is no "answer with nothing" case here). */
export const PostAnswerInputSchema = z
  .object({
    answer: z.string().min(1),
  })
  .openapi('PostAnswerInput');

/** `GET .../turns/{turn}/telemetry`'s path params（docs/tech/chat-webapp.md §11.4）：`id` 同 `ConversationParamsSchema`；`turn` 是账本 metadata 里的轮次号（1 起）。 */
export const TurnTelemetryParamsSchema = z.object({
  id: z
    .string()
    .openapi({ param: { name: 'id', in: 'path' }, examples: ['3f1b2c4d-...'] }),
  turn: z.coerce
    .number()
    .int()
    .min(1)
    .openapi({ param: { name: 'turn', in: 'path' }, examples: [1] }),
});

/**
 * 一条遥测事件（docs/tech/chat-webapp.md §11.4）：`payloadJson` 保持字符串原样
 * 透传（收敛后的事件 JSON，形状随 ai 小版本演化，服务端不做二次建模），
 * 前端自行 `JSON.parse` 按需取字段。
 */
export const TurnTelemetryEventSchema = z
  .object({
    eventType: z.string(),
    ts: z.number(),
    payloadJson: z.string(),
  })
  .openapi('TurnTelemetryEvent');

/** `GET .../turns/{turn}/telemetry`'s 200 body——遥测缺席（未启用/该轮无数据/会话尚无 nimbo header）一律空数组，不是错误。 */
export const TurnTelemetrySchema = z
  .object({ events: z.array(TurnTelemetryEventSchema) })
  .openapi('TurnTelemetry');

export type TurnTelemetryDto = z.infer<typeof TurnTelemetrySchema>;
