/**
 * 两个测试文件共用的假 Redis 与帧构造器。
 *
 * 假 Redis 只干一件事：把「谁订了哪个频道」记在进程内的一张表里，`publish` 时同步转发给
 * 订上的人。要验的是**这个包自己的逻辑**，不是 Redis 的发布订阅对不对。
 *
 * 除了顺风路径，它还带三个「让事情出错」的开关——订阅失败、发布失败、把一次 `SUBSCRIBE`
 * 扣在半空中。这三条错误路径正是这个包要处理的，没有开关就只测得到顺风路径。
 */
import type { Frame } from "@runko/agent";

import type { RedisPublisher, RedisSubscriber } from "../src/index.js";

type ChannelListener = (message: string) => void;

/** 被扣在半空中的那次 `SUBSCRIBE` 的遥控器：由测试决定它什么时候、以什么结果落地。 */
export interface HeldSubscribe {
  /** 让它成功。学真 node-redis：**resolve 之后**监听器才开始收消息。 */
  succeed: () => void;
  /** 让它失败。 */
  fail: () => void;
}

export interface FakeRedis {
  publisher: RedisPublisher;
  /** 每个 fanout 实例取一条订阅连接（真实部署里也是一个进程一条 duplicate 连接）。 */
  subscriberFor: () => RedisSubscriber;
  published: { channel: string; message: string }[];
  /** Redis 上现在有几个频道有人订着。 */
  channelCount: () => number;
  /** `SUBSCRIBE` 一共发过几次——用来断言「重试了」与「不再重试了」。 */
  subscribeCalls: () => number;
  /** `UNSUBSCRIBE` 发过哪些频道——用来断言「没在 Redis 上留没人看的订阅」。 */
  unsubscribed: string[];
  breakNextPublish: () => void;
  /** 接下来 `times` 次 `SUBSCRIBE` 一律失败；传 `Number.POSITIVE_INFINITY` 就是一直失败。 */
  breakSubscribe: (times: number) => void;
  /** 把下一次 `SUBSCRIBE` 扣在半空中，返回它的遥控器。 */
  holdNextSubscribe: () => HeldSubscribe;
}

export function fakeRedis(): FakeRedis {
  const channels = new Map<string, Set<ChannelListener>>();
  const published: { channel: string; message: string }[] = [];
  const unsubscribed: string[] = [];
  let failNextPublish = false;
  /** 还欠几次失败。先扣次数再决定这一次 reject 还是 resolve。 */
  let subscribeFailuresLeft = 0;
  let subscribeCallCount = 0;
  /** 下一次 `SUBSCRIBE` 要不要被扣住。 */
  let holdArmed = false;
  /** 正被扣着的那次 `SUBSCRIBE` 的落地开关；没有在飞的就是 `undefined`。 */
  let settleHeld: ((outcome: "succeed" | "fail") => void) | undefined;

  const register = (channel: string, listener: ChannelListener): void => {
    let listeners = channels.get(channel);
    if (listeners === undefined) {
      listeners = new Set();
      channels.set(channel, listeners);
    }
    listeners.add(listener);
  };

  const settle = (outcome: "succeed" | "fail"): void => {
    if (settleHeld === undefined) {
      // 大声失败，别让「遥控器按了个空」变成一条假绿的用例。
      throw new Error("没有被扣住的 SUBSCRIBE 可以落地");
    }
    settleHeld(outcome);
  };

  const publisher: RedisPublisher = {
    publish(channel, message) {
      if (failNextPublish) {
        failNextPublish = false;
        return Promise.reject(new Error("redis is down"));
      }
      published.push({ channel, message });
      for (const listener of channels.get(channel) ?? []) {
        listener(message);
      }
      return Promise.resolve(1);
    },
  };

  const subscriberFor = (): RedisSubscriber => ({
    subscribe(channel, listener) {
      subscribeCallCount += 1;
      if (holdArmed) {
        holdArmed = false;
        return new Promise<void>((resolve, reject) => {
          settleHeld = (outcome) => {
            settleHeld = undefined;
            if (outcome === "succeed") {
              register(channel, listener);
              resolve();
              return;
            }
            reject(new Error("redis refused SUBSCRIBE"));
          };
        });
      }
      if (subscribeFailuresLeft > 0) {
        subscribeFailuresLeft -= 1;
        return Promise.reject(new Error("redis refused SUBSCRIBE"));
      }
      register(channel, listener);
      return Promise.resolve();
    },
    unsubscribe(channel) {
      unsubscribed.push(channel);
      channels.delete(channel);
      return Promise.resolve();
    },
  });

  return {
    publisher,
    subscriberFor,
    published,
    unsubscribed,
    channelCount: () => channels.size,
    subscribeCalls: () => subscribeCallCount,
    breakNextPublish: () => {
      failNextPublish = true;
    },
    breakSubscribe: (times: number) => {
      subscribeFailuresLeft = times;
    },
    holdNextSubscribe: () => {
      holdArmed = true;
      return {
        succeed: () => {
          settle("succeed");
        },
        fail: () => {
          settle("fail");
        },
      };
    },
  };
}

export const frame = (text: string): Frame => ({
  kind: "chunk",
  chunk: { type: "text-delta", id: "t1", delta: text },
});
