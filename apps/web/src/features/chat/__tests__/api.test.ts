import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ChatApiError,
  postApprovalDecision,
  postChatMessage,
  postQuestionAnswer,
  streamSessionTail,
} from '../api';
import type { ChatStreamEnvelope } from '../schema';

function sseResponse(chunks: string[], init?: { status?: number }): Response {
  const encoder = new TextEncoder();
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[index]));
      index += 1;
    },
  });
  return new Response(body, { status: init?.status ?? 200 });
}

describe('postChatMessage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs { text } and resolves on a 202 (no body assumptions beyond ok)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 202 }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await postChatMessage('sess_1', 'hello');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/chat/sessions/sess_1/messages',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ text: 'hello' }),
      }),
    );
  });

  it('rejects with ChatApiError on 409 (a turn is already in progress) — callers can check .status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'turn already in progress' }), {
          status: 409,
        }),
      ),
    );

    const error = await postChatMessage('sess_1', 'hello').catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ChatApiError);
    expect(error).toHaveProperty('status', 409);
  });

  it('rejects with ChatApiError on a 404 (unknown session)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('not found', { status: 404 })),
    );
    await expect(postChatMessage('missing', 'hi')).rejects.toThrow(
      ChatApiError,
    );
  });
});

describe('postApprovalDecision', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs { behavior } to .../approvals/<callId> with JSON headers and credentials included', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await postApprovalDecision('sess_1', 'call_1', { behavior: 'allow' });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/chat/sessions/sess_1/approvals/call_1',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ behavior: 'allow' }),
      }),
    );
  });

  it('includes the optional deny message in the request body', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await postApprovalDecision('sess_1', 'call_1', {
      behavior: 'deny',
      message: '太危险了',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({ behavior: 'deny', message: '太危险了' }),
      }),
    );
  });

  it('URL-encodes the callId', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await postApprovalDecision('sess_1', 'call/weird id', {
      behavior: 'allow',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/chat/sessions/sess_1/approvals/${encodeURIComponent('call/weird id')}`,
      expect.anything(),
    );
  });

  it('rejects with ChatApiError on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('server error', { status: 500 })),
    );
    await expect(
      postApprovalDecision('sess_1', 'call_1', { behavior: 'allow' }),
    ).rejects.toThrow(ChatApiError);
  });

  it('a 404 (callId no longer pending — already timed out or turn already ended) sets ChatApiError.status to 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('gone', { status: 404 })),
    );
    const error = await postApprovalDecision('sess_1', 'call_1', {
      behavior: 'allow',
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ChatApiError);
    expect(error).toHaveProperty('status', 404);
  });
});

describe('postQuestionAnswer', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs { answer } to .../questions/<callId> with JSON headers and credentials included', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await postQuestionAnswer('sess_1', 'call_2', '用主题色吧。');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/chat/sessions/sess_1/questions/call_2',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer: '用主题色吧。' }),
      }),
    );
  });

  it('URL-encodes the callId', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await postQuestionAnswer('sess_1', 'call/weird id', 'answer');

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/chat/sessions/sess_1/questions/${encodeURIComponent('call/weird id')}`,
      expect.anything(),
    );
  });

  it('rejects with ChatApiError on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('server error', { status: 500 })),
    );
    await expect(
      postQuestionAnswer('sess_1', 'call_2', 'answer'),
    ).rejects.toThrow(ChatApiError);
  });

  it('a 404 (callId no longer pending) sets ChatApiError.status to 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('gone', { status: 404 })),
    );
    const error = await postQuestionAnswer('sess_1', 'call_2', 'answer').catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ChatApiError);
    expect(error).toHaveProperty('status', 404);
  });
});

describe('streamSessionTail', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('GETs .../stream?after=<seq> and delivers envelopes in order, even when SSE lines are split across fetch chunks', async () => {
    const chunks = [
      'data: {"seq":1,"event":{"type":"session.started","sessi',
      'onId":"s1"}}\n\n',
      'data: {"seq":2,"event":{"type":"turn.star',
      'ted","turn":1}}\n\n',
    ];
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(chunks));
    vi.stubGlobal('fetch', fetchMock);

    // `seq` is `number | undefined` on the envelope type (docs/08 §2.2d) —
    // neither fixture envelope below is ephemeral, so the assertion still
    // expects concrete numbers.
    const received: (number | undefined)[] = [];
    await streamSessionTail('sess_1', 0, {
      onEnvelope: (envelope: ChatStreamEnvelope) => received.push(envelope.seq),
    });

    expect(received).toEqual([1, 2]);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/chat/sessions/sess_1/stream?after=0',
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    );
  });

  it('encodes a non-zero after= cursor into the query string', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    await streamSessionTail('sess_1', 42, { onEnvelope: () => undefined });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/chat/sessions/sess_1/stream?after=42',
      expect.anything(),
    );
  });

  it('drops a malformed envelope via onParseError without throwing or losing later ones', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        sseResponse([
          'data: not json at all\n\n',
          'data: {"seq":1,"event":{"type":"turn.started","turn":1}}\n\n',
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);

    const received: (number | undefined)[] = [];
    const parseErrors: string[] = [];
    await streamSessionTail('sess_1', 0, {
      onEnvelope: (envelope: ChatStreamEnvelope) => received.push(envelope.seq),
      onParseError: (message: string) => parseErrors.push(message),
    });

    expect(received).toEqual([1]);
    expect(parseErrors).toHaveLength(1);
  });

  it('rejects with ChatApiError on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('session not found', {
          status: 404,
          statusText: 'Not Found',
        }),
      ),
    );

    await expect(
      streamSessionTail('missing', 0, { onEnvelope: () => undefined }),
    ).rejects.toThrow(ChatApiError);
  });

  it('propagates an AbortError when the signal fires mid-stream', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementation(() => {
      controller.abort();
      return Promise.reject(new DOMException('aborted', 'AbortError'));
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      streamSessionTail(
        'sess_1',
        0,
        { onEnvelope: () => undefined },
        controller.signal,
      ),
    ).rejects.toThrow('aborted');
  });
});
