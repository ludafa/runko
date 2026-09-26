/**
 * `createNodeOffline` —— [节点下线](../../../docs/terms.md)的闸门（docs/logic/orchestration/tech/handover.md §3.3）。
 *
 * 下线之后浏览器来的请求一律 503；别的节点转发来的在交接完成之前照常放行（对话还在本节点手上），之后也 503。
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
    const res = await buildProbeApp(offline).request('/probe');
    expect(res.status).toBe(200);
    expect(offline.isOffline()).toBe(false);
  });

  it('下线后：浏览器经 nginx 来的请求 503 + Retry-After，好让 nginx 换节点重试', async () => {
    const offline = createNodeOffline();
    offline.goOffline();
    const res = await buildProbeApp(offline).request('/probe');
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe(RETRY_AFTER_SECONDS);
    expect(offline.isOffline()).toBe(true);
  });

  it('交接完成之前：别的节点转发来的请求（令牌对）照常放行——对话还在本节点手上', async () => {
    const offline = createNodeOffline({
      url: 'http://a:3900',
      peerToken: 'secret',
    });
    offline.goOffline();
    const res = await buildProbeApp(offline).request('/probe', {
      headers: { [FORWARDED_HEADER]: '1', [PEER_TOKEN_HEADER]: 'secret' },
    });
    expect(res.status).toBe(200);
  });

  it('交接完成之前：令牌不对的转发请求照样 503', async () => {
    const offline = createNodeOffline({
      url: 'http://a:3900',
      peerToken: 'secret',
    });
    offline.goOffline();
    const res = await buildProbeApp(offline).request('/probe', {
      headers: { [FORWARDED_HEADER]: '1', [PEER_TOKEN_HEADER]: 'wrong' },
    });
    expect(res.status).toBe(503);
  });

  it('交接完成之后：转发来的请求也 503——对话都交出去了', async () => {
    const offline = createNodeOffline({
      url: 'http://a:3900',
      peerToken: 'secret',
    });
    offline.goOffline();
    offline.finishHandover();
    const res = await buildProbeApp(offline).request('/probe', {
      headers: { [FORWARDED_HEADER]: '1', [PEER_TOKEN_HEADER]: 'secret' },
    });
    expect(res.status).toBe(503);
  });

  it('goOffline 幂等：多次调用不报错', () => {
    const offline = createNodeOffline();
    offline.goOffline();
    expect(() => {
      offline.goOffline();
    }).not.toThrow();
    expect(offline.isOffline()).toBe(true);
  });
});
