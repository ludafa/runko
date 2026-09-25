/**
 * 节点侧调用[运维容器](../../../../docs/terms.md)的客户端（`src/console/ops-client.ts`）。
 * 设计见 docs/host/node/tech/cluster-console.md §7.1、§8。
 *
 * `routes/console.test.ts` 用假 `OpsClient` 覆盖了路由怎么处置各种 `OpsClientResult`；
 * 这里专测 `resolveOpsIdentity` 的开关判断与 `createOpsClient` 自己的失败分支
 * （超时 → unreachable）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createOpsClient,
  resolveOpsIdentity,
} from '../../src/console/ops-client.js';

describe('resolveOpsIdentity: URL/令牌缺一视为未配置', () => {
  it('两者都配了 → 返回身份', () => {
    const identity = resolveOpsIdentity({
      RUNKO_OPS_URL: 'http://ops:3950',
      RUNKO_OPS_TOKEN: 'secret',
    });
    expect(identity).toEqual({ url: 'http://ops:3950', token: 'secret' });
  });

  it('只有 URL，没有 token → undefined', () => {
    expect(
      resolveOpsIdentity({ RUNKO_OPS_URL: 'http://ops:3950' }),
    ).toBeUndefined();
  });

  it('只有 token，没有 URL → undefined', () => {
    expect(resolveOpsIdentity({ RUNKO_OPS_TOKEN: 'secret' })).toBeUndefined();
  });

  it('两者都没配 → undefined', () => {
    expect(resolveOpsIdentity({})).toBeUndefined();
  });

  it('配了但是空字符串 → 视为未配置', () => {
    expect(
      resolveOpsIdentity({ RUNKO_OPS_URL: '', RUNKO_OPS_TOKEN: '' }),
    ).toBeUndefined();
  });

  it('RUNKO_OPS_TIMEOUT_MS 是合法正数时才采用，否则用默认值（不出现在返回值里）', () => {
    const withTimeout = resolveOpsIdentity({
      RUNKO_OPS_URL: 'http://ops:3950',
      RUNKO_OPS_TOKEN: 'secret',
      RUNKO_OPS_TIMEOUT_MS: '5000',
    });
    expect(withTimeout?.timeoutMs).toBe(5000);

    const withInvalidTimeout = resolveOpsIdentity({
      RUNKO_OPS_URL: 'http://ops:3950',
      RUNKO_OPS_TOKEN: 'secret',
      RUNKO_OPS_TIMEOUT_MS: 'not-a-number',
    });
    expect(withInvalidTimeout?.timeoutMs).toBeUndefined();
  });
});

describe('createOpsClient: 超时', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('请求一直不返回，到点后归类为 unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      (_input: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );

    const client = createOpsClient({
      url: 'http://ops:3950',
      token: 'secret',
      timeoutMs: 5,
    });
    const result = await client.listNodes();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('unreachable');
      expect(result.error.message).toContain('timed out');
    }
  });

  it('offline/online 请求同样会超时归类为 unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      (_input: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );

    const client = createOpsClient({
      url: 'http://ops:3950',
      token: 'secret',
      timeoutMs: 5,
    });
    const result = await client.offline('node-1');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('unreachable');
    }
  });
});
