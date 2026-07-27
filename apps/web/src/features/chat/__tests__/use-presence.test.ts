/**
 * [在场](../../../../../docs/terms.md)上报（docs/tech/push-notification.md §5.2）。
 *
 * 断言的三件事：判据（可见 + 聚焦）、只在变化时补报、离开会话时销掉在场。
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { usePresence } from '../use-presence';

interface PresenceCall {
  conversationId: string;
  focused: boolean;
}

/** 记下每一次 `POST .../presence` 的会话 id 与 focused 值。 */
function installFetchSpy(): PresenceCall[] {
  const calls: PresenceCall[] = [];
  vi.stubGlobal('fetch', (input: string, init?: RequestInit) => {
    const match = /\/api\/chat\/conversations\/([^/]+)\/presence$/.exec(input);
    if (match !== null && typeof init?.body === 'string') {
      const parsed: unknown = JSON.parse(init.body);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'focused' in parsed &&
        typeof parsed.focused === 'boolean'
      ) {
        calls.push({
          conversationId: decodeURIComponent(match[1] ?? ''),
          focused: parsed.focused,
        });
      }
    }
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
  return calls;
}

/** jsdom 的 `document.hasFocus()` 恒为 true；可见性要自己接管。 */
function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
}

function setFocused(focused: boolean): void {
  vi.spyOn(document, 'hasFocus').mockReturnValue(focused);
}

describe('use-presence', () => {
  let calls: PresenceCall[];

  beforeEach(() => {
    vi.useFakeTimers();
    calls = installFetchSpy();
    setVisibility('visible');
    setFocused(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setVisibility('visible');
  });

  it('挂载时立刻报一次在场', () => {
    renderHook(() => usePresence('conv-1'));
    expect(calls).toEqual([{ conversationId: 'conv-1', focused: true }]);
  });

  it('页面可见但窗口没聚焦 = 不在场（第二个显示器上开着不算在看）', () => {
    setFocused(false);
    renderHook(() => usePresence('conv-1'));
    expect(calls).toEqual([{ conversationId: 'conv-1', focused: false }]);
  });

  it('每 20 秒续一次，只在还聚焦时发', () => {
    renderHook(() => usePresence('conv-1'));
    calls.length = 0;

    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(calls).toEqual([{ conversationId: 'conv-1', focused: true }]);

    // 切走之后心跳停发——服务端那条记录会自己过期，没必要每 20 秒说一遍"我还没看"。
    setFocused(false);
    calls.length = 0;
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(calls).toEqual([]);
  });

  it('切到后台立刻报 false，切回来立刻报 true', () => {
    renderHook(() => usePresence('conv-1'));
    calls.length = 0;

    act(() => {
      setVisibility('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(calls).toEqual([{ conversationId: 'conv-1', focused: false }]);

    calls.length = 0;
    act(() => {
      setVisibility('visible');
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(calls).toEqual([{ conversationId: 'conv-1', focused: true }]);
  });

  it('状态没变就不重复发（同一个事件连来三次只发一次）', () => {
    renderHook(() => usePresence('conv-1'));
    calls.length = 0;

    act(() => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('focus'));
    });
    expect(calls).toEqual([]); // 一直是 focused=true，没有变化
  });

  it('离开会话时销掉在场，否则接下来 45 秒这条会话的通知会被误抑制', () => {
    const { unmount } = renderHook(() => usePresence('conv-1'));
    calls.length = 0;

    act(() => {
      unmount();
    });
    expect(calls).toEqual([{ conversationId: 'conv-1', focused: false }]);
  });

  it('接口报错不冒泡（心跳是尽力而为的）', () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('网断了')));
    expect(() => {
      renderHook(() => usePresence('conv-1'));
    }).not.toThrow();
  });
});
