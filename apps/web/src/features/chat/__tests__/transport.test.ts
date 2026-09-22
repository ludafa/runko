/**
 * [直播流](../../../../../../docs/terms.md)走哪条通道的用户选择。
 *
 * 守两件事：**缺省与坏值都回落到 SSE**（这台设备存过的东西不可信——手改过、旧版本写
 * 的、别的站点串进来的都可能），以及**改了要通知在看的人**（设置页与聊天页同时翻，
 * 否则设置页显示 WebSocket、聊天页还连着 SSE）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getChatTransport,
  setChatTransport,
  subscribeChatTransport,
} from '../transport';

const KEY = 'runko:chat-transport';

describe('直播流通道偏好', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('没选过就是 SSE', () => {
    expect(getChatTransport()).toBe('sse');
  });

  it('选过就记住，换个标签页/刷新都还在', () => {
    setChatTransport('ws');

    expect(window.localStorage.getItem(KEY)).toBe('ws');
    expect(getChatTransport()).toBe('ws');
  });

  it('**存的值认不出来就当没选过**，不是把坏值原样传给连接代码', () => {
    window.localStorage.setItem(KEY, 'grpc');

    expect(getChatTransport()).toBe('sse');
  });

  it('存不进去也照常用（隐私模式、站点数据被禁）', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    expect(() => {
      setChatTransport('ws');
    }).not.toThrow();
  });

  it('读不出来也照常用，回落到 SSE', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });

    expect(getChatTransport()).toBe('sse');
  });

  it('**一改就通知订阅者**——设置页与聊天页同时翻', () => {
    const seen: string[] = [];
    const unsubscribe = subscribeChatTransport(() => {
      seen.push(getChatTransport());
    });

    setChatTransport('ws');
    setChatTransport('sse');

    expect(seen).toEqual(['ws', 'sse']);
    unsubscribe();
  });

  it('退订之后不再收到通知', () => {
    let calls = 0;
    const unsubscribe = subscribeChatTransport(() => {
      calls += 1;
    });
    unsubscribe();

    setChatTransport('ws');

    expect(calls).toBe(0);
  });
});
