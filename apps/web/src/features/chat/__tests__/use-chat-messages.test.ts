import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChatEnvelopeStreamHandlers } from '../api';
import { useChatMessages } from '../use-chat-messages';

type PostChatMessageFn = (
  sessionId: string,
  text: string,
  signal?: AbortSignal,
) => Promise<void>;
type StreamSessionTailFn = (
  sessionId: string,
  after: number,
  handlers: ChatEnvelopeStreamHandlers,
  signal?: AbortSignal,
) => Promise<void>;

const { postChatMessageMock, streamSessionTailMock } = vi.hoisted(() => ({
  postChatMessageMock: vi.fn<PostChatMessageFn>(),
  streamSessionTailMock: vi.fn<StreamSessionTailFn>(),
}));

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return {
    ...actual,
    postChatMessage: postChatMessageMock,
    streamSessionTail: streamSessionTailMock,
  };
});

interface TailCall {
  sessionId: string;
  after: number;
  handlers: ChatEnvelopeStreamHandlers;
  signal: AbortSignal | undefined;
  resolve: () => void;
  reject: (error: unknown) => void;
}

/**
 * A fully-controllable `streamSessionTail` fake: every call gets its own
 * deferred promise (so the test decides exactly when/how it settles) that
 * also auto-rejects with an `AbortError` the instant its `signal` aborts —
 * mirroring what the real fetch-based implementation does, which
 * `use-chat-messages.ts` relies on to tell a deliberate stop apart from a
 * real disconnect.
 */
function createStreamSessionTailRecorder(): { calls: TailCall[] } {
  const calls: TailCall[] = [];
  streamSessionTailMock.mockImplementation(
    (sessionId, after, handlers, signal) => {
      let resolveFn: () => void = () => undefined;
      let rejectFn: (error: unknown) => void = () => undefined;
      const promise = new Promise<void>((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
      });
      signal?.addEventListener('abort', () => {
        rejectFn(new DOMException('aborted', 'AbortError'));
      });
      calls.push({
        sessionId,
        after,
        handlers,
        signal,
        resolve: resolveFn,
        reject: rejectFn,
      });
      return promise;
    },
  );
  return { calls };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useChatMessages', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('opens a resumable tail on mount, seeded with after=<max seq of history>', () => {
    const { calls } = createStreamSessionTailRecorder();
    renderHook(() =>
      useChatMessages('sess_1', [
        { seq: 1, event: { type: 'session.started', sessionId: 'sess_1' } },
        {
          seq: 2,
          event: { type: 'turn.result', finalResponse: 'hi', usage: {} },
        },
      ]),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sessionId).toBe('sess_1');
    expect(calls[0]?.after).toBe(2);
  });

  it('aborts the open tail on unmount', () => {
    const { calls } = createStreamSessionTailRecorder();
    const { unmount } = renderHook(() => useChatMessages('sess_1', []));
    expect(calls[0]?.signal?.aborted).toBe(false);
    unmount();
    expect(calls[0]?.signal?.aborted).toBe(true);
  });

  it('resumes a turn left in progress by a prior page load: status starts "streaming" and reconnects with after=<last seq>, flipping to "idle" once turn.result arrives', async () => {
    const { calls } = createStreamSessionTailRecorder();
    const { result } = renderHook(() =>
      useChatMessages('sess_1', [
        { seq: 1, event: { type: 'user.message', text: '之前发的' } },
        { seq: 2, event: { type: 'turn.started', turn: 1 } }, // no terminal event yet — the turn was still going
      ]),
    );

    expect(calls[0]?.after).toBe(2);
    expect(result.current.status).toBe('streaming');

    act(() => {
      calls[0]?.handlers.onEnvelope({
        seq: 3,
        event: { type: 'turn.result', finalResponse: 'done', usage: {} },
      });
    });

    expect(result.current.status).toBe('idle');
    expect(result.current.envelopes.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('shows the outgoing text optimistically the instant sendMessage is called, before any network round-trip', () => {
    createStreamSessionTailRecorder();
    postChatMessageMock.mockImplementation(
      () => new Promise<void>(() => undefined),
    );

    const { result } = renderHook(() => useChatMessages('sess_1', []));

    act(() => {
      result.current.sendMessage('帮我看看登录页面');
    });

    expect(result.current.status).toBe('streaming');
    expect(result.current.awaitingFirstEvent).toBe(true);
    expect(result.current.optimisticMessages).toEqual([
      { id: 1, text: '帮我看看登录页面' },
    ]);
    expect(result.current.envelopes).toHaveLength(0);
  });

  it('reconciles the optimistic entry against the server user.message echo without a duplicate bubble', async () => {
    const { calls } = createStreamSessionTailRecorder();
    postChatMessageMock.mockResolvedValue(undefined);

    const { result } = renderHook(() => useChatMessages('sess_1', []));
    expect(calls).toHaveLength(1); // mount tail

    act(() => {
      result.current.sendMessage('帮我看看登录页面');
    });
    expect(result.current.optimisticMessages).toHaveLength(1);

    await flush(); // let postChatMessage's `.then` open the send's own tail
    expect(calls).toHaveLength(2);

    act(() => {
      calls[1]?.handlers.onEnvelope({
        seq: 1,
        event: { type: 'user.message', text: '帮我看看登录页面' },
      });
    });

    // the confirmed envelope replaces the optimistic placeholder in the same update:
    expect(result.current.optimisticMessages).toHaveLength(0);
    expect(result.current.envelopes).toHaveLength(1);
    expect(result.current.envelopes[0]?.event).toEqual({
      type: 'user.message',
      text: '帮我看看登录页面',
    });
    expect(result.current.awaitingFirstEvent).toBe(false);
  });

  it('replays a user.message event from history exactly like any other persisted envelope', () => {
    createStreamSessionTailRecorder();
    const { result } = renderHook(() =>
      useChatMessages('sess_1', [
        { seq: 1, event: { type: 'session.started', sessionId: 'sess_1' } },
        { seq: 2, event: { type: 'user.message', text: '之前发过的一条消息' } },
        {
          seq: 3,
          event: { type: 'turn.result', finalResponse: 'ok', usage: {} },
        },
      ]),
    );

    expect(
      result.current.envelopes.map((envelope) => envelope.event.type),
    ).toEqual(['session.started', 'user.message', 'turn.result']);
    expect(result.current.optimisticMessages).toHaveLength(0);
    expect(result.current.status).toBe('idle'); // history's last event was terminal
  });

  it('reopens the tail (after=<last seq>, exponential backoff) when it disconnects before turn.result/turn.failed, and dedupes any redelivered overlap once reconnected', async () => {
    vi.useFakeTimers();
    const { calls } = createStreamSessionTailRecorder();
    postChatMessageMock.mockResolvedValue(undefined);

    const { result } = renderHook(() => useChatMessages('sess_1', []));
    expect(calls).toHaveLength(1); // mount tail, after=0

    act(() => {
      result.current.sendMessage('写个组件');
    });
    await flush();
    expect(calls).toHaveLength(2); // send's own tail, after=0

    act(() => {
      calls[1]?.handlers.onEnvelope({
        seq: 1,
        event: { type: 'user.message', text: '写个组件' },
      });
      calls[1]?.handlers.onEnvelope({
        seq: 2,
        event: { type: 'turn.started', turn: 1 },
      });
    });
    expect(result.current.envelopes.map((e) => e.seq)).toEqual([1, 2]);

    await act(async () => {
      calls[1]?.reject(new Error('network dropped'));
      await Promise.resolve();
    });

    // base backoff delay (1s) — no reconnect before it elapses:
    expect(calls).toHaveLength(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(calls).toHaveLength(3);
    expect(calls[2]?.after).toBe(2); // resumes from the last confirmed seq

    act(() => {
      // seq 2 is a redelivered overlap (already applied above) — must not duplicate.
      calls[2]?.handlers.onEnvelope({
        seq: 2,
        event: { type: 'turn.started', turn: 1 },
      });
      calls[2]?.handlers.onEnvelope({
        seq: 3,
        event: { type: 'turn.result', finalResponse: 'done', usage: {} },
      });
    });

    expect(result.current.envelopes.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(result.current.status).toBe('idle');
  });

  it('does not reconnect once the tail has already delivered turn.result (a clean, expected close)', async () => {
    vi.useFakeTimers();
    const { calls } = createStreamSessionTailRecorder();

    renderHook(() => useChatMessages('sess_1', []));
    act(() => {
      calls[0]?.handlers.onEnvelope({
        seq: 1,
        event: { type: 'turn.result', finalResponse: 'ok', usage: {} },
      });
    });
    await act(async () => {
      calls[0]?.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000); // well past every backoff step
    });
    expect(calls).toHaveLength(1); // never reconnected — nothing to catch up on
  });

  it('gives up reconnecting after the retry budget is exhausted, without ever seeing a terminal event', async () => {
    vi.useFakeTimers();
    const { calls } = createStreamSessionTailRecorder();
    postChatMessageMock.mockResolvedValue(undefined);

    const { result } = renderHook(() => useChatMessages('sess_1', []));
    act(() => {
      result.current.sendMessage('写个组件'); // establishes turnInProgress — a fresh session has none to reconnect to
    });
    await flush();
    expect(calls).toHaveLength(2); // mount tail (after=0) + the send's own tail (after=0)

    // 1 (the send's tail) + 5 retries = 6 total attempts from here on, per docs/08 §2.2b's "限次".
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const call = calls[attempt + 1];
      expect(call).toBeDefined();
      await act(async () => {
        call?.reject(new Error('dropped'));
        await Promise.resolve();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2 ** (attempt + 1) * 1000);
      });
    }

    expect(calls).toHaveLength(7); // mount tail + 6 send-triggered attempts, no more
  });

  it('treats cancel() as a clean stop: aborts the tail and returns to idle without scheduling a reconnect', async () => {
    vi.useFakeTimers();
    const { calls } = createStreamSessionTailRecorder();

    const { result } = renderHook(() => useChatMessages('sess_1', []));
    act(() => {
      calls[0]?.handlers.onEnvelope({
        seq: 1,
        event: { type: 'turn.started', turn: 1 },
      }); // turn now looks in-progress from this hook's point of view
    });

    await act(async () => {
      result.current.cancel();
      await Promise.resolve();
    });
    expect(result.current.status).toBe('idle');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(calls).toHaveLength(1); // AbortError never triggers a reconnect
  });

  it('surfaces a turn-runner-level turn.failed sentinel as status="error" (not the mid-stream SessionEvent variant, which still completes normally)', () => {
    createStreamSessionTailRecorder();
    const { result } = renderHook(() => useChatMessages('sess_1', []));

    act(() => {
      streamSessionTailMock.mock.calls[0]?.[2].onEnvelope({
        seq: 1,
        event: {
          type: 'turn.failed',
          code: 'internal_error',
          message: '崩溃了',
        },
      });
    });

    expect(result.current.status).toBe('error');
    expect(result.current.error).toBe('崩溃了');
  });

  it('rolls back the optimistic bubble and surfaces an error when postChatMessage itself rejects (e.g. 409 already in progress)', async () => {
    createStreamSessionTailRecorder();
    postChatMessageMock.mockRejectedValue(
      new Error('turn already in progress'),
    );

    const { result } = renderHook(() => useChatMessages('sess_1', []));
    act(() => {
      result.current.sendMessage('hello');
    });
    expect(result.current.optimisticMessages).toHaveLength(1);

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.optimisticMessages).toHaveLength(0);
    expect(result.current.error).toBe('turn already in progress');
  });
});
