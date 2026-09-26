/**
 * [直播流](../../../../../docs/terms.md)的 WebSocket 通道——与 `api.ts` 里那条 SSE
 * **同一个签名**，所以上层（`use-chat-messages.ts`）换不换通道一行都不用改。
 *
 * 帧的形状两条完全一样：服务端两边用的是同一个转换函数。SSE 多一个 `event:` 行是协议
 * 要求，WebSocket 没这回事，直接发 JSON 正文——而前端本来就靠**结构**分辨四种帧，不靠
 * 事件名，所以解析代码也是同一份。
 *
 * 浏览器替 SSE 做的两件事，这里要自己来：把地址从 `http(s)` 换成 `ws(s)`；以及把
 * 「正常关闭」与「断线」分开（断线由上层那套退避重连接手）。见
 * docs/ingress/tech/ws-stream.md §4.2。
 */
import type { ChatFrameStreamHandlers } from './api';
import { parseChatReplayFrame } from './schema';

/** 正常关闭：这一轮跑完了，服务端主动收的连接。 */
const NORMAL_CLOSURE = 1000;
/** 会话不存在或不属于你——与 HTTP 那边的 404 同一个意思。 */
const NOT_FOUND = 4004;
/**
 * [请重连帧](../../../../../docs/terms.md)之后的关闭码——服务端发完那一帧就用它关连接
 * （`apps/node-server` 的 `chat-ws.ts` `CLOSE_SERVICE_RESTART`，docs/logic/orchestration/tech/handover.md §8）。
 * **导出**给 `use-chat-messages.ts` 用：即使那一帧因为某种原因没被处理到，单凭这个关闭码
 * 也要走[快速重连](../../../../../docs/terms.md)，不能被当成普通掉线走指数退避。
 */
export const CLOSE_SERVICE_RESTART = 1012;

/** 把页面地址换成 WebSocket 地址：同源、同端口，只是协议不同。 */
function wsUrl(path: string): string {
  const url = new URL(path, window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export class ChatWebSocketError extends Error {
  readonly code: number;

  constructor(code: number, reason: string) {
    super(
      reason.length > 0 ?
        reason
      : `chat websocket closed with code ${String(code)}`,
    );
    this.name = 'ChatWebSocketError';
    this.code = code;
  }
}

/**
 * 连上直播尾巴。**resolve = 流正常结束**（这一轮完了），**reject = 掉线或出错**——
 * 与 SSE 那条一字不差，上层的重连逻辑照原样复用。
 *
 * `signal` 一 abort 就关连接，并且**不 reject**：主动取消不是错误。
 */
export function streamConversationTailWs(
  conversationId: string,
  after: number,
  handlers: ChatFrameStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const socket = new WebSocket(
      wsUrl(
        `/api/chat/conversations/${encodeURIComponent(conversationId)}/ws?after=${encodeURIComponent(String(after))}`,
      ),
    );
    let cancelled = false;

    const onAbort = (): void => {
      cancelled = true;
      socket.close();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const cleanup = (): void => {
      signal?.removeEventListener('abort', onAbort);
    };

    socket.onmessage = (event: MessageEvent<unknown>) => {
      if (typeof event.data !== 'string') {
        handlers.onParseError?.('chat websocket sent a non-text frame');
        return;
      }
      const parsed = parseChatReplayFrame(event.data);
      if (parsed.ok) {
        handlers.onFrame(parsed.frame);
      } else {
        // 坏帧丢掉就好，不该连累这一轮剩下的内容——与 SSE 那条同一个姿态。
        handlers.onParseError?.(parsed.error);
      }
    };

    socket.onclose = (event: CloseEvent) => {
      cleanup();
      if (cancelled || event.code === NORMAL_CLOSURE) {
        resolve();
        return;
      }
      reject(new ChatWebSocketError(event.code, event.reason));
    };

    socket.onerror = () => {
      // 浏览器的 error 事件不带原因，紧跟着一定有 close——真正的处置在那边。
      if (socket.readyState === WebSocket.CLOSED) {
        cleanup();
        reject(new ChatWebSocketError(NOT_FOUND, 'chat websocket failed'));
      }
    };
  });
}
