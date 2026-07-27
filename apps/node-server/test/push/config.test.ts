/**
 * 推送总闸与事件白名单（docs/tech/push-notification.md §5.1、§6.5）。
 *
 * 这两个模块每次调用都重新读 env（不缓存，与仓库既有的 `resolve*` 同姿态），所以
 * 测试直接改 `process.env` 即可，不需要任何重置入口。
 */
import { afterEach, describe, expect, it } from 'vitest';

import { createLogger } from '../../src/logger.js';
import { isEventEnabled, resolveEnabledEvents } from '../../src/push/events.js';
import {
  getVapidConfig,
  isPushEnabled,
  logPushStartup,
} from '../../src/push/vapid.js';

const VAPID_VARS = [
  'VAPID_PUBLIC_KEY',
  'VAPID_PRIVATE_KEY',
  'VAPID_SUBJECT',
] as const;

function clearPushEnv(): void {
  for (const name of VAPID_VARS) delete process.env[name];
  delete process.env.CHAT_PUSH_EVENTS;
}

function setAllVapid(): void {
  process.env.VAPID_PUBLIC_KEY = 'pub';
  process.env.VAPID_PRIVATE_KEY = 'priv';
  process.env.VAPID_SUBJECT = 'mailto:me@example.com';
}

/** 收集日志行，用来断言"恰好说一遍"。 */
function collectingLogger(): {
  lines: string[];
  logger: ReturnType<typeof createLogger>;
} {
  const lines: string[] = [];
  return {
    lines,
    logger: createLogger({
      level: 'debug',
      sink: (line) => lines.push(line),
    }),
  };
}

afterEach(clearPushEnv);

describe('push/vapid —— 总闸', () => {
  it('三个变量全空 = 禁用', () => {
    clearPushEnv();
    expect(isPushEnabled()).toBe(false);
    expect(getVapidConfig()).toBeUndefined();
  });

  it('只配了两个（漏一个）仍然是禁用', () => {
    clearPushEnv();
    process.env.VAPID_PUBLIC_KEY = 'pub';
    process.env.VAPID_PRIVATE_KEY = 'priv';
    expect(isPushEnabled()).toBe(false);
  });

  it('空白字符串等于没配（不是"配了个空值"）', () => {
    setAllVapid();
    process.env.VAPID_SUBJECT = '   ';
    expect(isPushEnabled()).toBe(false);
  });

  it('三个都齐了才启用，且返回的配置去掉了首尾空白', () => {
    setAllVapid();
    process.env.VAPID_PUBLIC_KEY = '  pub  ';
    expect(isPushEnabled()).toBe(true);
    expect(getVapidConfig()).toEqual({
      publicKey: 'pub',
      privateKey: 'priv',
      subject: 'mailto:me@example.com',
    });
  });
});

describe('push/vapid —— 启动日志', () => {
  it('全空时恰好一行「未配置」，不告警', () => {
    clearPushEnv();
    const { lines, logger } = collectingLogger();
    logPushStartup(logger);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('推送未配置');
    expect(lines[0]).toContain('INFO');
  });

  it('配了一半时告警并点名缺哪个', () => {
    clearPushEnv();
    process.env.VAPID_PUBLIC_KEY = 'pub';
    const { lines, logger } = collectingLogger();
    logPushStartup(logger);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('WARN');
    expect(lines[0]).toContain('VAPID_PRIVATE_KEY');
    expect(lines[0]).toContain('VAPID_SUBJECT');
    expect(lines[0]).not.toContain('VAPID_PUBLIC_KEY');
  });

  it('齐了则报「已启用」并列出开着的事件', () => {
    setAllVapid();
    process.env.CHAT_PUSH_EVENTS = 'approval,turn-done';
    const { lines, logger } = collectingLogger();
    logPushStartup(logger);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('推送已启用');
    expect(lines[0]).toContain('approval,turn-done');
  });
});

describe('push/events —— 事件白名单', () => {
  it('未设置 = 四类全开', () => {
    clearPushEnv();
    expect([...resolveEnabledEvents()].sort()).toEqual([
      'approval',
      'question',
      'turn-done',
      'turn-failed',
    ]);
  });

  it('空字符串也当作未设置（四类全开）', () => {
    process.env.CHAT_PUSH_EVENTS = '   ';
    expect(isEventEnabled('approval')).toBe(true);
    expect(isEventEnabled('turn-done')).toBe(true);
  });

  it('只列一个就只开一个', () => {
    process.env.CHAT_PUSH_EVENTS = 'approval';
    expect(isEventEnabled('approval')).toBe(true);
    expect(isEventEnabled('question')).toBe(false);
    expect(isEventEnabled('turn-done')).toBe(false);
    expect(isEventEnabled('turn-failed')).toBe(false);
  });

  it('认不出的值忽略并告警，合法的照常生效', () => {
    process.env.CHAT_PUSH_EVENTS = 'approval, nonsense ,turn-done';
    const { lines, logger } = collectingLogger();
    const enabled = resolveEnabledEvents(logger);
    expect([...enabled].sort()).toEqual(['approval', 'turn-done']);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('nonsense');
  });

  it('显式填了一个合法值都没有的内容 = 全部关闭（不兜底成全开）', () => {
    process.env.CHAT_PUSH_EVENTS = 'typo';
    expect([...resolveEnabledEvents()]).toEqual([]);
  });
});
