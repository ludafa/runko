/**
 * [直播流](../../../../docs/terms.md)的 WebSocket 通道——与 SSE 那条**并排**，推的帧一模一样。
 *
 * 为什么能这么省：SSE 那条处理器只做一件事，把 `runtime.subscribe()` 吐出来的帧序列化。
 * 断线续传、[进行中草稿](../../../../docs/terms.md)快照、「先挂订阅再回放」的顺序全在框架里。
 * 这里只是把「写进 SSE」换成「往连接里发一条消息」，所以两条通道不可能长歪。
 *
 * 两个服务端的升级方式不同：Node 版用 `@hono/node-ws`（有 `onOpen`），Cloudflare 版的
 * `WebSocketPair` 一 accept 就能发、没有 `onOpen`。所以真正推帧的那段（`pumpLiveTail`）单独导出，
 * `createChatWsApp` 只是 Node 那种升级方式的包装。设计见 docs/ingress/tech/ws-stream.md §3、§5。
 */
import type { MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';

import type { Db } from '../agent/store.js';
import { getConversation } from '../agent/store.js';
import type { Logger } from '../logger.js';
import { logger as defaultLogger } from '../logger.js';
import type { ChatEnv, ConversationRuntime } from './chat.js';
import { toWireFrame } from './chat.js';

const LOG_SCOPE = 'chat-ws';

/** 这条通道只有一条路由；鉴权也只挂它（见 `createChatWsApp` 里 `app.use` 的注释）。 */
export const WS_ROUTE = '/api/chat/conversations/:id/ws';

/**
 * WebSocket 标准关闭码「服务重启」。[请重连帧](../../../../docs/terms.md)之后用它关：本节点在下线，
 * 这份对话已经交出去了，或者它本来就没有轮在本节点上跑。前端收到就[快速重连](../../../../docs/terms.md)
 * （docs/logic/orchestration/tech/handover.md §8）。
 */
const CLOSE_SERVICE_RESTART = 1012;

/** 不是你的会话：与 HTTP 那边回 404 同一个意思。 */
const CLOSE_NOT_FOUND = 4004;

/** 解析 `?after=<seq>`：认不出来就当没带（从头回放）。 */
export function parseAfter(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') {
    return undefined;
  }
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** 推帧只要连接的这两样。两种升级方式给的连接都满足它。 */
export interface LiveTailSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface LiveTailInput {
  db: Db;
  runtime: Pick<ConversationRuntime, 'subscribe'>;
  conversationId: string;
  userId: string;
  after: number | undefined;
  /** 连接断了（`onClose`/`onError`）就由调用方 abort。 */
  signal: AbortSignal;
  logger: Logger;
}

/** 查归属 → 订阅 → 逐帧发出去 → 按结束原因关连接。 */
export async function pumpLiveTail(
  ws: LiveTailSocket,
  input: LiveTailInput,
): Promise<void> {
  const { conversationId, signal } = input;
  const owned = await getConversation(input.db, conversationId, input.userId);
  if (owned === undefined) {
    ws.close(CLOSE_NOT_FOUND, 'not found');
    return;
  }
  try {
    let reconnect = false;
    for await (const frame of input.runtime.subscribe(conversationId, {
      ...(input.after !== undefined ? { after: input.after } : {}),
      signal,
    })) {
      if (signal.aborted) {
        break;
      }
      ws.send(JSON.stringify(toWireFrame(frame)));
      if (frame.kind === 'reconnect') {
        reconnect = true;
      }
    }
    if (signal.aborted) {
      return;
    }
    if (reconnect) {
      ws.close(CLOSE_SERVICE_RESTART, 'node going offline');
      return;
    }
    // 生成器结束 = 这一轮完了，与 SSE 那条「关流」同一个语义。
    ws.close(1000, 'stream ended');
  } catch (error) {
    if (signal.aborted) {
      return; // 人自己走的，不是错误
    }
    input.logger.warn(LOG_SCOPE, 'live tail failed', {
      conversationId,
      error: error instanceof Error ? error.message : String(error),
    });
    ws.close(1011, 'stream failed');
  }
}

export interface ChatWsOptions {
  db: Db;
  runtime: Pick<ConversationRuntime, 'subscribe'>;
  authMiddleware: MiddlewareHandler<ChatEnv>;
  /** 由 `@hono/node-ws` 造出来的升级处理器。 */
  upgradeWebSocket: UpgradeWebSocket;
  logger?: Logger;
}

/** 带 `onOpen` 的升级方式（Node 版）。 */
export function createChatWsApp(opts: ChatWsOptions): Hono<ChatEnv> {
  const log = opts.logger ?? defaultLogger;
  const app = new Hono<ChatEnv>();

  // 路径**只写这一条 ws 路由**，不能写 `/api/chat/*`：这个子应用经 `app.route('/', ...)`
  // 并进顶层之后，它的 `use` 会对顶层**全部** chat 路由生效——于是每个 chat 请求都要多做
  // 一次鉴权查库（chat 路由自己那条鉴权还会再做一次）。功能不坏，但白花一次查询。
  app.use(WS_ROUTE, opts.authMiddleware);

  app.get(
    WS_ROUTE,
    opts.upgradeWebSocket((c) => {
      // 路径里有 `:id`，所以这里一定有值；拿不到就当空串——查归属会得到 404。
      const conversationId = c.req.param('id') ?? '';
      const userId = c.get('userId');
      const after = parseAfter(c.req.query('after'));
      const abort = new AbortController();

      return {
        async onOpen(_event, ws) {
          await pumpLiveTail(ws, {
            db: opts.db,
            runtime: opts.runtime,
            conversationId,
            userId,
            after,
            signal: abort.signal,
            logger: log,
          });
        },
        // 只推不收（见 docs/ingress/features/ws-stream.md 的非目标）。
        onMessage() {},
        onClose() {
          abort.abort();
        },
        onError() {
          abort.abort();
        },
      };
    }),
  );

  return app;
}
