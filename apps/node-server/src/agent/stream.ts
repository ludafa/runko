/**
 * [流分发](../../../../docs/terms.md)的装配：**配了 `REDIS_URL` 就广播给所有副本，没配就用
 * 框架内置的进程内那份。**
 *
 * 为什么要广播：多副本时，看直播的人连到哪个副本是负载均衡说了算，而内容由**正在跑这一轮的
 * 那个副本**产生。不广播的话，只能把那条长连接转给[持有者](../../../../docs/terms.md)——
 * 多一跳、持有者一崩连接就断。广播之后连到谁都一样。
 *
 * **连接是懒的**：这个工厂同步返回，Redis 在后台连。理由是装配发生在模块顶层（`routes/chat.ts`
 * 底部的单例），那里不该 `await` 一个外部服务——生成接口文档、跑单测都会 import 到它。
 * 发布与订阅都是异步方法，等一下连接就绪即可；连不上时发布失败只记一行，
 * 直播本来就是尽力而为的，事实来源是[账本](../../../../docs/terms.md)。
 *
 * 设计见 docs/host/node/tech/cluster-lab.md §2、§5。
 */
import type { StreamFanout } from '@runko/agent';
import type { RedisPublisher, RedisSubscriber } from '@runko/stream-redis';
import { redisFanout } from '@runko/stream-redis';

import type { Logger } from '../logger.js';
import { logger as defaultLogger } from '../logger.js';

const LOG_SCOPE = 'stream';

export interface ChatStream {
  /** 传给 `createAgentRuntime` 的那一项；`undefined` = 用框架内置的进程内实现。 */
  readonly fanout: StreamFanout | undefined;
  /** 配了 Redis 时为 `true`——直播流据此决定**不再转发给持有者**。 */
  readonly broadcasts: boolean;
  /** 进程退出时收掉连接。没有 Redis 时是空操作。 */
  close(): Promise<void>;
}

/** 不配 Redis 的那一档：框架自己有进程内的 fan-out，这里什么都不用给。 */
const IN_PROCESS: ChatStream = {
  fanout: undefined,
  broadcasts: false,
  close: () => Promise.resolve(),
};

/** 两条连接：一条发布、一条订阅。Redis 的连接进入订阅模式之后不能再发普通命令。 */
interface RedisPair {
  publisher: RedisPublisher & { close(): Promise<void> };
  subscriber: RedisSubscriber & { close(): Promise<void> };
}

async function connectPair(url: string, log: Logger): Promise<RedisPair> {
  const { createClient } = await import('redis');
  const publisher = createClient({ url });
  const subscriber = publisher.duplicate();
  // 连接级错误必须接住：没人监听 `error` 时 Node 会当成未捕获异常，整个副本退出。
  for (const client of [publisher, subscriber]) {
    client.on('error', (error: Error) => {
      log.warn(LOG_SCOPE, 'redis connection error', { error: error.message });
    });
  }
  await publisher.connect();
  await subscriber.connect();
  log.info(LOG_SCOPE, 'broadcasting live frames through redis');
  return { publisher, subscriber };
}

export interface CreateChatStreamOptions {
  url?: string | undefined;
  /** 本副本的名字。`@runko/stream-redis` 用它认出「这条是我自己发的」，所以每个进程要唯一。 */
  nodeId: string;
  logger?: Logger;
}

export function createChatStream(opts: CreateChatStreamOptions): ChatStream {
  const url = opts.url?.trim();
  if (url === undefined || url.length === 0) {
    return IN_PROCESS;
  }
  const log = opts.logger ?? defaultLogger;
  const connecting = connectPair(url, log);
  // 连不上时不要变成未处理的 rejection——下面每个 await 点都会各自拿到这个失败。
  connecting.catch(() => undefined);

  const publisher: RedisPublisher = {
    publish: async (channel, message) =>
      (await connecting).publisher.publish(channel, message),
  };
  const subscriber: RedisSubscriber = {
    subscribe: async (channel, listener) =>
      (await connecting).subscriber.subscribe(channel, listener),
    unsubscribe: async (channel) =>
      (await connecting).subscriber.unsubscribe(channel),
  };

  return {
    fanout: redisFanout({
      publisher,
      subscriber,
      nodeId: opts.nodeId,
      logger: log,
    }),
    broadcasts: true,
    close: async () => {
      const pair = await connecting.catch(() => undefined);
      if (pair === undefined) {
        return;
      }
      await pair.subscriber.close();
      await pair.publisher.close();
    },
  };
}
