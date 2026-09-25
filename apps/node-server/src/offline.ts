/**
 * [节点下线](../../../docs/terms.md)的两样东西：**闸门**（挡新流量）与**下线信号**（断开已连上的直播）。
 * 设计见 docs/host/node/tech/cluster-console.md §4。
 *
 * 触发点只有一个：`index.ts` 收到 SIGTERM。集群里那个 SIGTERM 来自运维容器的 `docker stop`，
 * 本地热重载也发 SIGTERM——两种情况都该先挡流量，所以闸门不区分来源。
 * 什么时候断开直播则要看有没有别的节点能接着播，由 `index.ts` 决定，所以这是两个方法。
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
  /** 关上闸门：之后浏览器来的请求一律 503。重复调用无副作用。 */
  goOffline(): void;
  /** 触发 `signal`，断开已经连上的直播。重复调用无副作用。 */
  disconnectStreams(): void;
  isOffline(): boolean;
  /** `disconnectStreams()` 时触发。直播处理器把它与「连接断了」合并，传给 `runtime.subscribe`。 */
  readonly signal: AbortSignal;
  /**
   * 顶层闸门，挂在所有路由之前（含 WebSocket 升级——它也先走 Hono 的中间件链）。
   *
   * 只放行**别的节点转发来**的请求：那一轮还在本节点上跑，停止、答审批只有本节点能做。
   * 其余一律 503，nginx 见 503 换节点重试。
   */
  readonly gate: MiddlewareHandler;
}

export function createNodeOffline(node?: NodeIdentity): NodeOffline {
  const controller = new AbortController();
  let offline = false;

  return {
    goOffline() {
      offline = true;
    },
    disconnectStreams() {
      if (!controller.signal.aborted) {
        controller.abort(new Error('node going offline'));
      }
    },
    isOffline: () => offline,
    signal: controller.signal,
    gate: async (c, next) => {
      if (
        !offline ||
        isTrustedForward(
          c.req.header(FORWARDED_HEADER),
          c.req.header(PEER_TOKEN_HEADER),
          node?.peerToken,
        )
      ) {
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
