/**
 * `createNodeOffline` —— [节点下线](../../../docs/terms.md)的闸门与信号，
 * 设计见 docs/host/node/tech/cluster-console.md §4.1。
 *
 * 只测闸门本身（谁挡、谁放、状态怎么切）；闸门挂上去之后怎么断开已经连上的直播连接
 * 是另一组用例（`test/routes/chat-offline-stream.test.ts`、`test/routes/chat-ws-offline.test.ts`）。
 */
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { createNodeOffline } from '../src/offline.js';
import {
  FORWARDED_HEADER,
  PEER_TOKEN_HEADER,
  RETRY_AFTER_SECONDS,
} from '../src/routes/forward.js';

function buildProbeApp(offline: ReturnType<typeof createNodeOffline>) {
  const app = new Hono();
  app.use('*', offline.gate);
  app.get('/probe', (c) => c.json({ ok: true }));
  return app;
}

describe('createNodeOffline', () => {
  it('在线时：闸门放行，isOffline() 为 false', async () => {
    const offline = createNodeOffline();
    const app = buildProbeApp(offline);

    const res = await app.request('/probe');

    expect(res.status).toBe(200);
    expect(offline.isOffline()).toBe(false);
  });

  it('下线后：普通请求（浏览器经 nginx 来的）503 + Retry-After，好让 nginx 换节点重试', async () => {
    const offline = createNodeOffline();
    offline.goOffline();
    const app = buildProbeApp(offline);

    const res = await app.request('/probe');

    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe(RETRY_AFTER_SECONDS);
    expect(offline.isOffline()).toBe(true);
  });

  it('下线后：带转发标记 + 正确的副本间令牌 —— 照常放行（那一轮还在本节点上跑）', async () => {
    const offline = createNodeOffline({
      url: 'http://node-a:3900',
      peerToken: 'secret',
    });
    offline.goOffline();
    const app = buildProbeApp(offline);

    const res = await app.request('/probe', {
      headers: { [FORWARDED_HEADER]: '1', [PEER_TOKEN_HEADER]: 'secret' },
    });

    expect(res.status).toBe(200);
  });

  it('下线后：带转发标记但令牌不对 —— 503（挡住，不是放行）', async () => {
    const offline = createNodeOffline({
      url: 'http://node-a:3900',
      peerToken: 'secret',
    });
    offline.goOffline();
    const app = buildProbeApp(offline);

    const res = await app.request('/probe', {
      headers: { [FORWARDED_HEADER]: '1', [PEER_TOKEN_HEADER]: 'wrong' },
    });

    expect(res.status).toBe(503);
  });

  it('下线后：带转发标记但完全没带令牌头 —— 503', async () => {
    const offline = createNodeOffline({
      url: 'http://node-a:3900',
      peerToken: 'secret',
    });
    offline.goOffline();
    const app = buildProbeApp(offline);

    const res = await app.request('/probe', {
      headers: { [FORWARDED_HEADER]: '1' },
    });

    expect(res.status).toBe(503);
  });

  it('没配 peerToken（本机联调）时：只认转发标记，不校验令牌', async () => {
    const offline = createNodeOffline({ url: 'http://node-a:3900' });
    offline.goOffline();
    const app = buildProbeApp(offline);

    const res = await app.request('/probe', {
      headers: { [FORWARDED_HEADER]: '1' },
    });

    expect(res.status).toBe(200);
  });

  it('没有 node identity（单进程跑法，`resolveNodeIdentity()` 返回 undefined）：同样只认转发标记', async () => {
    const offline = createNodeOffline();
    offline.goOffline();
    const app = buildProbeApp(offline);

    const res = await app.request('/probe', {
      headers: { [FORWARDED_HEADER]: '1' },
    });

    expect(res.status).toBe(200);
  });

  it('goOffline / disconnectStreams 幂等：多次调用不报错', () => {
    const offline = createNodeOffline();

    offline.goOffline();
    offline.disconnectStreams();
    expect(() => {
      offline.goOffline();
      offline.disconnectStreams();
    }).not.toThrow();

    expect(offline.isOffline()).toBe(true);
    expect(offline.signal.aborted).toBe(true);
  });

  it('关闸门不断直播：goOffline 之后 signal 仍未触发，disconnectStreams 之后才触发', () => {
    const offline = createNodeOffline();

    offline.goOffline();
    expect(offline.isOffline()).toBe(true);
    expect(offline.signal.aborted).toBe(false);

    offline.disconnectStreams();
    expect(offline.signal.aborted).toBe(true);
  });
});
