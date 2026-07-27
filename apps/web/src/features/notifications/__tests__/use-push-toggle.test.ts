/**
 * 铃铛状态机（docs/tech/push-notification.md §7）。
 *
 * 最要紧的一条：**绝不主动弹权限框**——只有用户点铃铛才 `requestPermission()`。
 * 一进页面就问是最招人烦的做法，Chrome 还会因此惩罚站点。
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { usePushToggle } from '../use-push-toggle';

const PUBLIC_KEY = 'BOKk3IjA'; // base64url，内容无所谓，只要能被解码

interface Harness {
  requestPermissionCalls: number;
  subscribeCalls: number;
  unsubscribeCalls: number;
  postedEndpoints: string[];
  unsubscribedEndpoints: string[];
}

/** 一条最小可用的假 `PushSubscription`。 */
function fakeSubscription(
  endpoint: string,
  harness: Harness,
): PushSubscription {
  const key = new Uint8Array([1, 2, 3]).buffer;
  return {
    endpoint,
    expirationTime: null,
    options: { userVisibleOnly: true, applicationServerKey: null },
    getKey: () => key,
    toJSON: () => ({ endpoint }),
    unsubscribe: () => {
      harness.unsubscribeCalls += 1;
      return Promise.resolve(true);
    },
  };
}

interface SetupOptions {
  enabled?: boolean;
  permission?: NotificationPermission;
  /** 授权弹框的返回值（`enable()` 里那次）。 */
  grants?: NotificationPermission;
  existingEndpoint?: string;
  supported?: boolean;
}

function setup(opts: SetupOptions = {}): Harness {
  const {
    enabled = true,
    permission = 'default',
    grants = 'granted',
    existingEndpoint,
    supported = true,
  } = opts;

  const harness: Harness = {
    requestPermissionCalls: 0,
    subscribeCalls: 0,
    unsubscribeCalls: 0,
    postedEndpoints: [],
    unsubscribedEndpoints: [],
  };

  let current: PushSubscription | null =
    existingEndpoint === undefined ? null : (
      fakeSubscription(existingEndpoint, harness)
    );

  vi.stubGlobal('fetch', (input: string, init?: RequestInit) => {
    if (input === '/api/push/config') {
      return Promise.resolve(
        Response.json({
          enabled,
          publicKey: enabled ? PUBLIC_KEY : null,
        }),
      );
    }
    if (input === '/api/push/subscriptions' && typeof init?.body === 'string') {
      const parsed: unknown = JSON.parse(init.body);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'endpoint' in parsed &&
        typeof parsed.endpoint === 'string'
      ) {
        harness.postedEndpoints.push(parsed.endpoint);
      }
      return Promise.resolve(Response.json({ ok: true }));
    }
    if (input === '/api/push/unsubscribe' && typeof init?.body === 'string') {
      const parsed: unknown = JSON.parse(init.body);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'endpoint' in parsed &&
        typeof parsed.endpoint === 'string'
      ) {
        harness.unsubscribedEndpoints.push(parsed.endpoint);
      }
      return Promise.resolve(Response.json({ ok: true }));
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  });

  const pushManager = {
    getSubscription: () => Promise.resolve(current),
    subscribe: () => {
      harness.subscribeCalls += 1;
      current = fakeSubscription('https://fcm.example/new', harness);
      return Promise.resolve(current);
    },
  };
  const registration = { pushManager };

  if (supported) {
    vi.stubGlobal('navigator', {
      userAgent: 'Chrome/999',
      maxTouchPoints: 0,
      serviceWorker: {
        register: () => Promise.resolve(registration),
        ready: Promise.resolve(registration),
      },
    });
    vi.stubGlobal('PushManager', class {});
    vi.stubGlobal('Notification', {
      permission,
      requestPermission: () => {
        harness.requestPermissionCalls += 1;
        return Promise.resolve(grants);
      },
    });
  } else {
    vi.stubGlobal('navigator', { userAgent: 'Safari', maxTouchPoints: 0 });
    vi.stubGlobal('Notification', { permission });
    // 不注册 PushManager —— `isPushSupported()` 因此为 false
  }

  return harness;
}

describe('use-push-toggle', () => {
  beforeEach(() => {
    // `isPushSupported()` 会读 window 上的这两个键，先清干净。
    Reflect.deleteProperty(globalThis, 'PushManager');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('服务端没配 VAPID → disabled（铃铛整个不渲染）', async () => {
    setup({ enabled: false });
    const { result } = renderHook(() => usePushToggle());
    await waitFor(() => {
      expect(result.current.state).toBe('disabled');
    });
  });

  it('浏览器不支持 → unsupported，且给出一句提示', async () => {
    setup({ supported: false });
    const { result } = renderHook(() => usePushToggle());
    await waitFor(() => {
      expect(result.current.state).toBe('unsupported');
    });
    expect(result.current.hint).toBeTruthy();
  });

  it('权限已被拒 → blocked，并指引去浏览器设置', async () => {
    setup({ permission: 'denied' });
    const { result } = renderHook(() => usePushToggle());
    await waitFor(() => {
      expect(result.current.state).toBe('blocked');
    });
    expect(result.current.hint).toContain('浏览器');
  });

  it('还没订阅 → off，且**没有**主动弹权限框', async () => {
    const harness = setup();
    const { result } = renderHook(() => usePushToggle());
    await waitFor(() => {
      expect(result.current.state).toBe('off');
    });
    expect(harness.requestPermissionCalls).toBe(0);
    expect(harness.subscribeCalls).toBe(0);
  });

  it('已有订阅 → on，并顺手幂等重上报一次（兜住浏览器换过 endpoint）', async () => {
    const harness = setup({
      permission: 'granted',
      existingEndpoint: 'https://fcm.example/old',
    });
    const { result } = renderHook(() => usePushToggle());
    await waitFor(() => {
      expect(result.current.state).toBe('on');
    });
    expect(harness.postedEndpoints).toEqual(['https://fcm.example/old']);
  });

  it('点铃铛开启：请求权限 → 订阅 → 上报 → on', async () => {
    const harness = setup();
    const { result } = renderHook(() => usePushToggle());
    await waitFor(() => {
      expect(result.current.state).toBe('off');
    });

    act(() => {
      result.current.toggle();
    });
    await waitFor(() => {
      expect(result.current.state).toBe('on');
    });

    expect(harness.requestPermissionCalls).toBe(1);
    expect(harness.subscribeCalls).toBe(1);
    expect(harness.postedEndpoints).toEqual(['https://fcm.example/new']);
  });

  it('点铃铛但用户拒绝授权 → blocked，不订阅', async () => {
    const harness = setup({ grants: 'denied' });
    const { result } = renderHook(() => usePushToggle());
    await waitFor(() => {
      expect(result.current.state).toBe('off');
    });

    act(() => {
      result.current.toggle();
    });
    await waitFor(() => {
      expect(result.current.state).toBe('blocked');
    });
    expect(harness.subscribeCalls).toBe(0);
  });

  it('用户直接关掉弹框（default）→ 留在 off，不报错', async () => {
    setup({ grants: 'default' });
    const { result } = renderHook(() => usePushToggle());
    await waitFor(() => {
      expect(result.current.state).toBe('off');
    });

    act(() => {
      result.current.toggle();
    });
    await waitFor(() => {
      expect(result.current.busy).toBe(false);
    });
    expect(result.current.state).toBe('off');
    expect(result.current.error).toBeUndefined();
  });

  it('点铃铛关闭：浏览器退订 + 通知服务端删行', async () => {
    const harness = setup({
      permission: 'granted',
      existingEndpoint: 'https://fcm.example/old',
    });
    const { result } = renderHook(() => usePushToggle());
    await waitFor(() => {
      expect(result.current.state).toBe('on');
    });

    act(() => {
      result.current.toggle();
    });
    await waitFor(() => {
      expect(result.current.state).toBe('off');
    });

    expect(harness.unsubscribeCalls).toBe(1);
    expect(harness.unsubscribedEndpoints).toEqual(['https://fcm.example/old']);
  });

  it('unsupported / blocked 状态下点它不做任何事', async () => {
    const harness = setup({ permission: 'denied' });
    const { result } = renderHook(() => usePushToggle());
    await waitFor(() => {
      expect(result.current.state).toBe('blocked');
    });

    act(() => {
      result.current.toggle();
    });
    expect(harness.requestPermissionCalls).toBe(0);
    expect(result.current.state).toBe('blocked');
  });

  it('问不到配置（接口挂了）就当没这个功能，不顶着一个点不动的铃铛', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('网断了')));
    const { result } = renderHook(() => usePushToggle());
    await waitFor(() => {
      expect(result.current.state).toBe('disabled');
    });
  });
});
