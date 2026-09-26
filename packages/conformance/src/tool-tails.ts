/**
 * **[工具收尾](../../../docs/terms.md)记录的一致性套件。**
 *
 * 语义见 `@runko/agent` 的 `ToolTailStore` 接口注释：`begin` 幂等，`complete` 只在结果
 * 还空着时写得进（迟到的结果写不进去），`requestStop` 同理，`get` 把「缺席」翻译成
 * 「键不出现」而不是「键在、值是 undefined」。
 */
import * as assert from "./assert.js";
import type { ConformanceCase, ToolTailConformanceSetup } from "./types.js";

const RECORD = {
  conversationId: "c1",
  toolCallId: "call-1",
  toolName: "bash",
  runner: "node-a",
  startedAt: 1000,
  deadline: 5000,
};

export const toolTailCases: readonly ConformanceCase<ToolTailConformanceSetup>[] = [
  {
    name: "begin 幂等——重复登记不报错、不覆盖已有信息",
    async run(setup) {
      assert.equal(await setup.tails.begin(RECORD), { ok: true });
      assert.equal(await setup.tails.begin({ ...RECORD, toolName: "别的名字", runner: "node-b" }), { ok: true });

      const record = await setup.tails.get("c1", "call-1");
      assert.same(record?.toolName, "bash", "重复登记不该覆盖第一次的 toolName");
      assert.same(record?.runner, "node-a", "重复登记不该覆盖第一次的 runner");
    },
  },
  {
    name: "complete 只成功一次——迟到的第二次返回 false，不覆盖第一次的结果",
    async run(setup) {
      await setup.tails.begin(RECORD);
      const first = await setup.tails.complete("c1", "call-1", { kind: "output", output: { exitCode: 0 } }, 2000);
      assert.same(first, true);

      const late = await setup.tails.complete("c1", "call-1", { kind: "error", errorText: "太晚了" }, 3000);
      assert.same(late, false);

      const record = await setup.tails.get("c1", "call-1");
      assert.equal(record?.outcome, { kind: "output", output: { exitCode: 0 } });
      assert.same(record?.settledAt, 2000);
    },
  },
  {
    name: "complete 对不存在的行返回 false，不抛",
    async run(setup) {
      assert.same(await setup.tails.complete("c1", "从未登记过", { kind: "output", output: null }, 1), false);
    },
  },
  {
    name: "requestStop 在还没有结果时返回 true，get 能看到 stopRequested",
    async run(setup) {
      await setup.tails.begin(RECORD);
      assert.same(await setup.tails.requestStop("c1", "call-1"), true);
      assert.same((await setup.tails.get("c1", "call-1"))?.stopRequested, true);
    },
  },
  {
    name: "requestStop 在已经有结果之后返回 false——结果已经落地，停止请求没有意义",
    async run(setup) {
      await setup.tails.begin(RECORD);
      await setup.tails.complete("c1", "call-1", { kind: "output", output: null }, 2000);
      assert.same(await setup.tails.requestStop("c1", "call-1"), false);
    },
  },
  {
    name: "requestStop 对不存在的行返回 false，不抛",
    async run(setup) {
      assert.same(await setup.tails.requestStop("c1", "从未登记过"), false);
    },
  },
  {
    name: "get 翻译正确：还没结果的行 outcome/settledAt 缺席（不是出现一个 undefined 值）",
    async run(setup) {
      await setup.tails.begin(RECORD);
      const record = await setup.tails.get("c1", "call-1");
      assert.defined(record, "刚登记的那一行读不回来");
      assert.same("outcome" in record, false, "还没有结果的行不该带 outcome 键");
      assert.same("settledAt" in record, false, "还没有结果的行不该带 settledAt 键");
      assert.same(record.stopRequested, false);
      assert.same(record.toolName, "bash");
      assert.same(record.runner, "node-a");
      assert.same(record.startedAt, 1000);
      assert.same(record.deadline, 5000);
    },
  },
  {
    name: "get 对不存在的行返回 undefined，不抛",
    async run(setup) {
      assert.same(await setup.tails.get("c1", "从未登记过"), undefined);
    },
  },
  {
    name: "结清之后 get 带回 outcome 与 settledAt",
    async run(setup) {
      await setup.tails.begin(RECORD);
      await setup.tails.complete("c1", "call-1", { kind: "error", errorText: "工具挂了" }, 2500);
      const record = await setup.tails.get("c1", "call-1");
      assert.equal(record?.outcome, { kind: "error", errorText: "工具挂了" });
      assert.same(record?.settledAt, 2500);
    },
  },
  {
    // 守住「complete 回读后用结构比较，不看键序」这条：Postgres 的 jsonb / MySQL 的 json
    // 落盘时会重排对象的键，键序与字母序刻意都不一样（`stdout` 排在 `exitCode` 前面，
    // 嵌套对象 `meta` 里 `z` 排在 `a` 前面），一个只按 `JSON.stringify` 字符串比较的实现
    // 会在这条上把「写成功了」误判成 false。
    name: "多键对象、键序打乱也能 complete 成功、get 读回来深相等",
    async run(setup) {
      const record = { ...RECORD, conversationId: "c-jsonb", toolCallId: "call-jsonb" };
      await setup.tails.begin(record);
      const outcome = { kind: "output" as const, output: { stdout: "x", exitCode: 0, meta: { z: 1, a: 2 } } };
      const ok = await setup.tails.complete("c-jsonb", "call-jsonb", outcome, 4000);
      assert.same(ok, true, "多键对象 complete 不该因为键序被重排而误判失败");

      const got = await setup.tails.get("c-jsonb", "call-jsonb");
      assert.equal(got?.outcome, outcome);
    },
  },
];
