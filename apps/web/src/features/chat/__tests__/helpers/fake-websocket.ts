/**
 * 共享的假 WebSocket——供需要在测试里手动推送/关闭一条 WS 连接的用例复用。
 * `ws.test.ts`、`transport-switch.test.ts` 各自已经有一份局部定义（分别覆盖
 * `streamConversationTailWs` 自身、以及通道切换），这里是给第三处也要用到同样
 * 能力的地方——`use-chat-messages.test.ts` 的[快速重连](../../../../../../../docs/terms.md)
 * 用例（docs/logic/orchestration/tech/handover.md §8）——避免再复制一份。
 */
import { vi } from 'vitest';

export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly CLOSED = 3;

  readonly url: string;
  readyState = 1;
  closedByClient = false;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  close(): void {
    this.closedByClient = true;
    this.emitClose(1000, 'client closed');
  }

  emitMessage(data: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  emitClose(code: number, reason = ''): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close', { code, reason }));
  }
}

/** 清空已记录的实例，并把 `FakeWebSocket` 装成 `globalThis.WebSocket`。 */
export function installFakeWebSocket(): void {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
}
