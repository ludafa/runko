/**
 * **[流分发](../../../docs/terms.md)的 Redis 实现**——多副本部署时，把正在产生的内容广播给
 * 所有副本，于是「看直播」这件事连到哪个副本都行，不必把连接转给[持有者](../../../docs/terms.md)。
 *
 * 契约见 [流分发 · 技术方案](../../../docs/host/contract/tech/stream-fanout.md)：两个方法，
 * 一条硬约束——**`subscribe` 必须同步**。Redis 的 `SUBSCRIBE` 是异步的，所以这里的做法是：
 *
 * | 谁 | 怎么做 |
 * |---|---|
 * | `subscribe` | 同步挂进**本地登记簿**并立刻返回退订函数；真正的 Redis 订阅在后台补上（订不上就退避重试） |
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
 * 订阅失败之后的退避节奏：200ms 起步、每失败一次翻倍、封顶 5s，不加随机抖动。
 *
 * 不抖动是有意的：一个进程同时在重的频道数最多是「本副本正在看的会话数」，量级很小，
 * 没有惊群问题；固定节奏换来行为可预期（出事时看日志就能对上第几次重试）。
 */
const RETRY_BASE_MS = 200;
const RETRY_MAX_MS = 5000;

function retryDelayMs(failures: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_MAX_MS);
}

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

/** 一个频道的订阅进度。**没订上时要么有一次请求在飞，要么有一个重试定时器在等**，二者必居其一。 */
interface ChannelState {
  /** Redis 那边确认订上了。退订时据此决定要不要真发 `UNSUBSCRIBE`。 */
  subscribed: boolean;
  /** 连续失败几次了，决定下次等多久。 */
  failures: number;
  /** 正在等的重试定时器。同一频道同一时刻最多一个，退订时要清掉。 */
  retryTimer: ReturnType<typeof setTimeout> | undefined;
}

export function redisFanout(opts: RedisFanoutOptions): StreamFanout {
  const log = opts.logger ?? noopLogger;
  /** 会话 → 本进程挂着的监听器。**它是同步那一半**，Redis 只是把别的副本的帧送进来。 */
  const local = new Map<string, Set<(frame: Frame) => void>>();
  /** 已经（或正在）向 Redis 订阅的频道 → 它的订阅进度。 */
  const channels = new Map<string, ChannelState>();

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

  const unsubscribeQuietly = (conversationId: string, channel: string): void => {
    void opts.subscriber.unsubscribe(channel).catch((error: unknown) => {
      log.warn(LOG_SCOPE, "failed to unsubscribe from a stream channel", {
        conversationId,
        error: describe(error),
      });
    });
  };

  /**
   * 发一次 `SUBSCRIBE`，**失败就排一个退避重试**——只要本地还有人在看这个会话。
   *
   * 为什么非重试不可：node-redis 只在命令 resolve 之后才把监听器记进它的 pub-sub 表
   * （`reject` 那条路什么都不记）。所以一次失败之后，连 Redis 自己重连时的 `resubscribe`
   * 也救不回来——这个会话的远端帧会**永久**收不到。订阅正好赶上 Redis 重启就是这个场面。
   */
  const attemptSubscribe = (
    conversationId: string,
    channel: string,
    state: ChannelState,
  ): void => {
    state.retryTimer = undefined;
    void opts.subscriber.subscribe(channel, onMessage).then(
      () => {
        if (channels.get(channel) !== state) {
          // 这次成功属于一次「已经没人要了」的旧尝试。频道没被重新要上的话，把它退掉，
          // 别在 Redis 上留个没人看的订阅；被重新要上了就不碰——那份订阅正是新的那位要的
          // （监听器是同一个函数引用，node-redis 按 Set 存，不会重复投递）。
          if (!channels.has(channel)) {
            unsubscribeQuietly(conversationId, channel);
          }
          return;
        }
        state.subscribed = true;
        state.failures = 0;
      },
      (error: unknown) => {
        state.failures += 1;
        if (channels.get(channel) !== state) {
          // 重试的意义是「本地还有人在等远端帧」。这次请求在飞的过程中最后一个监听器走了，
          // 那就到此为止。
          log.warn(
            LOG_SCOPE,
            "gave up subscribing to a stream channel: no listeners left",
            { conversationId, attempts: state.failures, error: describe(error) },
          );
          return;
        }
        const delay = retryDelayMs(state.failures);
        log.warn(LOG_SCOPE, "failed to subscribe to a stream channel; retrying", {
          conversationId,
          attempt: state.failures,
          retryInMs: delay,
          error: describe(error),
        });
        state.retryTimer = setTimeout(() => {
          attemptSubscribe(conversationId, channel, state);
        }, delay);
      },
    );
  };

  const ensureChannel = (conversationId: string): void => {
    const channel = `${CHANNEL_PREFIX}${conversationId}`;
    if (channels.has(channel)) {
      return;
    }
    const state: ChannelState = {
      subscribed: false,
      failures: 0,
      retryTimer: undefined,
    };
    channels.set(channel, state);
    // 后台补上。订上之前到达的远端帧会漏——契约允许（「掉了靠回放补」），客户端连上时
    // 本来就先回放账本。
    attemptSubscribe(conversationId, channel, state);
  };

  const releaseChannel = (conversationId: string): void => {
    const channel = `${CHANNEL_PREFIX}${conversationId}`;
    const state = channels.get(channel);
    if (state === undefined) {
      return;
    }
    channels.delete(channel);
    if (state.retryTimer !== undefined) {
      // 还没订上就没人看了：把等着的定时器清掉。留着既是白重试，也会吊住 Node 进程不退出。
      clearTimeout(state.retryTimer);
      state.retryTimer = undefined;
      log.warn(LOG_SCOPE, "gave up subscribing to a stream channel: no listeners left", {
        conversationId,
        attempts: state.failures,
      });
    }
    if (state.subscribed) {
      unsubscribeQuietly(conversationId, channel);
    }
    // 没订上就不发 `UNSUBSCRIBE`：没有什么要撤的。万一还有一次请求在飞，它 resolve 时
    // 会在 `attemptSubscribe` 里自己收尾。
  };

  return {
    // 别的副本发的帧这里收得到——所以一轮跑在别处时，订阅方**留着等**而不是收线
    // （框架据此决定，见 `StreamFanout.crossInstance`）。
    crossInstance: true,

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
