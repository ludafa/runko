/**
 * [在场](../../../../docs/terms.md)（docs/app/push-notification/tech.md §5.2）——
 * 纯内存 + TTL，用假时钟测，不真等 45 秒。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearPresent,
  isPresent,
  markPresent,
  resetPresence,
} from '../../src/push/presence.js';

describe('push/presence', () => {
  beforeEach(() => {
    resetPresence();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-27T10:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    resetPresence();
  });

  it('没上报过就不在场', () => {
    expect(isPresent('user-1', 'conv-1')).toBe(false);
  });

  it('上报后 44 秒仍在场，46 秒后过期', () => {
    markPresent('user-1', 'conv-1');
    vi.advanceTimersByTime(44_000);
    expect(isPresent('user-1', 'conv-1')).toBe(true);

    vi.advanceTimersByTime(2_000);
    expect(isPresent('user-1', 'conv-1')).toBe(false);
  });

  it('心跳续期不累加，每次都是从现在起 45 秒', () => {
    markPresent('user-1', 'conv-1');
    vi.advanceTimersByTime(20_000);
    markPresent('user-1', 'conv-1'); // 一次心跳
    vi.advanceTimersByTime(40_000); // 距首次上报 60 秒，距最近一次 40 秒
    expect(isPresent('user-1', 'conv-1')).toBe(true);
  });

  it('clearPresent 立即生效，不等 TTL', () => {
    markPresent('user-1', 'conv-1');
    clearPresent('user-1', 'conv-1');
    expect(isPresent('user-1', 'conv-1')).toBe(false);
  });

  it('按 (用户, 会话) 隔离：别人的在场不算我的，别的会话也不算', () => {
    markPresent('user-1', 'conv-1');
    expect(isPresent('user-2', 'conv-1')).toBe(false);
    expect(isPresent('user-1', 'conv-2')).toBe(false);
  });

  it('拼键不会因为 id 里含空格而串味', () => {
    markPresent('a b', 'c');
    expect(isPresent('a', 'b c')).toBe(false);
  });

  it('过期条目在被问到时就地删除（惰性过期，不靠后续写入）', () => {
    markPresent('user-1', 'conv-1');
    vi.advanceTimersByTime(60_000);
    expect(isPresent('user-1', 'conv-1')).toBe(false);
    // 再问一次仍是 false，且不依赖任何清扫动作
    expect(isPresent('user-1', 'conv-1')).toBe(false);
  });
});
