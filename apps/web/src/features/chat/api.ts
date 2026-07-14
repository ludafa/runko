/**
 * REST + SSE client for the chat agent API (docs/08 §2.2). These routes
 * aren't in the OpenAPI spec kubb generates from (apps/server's chat routes
 * are built in parallel, see the work order) so — unlike `src/gen/clients`
 * — these are hand-written, and every response is validated with the zod
 * schemas in `./schema.ts` rather than trusted via a generic type parameter.
 * Plain `fetch` (not `@kubb/plugin-client`'s wrapper) so `credentials` and
 * the SSE-specific streaming path are both fully under our control.
 */
import {
  type ChatEventsPage,
  chatEventsPageSchema,
  type ChatSession,
  chatSessionListSchema,
  chatSessionSchema,
  type ChatStreamEnvelope,
  parseChatStreamEnvelope,
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

export async function listChatSessions(
  signal?: AbortSignal,
): Promise<ChatSession[]> {
  const json = await requestJson('/api/chat/sessions', {
    method: 'GET',
    signal,
  });
  return chatSessionListSchema.parse(json);
}

export async function createChatSession(
  input: { title?: string },
  signal?: AbortSignal,
): Promise<ChatSession> {
  const json = await requestJson('/api/chat/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal,
  });
  return chatSessionSchema.parse(json);
}

export async function getChatSession(
  id: string,
  signal?: AbortSignal,
): Promise<ChatSession> {
  const json = await requestJson(
    `/api/chat/sessions/${encodeURIComponent(id)}`,
    { method: 'GET', signal },
  );
  return chatSessionSchema.parse(json);
}

/**
 * One page of `GET .../events?after=<seq>` (docs/08 §2.2: "历史回放（分页）").
 * The response shape's exact pagination fields aren't spelled out in the
 * contract beyond the `after` cursor, so this only relies on `events` being
 * present — `fetchAllSessionEvents` below drains pages by re-querying with
 * the last seen `seq` until an empty batch comes back, which terminates
 * correctly whether or not the server actually caps page size.
 */
export async function fetchChatSessionEventsPage(
  sessionId: string,
  opts?: { after?: number; signal?: AbortSignal },
): Promise<ChatEventsPage> {
  const query =
    opts?.after !== undefined ?
      `?after=${encodeURIComponent(String(opts.after))}`
    : '';
  const json = await requestJson(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}/events${query}`,
    {
      method: 'GET',
      signal: opts?.signal,
    },
  );
  return chatEventsPageSchema.parse(json);
}

export async function fetchAllChatSessionEvents(
  sessionId: string,
  opts?: { after?: number; signal?: AbortSignal },
): Promise<ChatStreamEnvelope[]> {
  const all: ChatStreamEnvelope[] = [];
  let after = opts?.after;
  for (;;) {
    const page = await fetchChatSessionEventsPage(sessionId, {
      after,
      signal: opts?.signal,
    });
    if (page.events.length === 0) break;
    all.push(...page.events);
    const last = page.events.at(-1);
    if (last === undefined) break;
    after = last.seq;
  }
  return all;
}

export interface ChatEnvelopeStreamHandlers {
  onEnvelope: (envelope: ChatStreamEnvelope) => void;
  /** Malformed SSE payloads are dropped, not fatal to the rest of the turn — surfaced here for diagnostics. */
  onParseError?: (message: string) => void;
}

/**
 * `POST /api/chat/sessions/:id/messages` (docs/08 §2.2b): only *starts* a
 * turn — the turn's events arrive separately, over `streamSessionTail`, not
 * this response. Resolves once the server has accepted the turn (202);
 * rejects with `ChatApiError` on a non-2xx response — notably `409` when a
 * turn is already in progress for this session (callers can check
 * `error.status === 409` to tell that apart from other failures).
 */
export async function postChatMessage(
  sessionId: string,
  text: string,
  signal?: AbortSignal,
): Promise<void> {
  await requestJson(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}/messages`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal,
    },
  );
}

/**
 * `POST .../approvals/:callId` (docs/08 §2.2c（审批链）): a human's decision
 * on a pending tool call. Same posture as `postChatMessage` above — the
 * decision itself arrives back over the tail as `approval.resolved`, this
 * call only needs to succeed or fail; `use-chat-messages.ts` tells a `404`
 * (the server no longer has this `callId` pending — already timed out, or
 * the turn already ended) apart from every other failure via
 * `ChatApiError.status`.
 *
 * `src/gen/clients/postApiChatSessionsIdApprovalsCallid.ts` covers the same
 * route (kubb now generates it — the routes are in `openapi.yml`), but its
 * default `@kubb/plugin-client/clients/fetch` client never checks
 * `response.ok`/throws on a non-2xx status, only returning whatever JSON
 * body came back regardless of status code — unusable for the
 * 404-vs-anything-else distinction this hook needs, so this stays
 * hand-written like the rest of this file.
 */
export async function postApprovalDecision(
  sessionId: string,
  callId: string,
  decision: { behavior: 'allow' | 'deny'; message?: string },
  signal?: AbortSignal,
): Promise<void> {
  await requestJson(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(callId)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(decision),
      signal,
    },
  );
}

/** `POST .../questions/:callId` (docs/08 §2.2c（审批链）): a human's free-text answer to a pending `ask_user` question — same posture/rationale as `postApprovalDecision` above. */
export async function postQuestionAnswer(
  sessionId: string,
  callId: string,
  answer: string,
  signal?: AbortSignal,
): Promise<void> {
  await requestJson(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(callId)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer }),
      signal,
    },
  );
}

/**
 * `GET /api/chat/sessions/:id/stream?after=<seq>` (docs/08 §2.2b): the
 * resumable live tail — replays persisted events after `after`, then
 * forwards the turn's live events until it ends (or closes immediately if
 * there's no turn in progress). Resolves once the stream closes; rejects on
 * a non-2xx response, a missing body, or a network/parse-level failure
 * (including `AbortError` when `signal` fires — `use-chat-messages.ts`
 * distinguishes that from a real disconnect to decide whether to reconnect).
 */
export async function streamSessionTail(
  sessionId: string,
  after: number,
  handlers: ChatEnvelopeStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}/stream?after=${encodeURIComponent(String(after))}`,
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
    throw new Error('chat session tail response has no body');

  await consumeSSEStream(response.body, (message) => {
    const parsed = parseChatStreamEnvelope(message.data);
    if (parsed.ok) {
      handlers.onEnvelope(parsed.envelope);
    } else {
      handlers.onParseError?.(parsed.error);
    }
  });
}
