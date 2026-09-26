/**
 * [指定交接](../../../../docs/terms.md)的节点间端点（`routes/takeover.ts`）：只认带副本间令牌的节点间请求；
 * 本节点自己在下线就拒绝（docs/logic/orchestration/tech/handover.md §7.3）。
 */
import type { AgentRuntime } from '@runko/agent';
import { describe, expect, it, vi } from 'vitest';

import {
  FORWARDED_HEADER,
  PEER_TOKEN_HEADER,
} from '../../src/routes/forward.js';
import {
  createTakeoverApp,
  createTakeoverRequester,
  TAKEOVER_PATH,
} from '../../src/routes/takeover.js';
import { silentLogger } from '../helpers/silent-logger.js';

function fakeRuntime(accepts: boolean) {
  const takeOver = vi.fn((_ids: string[]) => Promise.resolve(accepts));
  const runtime: Pick<AgentRuntime, 'takeOver'> = { takeOver };
  return { runtime, takeOver };
}

function post(
  app: ReturnType<typeof createTakeoverApp>,
  body: unknown,
  headers: Record<string, string>,
) {
  return app.request(TAKEOVER_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('POST /internal/takeover', () => {
  const node = { url: 'http://node-b:3900', peerToken: 'secret' };

  it('带对令牌：交给 runtime.takeOver，把它的答复原样回去', async () => {
    const { runtime, takeOver } = fakeRuntime(true);
    const app = createTakeoverApp({
      runtime,
      node,
      logger: silentLogger,
    });
    const res = await post(
      app,
      { conversationIds: ['c1', 'c2'] },
      { [FORWARDED_HEADER]: '1', [PEER_TOKEN_HEADER]: 'secret' },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: true });
    expect(takeOver).toHaveBeenCalledWith(['c1', 'c2']);
  });

  it('本节点在下线：答 accepted:false（空列表 = 只问接不接）', async () => {
    const { runtime } = fakeRuntime(false);
    const app = createTakeoverApp({
      runtime,
      node,
      logger: silentLogger,
    });
    const res = await post(
      app,
      { conversationIds: [] },
      { [FORWARDED_HEADER]: '1', [PEER_TOKEN_HEADER]: 'secret' },
    );
    expect(await res.json()).toEqual({ accepted: false });
  });

  it('没带令牌或令牌不对：401，不碰 runtime', async () => {
    const { runtime, takeOver } = fakeRuntime(true);
    const app = createTakeoverApp({
      runtime,
      node,
      logger: silentLogger,
    });
    expect((await post(app, { conversationIds: ['c1'] }, {})).status).toBe(401);
    expect(
      (
        await post(
          app,
          { conversationIds: ['c1'] },
          { [FORWARDED_HEADER]: '1', [PEER_TOKEN_HEADER]: 'wrong' },
        )
      ).status,
    ).toBe(401);
    expect(takeOver).not.toHaveBeenCalled();
  });

  it('没配副本间令牌：端点整个不开（404），不碰 runtime', async () => {
    const { runtime, takeOver } = fakeRuntime(true);
    const app = createTakeoverApp({
      runtime,
      node: { url: 'http://node-b:3900' },
      logger: silentLogger,
    });
    expect(
      (
        await post(
          app,
          { conversationIds: ['c1'] },
          { [FORWARDED_HEADER]: '1' },
        )
      ).status,
    ).toBe(404);
    expect(takeOver).not.toHaveBeenCalled();
  });

  it('一次最多 500 份对话：超了回 400', async () => {
    const { runtime, takeOver } = fakeRuntime(true);
    const app = createTakeoverApp({ runtime, node, logger: silentLogger });
    const ids = Array.from({ length: 501 }, (_, index) => `c${String(index)}`);
    const res = await post(
      app,
      { conversationIds: ids },
      { [FORWARDED_HEADER]: '1', [PEER_TOKEN_HEADER]: 'secret' },
    );
    expect(res.status).toBe(400);
    expect(takeOver).not.toHaveBeenCalled();
  });

  it('客户端：连不上就当没答应', async () => {
    const request = createTakeoverRequester(node, silentLogger);
    await expect(request('http://127.0.0.1:1', ['c1'])).resolves.toBe(false);
  });
});
