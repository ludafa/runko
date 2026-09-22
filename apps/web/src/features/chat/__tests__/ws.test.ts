/**
 * [直播流](../../../../../../docs/terms.md)的 WebSocket 通道。
 *
 * 这里守的是**上层看到的那三种结局**——SSE 那条是浏览器替我们分的，WebSocket 要自己分：
 * 正常关闭 = 这一轮完了（resolve）、异常关闭 = 掉线（reject，上层去重连）、主动取消 = 不是错误。
 * 分错的后果很具体：把掉线当成「正常结束」，界面就再也不重连，用户盯着一个不动的页面。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatReplayFrame } from '../schema';
import { streamConversationTailWs } from '../ws';

/** 一个假的 WebSocket：测试自己决定什么时候来消息、什么时候关。 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly CLOSED = 3;

  readonly url: string;
  readyState = 1;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  closedByClient = false;

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

function install(): void {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
}

const frame = (text: string): string =>
  JSON.stringify({ chunk: { type: 'text-delta', id: 't1', delta: text } });

describe('streamConversationTailWs', () => {
  beforeEach(() => {
    install();
  });

  it('地址是同源的 ws://，带上「我看到第几条了」', () => {
    void streamConversationTailWs('conv-1', 7, { onFrame: () => {} });

    const socket = FakeWebSocket.instances[0];
    expect(socket?.url).toContain('/api/chat/conversations/conv-1/ws?after=7');
    expect(socket?.url.startsWith('ws://')).toBe(true);
  });

  it('收到的帧解析出来交给上层', async () => {
    const seen: ChatReplayFrame[] = [];
    const tail = streamConversationTailWs('conv-1', 0, {
      onFrame: (f) => seen.push(f),
    });

    const socket = FakeWebSocket.instances[0];
    socket?.emitMessage(frame('你好'));
    socket?.emitClose(1000);

    await expect(tail).resolves.toBeUndefined();
    expect(JSON.stringify(seen)).toContain('你好');
  });

  it('**正常关闭 = 这一轮完了**（resolve，上层不重连）', async () => {
    const tail = streamConversationTailWs('conv-1', 0, { onFrame: () => {} });
    FakeWebSocket.instances[0]?.emitClose(1000, 'stream ended');

    await expect(tail).resolves.toBeUndefined();
  });

  it('**异常关闭 = 掉线**（reject，上层才会去重连）', async () => {
    const tail = streamConversationTailWs('conv-1', 0, { onFrame: () => {} });
    FakeWebSocket.instances[0]?.emitClose(1006, 'abnormal');

    await expect(tail).rejects.toThrow(/1006|abnormal/);
  });

  it('主动取消不算错误：连接关掉，promise 正常结束', async () => {
    const controller = new AbortController();
    const tail = streamConversationTailWs(
      'conv-1',
      0,
      { onFrame: () => {} },
      controller.signal,
    );

    controller.abort();

    await expect(tail).resolves.toBeUndefined();
    expect(FakeWebSocket.instances[0]?.closedByClient).toBe(true);
  });

  it('已经取消了就不连（传进来的 signal 已 abort）', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      streamConversationTailWs(
        'conv-1',
        0,
        { onFrame: () => {} },
        controller.signal,
      ),
    ).resolves.toBeUndefined();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('坏帧丢掉、报一行，不影响后面的帧', async () => {
    const seen: ChatReplayFrame[] = [];
    const errors: string[] = [];
    const tail = streamConversationTailWs('conv-1', 0, {
      onFrame: (f) => seen.push(f),
      onParseError: (message) => errors.push(message),
    });

    const socket = FakeWebSocket.instances[0];
    socket?.emitMessage('{ 这不是 JSON');
    socket?.emitMessage(frame('还活着'));
    socket?.emitClose(1000);

    await tail;
    expect(errors).toHaveLength(1);
    expect(seen).toHaveLength(1);
  });
});
