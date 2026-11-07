/**
 * 直播流的 WebSocket 通道，Cloudflare 版。
 *
 * 推帧的那段与 Node 版是同一个函数（`pumpLiveTail`）；只是升级方式不同：`WebSocketPair`
 * 一 accept 就能发，没有 `onOpen`，所以 accept 之后直接开始推。
 */
import type { Logger } from '@runko-chat/shared/logger';
import type { ConversationRuntime } from '@runko-chat/shared/routes/chat';
import type { LiveTailSocket } from '@runko-chat/shared/routes/chat-ws';
import { parseAfter, pumpLiveTail } from '@runko-chat/shared/routes/chat-ws';
import type { Context } from 'hono';

import { authFor } from '../auth.js';
import { chatDb } from '../db/instance.js';
import type { Env } from '../env.js';

/** 关一个可能已经关了的连接：对面先走了的话 `close` 会抛，那正是我们想要的状态。 */
function socketOf(server: WebSocket): LiveTailSocket {
  return {
    send: (data) => {
      server.send(data);
    },
    close: (code, reason) => {
      try {
        server.close(code, reason);
      } catch {
        // 已经关了
      }
    },
  };
}

export async function handleLiveTailSocket(
  c: Context<{ Bindings: Env }>,
  runtime: Pick<ConversationRuntime, 'subscribe'>,
  logger: Logger,
): Promise<Response> {
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
    return c.json({ error: 'Expected a WebSocket upgrade' }, 426);
  }
  const auth = authFor(c.env, new URL(c.req.url).origin);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (session === null) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();
  const abort = new AbortController();
  server.addEventListener('close', () => abort.abort());
  server.addEventListener('error', () => abort.abort());

  c.executionCtx.waitUntil(
    pumpLiveTail(socketOf(server), {
      db: chatDb(c.env.DB),
      runtime,
      conversationId: c.req.param('id') ?? '',
      userId: session.user.id,
      after: parseAfter(c.req.query('after')),
      signal: abort.signal,
      logger,
    }),
  );

  return new Response(null, { status: 101, webSocket: client });
}
