/**
 * REST + SSE client for the chat agent API (docs/app/chat-webapp/tech.md §2.2, docs/agent/single-ledger/tech.md §5/§6). These routes aren't in the OpenAPI spec kubb
 * generates a *usable* client from (`chunk`/`message` come out `z.any()` — see
 * `schema.ts`'s own file header) — like before this migration, this stays
 * hand-written, and every response is validated with the zod schemas in
 * `./schema.ts` rather than trusted via a generic type parameter. Plain
 * `fetch` (not `@kubb/plugin-client`'s wrapper) so `credentials` and the
 * SSE-specific streaming path are both fully under our control.
 */
import {
  abortTurnAckSchema,
  type ChatReplayFrame,
  type Conversation,
  conversationEventsListSchema,
  conversationListSchema,
  type ConversationProvider,
  conversationSchema,
  parseChatReplayFrame,
  type QueuedMessage,
  queueFrameSchema,
  startTurnAckSchema,
  type StartTurnMode,
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
 * `GET .../events?after=<seq>` (docs/app/chat-webapp/tech.md §2.2, docs/agent/single-ledger/tech.md §5 单-3): the full
 * persisted history, in seq order — `{ frames: ChatReplayFrame[] }`, not a
 * bare/paginated array (`apps/node-server`'s `schemas/chat.ts` `ChatEventsListSchema`
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
 * `POST /api/chat/conversations/:id/messages` (docs/app/chat-webapp/tech.md §2.2b,
 * docs/agent/steer-and-queue/tech.md §4.1): only *starts* a turn, *queues* this
 * message for the next one, or *steers* the in-progress one — its events
 * arrive separately, over `streamConversationTail`, not this response.
 *
 * `intent` 只在**已有进行中的一轮**时才有意义：`'queue'`（默认，省略即此）排队到下
 * 一轮，`'steer'` 注入当前这一轮。没有进行中的一轮时两者都直接起新一轮——分流完全
 * 由服务端判定，这里不预判。
 *
 * Resolves once the server has accepted it (202); rejects with `ChatApiError`
 * on a non-2xx response — notably `409` for a full 待发队列, or (窄竞态) a turn
 * already in progress that couldn't be steered either.
 *
 * resolve 的值是服务端**实际**的分流结果（`mode`，见 `startTurnAckSchema`）：它可能与
 * 请求的 `intent` 不一致，调用方需要据此修正自己的乐观状态——目前唯一的用处是
 * `use-chat-messages.ts` 在「请求 steer 却拿回 `queued`」时撤掉那条「待注入」回显
 * （docs/agent/turn-abort/tech.md §3.3）。
 */
export async function postChatMessage(
  conversationId: string,
  text: string,
  intent?: 'queue' | 'steer',
  signal?: AbortSignal,
): Promise<StartTurnMode> {
  const json = await requestJson(
    `/api/chat/conversations/${encodeURIComponent(conversationId)}/messages`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(intent === undefined ? { text } : { text, intent }),
      signal,
    },
  );
  return startTurnAckSchema.parse(json).mode;
}

/**
 * `POST .../abort`（docs/agent/turn-abort/tech.md §3.2）：[停止](../../../../../docs/terms.md)
 * 进行中的那一轮——中止当前轮 + 清空[待发队列](../../../../../docs/terms.md)，返回清空
 * 后的队列快照（恒为空数组）。
 *
 * resolve 只代表「停止已请求」：真正停下的那一刻由 agent 当时在做什么决定，界面靠直播
 * 流上那条 `status: 'interrupted'` 的 `message-metadata` 才知道停住了（与审批「不做乐观
 * 翻转」同一姿态）。`409` = 没有进行中的一轮（含「刚好自己结束了」的窄竞态），
 * `use-chat-messages.ts` 靠 `ChatApiError.status` 把它当成无事发生。
 */
export async function postAbortTurn(
  conversationId: string,
  signal?: AbortSignal,
): Promise<QueuedMessage[]> {
  const json = await requestJson(
    `/api/chat/conversations/${encodeURIComponent(conversationId)}/abort`,
    { method: 'POST', signal },
  );
  return abortTurnAckSchema.parse(json).queue;
}

/**
 * `DELETE .../queue/:messageId`（docs/agent/steer-and-queue/tech.md §4.2）：删掉一条还没
 * 发出的[排队](../../../../../docs/terms.md)消息，返回**变更后的完整队列快照**
 * ——服务端始终是队列的权威，调用方直接用这份快照覆盖本地状态，不做乐观合并（与审批
 * 「不做乐观翻转」同一姿态）。`404` = 这条已经不在队列里了（已出队成一轮 / 已删）。
 */
export async function deleteQueuedMessage(
  conversationId: string,
  messageId: string,
  signal?: AbortSignal,
): Promise<QueuedMessage[]> {
  const json = await requestJson(
    `/api/chat/conversations/${encodeURIComponent(conversationId)}/queue/${encodeURIComponent(messageId)}`,
    { method: 'DELETE', signal },
  );
  return queueFrameSchema.parse(json).queue;
}

/** `DELETE .../queue`（docs/agent/steer-and-queue/tech.md §4.2）：清空队列，同样返回变更后的快照（恒为空数组）。 */
export async function clearQueuedMessages(
  conversationId: string,
  signal?: AbortSignal,
): Promise<QueuedMessage[]> {
  const json = await requestJson(
    `/api/chat/conversations/${encodeURIComponent(conversationId)}/queue`,
    { method: 'DELETE', signal },
  );
  return queueFrameSchema.parse(json).queue;
}

/**
 * `POST .../approvals/:callId` (docs/agent/single-ledger/tech.md §6): a human's decision on a pending
 * tool call — `callId` is the gated tool part's own `toolCallId`
 * (`approval-requested` state, `part.approval.id`), no separate id space to
 * reconcile anymore (docs/agent/single-ledger/tech.md §5 引言's "旧『卡片对不上工具卡片』的痛点自动消失").
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

/** `POST .../questions/:callId` (docs/agent/single-ledger/tech.md §6): a human's free-text answer to a pending `ask-user` tool call — same posture/rationale as `postApprovalDecision` above. */
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

/**
 * `POST .../presence`（[在场](../../../../docs/terms.md)心跳，
 * docs/app/push-notification/tech.md §5.2）：上报"这条会话此刻是否正在我眼前"。服务端
 * 据此决定要不要推送——在场就不推，因为审批卡片已经在眼前了。
 *
 * 与本文件其它函数不同，**这个接口失败一律吞掉**（由 `use-presence.ts` 负责）：
 * 心跳是尽力而为的，报不上去最坏是多收一条通知，不该在界面上冒出任何错误。
 *
 * `keepalive` 给页面卸载时那一次用——普通 fetch 会随页面一起被取消，而"我不看了"
 * 这条恰恰必须发出去。
 */
export async function postPresence(
  conversationId: string,
  focused: boolean,
  opts?: { signal?: AbortSignal; keepalive?: boolean },
): Promise<void> {
  await requestJson(
    `/api/chat/conversations/${encodeURIComponent(conversationId)}/presence`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ focused }),
      ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
      ...(opts?.keepalive === true ? { keepalive: true } : {}),
    },
  );
}

/** `GET .../turns/{turn}/telemetry`（docs/app/chat-webapp/tech.md §11.4）：一个 turn 的遥测明细——未启用遥测/该轮无数据返回空数组，UI 显示"无遥测数据"而不是报错。 */
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
 * `GET /api/chat/conversations/:id/stream?after=<seq>` (docs/app/chat-webapp/tech.md §2.2b, docs/agent/single-ledger/tech.md §5
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
