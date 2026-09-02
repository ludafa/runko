/**
 * 套件的形状：**一条用例就是一个 `{ name, run }`**，不是一次 `it(...)` 调用。
 *
 * 这是本包与「直接写测试」最大的区别，也是它能零依赖的原因：套件只描述**要验什么**，
 * 「怎么把它变成一个测试」是消费方的事。于是同一份用例在 vitest / jest / node:test /
 * Workers 上都能跑，本包自己不 import 任何测试框架。
 *
 * 消费方的接法固定是这么几行：
 *
 * ```ts
 * describe("我的实现", () => {
 *   for (const c of persistenceCases) {
 *     it(c.name, async () => {
 *       const setup = await makeSetup();
 *       try { await c.run(setup); } finally { await setup.cleanup?.(); }
 *     });
 *   }
 * });
 * ```
 */
import type { Arbitration, Persistence } from "@runko/agent";

/** 一条一致性用例。`run` 抛错即失败——所有测试框架都认这个。 */
export interface ConformanceCase<S> {
  /** 用例名，直接拿去当 `it()` 的标题。 */
  readonly name: string;
  run(setup: S): Promise<void>;
}

export interface PersistenceConformanceSetup {
  persistence: Persistence;
  cleanup?: () => Promise<void> | void;
}

export interface ArbitrationConformanceSetup {
  arbitration: Arbitration;
  cleanup?: () => Promise<void> | void;
}

/**
 * 多节点那两组要的额外能力。**单独一个类型、配单独一组用例**，不是把字段设成可选然后
 * 在用例里判 undefined——那样一个本该支持接管的实现忘了传 `expire`，那几条会**静默跳过**
 * 并显示绿。
 *
 * 分组换来的是**「跑了哪几组」写在消费方的代码里，看得见**：谁跑了哪几组一眼可查。
 * 它换不来编译期强制——三个数组之间没有类型层面的绑定，一个提供了 `expire` 的实现
 * 完全可以只 import `arbitrationCases`，编译照过。**这是一条靠代码评审守的纪律，
 * 不是编译器守的**。
 */
export interface MultiNodeConformanceSetup extends ArbitrationConformanceSetup {
  /** 第二个「节点」——同一个后端、不同 `holder`。 */
  other: Arbitration;
}

export interface TakeoverConformanceSetup extends MultiNodeConformanceSetup {
  /**
   * 让当前持有者**看起来死了**，好在不等真实超时的前提下测接管。
   *
   * **必须让它「持续」看起来死了。** 只把心跳时刻拨到过去是不够的：持有者还活着，
   * 它的下一拍心跳会把时刻刷回来，接管于是随机失败——库越快（真库每次往返都是毫秒级）
   * 撞上的概率越大。要么让持有者那一侧的时钟停在过去，要么真的把它的心跳停掉。
   */
  expire: (conversationId: string) => Promise<void>;
}
