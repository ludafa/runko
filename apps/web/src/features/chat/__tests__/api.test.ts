import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ChatApiError,
  createConversation,
  fetchGithubRepos,
  fetchGithubStatus,
  postAbortTurn,
  postApprovalDecision,
  postChatMessage,
  postQuestionAnswer,
  streamConversationTail,
} from '../api';
import type { ChatReplayFrame } from '../schema';
import { frameSeq, isMessageFrame } from '../schema';

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 把一次 `fetch` 调用的请求体解回一个可判空判 key 的对象——不 cast、不 `any`，
 * `JSON.parse` 的返回值先落进 `unknown`，再用类型守卫收窄（`createConversation`
 * 的「云沙盒带 repo、本地不带」就是靠 `'repo' in body` 这样的判断来验证的，
 * 关键在于 `JSON.stringify` 会整个丢掉值为 `undefined` 的属性——所以「没带这个
 * key」和「带了但是 undefined」在 wire 上无法区分，也就没必要区分）。 */
function parseJsonBody(init: RequestInit): Record<string, unknown> {
  const body = init.body;
  if (typeof body !== 'string') {
    throw new Error('expected a string JSON body');
  }
  const parsed: unknown = JSON.parse(body);
  if (!isJsonRecord(parsed)) {
    throw new Error('expected the JSON body to parse into an object');
  }
  return parsed;
}

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

  it('POSTs { text } and resolves with the server’s own 分流结果 (`mode`) on a 202', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, mode: 'started' }), {
        status: 202,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(postChatMessage('sess_1', 'hello')).resolves.toBe('started');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/chat/conversations/sess_1/messages',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ text: 'hello' }),
      }),
    );
  });

  // 请求 steer 却拿回 `'queued'`：那一轮还卡在[起轮装配](../../../../../../docs/terms.md)里，
  // 插不进去（docs/logic/orchestration/tech/turn-abort.md §3.3）。调用方靠这个返回值撤掉「待注入」回显。
  it('resolves with `queued` even when `steer` was requested (server is the one that decides)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true, mode: 'queued' }), {
          status: 202,
        }),
      ),
    );

    await expect(postChatMessage('sess_1', 'hello', 'steer')).resolves.toBe(
      'queued',
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

describe('postAbortTurn', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs .../abort（无请求体）并解析出清空后的队列快照', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, queue: [] }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(postAbortTurn('sess_1')).resolves.toEqual([]);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/chat/conversations/sess_1/abort',
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    );
  });

  it('409（没有进行中的一轮）带 status 抛出，交给调用方判断是否静默', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'no turn in progress' }), {
          status: 409,
        }),
      ),
    );

    const error = await postAbortTurn('sess_1').catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ChatApiError);
    expect(error).toHaveProperty('status', 409);
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
      '/api/chat/conversations/sess_1/approvals/call_1',
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
      `/api/chat/conversations/sess_1/approvals/${encodeURIComponent('call/weird id')}`,
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
      '/api/chat/conversations/sess_1/questions/call_2',
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
      `/api/chat/conversations/sess_1/questions/${encodeURIComponent('call/weird id')}`,
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

// ---------------------------------------------------------------------------
// 按用户授权加载 GitHub 仓库（docs/ingress/tech/github-repo-access.md §5）
// ---------------------------------------------------------------------------

describe('createConversation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function okConversationResponse(): Response {
    return new Response(
      JSON.stringify({
        id: 'conv-1',
        title: null,
        repo: null,
        branchName: null,
        sandboxName: 'runko-conv-1',
        provider: 'e2b',
        status: 'active',
        lastActiveAt: new Date(0).toISOString(),
        queuedMessages: [],
        availableSkills: [],
        turnInProgress: false,
        pendingDecisions: 0,
        createdAt: new Date(0).toISOString(),
      }),
      { status: 201 },
    );
  }

  it('云沙盒（带 repo）：请求体里带上 repo 字段，值是 {installationId, repoId}', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(okConversationResponse());
    vi.stubGlobal('fetch', fetchMock);

    await createConversation({
      provider: 'e2b',
      repo: { installationId: 1, repoId: 100 },
    });

    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    const init = call?.[1];
    expect(init).toBeDefined();
    if (init === undefined) {
      return;
    }
    const body = parseJsonBody(init);
    expect('repo' in body).toBe(true);
    expect(body.repo).toEqual({ installationId: 1, repoId: 100 });
  });

  it('本地沙盒（不传 repo）：请求体里完全没有 repo 这个 key，不是 repo: undefined/null', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(okConversationResponse());
    vi.stubGlobal('fetch', fetchMock);

    await createConversation({ provider: 'local' });

    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    const init = call?.[1];
    expect(init).toBeDefined();
    if (init === undefined) {
      return;
    }
    const body = parseJsonBody(init);
    expect('repo' in body).toBe(false);
  });

  it('403（核对不过，github_repo_forbidden）作为 ChatApiError 抛出，调用方能取到 status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ error: 'github_repo_forbidden' }), {
          status: 403,
        }),
      ),
    );

    const error = await createConversation({
      provider: 'e2b',
      repo: { installationId: 1, repoId: 100 },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ChatApiError);
    expect(error).toHaveProperty('status', 403);
  });
});

describe('fetchGithubStatus', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('GETs /api/github/status 并解析出 { configured, linked, installUrl }', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          configured: true,
          linked: false,
          installUrl: 'https://github.com/apps/demo-app/installations/new',
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchGithubStatus()).resolves.toEqual({
      configured: true,
      linked: false,
      installUrl: 'https://github.com/apps/demo-app/installations/new',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/github/status',
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    );
  });

  it('非 2xx 时作为 ChatApiError 抛出', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('server error', { status: 500 })),
    );
    await expect(fetchGithubStatus()).rejects.toThrow(ChatApiError);
  });
});

describe('fetchGithubRepos', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('GETs /api/github/repos 并解析出 repos 数组', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          repos: [
            {
              installationId: 1,
              repoId: 100,
              fullName: 'acme/demo',
              private: false,
              defaultBranch: 'main',
            },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchGithubRepos()).resolves.toEqual([
      {
        installationId: 1,
        repoId: 100,
        fullName: 'acme/demo',
        private: false,
        defaultBranch: 'main',
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/github/repos',
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    );
  });

  it('409（没连 GitHub）作为 ChatApiError 抛出，status 是 409', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ error: 'github_not_linked' }), {
          status: 409,
        }),
      ),
    );
    const error = await fetchGithubRepos().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ChatApiError);
    expect(error).toHaveProperty('status', 409);
  });

  it('404（没配 App）作为 ChatApiError 抛出，status 是 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('not found', { status: 404 })),
    );
    const error = await fetchGithubRepos().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ChatApiError);
    expect(error).toHaveProperty('status', 404);
  });
});

// ---------------------------------------------------------------------------
// 503 自动重试（[节点下线](../../../../../../docs/terms.md)窗口）——发消息、停止、提交
// 审批/提问答复这几个请求可能撞上一个正在关闭的节点，服务端约定回 503 时请求一定
// 没被处理，按 `Retry-After` 重发是安全的。用 `postChatMessage` 覆盖通用行为
// （等待时长、缺省/非法 Retry-After、重试次数上限、504 不重试），其余三个各留一条
// 用例确认它们也走了这条重试路径。
// ---------------------------------------------------------------------------

describe('POST 请求的 503 自动重试', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('503 带 Retry-After（秒）时按这个时长等一下再重发，成功就正常 resolve', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('node is going offline', {
          status: 503,
          headers: { 'Retry-After': '2' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, mode: 'started' }), {
          status: 202,
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const promise = postChatMessage('sess_1', 'hello');
    await vi.advanceTimersByTimeAsync(1900);
    expect(fetchMock).toHaveBeenCalledTimes(1); // 还没到 2 秒，不该已经重发

    await vi.advanceTimersByTimeAsync(200);
    await expect(promise).resolves.toBe('started');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('503 没带 Retry-After 时缺省等 1 秒', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('offline', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, mode: 'started' }), {
          status: 202,
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const promise = postChatMessage('sess_1', 'hello');
    await vi.advanceTimersByTimeAsync(900);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(200);
    await expect(promise).resolves.toBe('started');
  });

  it('Retry-After 不是合法的非负数时，同样退回缺省的 1 秒', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('offline', {
          status: 503,
          headers: { 'Retry-After': 'not-a-number' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, mode: 'started' }), {
          status: 202,
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const promise = postChatMessage('sess_1', 'hello');
    await vi.advanceTimersByTimeAsync(1000);
    await expect(promise).resolves.toBe('started');
  });

  it('最多重发 3 次——连续 4 次都是 503 时，最终把这个 503 当成 ChatApiError 抛出', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('offline', {
        status: 503,
        headers: { 'Retry-After': '1' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const promise = postChatMessage('sess_1', 'hello').catch(
      (caught: unknown) => caught,
    );
    // 3 次重试，每次都等 1 秒。
    await vi.advanceTimersByTimeAsync(3000);
    const error = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(4); // 1 次原始请求 + 3 次重发
    expect(error).toBeInstanceOf(ChatApiError);
    expect(error).toHaveProperty('status', 503);
  });

  it('504（网关超时，结果未知）不重试——立刻抛出，一次都不多发', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('gateway timeout', { status: 504 }));
    vi.stubGlobal('fetch', fetchMock);

    const error = await postChatMessage('sess_1', 'hello').catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ChatApiError);
    expect(error).toHaveProperty('status', 504);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('postAbortTurn 也会对 503 自动重试', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('offline', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, queue: [] }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const promise = postAbortTurn('sess_1');
    await vi.advanceTimersByTimeAsync(1000);
    await expect(promise).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('postApprovalDecision 也会对 503 自动重试', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('offline', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const promise = postApprovalDecision('sess_1', 'call_1', {
      behavior: 'allow',
    });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(promise).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('postQuestionAnswer 也会对 503 自动重试', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('offline', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const promise = postQuestionAnswer('sess_1', 'call_2', '用主题色吧。');
    await vi.advanceTimersByTimeAsync(1000);
    await expect(promise).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('streamConversationTail', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('GETs .../stream?after=<seq> and delivers frames in order (a ChunkEnvelope and a MessageFrame alike), even when SSE lines are split across fetch chunks', async () => {
    const chunks = [
      // A ChunkEnvelope (`{ seq, chunk }`), split mid-payload.
      'data: {"seq":1,"chunk":{"type":"start","messageI',
      'd":"m1"}}\n\n',
      // A MessageFrame (`{ seq, message }`, replay-only), also split mid-payload.
      'data: {"seq":2,"message":{"id":"m1","role":"assist',
      'ant","parts":[]}}\n\n',
    ];
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(chunks));
    vi.stubGlobal('fetch', fetchMock);

    // `seq` is `number | undefined` on the envelope type (docs/logic/orchestration/tech/single-ledger.md §5 单-3) —
    // neither fixture frame below is ephemeral, so the assertion still
    // expects concrete numbers.
    const received: (number | undefined)[] = [];
    let sawMessageFrame = false;
    await streamConversationTail('sess_1', 0, {
      onFrame: (frame: ChatReplayFrame) => {
        received.push(frameSeq(frame));
        if (isMessageFrame(frame)) {
          sawMessageFrame = true;
        }
      },
    });

    expect(received).toEqual([1, 2]);
    expect(sawMessageFrame).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/chat/conversations/sess_1/stream?after=0',
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    );
  });

  it('encodes a non-zero after= cursor into the query string', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    await streamConversationTail('sess_1', 42, { onFrame: () => undefined });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/chat/conversations/sess_1/stream?after=42',
      expect.anything(),
    );
  });

  it('drops a malformed envelope via onParseError without throwing or losing later ones', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        sseResponse([
          'data: not json at all\n\n',
          'data: {"seq":1,"chunk":{"type":"finish","finishReason":"stop"}}\n\n',
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);

    const received: (number | undefined)[] = [];
    const parseErrors: string[] = [];
    await streamConversationTail('sess_1', 0, {
      onFrame: (frame: ChatReplayFrame) => received.push(frameSeq(frame)),
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
      streamConversationTail('missing', 0, { onFrame: () => undefined }),
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
      streamConversationTail(
        'sess_1',
        0,
        { onFrame: () => undefined },
        controller.signal,
      ),
    ).rejects.toThrow('aborted');
  });
});
