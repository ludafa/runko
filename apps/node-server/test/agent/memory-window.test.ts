/**
 * `CHAT_SUSPEND_MEMORY_WINDOW` 怎么读成框架的[内存窗口](../../../../docs/terms.md)
 * （docs/ingress/tech/chat-webapp.md §6.3）。写错了一律当没配，交给框架缺省——宁可按默认等，
 * 也不要因为一个环境变量把服务起不来。
 */
import { describe, expect, it } from 'vitest';

import { resolveMemoryWindowMs } from '../../src/agent/runtime.js';

describe('resolveMemoryWindowMs', () => {
  it('没配：交给框架缺省', () => {
    expect(resolveMemoryWindowMs({})).toBeUndefined();
    expect(
      resolveMemoryWindowMs({ CHAT_SUSPEND_MEMORY_WINDOW: '  ' }),
    ).toBeUndefined();
  });

  it('毫秒数原样用；0 = 一等人就挂起', () => {
    expect(resolveMemoryWindowMs({ CHAT_SUSPEND_MEMORY_WINDOW: '60000' })).toBe(
      60_000,
    );
    expect(resolveMemoryWindowMs({ CHAT_SUSPEND_MEMORY_WINDOW: '0' })).toBe(0);
  });

  it('写错了（负数、不是数）当没配', () => {
    expect(
      resolveMemoryWindowMs({ CHAT_SUSPEND_MEMORY_WINDOW: '-1' }),
    ).toBeUndefined();
    expect(
      resolveMemoryWindowMs({ CHAT_SUSPEND_MEMORY_WINDOW: '5m' }),
    ).toBeUndefined();
    // 超过 setTimeout 的上限：框架会报错，而这里在模块顶层求值——报错就是进程起不来。
    expect(
      resolveMemoryWindowMs({ CHAT_SUSPEND_MEMORY_WINDOW: '9999999999' }),
    ).toBeUndefined();
  });
});
