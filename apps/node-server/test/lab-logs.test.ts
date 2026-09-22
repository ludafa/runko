/** 验证环境的日志合并：按每行开头的 ISO 时间排，调用栈这类续行跟着上一条走。 */
import { mkdtempSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createLogDir, mergeTimeline } from '../scripts/lab-logs.js';

describe('createLogDir', () => {
  it('连续跑两次：各建一个目录，`lab-latest` 指向后一个（第二次曾因删不掉旧软链接而失败）', () => {
    const root = mkdtempSync(join(tmpdir(), 'runko-lab-logs-'));
    try {
      const first = createLogDir(root, new Date('2026-09-13T10:00:00.000Z'));
      const second = createLogDir(root, new Date('2026-09-13T10:05:00.000Z'));
      expect(first).not.toBe(second);
      expect(readlinkSync(join(root, 'lab-latest'))).toBe(
        'lab-2026-09-13T10-05-00',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('mergeTimeline', () => {
  it('几份日志按时间交错合并；同一毫秒保持来源顺序', () => {
    const a = [
      '2026-09-13T06:30:52.100Z  replica-a  INFO   lease  lease acquired',
      '2026-09-13T06:30:52.300Z  replica-a  INFO   http  POST → 202',
    ].join('\n');
    const b = [
      '2026-09-13T06:30:52.200Z  replica-b  INFO   forward  forwarding to holder',
      '2026-09-13T06:30:52.300Z  replica-b  INFO   forward  holder answered',
    ].join('\n');
    expect(mergeTimeline([a, b]).trimEnd().split('\n')).toEqual([
      '2026-09-13T06:30:52.100Z  replica-a  INFO   lease  lease acquired',
      '2026-09-13T06:30:52.200Z  replica-b  INFO   forward  forwarding to holder',
      '2026-09-13T06:30:52.300Z  replica-a  INFO   http  POST → 202',
      '2026-09-13T06:30:52.300Z  replica-b  INFO   forward  holder answered',
    ]);
  });

  it('没有时间戳的行跟着上一条（缩进），开头就没有时间戳的行丢弃', () => {
    const text = [
      'npm warn something',
      '2026-09-13T06:30:52.100Z  replica-a  ERROR  agent  boom',
      'Error: boom',
      '    at x (y.ts:1:1)',
    ].join('\n');
    expect(mergeTimeline([text])).toBe(
      '2026-09-13T06:30:52.100Z  replica-a  ERROR  agent  boom\n    Error: boom\n        at x (y.ts:1:1)\n',
    );
  });

  it('什么都没有时是空串', () => {
    expect(mergeTimeline(['', 'no stamp here'])).toBe('');
  });
});
