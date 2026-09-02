/**
 * **[归属仲裁机制](../../../docs/terms.md)的一致性套件**，按能力分三组导出。
 *
 * 三种实现的「独占」不是同一个级别的保证（内存版与 Durable Object 是**真保证**，租约版是
 * **尽力 + 可检测**），所以这里**不是一个数组配可选字段**，而是三个数组配三种 setup 类型。
 * 消费方于是必须显式写出自己跑哪几组——**跑了什么写在它自己的代码里，看得见**，
 * 而不是漏了 `expire` 就静默跳过还显示绿。（三个数组之间没有类型绑定：少 import 一组
 * 编译照过，这条靠评审守。）
 */
import * as assert from "./assert.js";
import type {
  ArbitrationConformanceSetup,
  ConformanceCase,
  MultiNodeConformanceSetup,
  TakeoverConformanceSetup,
} from "./types.js";

/** 每次都从 0 起——账本是空的。 */
function ctx(seed = 0): { seedSeq: () => Promise<number> } {
  return { seedSeq: () => Promise.resolve(seed) };
}

/** **所有实现都要过**：抢占 / 释放 / 取号 / inspect 的基本语义。 */
export const arbitrationCases: readonly ConformanceCase<ArbitrationConformanceSetup>[] = [
  {
    name: "抢到之后 grant 是有效的，`holder` 与 `conversationId` 都对",
    async run(setup) {
      const got = await setup.arbitration.acquire("c1", ctx());
      assert.same(got.ok, true);
      if (!got.ok) {return;}
      assert.same(got.grant.conversationId, "c1");
      assert.notSame(got.grant.holder, "");
      assert.same(got.grant.valid, true);
      assert.same(got.grant.signal.aborted, false);
    },
  },
  {
    name: "同一个会话再抢一次 → busy",
    async run(setup) {
      const first = await setup.arbitration.acquire("c1", ctx());
      assert.same(first.ok, true);
      const second = await setup.arbitration.acquire("c1", ctx());
      assert.same(second.ok, false);
      if (second.ok) {return;}
      assert.same(second.reason, "busy");
    },
  },
  {
    name: "**别的会话不受影响**——独占是按会话保证的，不是按机器",
    async run(setup) {
      assert.same((await setup.arbitration.acquire("c1", ctx())).ok, true);
      assert.same((await setup.arbitration.acquire("c2", ctx())).ok, true);
    },
  },
  {
    name: "release 之后可以再抢，且 grant 失效",
    async run(setup) {
      const first = await setup.arbitration.acquire("c1", ctx());
      assert.same(first.ok, true);
      if (!first.ok) {return;}
      await first.grant.release();
      assert.same(first.grant.valid, false);
      assert.same((await setup.arbitration.acquire("c1", ctx())).ok, true);
    },
  },
  {
    name: "release 幂等",
    async run(setup) {
      const got = await setup.arbitration.acquire("c1", ctx());
      assert.same(got.ok, true);
      if (!got.ok) {return;}
      await got.grant.release();
      await got.grant.release();
      assert.same(got.grant.valid, false);
    },
  },
  {
    name: "取号从 `seedSeq` 播种，之后单调递增",
    async run(setup) {
      const got = await setup.arbitration.acquire("c1", ctx(7));
      assert.same(got.ok, true);
      if (!got.ok) {return;}
      assert.equal(await got.grant.nextSeq(), { ok: true, seq: 8 });
      assert.equal(await got.grant.nextSeq(), { ok: true, seq: 9 });
    },
  },
  {
    name: "**水位跨释放保留**——同一个会话的下一轮接着数，不回头",
    async run(setup) {
      const first = await setup.arbitration.acquire("c1", ctx(0));
      assert.same(first.ok, true);
      if (!first.ok) {return;}
      assert.equal(await first.grant.nextSeq(), { ok: true, seq: 1 });
      assert.equal(await first.grant.nextSeq(), { ok: true, seq: 2 });
      await first.grant.release();

      // 第二轮即使 `seedSeq` 报 0（账本还没写），也不能倒回去发 1——那会撞上已经发出去的号。
      const second = await setup.arbitration.acquire("c1", ctx(0));
      assert.same(second.ok, true);
      if (!second.ok) {return;}
      assert.equal(await second.grant.nextSeq(), { ok: true, seq: 3 });
    },
  },
  {
    name: "release 之后取号报 `lost_ownership`，不抛",
    async run(setup) {
      const got = await setup.arbitration.acquire("c1", ctx());
      assert.same(got.ok, true);
      if (!got.ok) {return;}
      await got.grant.release();
      assert.equal(await got.grant.nextSeq(), { ok: false, reason: "lost_ownership" });
    },
  },
  {
    name: "`inspect` 反映当下：持有中为 true，释放后为 false",
    async run(setup) {
      assert.matches(await setup.arbitration.inspect("c1"), { held: false });
      const got = await setup.arbitration.acquire("c1", ctx());
      assert.same(got.ok, true);
      if (!got.ok) {return;}
      assert.matches(await setup.arbitration.inspect("c1"), { held: true });
      await got.grant.release();
      assert.matches(await setup.arbitration.inspect("c1"), { held: false });
    },
  },
];

/** **能表达多节点的实现才跑**：两个节点抢同一个会话，只有一个赢，输的拿到赢家的 `holder`。 */
export const arbitrationMultiNodeCases: readonly ConformanceCase<MultiNodeConformanceSetup>[] = [
  {
    name: "两个节点抢同一个会话，只有一个赢；输的拿到赢家的 holder",
    async run(setup) {
      const a = await setup.arbitration.acquire("c1", ctx());
      const b = await setup.other.acquire("c1", ctx());

      const wins = [a, b].filter((r) => r.ok);
      assert.length(wins, 1);

      const loser = a.ok ? b : a;
      assert.same(loser.ok, false);
      if (loser.ok) {return;}
      // **`held_by_other` 不是错误，是「转给这个 holder」**——接入层据它转发。
      assert.defined(loser.holder);
      assert.notSame(loser.holder, "");
    },
  },
  {
    name: "一个节点释放后，另一个节点抢得到",
    async run(setup) {
      const a = await setup.arbitration.acquire("c1", ctx());
      assert.same(a.ok, true);
      if (!a.ok) {return;}
      assert.same((await setup.other.acquire("c1", ctx())).ok, false);
      await a.grant.release();
      assert.same((await setup.other.acquire("c1", ctx())).ok, true);
    },
  },
];

/**
 * **能表达超时接管的实现才跑。**
 *
 * 其中「被误判的老持有者取号一律被拒」是整个租约版**唯一真正要证明的东西**：保证不了
 * 「不发生」，只保证「发生时被拦住」。
 */
export const arbitrationTakeoverCases: readonly ConformanceCase<TakeoverConformanceSetup>[] = [
  {
    // 这条守的是审查发现的 P1：`clearStale` 若不带陈旧判据，会擦掉一个**活着的**持有者。
    // 触发路径就在框架自己身上——`recover()` 是 `listStale → clearStale → acquire`，
    // 多节点同时启动时后到的那个会把先到者刚拿到的令牌抹掉。
    name: "**`clearStale` 不能擦掉活着的持有者**（与 `release` 对称的那条）",
    async run(setup) {
      const held = await setup.arbitration.acquire("c1", ctx());
      assert.same(held.ok, true);

      // 这个会话没有陈旧标记——clearStale 打上去必须是 no-op。
      await setup.other.clearStale("c1");

      assert.matches(await setup.arbitration.inspect("c1"), { held: true });
      assert.same((await setup.other.acquire("c1", ctx())).ok, false);
      if (!held.ok) {return;}
      // 持有者照常还能取号：它的令牌没被动过。
      assert.matches(await held.grant.nextSeq(), { ok: true });
    },
  },
  {
    // 这条守的是审查发现的另一条 P1：心跳连续失败时老持有者必须**自己停手**。
    // 它同时补上了「心跳整条路径零覆盖」——此前唯一断言 `signal.aborted` 的用例，
    // abort 是 `nextSeq()` 触发的，`setInterval → beat() → lose()` 从没被跑到过。
    name: "**心跳自己发现被接管**——不用等下一次取号",
    async run(setup) {
      const a = await setup.arbitration.acquire("c1", ctx());
      assert.same(a.ok, true);
      if (!a.ok) {return;}

      await setup.expire("c1");
      assert.same((await setup.other.acquire("c1", ctx())).ok, true);

      // **不调 `nextSeq`**：等心跳自己发现。给它几拍的时间。
      const deadline = Date.now() + 3_000;
      while (!a.grant.signal.aborted && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.same(a.grant.signal.aborted, true, "心跳应该自己把老持有者停下来");
      assert.same(a.grant.valid, false);
    },
  },
  {
    name: "持有者停跳之后，另一个节点能接管",
    async run(setup) {
      const a = await setup.arbitration.acquire("c1", ctx());
      assert.same(a.ok, true);
      assert.same((await setup.other.acquire("c1", ctx())).ok, false);

      await setup.expire("c1");
      assert.same((await setup.other.acquire("c1", ctx())).ok, true);
    },
  },
  {
    name: "**被误判的老持有者，取号一律被拒**（这条是核心）",
    async run(setup) {
      const a = await setup.arbitration.acquire("c1", ctx());
      assert.same(a.ok, true);
      if (!a.ok) {return;}
      assert.equal(await a.grant.nextSeq(), { ok: true, seq: 1 });

      // A 只是**联系不上**，并没有死——它还会继续尝试写。
      await setup.expire("c1");
      const b = await setup.other.acquire("c1", ctx());
      assert.same(b.ok, true);

      // 保证不了「A 不再尝试」，只保证「A 一尝试就被拦住」。
      assert.equal(await a.grant.nextSeq(), { ok: false, reason: "lost_ownership" });
      assert.same(a.grant.valid, false);
      assert.same(a.grant.signal.aborted, true);
    },
  },
  {
    name: "老持有者的 release 不会擦掉新持有者的租约",
    async run(setup) {
      const a = await setup.arbitration.acquire("c1", ctx());
      assert.same(a.ok, true);
      if (!a.ok) {return;}
      await setup.expire("c1");
      const b = await setup.other.acquire("c1", ctx());
      assert.same(b.ok, true);

      // A 醒过来，照常走它的收尾——**不能把 B 的归属放掉**。
      await a.grant.release();
      assert.matches(await setup.arbitration.inspect("c1"), { held: true });
      assert.same((await setup.arbitration.acquire("c1", ctx())).ok, false);
    },
  },
  {
    name: "接管之后新持有者继续发号，不与老持有者发过的撞",
    async run(setup) {
      const a = await setup.arbitration.acquire("c1", ctx(0));
      assert.same(a.ok, true);
      if (!a.ok) {return;}
      assert.equal(await a.grant.nextSeq(), { ok: true, seq: 1 });
      assert.equal(await a.grant.nextSeq(), { ok: true, seq: 2 });

      await setup.expire("c1");
      const b = await setup.other.acquire("c1", ctx(0));
      assert.same(b.ok, true);
      if (!b.ok) {return;}
      // 即使 `seedSeq` 报 0，也必须接着 2 往后发。
      assert.equal(await b.grant.nextSeq(), { ok: true, seq: 3 });
    },
  },
  {
    // **从 `other` 那一侧扫**，不从持有者自己那一侧。这才是这个接口的真实场景：
    // 一个节点崩了，**另一个**节点开机时扫出它留下的孤儿标记。持有者自己扫自己，
    // 在「让它看起来死了」这件事上还得跟自己的心跳打架（见 `expire` 的注释）。
    name: "`listStale` 扫得到停跳的，`clearStale` 之后扫不到",
    async run(setup) {
      const a = await setup.arbitration.acquire("c1", ctx());
      assert.same(a.ok, true);
      assert.equal(await setup.other.listStale(), []);

      await setup.expire("c1");
      const stale = await setup.other.listStale();
      assert.contains(stale.map((s) => s.conversationId), "c1");

      await setup.other.clearStale("c1");
      assert.notContains((await setup.other.listStale()).map((s) => s.conversationId), "c1");
      // 清完之后这个会话是自由的。
      assert.same((await setup.other.acquire("c1", ctx())).ok, true);
    },
  },
];
