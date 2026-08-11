/**
 * A route-aware `fetch` fake for `use-chat-messages.test.ts` — the hook
 * itself is never mocked (only the true network boundary, `global.fetch`, is
 * — same posture `api.test.ts` already uses via `vi.stubGlobal('fetch', ...)`
 * for the real `./api.ts` functions this hook calls). Gives each test fine
 * control over: (a) the `POST .../messages` response status, (b) a queue of
 * controllable SSE bodies for successive `GET .../stream` calls (so a test
 * can push frames on its own schedule and later close/error the stream to
 * simulate a disconnect), and (c) `POST .../approvals/:id` /
 * `.../questions/:id` response statuses.
 */
import type { NimboChunk, NimboUIMessage } from '@nimbo/core';

import type {
  ChatReplayFrame,
  QueuedMessage,
  StartTurnMode,
} from '../../schema';

/**
 * 请求体里的 `intent`（没有/不认识就是 `undefined`）——`POST .../messages` 的默认
 * `mode` 据它推断，让 fake 的分流结果与真服务端一致：有进行中的一轮时 `intent: 'steer'`
 * → `'steered'`，其余 → `'started'`。测试要覆盖不一致的那几档（比如装配窗口里 steer 被
 * 转成排队，docs/agent/turn-abort/tech.md §3.3）就用 `setMessagePostMode` 显式指定。
 */
function requestedIntent(body: unknown): 'queue' | 'steer' | undefined {
  if (typeof body !== 'object' || body === null || !('intent' in body)) {
    return undefined;
  }
  const { intent } = body;
  return intent === 'steer' || intent === 'queue' ? intent : undefined;
}

/** One controllable `text/event-stream` body — push SSE-framed lines on demand, close or error it whenever the test wants. */
export class ControllableSSEStream {
  private controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  private readonly encoder = new TextEncoder();
  readonly body: ReadableStream<Uint8Array>;

  constructor() {
    this.body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
    });
  }

  private pushRaw(text: string): void {
    this.controller?.enqueue(this.encoder.encode(text));
  }

  pushFrame(frame: ChatReplayFrame): void {
    this.pushRaw(`data: ${JSON.stringify(frame)}\n\n`);
  }

  pushChunk(chunk: NimboChunk, seq?: number): void {
    this.pushFrame(seq === undefined ? { chunk } : { seq, chunk });
  }

  pushMessage(seq: number, message: NimboUIMessage): void {
    this.pushFrame({ seq, message });
  }

  /** No-op if already closed/errored (e.g. the hook itself already aborted this stream) — test cleanup calls this unconditionally. */
  close(): void {
    try {
      this.controller?.close();
    } catch {
      /* already closed/errored — fine, this is best-effort cleanup */
    }
  }

  error(reason: unknown): void {
    this.controller?.error(reason);
  }
}

interface QueuedStreamError {
  status: number;
}

type QueuedStream = ControllableSSEStream | QueuedStreamError;

function isQueuedStreamError(entry: QueuedStream): entry is QueuedStreamError {
  return 'status' in entry;
}

export interface RecordedPost {
  conversationId: string;
  body: unknown;
}

export interface RecordedStreamRequest {
  conversationId: string;
  after: number;
  signal: AbortSignal | undefined;
}

export interface RecordedQueueDelete {
  conversationId: string;
  /** 缺席 = `DELETE .../queue`（清空）；有值 = `DELETE .../queue/:messageId`（删一条）。 */
  messageId: string | undefined;
}

/**
 * `fetch` fake, routed by method + path shape (`.../messages`,
 * `.../stream`, `.../approvals/:id`, `.../questions/:id`) — install via
 * `vi.stubGlobal('fetch', fake.fetch)`.
 */
export class FakeChatFetch {
  readonly messagePosts: RecordedPost[] = [];
  readonly approvalPosts: RecordedPost[] = [];
  readonly answerPosts: RecordedPost[] = [];
  /** 每次 `POST .../abort`（[停止](../../../../../../docs/terms.md)本轮）的记录。 */
  readonly abortPosts: RecordedPost[] = [];
  readonly streamRequests: RecordedStreamRequest[] = [];

  /** 每次 `DELETE .../queue*` 的记录（`messageId` 缺席 = 清空整个队列）。 */
  readonly queueDeletes: RecordedQueueDelete[] = [];

  private messagePostStatus = 202;
  /** 缺省 = 按请求的 `intent` 推断（见 `requestedIntent`）；显式设了就一律回这一档。 */
  private messagePostMode: StartTurnMode | undefined = undefined;
  private approvalStatus = 200;
  private answerStatus = 200;
  private queueDeleteStatus = 200;
  private abortStatus = 200;
  /** 服务端「当前队列」的替身：删一条从中过滤，清空则置空——响应体就是变更后的这一份。 */
  private queueSnapshot: QueuedMessage[] = [];
  private readonly streamQueue: QueuedStream[] = [];

  /** 预置服务端当前的[待发队列](../../../../../../docs/terms.md)，供 `DELETE .../queue*` 的响应快照使用。 */
  setQueueSnapshot(queue: QueuedMessage[]): void {
    this.queueSnapshot = queue;
  }

  setQueueDeleteStatus(status: number): void {
    this.queueDeleteStatus = status;
  }

  /** `POST .../abort` 的响应码——`409` 覆盖「没有进行中的一轮」（轮刚好自己结束了）。 */
  setAbortStatus(status: number): void {
    this.abortStatus = status;
  }

  setMessagePostStatus(status: number): void {
    this.messagePostStatus = status;
  }

  /**
   * 固定 `POST .../messages` 的 `mode`（服务端实际分流结果，见 `startTurnAckSchema`）。
   * 唯一必须用它的场景是「请求 steer 却拿回 `'queued'`」——那一轮还卡在
   * [起轮装配](../../../../../../docs/terms.md)里，插不进去（docs/agent/turn-abort/tech.md §3.3）。
   */
  setMessagePostMode(mode: StartTurnMode): void {
    this.messagePostMode = mode;
  }

  setApprovalStatus(status: number): void {
    this.approvalStatus = status;
  }

  setAnswerStatus(status: number): void {
    this.answerStatus = status;
  }

  /** Queues a controllable stream for the *next* `GET .../stream` call — returns it so the test can push/close/error it. */
  queueStream(): ControllableSSEStream {
    const stream = new ControllableSSEStream();
    this.streamQueue.push(stream);
    return stream;
  }

  /** Queues a non-2xx response for the *next* `GET .../stream` call. */
  queueStreamError(status: number): void {
    this.streamQueue.push({ status });
  }

  private parseBody(init: RequestInit | undefined): unknown {
    const body = init?.body;
    if (typeof body !== 'string') return undefined;
    return JSON.parse(body) as unknown;
  }

  fetch = (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const path = url.split('?')[0] ?? url;
    const segments = path.split('/').filter((s) => s.length > 0);
    // .../conversations/:id/messages|stream|approvals/:cid|questions/:cid
    const conversationsIndex = segments.indexOf('conversations');
    const conversationId = segments[conversationsIndex + 1] ?? '';
    const kind = segments[conversationsIndex + 2] ?? '';

    if (method === 'POST' && kind === 'messages') {
      const body = this.parseBody(init);
      this.messagePosts.push({ conversationId, body });
      const mode =
        this.messagePostMode ??
        (requestedIntent(body) === 'steer' ? 'steered' : 'started');
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, mode }), {
          status: this.messagePostStatus,
        }),
      );
    }

    if (method === 'GET' && kind === 'stream') {
      const query = new URLSearchParams(url.split('?')[1] ?? '');
      const after = Number(query.get('after') ?? '0');
      this.streamRequests.push({
        conversationId,
        after,
        signal: init?.signal ?? undefined,
      });
      const next = this.streamQueue.shift();
      if (next === undefined) {
        return Promise.resolve(
          new Response('no stream queued', { status: 500 }),
        );
      }
      if (isQueuedStreamError(next)) {
        return Promise.resolve(
          new Response('stream error', { status: next.status }),
        );
      }
      const signal = init?.signal;
      if (signal !== undefined && signal !== null) {
        signal.addEventListener('abort', () => {
          next.error(new DOMException('aborted', 'AbortError'));
        });
      }
      return Promise.resolve(new Response(next.body, { status: 200 }));
    }

    if (method === 'POST' && kind === 'approvals') {
      this.approvalPosts.push({ conversationId, body: this.parseBody(init) });
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: this.approvalStatus,
        }),
      );
    }

    if (method === 'POST' && kind === 'questions') {
      this.answerPosts.push({ conversationId, body: this.parseBody(init) });
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: this.answerStatus,
        }),
      );
    }

    // POST .../abort（[停止](../../../../../../docs/terms.md)本轮，
    // docs/agent/turn-abort/tech.md §3.2）——服务端中止当前轮 + 清空队列，响应带回清空后的
    // 快照（恒为空数组）。
    if (method === 'POST' && kind === 'abort') {
      this.abortPosts.push({ conversationId, body: undefined });
      if (this.abortStatus !== 200) {
        return Promise.resolve(
          new Response('abort failed', { status: this.abortStatus }),
        );
      }
      this.queueSnapshot = [];
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, queue: [] }), { status: 200 }),
      );
    }

    // DELETE .../queue/:messageId（删一条）与 DELETE .../queue（清空）——两者都返回
    // 变更后的完整队列快照（docs/agent/steer-and-queue/tech.md §4.2）。
    if (method === 'DELETE' && kind === 'queue') {
      const messageId = segments[conversationsIndex + 3];
      this.queueDeletes.push({ conversationId, messageId });
      if (this.queueDeleteStatus !== 200) {
        return Promise.resolve(
          new Response('queue delete failed', {
            status: this.queueDeleteStatus,
          }),
        );
      }
      const queue =
        messageId === undefined ?
          []
        : this.queueSnapshot.filter((message) => message.id !== messageId);
      this.queueSnapshot = queue;
      return Promise.resolve(
        new Response(JSON.stringify({ queue }), { status: 200 }),
      );
    }

    return Promise.resolve(
      new Response(`FakeChatFetch: unhandled ${method} ${url}`, {
        status: 500,
      }),
    );
  };
}
