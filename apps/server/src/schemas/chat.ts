import { z } from '@hono/zod-openapi';
import type { JsonValue, SessionEvent, SessionItem } from '@nimbo/core';

// ---------------------------------------------------------------------------
// Wire mirror of @nimbo/core's `SessionEvent`/`SessionItem` discriminated
// unions (docs/08-chat-agent-webapp.md §2.2's `{ seq, event }` SSE envelope).
//
// `z.ZodType<T>` annotations (same technique as @nimbo/core's own
// `state.ts`/`types.ts`) only constrain a schema's *input* position — its
// *output* (`z.infer<...>`) is covariant, so a schema that's missing a
// variant still satisfies `z.ZodType<T>` and silently compiles (this bit the
// repo once already: `sessionItemSchema` drifted out of sync with
// `SessionItem` and `tsc` said nothing). Worse: `z.infer<typeof exported>`
// where `exported` is *itself* annotated `z.ZodType<T>` just reads back the
// annotation `T` — the annotation erases the schema's real, narrower
// inferred shape, so a naive coverage check against the annotated export is
// circular and always "passes". Each `*Schema` below is therefore built as
// an **unannotated** `z.union([...])` first (its `z.infer` reflects the true
// structural shape of the branches actually listed) and only wrapped in a
// `z.ZodType<T>`-annotated export afterwards; the `_...CoversAllVariants`
// identity function right after each one checks against the *unannotated*
// value — that's what actually fails to compile when a variant goes missing.
// ---------------------------------------------------------------------------

/**
 * ============================================================
 * Controlled exception: `@nimbo/core`'s own `jsonValueSchema` (a genuinely
 * self-referential `z.lazy`) cannot be used here.
 * ============================================================
 *
 * Feeding it into `@asteasolutions/zod-to-openapi`'s generator — which every
 * schema below eventually is, via `createRoute`'s `request`/`responses` —
 * triggers `RangeError: Maximum call stack size exceeded` (reproduced in
 * isolation: a bare `z.object({ foo: jsonValueSchema })` alone crashes
 * `OpenApiGeneratorV31.generateDocument()`; this generator version has no
 * support for `z.lazy`/recursive schemas at all). `@nimbo/core` isn't ours
 * to change here, and a real `JsonValue` has no non-recursive shape to fall
 * back to for *documentation* purposes without lying about the contract —
 * `z.any()` is the one zod primitive this generator explicitly special-cases
 * as "no constraint" (same branch as `z.unknown()`, see the generator's
 * `transformSchemaWithoutDefault`), i.e. an accurate rendering of "any JSON
 * value" for docs, not a workaround-shaped approximation.
 *
 * The two places this schema appears (`tool_call`'s `input`/`output`) only
 * ever parse a value that has *already* round-tripped through
 * `JSON.parse()` (reading `agent_events.payload_json` back in
 * `routes/chat.ts`) — `JSON.parse()` can only ever produce plain
 * objects/arrays/strings/numbers/booleans/null (never `undefined`,
 * functions, symbols, or cycles), i.e. something that already satisfies
 * `JsonValue` by construction. A schema that always accepts is therefore
 * exactly as strict as the real `jsonValueSchema` would be in this specific
 * post-`JSON.parse` position — nothing is actually lost at the one boundary
 * this file uses it at.
 *
 * The `z.ZodType<JsonValue>` annotation is what keeps this contained: from
 * here down, every consumer sees the precise `JsonValue` type, never `any`
 * — this is the same "isolate the unavoidable escape hatch behind an exact
 * type" pattern `@nimbo/core`'s `state.ts` documents for its own comparable
 * case (`isModelMessage`'s `unknown`-typed guard).
 */
const openApiSafeJsonValueSchema: z.ZodType<JsonValue> = z.any();

const toolOutputSchema = z.union([z.string(), openApiSafeJsonValueSchema]);

const usageSchema = z
  .object({
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    totalTokens: z.number().optional(),
    // 缓存命中的输入 token（DeepSeek 自动前缀缓存），透传自 nimbo Usage
    cachedInputTokens: z.number().optional(),
  })
  .openapi('Usage');

const nimboErrorSchema = z
  .object({
    code: z.enum([
      'max_turns',
      'context_overflow',
      'provider_error',
      'aborted',
    ]),
    message: z.string(),
  })
  .openapi('NimboError');

const sessionItemUnion = z.union([
  z.object({
    id: z.string(),
    type: z.literal('agent_message'),
    text: z.string(),
  }),
  z.object({ id: z.string(), type: z.literal('reasoning'), text: z.string() }),
  z.object({
    id: z.string(),
    type: z.literal('user_message'),
    text: z.string(),
  }),
  z.object({
    id: z.string(),
    type: z.literal('tool_call'),
    toolName: z.string(),
    input: openApiSafeJsonValueSchema,
    output: toolOutputSchema.optional(),
    status: z.enum(['in_progress', 'completed', 'failed', 'denied']),
  }),
  z.object({
    id: z.string(),
    type: z.literal('file_change'),
    changes: z.array(
      z.object({ path: z.string(), kind: z.enum(['add', 'update', 'delete']) }),
    ),
  }),
  z.object({
    id: z.string(),
    type: z.literal('plan_update'),
    items: z.array(z.object({ text: z.string(), completed: z.boolean() })),
  }),
  z.object({ id: z.string(), type: z.literal('error'), message: z.string() }),
]);

/**
 * Coverage enforcement (see file header): every `SessionItem` variant must
 * be assignable to `z.infer<typeof sessionItemUnion>` (the *unannotated*
 * union, not the annotated `sessionItemSchema` export below) — this identity
 * function *is* that assignment, so a schema missing a variant (or narrower
 * than the real one) fails to compile here instead of silently type-checking.
 */
const _sessionItemSchemaCoversAllVariants: (
  item: SessionItem,
) => z.infer<typeof sessionItemUnion> = (item) => item;

export const sessionItemSchema: z.ZodType<SessionItem> = sessionItemUnion;

const sessionEventUnion = z.union([
  z.object({ type: z.literal('session.started'), sessionId: z.string() }),
  z.object({ type: z.literal('turn.started'), turn: z.number() }),
  z.object({ type: z.literal('item.started'), item: sessionItemSchema }),
  z.object({ type: z.literal('item.updated'), item: sessionItemSchema }),
  z.object({ type: z.literal('item.completed'), item: sessionItemSchema }),
  z.object({ type: z.literal('turn.completed'), usage: usageSchema }),
  z.object({ type: z.literal('turn.failed'), error: nimboErrorSchema }),
]);

/** Same coverage enforcement as `_sessionItemSchemaCoversAllVariants`, against the unannotated `sessionEventUnion`, for `SessionEvent`. */
const _sessionEventSchemaCoversAllVariants: (
  event: SessionEvent,
) => z.infer<typeof sessionEventUnion> = (event) => event;

export const sessionEventSchema: z.ZodType<SessionEvent> = sessionEventUnion;

/**
 * Six wire-only members on top of `@nimbo/core`'s `SessionEvent` (docs/08
 * §2.2 "契约细化", P12-2 front-end gap; the approval and question pairs added
 * for the approval/ask_user bridges, docs/08 §2.2c（审批链）): all defined
 * *only* here, never folded into `@nimbo/core`'s own type — that union stays
 * exactly what the SDK produces.
 *
 * - `user.message`: persisted (and pushed) as the very first event of every
 *   turn — without it, a `GET .../events` replay after a page refresh can't
 *   reconstruct what the user actually typed (`session.stream()` only ever
 *   yields the *agent's* events, never echoes the input back).
 * - `turn.result`: the server's own terminal sentinel — now persisted (not
 *   just streamed): the front end folds `turn.completed` into its
 *   `turn.result` rendering, so a replay without the sentinel would render
 *   the last turn without a close-out line.
 * - `approval.requested`/`approval.resolved`: `turn-runner.ts`'s
 *   `requestApproval`/`resolveApproval` (docs/08 §2.2c（审批链）) — a pending
 *   tool call that needs a human, and its eventual outcome (manual decision
 *   or timeout, both funnel through the same `resolveApproval` call so the
 *   two look identical on the wire). Persisted like every other event, so a
 *   reconnecting client can tell whether a request is still pending
 *   (`approval.requested` with no matching `approval.resolved` yet).
 * - `question.asked`/`question.answered`: the `ask_user` tool's own pending
 *   question and its outcome (`turn-runner.ts`'s `requestUserAnswer`/
 *   `resolveUserAnswer`) — structurally the same shape as the approval pair
 *   (register → emit → suspend → settle, manual answer and timeout both
 *   funneling through one settle path), just for "the model needs the user
 *   to say something" instead of "the model needs the user to authorize a
 *   command".
 */
export const userMessageEventSchema = z
  .object({ type: z.literal('user.message'), text: z.string() })
  .openapi('ChatUserMessage');

export type UserMessageEvent = z.infer<typeof userMessageEventSchema>;

/** The server's own terminal sentinel (docs/08 §2.2) — not part of `@nimbo/core`'s `SessionEvent` union, appended (and, per the §2.2 "契约细化" addendum, persisted) once at the end of every turn's stream. */
export const turnResultSentinelSchema = z
  .object({
    type: z.literal('turn.result'),
    finalResponse: z.string(),
    usage: usageSchema,
  })
  .openapi('ChatTurnResult');

export type TurnResultSentinel = z.infer<typeof turnResultSentinelSchema>;

/**
 * `turn-runner.ts`'s own terminal sentinel (docs/08 §2.2b): emitted *instead
 * of* `turn.result` when driving `session.stream()` throws an unexpected
 * error (not the graceful mid-stream `turn.failed` `SessionEvent` above,
 * which `session.stream()` already degrades into a normal `TurnResult` for —
 * that case is a regular event on the union above, always still followed by
 * a `turn.result`). This one deliberately "mirrors" that same `type` literal
 * (docs/08 §2.2b's own wording) despite the different shape (`code`+`message`
 * here vs. a nested `error: NimboError` above) — it plays a structurally
 * different role (turn-ending sentinel, never coexists with `turn.result` in
 * the same turn) and is told apart from the `SessionEvent` member by its
 * shape, not by a distinct literal; consumers narrow on field presence
 * (`'error' in event`), same as `use-chat-messages.ts`/`timeline.ts` do on
 * the wire's client side.
 */
export const turnFailedSentinelSchema = z
  .object({
    type: z.literal('turn.failed'),
    code: z.string(),
    message: z.string(),
  })
  .openapi('ChatTurnFailed');

export type TurnFailedSentinel = z.infer<typeof turnFailedSentinelSchema>;

/**
 * `turn-runner.ts`'s `requestApproval` (docs/08 §2.2c（审批链）): emitted the
 * moment a tool call escalates to the session's `onApproval` bridge and
 * actually needs a human — `input` is the already-`inputSchema`-validated
 * argument object the tool call would run with (`packages/core/src/runtime.ts`'s
 * `executeToolCall` validates before evaluating approval), reusing
 * `openApiSafeJsonValueSchema` for the same reason `tool_call`'s `input`
 * above does.
 */
export const approvalRequestedEventSchema = z
  .object({
    type: z.literal('approval.requested'),
    callId: z.string(),
    toolName: z.string(),
    input: openApiSafeJsonValueSchema,
  })
  .openapi('ChatApprovalRequested');

export type ApprovalRequestedEvent = z.infer<
  typeof approvalRequestedEventSchema
>;

/**
 * `turn-runner.ts`'s `resolveApproval` (docs/08 §2.2c（审批链）): the outcome
 * of a previously-requested approval, however it was reached (a human's
 * `POST .../approvals/:callId`, or `requestApproval`'s own timeout deny) —
 * `message` is only ever present on a `deny` (the human's rejection reason,
 * or the timeout's own explanatory text); an `allow` never carries one.
 */
export const approvalResolvedEventSchema = z
  .object({
    type: z.literal('approval.resolved'),
    callId: z.string(),
    behavior: z.enum(['allow', 'deny']),
    message: z.string().optional(),
  })
  .openapi('ChatApprovalResolved');

export type ApprovalResolvedEvent = z.infer<typeof approvalResolvedEventSchema>;

/**
 * `turn-runner.ts`'s `requestUserAnswer` (docs/08 §2.2c（审批链）): emitted the
 * moment the `ask_user` tool (`chat-agent.ts`) is called and actually
 * suspends the turn — `options`, when the model supplied any, are quick-reply
 * suggestions for the human, not a closed set (a free-text `answer` is always
 * valid too, see `PostAnswerInputSchema`).
 */
export const questionAskedEventSchema = z
  .object({
    type: z.literal('question.asked'),
    callId: z.string(),
    question: z.string(),
    options: z.array(z.string()).optional(),
  })
  .openapi('ChatQuestionAsked');

export type QuestionAskedEvent = z.infer<typeof questionAskedEventSchema>;

/**
 * `turn-runner.ts`'s `resolveUserAnswer` (docs/08 §2.2c（审批链）): the outcome
 * of a previously-asked question — `answer` only ever appears when
 * `outcome === 'answered'` (a human's `POST .../questions/:callId`); a
 * `'timeout'` outcome (`requestUserAnswer`'s own timeout) never carries one,
 * mirroring how `approval.resolved`'s `message` is deny-only.
 */
export const questionAnsweredEventSchema = z
  .object({
    type: z.literal('question.answered'),
    callId: z.string(),
    outcome: z.enum(['answered', 'timeout']),
    answer: z.string().optional(),
  })
  .openapi('ChatQuestionAnswered');

export type QuestionAnsweredEvent = z.infer<typeof questionAnsweredEventSchema>;

/** Everything that can appear as the `event` half of the `{ seq, event }` envelope: a `SessionEvent`, the `user.message` echo, the `turn.result`/`turn.failed` sentinels, or the approval/ask_user bridge pairs. */
export type ChatStreamEvent =
  | SessionEvent
  | UserMessageEvent
  | TurnResultSentinel
  | TurnFailedSentinel
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | QuestionAskedEvent
  | QuestionAnsweredEvent;

const chatStreamEventUnion = z.union([
  sessionEventSchema,
  userMessageEventSchema,
  turnResultSentinelSchema,
  turnFailedSentinelSchema,
  approvalRequestedEventSchema,
  approvalResolvedEventSchema,
  questionAskedEventSchema,
  questionAnsweredEventSchema,
]);

/** Same coverage enforcement as `_sessionEventSchemaCoversAllVariants`, against the unannotated `chatStreamEventUnion`, for `ChatStreamEvent`. */
const _chatStreamEventSchemaCoversAllVariants: (
  event: ChatStreamEvent,
) => z.infer<typeof chatStreamEventUnion> = (event) => event;

export const chatStreamEventSchema: z.ZodType<ChatStreamEvent> =
  chatStreamEventUnion;

/**
 * `seq` is a two-layer signal (docs/08 §2.2d, "transcript 减量：durable/
 * ephemeral 分层"): **present ⇔ this envelope was persisted and is replayable**
 * (`agent_events`, `GET .../stream?after=<seq>`'s continuation cursor);
 * **absent ⇔ an ephemeral live-only frame** — today exactly `item.updated`'s
 * per-tick "accumulated text so far" (`createEmitWire` in turn-runner.ts
 * broadcasts it straight to subscribers without persisting or consuming a
 * seq number). A reconnecting client only ever needs the seq'd envelopes to
 * pick its `after=` cursor and dedupe overlap; ephemeral frames exist purely
 * for the live typewriter effect and vanish on reconnect (the next
 * `item.completed` — always seq'd — resettles the item's final text).
 */
export const chatEventEnvelopeSchema = z
  .object({
    seq: z.number().int().optional(),
    event: chatStreamEventSchema,
  })
  .openapi('ChatEventEnvelope');

export type ChatEventEnvelope = z.infer<typeof chatEventEnvelopeSchema>;

/**
 * `GET .../events` response shape (docs/08 §2.2 "契约细化", front-end-consumed
 * contract — NOT a bare array). Reuses `chatEventEnvelopeSchema` as-is rather
 * than a seq-required variant: this route only ever reads back persisted
 * `agent_events` rows (docs/08 §2.2d), so every envelope it returns carries a
 * `seq` in practice — the shared schema's `seq` being *typed* optional is
 * just the envelope shape's general contract, not a claim that this
 * particular endpoint ever omits one.
 */
export const ChatEventsListSchema = z
  .object({ events: z.array(chatEventEnvelopeSchema) })
  .openapi('ChatEventsList');

export type ChatEventsListDto = z.infer<typeof ChatEventsListSchema>;

// ---------------------------------------------------------------------------
// Request/response schemas for routes/chat.ts
// ---------------------------------------------------------------------------

export const ChatSessionSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    repo: z.string(),
    branchName: z.string(),
    sandboxName: z.string(),
    status: z.enum(['active', 'sleeping', 'expired']),
    lastActiveAt: z.string(),
    createdAt: z.string(),
  })
  .openapi('ChatSession');

export type ChatSessionDto = z.infer<typeof ChatSessionSchema>;

export const CreateChatSessionInputSchema = z
  .object({
    title: z.string().min(1).max(255).optional(),
  })
  .openapi('CreateChatSessionInput');

export const PostChatMessageInputSchema = z
  .object({
    text: z.string().min(1),
  })
  .openapi('PostChatMessageInput');

/**
 * `POST .../messages`'s 202 body (docs/08 §2.2b): the turn only starts or
 * the steer only lands here — events arrive over `GET .../stream`, not this
 * response. `mode` (STEER-3B) distinguishes the two ways this request could
 * have been handled: `'started'` — no turn was active for this session, so
 * this kicked off a new one; `'steered'` — a turn was already in progress
 * and `text` was injected into it (`Session.steer`) instead of starting
 * another. See docs/08 §2.2 "契约细化" #3 for the wire-level consequence
 * (`'steered'` never gets its own `user.message` echo).
 */
export const StartTurnAckSchema = z
  .object({ ok: z.literal(true), mode: z.enum(['started', 'steered']) })
  .openapi('StartTurnAck');

export type StartTurnAck = z.infer<typeof StartTurnAckSchema>;

export const ChatSessionParamsSchema = z.object({
  id: z
    .string()
    .openapi({ param: { name: 'id', in: 'path' }, examples: ['3f1b2c4d-...'] }),
});

export const ChatEventsQuerySchema = z.object({
  after: z.coerce
    .number()
    .int()
    .nonnegative()
    .optional()
    .openapi({ param: { name: 'after', in: 'query' } }),
});

/**
 * `POST .../approvals/{callId}`'s path params (docs/08 §2.2c（审批链）): `id`
 * is the chat session, `callId` the pending tool call's own id
 * (`ApprovalContext.callId`, echoed on `approval.requested`). Also reused
 * as-is for `POST .../questions/{callId}` (identical id+callId shape, same
 * `callId` namespace — `ToolContext.callId` — just for the `ask_user` tool
 * call instead of a gated one); no naming/param conflict, since each
 * `createRoute` renders its own inline parameter list (same pattern
 * `ChatSessionParamsSchema` already sets across four other routes).
 */
export const ChatApprovalParamsSchema = z.object({
  id: z
    .string()
    .openapi({ param: { name: 'id', in: 'path' }, examples: ['3f1b2c4d-...'] }),
  callId: z
    .string()
    .openapi({ param: { name: 'callId', in: 'path' }, examples: ['call_1'] }),
});

/** `POST .../approvals/{callId}`'s body (docs/08 §2.2c（审批链）): a human's decision on a pending tool call — `message` is only meaningful (and optional) on `deny`, ignored on `allow`. */
export const PostApprovalInputSchema = z
  .object({
    behavior: z.enum(['allow', 'deny']),
    message: z.string().optional(),
  })
  .openapi('PostApprovalInput');

/**
 * `POST .../approvals/{callId}`'s 200 body — the decision itself already went
 * out over `GET .../stream` as `approval.resolved`, so this is just an ack.
 * Also reused for `POST .../questions/{callId}`'s 200 (its own outcome
 * likewise already went out as `question.answered`) — same "just an ack,
 * `{ ok: true }`" shape, no reason for a second identical schema.
 */
export const ApprovalAckSchema = z
  .object({ ok: z.literal(true) })
  .openapi('ApprovalAck');

export type ApprovalAck = z.infer<typeof ApprovalAckSchema>;

/** `POST .../questions/{callId}`'s body (docs/08 §2.2c（审批链）): a human's free-text answer to a pending `ask_user` question — always required (unlike `PostApprovalInputSchema`'s optional deny `message`, there is no "answer with nothing" case here). */
export const PostAnswerInputSchema = z
  .object({
    answer: z.string().min(1),
  })
  .openapi('PostAnswerInput');
