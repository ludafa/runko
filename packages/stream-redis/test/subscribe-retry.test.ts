/**
 * **后台那次 `SUBSCRIBE` 失败之后会怎样**——退避重试、收尾、以及两条只有在「订阅还在飞」
 * 时才走得到的路径。
 *
 * 为什么这件事值得单开一个文件：node-redis 只在 `subscribe` 的 promise **resolve 之后**
 * 才把监听器记进自己的 pub-sub 表，reject 那条路什么都不记。所以一次失败如果不重试，
 * 这个会话就**永久**收不到别的副本发来的帧，而且没有任何告警——直播看着「就是不动」。
 * 这里的每条用例都是在钉住「这种永久哑掉不会发生」。
 *
 * 全文件用假定时器。两个坑写在 `flush` 的注释里。
 */
import type { Frame } from "@runko/agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { redisFanout } from "../src/index.js";
import { fakeRedis, frame } from "./fake-redis.js";

/** 会话 `c1` 对应的频道名。 */
const CHANNEL = "runko:stream:c1";

/**
 * 把已经排好的微任务跑完，但**一点时间都不推进**。
 *
 * 两个坑，踩了会写出假绿的用例：
 * ① `subscribe` 的 reject 是在**微任务**里被观察到的，重试定时器在那之后才排上。不先
 *    flush 就去数定时器，看到的是「一个都没有」，断言 `getTimerCount() === 0` 会假绿。
 * ② `fanout.test.ts` 里那个 `settle()` 用的是真 `setTimeout(0)`，开了假定时器它永远不会
 *    自己 resolve，这个文件里不能用。
 */
const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

/** 推进假时钟，顺带把这段时间里排上的微任务也跑完。 */
const advance = async (ms: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};

describe("redisFanout · 订阅失败重试", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("订上之前失败了会退避重试；**重试成功之后，别的副本发的帧就收得到了**", async () => {
    const redis = fakeRedis();
    redis.breakSubscribe(1); // 头一次 SUBSCRIBE 失败，之后正常
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
    b.subscribe("c1", (f) => {
      seen.push(f);
    });
    await flush();
    expect(redis.subscribeCalls()).toBe(1);

    // 重试落地**之前**发的这一帧收不到。契约允许丢（客户端重连时从账本回放补），
    // 这条断言是在钉住这个边界，不是在期待它能收到。
    a.publish("c1", frame("重试落地之前"));
    await flush();
    expect(seen).toHaveLength(0);

    // 第一次退避正好是 200ms：差 1ms 都还没重试。
    await advance(199);
    expect(redis.subscribeCalls()).toBe(1);
    await advance(1);
    expect(redis.subscribeCalls()).toBe(2);

    // 守的就是这一条：不重试的话，这个会话到死都收不到远端帧。
    a.publish("c1", frame("重试落地之后"));
    await flush();
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(seen[0])).toContain("重试落地之后");
  });

  it("退避节奏：200ms 起步、每失败一次翻倍、封顶 5s", async () => {
    const redis = fakeRedis();
    redis.breakSubscribe(Number.POSITIVE_INFINITY); // 一直订不上
    const fanout = redisFanout({
      publisher: redis.publisher,
      subscriber: redis.subscriberFor(),
      nodeId: "node-a",
    });

    fanout.subscribe("c1", () => undefined);
    await flush();
    expect(redis.subscribeCalls()).toBe(1);

    // 守的是「等待时间不会失控」：既不会退化成毫秒级死循环把 Redis 打爆，
    // 也不会越翻越久（第 10 次就是 100 秒）让人等不到恢复。
    let attempts = 1;
    for (const delay of [200, 400, 800, 1600, 3200, 5000, 5000]) {
      await advance(delay - 1);
      expect(redis.subscribeCalls()).toBe(attempts);
      await advance(1);
      attempts += 1;
      expect(redis.subscribeCalls()).toBe(attempts);
    }
  });

  it("一直订不上、最后一个监听器又退订了：**定时器清干净、不再重试**", async () => {
    const redis = fakeRedis();
    redis.breakSubscribe(Number.POSITIVE_INFINITY);
    const fanout = redisFanout({
      publisher: redis.publisher,
      subscriber: redis.subscriberFor(),
      nodeId: "node-a",
    });

    const stop = fanout.subscribe("c1", () => undefined);
    await flush();
    expect(vi.getTimerCount()).toBe(1);

    await advance(200); // 第二次也失败，又排一个
    expect(vi.getTimerCount()).toBe(1);
    const callsBeforeStop = redis.subscribeCalls();
    expect(callsBeforeStop).toBe(2);

    stop();

    // 守两件事：① 没有定时器留着白重试——留着还会吊住 Node 进程不退出（进程收到关闭
    // 信号后迟迟不走）；② 再等多久都不会再发 SUBSCRIBE，没人看的会话不该继续占 Redis。
    expect(vi.getTimerCount()).toBe(0);
    await advance(10_000);
    expect(redis.subscribeCalls()).toBe(callsBeforeStop);
  });

  it("退订正好卡在一次 SUBSCRIBE 在飞的时候：**这次订上了要补发 UNSUBSCRIBE**", async () => {
    const redis = fakeRedis();
    const held = redis.holdNextSubscribe(); // 把这次 SUBSCRIBE 扣在半空中
    const fanout = redisFanout({
      publisher: redis.publisher,
      subscriber: redis.subscriberFor(),
      nodeId: "node-a",
    });

    const stop = fanout.subscribe("c1", () => undefined);
    await flush();
    expect(redis.subscribeCalls()).toBe(1);

    // 还在飞的时候，最后一个监听器走了。
    stop();
    expect(redis.unsubscribed).toEqual([]); // 这会儿还没订上，没什么可撤的

    held.succeed(); // 请求这才落地，而且是成功
    await flush();

    // 守的是：Redis 上不能留一个没人看的订阅。留着的话，这个进程会一直收别的副本推来的
    // 帧（白解析、白丢弃），而且永远不会有人去撤它。
    expect(redis.unsubscribed).toEqual([CHANNEL]);
    expect(redis.channelCount()).toBe(0);
  });

  it("退订卡在 SUBSCRIBE 在飞的时候：**这次失败了就别再排重试**", async () => {
    const redis = fakeRedis();
    const held = redis.holdNextSubscribe();
    const fanout = redisFanout({
      publisher: redis.publisher,
      subscriber: redis.subscriberFor(),
      nodeId: "node-a",
    });

    const stop = fanout.subscribe("c1", () => undefined);
    await flush();

    stop();
    held.fail(); // 在飞的那次落地时才失败，此时已经没人在看了
    await flush();

    // 守的是：重试的意义是「本地还有人等远端帧」。没人等了还重试，就是一个没人能停下的
    // 后台循环——会话早结束了，它还在按退避节奏敲 Redis。
    expect(vi.getTimerCount()).toBe(0);
    await advance(10_000);
    expect(redis.subscribeCalls()).toBe(1);
  });

  it("从没订上就退订：**不发 UNSUBSCRIBE**（没有什么要撤的）", async () => {
    const redis = fakeRedis();
    redis.breakSubscribe(Number.POSITIVE_INFINITY);
    const fanout = redisFanout({
      publisher: redis.publisher,
      subscriber: redis.subscriberFor(),
      nodeId: "node-a",
    });

    const stop = fanout.subscribe("c1", () => undefined);
    await flush();
    stop();
    await flush();

    // 守的是：对一个从没订上的频道发 UNSUBSCRIBE 不只是白跑一趟——订阅连接上每多一条
    // 命令就多一次可能失败、多一行告警，把真正的问题埋掉。
    expect(redis.unsubscribed).toEqual([]);
  });

  it("⚠️ 两个实例用同一个 nodeId：互相收不到——**每个进程的 nodeId 必须唯一**", async () => {
    const redis = fakeRedis();
    // 这条是**警告性**用例，不是在肯定这种配置。redisFanout 靠 nodeId 认出「这条是我自己
    // 发的」并丢掉，否则本进程的订阅者会收到两遍（见 fanout.test.ts「自己发的帧只收一遍」）。
    // 两个进程共用一个 nodeId，各自就会把**对方**发的也当成自己发的丢掉：直播静悄悄地
    // 半瘫——不报错、日志里什么都没有，只是有些帧永远不到。
    // 部署时给每个副本各自可达的地址当 nodeId（与租约里的 holder 同一个值最省事）。
    const a = redisFanout({
      publisher: redis.publisher,
      subscriber: redis.subscriberFor(),
      nodeId: "same-node",
    });
    const b = redisFanout({
      publisher: redis.publisher,
      subscriber: redis.subscriberFor(),
      nodeId: "same-node",
    });

    const seenOnB: Frame[] = [];
    b.subscribe("c1", (f) => {
      seenOnB.push(f);
    });
    await flush();

    a.publish("c1", frame("A 在跑这一轮"));
    await flush();

    expect(seenOnB).toHaveLength(0);
  });
});
