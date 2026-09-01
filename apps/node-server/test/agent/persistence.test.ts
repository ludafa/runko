/**
 * `agent/persistence.ts` 里两处**只在升级那一刻**才会走到的路径。
 *
 * 它们的共同点是：出错时不抛、只记一行 warn，所以没有用例守着的话，退化是**静默**的
 * ——CI 全绿，用户那边消息没了。
 */
import { describe, expect, it } from 'vitest';

import { parseQueuedInputs } from '../../src/agent/persistence.js';
import { silentLogger } from '../helpers/silent-logger.js';

const CONV = 'conv-1';

describe('parseQueuedInputs', () => {
  it('新形状原样解析', () => {
    const rows = [
      {
        id: 'q1',
        conversationId: CONV,
        seq: 1,
        input: { text: 'hello', userId: 'u1' },
        createdAt: 1_700_000_000_000,
      },
    ];
    expect(parseQueuedInputs(JSON.stringify(rows), CONV, silentLogger)).toEqual(
      rows,
    );
  });

  it('**迁移前的旧形状就地升格，不丢消息**', () => {
    // 这一列换形状那次没配数据迁移，旧行会 `safeParse` 失败 → 当作空队列 → 第一次
    // 写入就把它覆盖掉。用户排着的消息就是这么静默消失的。
    const legacy = [
      {
        id: 'q1',
        text: '先跑测试',
        userId: 'u1',
        createdAt: 1_700_000_000_000,
      },
      { id: 'q2', text: '再提交', userId: 'u1', createdAt: 1_700_000_000_001 },
    ];
    const upgraded = parseQueuedInputs(
      JSON.stringify(legacy),
      CONV,
      silentLogger,
    );
    expect(upgraded).toHaveLength(2);
    expect(upgraded.map((q) => q.input.text)).toEqual(['先跑测试', '再提交']);
    expect(upgraded[0]).toMatchObject({
      id: 'q1',
      conversationId: CONV,
      seq: 1,
      input: { text: '先跑测试', userId: 'u1' },
    });
    // seq 按下标补，保证排序稳定。
    expect(upgraded.map((q) => q.seq)).toEqual([1, 2]);
  });

  it('两种形状都不是（手改坏了库）→ 当作空队列，不抛', () => {
    expect(parseQueuedInputs('{"nope":1}', CONV, silentLogger)).toEqual([]);
    expect(parseQueuedInputs('not json', CONV, silentLogger)).toEqual([]);
  });
});
