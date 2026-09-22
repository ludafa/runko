/**
 * [应用层转发](../../../../docs/terms.md)：请求打到哪个副本都要能被送到[归属](../../../../docs/terms.md)
 * 持有者手上。
 *
 * 四条防线各一组用例：**环路**（转过一次的不再转）、**身份**（cookie 带过去，持有者自己查）、
 * **副本间令牌**（伪造转发标记会被挡）、**背压与失联**（持有者不在就回「稍后再试」，不是 500）。
 */
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import {
  createForwarder,
  resolveNodeIdentity,
} from '../../src/routes/forward.js';
import { silentLogger } from '../helpers/silent-logger.js';

/** 起一个「持有者」：记下收到的请求，按给定的方式回应。 */
function holderApp(
  respond: (info: {
    cookie?: string;
    forwarded?: string;
    token?: string;
  }) => Response,
) {
  const seen: { cookie?: string; forwarded?: string; token?: string }[] = [];
  const app = new Hono();
  app.all('*', (c) => {
    const info = {
      ...(c.req.header('cookie') !== undefined ?
        { cookie: c.req.header('cookie') }
      : {}),
      ...(c.req.header('x-runko-forwarded') !== undefined ?
        { forwarded: c.req.header('x-runko-forwarded') }
      : {}),
      ...(c.req.header('x-runko-peer-token') !== undefined ?
        { token: c.req.header('x-runko-peer-token') }
      : {}),
    };
    seen.push(info);
    return respond(info);
  });
  return { app, seen };
}

/** 把一次转发跑起来：用一个 Hono 当「本副本」，`holder` 指向内存里的另一个 app。 */
async function forwardOnce(opts: {
  peerToken?: string;
  forwardTimeoutMs?: number;
  headers?: Record<string, string>;
  holderFetch: typeof fetch;
}): Promise<Response> {
  const forwarder = createForwarder(
    {
      url: 'http://replica-b:3900',
      ...(opts.peerToken !== undefined ? { peerToken: opts.peerToken } : {}),
      ...(opts.forwardTimeoutMs !== undefined ?
        { forwardTimeoutMs: opts.forwardTimeoutMs }
      : {}),
    },
    silentLogger,
  );
  const local = new Hono();
  local.all('*', (c) => forwarder.forward(c, 'http://replica-a:3900'));
  vi.stubGlobal('fetch', opts.holderFetch);
  try {
    return await local.request('/api/chat/conversations/c1/abort', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...opts.headers },
      body: JSON.stringify({}),
    });
  } finally {
    vi.unstubAllGlobals();
  }
}

describe('转发', () => {
  it('把 cookie 带过去，持有者据此认人', async () => {
    const holder = holderApp(() => new Response('ok', { status: 200 }));
    const response = await forwardOnce({
      headers: { cookie: 'session=abc' },
      holderFetch: async (input, init) => await holder.app.request(input, init),
    });

    expect(response.status).toBe(200);
    expect(holder.seen[0]?.cookie).toBe('session=abc');
  });

  it('**带转发标记进去**，对面就不会再转一次（防环路）', async () => {
    const holder = holderApp(() => new Response('ok', { status: 200 }));
    await forwardOnce({
      holderFetch: async (input, init) => await holder.app.request(input, init),
    });

    expect(holder.seen[0]?.forwarded).toBe('1');
  });

  it('配了副本间令牌就带上；对面用它挡住伪造的转发请求', async () => {
    const holder = holderApp(() => new Response('ok', { status: 200 }));
    await forwardOnce({
      peerToken: 'shhh',
      holderFetch: async (input, init) => await holder.app.request(input, init),
    });
    expect(holder.seen[0]?.token).toBe('shhh');

    // 反过来：一个伪造转发标记、但令牌不对的请求，进不来。
    const guard = createForwarder(
      { url: 'http://replica-b:3900', peerToken: 'shhh' },
      silentLogger,
    );
    const app = new Hono();
    app.use('*', async (c, next) => {
      const rejected = guard.reject(c);
      if (rejected !== undefined) {
        return rejected;
      }
      await next();
      return undefined;
    });
    app.all('*', (c) => c.json({ ok: true }));

    const bad = await app.request('/x', {
      headers: {
        'x-runko-forwarded': '1',
        'x-runko-peer-token': 'wrong-token',
      },
    });
    expect(bad.status).toBe(401);

    // 终端用户的请求不带转发标记，不该被要求带令牌。
    const user = await app.request('/x');
    expect(user.status).toBe(200);
  });

  it('**持有者连不上 → 503 + Retry-After**，不是 500', async () => {
    const response = await forwardOnce({
      holderFetch: () => Promise.reject(new Error('ECONNREFUSED')),
    });

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('1');
    expect(await response.json()).toMatchObject({
      reason: 'holder_unreachable',
      holder: 'http://replica-a:3900',
    });
  });

  it('**持有者活着但不开口 → 也是 503**（冻住的进程会把连接建起来然后干等）', async () => {
    const response = await forwardOnce({
      forwardTimeoutMs: 20,
      holderFetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
    });

    expect(response.status).toBe(503);
  });
});

describe('resolveNodeIdentity', () => {
  it('没配 RUNKO_NODE_URL = 单进程跑法，什么都不转', () => {
    expect(resolveNodeIdentity({})).toBeUndefined();
    expect(resolveNodeIdentity({ RUNKO_NODE_URL: '  ' })).toBeUndefined();
  });

  it('配了就带上地址；令牌与超时是可选的', () => {
    expect(resolveNodeIdentity({ RUNKO_NODE_URL: 'http://a:3900' })).toEqual({
      url: 'http://a:3900',
    });
    expect(
      resolveNodeIdentity({
        RUNKO_NODE_URL: 'http://a:3900',
        RUNKO_PEER_TOKEN: 'tok',
        RUNKO_FORWARD_TIMEOUT_MS: '2000',
      }),
    ).toEqual({
      url: 'http://a:3900',
      peerToken: 'tok',
      forwardTimeoutMs: 2000,
    });
  });

  it('超时写错了当没配，交给缺省值——不要因为一个拼错的数字就把转发调成 0 毫秒', () => {
    expect(
      resolveNodeIdentity({
        RUNKO_NODE_URL: 'http://a:3900',
        RUNKO_FORWARD_TIMEOUT_MS: '一会儿',
      }),
    ).toEqual({ url: 'http://a:3900' });
  });
});
