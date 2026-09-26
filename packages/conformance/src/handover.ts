/**
 * **[交接预留 / 待接手 / 定时回捞](../../../docs/terms.md)的一致性套件。**
 *
 * 只对实现了整套可选的交权方法（`Grant.releaseTo`、`Arbitration.markAwaitingTakeover` /
 * `clearAwaitingTakeover` / `listSweepCandidates`）的实现成立——跟 `arbitrationTakeoverCases`
 * 一样单独成组，接口注释里写明这几个方法「要么都实现、要么都不实现」，所以这里一律用
 * `assert.defined` 当场钉住，而不是悄悄 `?.` 跳过。
 */
import * as assert from "./assert.js";
import type { ConformanceCase, HandoverConformanceSetup } from "./types.js";

function ctx(seed = 0): { seedSeq: () => Promise<number> } {
  return { seedSeq: () => Promise.resolve(seed) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const handoverCases: readonly ConformanceCase<HandoverConformanceSetup>[] = [
  {
    name: "预留期内：只有被预留的节点抢得到，别人拿到 busy 且 holder 是被预留者",
    async run(setup) {
      const got = await setup.arbitration.acquire("c1", ctx());
      assert.same(got.ok, true);
      if (!got.ok) {return;}
      assert.defined(got.grant.releaseTo, "这组用例要求实现 Grant.releaseTo");
      await got.grant.releaseTo(setup.otherNode, { ttlMs: 5_000 });

      // `self` 不是被预留者，跟任何第三方一样该被挡住。
      const bySelf = await setup.arbitration.acquire("c1", ctx());
      assert.same(bySelf.ok, false);
      if (bySelf.ok) {return;}
      assert.same(bySelf.reason, "busy");
      assert.same(bySelf.holder, setup.otherNode);

      // 被预留者照常抢得到。
      const byOther = await setup.other.acquire("c1", ctx());
      assert.same(byOther.ok, true);
    },
  },
  {
    name: "inspect 在预留期内报被预留者，且带上 reserved: true——没人真持有，只是预留",
    async run(setup) {
      const got = await setup.arbitration.acquire("c1", ctx());
      assert.same(got.ok, true);
      if (!got.ok) {return;}

      // 真持有时不该出现 `reserved: true`——这个字段专门用来分辨「没人真持有，只是预留」。
      const whileHeld = await setup.arbitration.inspect("c1");
      assert.same(whileHeld.reserved === true, false, "真持有时不该报 reserved: true");

      assert.defined(got.grant.releaseTo);
      await got.grant.releaseTo(setup.otherNode, { ttlMs: 5_000 });

      assert.matches(await setup.arbitration.inspect("c1"), {
        held: true,
        holder: setup.otherNode,
        reserved: true,
      });
    },
  },
  {
    name: "预留过期之后退化成谁都能抢——不再限定被预留者",
    async run(setup) {
      const got = await setup.arbitration.acquire("c1", ctx());
      assert.same(got.ok, true);
      if (!got.ok) {return;}
      assert.defined(got.grant.releaseTo);
      // 很短的 ttl + 真 sleep：等它自己过期，不靠 setup 提供额外的时钟钩子。
      await got.grant.releaseTo(setup.otherNode, { ttlMs: 20 });
      await sleep(100);

      const bySelf = await setup.arbitration.acquire("c1", ctx());
      assert.same(bySelf.ok, true, "预留过期之后，不是被预留者的一方也该抢得到");
    },
  },
  {
    name: "被预留者抢到之后，预留被消费——它 release 之后别人能抢",
    async run(setup) {
      const got = await setup.arbitration.acquire("c1", ctx());
      assert.same(got.ok, true);
      if (!got.ok) {return;}
      assert.defined(got.grant.releaseTo);
      await got.grant.releaseTo(setup.otherNode, { ttlMs: 5_000 });

      const byOther = await setup.other.acquire("c1", ctx());
      assert.same(byOther.ok, true);
      if (!byOther.ok) {return;}
      await byOther.grant.release();

      // 预留早在被预留者抢到的那一刻就该被消费掉了——现在谁都能抢，不会因为预留
      // 还没过期而继续把不是被预留者的一方挡在外面。
      const bySelf = await setup.arbitration.acquire("c1", ctx());
      assert.same(bySelf.ok, true);
    },
  },
  {
    name: "grant 已经失效时，releaseTo 不产生预留——跟 release 一样，只在还持有时生效",
    async run(setup) {
      const got = await setup.arbitration.acquire("c1", ctx());
      assert.same(got.ok, true);
      if (!got.ok) {return;}
      assert.defined(got.grant.releaseTo);
      await got.grant.release();

      // 已经失效——再调 releaseTo 应当是 no-op，不留下任何预留。
      await got.grant.releaseTo(setup.otherNode, { ttlMs: 5_000 });

      const bySelf = await setup.arbitration.acquire("c1", ctx());
      assert.same(bySelf.ok, true, "没有留下预留的话，不是 otherNode 的一方也该抢得到");
    },
  },
  {
    name: "待接手打标之后出现在回捞候选里，撤标之后不在",
    async run(setup) {
      assert.defined(setup.arbitration.markAwaitingTakeover, "这组用例要求待接手三件套一起实现");
      assert.defined(setup.arbitration.clearAwaitingTakeover);
      assert.defined(setup.arbitration.listSweepCandidates);

      await setup.arbitration.markAwaitingTakeover("c-sweep-1");
      assert.contains(await setup.arbitration.listSweepCandidates({ limit: 10 }), "c-sweep-1");

      await setup.arbitration.clearAwaitingTakeover("c-sweep-1");
      assert.notContains(await setup.arbitration.listSweepCandidates({ limit: 10 }), "c-sweep-1");
    },
  },
  {
    name: "有活着的持有者时不在回捞候选里——就算打了待接手标记",
    async run(setup) {
      assert.defined(setup.arbitration.markAwaitingTakeover);
      assert.defined(setup.arbitration.listSweepCandidates);

      const got = await setup.arbitration.acquire("c-sweep-2", ctx());
      assert.same(got.ok, true);
      await setup.arbitration.markAwaitingTakeover("c-sweep-2");

      assert.notContains(await setup.arbitration.listSweepCandidates({ limit: 10 }), "c-sweep-2");
    },
  },
  {
    name: "有有效预留时不在回捞候选里——指定交接优先，定时回捞不跟它抢",
    async run(setup) {
      assert.defined(setup.arbitration.markAwaitingTakeover);
      assert.defined(setup.arbitration.listSweepCandidates);

      const got = await setup.arbitration.acquire("c-sweep-3", ctx());
      assert.same(got.ok, true);
      if (!got.ok) {return;}
      assert.defined(got.grant.releaseTo);
      await got.grant.releaseTo(setup.otherNode, { ttlMs: 5_000 });
      await setup.arbitration.markAwaitingTakeover("c-sweep-3");

      assert.notContains(await setup.arbitration.listSweepCandidates({ limit: 10 }), "c-sweep-3");
    },
  },
  {
    // 队列不空不等于卡住——在等人答复、按设计排着后续消息的对话，队列也不空，但永远推不动。
    // 回捞候选只认待接手标记，不认队列，否则这类对话会占满每次的 limit，挤掉真正卡住的那些。
    name: "待发队列不空，但没打待接手标记 → 不出现在回捞候选里",
    async run(setup) {
      assert.defined(setup.arbitration.listSweepCandidates);
      // 没提供持久化的实现跳过这条——不是「假装测过」，是这条用例本来就依赖它。
      if (setup.persistence === undefined) {return;}

      await setup.persistence.queue.enqueue("c-sweep-4", { text: "还没发出去" }, { max: 5, onFull: "reject" });
      assert.notContains(await setup.arbitration.listSweepCandidates({ limit: 10 }), "c-sweep-4");
    },
  },
  {
    // 守住「打标记时垫的水位必须能让 acquire 认出还没播种」这条：如果错误地把它垫成了
    // 合法的 0，acquire 会以为已经播种过、跳过 seedSeq()，发号从 1 开始，跟账本里已有的
    // seq 撞车。
    name: "先打待接手标记（会话此前不存在），账本里已有 3 条 → acquire 之后 nextSeq 从 4 开始",
    async run(setup) {
      assert.defined(setup.arbitration.markAwaitingTakeover, "这组用例要求待接手三件套一起实现");
      await setup.arbitration.markAwaitingTakeover("c-watermark");

      const got = await setup.arbitration.acquire("c-watermark", ctx(3));
      assert.same(got.ok, true);
      if (!got.ok) {return;}
      assert.equal(await got.grant.nextSeq(), { ok: true, seq: 4 });
    },
  },
];
