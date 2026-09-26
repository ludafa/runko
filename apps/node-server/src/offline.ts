/**
 * [节点下线](../../../docs/terms.md)的闸门：收到 SIGTERM 之后，本节点不再接浏览器来的请求，一律回 503，nginx 见 503
 * 换节点重试。它在验证环境里模拟「入站随 SIGTERM 一起关」（真集群里是负载均衡与 service mesh 在做）。
 *
 * **交接完成之前，别的节点转发来的请求照常放行**：那段时间（挑接手节点、等各轮交出去，通常几十毫秒）这份对话
 * 还在本节点手上，所有节点都把它的停止、发消息、答卡片转到这里；挡掉的话这些请求就丢了。`finishHandover()`
 * 之后对话都交出去了，转发来的也一律 503。
 *
 * 已经连着的直播不归它管：框架在每份对话交接完之后发[请重连帧](../../../docs/terms.md)、自己收线。
 */
import type { MiddlewareHandler } from 'hono';

import type { NodeIdentity } from './routes/forward.js';
import {
  FORWARDED_HEADER,
  isTrustedForward,
  PEER_TOKEN_HEADER,
  RETRY_AFTER_SECONDS,
} from './routes/forward.js';

export interface NodeOffline {
  /** 关上闸门（浏览器来的请求 503）。重复调用无副作用。 */
  goOffline(): void;
  /** 交接完成：转发来的请求也 503。 */
  finishHandover(): void;
  isOffline(): boolean;
  /** 顶层闸门，挂在所有路由之前（含 WebSocket 升级——它也先走 Hono 的中间件链）。 */
  readonly gate: MiddlewareHandler;
}

export function createNodeOffline(node?: NodeIdentity): NodeOffline {
  let offline = false;
  let handedOver = false;

  return {
    goOffline() {
      offline = true;
    },
    finishHandover() {
      handedOver = true;
    },
    isOffline: () => offline,
    gate: async (c, next) => {
      const forwardedInWindow =
        !handedOver &&
        isTrustedForward(
          c.req.header(FORWARDED_HEADER),
          c.req.header(PEER_TOKEN_HEADER),
          node?.peerToken,
        );
      if (!offline || forwardedInWindow) {
        await next();
        return;
      }
      c.header('Retry-After', RETRY_AFTER_SECONDS);
      return c.json(
        { error: 'This node is going offline; retry shortly.' },
        503,
      );
    },
  };
}
