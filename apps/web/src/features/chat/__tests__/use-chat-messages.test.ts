import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChatReplayFrame, QueuedMessage } from '../schema';
import { buildRenderEntries } from '../timeline';
import { setChatTransport } from '../transport';
import { useChatMessages } from '../use-chat-messages';
import { CLOSE_SERVICE_RESTART } from '../ws';
import { FakeChatFetch } from './helpers/fake-chat-fetch';
import { FakeWebSocket, installFakeWebSocket } from './helpers/fake-websocket';
import {
  assistantMessage,
  finishChunk,
  finishStepChunk,
  messageMetadataChunk,
  startChunk,
  startStepChunk,
  textDeltaChunk,
  textStartChunk,
  textStepChunks,
  toolApprovalRequestChunk,
  toolInputAvailableChunk,
  userMessage,
} from './helpers/runko-chunks';

function setup(): FakeChatFetch {
  const fake = new FakeChatFetch();
  vi.stubGlobal('fetch', fake.fetch);
  return fake;
}

/** 一条[待发队列](../../../../../../docs/terms.md)条目（docs/logic/orchestration/tech/steer-and-queue.md §2.2）。 */
function queuedMessage(id: string, text: string): QueuedMessage {
  return { id, text, userId: 'user-1', createdAt: 1_700_000_000_000 };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  // 只有走 WebSocket 通道的[快速重连](../../../../../../docs/terms.md)用例会碰它
  // （`setChatTransport` 写 `localStorage`）——其余用例从不读写，清空对它们无害。
  window.localStorage.clear();
});

describe('useChatMessages — 挂载', () => {
  it('a history ending in a MessageFrame (gracefully finished turn) starts idle and opens the tail with after=<max seq>', () => {
    const fake = setup();
    const stream = fake.queueStream();
    renderHook(() =>
      useChatMessages('sess_1', [
        {
          seq: 1,
          message: {
            id: 'm1',
            role: 'user',
            parts: [{ type: 'text', text: 'hi' }],
          },
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
      ] satisfies ChatReplayFrame[]),
    );

    expect(fake.streamRequests).toHaveLength(1);
    expect(fake.streamRequests[0]).toMatchObject({
      conversationId: 'sess_1',
      after: 2,
    });
    stream.close();
  });

  it('挂载时的初值来自会话详情的 turnInProgress（服务端读起轮标记那一列给出）——为真即 streaming', () => {
    const fake = setup();
    const stream = fake.queueStream();
    const { result } = renderHook(() =>
      useChatMessages(
        'sess_1',
        [{ seq: 1, chunk: startChunk('m1') }],
        [],
        true,
      ),
    );

    expect(result.current.status).toBe('streaming');
    stream.close();
  });

  it('an empty history (brand-new session) starts idle and opens the tail with after=0', () => {
    const fake = setup();
    const stream = fake.queueStream();
    const { result } = renderHook(() => useChatMessages('sess_1', []));

    expect(result.current.status).toBe('idle');
    expect(fake.streamRequests[0]).toMatchObject({ after: 0 });
    stream.close();
  });

  it('aborts the open tail on unmount', () => {
    const fake = setup();
    const stream = fake.queueStream();
    const { unmount } = renderHook(() => useChatMessages('sess_1', []));
    expect(fake.streamRequests[0]?.signal?.aborted).toBe(false);
    unmount();
    expect(fake.streamRequests[0]?.signal?.aborted).toBe(true);
    stream.close();
  });
});

// ---------------------------------------------------------------------------
// 轮状态快照（docs/ingress/tech/chat-webapp.md §5.1）——服务端在每条 tail 连上时下发的权威
// 「这个会话有没有轮在跑」。任何前端与服务端的分叉都会被下一次 tail 连接纠正。
// ---------------------------------------------------------------------------

describe('useChatMessages — 轮状态快照（turn-state 帧）', () => {
  /** 崩溃残留的会话：历史以 chunk 收尾，挂载时初值说「有轮在跑」。 */
  const crashResidueHistory: ChatReplayFrame[] = [
    { seq: 1, chunk: startChunk('m1') },
  ];

  it('回归：崩溃残留的会话收到 turnActive:false 后落回 idle，发消息重新走「起新一轮」并**有乐观上屏**', async () => {
    const fake = setup();
    const stream = fake.queueStream();
    const { result } = renderHook(() =>
      useChatMessages('sess_1', crashResidueHistory, [], true),
    );

    // 挂载初值说「在跑」，但服务端此刻其实已经没有轮了（这一轮崩过）——
    // 下一帧轮状态快照会把它纠正过来。
    expect(result.current.status).toBe('streaming');

    act(() => {
      stream.pushFrame({ turnActive: false });
    });
    await waitFor(() => {
      expect(result.current.status).toBe('idle');
    });

    // 病根修掉之后的直接后果：这条消息走「起新一轮」，于是立刻有乐观回显上屏
    // （而不是被判成排队、悄悄进待发区、再也发不出去）。
    //
    // 注意判据不是请求体——起新一轮与排队发出的 body 是**同一个**（`intent` 恒为默认
    // 的 `'queue'`，分流权在服务端）。真正区分两条分支的是这两件事：只有起新一轮会
    // 产生乐观回显，也只有它会重开 tail。
    const streamRequestsBefore = fake.streamRequests.length;
    fake.queueStream(); // 起新一轮会重开一条 tail，给它备好
    act(() => {
      result.current.sendMessage('这条要立刻上屏');
    });
    await waitFor(() => {
      expect(fake.messagePosts).toHaveLength(1);
    });
    expect(result.current.pendingUserEchoes).toHaveLength(1);
    expect(result.current.pendingUserEchoes[0]).toMatchObject({
      text: '这条要立刻上屏',
    });
    await waitFor(() => {
      expect(fake.streamRequests.length).toBe(streamRequestsBefore + 1);
    });

    stream.close();
  });

  it('turnActive:true 让本端进入 streaming（另一个标签页起的轮，本端历史还停在上一轮收尾）', async () => {
    const fake = setup();
    const stream = fake.queueStream();
    const { result } = renderHook(() =>
      useChatMessages('sess_1', [
        {
          seq: 1,
          message: {
            id: 'm1',
            role: 'assistant',
            parts: [{ type: 'text', text: 'done', state: 'done' }],
            metadata: { status: 'completed' },
          },
        },
      ] satisfies ChatReplayFrame[]),
    );
    expect(result.current.status).toBe('idle');

    act(() => {
      stream.pushFrame({ turnActive: true });
    });
    await waitFor(() => {
      expect(result.current.status).toBe('streaming');
    });

    // 内部的 turnInProgressRef 也跟着翻真：此后发消息走排队，而不是又起一轮。
    act(() => {
      result.current.sendMessage('排到下一轮');
    });
    await waitFor(() => {
      expect(fake.messagePosts).toHaveLength(1);
    });
    expect(fake.messagePosts[0]?.body).toEqual({
      text: '排到下一轮',
      intent: 'queue',
    });

    stream.close();
  });

  it('turnActive:false 不覆盖 error 态——那条红色的直播中断提示是另一件事', async () => {
    const fake = setup();
    const stream = fake.queueStream();
    fake.setMessagePostStatus(500); // 起轮请求失败 → status 进 error
    const { result } = renderHook(() => useChatMessages('sess_1', []));

    act(() => {
      result.current.sendMessage('起不来的一轮');
    });
    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });

    act(() => {
      stream.pushFrame({ turnActive: false });
    });
    // 「没有轮在跑」本来就是 error 态的题中之意，不该把提示抹成 idle。
    await waitFor(() => {
      expect(result.current.error).toBeDefined();
    });
    expect(result.current.status).toBe('error');

    stream.close();
  });
});

// ---------------------------------------------------------------------------
// 回放顺序（用户实测：对话流顺序错乱）——一段历史里**同时**有崩溃轮留下的 chunk 行
// 与后续轮的 message 行时，两者的物化时机差着一个微任务（message 帧同步 upsert，
// chunk 帧要等 `readUIMessageStream()` 异步吐出）。顺序必须按 **wire 到达先后**定，
// 不能按「谁先物化完」定。
// ---------------------------------------------------------------------------

describe('useChatMessages — 混合帧的回放顺序', () => {
  it('崩溃轮的 chunk 行排在后续轮的 message 行**前面**（按 wire 顺序，不按物化先后）', async () => {
    const fake = setup();
    const stream = fake.queueStream();

    // 账本长这样：一轮崩在半路（只留下 chunk 行 + 启动时补的 interrupted 收尾），
    // 用户之后又发了「继续」，那一轮正常收尾（落成 message 行）。
    const crashedTurnChunks = textStepChunks({
      messageId: 'm-crashed',
      textId: 't1',
      text: '我正在改 globals.css…',
    });
    const initialFrames: ChatReplayFrame[] = [
      ...crashedTurnChunks.map((chunk, index) => ({ seq: index + 1, chunk })),
      {
        seq: crashedTurnChunks.length + 1,
        chunk: messageMetadataChunk({
          status: 'interrupted',
          error: {
            code: 'aborted',
            message: 'The server shut down while this turn was running.',
          },
        }),
      },
      {
        seq: crashedTurnChunks.length + 2,
        message: userMessage('m-u', '继续'),
      },
      {
        seq: crashedTurnChunks.length + 3,
        message: assistantMessage(
          'm-next',
          [{ type: 'text', text: '好的，我接着来', state: 'done' }],
          { status: 'completed' },
        ),
      },
    ];

    const { result } = renderHook(() =>
      useChatMessages('sess_1', initialFrames),
    );

    // chunk 的物化是异步的——等它落位。
    await waitFor(() => {
      expect(result.current.messages).toHaveLength(3);
    });

    // 关键断言：崩溃轮在最前，不是被挤到末尾。
    expect(result.current.messages.map((message) => message.id)).toEqual([
      'm-crashed',
      'm-u',
      'm-next',
    ]);

    stream.close();
  });
});

describe('useChatMessages — seq dedup', () => {
  it('ignores a second frame carrying an already-seen seq, even with different content', async () => {
    const fake = setup();
    const stream = fake.queueStream();
    const { result } = renderHook(() => useChatMessages('sess_1', []));

    act(() => {
      stream.pushChunk(
        messageMetadataChunk({ turn: 1, usage: {}, status: 'completed' }),
        5,
      );
    });
    await waitFor(() => {
      expect(result.current.status).toBe('idle');
    });

    act(() => {
      // 与上面同一个 seq（5），但载荷**不同**。去重只按 seq 判（`applyFrame` 的
      // `seenSeqs` 就是这么做的），所以这一帧根本不该进账本：status 必须还是
      // 'idle'，不能翻成 'error'。
      stream.pushChunk(
        messageMetadataChunk({
          turn: 1,
          usage: {},
          status: 'failed',
          error: { code: 'provider_error', message: 'should be ignored' },
        }),
        5,
      );
    });
    // 给那个「万一没被去重」的更新一点时间落地。
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(result.current.status).toBe('idle');
    expect(result.current.error).toBeUndefined();
    stream.close();
  });
});

describe('useChatMessages — reconnect backoff', () => {
  it('reconnects with exponential backoff (1s, 2s, 4s, 8s, 16s) after a non-abort disconnect while a turn is in progress, then gives up quietly', async () => {
    vi.useFakeTimers();
    const fake = setup();
    // 挂载时就有一轮在跑（历史以一条裸 chunk 结尾）——挂载自己那次 tail 尝试，加上
    // 5 次重连尝试，全部以非 2xx 状态失败（算掉线，不是 AbortError）。
    for (let i = 0; i < 6; i++) {
      fake.queueStreamError(503);
    }

    renderHook(() =>
      useChatMessages(
        'sess_1',
        [{ seq: 1, chunk: startChunk('m1') }],
        [],
        true,
      ),
    );

    await vi.waitFor(() => {
      expect(fake.streamRequests).toHaveLength(1);
    });

    const delays = [1000, 2000, 4000, 8000, 16000];
    for (let i = 0; i < delays.length; i++) {
      const delay = delays[i];
      if (delay === undefined) {
        continue;
      }

      await vi.advanceTimersByTimeAsync(delay);

      await vi.waitFor(() => {
        expect(fake.streamRequests).toHaveLength(i + 2);
      });
    }

    // 5 次重连（加上最初那次）全部用完——再往后推时间（远超第 6 档退避延迟）也不
    // 能再排一次重连。
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.streamRequests).toHaveLength(6);
    expect(fake.streamRequests.every((r) => r.after === 1)).toBe(true);
  });

  it('does not reconnect after a clean AbortError (deliberate stop, not a disconnect)', async () => {
    const fake = setup();
    const stream = fake.queueStream();
    const { unmount } = renderHook(() =>
      useChatMessages(
        'sess_1',
        [{ seq: 1, chunk: startChunk('m1') }],
        [],
        true,
      ),
    );
    unmount(); // 断掉 tail——streamConversationTail 会以 AbortError reject
    stream.error(new DOMException('aborted', 'AbortError'));

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.streamRequests).toHaveLength(1); // 一次重连都没发起
  });
});

// ---------------------------------------------------------------------------
// 快速重连（docs/logic/orchestration/tech/handover.md §8）——收到[请重连帧](../../../../../../docs/terms.md)
// （或 WS 以 1012 关闭）时不走 1/2/4/8/16 秒的指数退避，隔 250ms 直接再试；窗口
// （10 秒）用完退回原退避。真正的断线（没收到那一帧）仍走原退避——已经由上面
// 「reconnect backoff」那组用例覆盖。
// ---------------------------------------------------------------------------

describe('useChatMessages — 快速重连（docs/logic/orchestration/tech/handover.md §8）', () => {
  it('SSE：收到请重连帧后约 250ms 内重连（不是 1 秒起步的指数退避），期间状态全程 streaming、不报错', async () => {
    vi.useFakeTimers();
    const fake = setup();
    const stream = fake.queueStream();
    const { result } = renderHook(() =>
      useChatMessages(
        'sess_1',
        [{ seq: 1, chunk: startChunk('m1') }],
        [],
        true,
      ),
    );
    await vi.waitFor(() => {
      expect(fake.streamRequests).toHaveLength(1);
    });
    expect(result.current.status).toBe('streaming');

    const nextStream = fake.queueStream();
    act(() => {
      stream.pushFrame({ reconnect: true });
      // 请重连帧是这条连接的最后一帧，服务端发完自己关掉（SSE 直接结束响应体）。
      stream.close();
    });

    // 还没到 250ms——不该已经重连（区别于指数退避第一档的 1000ms）。
    await vi.advanceTimersByTimeAsync(200);
    expect(fake.streamRequests).toHaveLength(1);
    expect(result.current.status).toBe('streaming');
    expect(result.current.error).toBeUndefined();

    await vi.advanceTimersByTimeAsync(60);
    await vi.waitFor(() => {
      expect(fake.streamRequests).toHaveLength(2);
    });
    // 续传水位没丢——从上次看到的那条接着来。
    expect(fake.streamRequests[1]).toMatchObject({ after: 1 });
    expect(result.current.status).toBe('streaming');
    expect(result.current.error).toBeUndefined();

    nextStream.close();
  });

  it('WS：收到请重连帧、并以 1012（CLOSE_SERVICE_RESTART）关闭，同样约 250ms 内快速重连', async () => {
    vi.useFakeTimers();
    const fake = setup();
    installFakeWebSocket();
    setChatTransport('ws');
    const { result } = renderHook(() =>
      useChatMessages(
        'sess_1',
        [{ seq: 1, chunk: startChunk('m1') }],
        [],
        true,
      ),
    );
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(result.current.status).toBe('streaming');

    act(() => {
      FakeWebSocket.instances[0]?.emitMessage(
        JSON.stringify({ reconnect: true }),
      );
      FakeWebSocket.instances[0]?.emitClose(CLOSE_SERVICE_RESTART, '');
    });

    await vi.advanceTimersByTimeAsync(200);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(result.current.status).toBe('streaming');

    await vi.advanceTimersByTimeAsync(60);
    await vi.waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(2);
    });
    expect(result.current.status).toBe('streaming');
    expect(result.current.error).toBeUndefined();
    expect(fake.streamRequests).toEqual([]); // 全程没有发出过一次 SSE 请求
  });

  it('快速重连窗口（10 秒）用完之后退回原有的指数退避（从 1 秒这一档重新数）', async () => {
    vi.useFakeTimers();
    const fake = setup();
    const stream = fake.queueStream();
    renderHook(() =>
      useChatMessages(
        'sess_1',
        [{ seq: 1, chunk: startChunk('m1') }],
        [],
        true,
      ),
    );
    await vi.waitFor(() => {
      expect(fake.streamRequests).toHaveLength(1);
    });

    act(() => {
      stream.pushFrame({ reconnect: true });
      stream.close();
    });

    // 窗口内每 250ms 重试一次，全部落空——队列已空，fake 对没排队的 stream 请求
    // 自动回 500（见 FakeChatFetch.fetch），这本身就等同于「重连失败」。
    await vi.advanceTimersByTimeAsync(10_050);
    const requestsAfterWindow = fake.streamRequests.length;
    expect(requestsAfterWindow).toBeGreaterThan(1); // 窗口内确实重试过

    // 窗口刚过，下一次重试还没到——指数退避第一档是 1000ms，比 250ms 长得多。
    await vi.advanceTimersByTimeAsync(900);
    expect(fake.streamRequests.length).toBe(requestsAfterWindow);

    await vi.advanceTimersByTimeAsync(200);
    await vi.waitFor(() => {
      expect(fake.streamRequests.length).toBe(requestsAfterWindow + 1);
    });
  });

  it('新连接一收到第一帧就结束快速重连窗口——窗口没到期，但之后的断线不再按 250ms 重试', async () => {
    vi.useFakeTimers();
    const fake = setup();
    const stream = fake.queueStream();
    renderHook(() =>
      useChatMessages(
        'sess_1',
        [{ seq: 1, chunk: startChunk('m1') }],
        [],
        true,
      ),
    );
    await vi.waitFor(() => {
      expect(fake.streamRequests).toHaveLength(1);
    });

    const reconnectedStream = fake.queueStream();
    act(() => {
      stream.pushFrame({ reconnect: true });
      stream.close();
    });
    await vi.advanceTimersByTimeAsync(260);
    await vi.waitFor(() => {
      expect(fake.streamRequests).toHaveLength(2);
    });

    // 新连接送来了第一帧——即使只是[轮状态快照](../../../../../../docs/terms.md)、没有任何
    // 账本内容（正是接手节点查不到工具收尾结果就放手时给出的那种回应），也说明这次
    // 重连已经成功，快速重连窗口该到此结束，不用等它自己 10 秒过期。
    const nextBackoffStream = fake.queueStream();
    act(() => {
      reconnectedStream.pushFrame({ turnActive: true });
      reconnectedStream.close(); // 之后正常断线——没有再收到请重连帧
    });

    // 还没到 1000ms（指数退避第一档）——如果窗口没结束，250ms 就该已经重试过了。
    await vi.advanceTimersByTimeAsync(900);
    expect(fake.streamRequests).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(200);
    await vi.waitFor(() => {
      expect(fake.streamRequests).toHaveLength(3);
    });

    nextBackoffStream.close();
  });
});

// ---------------------------------------------------------------------------
// 已交权（docs/logic/orchestration/tech/handover.md §6）——`onTurnEnd` 收到
// `metadata.status === 'handed-over'` 时这一轮没有结束，保持 streaming、等接手节点
// 的帧接上。`handedOver.callIds` 为空 = 模型输出段被交权，那半段字要被丢弃
// （`MessageLedger.replaceDraft()`）；非空 = 工具段被交权，账本末尾那次悬空调用
// 是真实状态，留给接手节点结清，不能被当草稿丢。
// ---------------------------------------------------------------------------

describe('useChatMessages — 已交权（docs/logic/orchestration/tech/handover.md §6）', () => {
  it('模型输出段被交权（handedOver.callIds 为空）：不报错、保持 streaming，旧节点流出来的那半段字被整体丢弃', async () => {
    const fake = setup();
    const stream = fake.queueStream();
    const nextStream = fake.queueStream(); // handed-over 之后 startTail() 会重新（重）开一条 tail
    const { result } = renderHook(() => useChatMessages('sess_1', []));

    act(() => {
      stream.pushChunk(startChunk('draft-1'), 1);
      stream.pushChunk(startStepChunk(), 2);
      stream.pushChunk(textStartChunk('t'), 3);
      stream.pushChunk(textDeltaChunk('t', '旧节点输出到一半'));
    });
    await waitFor(() => {
      expect(result.current.messages).toHaveLength(1);
    });

    act(() => {
      // 掐断模型流、不发 finish——服务端直接以独立的 message-metadata 收尾
      // （docs/logic/orchestration/tech/handover.md §6.1）。
      stream.pushChunk(
        messageMetadataChunk({
          turn: 1,
          usage: {},
          status: 'handed-over',
          handedOver: { callIds: [] },
        }),
        4,
      );
    });

    await waitFor(() => {
      expect(result.current.messages).toHaveLength(0);
    });
    expect(result.current.status).toBe('streaming');
    expect(result.current.error).toBeUndefined();
    expect(result.current.awaitingFirstEvent).toBe(true);

    stream.close();
    nextStream.close();
  });

  it('工具段被交权（handedOver.callIds 非空）：不报错、保持 streaming，带悬空调用的那条消息不被丢弃', async () => {
    const fake = setup();
    const stream = fake.queueStream();
    const nextStream = fake.queueStream();
    const { result } = renderHook(() => useChatMessages('sess_1', []));

    act(() => {
      // 工具段交权时这一步已经正常 finish 了（旧节点不动工具，调用参数落账本，
      // 悬空调用留给接手节点结清）。
      stream.pushChunk(startChunk('tool-msg-1'), 1);
      stream.pushChunk(startStepChunk(), 2);
      stream.pushChunk(
        toolInputAvailableChunk('call-1', 'bash', { command: 'sleep 90' }),
        3,
      );
      stream.pushChunk(finishStepChunk(), 4);
      stream.pushChunk(finishChunk('tool-calls'), 5);
    });
    await waitFor(() => {
      expect(result.current.messages).toHaveLength(1);
    });

    act(() => {
      stream.pushChunk(
        messageMetadataChunk({
          turn: 1,
          usage: {},
          status: 'handed-over',
          handedOver: { callIds: ['call-1'] },
        }),
        6,
      );
    });

    await waitFor(() => {
      expect(result.current.status).toBe('streaming');
    });
    expect(result.current.error).toBeUndefined();
    expect(result.current.awaitingFirstEvent).toBe(true);
    // 带悬空调用的消息是真实状态，要留给接手节点结清——不能被当草稿丢掉。
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]?.id).toBe('tool-msg-1');

    stream.close();
    nextStream.close();
  });
});

// ---------------------------------------------------------------------------
// 断线重连一律先丢一次草稿（docs/logic/orchestration/tech/handover.md §8）——不只是「实时收到
// 了 handed-over 的 metadata」那一种情形：那条 metadata 发出的那一刻连接恰好断着、
// 客户端从未见过它，一样要在下一次真正重连、接住新连接的帧之前丢一次手上的草稿，
// 不能指望某次单独的 onTurnEnd 回调来兜底。
// ---------------------------------------------------------------------------

describe('useChatMessages — 重连一律先丢一次草稿（不止「实时收到 handed-over」那一种情形）', () => {
  it('从未收到 handed-over 的 metadata（那条 chunk 发出时连接正好断着）：真正断线重连之后，旧节点流出来的半截字不会和接手节点的新内容一起留在时间线上', async () => {
    const fake = setup();
    const stream = fake.queueStream();
    const { result } = renderHook(() =>
      useChatMessages('sess_1', [], [], true),
    );

    // 旧节点流出一半就断线——没有 finish，也没有收尾的 message-metadata（模拟
    // handed-over 那条 chunk 发出时连接正好断着，客户端从未见过它）。
    act(() => {
      stream.pushChunk(startChunk('draft-1'), 1);
      stream.pushChunk(startStepChunk(), 2);
      stream.pushChunk(textStartChunk('t'), 3);
      stream.pushChunk(textDeltaChunk('t', '旧节点输出到一半'));
    });
    await waitFor(() => {
      expect(result.current.messages).toHaveLength(1);
    });
    expect(result.current.messages[0]?.id).toBe('draft-1');

    // 真正的断线（不是请重连帧）——走指数退避，第一档 1000ms 后重试。接手节点从
    // 账本直接接着调模型，产出的是一条全新 id 的消息（§6.1：旧的半截字整个作废，
    // 永远不会再被更新）。
    const nextStream = fake.queueStream();
    act(() => {
      stream.error(new Error('network drop'));
    });
    await waitFor(
      () => {
        expect(fake.streamRequests).toHaveLength(2);
      },
      { timeout: 3000 },
    );

    // [seq](../../../../../../docs/terms.md) 接着上一条连接已经见过的往后编号——
    // 重连时的续传是 `after=<lastSeq>`，用回 1/2/3 会撞上去重簿记，被当成重复帧
    // 直接丢弃。
    act(() => {
      nextStream.pushChunk(startChunk('resumed-1'), 4);
      nextStream.pushChunk(startStepChunk(), 5);
      nextStream.pushChunk(textStartChunk('t2'), 6);
      nextStream.pushChunk(textDeltaChunk('t2', '接手节点重新生成的内容'));
    });
    await waitFor(() => {
      expect(result.current.messages).toHaveLength(1);
    });
    // 只剩接手节点的新内容——旧节点那半截字（'draft-1'）已经被重连时丢弃，不会与
    // 新内容一起堆在时间线上。
    expect(result.current.messages[0]?.id).toBe('resumed-1');

    nextStream.close();
  }, 10_000);

  it('对照组：同一轮在同一连接上正常收尾，随后开新一轮——上一轮没来得及落地的消息不受影响（不是「重连」，是主动开一条全新连接）', async () => {
    const fake = setup();
    const mountStream = fake.queueStream();
    const { result } = renderHook(() => useChatMessages('sess_1', []));

    const turn1Stream = fake.queueStream();
    act(() => {
      result.current.sendMessage('第一条');
    });
    act(() => {
      turn1Stream.pushMessage(1, userMessage('u1', '第一条'));
      turn1Stream.pushChunk(startChunk('a1'), 2);
      turn1Stream.pushChunk(finishChunk('stop'), 3);
      turn1Stream.pushChunk(
        messageMetadataChunk({ turn: 1, usage: {}, status: 'completed' }),
        4,
      );
    });
    await waitFor(() => {
      expect(result.current.status).toBe('idle');
    });
    // 'a1' 只由 chunk 物化出来，从未以 MessageFrame 落地过——这是本用例要保护的对象。
    expect(result.current.messages.map((m) => m.id)).toEqual(['u1', 'a1']);

    const turn2Stream = fake.queueStream();
    act(() => {
      result.current.sendMessage('第二条');
    });
    await waitFor(() => {
      expect(fake.streamRequests).toHaveLength(3);
    });
    act(() => {
      turn2Stream.pushMessage(5, userMessage('u2', '第二条'));
    });
    await waitFor(() => {
      expect(result.current.messages.map((m) => m.id)).toContain('u2');
    });
    // 上一轮的 'a1' 还在——开新一轮不是重连，不该触发 `replaceDraft()`。
    expect(result.current.messages.map((m) => m.id)).toEqual([
      'u1',
      'a1',
      'u2',
    ]);

    mountStream.close();
    turn1Stream.close();
    turn2Stream.close();
  });
});

describe('useChatMessages — pendingUserEchoes', () => {
  it('anchors each echo at messages.length at send time; an echo is only ever popped by the real turn-start user MessageFrame (a separate coverage below) — a turn whose tail never sends one (this test only ever pushes plain chunks) leaves an earlier echo in place', async () => {
    const fake = setup();
    // `sendMessage` 的 POST 一 resolve 就会（重）开 tail，哪怕这个会话此刻还没有轮在跑
    // （见 `use-chat-messages.ts` 的文件头）。所以挂载自己开的那条 tail，与真正承载第 1
    // 轮帧的那条，是两条不同的、前者很短命的连接。
    const mountStream = fake.queueStream();
    const { result } = renderHook(() => useChatMessages('sess_1', []));

    const turn1Stream = fake.queueStream();
    act(() => {
      result.current.sendMessage('第一条');
    });
    await waitFor(() => {
      expect(result.current.pendingUserEchoes).toHaveLength(1);
    });
    expect(result.current.pendingUserEchoes[0]).toMatchObject({
      text: '第一条',
      afterMessageCount: 0,
    });
    await waitFor(() => {
      expect(fake.streamRequests).toHaveLength(2); // 挂载那条 + POST 之后重开的那条
    });

    // 这一轮跑完——messages 多出一条 assistant 消息。
    act(() => {
      turn1Stream.pushChunk(startChunk('a1'), 1);
      turn1Stream.pushChunk(finishChunk('stop'), 2);
      turn1Stream.pushChunk(
        messageMetadataChunk({ turn: 1, usage: {}, status: 'completed' }),
        3,
      );
    });
    await waitFor(() => {
      expect(result.current.status).toBe('idle');
    });
    await waitFor(() => {
      expect(result.current.messages.length).toBeGreaterThan(0);
    });
    const messagesAfterTurn1 = result.current.messages.length;

    const turn2Stream = fake.queueStream();
    act(() => {
      result.current.sendMessage('第二条');
    });
    await waitFor(() => {
      expect(result.current.pendingUserEchoes).toHaveLength(2);
    });

    // 两条回显都还在：这个用例里的轮从不发起轮 MessageFrame（只推裸 chunk），所以
    // 没有任何东西会把它们弹出去。第一条仍锚在 0，第二条锚在**它自己**发出时的
    // messages.length（那时第 1 轮已经落定）。
    expect(result.current.pendingUserEchoes[0]).toMatchObject({
      text: '第一条',
      afterMessageCount: 0,
    });
    expect(result.current.pendingUserEchoes[1]).toMatchObject({
      text: '第二条',
      afterMessageCount: messagesAfterTurn1,
    });

    mountStream.close();
    turn1Stream.close();
    turn2Stream.close();
  });

  it('undoes the optimistic echo if the POST that starts the turn fails', async () => {
    const fake = setup();
    const stream = fake.queueStream();
    fake.setMessagePostStatus(500);
    const { result } = renderHook(() => useChatMessages('sess_1', []));

    act(() => {
      result.current.sendMessage('会失败的消息');
    });
    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.pendingUserEchoes).toHaveLength(0);
    stream.close();
  });

  it('pops the oldest pending echo (FIFO) the instant the real turn-start user MessageFrame arrives over the tail (this ticket’s fix)', async () => {
    const fake = setup();
    const mountStream = fake.queueStream();
    const { result } = renderHook(() => useChatMessages('sess_1', []));

    const turnStream = fake.queueStream();
    act(() => {
      result.current.sendMessage('第一条');
    });
    await waitFor(() => {
      expect(result.current.pendingUserEchoes).toHaveLength(1);
    });

    act(() => {
      turnStream.pushMessage(1, userMessage('u1', '第一条'));
    });
    await waitFor(() => {
      expect(result.current.pendingUserEchoes).toHaveLength(0);
    });
    expect(result.current.messages.map((m) => m.role)).toEqual(['user']);
    expect(result.current.messages[0]?.id).toBe('u1'); // 是真实消息，不是那条回显

    mountStream.close();
    turnStream.close();
  });

  it('the POST-failure rollback path and the FIFO pop-on-MessageFrame path don’t interfere with each other: a turn that pops its own echo via a real MessageFrame, followed by a later send whose POST fails, ends with pendingUserEchoes empty either way — never double-removed, never left dangling', async () => {
    const fake = setup();
    const mountStream = fake.queueStream();
    const { result } = renderHook(() => useChatMessages('sess_1', []));

    const turn1Stream = fake.queueStream();
    act(() => {
      result.current.sendMessage('第一条');
    });
    await waitFor(() => {
      expect(result.current.pendingUserEchoes).toHaveLength(1);
    });
    act(() => {
      turn1Stream.pushMessage(1, userMessage('u1', '第一条'));
    });
    await waitFor(() => {
      expect(result.current.pendingUserEchoes).toHaveLength(0); // 走 MessageFrame 那条路弹掉了
    });
    act(() => {
      turn1Stream.pushChunk(startChunk('a1'), 2);
      turn1Stream.pushChunk(finishChunk('stop'), 3);
      turn1Stream.pushChunk(
        messageMetadataChunk({ turn: 1, usage: {}, status: 'completed' }),
        4,
      );
    });
    await waitFor(() => {
      expect(result.current.status).toBe('idle');
    });

    fake.setMessagePostStatus(500);
    const unusedStream = fake.queueStream(); // 不会被消费——POST 先失败了，tail 根本没重开
    act(() => {
      result.current.sendMessage('第二条（会失败）');
    });
    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    // 走的是「按 id 过滤」那条回滚路径，不是 FIFO 弹出那条。两条路最后都归空，既不会
    // 重复删，也不会留下一条挂着不管。
    expect(result.current.pendingUserEchoes).toHaveLength(0);
    expect(result.current.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
    ]); // 第 2 轮那次失败的发送没有动到第 1 轮的消息

    mountStream.close();
    turn1Stream.close();
    unusedStream.close();
  });

  it('end-to-end: send msg1 → its MessageFrame pops echo1 → turn1 finishes → send msg2 → its MessageFrame pops echo2 → turn2 finishes — final render order is user1, assistant1, user2, assistant2, never reordered (the exact "连发两条消息乱序" scenario this ticket fixes)', async () => {
    const fake = setup();
    const mountStream = fake.queueStream();
    const { result } = renderHook(() => useChatMessages('sess_1', []));

    const turn1Stream = fake.queueStream();
    act(() => {
      result.current.sendMessage('msg1');
    });
    await waitFor(() => {
      expect(result.current.pendingUserEchoes).toHaveLength(1);
    });

    act(() => {
      turn1Stream.pushMessage(1, userMessage('u1', 'msg1'));
    });
    await waitFor(() => {
      expect(result.current.pendingUserEchoes).toHaveLength(0);
    });
    act(() => {
      turn1Stream.pushChunk(startChunk('a1'), 2);
      turn1Stream.pushChunk(finishChunk('stop'), 3);
      turn1Stream.pushChunk(
        messageMetadataChunk({ turn: 1, usage: {}, status: 'completed' }),
        4,
      );
    });
    await waitFor(() => {
      expect(result.current.status).toBe('idle');
    });
    expect(result.current.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
    ]);

    const turn2Stream = fake.queueStream();
    act(() => {
      result.current.sendMessage('msg2');
    });
    await waitFor(() => {
      expect(result.current.pendingUserEchoes).toHaveLength(1);
    });
    // 半途状态（echo2 还挂着，msg2 的真实消息还没落地）：交错之后的渲染顺序此刻就已经
    // 是对的。
    expect(
      buildRenderEntries(
        result.current.messages,
        result.current.pendingUserEchoes,
      ).map((entry) =>
        entry.kind === 'message' ? entry.message.role : 'pending-echo',
      ),
    ).toEqual(['user', 'assistant', 'pending-echo']);

    act(() => {
      turn2Stream.pushMessage(5, userMessage('u2', 'msg2'));
    });
    await waitFor(() => {
      expect(result.current.pendingUserEchoes).toHaveLength(0);
    });
    act(() => {
      turn2Stream.pushChunk(startChunk('a2'), 6);
      turn2Stream.pushChunk(finishChunk('stop'), 7);
      turn2Stream.pushChunk(
        messageMetadataChunk({ turn: 2, usage: {}, status: 'completed' }),
        8,
      );
    });
    await waitFor(() => {
      expect(result.current.status).toBe('idle');
    });

    expect(result.current.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(result.current.pendingUserEchoes).toHaveLength(0);

    mountStream.close();
    turn1Stream.close();
    turn2Stream.close();
  });
});

describe('useChatMessages — submitApproval / submitAnswer', () => {
  function renderWithPendingApproval(fake: FakeChatFetch) {
    const stream = fake.queueStream();
    const rendered = renderHook(() => useChatMessages('sess_1', []));
    act(() => {
      stream.pushChunk(startChunk('a1'), 1);
      stream.pushChunk(
        toolInputAvailableChunk('call-1', 'bash', { command: 'ls' }),
        2,
      );
      stream.pushChunk(toolApprovalRequestChunk('call-1'), 3);
    });
    return { ...rendered, stream };
  }

  it('a 404 on submitApproval marks the callId locallyExpired, not a hook-level error', async () => {
    const fake = setup();
    fake.setApprovalStatus(404);
    const { result, stream } = renderWithPendingApproval(fake);

    await waitFor(() => {
      expect(result.current.messages.length).toBeGreaterThan(0);
    });

    act(() => {
      result.current.submitApproval('call-1', 'allow');
    });

    await waitFor(() => {
      expect(result.current.locallyExpiredCallIds.has('call-1')).toBe(true);
    });
    expect(result.current.error).toBeUndefined();
    stream.close();
  });

  it('a non-404 failure on submitApproval surfaces as a hook-level error, not locallyExpired', async () => {
    const fake = setup();
    fake.setApprovalStatus(500);
    const { result, stream } = renderWithPendingApproval(fake);

    await waitFor(() => {
      expect(result.current.messages.length).toBeGreaterThan(0);
    });

    act(() => {
      result.current.submitApproval('call-1', 'deny');
    });

    await waitFor(() => {
      expect(result.current.error).toBeDefined();
    });
    expect(result.current.locallyExpiredCallIds.has('call-1')).toBe(false);
    stream.close();
  });

  it('a second submitApproval for the same callId while one is already in flight is swallowed (only one POST goes out)', async () => {
    const fake = setup();
    const { result, stream } = renderWithPendingApproval(fake);

    await waitFor(() => {
      expect(result.current.messages.length).toBeGreaterThan(0);
    });

    // 刻意分成**两次** `act()`，不是一批：`submittingCallIds` 是 `useState`，只有 React
    // 在两次调用之间真的重渲染过一次，`submitDecision` 里的那道判断才看得到它已更新。
    //
    // 这也对应真实用法：同一 tick 内的连点由卡片自己的 `disabled={submitting}` 在 DOM
    // 层挡住；hook 里这道判断挡的是重渲染之后又来的第二次**程序化**调用。
    act(() => {
      result.current.submitApproval('call-1', 'allow');
    });
    expect(result.current.submittingCallIds.has('call-1')).toBe(true);
    act(() => {
      result.current.submitApproval('call-1', 'allow');
    });

    await waitFor(() => {
      expect(result.current.submittingCallIds.has('call-1')).toBe(false);
    });
    expect(fake.approvalPosts).toHaveLength(1);
    stream.close();
  });

  it('a 404 on submitAnswer marks the callId locallyExpired', async () => {
    const fake = setup();
    fake.setAnswerStatus(404);
    const stream = fake.queueStream();
    const { result } = renderHook(() => useChatMessages('sess_1', []));
    act(() => {
      stream.pushChunk(startChunk('a1'), 1);
      stream.pushChunk(
        toolInputAvailableChunk('call-2', 'ask-user', { question: '选哪个？' }),
        2,
      );
    });
    await waitFor(() => {
      expect(result.current.messages.length).toBeGreaterThan(0);
    });

    act(() => {
      result.current.submitAnswer('call-2', '选 A');
    });

    await waitFor(() => {
      expect(result.current.locallyExpiredCallIds.has('call-2')).toBe(true);
    });
    stream.close();
  });

  it('submitAnswer with only whitespace is a no-op (no POST)', async () => {
    const fake = setup();
    const { result, stream } = renderWithPendingApproval(fake);
    await waitFor(() => {
      expect(result.current.messages.length).toBeGreaterThan(0);
    });

    act(() => {
      result.current.submitAnswer('call-1', '   ');
    });

    expect(fake.answerPosts).toHaveLength(0);
    stream.close();
  });
});

// ---------------------------------------------------------------------------
// 待发队列（[排队](../../../../../../docs/terms.md)，docs/logic/orchestration/tech/steer-and-queue.md §6）
// ---------------------------------------------------------------------------

describe('useChatMessages — 待发队列', () => {
  it('会话详情给的初始队列直接可见；直播流的 QueueFrame 快照随后覆盖它', async () => {
    const fake = setup();
    const stream = fake.queueStream();
    const { result } = renderHook(() =>
      useChatMessages('sess_1', [], [queuedMessage('q1', '排队中的一条')]),
    );

    expect(result.current.queuedMessages.map((m) => m.text)).toEqual([
      '排队中的一条',
    ]);

    act(() => {
      // 服务端的权威快照（每条 tail 连上必发一帧）——直接覆盖，不做合并。
      stream.pushFrame({
        queue: [
          queuedMessage('q1', '排队中的一条'),
          queuedMessage('q2', '又一条'),
        ],
      });
    });

    await waitFor(() => {
      expect(result.current.queuedMessages.map((m) => m.text)).toEqual([
        '排队中的一条',
        '又一条',
      ]);
    });
    stream.close();
  });

  it('QueueFrame 不进账本：它既不产生消息，也不占用 seq 续传位', async () => {
    const fake = setup();
    const stream = fake.queueStream();
    const { result } = renderHook(() => useChatMessages('sess_1', []));

    act(() => {
      stream.pushFrame({ queue: [queuedMessage('q1', '排一条')] });
    });
    await waitFor(() => {
      expect(result.current.queuedMessages).toHaveLength(1);
    });

    expect(result.current.messages).toEqual([]);
    stream.close();
  });

  it('流式中发消息默认带 intent "queue"，显式 steer 则带 "steer"（只有 steer 产生乐观 echo）', async () => {
    const fake = setup();
    const stream = fake.queueStream();
    // 历史以 chunk 收尾 = 挂载时就有进行中的一轮。
    const { result } = renderHook(() =>
      useChatMessages(
        'sess_1',
        [{ seq: 1, chunk: startChunk('m1') }],
        [],
        true,
      ),
    );

    act(() => {
      result.current.sendMessage('排到下一轮');
    });
    await waitFor(() => {
      expect(fake.messagePosts).toHaveLength(1);
    });
    expect(fake.messagePosts[0]?.body).toEqual({
      text: '排到下一轮',
      intent: 'queue',
    });

    act(() => {
      result.current.sendMessage('插进这一轮', 'steer');
    });
    await waitFor(() => {
      expect(fake.messagePosts).toHaveLength(2);
    });
    expect(fake.messagePosts[1]?.body).toEqual({
      text: '插进这一轮',
      intent: 'steer',
    });

    // 排队不做乐观 echo（服务端的 QueueFrame 快照会把它回填到待发区，那里就是
    // 它的可见位置）；steer 做——它的真实注入点是 core 的下一个 step 边界，可能
    // 等几十秒，在那之前界面上什么都不发生用户会以为按钮没生效
    //（docs/ingress/features/chat-ui.md、2026-07-25）。
    expect(result.current.pendingUserEchoes).toEqual([
      // 锚点恒为 MAX_SAFE_INTEGER：`buildRenderEntries` 把越界锚点夹到末尾，
      // 于是这条「待注入」在等待期间始终待在时间线最下面，不会被后续 step 产出的
      // 新消息挤到中间去（用 `messages.length` 快照锚点就会）。
      {
        id: 1,
        text: '插进这一轮',
        afterMessageCount: Number.MAX_SAFE_INTEGER,
        steered: true,
      },
    ]);
    stream.close();
  });

  // 请求 steer 但服务端回 `'queued'`：那一轮还卡在[起轮装配](../../../../../../docs/terms.md)
  // 里，没有 session 可插，服务端只能给它排队（docs/logic/orchestration/tech/turn-abort.md §3.3）。
  it('steer 拿回 mode "queued" 时撤掉那条「待注入」回显——它永远等不到注入点', async () => {
    const fake = setup();
    fake.setMessagePostMode('queued');
    const stream = fake.queueStream();
    const { result } = renderHook(() =>
      useChatMessages(
        'sess_1',
        [{ seq: 1, chunk: startChunk('m1') }],
        [],
        true,
      ),
    );

    act(() => {
      result.current.sendMessage('插进这一轮', 'steer');
    });
    await waitFor(() => {
      expect(fake.messagePosts).toHaveLength(1);
    });
    // 请求本身照旧带 intent steer（客户端不预判分流，判定权在服务端）。
    expect(fake.messagePosts[0]?.body).toEqual({
      text: '插进这一轮',
      intent: 'steer',
    });

    // 回显被撤掉，且没有报错——这不是失败，是服务端换了条路。
    await waitFor(() => {
      expect(result.current.pendingUserEchoes).toEqual([]);
    });
    expect(result.current.error).toBeUndefined();
    stream.close();
  });

  it('一轮收尾时队列非空：保持 streaming 并重连 tail，接住服务端自动出队起的下一轮', async () => {
    const fake = setup();
    const stream = fake.queueStream();
    const nextTurnStream = fake.queueStream();
    const { result } = renderHook(() =>
      useChatMessages('sess_1', [], [queuedMessage('q1', '下一件事')]),
    );

    act(() => {
      stream.pushChunk(
        messageMetadataChunk({ turn: 1, usage: {}, status: 'completed' }),
        5,
      );
      stream.close();
    });

    // 不落回 idle——服务端必然会出队起下一轮，落回去会让界面「转完→静止→又转」。
    // 重连走既有的退避阶梯，第一档就是 1s，所以这里的等待窗口要比它宽。
    await waitFor(
      () => {
        expect(fake.streamRequests.length).toBeGreaterThan(1);
      },
      { timeout: 3000 },
    );
    expect(result.current.status).toBe('streaming');
    // 下一轮同样要走一整段起轮装配才出第一帧——AI 侧要有「正在准备…」占位，
    // 别让时间线静止在上一轮的收尾上（与手动发消息那条路一致）。
    expect(result.current.awaitingFirstEvent).toBe(true);

    // 下一轮的 tail 连上后带来最新快照：那条已经出队了。
    act(() => {
      nextTurnStream.pushFrame({ queue: [] });
    });
    await waitFor(() => {
      expect(result.current.queuedMessages).toEqual([]);
    });
    nextTurnStream.close();
  });

  it('排队的下一轮从同一条流接上（服务端不放手、两轮之间不发 turnActive:false）：不重连，不落回 idle', async () => {
    const fake = setup();
    const stream = fake.queueStream();
    const { result } = renderHook(() =>
      useChatMessages('sess_1', [], [queuedMessage('q1', '下一件事')]),
    );

    act(() => {
      stream.pushChunk(startChunk('a1'), 2);
      stream.pushChunk(finishChunk('stop'), 3);
      stream.pushChunk(
        messageMetadataChunk({ turn: 1, usage: {}, status: 'completed' }),
        4,
      );
    });
    await waitFor(() => {
      expect(result.current.awaitingFirstEvent).toBe(true);
    });
    expect(result.current.status).toBe('streaming');

    // 同一条流：出队后的队列快照 → 第 2 轮的用户消息 → 第 2 轮的回复。
    act(() => {
      stream.pushFrame({ queue: [] });
      stream.pushMessage(5, userMessage('u2', '下一件事'));
      stream.pushChunk(startChunk('a2'), 6);
    });
    await waitFor(() => {
      expect(result.current.messages.map((m) => m.id)).toContain('a2');
    });
    expect(result.current.queuedMessages).toEqual([]);
    expect(result.current.awaitingFirstEvent).toBe(false);
    expect(fake.streamRequests).toHaveLength(1);
    stream.close();
  });

  it('一轮收尾时队列为空：照旧落回 idle', async () => {
    const fake = setup();
    const stream = fake.queueStream();
    const { result } = renderHook(() => useChatMessages('sess_1', []));

    act(() => {
      stream.pushChunk(
        messageMetadataChunk({ turn: 1, usage: {}, status: 'completed' }),
        5,
      );
    });

    await waitFor(() => {
      expect(result.current.status).toBe('idle');
    });
    stream.close();
  });

  it('removeQueuedMessage / clearQueue 用服务端返回的快照覆盖本地队列', async () => {
    const fake = setup();
    const stream = fake.queueStream();
    fake.setQueueSnapshot([
      queuedMessage('q1', '一'),
      queuedMessage('q2', '二'),
    ]);
    const { result } = renderHook(() =>
      useChatMessages(
        'sess_1',
        [],
        [queuedMessage('q1', '一'), queuedMessage('q2', '二')],
      ),
    );

    act(() => {
      result.current.removeQueuedMessage('q1');
    });
    await waitFor(() => {
      expect(result.current.queuedMessages.map((m) => m.text)).toEqual(['二']);
    });
    expect(fake.queueDeletes[0]).toEqual({
      conversationId: 'sess_1',
      messageId: 'q1',
    });

    act(() => {
      result.current.clearQueue();
    });
    await waitFor(() => {
      expect(result.current.queuedMessages).toEqual([]);
    });
    expect(fake.queueDeletes[1]).toEqual({
      conversationId: 'sess_1',
      messageId: undefined,
    });
    stream.close();
  });

  it('删除时的 404（那条刚被自动出队/别处删了）不算错误，只是没有变化', async () => {
    const fake = setup();
    const stream = fake.queueStream();
    fake.setQueueDeleteStatus(404);
    const { result } = renderHook(() =>
      useChatMessages('sess_1', [], [queuedMessage('q1', '一')]),
    );

    act(() => {
      result.current.removeQueuedMessage('q1');
    });
    await waitFor(() => {
      expect(fake.queueDeletes).toHaveLength(1);
    });

    expect(result.current.error).toBeUndefined();
    expect(result.current.queuedMessages.map((m) => m.text)).toEqual(['一']);
    stream.close();
  });
});

// ---------------------------------------------------------------------------
// 停止本轮（docs/logic/orchestration/tech/turn-abort.md §4.1）——`stopTurn` / `stopping`。核心是「不做
// 乐观翻转」：按下停止只发请求 + 置中间态，界面回到空闲只认 wire 上那条
// `status: 'interrupted'` 的 `message-metadata`。
// ---------------------------------------------------------------------------

describe('useChatMessages — 停止本轮（docs/logic/orchestration/tech/turn-abort.md）', () => {
  /** 起一轮：`initialFrames` 以一条裸 chunk 结尾 = 有进行中的一轮。 */
  const IN_PROGRESS_FRAMES: ChatReplayFrame[] = [
    { seq: 1, chunk: startChunk('m1') },
  ];

  it('stopTurn 发 POST .../abort、置 stopping，并且**不**乐观翻转 status（仍是 streaming）', async () => {
    const fake = setup();
    const stream = fake.queueStream();
    const { result } = renderHook(() =>
      useChatMessages(
        'sess_1',
        IN_PROGRESS_FRAMES,
        [queuedMessage('q1', '排着的一条')],
        true,
      ),
    );
    expect(result.current.status).toBe('streaming');

    act(() => {
      result.current.stopTurn();
    });

    await waitFor(() => {
      expect(fake.abortPosts).toEqual([
        { conversationId: 'sess_1', body: undefined },
      ]);
    });
    // 停止请求已发出，但这一轮还没真正停住：状态照旧 streaming，只多一个中间态。
    expect(result.current.status).toBe('streaming');
    expect(result.current.stopping).toBe(true);
    // 队列按服务端返回的快照清空（停止 = 全停）。
    await waitFor(() => {
      expect(result.current.queuedMessages).toEqual([]);
    });
    // tail 没被断开——还要靠它接住 interrupted 那帧。
    expect(fake.streamRequests).toHaveLength(1);
    stream.close();
  });

  it('interrupted 的收尾帧到达后落回 idle（不是 error）、不显示错误、stopping 复位', async () => {
    const fake = setup();
    const stream = fake.queueStream();
    const { result } = renderHook(() =>
      useChatMessages('sess_1', IN_PROGRESS_FRAMES, [], true),
    );

    act(() => {
      result.current.stopTurn();
    });
    await waitFor(() => {
      expect(result.current.stopping).toBe(true);
    });

    // 真实收尾顺序（core 的 loop）：先 `finish` 关掉这条 assistant 消息，随后那条
    // **独立的** `message-metadata` 才是「这一轮结束了」的信号。
    act(() => {
      stream.pushChunk(finishChunk(), 5);
      stream.pushChunk(
        messageMetadataChunk({
          turn: 1,
          usage: {},
          status: 'interrupted',
          error: { code: 'aborted', message: 'Turn stopped by the user.' },
        }),
        6,
      );
    });

    await waitFor(() => {
      expect(result.current.status).toBe('idle');
    });
    expect(result.current.error).toBeUndefined();
    expect(result.current.stopping).toBe(false);
    stream.close();
  });

  it('failed 的收尾帧照旧算错误（把 interrupted 归 idle 没有顺手把真失败也一起放过）', async () => {
    const fake = setup();
    const stream = fake.queueStream();
    const { result } = renderHook(() =>
      useChatMessages('sess_1', IN_PROGRESS_FRAMES, [], true),
    );

    act(() => {
      stream.pushChunk(finishChunk(), 5);
      stream.pushChunk(
        messageMetadataChunk({
          turn: 1,
          usage: {},
          status: 'failed',
          error: { code: 'provider_error', message: '模型炸了' },
        }),
        6,
      );
    });

    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.error).toBe('模型炸了');
    stream.close();
  });

  it('409（这一轮刚好自己结束了）静默处理：不报错，只复位 stopping', async () => {
    const fake = setup();
    const stream = fake.queueStream();
    fake.setAbortStatus(409);
    const { result } = renderHook(() =>
      useChatMessages('sess_1', IN_PROGRESS_FRAMES, [], true),
    );

    act(() => {
      result.current.stopTurn();
    });

    await waitFor(() => {
      expect(result.current.stopping).toBe(false);
    });
    expect(result.current.error).toBeUndefined();
    expect(fake.abortPosts).toHaveLength(1);
    stream.close();
  });

  it('非 409 的失败（如 500）浮到 hook 的 error 上', async () => {
    const fake = setup();
    const stream = fake.queueStream();
    fake.setAbortStatus(500);
    const { result } = renderHook(() =>
      useChatMessages('sess_1', IN_PROGRESS_FRAMES, [], true),
    );

    act(() => {
      result.current.stopTurn();
    });

    await waitFor(() => {
      expect(result.current.error).toBeDefined();
    });
    expect(result.current.stopping).toBe(false);
    stream.close();
  });

  it('没有进行中的一轮时 stopTurn 是无操作（不发请求）', async () => {
    const fake = setup();
    const stream = fake.queueStream();
    const { result } = renderHook(() => useChatMessages('sess_1', []));
    expect(result.current.status).toBe('idle');

    act(() => {
      result.current.stopTurn();
    });

    await waitFor(() => {
      expect(fake.streamRequests).toHaveLength(1);
    });
    expect(fake.abortPosts).toEqual([]);
    stream.close();
  });
});
