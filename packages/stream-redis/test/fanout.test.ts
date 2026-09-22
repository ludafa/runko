/**
 * Redis 版[流分发](../../../docs/terms.md)。
 *
 * 用一个假的 Redis（进程内的频道表）跑：要验的是**这个包自己的逻辑**——同步登记、本地回环、
 * 认出自己发的、失败不抛——不是 Redis 的发布订阅对不对。真 Redis 的往返由集群端到端覆盖。
 */
import type { Frame } from "@runko/agent";
import { describe, expect, it } from "vitest";

import type { RedisPublisher, RedisSubscriber } from "../src/index.js";
import { redisFanout } from "../src/index.js";

/** 一个进程内的假 Redis：谁订了哪个频道、发出去的消息给谁。 */
function fakeRedis() {
  const channels = new Map<string, Set<(message: string) => void>>();
  const published: { channel: string; message: string }[] = [];
  let failNextPublish = false;

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
      let listeners = channels.get(channel);
      if (listeners === undefined) {
        listeners = new Set();
        channels.set(channel, listeners);
      }
      listeners.add(listener);
      return Promise.resolve();
    },
    unsubscribe(channel) {
      channels.delete(channel);
      return Promise.resolve();
    },
  });

  return {
    publisher,
    subscriberFor,
    published,
    channelCount: () => channels.size,
    breakNextPublish: () => {
      failNextPublish = true;
    },
  };
}

const frame = (text: string): Frame => ({
  kind: "chunk",
  chunk: { type: "text-delta", id: "t1", delta: text },
});

/** 让后台那次 `SUBSCRIBE` 落地。 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("redisFanout", () => {
  it("**subscribe 是同步的**：返回之后马上 publish，这一帧就收得到", () => {
    const redis = fakeRedis();
    const fanout = redisFanout({
      publisher: redis.publisher,
      subscriber: redis.subscriberFor(),
      nodeId: "node-a",
    });

    const seen: Frame[] = [];
    // 中间**没有 await**——契约要的就是这个（挂订阅与取进行中草稿快照之间不能留缝）。
    fanout.subscribe("c1", (f) => seen.push(f));
    fanout.publish("c1", frame("你好"));

    expect(seen).toHaveLength(1);
  });

  it("自己发的帧只收一遍（本地回环一次 + Redis 回来那次要丢掉）", async () => {
    const redis = fakeRedis();
    const fanout = redisFanout({
      publisher: redis.publisher,
      subscriber: redis.subscriberFor(),
      nodeId: "node-a",
    });

    const seen: Frame[] = [];
    fanout.subscribe("c1", (f) => seen.push(f));
    await settle(); // 后台订阅落地之后，自己发的也会从 Redis 绕回来

    fanout.publish("c1", frame("只该出现一次"));
    await settle();

    expect(seen).toHaveLength(1);
  });

  it("**别的副本发的收得到**——这就是多副本共享直播的那一跳", async () => {
    const redis = fakeRedis();
    const a = redisFanout({
      publisher: redis.publisher,
      subscriber: redis.subscriberFor(),
      nodeId: "node-a",
    });
    const b = redisFanout({
      publisher: redis.publisher,
      subscriber: redis.subscriberFor(),
      nodeId: "node-b",
    });

    const seenOnB: Frame[] = [];
    b.subscribe("c1", (f) => seenOnB.push(f));
    await settle();

    a.publish("c1", frame("A 在跑这一轮"));
    await settle();

    expect(seenOnB).toHaveLength(1);
    expect(JSON.stringify(seenOnB[0])).toContain("A 在跑这一轮");
  });

  it("退订之后不再收；本会话没人看了就把频道退掉", async () => {
    const redis = fakeRedis();
    const a = redisFanout({
      publisher: redis.publisher,
      subscriber: redis.subscriberFor(),
      nodeId: "node-a",
    });
    const b = redisFanout({
      publisher: redis.publisher,
      subscriber: redis.subscriberFor(),
      nodeId: "node-b",
    });

    const seen: Frame[] = [];
    const stop = b.subscribe("c1", (f) => seen.push(f));
    await settle();
    expect(redis.channelCount()).toBe(1);

    stop();
    await settle();
    expect(redis.channelCount()).toBe(0);

    a.publish("c1", frame("没人看了"));
    await settle();
    expect(seen).toHaveLength(0);
  });

  it("**Redis 挂了 publish 不抛**：本进程照样收得到，这一轮不受影响", async () => {
    const redis = fakeRedis();
    const fanout = redisFanout({
      publisher: redis.publisher,
      subscriber: redis.subscriberFor(),
      nodeId: "node-a",
    });

    const seen: Frame[] = [];
    fanout.subscribe("c1", (f) => seen.push(f));
    redis.breakNextPublish();

    expect(() => {
      fanout.publish("c1", frame("库挂了也得发出去"));
    }).not.toThrow();
    await settle();

    expect(seen).toHaveLength(1);
  });

  it("脏消息丢掉，订阅不断（下一帧照收）", async () => {
    const redis = fakeRedis();
    const b = redisFanout({
      publisher: redis.publisher,
      subscriber: redis.subscriberFor(),
      nodeId: "node-b",
    });

    const seen: Frame[] = [];
    b.subscribe("c1", (f) => seen.push(f));
    await settle();

    // 直接往频道里塞两条坏消息：不是 JSON、以及形状不对。
    await redis.publisher.publish("runko:stream:c1", "{ 这不是 JSON");
    await redis.publisher.publish("runko:stream:c1", JSON.stringify({ hello: 1 }));
    expect(seen).toHaveLength(0);

    const a = redisFanout({
      publisher: redis.publisher,
      subscriber: redis.subscriberFor(),
      nodeId: "node-a",
    });
    a.publish("c1", frame("还活着"));
    await settle();

    expect(seen).toHaveLength(1);
  });

  it("一个订阅者抛错，不连累别的订阅者", () => {
    const redis = fakeRedis();
    const fanout = redisFanout({
      publisher: redis.publisher,
      subscriber: redis.subscriberFor(),
      nodeId: "node-a",
    });

    const seen: Frame[] = [];
    fanout.subscribe("c1", () => {
      throw new Error("这个订阅者坏了");
    });
    fanout.subscribe("c1", (f) => seen.push(f));

    expect(() => {
      fanout.publish("c1", frame("照发"));
    }).not.toThrow();
    expect(seen).toHaveLength(1);
  });
});
