/**
 * 设置页选的通道，聊天页真的会照着连——本文件守的是这条接线
 * （`transport.ts` → `use-chat-messages.ts`）。
 *
 * 三件事：**选什么连什么**、**中途改了立刻换**（关掉旧连接、开新的），以及
 * **换通道不丢内容**（新连接带着「我看到第几条了」，从那儿接着收）。
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatReplayFrame } from '../schema';
import { setChatTransport } from '../transport';
import { useChatMessages } from '../use-chat-messages';
import { FakeChatFetch } from './helpers/fake-chat-fetch';

/** 一个假的 WebSocket：只记录连过哪些地址、有没有被关掉。 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly CLOSED = 3;

  readonly url: string;
  readyState = 1;
  closed = false;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  close(): void {
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close', { code: 1000 }));
  }
}

/** 一段已经落盘的历史：最后一条的 seq 是 2，所以续传应当从 `after=2` 开始。 */
const HISTORY: ChatReplayFrame[] = [
  {
    seq: 1,
    message: { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
  },
  {
    seq: 2,
    message: {
      id: 'm2',
      role: 'assistant',
      parts: [{ type: 'text', text: 'hello', state: 'done' }],
      metadata: { status: 'completed' },
    },
  },
];

function setup(): FakeChatFetch {
  const fake = new FakeChatFetch();
  vi.stubGlobal('fetch', fake.fetch);
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  return fake;
}

describe('直播流按用户选的通道连', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it('没选过 = SSE：走 `GET .../stream`，不开 WebSocket', () => {
    const fake = setup();
    const stream = fake.queueStream();

    renderHook(() => useChatMessages('sess_1', HISTORY));

    expect(fake.streamRequests).toHaveLength(1);
    expect(FakeWebSocket.instances).toHaveLength(0);
    stream.close();
  });

  it('选了 WebSocket：开 ws 连接，**一个 SSE 请求都不发**', () => {
    setChatTransport('ws');
    const fake = setup();

    renderHook(() => useChatMessages('sess_1', HISTORY));

    expect(fake.streamRequests).toEqual([]);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]?.url).toContain(
      '/api/chat/conversations/sess_1/ws?after=2',
    );
  });

  it('**中途改设置就换**：SSE 的连接被断掉，改从 WebSocket 收，且从上次那条接着来', async () => {
    const fake = setup();
    const stream = fake.queueStream();
    renderHook(() => useChatMessages('sess_1', HISTORY));

    expect(fake.streamRequests).toHaveLength(1);
    const sseSignal = fake.streamRequests[0]?.signal;

    act(() => {
      setChatTransport('ws');
    });

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });
    // 旧的那条被主动断开——不然两条连着同一个会话，同样的内容会收两遍。
    expect(sseSignal?.aborted).toBe(true);
    // 续传的水位跟着走：换通道不该把已经看过的内容再收一遍，也不该漏掉中间的。
    expect(FakeWebSocket.instances[0]?.url).toContain('after=2');
    stream.close();
  });

  it('改回 SSE 也一样：WebSocket 关掉，重新走 `GET .../stream`', async () => {
    setChatTransport('ws');
    const fake = setup();
    const stream = fake.queueStream();
    renderHook(() => useChatMessages('sess_1', HISTORY));

    expect(FakeWebSocket.instances).toHaveLength(1);

    act(() => {
      setChatTransport('sse');
    });

    await waitFor(() => {
      expect(fake.streamRequests).toHaveLength(1);
    });
    expect(FakeWebSocket.instances[0]?.closed).toBe(true);
    expect(fake.streamRequests[0]).toMatchObject({
      conversationId: 'sess_1',
      after: 2,
    });
    stream.close();
  });
});
