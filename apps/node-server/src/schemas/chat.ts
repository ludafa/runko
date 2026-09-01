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
//   (`@nimbo/agent`'s `runtime/turn.ts`), no server-invented wrapper events left.
// - Approval visibility is now a `tool-approval-request`/
//   `tool-approval-response` chunk pair `@nimbo/core`'s own loop produces
//   (docs/tech/single-ledger.md §6.1) — the server no longer emits its own `approval.*` events
//   (`@nimbo/agent`'s `runtime/human.ts` 人审通道 bridge is pure in-memory promise
//   routing, no server-emitted events at all).
// - `ask-user` visibility is the `tool-ask-user` part's own
//   `input-available`/`output-available` states (already a normal tool call
//   as far as the loop is concerned) — no `question.*` events either.
// - The turn-starting user message now has a real wire position of its own
//   (closing what used to be a known gap inherited from `@nimbo/core`'s
//   `Session.stream()`, which pushes it onto its own internal ledger but
//   never yields anything for it): `@nimbo/agent`'s `runtime/turn.ts` synthesizes
//   a user `NimboUIMessage` (its own `id`, a single `text` part — chat input
//   is always plain text) *before* it ever starts consuming
//   `session.stream()`, persists it as a `kind = 'message'` row, and
//   broadcasts it as a `MessageFrame` — sharing the exact same monotonic
//   `seq` counter the turn's subsequent chunks use
//   (the turn's `Grant.nextSeq()`), so any listener sees it
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
//   chunk was durable (replayable — `@nimbo/agent`'s `isDurableChunk`); absent ⇔ ephemeral (`text-delta`/`reasoning-delta`/any
//   `transient: true` data part — P13-1's durable/ephemeral split, carried
//   over verbatim) — plus exactly one `MessageFrame` per turn, its very
//   first frame: the synthesized turn-start user message (see above).
// - **Replay** (`GET .../messages`, and `GET .../stream`'s replay-before-tail
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
 * finished (`@nimbo/agent`'s `finalize`), by which point
 * there's no "live" activity left for that turn to broadcast — the one
 * exception is the turn-start synthesized user message, which *is*
 * broadcast live (as the turn's very first frame, `@nimbo/agent`'s
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
 * 一条[排队](../../../../docs/terms.md)中的待发消息（docs/tech/steer-and-queue.md §2.2）
 * ——`conversations.queued_messages_json` 的数组元素，也是 wire 上 `QueueFrame` /
 * 队列端点响应的元素。
 *
 * `userId` 不是冗余镜像 conversation owner：[出队](../../../../docs/terms.md)起轮时
 * [会话级授权](../../../../docs/terms.md)按「本轮发起者」匹配（`conversation-grants.ts`），
 * 必须知道这条消息是谁排的。
 */
export const QueuedMessageSchema = z
  .object({
    id: z.string(),
    text: z.string().min(1),
    userId: z.string(),
    createdAt: z.number().int(),
  })
  .openapi('QueuedMessage');

export type QueuedMessage = z.infer<typeof QueuedMessageSchema>;

/**
 * `{ queue }` — 队列状态快照（docs/tech/steer-and-queue.md §4.3）。两处共用一个形状：
 *
 * - **wire 帧**：[直播流](../../../../docs/terms.md)的第三种帧。刻意**没有 `seq`**——
 *   它不是[账本](../../../../docs/terms.md)事件而是[transient](../../../../docs/terms.md)
 *   档的状态快照（「此刻队列长这样」，重发一次即最新，没有回放价值），因此不落库、
 *   不占 seq、不参与 `after=` 续传。
 * - **队列端点响应**：`DELETE .../queue/{messageId}` 与 `DELETE .../queue` 都返回变更后的
 *   完整快照，调用方一次往返拿到权威状态。
 */
export const queueFrameSchema = z
  .object({ queue: z.array(QueuedMessageSchema) })
  .openapi('ChatQueueFrame');

export type QueueFrame = z.infer<typeof queueFrameSchema>;

/**
 * `{ turnActive }` — [轮状态快照](../../../../docs/terms.md)（docs/tech/chat-webapp.md §5.1）。
 * 与上面的队列快照同构（**没有 `seq`**、不落库、不参与 `after=` 续传），每条
 * `GET .../stream` 在回放之后、进入直播之前必发一帧。
 *
 * **为什么要有这一帧**：在它之前，前端只能**猜**这个会话有没有轮在跑——「历史回放的最后
 * 一帧不是 message 就算在跑」（`use-chat-messages.ts` 的 `lastFrameIsChunk`）。这个猜法在
 * 一轮**崩溃**后就长期失准：崩溃的轮从不跑 `finalizeTurnPersistence`，它的 `kind = 'chunk'`
 * 行永不 GC（`db/schema.ts` 的既有取舍），于是账本最后一行永远是 chunk，此后每次打开这个
 * 会话前端都以为有轮在跑，而且**永不自愈**（翻假只发生在收到收尾 `message-metadata` 时，
 * 那需要一个真在跑的轮）。后果是用户发的消息一律走[排队](../../../../docs/terms.md)、
 * 不再有乐观回显，而且永远等不到[出队](../../../../docs/terms.md)（没有轮会收尾去触发它）；
 * 按[停止](../../../../docs/terms.md)也只会拿到 409。
 *
 * 服务端手上有权威答案（`isTurnActive`），下发它即可。因为**每条**连接都发一帧，任何
 * 「前端与服务端对轮状态的分叉」都会被下一次 tail 连接纠正——不只是打开会话那一刻。
 */
export const turnStateFrameSchema = z
  .object({ turnActive: z.boolean() })
  .openapi('ChatTurnStateFrame');

export type TurnStateFrame = z.infer<typeof turnStateFrameSchema>;

/**
 * Coverage enforcement (same discipline this file has always used for its
 * discriminated unions): every wire frame this app can ever produce is a
 * `ChunkEnvelope`, a `MessageFrame`, a `QueueFrame`, or a `TurnStateFrame` —
 * distinguished by which of `chunk`/`message`/`queue`/`turnActive` the object
 * actually carries (no shared literal discriminant field the way the old
 * `SessionEvent`/`SessionItem` unions had one; the four keys never co-occur on
 * one frame, so structural presence is enough — and zod v4 treats a missing
 * `z.any()` object key as a failure, so a `MessageFrame`/`QueueFrame`/
 * `TurnStateFrame` can't be silently absorbed by `chunkEnvelopeSchema`'s
 * `chunk: z.any()`).
 */
export const chatReplayFrameSchema = z.union([
  chunkEnvelopeSchema,
  messageFrameSchema,
  queueFrameSchema,
  turnStateFrameSchema,
]);

export type ChatReplayFrame =
  ChunkEnvelope | MessageFrame | QueueFrame | TurnStateFrame;

/**
 * `GET .../messages` response shape (docs/tech/chat-webapp.md §2.2 "契约细化", front-end-consumed
 * contract — NOT a bare array): every persisted row for the session, in seq order.
 *
 * **账本里现在只有成品消息。** [进行中草稿](../../../../docs/terms.md)搬进内存之后
 * （`@nimbo/agent`），这一列不再写 `kind = 'chunk'` 行，那套「跑完 GC 掉本轮 chunk」的
 * 逻辑也随之删除。回放因此就是一串 `MessageFrame`；`ChunkEnvelope` 这一支只为**迁移前
 * 留下的存量 chunk 行**保留，读时被 `agent/persistence.ts` 过滤掉。进行中那一轮的草稿
 * 走[直播流](../../../../docs/terms.md)重连补发，不再经这个端点。
 */
export const ConversationMessagesListSchema = z
  .object({ frames: z.array(chatReplayFrameSchema) })
  .openapi('ConversationMessagesList');

export type ConversationMessagesListDto = z.infer<
  typeof ConversationMessagesListSchema
>;

// ---------------------------------------------------------------------------
// Request/response schemas for routes/chat.ts
// ---------------------------------------------------------------------------

/**
 * [skill 清单](../../../../docs/terms.md)的一条（docs/tech/composer-skill-mention.md §5.2）——
 * `name` 是目录名，同时也是 `load-skill` 的入参与 [skill 提及](../../../../docs/terms.md)
 * 的字面量；`description` 是 SKILL.md frontmatter 里那句话，菜单里那行灰字。
 */
export const SkillSummarySchema = z
  .object({
    name: z.string(),
    description: z.string(),
  })
  .openapi('SkillSummary');

export type SkillSummaryDto = z.infer<typeof SkillSummarySchema>;

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
    /** 这个会话的[待发队列](../../../../docs/terms.md)（docs/tech/steer-and-queue.md §4.2）——页面加载时的初始快照，之后由 `QueueFrame` / 队列端点响应刷新。列表端点也带（侧边栏可显示「N 条待发」）。 */
    queuedMessages: z.array(QueuedMessageSchema),
    /**
     * 这个会话当前可选的 [skill 清单](../../../../docs/terms.md)（docs/tech/composer-skill-mention.md
     * §2.1）——[composer](../../../../docs/terms.md) 里打 `/` 时列的就是它。
     *
     * 读的是库缓存（`conversations.available_skills_json`），**不碰沙盒**：休眠中的
     * 会话照样能列菜单，不会为此把沙盒唤醒。代价是最多滞后一轮。列表端点也带，
     * 与 `queuedMessages` 同一姿态——前端拿到会话就拿到菜单，零额外往返。
     */
    availableSkills: z.array(SkillSummarySchema),
    /**
     * 这个会话此刻有没有[轮](../../../../docs/terms.md)在跑——**服务端的权威答案**，
     * 直接读[起轮标记](../../../../docs/terms.md)那一列（`conversations.turn_holder`），
     * 零额外查询。
     *
     * 在它之前前端只能猜（「历史回放的最后一帧是不是 chunk」）。[进行中草稿](../../../../docs/terms.md)
     * 搬进内存之后账本里根本不再有 chunk 行，那个猜测**恒为假**——于是页面刚打开的那几十
     * 毫秒里，一个明明在跑的会话会被当成空闲，用户此时发的消息会去「起新轮」而不是
     * [排队](../../../../docs/terms.md)。有了这个字段就不用猜了。
     */
    turnInProgress: z.boolean(),
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
    /**
     * 这条消息**在已有进行中的一轮时**该走哪条路（docs/tech/steer-and-queue.md §4.1）：
     * `'queue'`（默认）= [排队](../../../../docs/terms.md)到下一轮，`'steer'` =
     * [中途插话](../../../../docs/terms.md)注入当前这一轮。**没有**进行中的一轮时两者
     * 无差别，都是起新一轮——分流规则完全由服务端判定，客户端不预判。
     */
    intent: z.enum(['queue', 'steer']).optional(),
  })
  .openapi('PostChatMessageInput');

/**
 * `POST .../messages`'s 202 body (docs/tech/chat-webapp.md §2.2b): the turn only starts, the
 * steer only lands, or the message only gets queued here — events arrive over
 * `GET .../stream`, not this response. `mode` distinguishes the three ways
 * this request could have been handled: `'started'` — no turn was active for
 * this session, so this kicked off a new one; `'steered'` (STEER-3B) — a turn
 * was already in progress and `text` was injected into it (`Session.steer`);
 * `'queued'` (docs/tech/steer-and-queue.md §4.1) — a turn was in progress and
 * `text` went into the conversation's 待发队列 instead, to be dequeued as the
 * next turn once this one finishes.
 *
 * **曾经有第四档 `'aborted'`，已经取消。** 轮编排搬进 `@nimbo/agent` 之后
 * [起轮占位](../../../../docs/terms.md)成了装配的**第一件事**，所以本端点一登记就返回
 * `'started'`，不再等装配走完——老实现是 ack 卡在装配里，才有机会把它改判成 `aborted`。
 * 装配窗口里按停止的行为没变（照样停），只是那条 ack 说的是 `'started'`，「已停止」这个
 * 结果跟其余情形一样走 `GET .../stream`。框架的 `EnqueueResult` 也只有这三档 + 拒绝。
 */
export const StartTurnAckSchema = z
  .object({
    ok: z.literal(true),
    mode: z.enum(['started', 'steered', 'queued']),
  })
  .openapi('StartTurnAck');

export type StartTurnAck = z.infer<typeof StartTurnAckSchema>;

/**
 * `POST .../abort`'s 200 body（docs/tech/turn-abort.md §3.2）：`ok` 只表示
 * [停止](../../../../docs/terms.md)**已请求**——真正停下的时刻由 agent 当时在做什么
 * 决定（docs/features/turn-abort.md §2.3），而「已停止」这个结果和其它轮收尾一样，
 * 走[直播流](../../../../docs/terms.md)上那条 `status: 'interrupted'` 的
 * `message-metadata` chunk 送达，不在本响应里。
 *
 * `queue` 是清空后的[待发队列](../../../../docs/terms.md)快照（恒为空数组）——停止即
 * 清空队列（本功能定案），带上它让调用方一次往返就拿到权威状态，与
 * `DELETE .../queue*` 返回快照同一姿态。
 */
export const AbortTurnAckSchema = z
  .object({ ok: z.literal(true), queue: z.array(QueuedMessageSchema) })
  .openapi('AbortTurnAck');

export type AbortTurnAck = z.infer<typeof AbortTurnAckSchema>;

export const ConversationParamsSchema = z.object({
  id: z
    .string()
    .openapi({ param: { name: 'id', in: 'path' }, examples: ['3f1b2c4d-...'] }),
});

/** 两个回放端点（`GET .../messages` 与 `GET .../stream`）共用的断线续传游标。 */
export const ConversationReplayQuerySchema = z.object({
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

/** `DELETE .../queue/{messageId}`'s path params（docs/tech/steer-and-queue.md §4.2）：`id` 同 `ConversationParamsSchema`；`messageId` 是[待发队列](../../../../docs/terms.md)条目自己的 `QueuedMessage.id`（入队时 `randomUUID()` 生成，与工具调用的 `callId` 是两个不相干的 id 空间）。 */
export const ChatQueueParamsSchema = z.object({
  id: z
    .string()
    .openapi({ param: { name: 'id', in: 'path' }, examples: ['3f1b2c4d-...'] }),
  messageId: z.string().openapi({
    param: { name: 'messageId', in: 'path' },
    examples: ['9c2e1f70-...'],
  }),
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
 * ——「会话内记住」是纯 chat 层概念（`conversation-grants.ts`），core 不感知。
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

/**
 * `POST .../presence`'s body（[在场](../../../../docs/terms.md)心跳，
 * docs/tech/push-notification.md §5.2）：`focused` = 「此刻这条会话正在这个人眼前」
 * ——页面可见 **且** 窗口聚焦 **且** 路由停在这条会话，三者缺一即为 false。
 *
 * 只有页面自己知道这三件事，所以必须由它上报：服务端能看到的「有没有活的 SSE
 * 连接」在被切到后台的标签页上照样为真，恰恰是最需要通知的情形。
 */
export const PresenceInputSchema = z
  .object({ focused: z.boolean() })
  .openapi('PresenceInput');

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
