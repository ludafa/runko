/**
 * [直播流](../../../../docs/terms.md)的 WebSocket 通道——与 SSE 那条**并排**，推的帧一模一样。
 *
 * 为什么能这么省：SSE 那条处理器只做一件事，把 `runtime.subscribe()` 吐出来的帧序列化。
 * 断线续传、[进行中草稿](../../../../docs/terms.md)快照、「先挂订阅再回放」的顺序全在框架里。
 * 这里只是把「写进 SSE」换成「往连接里发一条消息」，所以两条通道不可能长歪。
 *
 * **单独一个子应用**，不跟 `chat.ts` 那堆路由放一起：`@hono/node-ws` 的 `upgradeWebSocket`
 * 要由顶层 app 造出来（升级发生在 HTTP 服务器那一层），而那个 app 又要挂载本文件——
 * 分开才不打结，见 `app.ts`。
 *
 * **多副本时要配 Redis**：WebSocket 的升级没法像普通请求那样转发给[持有者](../../../../docs/terms.md)，
 * 所以内容得靠广播到每个副本（`agent/stream.ts`）。设计见 docs/ingress/tech/ws-stream.md §3、§5。
 */
import type { AgentRuntime, Frame } from '@runko/agent';
import type { MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';

import { getConversation } from '../agent/store.js';
import type { Db } from '../db/instance.js';
import type { Logger } from '../logger.js';
import { logger as defaultLogger } from '../logger.js';
import type { ChatReplayFrame } from '../schemas/chat.js';

const LOG_SCOPE = 'chat-ws';

type ChatEnv = { Variables: { userId: string } };

export interface ChatWsOptions {
  db: Db;
  runtime: AgentRuntime;
  authMiddleware: MiddlewareHandler<ChatEnv>;
  /** 由 `@hono/node-ws` 造出来的升级处理器。 */
  upgradeWebSocket: UpgradeWebSocket;
  /** 框架的 `Frame` → wire 帧；**与 SSE 那条是同一个函数**。 */
  toWire: (frame: Frame) => ChatReplayFrame;
  logger?: Logger;
}

/** 解析 `?after=<seq>`：认不出来就当没带（从头回放）。 */
function parseAfter(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') {
    return undefined;
  }
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function createChatWsApp(opts: ChatWsOptions): Hono<ChatEnv> {
  const log = opts.logger ?? defaultLogger;
  const app = new Hono<ChatEnv>();

  app.use('/api/chat/*', opts.authMiddleware);

  app.get(
    '/api/chat/conversations/:id/ws',
    opts.upgradeWebSocket((c) => {
      // 路径里有 `:id`，所以这里一定有值；拿不到就当空串——下面查归属会得到 404。
      const conversationId = c.req.param('id') ?? '';
      const userId = c.get('userId');
      const after = parseAfter(c.req.query('after'));
      const abort = new AbortController();

      return {
        async onOpen(_event, ws) {
          // 归属照查：不是你的会话就立刻关掉（与 HTTP 那边回 404 同一个意思）。
          const owned = await getConversation(opts.db, conversationId, userId);
          if (owned === undefined) {
            ws.close(4004, 'not found');
            return;
          }
          try {
            for await (const frame of opts.runtime.subscribe(conversationId, {
              ...(after !== undefined ? { after } : {}),
              signal: abort.signal,
            })) {
              if (abort.signal.aborted) {
                break;
              }
              ws.send(JSON.stringify(opts.toWire(frame)));
            }
            // 生成器结束 = 这一轮完了，与 SSE 那条「关流」同一个语义。
            ws.close(1000, 'stream ended');
          } catch (error) {
            if (abort.signal.aborted) {
              return; // 人自己走的，不是错误
            }
            log.warn(LOG_SCOPE, 'live tail failed', {
              conversationId,
              error: error instanceof Error ? error.message : String(error),
            });
            ws.close(1011, 'stream failed');
          }
        },
        // 这一批只推不收（见 docs/ingress/features/ws-stream.md 的非目标）。
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
