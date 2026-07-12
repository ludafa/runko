/**
 * Wire-level schemas for the chat agent API (docs/08-chat-agent-webapp.md
 * §2.2). `@nimbo/core` only ships types for `SessionEvent`/`SessionItem`
 * (events.ts's file header: "纯类型，不含...运行时实现") — there is no zod
 * schema to import, so this file re-declares the same shapes at the wire
 * boundary and validates every JSON payload against them with
 * `.parse()`/`.safeParse()` before it ever touches app state (project rule:
 * no `any`/`as` at network boundaries). Every exported type here is written
 * so it stays structurally assignable to the corresponding `@nimbo/core`
 * type — the schema shapes are kept in lockstep with `packages/core/src/{types,events}.ts`
 * by hand since the two packages don't share a runtime dependency (§2.3:
 * apps/web imports `@nimbo/core` for types only).
 */
import { z } from 'zod';

// ---- JsonValue (packages/core/src/types.ts) ----

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

// ---- Usage / NimboError (packages/core/src/events.ts) ----

export const usageSchema = z.object({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  totalTokens: z.number().optional(),
  // 缓存命中的输入 token（见 @nimbo/core 的 Usage.cachedInputTokens）
  cachedInputTokens: z.number().optional(),
});

export const nimboErrorSchema = z.object({
  code: z.enum(['max_turns', 'context_overflow', 'provider_error', 'aborted']),
  message: z.string(),
});

// ---- SessionItem (packages/core/src/events.ts) ----

export const sessionItemSchema = z.discriminatedUnion('type', [
  z.object({
    id: z.string(),
    type: z.literal('agent_message'),
    text: z.string(),
  }),
  z.object({ id: z.string(), type: z.literal('reasoning'), text: z.string() }),
  z.object({
    id: z.string(),
    type: z.literal('tool_call'),
    toolName: z.string(),
    input: jsonValueSchema,
    output: jsonValueSchema.optional(),
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

// ---- SessionEvent (packages/core/src/events.ts) ----
//
// Core groups item.started/item.updated/item.completed into one union arm
// with `type: "item.started" | "item.updated" | "item.completed"`. zod's
// discriminatedUnion needs one literal per branch, so this is split into
// three branches with an identical shape — structurally that's a subtype of
// core's single wider arm (each branch is narrower), so values parsed here
// stay assignable to `@nimbo/core`'s `SessionEvent` without a cast.

export const sessionEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session.started'), sessionId: z.string() }),
  z.object({ type: z.literal('turn.started'), turn: z.number() }),
  z.object({ type: z.literal('item.started'), item: sessionItemSchema }),
  z.object({ type: z.literal('item.updated'), item: sessionItemSchema }),
  z.object({ type: z.literal('item.completed'), item: sessionItemSchema }),
  z.object({ type: z.literal('turn.completed'), usage: usageSchema }),
  z.object({ type: z.literal('turn.failed'), error: nimboErrorSchema }),
]);

// ---- turn.result sentinel (docs/08 §2.2: not a core SessionEvent — it's the
// synthesized wrapper around the stream's TurnResult return value, pushed as
// the last envelope of a turn) ----

export const turnResultEventSchema = z.object({
  type: z.literal('turn.result'),
  finalResponse: z.string(),
  usage: usageSchema,
});

// ---- user.message sentinel (docs/08 §2.2 "契约细化" #1: not a core
// SessionEvent either — the user's own text, echoed back by the server as
// the first envelope of the turn it kicks off, with a real `seq` so it
// replays from `GET events` like everything else) ----

export const userMessageEventSchema = z.object({
  type: z.literal('user.message'),
  text: z.string(),
});

// ---- turn-runner's own turn.failed sentinel (docs/08 §2.2b: apps/server's
// turn-runner.ts) — emitted *instead of* turn.result when the whole
// in-process turn driver throws unexpectedly, so no TurnResult was ever
// reached. Deliberately shares the `turn.failed` literal with
// `sessionEventSchema`'s own member above (that one is a graceful mid-stream
// item — the turn still reaches a normal turn.result afterwards) but has a
// different, flatter shape (`code`+`message`, no nested `error`); tell them
// apart by field presence (`'error' in event`), same as `timeline.ts` does. ----

export const turnRunnerFailedEventSchema = z.object({
  type: z.literal('turn.failed'),
  code: z.string(),
  message: z.string(),
});

export type TurnRunnerFailedEvent = z.infer<typeof turnRunnerFailedEventSchema>;

export const chatTimelineEventSchema = z.union([
  sessionEventSchema,
  turnResultEventSchema,
  userMessageEventSchema,
  turnRunnerFailedEventSchema,
]);

export type ChatTimelineEvent = z.infer<typeof chatTimelineEventSchema>;

// ---- `{ seq, event }` envelope (docs/08 §2.2/§2.3) ----

export const chatStreamEnvelopeSchema = z.object({
  seq: z.number(),
  event: chatTimelineEventSchema,
});

export type ChatStreamEnvelope = z.infer<typeof chatStreamEnvelopeSchema>;

export const chatEventsPageSchema = z.object({
  events: z.array(chatStreamEnvelopeSchema),
});

export type ChatEventsPage = z.infer<typeof chatEventsPageSchema>;

// ---- ChatSession (apps/server's `chat_sessions` row, camelCase over the
// wire — matches this repo's existing kubb-generated convention, e.g.
// `gen/types/Note.ts`'s `createdAt`) ----

export const chatSessionStatusSchema = z.enum([
  'active',
  'sleeping',
  'expired',
]);

export type ChatSessionStatus = z.infer<typeof chatSessionStatusSchema>;

export const chatSessionSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  repo: z.string(),
  branchName: z.string(),
  sandboxName: z.string(),
  status: chatSessionStatusSchema,
  lastActiveAt: z.string(),
  createdAt: z.string(),
});

export type ChatSession = z.infer<typeof chatSessionSchema>;

export const chatSessionListSchema = z.array(chatSessionSchema);

/**
 * Parses one SSE `data:` payload's JSON text into a `ChatStreamEnvelope`.
 * `JSON.parse`'s stdlib return type is `any` — contained to this one
 * expression by assigning straight into a `zod.safeParse()` call rather than
 * a typed variable, so no `any` value ever escapes this function.
 */
export type ParsedEnvelopeResult =
  { ok: true; envelope: ChatStreamEnvelope } | { ok: false; error: string };

export function parseChatStreamEnvelope(raw: string): ParsedEnvelopeResult {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      error: `invalid JSON in SSE data: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const result = chatStreamEnvelopeSchema.safeParse(parsedJson);
  if (!result.success) {
    return { ok: false, error: result.error.message };
  }
  return { ok: true, envelope: result.data };
}
