/**
 * [集群控制台](../../../../../../docs/terms.md)的两个纯格式化函数（`../format.ts`）：
 * 下线倒计时（m:ss，从 2:00 往下数）与「心跳几秒前」（功能手册 §3.2）。
 */
import { describe, expect, it } from 'vitest';

import { formatCountdown, formatSecondsAgo } from '../format';

describe('formatCountdown', () => {
  it('2 分钟整（下线倒计时的起点）', () => {
    expect(formatCountdown(120_000)).toBe('2:00');
  });

  it('不足整分钟时秒数补零', () => {
    expect(formatCountdown(65_000)).toBe('1:05');
  });

  it('0 毫秒', () => {
    expect(formatCountdown(0)).toBe('0:00');
  });

  it('负数（已经过期）钳到 0:00，不显示负号', () => {
    expect(formatCountdown(-5_000)).toBe('0:00');
  });

  it('向上取整到秒（差 1 毫秒也算下一秒，不提前显示 0:00）', () => {
    expect(formatCountdown(1)).toBe('0:01');
  });
});

describe('formatSecondsAgo', () => {
  it('同一时刻 → 0 秒前', () => {
    expect(formatSecondsAgo(1000, 1000)).toBe('0 秒前');
  });

  it('四舍五入到秒', () => {
    expect(formatSecondsAgo(1000, 2400)).toBe('1 秒前');
    expect(formatSecondsAgo(1000, 2600)).toBe('2 秒前');
  });

  it('未来时刻（本机时钟偏差）钳到 0，不显示负数', () => {
    expect(formatSecondsAgo(5000, 1000)).toBe('0 秒前');
  });
});
