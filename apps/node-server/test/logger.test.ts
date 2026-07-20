/**
 * `src/logger.ts`：零依赖分级 logger（chat 可观测性工单）。覆盖点：分级过滤
 * （`level` 显式传入 vs `LOG_LEVEL` 环境变量兜底）、sink 注入（不碰
 * `process.stdout`）、单行格式（时间戳/级别/scope/message/结构化字段）、
 * `truncate` 截断助手、默认单例仍写 `process.stdout`。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LogFields } from '../src/logger.js';
import { createLogger, logger, truncate } from '../src/logger.js';

function collectingSink(): { lines: string[]; sink: (line: string) => void } {
  const lines: string[] = [];
  return {
    lines,
    sink: (line: string) => {
      lines.push(line);
    },
  };
}

describe('createLogger — level filtering', () => {
  it('default level (info) drops debug but keeps info/warn/error', () => {
    const { lines, sink } = collectingSink();
    const log = createLogger({ sink });

    log.debug('scope', 'debug message');
    log.info('scope', 'info message');
    log.warn('scope', 'warn message');
    log.error('scope', 'error message');

    expect(lines).toHaveLength(3);
    expect(lines.some((line) => line.includes('debug message'))).toBe(false);
    expect(lines.some((line) => line.includes('info message'))).toBe(true);
    expect(lines.some((line) => line.includes('warn message'))).toBe(true);
    expect(lines.some((line) => line.includes('error message'))).toBe(true);
  });

  it('level: "error" drops debug/info/warn, keeps only error', () => {
    const { lines, sink } = collectingSink();
    const log = createLogger({ level: 'error', sink });

    log.debug('scope', 'debug message');
    log.info('scope', 'info message');
    log.warn('scope', 'warn message');
    log.error('scope', 'error message');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('error message');
  });

  it('level: "debug" keeps everything, including debug', () => {
    const { lines, sink } = collectingSink();
    const log = createLogger({ level: 'debug', sink });

    log.debug('scope', 'debug message');
    log.info('scope', 'info message');

    expect(lines).toHaveLength(2);
  });

  it('level: "warn" keeps warn/error but drops debug/info', () => {
    const { lines, sink } = collectingSink();
    const log = createLogger({ level: 'warn', sink });

    log.debug('scope', 'a');
    log.info('scope', 'b');
    log.warn('scope', 'c');
    log.error('scope', 'd');

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(' WARN ');
    expect(lines[1]).toContain(' ERROR ');
  });
});

describe('createLogger — LOG_LEVEL environment variable', () => {
  const originalLogLevel = process.env.LOG_LEVEL;

  beforeEach(() => {
    delete process.env.LOG_LEVEL;
  });

  afterEach(() => {
    if (originalLogLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = originalLogLevel;
  });

  it('reads LOG_LEVEL when no explicit level is passed', () => {
    process.env.LOG_LEVEL = 'warn';
    const { lines, sink } = collectingSink();
    const log = createLogger({ sink });

    log.info('scope', 'should be dropped');
    log.warn('scope', 'should appear');

    expect(lines).toEqual([expect.stringContaining('should appear')]);
  });

  it('is case-insensitive ("DEBUG"/"Debug"/"debug" all resolve to the debug level)', () => {
    for (const raw of ['DEBUG', 'Debug', 'debug']) {
      process.env.LOG_LEVEL = raw;
      const { lines, sink } = collectingSink();
      const log = createLogger({ sink });
      log.debug('scope', 'x');
      expect(lines).toHaveLength(1);
    }
  });

  it('falls back to "info" when LOG_LEVEL is unset', () => {
    delete process.env.LOG_LEVEL;
    const { lines, sink } = collectingSink();
    const log = createLogger({ sink });

    log.debug('scope', 'dropped');
    log.info('scope', 'kept');

    expect(lines).toEqual([expect.stringContaining('kept')]);
  });

  it('falls back to "info" when LOG_LEVEL is an illegal value', () => {
    process.env.LOG_LEVEL = 'verbose'; // not a real LogLevel
    const { lines, sink } = collectingSink();
    const log = createLogger({ sink });

    log.debug('scope', 'dropped');
    log.info('scope', 'kept');

    expect(lines).toEqual([expect.stringContaining('kept')]);
  });

  it('an explicit level option takes priority over LOG_LEVEL', () => {
    process.env.LOG_LEVEL = 'error';
    const { lines, sink } = collectingSink();
    const log = createLogger({ level: 'debug', sink });

    log.debug('scope', 'kept because explicit level wins');

    expect(lines).toHaveLength(1);
  });
});

describe('createLogger — line format', () => {
  it('is "<ISO timestamp> <LEVEL> [<scope>] <message> <fields as JSON>"', () => {
    const { lines, sink } = collectingSink();
    const log = createLogger({ sink });

    log.info('turn-runner', 'tool call started', {
      sessionId: 's1',
      callId: 'call_1',
    });

    expect(lines).toHaveLength(1);
    const line = lines[0] ?? '';
    const match = /^(\S+) (\w+) \[(\w[\w-]*)\] (.+?) (\{.*\})$/.exec(line);
    expect(match).not.toBeNull();
    const [, timestamp, level, scope, message, fieldsJson] = match ?? [];
    expect(() => new Date(timestamp ?? '')).not.toThrow();
    expect(new Date(timestamp ?? '').toISOString()).toBe(timestamp);
    expect(level).toBe('INFO');
    expect(scope).toBe('turn-runner');
    expect(message).toBe('tool call started');
    expect(JSON.parse(fieldsJson ?? '{}')).toEqual({
      sessionId: 's1',
      callId: 'call_1',
    });
  });

  it('omits the trailing fields object entirely when no fields are passed', () => {
    const { lines, sink } = collectingSink();
    const log = createLogger({ sink });

    log.info('scope', 'plain message');

    expect(lines[0]).not.toContain('{');
    expect(lines[0]?.endsWith('plain message')).toBe(true);
  });

  it('omits the trailing fields object when fields is an empty object', () => {
    const { lines, sink } = collectingSink();
    const log = createLogger({ sink });

    log.info('scope', 'plain message', {});

    expect(lines[0]).not.toContain('{');
  });

  it('JSON.stringify drops keys whose value is undefined (e.g. waitMs when no matching approval-request was ever seen)', () => {
    const { lines, sink } = collectingSink();
    const log = createLogger({ sink });
    const fields: LogFields = { approvalId: 'a1', waitMs: undefined };

    log.info('scope', 'tool approval resolved', fields);

    const line = lines[0] ?? '';
    const fieldsJson = /(\{.*\})$/.exec(line)?.[1] ?? '{}';
    expect(JSON.parse(fieldsJson)).toEqual({ approvalId: 'a1' });
    expect('waitMs' in JSON.parse(fieldsJson)).toBe(false);
  });

  it('nested objects/arrays in fields survive JSON round-tripping intact', () => {
    const { lines, sink } = collectingSink();
    const log = createLogger({ sink });

    log.warn('scope', 'nested', { list: [1, 2, 3], nested: { a: 'b' } });

    const fieldsJson = /(\{.*\})$/.exec(lines[0] ?? '')?.[1] ?? '{}';
    expect(JSON.parse(fieldsJson)).toEqual({
      list: [1, 2, 3],
      nested: { a: 'b' },
    });
  });
});

describe('truncate', () => {
  it('returns the value unchanged when it is at or under maxLength', () => {
    expect(truncate('hello', 5)).toBe('hello');
    expect(truncate('hi', 5)).toBe('hi');
    expect(truncate('', 5)).toBe('');
  });

  it('truncates and appends an omitted-character-count suffix when over maxLength', () => {
    const long = 'x'.repeat(210);
    const result = truncate(long, 200);

    expect(result.startsWith('x'.repeat(200))).toBe(true);
    expect(result).toContain('+10');
    expect(result.length).toBeGreaterThan(200); // the suffix adds length back on top of the 200-char slice
  });

  it('the omitted-character count is exact for an arbitrary overage', () => {
    const long = 'a'.repeat(123);
    const result = truncate(long, 100);
    expect(result).toBe(`${'a'.repeat(100)}…(+23)`);
  });
});

describe('the default logger singleton', () => {
  it('writes to process.stdout when no sink is injected', () => {
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      logger.info('scope', 'hits real stdout');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[0]).toContain('hits real stdout');
    } finally {
      spy.mockRestore();
    }
  });
});
