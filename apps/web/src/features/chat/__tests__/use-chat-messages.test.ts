import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChatReplayFrame } from '../schema';
import { buildRenderEntries } from '../timeline';
import { useChatMessages } from '../use-chat-messages';
import { FakeChatFetch } from './helpers/fake-chat-fetch';
import {
  finishChunk,
  messageMetadataChunk,
  startChunk,
  toolApprovalRequestChunk,
  toolInputAvailableChunk,
  userMessage,
} from './helpers/nimbo-chunks';

function setup(): FakeChatFetch {
  const fake = new FakeChatFetch();
  vi.stubGlobal('fetch', fake.fetch);
  return fake;
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
