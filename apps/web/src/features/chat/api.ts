/**
 * REST + SSE client for the chat agent API (docs/tech/chat-webapp.md §2.2, docs/tech/single-ledger.md §5/§6). These routes aren't in the OpenAPI spec kubb
 * generates a *usable* client from (`chunk`/`message` come out `z.any()` — see
 * `schema.ts`'s own file header) — like before this migration, this stays
 * hand-written, and every response is validated with the zod schemas in
 * `./schema.ts` rather than trusted via a generic type parameter. Plain
 * `fetch` (not `@kubb/plugin-client`'s wrapper) so `credentials` and the
 * SSE-specific streaming path are both fully under our control.
 */
import {
  type ChatReplayFrame,
  type Conversation,
  conversationEventsListSchema,
  conversationListSchema,
  type ConversationProvider,
  conversationSchema,
  parseChatReplayFrame,
  type TurnTelemetryEvent,
  turnTelemetrySchema,
} from './schema';
import { consumeSSEStream } from './sse';

export class ChatApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(
      message.length > 0 ?
        message
      : `chat API request failed with status ${String(status)}`,
    );
    this.name = 'ChatApiError';
    this.status = status;
  }
}

async function readBodyText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

async function requestJson(input: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(input, { credentials: 'include', ...init });
  if (!response.ok)
    throw new ChatApiError(response.status, await readBodyText(response));
  if (response.status === 204 || response.status === 205) return null;
  return response.json() as Promise<unknown>;
}

export async function listConversations(
  signal?: AbortSignal,
): Promise<Conversation[]> {
  const json = await requestJson('/api/chat/conversations', {
    method: 'GET',
    signal,
  });
  return conversationListSchema.parse(json);
}

export async function createConversation(
  input: { title?: string; provider?: ConversationProvider },
  signal?: AbortSignal,
): Promise<Conversation> {
  const json = await requestJson('/api/chat/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal,
  });
  return conversationSchema.parse(json);
}

export async function getConversation(
  id: string,
  signal?: AbortSignal,
): Promise<Conversation> {
  const json = await requestJson(
    `/api/chat/conversations/${encodeURIComponent(id)}`,
    { method: 'GET', signal },
  );
  return conversationSchema.parse(json);
}

/**
 * `GET .../events?after=<seq>` (docs/tech/chat-webapp.md §2.2, docs/tech/single-ledger.md §5 单-3): the full
 * persisted history, in seq order — `{ frames: ChatReplayFrame[] }`, not a
 * bare/paginated array (`apps/server`'s `schemas/chat.ts` `ChatEventsListSchema`
 * doc comment: GC already keeps this bounded to "finished message history +
 * the in-progress/crashed turn's durable chunks", no pagination needed).
 */
export async function fetchConversationEvents(
  conversationId: string,
  opts?: { after?: number; signal?: AbortSignal },
): Promise<ChatReplayFrame[]> {
  const query =
    opts?.after !== undefined ?
      `?after=${encodeURIComponent(String(opts.after))}`
    : '';
  const json = await requestJson(
    `/api/chat/conversations/${encodeURIComponent(conversationId)}/events${query}`,
    { method: 'GET', signal: opts?.signal },
  );
  return conversationEventsListSchema.parse(json).frames;
}

export interface ChatFrameStreamHandlers {
  onFrame: (frame: ChatReplayFrame) => void;
  /** Malformed SSE payloads are dropped, not fatal to the rest of the turn — surfaced here for diagnostics. */
  onParseError?: (message: string) => void;
}

/**
 * `POST /api/chat/conversations/:id/messages` (docs/tech/chat-webapp.md §2.2b): only *starts* a
 * turn (or steers an in-progress one, STEER-3B) — its events arrive
 * separately, over `streamConversationTail`, not this response. Resolves once the
 * server has accepted the turn (202); rejects with `ChatApiError` on a
 * non-2xx response — notably `409` when a turn is already in progress for
 * this conversation and couldn't be steered either.
 */
export async function postChatMessage(
  conversationId: string,
  text: string,
  signal?: AbortSignal,
): Promise<void> {
  await requestJson(
    `/api/chat/conversations/${encodeURIComponent(conversationId)}/messages`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal,
    },
  );
}

/**
 * `POST .../approvals/:callId` (docs/tech/single-ledger.md §6): a human's decision on a pending
 * tool call — `callId` is the gated tool part's own `toolCallId`
 * (`approval-requested` state, `part.approval.id`), no separate id space to
 * reconcile anymore (docs/tech/single-ledger.md §5 引言's "旧『卡片对不上工具卡片』的痛点自动消失").
 * Result arrives back over the tail as the matching `tool-approval-response`
 * chunk, this call only needs to succeed or fail; `use-chat-messages.ts`
 * tells a `404` (the server no longer has this `callId` pending) apart from
 * every other failure via `ChatApiError.status`.
 *
 * `src/gen/clients/postApiConversationsIdApprovalsCallid.ts` covers the same
 * route (kubb generates it from `openapi.yml`), but its default
 * `@kubb/plugin-client/clients/fetch` client never checks `response.ok`/
 * throws on a non-2xx status — unusable for the 404-vs-anything-else
 * distinction this hook needs, so this stays hand-written.
 */
export async function postApprovalDecision(
  conversationId: string,
  callId: string,
  decision: { behavior: 'allow' | 'allow-session' | 'deny'; message?: string },
  signal?: AbortSignal,
): Promise<void> {
  await requestJson(
    `/api/chat/conversations/${encodeURIComponent(conversationId)}/approvals/${encodeURIComponent(callId)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(decision),
      signal,
    },
  );
}

/** `POST .../questions/:callId` (docs/tech/single-ledger.md §6): a human's free-text answer to a pending `ask-user` tool call — same posture/rationale as `postApprovalDecision` above. */
export async function postQuestionAnswer(
  conversationId: string,
  callId: string,
  answer: string,
  signal?: AbortSignal,
): Promise<void> {
  await requestJson(
    `/api/chat/conversations/${encodeURIComponent(conversationId)}/questions/${encodeURIComponent(callId)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer }),
      signal,
    },
  );
}

/** `GET .../turns/{turn}/telemetry`（docs/tech/chat-webapp.md §11.4）：一个 turn 的遥测明细——未启用遥测/该轮无数据返回空数组，UI 显示"无遥测数据"而不是报错。 */
export async function fetchTurnTelemetry(
  conversationId: string,
  turn: number,
  signal?: AbortSignal,
): Promise<TurnTelemetryEvent[]> {
  const json = await requestJson(
    `/api/chat/conversations/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(String(turn))}/telemetry`,
    { method: 'GET', signal },
  );
  return turnTelemetrySchema.parse(json).events;
}

/**
 * `GET /api/chat/conversations/:id/stream?after=<seq>` (docs/tech/chat-webapp.md §2.2b, docs/tech/single-ledger.md §5
 * 单-3): the resumable live tail — replays persisted frames after `after`,
 * then forwards the turn's live frames until it ends (or closes immediately
 * if there's no turn in progress). Resolves once the stream closes; rejects
 * on a non-2xx response, a missing body, or a network/parse-level failure
 * (including `AbortError` when `signal` fires — `use-chat-messages.ts`
 * distinguishes that from a real disconnect to decide whether to reconnect).
 */
export async function streamConversationTail(
  conversationId: string,
  after: number,
  handlers: ChatFrameStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(
    `/api/chat/conversations/${encodeURIComponent(conversationId)}/stream?after=${encodeURIComponent(String(after))}`,
    {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'text/event-stream' },
      signal,
    },
  );
  if (!response.ok)
    throw new ChatApiError(response.status, await readBodyText(response));
  if (response.body === null)
    throw new Error('chat conversation tail response has no body');

  await consumeSSEStream(response.body, (message) => {
    const parsed = parseChatReplayFrame(message.data);
    if (parsed.ok) {
      handlers.onFrame(parsed.frame);
    } else {
      handlers.onParseError?.(parsed.error);
    }
  });
}
