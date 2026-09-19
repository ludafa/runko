/**
 * **[挂起](../../../docs/terms.md)与[恢复](../../../docs/terms.md)对持久化的要求**——框架的恢复逻辑
 * 靠这几条成立，而普通的读写用例覆盖不到它们。设计见
 * [挂起与恢复 · 技术方案](../../../docs/logic/orchestration/tech/suspend-resume.md) §5.4、§5.7、§9.2。
 *
 * 它们并进 `persistenceCases` 一起导出：用的是同一种 setup，而一个实现只要跑持久化用例，
 * 就该验到这几条——单独一组要消费方记得去接，漏接就是静默的覆盖缺口。
 */
import type { RunkoUIMessage } from "@runko/core";

import * as assert from "./assert.js";
import type { ConformanceCase, PersistenceConformanceSetup } from "./types.js";

/** 挂起那一轮的最后一条消息：一次停在「待审批」的调用，收尾 metadata 带 `suspended`。 */
const suspendedMessage: RunkoUIMessage = {
  id: "msg-a1",
  role: "assistant",
  parts: [
    { type: "step-start" },
    { type: "text", text: "我要推送到远端。", state: "done" },
    {
      type: "tool-bash",
      toolCallId: "call-1",
      state: "approval-requested",
      input: { command: "git push origin HEAD" },
      approval: { id: "call-1" },
    },
  ],
  metadata: {
    turn: 3,
    usage: {},
    status: "suspended",
    suspended: { callIds: ["call-1"], reason: "timeout" },
  },
};

/** 恢复轮把同一条消息原地改写后的样子：同一个 id，那次调用有了结果。 */
const resumedMessage: RunkoUIMessage = {
  ...suspendedMessage,
  parts: [
    { type: "step-start" },
    { type: "text", text: "我要推送到远端。", state: "done" },
    {
      type: "tool-bash",
      toolCallId: "call-1",
      state: "output-available",
      input: { command: "git push origin HEAD" },
      output: { exitCode: 0, stdout: "Everything up-to-date" },
      approval: { id: "call-1", approved: true },
    },
  ],
};

export const suspendResumeCases: readonly ConformanceCase<PersistenceConformanceSetup>[] = [
  {
    name: "挂起恢复 · 悬空调用原样往返：待审批的部件与 suspended 收尾 metadata 读回来一字不差",
    async run(setup) {
      await setup.persistence.ledger.append({ conversationId: "c1", seq: 1, message: suspendedMessage, ts: 1 });
      const [entry] = await setup.persistence.ledger.read("c1");
      // 恢复靠读回的这条判「哪次调用还悬着」、拿原封不动的参数去执行。差一个字段就恢复错了。
      assert.equal(entry?.message, suspendedMessage);
    },
  },
  {
    name: "挂起恢复 · 同一个消息 id 以新 seq 再追加：两行都在、按 seq 排、各是各的内容（不能按 id 去重或覆盖）",
    async run(setup) {
      await setup.persistence.ledger.append({ conversationId: "c1", seq: 1, message: suspendedMessage, ts: 1 });
      const written = await setup.persistence.ledger.append({ conversationId: "c1", seq: 2, message: resumedMessage, ts: 2 });
      assert.matches(written, { ok: true }, "同 id 的第二行写不进去");

      const entries = await setup.persistence.ledger.read("c1");
      assert.equal(
        entries.map((row) => row.seq),
        [1, 2],
      );
      assert.equal(entries[0]?.message, suspendedMessage, "第一行被改掉了——实现按消息 id 覆盖了");
      assert.equal(entries[1]?.message, resumedMessage);
      assert.same(await setup.persistence.ledger.maxSeq("c1"), 2);
    },
  },
  {
    name: "挂起恢复 · 只读账本末尾一条（afterSeq = maxSeq - 1）读到的是改写后的那一行",
    async run(setup) {
      await setup.persistence.ledger.append({ conversationId: "c1", seq: 1, message: suspendedMessage, ts: 1 });
      await setup.persistence.ledger.append({ conversationId: "c1", seq: 2, message: resumedMessage, ts: 2 });
      const maxSeq = await setup.persistence.ledger.maxSeq("c1");
      const tail = await setup.persistence.ledger.read("c1", { afterSeq: maxSeq - 1 });
      assert.length(tail, 1);
      assert.equal(tail[0]?.message, resumedMessage);
    },
  },
  {
    name: "挂起恢复 · 两个副本同时结清同一行：恰好一个成功，读回的是成功那一个的答案",
    async run(setup) {
      await setup.persistence.decisions.record({
        conversationId: "c1",
        toolCallId: "call-1",
        kind: "approval",
        toolName: "bash",
        payload: { command: "git push origin HEAD" },
        requestedAt: 1000,
      });
      const [first, second] = await Promise.all([
        setup.persistence.decisions.settle("c1", "call-1", { outcome: "allow", decidedBy: "alice", decidedAt: 2000 }),
        setup.persistence.decisions.settle("c1", "call-1", { outcome: "deny", decidedBy: "bob", message: "别推", decidedAt: 2001 }),
      ]);
      assert.equal([first, second].filter(Boolean).length, 1, "两次结清都报了成功——恢复会拿到两份互相矛盾的答案");

      const record = await setup.persistence.decisions.get("c1", "call-1");
      const winner = first ? "alice" : "bob";
      assert.same(record?.decidedBy, winner);
      assert.same(record?.outcome, first ? "allow" : "deny");
    },
  },
  {
    name: "挂起恢复 · 提问的答案原文读回：多行、中文、引号都不走样（恢复轮拿它当工具输出）",
    async run(setup) {
      const answer = '用 pnpm。\n另外："锁文件"别动，\\n 这是字面量。';
      await setup.persistence.decisions.record({
        conversationId: "c1",
        toolCallId: "call-q",
        kind: "question",
        payload: "用哪个包管理器？",
        requestedAt: 1000,
      });
      await setup.persistence.decisions.settle("c1", "call-q", { outcome: "answered", message: answer, decidedAt: 2000 });

      const record = await setup.persistence.decisions.get("c1", "call-q");
      assert.same(record?.kind, "question");
      assert.same(record?.outcome, "answered");
      assert.same(record?.message, answer);
    },
  },
];
