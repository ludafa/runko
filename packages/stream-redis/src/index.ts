/**
 * **[流分发](../../../docs/terms.md)的 Redis 实现**——多副本部署时，把正在产生的内容广播给
 * 所有副本，于是「看直播」这件事连到哪个副本都行，不必把连接转给[持有者](../../../docs/terms.md)。
 *
 * 契约见 [流分发 · 技术方案](../../../docs/host/contract/tech/stream-fanout.md)：两个方法，
 * 一条硬约束——**`subscribe` 必须同步**。Redis 的 `SUBSCRIBE` 是异步的，所以这里的做法是：
 *
 * | 谁 | 怎么做 |
 * |---|---|
 * | `subscribe` | 同步挂进**本地登记簿**并立刻返回退订函数；真正的 Redis 订阅在后台补上 |
 * | `publish` | **先同步发给本进程的订阅者**（零空隙的保证一字不改），再异步发给 Redis |
 * | 收到 Redis 消息 | 是自己发的就丢掉——否则本进程的订阅者会收到两遍 |
 *
 * **Redis 掉线不影响一轮**：发布失败只记一行。直播内容本来就是尽力而为，事实来源是
 * [账本](../../../docs/terms.md)；客户端重连时带上「看到第几条了」，落下的从账本补。
 *
 * 设计与取舍见[集群实验环境 · 技术方案](../../../docs/host/node/tech/cluster-lab.md) §2。
 */
import type { Frame, Logger, StreamFanout } from "@runko/agent";

/** 频道名：一个会话一个。没人订阅的会话不占任何东西。 */
const CHANNEL_PREFIX = "runko:stream:";

const LOG_SCOPE = "stream-redis";

/**
 * 需要的 Redis 客户端能力——**手写的最小结构接口**，运行时不 import 任何驱动。
 *
 * 与 `@runko/persist-*` 那几个包同款姿态：宿主把自己那份客户端实例传进来，这个包只描述
 * 「我会用到哪几个方法」。node-redis 与 ioredis 的实例都对得上这个形状。
 */
export interface RedisPublisher {
  publish(channel: string, message: string): Promise<unknown>;
}

/**
 * 订阅端。**必须是一条独立连接**：Redis 的连接一旦进入订阅模式就不能再发普通命令，
 * 所以发布与订阅不能共用一条（node-redis 用 `client.duplicate()` 造第二条）。
 */
export interface RedisSubscriber {
  subscribe(
    channel: string,
    listener: (message: string) => void,
  ): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
}

export interface RedisFanoutOptions {
  publisher: RedisPublisher;
  subscriber: RedisSubscriber;
  /**
   * 本副本的名字，用来认出「这条消息是我自己发的」。多副本时给可达地址
   * （与租约里的 `holder` 同一个值最省事）。
   */
  nodeId: string;
  /** 缺省静音。接上之后能看到发布失败、脏消息这些只有运维关心的事。 */
  logger?: Logger;
}

/** 走 Redis 的那一跳上传的东西。 */
interface Envelope {
  /** 发布者的名字。收到自己发的就丢掉。 */
  from: string;
  conversationId: string;
  frame: Frame;
}

function isEnvelope(value: unknown): value is Envelope {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!("from" in value) || !("conversationId" in value) || !("frame" in value)) {
    return false;
  }
  const frame: unknown = value.frame;
  return (
    typeof value.from === "string" &&
    typeof value.conversationId === "string" &&
    typeof frame === "object" &&
    frame !== null &&
    "kind" in frame
  );
}

const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function redisFanout(opts: RedisFanoutOptions): StreamFanout {
  const log = opts.logger ?? noopLogger;
  /** 会话 → 本进程挂着的监听器。**它是同步那一半**，Redis 只是把别的副本的帧送进来。 */
  const local = new Map<string, Set<(frame: Frame) => void>>();
  /** 已经（或正在）向 Redis 订阅的频道。 */
  const channels = new Set<string>();

  const deliverLocally = (conversationId: string, frame: Frame): void => {
    const listeners = local.get(conversationId);
    if (listeners === undefined) {
      return;
    }
    // 复制一份再遍历：监听器里退订是常事（一轮结束时订阅者会收掉自己）。
    for (const listener of [...listeners]) {
      try {
        listener(frame);
      } catch (error) {
        // 一个订阅者抛错不该连累别的订阅者，更不该冒泡回正在跑的那一轮。
        log.error(LOG_SCOPE, "a stream listener threw", {
          conversationId,
          error: describe(error),
        });
      }
    }
  };

  const onMessage = (raw: string): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      log.warn(LOG_SCOPE, "dropped an unparsable stream message", {
        error: describe(error),
      });
      return;
    }
    if (!isEnvelope(parsed)) {
      log.warn(LOG_SCOPE, "dropped a stream message with an unexpected shape");
      return;
    }
    // 自己发的那一份已经在 publish 里同步发过了。
    if (parsed.from === opts.nodeId) {
      return;
    }
    deliverLocally(parsed.conversationId, parsed.frame);
  };

  const ensureChannel = (conversationId: string): void => {
    const channel = `${CHANNEL_PREFIX}${conversationId}`;
    if (channels.has(channel)) {
      return;
    }
    channels.add(channel);
    // 后台补上。这中间到达的远端帧会漏——契约允许（「掉了靠回放补」），客户端连上时
    // 本来就先回放账本。
    void opts.subscriber.subscribe(channel, onMessage).catch((error: unknown) => {
      channels.delete(channel);
      log.warn(LOG_SCOPE, "failed to subscribe to a stream channel", {
        conversationId,
        error: describe(error),
      });
    });
  };

  const releaseChannel = (conversationId: string): void => {
    const channel = `${CHANNEL_PREFIX}${conversationId}`;
    if (!channels.delete(channel)) {
      return;
    }
    void opts.subscriber.unsubscribe(channel).catch((error: unknown) => {
      log.warn(LOG_SCOPE, "failed to unsubscribe from a stream channel", {
        conversationId,
        error: describe(error),
      });
    });
  };

  return {
    publish(conversationId: string, frame: Frame): void {
      // ① 本进程的订阅者先拿到——这一步是同步的，契约里那条「零空隙」保证靠它。
      deliverLocally(conversationId, frame);
      // ② 再广播给别的副本。失败只记一行：直播是尽力而为的，账本才是事实来源。
      const envelope: Envelope = { from: opts.nodeId, conversationId, frame };
      void opts.publisher
        .publish(`${CHANNEL_PREFIX}${conversationId}`, JSON.stringify(envelope))
        .catch((error: unknown) => {
          log.warn(LOG_SCOPE, "failed to broadcast a frame", {
            conversationId,
            error: describe(error),
          });
        });
    },

    subscribe(
      conversationId: string,
      listener: (frame: Frame) => void,
    ): () => void {
      let listeners = local.get(conversationId);
      if (listeners === undefined) {
        listeners = new Set();
        local.set(conversationId, listeners);
      }
      listeners.add(listener);
      ensureChannel(conversationId);

      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        const current = local.get(conversationId);
        if (current === undefined) {
          return;
        }
        current.delete(listener);
        if (current.size === 0) {
          local.delete(conversationId);
          // 本进程已经没人看这个会话了，别让频道越积越多。
          releaseChannel(conversationId);
        }
      };
    },
  };
}
