/**
 * **持久化一致性套件**——一套用例，喂给任意一个 `Persistence` 实现，逐条断言
 * [契约](../../../docs/host/contract/tech/persistence.md)里那些**写死了但从没验过**的承诺。
 *
 * ```ts
 * import { runPersistenceConformance } from "@nimbo/agent/conformance";
 *
 * runPersistenceConformance("persist-sql · sqlite", async () => {
 *   const db = new Database(":memory:");
 *   await migrate(db);
 *   return { persistence: sqlitePersistence(db), cleanup: async () => { db.close(); } };
 * });
 * ```
 *
 * **为什么住在这个包里**：它断言的是**接口的承诺**，不是某个实现的行为。放在定义接口
 * 的包里，`persist-sql`、将来的 `persist-drizzle` / `persist-prisma`、以及任何第三方
 * 实现都能直接引来自测——「换实现不改行为」这个承诺才有人守。
 *
 * 它 import `vitest`，所以 `vitest` 是本包的**可选 peer**：只用主入口的人完全不受影响。
 */
import { beforeEach, describe, expect, it } from "vitest";

import type { Persistence } from "./persistence.js";
import type { NimboUIMessage } from "@nimbo/core";

/** 每个用例前拿一份干净的实现；`cleanup` 在用例后调用。 */
export interface ConformanceSetup {
  persistence: Persistence;
  cleanup?: () => Promise<void> | void;
}

function message(id: string, text: string): NimboUIMessage {
  return { id, role: "assistant", parts: [{ type: "text", text }] };
}

/**
 * 跑一遍一致性套件。
 *
 * @param name 显示名，进 `describe` 标题——多个实现跑同一套时靠它区分。
 * @param setup 每个用例前调一次，给一份**干净的**实现（空库/新实例）。
 */
export function runPersistenceConformance(
  name: string,
  setup: () => Promise<ConformanceSetup> | ConformanceSetup,
): void {
  describe(`持久化一致性 · ${name}`, () => {
    let persistence: Persistence;
    let cleanup: (() => Promise<void> | void) | undefined;

    beforeEach(async () => {
      if (cleanup !== undefined) {
        await cleanup();
      }
      const ready = await setup();
      persistence = ready.persistence;
      cleanup = ready.cleanup;
    });

    // -----------------------------------------------------------------------
    // 账本
    // -----------------------------------------------------------------------

    describe("账本（LedgerStore）", () => {
      it("append 之后 read 读得回来，且按 seq 升序", async () => {
        // 刻意乱序写入——「按 seq 升序」是读的承诺，不是写的顺序。
        await persistence.ledger.append({ conversationId: "c1", seq: 3, message: message("m3", "三"), ts: 300 });
        await persistence.ledger.append({ conversationId: "c1", seq: 1, message: message("m1", "一"), ts: 100 });
        await persistence.ledger.append({ conversationId: "c1", seq: 2, message: message("m2", "二"), ts: 200 });

        const entries = await persistence.ledger.read("c1");
        expect(entries.map((e) => e.seq)).toEqual([1, 2, 3]);
        expect(entries.map((e) => e.message.id)).toEqual(["m1", "m2", "m3"]);
        expect(entries[0]?.ts).toBe(100);
      });

      it("message 原样往返（JSON 列的序列化边界）", async () => {
        const original: NimboUIMessage = {
          id: "m1",
          role: "assistant",
          parts: [{ type: "text", text: "带 emoji 😀 与「引号」和 \\ 反斜杠" }],
          metadata: { turn: 7, status: "completed", usage: { totalTokens: 42 } },
        };
        await persistence.ledger.append({ conversationId: "c1", seq: 1, message: original, ts: 1 });
        const [entry] = await persistence.ledger.read("c1");
        expect(entry?.message).toEqual(original);
      });

      it("同 (conversationId, seq) 重复写入不得写出两行", async () => {
        await persistence.ledger.append({ conversationId: "c1", seq: 1, message: message("m1", "先"), ts: 1 });
        // 契约允许「幂等或被拒」两种处置，但**不得写出两行**——这才是要守的不变量。
        await persistence.ledger.append({ conversationId: "c1", seq: 1, message: message("m1b", "后"), ts: 2 });

        const entries = await persistence.ledger.read("c1");
        expect(entries).toHaveLength(1);
      });

      it("read({ afterSeq }) 不含自身", async () => {
        for (const seq of [1, 2, 3]) {
          await persistence.ledger.append({ conversationId: "c1", seq, message: message(`m${String(seq)}`, "x"), ts: seq });
        }
        const entries = await persistence.ledger.read("c1", { afterSeq: 2 });
        expect(entries.map((e) => e.seq)).toEqual([3]);
      });

      it("seq 允许有空洞——占了号没写成，读写都不受影响", async () => {
        await persistence.ledger.append({ conversationId: "c1", seq: 1, message: message("m1", "x"), ts: 1 });
        // seq 2 被占号但从未写入（起轮失败/写入被拒），直接跳到 5。
        await persistence.ledger.append({ conversationId: "c1", seq: 5, message: message("m5", "x"), ts: 5 });

        expect((await persistence.ledger.read("c1")).map((e) => e.seq)).toEqual([1, 5]);
        expect(await persistence.ledger.maxSeq("c1")).toBe(5);
        expect((await persistence.ledger.read("c1", { afterSeq: 1 })).map((e) => e.seq)).toEqual([5]);
      });

      it("maxSeq 对空会话返回 0", async () => {
        expect(await persistence.ledger.maxSeq("从未存在过")).toBe(0);
      });

      it("会话之间互不串", async () => {
        await persistence.ledger.append({ conversationId: "c1", seq: 1, message: message("a", "x"), ts: 1 });
        await persistence.ledger.append({ conversationId: "c2", seq: 1, message: message("b", "x"), ts: 1 });

        expect((await persistence.ledger.read("c1")).map((e) => e.message.id)).toEqual(["a"]);
        expect((await persistence.ledger.read("c2")).map((e) => e.message.id)).toEqual(["b"]);
      });

      it("空会话 read 返回空数组，不抛", async () => {
        expect(await persistence.ledger.read("从未存在过")).toEqual([]);
      });
    });

    // -----------------------------------------------------------------------
    // 裁决表
    // -----------------------------------------------------------------------

    describe("裁决表（DecisionStore）", () => {
      const pending = {
        conversationId: "c1",
        toolCallId: "call-1",
        kind: "approval" as const,
        toolName: "bash",
        payload: { command: "rm -rf build" },
        requestedAt: 1000,
      };

      it("record 之后进 listPending，settle 之后出 listPending", async () => {
        await persistence.decisions.record(pending);
        expect((await persistence.decisions.listPending("c1")).map((d) => d.toolCallId)).toEqual(["call-1"]);

        const settled = await persistence.decisions.settle("c1", "call-1", {
          outcome: "allow",
          scope: "conversation",
          decidedBy: "u1",
          decidedAt: 2000,
        });
        expect(settled).toBe(true);
        expect(await persistence.decisions.listPending("c1")).toEqual([]);
      });

      it("待定项带回 toolName 与 payload（挂起恢复要拿原封不动的参数）", async () => {
        await persistence.decisions.record(pending);
        const [record] = await persistence.decisions.listPending("c1");
        expect(record?.toolName).toBe("bash");
        expect(record?.payload).toEqual({ command: "rm -rf build" });
        expect(record?.requestedAt).toBe(1000);
      });

      it("settle 对已结清的返回 false（不抛）", async () => {
        await persistence.decisions.record(pending);
        await persistence.decisions.settle("c1", "call-1", { outcome: "allow", decidedAt: 2000 });

        const again = await persistence.decisions.settle("c1", "call-1", { outcome: "deny", decidedAt: 3000 });
        expect(again).toBe(false);
      });

      it("settle 对从未存在的返回 false（不抛）", async () => {
        expect(await persistence.decisions.settle("c1", "根本没有这个", { outcome: "allow", decidedAt: 1 })).toBe(false);
      });

      it("question 通道与 approval 通道分得开", async () => {
        await persistence.decisions.record(pending);
        await persistence.decisions.record({
          conversationId: "c1",
          toolCallId: "call-2",
          kind: "question",
          payload: "你想用哪个分支？",
          requestedAt: 1100,
        });
        const kinds = (await persistence.decisions.listPending("c1")).map((d) => d.kind);
        expect(kinds).toEqual(["approval", "question"]);
      });

      it("会话之间互不串", async () => {
        await persistence.decisions.record(pending);
        expect(await persistence.decisions.listPending("c2")).toEqual([]);
      });
    });

    // -----------------------------------------------------------------------
    // 待发队列
    // -----------------------------------------------------------------------

    describe("待发队列（QueueStore）", () => {
      const opts = { max: 3, onFull: "reject" as const };

      it("先进先出", async () => {
        for (const text of ["一", "二", "三"]) {
          await persistence.queue.enqueue("c1", { text }, opts);
        }
        expect((await persistence.queue.list("c1")).map((q) => q.input.text)).toEqual(["一", "二", "三"]);

        const first = await persistence.queue.dequeue("c1");
        expect(first.item?.input.text).toBe("一");
        expect(first.queue.map((q) => q.input.text)).toEqual(["二", "三"]);
      });

      it("入队原样保住 userId 与 meta", async () => {
        await persistence.queue.enqueue("c1", { text: "x", userId: "u1", meta: { pri: 3 } }, opts);
        const [item] = await persistence.queue.list("c1");
        expect(item?.input).toEqual({ text: "x", userId: "u1", meta: { pri: 3 } });
        expect(item?.conversationId).toBe("c1");
      });

      it("dequeue 取出即移除——同一条不会被取两次", async () => {
        await persistence.queue.enqueue("c1", { text: "只此一条" }, opts);
        const first = await persistence.queue.dequeue("c1");
        const second = await persistence.queue.dequeue("c1");

        expect(first.item?.input.text).toBe("只此一条");
        expect(second.item).toBeUndefined();
        expect(second.queue).toEqual([]);
      });

      it("空队列 dequeue 给 undefined，不抛", async () => {
        const result = await persistence.queue.dequeue("从未存在过");
        expect(result.item).toBeUndefined();
        expect(result.queue).toEqual([]);
      });

      it("满了且 onFull=reject：原样返回当前队列，不截断不覆盖", async () => {
        for (const text of ["一", "二", "三"]) {
          await persistence.queue.enqueue("c1", { text }, opts);
        }
        const result = await persistence.queue.enqueue("c1", { text: "第四条" }, opts);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe("full");
          expect(result.queue.map((q) => q.input.text)).toEqual(["一", "二", "三"]);
        }
        // 库里也确实没多出来那条。
        expect((await persistence.queue.list("c1")).map((q) => q.input.text)).toEqual(["一", "二", "三"]);
      });

      it("满了且 onFull=dropOldest：丢队首，新的进队尾", async () => {
        const drop = { max: 3, onFull: "dropOldest" as const };
        for (const text of ["一", "二", "三"]) {
          await persistence.queue.enqueue("c1", { text }, drop);
        }
        const result = await persistence.queue.enqueue("c1", { text: "第四条" }, drop);

        expect(result.ok).toBe(true);
        expect((await persistence.queue.list("c1")).map((q) => q.input.text)).toEqual(["二", "三", "第四条"]);
      });

      it("remove 按 id 删中间那条；删不存在的给 removed:false", async () => {
        for (const text of ["一", "二", "三"]) {
          await persistence.queue.enqueue("c1", { text }, opts);
        }
        const queue = await persistence.queue.list("c1");
        const middle = queue[1];
        if (middle === undefined) {
          throw new Error("夹具不对：队列应该有三条");
        }

        const removed = await persistence.queue.remove("c1", middle.id);
        expect(removed.removed).toBe(true);
        expect(removed.queue.map((q) => q.input.text)).toEqual(["一", "三"]);

        const missing = await persistence.queue.remove("c1", "根本没有这个 id");
        expect(missing.removed).toBe(false);
        expect(missing.queue.map((q) => q.input.text)).toEqual(["一", "三"]);
      });

      it("clear 清空", async () => {
        await persistence.queue.enqueue("c1", { text: "x" }, opts);
        expect(await persistence.queue.clear("c1")).toEqual([]);
        expect(await persistence.queue.list("c1")).toEqual([]);
      });

      it("requeueFront 放回队首，保住原有顺序位置", async () => {
        for (const text of ["一", "二", "三"]) {
          await persistence.queue.enqueue("c1", { text }, opts);
        }
        const taken = await persistence.queue.dequeue("c1");
        if (taken.item === undefined) {
          throw new Error("夹具不对：应该取到队首");
        }

        const queue = await persistence.queue.requeueFront("c1", taken.item);
        expect(queue.map((q) => q.input.text)).toEqual(["一", "二", "三"]);
      });

      it("requeueFront 不受 max 约束——它是回滚一次出队，不是新入队", async () => {
        const tiny = { max: 1, onFull: "reject" as const };
        await persistence.queue.enqueue("c1", { text: "甲" }, tiny);
        const taken = await persistence.queue.dequeue("c1");
        if (taken.item === undefined) {
          throw new Error("夹具不对");
        }
        // 出队之后队列空了，趁机塞进另一条把它填满。
        await persistence.queue.enqueue("c1", { text: "乙" }, tiny);
        expect(await persistence.queue.list("c1")).toHaveLength(1);

        // 此刻队列已满，但回滚必须成功——否则用户那条话就丢了。
        const queue = await persistence.queue.requeueFront("c1", taken.item);
        expect(queue.map((q) => q.input.text)).toEqual(["甲", "乙"]);
      });

      it("会话之间互不串", async () => {
        await persistence.queue.enqueue("c1", { text: "属于 c1" }, opts);
        expect(await persistence.queue.list("c2")).toEqual([]);
        expect((await persistence.queue.dequeue("c2")).item).toBeUndefined();
      });
    });

    // -----------------------------------------------------------------------
    // 跨 Store
    // -----------------------------------------------------------------------

    it("三个 Store 用同一个 conversationId 互不干扰", async () => {
      await persistence.ledger.append({ conversationId: "c1", seq: 1, message: message("m1", "x"), ts: 1 });
      await persistence.decisions.record({
        conversationId: "c1",
        toolCallId: "call-1",
        kind: "approval",
        requestedAt: 1,
      });
      await persistence.queue.enqueue("c1", { text: "排着" }, { max: 3, onFull: "reject" });

      expect(await persistence.ledger.maxSeq("c1")).toBe(1);
      expect(await persistence.decisions.listPending("c1")).toHaveLength(1);
      expect(await persistence.queue.list("c1")).toHaveLength(1);
    });

    it("写入结果一律是 WriteResult，不抛（rejected 那一支在无租约下走不到，但类型上必须有）", async () => {
      const appended = await persistence.ledger.append({
        conversationId: "c1",
        seq: 1,
        message: message("m1", "x"),
        ts: 1,
      });
      expect(appended.ok).toBe(true);

      const recorded = await persistence.decisions.record({
        conversationId: "c1",
        toolCallId: "call-1",
        kind: "approval",
        requestedAt: 1,
      });
      expect(recorded.ok).toBe(true);
    });

    // -----------------------------------------------------------------------
    // 跨 Store 的横向约束
    // -----------------------------------------------------------------------

    describe("横向约束", () => {
      it("**别的消息占了同一个 seq → append 报 rejected，不静默丢**", async () => {
        // 契约允许「幂等或被拒」。同一条消息重写一遍是幂等（报成功），但**另一条**消息
        // 占了这个号时报成功就是静默丢消息——租约版归属仲裁上线后，两个进程各自发号
        // 撞在一起正是最需要被看见的信号，表现不该是「消息没了、没有任何错误」。
        const first = await persistence.ledger.append({ conversationId: "c1", seq: 1, message: message("m1", "先到"), ts: 1 });
        expect(first.ok).toBe(true);

        // 同一条重写 → 幂等。
        const again = await persistence.ledger.append({ conversationId: "c1", seq: 1, message: message("m1", "先到"), ts: 1 });
        expect(again.ok).toBe(true);

        // 换一条消息占同一个号 → 明确拒绝。
        const clash = await persistence.ledger.append({ conversationId: "c1", seq: 1, message: message("m2", "后到"), ts: 2 });
        expect(clash).toEqual({ ok: false, reason: "rejected" });

        // 账本里仍然只有先到的那条。
        const rows = await persistence.ledger.read("c1");
        expect(rows).toHaveLength(1);
        expect(rows[0]?.message.id).toBe("m1");
      });

      it("**conversationId 大小写敏感**——只差大小写的两个会话互不可见", async () => {
        // 契约明说 conversationId 是**不透明字符串**，宿主爱用什么用什么，所以不能把
        // 「别用混合大小写」推给宿主。MySQL 8 的默认排序规则 `utf8mb4_0900_ai_ci`
        // 大小写与重音都不敏感，不显式 `COLLATE utf8mb4_bin` 就会串会话——跨会话读到
        // 别人的账本，主键上还会撞键、第二条 append 被静默丢掉。
        await persistence.ledger.append({ conversationId: "Case", seq: 1, message: message("m1", "大写"), ts: 1 });
        await persistence.ledger.append({ conversationId: "case", seq: 1, message: message("m2", "小写"), ts: 2 });

        const upper = await persistence.ledger.read("Case");
        const lower = await persistence.ledger.read("case");
        expect(upper).toHaveLength(1);
        expect(lower).toHaveLength(1);
        expect(upper[0]?.message.id).toBe("m1");
        expect(lower[0]?.message.id).toBe("m2");
      });

      it("**tool_call_id 大小写敏感**——各家模型的 call id 本来就是混合大小写", async () => {
        await persistence.decisions.record({ conversationId: "c1", toolCallId: "call_AbC", kind: "approval", requestedAt: 1 });
        await persistence.decisions.record({ conversationId: "c1", toolCallId: "call_abc", kind: "approval", requestedAt: 2 });
        const pending = await persistence.decisions.listPending("c1");
        expect(pending.map((p) => p.toolCallId).sort()).toEqual(["call_AbC", "call_abc"]);

        // 结清其中一条，另一条必须还在（不能被结到一起去）。
        expect(await persistence.decisions.settle("c1", "call_AbC", { outcome: "allow", decidedAt: 3 })).toBe(true);
        expect((await persistence.decisions.listPending("c1")).map((p) => p.toolCallId)).toEqual(["call_abc"]);
      });

      it("**并发 enqueue**：不越过 max，seq 不重复", async () => {
        // `AgentRuntime.enqueue` 是从 HTTP handler 直接调的，没有按会话串行——「先 SELECT
        // 再 INSERT」会让两个并发请求读到同一份快照：都认为没满、还都算出同一个 seq，
        // 之后按 seq 排序平局，先到先发不再成立。
        const results = await Promise.all(
          Array.from({ length: 8 }, (_unused, i) =>
            persistence.queue.enqueue("c1", { text: `m${String(i)}` }, { max: 5, onFull: "reject" }),
          ),
        );
        const accepted = results.filter((r) => r.ok);
        const queue = await persistence.queue.list("c1");

        expect(queue.length).toBeLessThanOrEqual(5);
        expect(accepted.length).toBe(queue.length);
        expect(new Set(queue.map((q) => q.seq)).size).toBe(queue.length);
        expect(new Set(queue.map((q) => q.id)).size).toBe(queue.length);
      });
    });
  });
}
