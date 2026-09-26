/**
 * **[节点登记表](../../../docs/terms.md)的一致性套件。**
 *
 * 语义见 `@runko/agent` 的 `NodeRegistry` 接口注释，尤其是 `candidates()` 那段——两档
 * 排序（发布序号严格大于 self 的在前、等于的在后，更小的整档不要）、同档按 `load` 升序。
 */
import * as assert from "./assert.js";
import type { ConformanceCase, NodeRegistryConformanceSetup } from "./types.js";

/** 用例统一站在这个「自己」的视角挑候选。 */
const SELF = { node: "self", releaseSeq: 5 };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const nodeRegistryCases: readonly ConformanceCase<NodeRegistryConformanceSetup>[] = [
  {
    name: "候选按发布序号分两档：更大的在前，相同的在后",
    async run(setup) {
      await setup.registry.register({ node: "newer", releaseSeq: SELF.releaseSeq + 1 });
      await setup.registry.register({ node: "same", releaseSeq: SELF.releaseSeq });
      const candidates = await setup.registry.candidates(SELF, { freshMs: 60_000 });
      assert.equal(candidates.map((c) => c.node), ["newer", "same"]);
    },
  },
  {
    name: "更小的发布序号不算候选——那是还没被替换的旧版本，交给它等于再迁一次",
    async run(setup) {
      await setup.registry.register({ node: "older", releaseSeq: SELF.releaseSeq - 1 });
      const candidates = await setup.registry.candidates(SELF, { freshMs: 60_000 });
      assert.notContains(candidates.map((c) => c.node), "older");
    },
  },
  {
    name: "leaving 状态不算候选",
    async run(setup) {
      await setup.registry.register({ node: "leaving-node", releaseSeq: SELF.releaseSeq });
      await setup.registry.markLeaving("leaving-node");
      const candidates = await setup.registry.candidates(SELF, { freshMs: 60_000 });
      assert.notContains(candidates.map((c) => c.node), "leaving-node");
    },
  },
  {
    name: "心跳超过 freshMs 不算候选",
    async run(setup) {
      await setup.registry.register({ node: "stale-node", releaseSeq: SELF.releaseSeq });
      await sleep(60);
      const candidates = await setup.registry.candidates(SELF, { freshMs: 20 });
      assert.notContains(candidates.map((c) => c.node), "stale-node");
    },
  },
  {
    name: "自己不算候选",
    async run(setup) {
      await setup.registry.register(SELF);
      const candidates = await setup.registry.candidates(SELF, { freshMs: 60_000 });
      assert.notContains(candidates.map((c) => c.node), SELF.node);
    },
  },
  {
    name: "同档按 load 升序——持有对话越少的排越前",
    async run(setup) {
      await setup.registry.register({ node: "busy", releaseSeq: SELF.releaseSeq });
      await setup.registry.register({ node: "idle", releaseSeq: SELF.releaseSeq });
      await setup.acquireLoad("busy", 3);

      const candidates = await setup.registry.candidates(SELF, { freshMs: 60_000 });
      const names = candidates.filter((c) => c.node === "busy" || c.node === "idle").map((c) => c.node);
      assert.equal(names, ["idle", "busy"]);

      const busy = candidates.find((c) => c.node === "busy");
      const idle = candidates.find((c) => c.node === "idle");
      assert.same(busy?.load, 3);
      assert.same(idle?.load, 0);
    },
  },
  {
    name: "heartbeat 只改心跳，不改状态——leaving 心跳之后还是 leaving",
    async run(setup) {
      await setup.registry.register({ node: "n1", releaseSeq: SELF.releaseSeq });
      await setup.registry.markLeaving("n1");
      await setup.registry.heartbeat("n1");

      const row = (await setup.registry.list()).find((r) => r.node === "n1");
      assert.same(row?.state, "leaving");
    },
  },
  {
    name: "register 把 leaving 改回 ready——重新上线",
    async run(setup) {
      await setup.registry.register({ node: "n1", releaseSeq: SELF.releaseSeq });
      await setup.registry.markLeaving("n1");
      await setup.registry.register({ node: "n1", releaseSeq: SELF.releaseSeq + 1 });

      const row = (await setup.registry.candidates(SELF, { freshMs: 60_000 })).find((c) => c.node === "n1");
      assert.defined(row, "重新 register 之后应当出现在候选里——状态已经改回 ready");
      assert.same(row.state, "ready");
    },
  },
  {
    name: "remove 删掉这一行",
    async run(setup) {
      await setup.registry.register({ node: "n1", releaseSeq: SELF.releaseSeq });
      await setup.registry.remove("n1");
      assert.equal((await setup.registry.list()).map((r) => r.node), []);
    },
  },
  {
    name: "list 返回全部登记的节点",
    async run(setup) {
      await setup.registry.register({ node: "a", releaseSeq: 1 });
      await setup.registry.register({ node: "b", releaseSeq: 2 });
      const nodes = (await setup.registry.list()).map((r) => r.node).sort();
      assert.equal(nodes, ["a", "b"]);
    },
  },
];
