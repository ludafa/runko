import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChatReplayFrame, QueuedMessage } from '../schema';
import { buildRenderEntries } from '../timeline';
import { useChatMessages } from '../use-chat-messages';
import { FakeChatFetch } from './helpers/fake-chat-fetch';
import {
  assistantMessage,
  finishChunk,
  messageMetadataChunk,
  startChunk,
  textStepChunks,
  toolApprovalRequestChunk,
  toolInputAvailableChunk,
  userMessage,
} from './helpers/nimbo-chunks';

function setup(): FakeChatFetch {
  const fake = new FakeChatFetch();
  vi.stubGlobal('fetch', fake.fetch);
  return fake;
}

/** 一条[待发队列](../../../../../docs/terms.md)条目（docs/agent/steer-and-queue/tech.md §2.2）。 */
function queuedMessage(id: string, text: string): QueuedMessage {
  return { id, text, userId: 'user-1', createdAt: 1_700_000_000_000 };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('useChatMessages — mount / lastFrameIsChunk', () => {
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

  it('a history ending in a raw ChunkEnvelope (turn still in progress / crashed) starts "streaming"', () => {
    const fake = setup();
    const stream = fake.queueStream();
    const { result } = renderHook(() =>
      useChatMessages('sess_1', [{ seq: 1, chunk: startChunk('m1') }]),
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
// 轮状态快照（docs/app/chat-webapp/tech.md §5.1）——服务端在每条 tail 连上时下发的权威
// 「这个会话有没有轮在跑」。它取代了 `lastFrameIsChunk` 那个猜测：崩溃残留会让那个
// 猜法长期失准且永不自愈（用户发的消息一律走排队、没有乐观回显、还等不到出队）。
// ---------------------------------------------------------------------------

describe('useChatMessages — 轮状态快照（turn-state 帧）', () => {
  /** 崩溃残留的会话：历史以 chunk 收尾，所以挂载时 `lastFrameIsChunk` 猜「有轮在跑」。 */
  const crashResidueHistory: ChatReplayFrame[] = [
    { seq: 1, chunk: startChunk('m1') },
  ];

  it('回归：崩溃残留的会话收到 turnActive:false 后落回 idle，发消息重新走「起新一轮」并**有乐观上屏**', async () => {
    const fake = setup();
    const stream = fake.queueStream();
    const { result } = renderHook(() =>
      useChatMessages('sess_1', crashResidueHistory),
    );

    // 挂载时前端只能靠猜——这里就是猜错的那一档（服务端其实没有轮在跑）。
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
      // Same seq (5) as above but a *different* payload — if dedup is keyed
      // on seq alone (as `applyFrame`'s `seenSeqs` is), this must never reach
      // the ledger at all, so status must stay 'idle', not flip to 'error'.
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
    // Give the (would-be, if not deduped) update a chance to land.
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
    // Turn already in progress at mount (history ends in a raw chunk) — the
    // mount's own tail attempt plus 5 reconnect attempts, all failing with a
    // non-2xx status (a disconnect, not an AbortError).
    for (let i = 0; i < 6; i++) fake.queueStreamError(503);

    renderHook(() =>
      useChatMessages('sess_1', [{ seq: 1, chunk: startChunk('m1') }]),
    );

    await vi.waitFor(() => {
      expect(fake.streamRequests).toHaveLength(1);
    });

    const delays = [1000, 2000, 4000, 8000, 16000];
    for (let i = 0; i < delays.length; i++) {
      const delay = delays[i];
      if (delay === undefined) continue;

      await vi.advanceTimersByTimeAsync(delay);

      await vi.waitFor(() => {
        expect(fake.streamRequests).toHaveLength(i + 2);
      });
    }

    // All 5 reconnect attempts (plus the initial one) are exhausted — advancing
    // further (well past a 6th backoff delay) must not schedule another.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.streamRequests).toHaveLength(6);
    expect(fake.streamRequests.every((r) => r.after === 1)).toBe(true);
  });

  it('does not reconnect after a clean AbortError (deliberate stop, not a disconnect)', async () => {
    const fake = setup();
    const stream = fake.queueStream();
    const { unmount } = renderHook(() =>
      useChatMessages('sess_1', [{ seq: 1, chunk: startChunk('m1') }]),
    );
    unmount(); // aborts the tail — streamConversationTail rejects with AbortError
    stream.error(new DOMException('aborted', 'AbortError'));

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.streamRequests).toHaveLength(1); // no reconnect attempt
  });
});

describe('useChatMessages — pendingUserEchoes', () => {
  it('anchors each echo at messages.length at send time; an echo is only ever popped by the real turn-start user MessageFrame (a separate coverage below) — a turn whose tail never sends one (this test only ever pushes plain chunks) leaves an earlier echo in place', async () => {
    const fake = setup();
    // `sendMessage` always (re)opens the tail once its POST resolves — even
    // for a session with no turn in flight yet (`use-chat-messages.ts`'s own
    // file header) — so the mount's own tail is a separate, short-lived
    // connection from the one that actually carries turn 1's frames.
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
      expect(fake.streamRequests).toHaveLength(2); // mount + reopened-after-POST
    });

    // The turn completes — messages grows by one assistant message.
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

    // Both echoes are still present (this test's turns never send a
    // turn-start MessageFrame — plain chunks only — so nothing ever pops
    // either one) — the first is still anchored at 0, the second at
    // messages.length when *it* was sent (after turn 1 already landed).
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
    expect(result.current.messages[0]?.id).toBe('u1'); // the real message, not the echo

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
      expect(result.current.pendingUserEchoes).toHaveLength(0); // popped via the MessageFrame path
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
    const unusedStream = fake.queueStream(); // never consumed — the POST fails before the tail is ever reopened
    act(() => {
      result.current.sendMessage('第二条（会失败）');
    });
    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    // Rolled back via the filter-by-id path — not the FIFO pop path — and
    // ends up empty either way, not double-removed nor left dangling.
    expect(result.current.pendingUserEchoes).toHaveLength(0);
    expect(result.current.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
    ]); // turn 1's messages untouched by turn 2's failed send

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
    // Mid-flight (echo2 still pending, msg2's real message not landed yet):
    // the interleaved render order is already correct.
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

    // Two *separate* `act()` calls (not one batch): `submittingCallIds` is
    // `useState`, so the guard in `submitDecision` only sees it updated once
    // React has actually re-rendered between the two calls (matching real
    // usage: the card's own `disabled={submitting}` prop is what stops a
    // literal same-tick double click at the DOM level; this in-hook guard
    // covers a second *programmatic* call arriving after that re-render).
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
// 待发队列（[排队](../../../../../docs/terms.md)，docs/agent/steer-and-queue/tech.md §6）
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
      useChatMessages('sess_1', [{ seq: 1, chunk: startChunk('m1') }]),
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
    //（docs/app/chat-ui/feature.md、2026-07-25）。
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

  // 请求 steer 但服务端回 `'queued'`：那一轮还卡在[起轮装配](../../../../../docs/terms.md)
  // 里，没有 session 可插，服务端只能给它排队（docs/agent/turn-abort/tech.md §3.3）。
  it('steer 拿回 mode "queued" 时撤掉那条「待注入」回显——它永远等不到注入点', async () => {
    const fake = setup();
    fake.setMessagePostMode('queued');
    const stream = fake.queueStream();
    const { result } = renderHook(() =>
      useChatMessages('sess_1', [{ seq: 1, chunk: startChunk('m1') }]),
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
// 停止本轮（docs/agent/turn-abort/tech.md §4.1）——`stopTurn` / `stopping`。核心是「不做
// 乐观翻转」：按下停止只发请求 + 置中间态，界面回到空闲只认 wire 上那条
// `status: 'interrupted'` 的 `message-metadata`。
// ---------------------------------------------------------------------------

describe('useChatMessages — 停止本轮（docs/agent/turn-abort/tech.md）', () => {
  /** 起一轮：`initialFrames` 以一条裸 chunk 结尾 = 有进行中的一轮（`lastFrameIsChunk`）。 */
  const IN_PROGRESS_FRAMES: ChatReplayFrame[] = [
    { seq: 1, chunk: startChunk('m1') },
  ];

  it('stopTurn 发 POST .../abort、置 stopping，并且**不**乐观翻转 status（仍是 streaming）', async () => {
    const fake = setup();
    const stream = fake.queueStream();
    const { result } = renderHook(() =>
      useChatMessages('sess_1', IN_PROGRESS_FRAMES, [
        queuedMessage('q1', '排着的一条'),
      ]),
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
      useChatMessages('sess_1', IN_PROGRESS_FRAMES),
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
      useChatMessages('sess_1', IN_PROGRESS_FRAMES),
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
      useChatMessages('sess_1', IN_PROGRESS_FRAMES),
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
      useChatMessages('sess_1', IN_PROGRESS_FRAMES),
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
