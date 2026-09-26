/**
 * [指定交接](../../../../docs/terms.md)的节点间端点：下线的节点经出站请本节点接手几份对话
 * （docs/logic/orchestration/tech/handover.md §7.5）。
 *
 * 两半都在这里：本节点**接**的那个端点，以及本节点**请别人接**时用的客户端。它们走的是节点间的通道：
 * 带转发标记与副本间令牌，不带用户身份——要做的事不属于任何一个用户。
 *
 * 请求体里的会话列表为空 = 只问一句「你现在接不接」：本节点自己也在下线就答否（它看的是自己内存里的状态，
 * 登记表有时差）。
 */
import type { AgentRuntime } from '@runko/agent';
import { Hono } from 'hono';
import { z } from 'zod';

import type { Logger } from '../logger.js';
import { logger as defaultLogger } from '../logger.js';
import type { NodeIdentity } from './forward.js';
import {
  FORWARDED_HEADER,
  isTrustedForward,
  PEER_TOKEN_HEADER,
} from './forward.js';

const LOG_SCOPE = 'takeover';

export const TAKEOVER_PATH = '/internal/takeover';

/** 请接手最多等对方多久。框架那边还有一道自己的上限，这里只是别让一次出站调用挂住。 */
const TAKEOVER_REQUEST_TIMEOUT_MS = 4_000;

/** 一次请接手最多带几份对话——一个节点手上的对话数远小于它；上限挡住拿这个端点刷库。 */
const MAX_CONVERSATIONS_PER_REQUEST = 500;

const takeoverRequestSchema = z.object({
  conversationIds: z.array(z.string()).max(MAX_CONVERSATIONS_PER_REQUEST),
});

const takeoverResponseSchema = z.object({ accepted: z.boolean() });

export function createTakeoverApp(opts: {
  /** 只用到 `takeOver`。 */
  runtime: Pick<AgentRuntime, 'takeOver'>;
  node: NodeIdentity | undefined;
  logger?: Logger;
}): Hono {
  const log = opts.logger ?? defaultLogger;
  const app = new Hono();
  app.post(TAKEOVER_PATH, async (c) => {
    // 没配副本间令牌就**整个不开**：这个端点不做用户鉴权，只剩令牌这一道——没令牌时谁都能调它
    // （转发中间件对「本机联调」的宽松口径在这里不适用）。
    const peerToken = opts.node?.peerToken;
    if (peerToken === undefined || peerToken === '') {
      return c.json({ error: 'not found' }, 404);
    }
    if (
      !isTrustedForward(
        c.req.header(FORWARDED_HEADER),
        c.req.header(PEER_TOKEN_HEADER),
        peerToken,
      )
    ) {
      return c.json({ error: 'peer token required' }, 401);
    }
    const body = takeoverRequestSchema.safeParse(await c.req.json());
    if (!body.success) {
      return c.json(
        {
          error: `conversationIds must be a list of at most ${String(MAX_CONVERSATIONS_PER_REQUEST)} strings`,
        },
        400,
      );
    }
    const accepted = await opts.runtime.takeOver(body.data.conversationIds);
    if (body.data.conversationIds.length > 0) {
      log.info(LOG_SCOPE, 'takeover request handled', {
        accepted,
        count: body.data.conversationIds.length,
      });
    }
    return c.json({ accepted });
  });
  return app;
}

/**
 * 请 `target` 节点接手：给框架的 `handover.requestTakeover`。连不上、超时、对方拒绝都算 `false`——
 * 框架据此换下一个候选，或者交给[定时回捞](../../../../docs/terms.md)。
 */
export function createTakeoverRequester(
  node: NodeIdentity | undefined,
  logger: Logger = defaultLogger,
): (target: string, conversationIds: string[]) => Promise<boolean> {
  return async (target, conversationIds) => {
    const headers = new Headers({
      'content-type': 'application/json',
      [FORWARDED_HEADER]: '1',
    });
    if (node?.peerToken !== undefined && node.peerToken !== '') {
      headers.set(PEER_TOKEN_HEADER, node.peerToken);
    }
    try {
      const response = await fetch(new URL(TAKEOVER_PATH, target), {
        method: 'POST',
        headers,
        body: JSON.stringify({ conversationIds }),
        signal: AbortSignal.timeout(TAKEOVER_REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        return false;
      }
      const parsed = takeoverResponseSchema.safeParse(await response.json());
      return parsed.success && parsed.data.accepted;
    } catch (error) {
      logger.warn(LOG_SCOPE, 'takeover request failed', {
        target,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  };
}
