/**
 * [流分发](../../../../docs/terms.md)装配的三档：不配 Redis、配齐、**只配了一半**。
 *
 * 重点在第三档：配了 `REDIS_URL` 却没配 `RUNKO_NODE_URL` 时，所有副本会叫同一个名字，
 * 于是每个副本都把别人广播来的帧当成自己发的丢掉，而 `broadcasts === true` 又会让调用方
 * 关掉「转发给持有者」那条退路——必须退回进程内 fan-out，并且吵一嗓子。
 *
 * `redis` 模块整个换成替身：`createChatStream` 是懒连接的，真去连会在测试进程里留下一个
 * 后台重连的句柄。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createLogger } from '../../src/logger.js';

const { createClientMock } = vi.hoisted(() => ({ createClientMock: vi.fn() }));

vi.mock('redis', () => ({
  createClient: (...args: unknown[]) => createClientMock(...args),
}));

// 在 mock 注册之后再 import（vi.mock 被提升到所有 import 之前）。
const { createChatStream } = await import('../../src/agent/stream.js');

/** 够用的假客户端：连接、复制出订阅端、收连接级错误、关掉。 */
interface FakeRedisClient {
  on(event: string, handler: (error: Error) => void): FakeRedisClient;
  connect(): Promise<void>;
  duplicate(): FakeRedisClient;
  publish(channel: string, message: string): Promise<number>;
  subscribe(
    channel: string,
    listener: (message: string) => void,
  ): Promise<void>;
  unsubscribe(channel: string): Promise<void>;
  close(): Promise<void>;
}

function fakeRedisClient(): FakeRedisClient {
  const client: FakeRedisClient = {
    on: () => client,
    connect: () => Promise.resolve(),
    duplicate: () => fakeRedisClient(),
    publish: () => Promise.resolve(0),
    subscribe: () => Promise.resolve(),
    unsubscribe: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
  return client;
}

/** 收日志行的 logger：`level: 'debug'` 是为了一行都不漏。 */
function capturingLogger() {
  const lines: string[] = [];
  return {
    lines,
    logger: createLogger({
      level: 'debug',
      sink: (line) => {
        lines.push(line);
      },
    }),
  };
}

function errorLines(lines: readonly string[]): string[] {
  return lines.filter((line) => line.includes(' ERROR '));
}

const REDIS_URL = 'redis://127.0.0.1:6379';

describe('createChatStream', () => {
  beforeEach(() => {
    createClientMock.mockReset();
    createClientMock.mockImplementation(() => fakeRedisClient());
  });

  it('配齐了 REDIS_URL + nodeId：走 Redis 广播', async () => {
    const { lines, logger } = capturingLogger();

    const stream = createChatStream({
      url: REDIS_URL,
      nodeId: 'http://node-a:3900',
      logger,
    });

    expect(stream.broadcasts).toBe(true);
    expect(stream.fanout).toBeDefined();
    expect(errorLines(lines)).toEqual([]);

    await stream.close();
    expect(createClientMock).toHaveBeenCalledWith({ url: REDIS_URL });
  });

  it('配了 REDIS_URL 但没配 nodeId：退回进程内，并记一行 error', async () => {
    const { lines, logger } = capturingLogger();

    const stream = createChatStream({ url: REDIS_URL, logger });

    // 退回进程内：不广播、不给 fanout（框架用它自己那份）。
    expect(stream.broadcasts).toBe(false);
    expect(stream.fanout).toBeUndefined();
    // 连都不连——不然会留下一条谁都不用的 Redis 连接。
    expect(createClientMock).not.toHaveBeenCalled();

    const errors = errorLines(lines);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('REDIS_URL');
    expect(errors[0]).toContain('RUNKO_NODE_URL');

    await expect(stream.close()).resolves.toBeUndefined();
  });

  it('nodeId 是空白串等于没配：同样退回并记 error', () => {
    const { lines, logger } = capturingLogger();

    const stream = createChatStream({
      url: REDIS_URL,
      nodeId: '   ',
      logger,
    });

    expect(stream.broadcasts).toBe(false);
    expect(stream.fanout).toBeUndefined();
    expect(createClientMock).not.toHaveBeenCalled();
    expect(errorLines(lines)).toHaveLength(1);
  });

  it('没配 REDIS_URL：进程内那档，不连 Redis 也不报错', async () => {
    const { lines, logger } = capturingLogger();

    const stream = createChatStream({ nodeId: 'http://node-a:3900', logger });

    expect(stream.broadcasts).toBe(false);
    expect(stream.fanout).toBeUndefined();
    expect(createClientMock).not.toHaveBeenCalled();
    expect(lines).toEqual([]);

    await expect(stream.close()).resolves.toBeUndefined();
  });

  it('REDIS_URL 是空白串等于没配：两样都缺也不吵', () => {
    const { lines, logger } = capturingLogger();

    const stream = createChatStream({ url: '   ', logger });

    expect(stream.broadcasts).toBe(false);
    expect(stream.fanout).toBeUndefined();
    expect(createClientMock).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });
});
