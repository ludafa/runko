/**
 * **[持久化](../../../docs/terms.md)的一致性套件**——31 条，把接口注释里写死却没验过的
 * 承诺变成可执行断言。五个官方实现跑的是同一份；第三方实现装上这个包也能跑。
 */
import type { RunkoUIMessage } from "@runko/core";

import * as assert from "./assert.js";
import type { ConformanceCase, PersistenceConformanceSetup } from "./types.js";

function message(id: string, text: string): RunkoUIMessage {
  return { id, role: "assistant", parts: [{ type: "text", text }] };
}

/** 裁决表那一组共用的一条待定记录。 */
const pending = {
  conversationId: "c1",
  toolCallId: "call-1",
  kind: "approval" as const,
  toolName: "bash",
  payload: { command: "rm -rf build" },
  requestedAt: 1000,
};

/** 队列那一组共用的入队选项——上限 3、满了就拒。 */
const opts = { max: 3, onFull: "reject" as const };

export const persistenceCases: readonly ConformanceCase<PersistenceConformanceSetup>[] = [
  {
    name: "append 之后 read 读得回来，且按 seq 升序",
    async run(setup) {
      // 刻意乱序写入——「按 seq 升序」是读的承诺，不是写的顺序。
      await setup.persistence.ledger.append({ conversationId: "c1", seq: 3, message: message("m3", "三"), ts: 300 });
      await setup.persistence.ledger.append({ conversationId: "c1", seq: 1, message: message("m1", "一"), ts: 100 });
      await setup.persistence.ledger.append({ conversationId: "c1", seq: 2, message: message("m2", "二"), ts: 200 });

      const entries = await setup.persistence.ledger.read("c1");
      assert.equal(entries.map((e) => e.seq), [1, 2, 3]);
      assert.equal(entries.map((e) => e.message.id), ["m1", "m2", "m3"]);
      assert.same(entries[0]?.ts, 100);
    },
  },
  {
    name: "message 原样往返（JSON 列的序列化边界）",
    async run(setup) {
      const original: RunkoUIMessage = {
        id: "m1",
        role: "assistant",
        parts: [{ type: "text", text: "带 emoji 😀 与「引号」和 \\ 反斜杠" }],
        metadata: { turn: 7, status: "completed", usage: { totalTokens: 42 } },
      };
      await setup.persistence.ledger.append({ conversationId: "c1", seq: 1, message: original, ts: 1 });
      const [entry] = await setup.persistence.ledger.read("c1");
      assert.equal(entry?.message, original);
    },
  },
  {
    name: "同 (conversationId, seq) 重复写入不得写出两行",
    async run(setup) {
      await setup.persistence.ledger.append({ conversationId: "c1", seq: 1, message: message("m1", "先"), ts: 1 });
      // 契约允许「幂等或被拒」两种处置，但**不得写出两行**——这才是要守的不变量。
      await setup.persistence.ledger.append({ conversationId: "c1", seq: 1, message: message("m1b", "后"), ts: 2 });

      const entries = await setup.persistence.ledger.read("c1");
      assert.length(entries, 1);
    },
  },
  {
    name: "read({ afterSeq }) 不含自身",
    async run(setup) {
      for (const seq of [1, 2, 3]) {
        await setup.persistence.ledger.append({ conversationId: "c1", seq, message: message(`m${String(seq)}`, "x"), ts: seq });
      }
      const entries = await setup.persistence.ledger.read("c1", { afterSeq: 2 });
      assert.equal(entries.map((e) => e.seq), [3]);
    },
  },
  {
    name: "seq 允许有空洞——占了号没写成，读写都不受影响",
    async run(setup) {
      await setup.persistence.ledger.append({ conversationId: "c1", seq: 1, message: message("m1", "x"), ts: 1 });
      // seq 2 被占号但从未写入（起轮失败/写入被拒），直接跳到 5。
      await setup.persistence.ledger.append({ conversationId: "c1", seq: 5, message: message("m5", "x"), ts: 5 });

      assert.equal((await setup.persistence.ledger.read("c1")).map((e) => e.seq), [1, 5]);
      assert.same(await setup.persistence.ledger.maxSeq("c1"), 5);
      assert.equal((await setup.persistence.ledger.read("c1", { afterSeq: 1 })).map((e) => e.seq), [5]);
    },
  },
  {
    name: "maxSeq 对空会话返回 0",
    async run(setup) {
      assert.same(await setup.persistence.ledger.maxSeq("从未存在过"), 0);
    },
  },
  {
    name: "账本 · 会话之间互不串",
    async run(setup) {
      await setup.persistence.ledger.append({ conversationId: "c1", seq: 1, message: message("a", "x"), ts: 1 });
      await setup.persistence.ledger.append({ conversationId: "c2", seq: 1, message: message("b", "x"), ts: 1 });

      assert.equal((await setup.persistence.ledger.read("c1")).map((e) => e.message.id), ["a"]);
      assert.equal((await setup.persistence.ledger.read("c2")).map((e) => e.message.id), ["b"]);
    },
  },
  {
    name: "空会话 read 返回空数组，不抛",
    async run(setup) {
      assert.equal(await setup.persistence.ledger.read("从未存在过"), []);
    },
  },
  {
    name: "record 之后进 listPending，settle 之后出 listPending",
    async run(setup) {
      await setup.persistence.decisions.record(pending);
      assert.equal((await setup.persistence.decisions.listPending("c1")).map((d) => d.toolCallId), ["call-1"]);

      const settled = await setup.persistence.decisions.settle("c1", "call-1", {
        outcome: "allow",
        scope: "conversation",
        decidedBy: "u1",
        decidedAt: 2000,
      });
      assert.same(settled, true);
      assert.equal(await setup.persistence.decisions.listPending("c1"), []);
    },
  },
  {
    name: "待定项带回 toolName 与 payload（挂起恢复要拿原封不动的参数）",
    async run(setup) {
      await setup.persistence.decisions.record(pending);
      const [record] = await setup.persistence.decisions.listPending("c1");
      assert.same(record?.toolName, "bash");
      assert.equal(record?.payload, { command: "rm -rf build" });
      assert.same(record?.requestedAt, 1000);
    },
  },
  {
    name: "settle 对已结清的返回 false（不抛）",
    async run(setup) {
      await setup.persistence.decisions.record(pending);
      await setup.persistence.decisions.settle("c1", "call-1", { outcome: "allow", decidedAt: 2000 });

      const again = await setup.persistence.decisions.settle("c1", "call-1", { outcome: "deny", decidedAt: 3000 });
      assert.same(again, false);
    },
  },
  {
    name: "settle 对从未存在的返回 false（不抛）",
    async run(setup) {
      assert.same(await setup.persistence.decisions.settle("c1", "根本没有这个", { outcome: "allow", decidedAt: 1 }), false);
    },
  },
  {
    name: "question 通道与 approval 通道分得开",
    async run(setup) {
      await setup.persistence.decisions.record(pending);
      await setup.persistence.decisions.record({
        conversationId: "c1",
        toolCallId: "call-2",
        kind: "question",
        payload: "你想用哪个分支？",
        requestedAt: 1100,
      });
      const kinds = (await setup.persistence.decisions.listPending("c1")).map((d) => d.kind);
      assert.equal(kinds, ["approval", "question"]);
    },
  },
  {
    name: "裁决表 · 会话之间互不串",
    async run(setup) {
      await setup.persistence.decisions.record(pending);
      assert.equal(await setup.persistence.decisions.listPending("c2"), []);
    },
  },
  {
    name: "先进先出",
    async run(setup) {
      for (const text of ["一", "二", "三"]) {
        await setup.persistence.queue.enqueue("c1", { text }, opts);
      }
      assert.equal((await setup.persistence.queue.list("c1")).map((q) => q.input.text), ["一", "二", "三"]);

      const first = await setup.persistence.queue.dequeue("c1");
      assert.same(first.item?.input.text, "一");
      assert.equal(first.queue.map((q) => q.input.text), ["二", "三"]);
    },
  },
  {
    name: "入队原样保住 userId 与 meta",
    async run(setup) {
      await setup.persistence.queue.enqueue("c1", { text: "x", userId: "u1", meta: { pri: 3 } }, opts);
      const [item] = await setup.persistence.queue.list("c1");
      assert.equal(item?.input, { text: "x", userId: "u1", meta: { pri: 3 } });
      assert.same(item?.conversationId, "c1");
    },
  },
  {
    name: "dequeue 取出即移除——同一条不会被取两次",
    async run(setup) {
      await setup.persistence.queue.enqueue("c1", { text: "只此一条" }, opts);
      const first = await setup.persistence.queue.dequeue("c1");
      const second = await setup.persistence.queue.dequeue("c1");

      assert.same(first.item?.input.text, "只此一条");
      assert.isUndefined(second.item);
      assert.equal(second.queue, []);
    },
  },
  {
    name: "空队列 dequeue 给 undefined，不抛",
    async run(setup) {
      const result = await setup.persistence.queue.dequeue("从未存在过");
      assert.isUndefined(result.item);
      assert.equal(result.queue, []);
    },
  },
  {
    name: "满了且 onFull=reject：原样返回当前队列，不截断不覆盖",
    async run(setup) {
      for (const text of ["一", "二", "三"]) {
        await setup.persistence.queue.enqueue("c1", { text }, opts);
      }
      const result = await setup.persistence.queue.enqueue("c1", { text: "第四条" }, opts);

      assert.same(result.ok, false);
      if (!result.ok) {
        assert.same(result.reason, "full");
        assert.equal(result.queue.map((q) => q.input.text), ["一", "二", "三"]);
      }
      // 库里也确实没多出来那条。
      assert.equal((await setup.persistence.queue.list("c1")).map((q) => q.input.text), ["一", "二", "三"]);
    },
  },
  {
    name: "满了且 onFull=dropOldest：丢队首，新的进队尾",
    async run(setup) {
      const drop = { max: 3, onFull: "dropOldest" as const };
      for (const text of ["一", "二", "三"]) {
        await setup.persistence.queue.enqueue("c1", { text }, drop);
      }
      const result = await setup.persistence.queue.enqueue("c1", { text: "第四条" }, drop);

      assert.same(result.ok, true);
      assert.equal((await setup.persistence.queue.list("c1")).map((q) => q.input.text), ["二", "三", "第四条"]);
    },
  },
  {
    name: "remove 按 id 删中间那条；删不存在的给 removed:false",
    async run(setup) {
      for (const text of ["一", "二", "三"]) {
        await setup.persistence.queue.enqueue("c1", { text }, opts);
      }
      const queue = await setup.persistence.queue.list("c1");
      const middle = queue[1];
      if (middle === undefined) {
        throw new Error("夹具不对：队列应该有三条");
      }

      const removed = await setup.persistence.queue.remove("c1", middle.id);
      assert.same(removed.removed, true);
      assert.equal(removed.queue.map((q) => q.input.text), ["一", "三"]);

      const missing = await setup.persistence.queue.remove("c1", "根本没有这个 id");
      assert.same(missing.removed, false);
      assert.equal(missing.queue.map((q) => q.input.text), ["一", "三"]);
    },
  },
  {
    name: "clear 清空",
    async run(setup) {
      await setup.persistence.queue.enqueue("c1", { text: "x" }, opts);
      assert.equal(await setup.persistence.queue.clear("c1"), []);
      assert.equal(await setup.persistence.queue.list("c1"), []);
    },
  },
  {
    name: "requeueFront 放回队首，保住原有顺序位置",
    async run(setup) {
      for (const text of ["一", "二", "三"]) {
        await setup.persistence.queue.enqueue("c1", { text }, opts);
      }
      const taken = await setup.persistence.queue.dequeue("c1");
      if (taken.item === undefined) {
        throw new Error("夹具不对：应该取到队首");
      }

      const queue = await setup.persistence.queue.requeueFront("c1", taken.item);
      assert.equal(queue.map((q) => q.input.text), ["一", "二", "三"]);
    },
  },
  {
    name: "requeueFront 不受 max 约束——它是回滚一次出队，不是新入队",
    async run(setup) {
      const tiny = { max: 1, onFull: "reject" as const };
      await setup.persistence.queue.enqueue("c1", { text: "甲" }, tiny);
      const taken = await setup.persistence.queue.dequeue("c1");
      if (taken.item === undefined) {
        throw new Error("夹具不对");
      }
      // 出队之后队列空了，趁机塞进另一条把它填满。
      await setup.persistence.queue.enqueue("c1", { text: "乙" }, tiny);
      assert.length(await setup.persistence.queue.list("c1"), 1);

      // 此刻队列已满，但回滚必须成功——否则用户那条话就丢了。
      const queue = await setup.persistence.queue.requeueFront("c1", taken.item);
      assert.equal(queue.map((q) => q.input.text), ["甲", "乙"]);
    },
  },
  {
    name: "待发队列 · 会话之间互不串",
    async run(setup) {
      await setup.persistence.queue.enqueue("c1", { text: "属于 c1" }, opts);
      assert.equal(await setup.persistence.queue.list("c2"), []);
      assert.isUndefined((await setup.persistence.queue.dequeue("c2")).item);
    },
  },
  {
    name: "三个 Store 用同一个 conversationId 互不干扰",
    async run(setup) {
      await setup.persistence.ledger.append({ conversationId: "c1", seq: 1, message: message("m1", "x"), ts: 1 });
      await setup.persistence.decisions.record({
        conversationId: "c1",
        toolCallId: "call-1",
        kind: "approval",
        requestedAt: 1,
      });
      await setup.persistence.queue.enqueue("c1", { text: "排着" }, { max: 3, onFull: "reject" });

      assert.same(await setup.persistence.ledger.maxSeq("c1"), 1);
      assert.length(await setup.persistence.decisions.listPending("c1"), 1);
      assert.length(await setup.persistence.queue.list("c1"), 1);
    },
  },
  {
    name: "写入结果一律是 WriteResult，不抛（rejected 那一支在无租约下走不到，但类型上必须有）",
    async run(setup) {
      const appended = await setup.persistence.ledger.append({
        conversationId: "c1",
        seq: 1,
        message: message("m1", "x"),
        ts: 1,
      });
      assert.same(appended.ok, true);

      const recorded = await setup.persistence.decisions.record({
        conversationId: "c1",
        toolCallId: "call-1",
        kind: "approval",
        requestedAt: 1,
      });
      assert.same(recorded.ok, true);
    },
  },
  {
    name: "**别的消息占了同一个 seq → append 报 rejected，不静默丢**",
    async run(setup) {
      // 契约允许「幂等或被拒」。同一条消息重写一遍是幂等（报成功），但**另一条**消息
      // 占了这个号时报成功就是静默丢消息——租约版归属仲裁上线后，两个进程各自发号
      // 撞在一起正是最需要被看见的信号，表现不该是「消息没了、没有任何错误」。
      const first = await setup.persistence.ledger.append({ conversationId: "c1", seq: 1, message: message("m1", "先到"), ts: 1 });
      assert.same(first.ok, true);

      // 同一条重写 → 幂等。
      const again = await setup.persistence.ledger.append({ conversationId: "c1", seq: 1, message: message("m1", "先到"), ts: 1 });
      assert.same(again.ok, true);

      // 换一条消息占同一个号 → 明确拒绝。
      const clash = await setup.persistence.ledger.append({ conversationId: "c1", seq: 1, message: message("m2", "后到"), ts: 2 });
      assert.equal(clash, { ok: false, reason: "rejected" });

      // 账本里仍然只有先到的那条。
      const rows = await setup.persistence.ledger.read("c1");
      assert.length(rows, 1);
      assert.same(rows[0]?.message.id, "m1");
    },
  },
  {
    name: "**conversationId 大小写敏感**——只差大小写的两个会话互不可见",
    async run(setup) {
      // 契约明说 conversationId 是**不透明字符串**，宿主爱用什么用什么，所以不能把
      // 「别用混合大小写」推给宿主。MySQL 8 的默认排序规则 `utf8mb4_0900_ai_ci`
      // 大小写与重音都不敏感，不显式 `COLLATE utf8mb4_bin` 就会串会话——跨会话读到
      // 别人的账本，主键上还会撞键、第二条 append 被静默丢掉。
      await setup.persistence.ledger.append({ conversationId: "Case", seq: 1, message: message("m1", "大写"), ts: 1 });
      await setup.persistence.ledger.append({ conversationId: "case", seq: 1, message: message("m2", "小写"), ts: 2 });

      const upper = await setup.persistence.ledger.read("Case");
      const lower = await setup.persistence.ledger.read("case");
      assert.length(upper, 1);
      assert.length(lower, 1);
      assert.same(upper[0]?.message.id, "m1");
      assert.same(lower[0]?.message.id, "m2");
    },
  },
  {
    name: "**tool_call_id 大小写敏感**——各家模型的 call id 本来就是混合大小写",
    async run(setup) {
      await setup.persistence.decisions.record({ conversationId: "c1", toolCallId: "call_AbC", kind: "approval", requestedAt: 1 });
      await setup.persistence.decisions.record({ conversationId: "c1", toolCallId: "call_abc", kind: "approval", requestedAt: 2 });
      const pending = await setup.persistence.decisions.listPending("c1");
      assert.equal(pending.map((p) => p.toolCallId).sort(), ["call_AbC", "call_abc"]);

      // 结清其中一条，另一条必须还在（不能被结到一起去）。
      assert.same(await setup.persistence.decisions.settle("c1", "call_AbC", { outcome: "allow", decidedAt: 3 }), true);
      assert.equal((await setup.persistence.decisions.listPending("c1")).map((p) => p.toolCallId), ["call_abc"]);
    },
  },
  {
    name: "**并发 enqueue**：不越过 max，seq 不重复",
    async run(setup) {
      // `AgentRuntime.enqueue` 是从 HTTP handler 直接调的，没有按会话串行——「先 SELECT
      // 再 INSERT」会让两个并发请求读到同一份快照：都认为没满、还都算出同一个 seq，
      // 之后按 seq 排序平局，先到先发不再成立。
      const results = await Promise.all(
        Array.from({ length: 8 }, (_unused, i) =>
          setup.persistence.queue.enqueue("c1", { text: `m${String(i)}` }, { max: 5, onFull: "reject" }),
        ),
      );
      const accepted = results.filter((r) => r.ok);
      const queue = await setup.persistence.queue.list("c1");

      assert.atMost(queue.length, 5);
      assert.same(accepted.length, queue.length);
      assert.same(new Set(queue.map((q) => q.seq)).size, queue.length);
      assert.same(new Set(queue.map((q) => q.id)).size, queue.length);
    },
  },
];
