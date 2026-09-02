/**
 * 三样内置实现的契约用例——它们是「零配置能跑」的底座，也是宿主自己实现同一组接口时
 * 的行为基准（换实现要跑得过同一批断言）。
 */
import { describe, expect, it } from "vitest";

import type { ArbitrationConformanceSetup, ConformanceCase, PersistenceConformanceSetup } from "@runko/conformance";
import { arbitrationCases, persistenceCases } from "@runko/conformance";
import type { Frame } from "../src/index.js";
import { inProcessArbitration, inProcessStream, memoryPersistence } from "../src/index.js";

// 内置内存实现也要跑一致性套件——它是「换实现不改行为」这个承诺的**基准**，
// 别的实现全都对着它看齐。同一套用例在 `@runko/conformance`。
/**
 * 把一致性用例接进 vitest。**套件本身不依赖任何测试框架**（它只导出 `{ name, run }`），
 * 这十几行就是「接上去」的全部成本。
 */
function runCases<S extends { cleanup?: () => Promise<void> | void }>(
  title: string,
  cases: readonly ConformanceCase<S>[],
  makeSetup: () => Promise<S> | S,
): void {
  describe(title, () => {
    for (const testCase of cases) {
      it(testCase.name, async () => {
        const setup = await makeSetup();
        try {
          await testCase.run(setup);
        } finally {
          await setup.cleanup?.();
        }
      });
    }
  });
}

runCases<PersistenceConformanceSetup>("memoryPersistence", persistenceCases, () => ({
  persistence: memoryPersistence(),
}));

// **内存版只接「通用」这一组。** 另外两组它给不了——归属表就在自己进程里，没有第二个
// 节点，也没有「心跳超时」这回事。分组是三个独立数组而不是可选字段，所以这里少接两组
// 是一目了然的事实陈述，不是静默跳过。
runCases<ArbitrationConformanceSetup>("inProcessArbitration", arbitrationCases, () => ({
  arbitration: inProcessArbitration(),
}));

const message = { id: "m1", role: "assistant" as const, parts: [{ type: "text" as const, text: "hi" }] };

describe("memoryPersistence · 账本", () => {
  it("按 seq 升序读回；`afterSeq` 不含自身", async () => {
    const { ledger } = memoryPersistence();
    await ledger.append({ conversationId: "c", seq: 2, message, ts: 2 });
    await ledger.append({ conversationId: "c", seq: 1, message, ts: 1 });
    expect((await ledger.read("c")).map((row) => row.seq)).toEqual([1, 2]);
    expect((await ledger.read("c", { afterSeq: 1 })).map((row) => row.seq)).toEqual([2]);
  });

  it("同 seq 重复写入是幂等的，不会写出两行", async () => {
    const { ledger } = memoryPersistence();
    await ledger.append({ conversationId: "c", seq: 1, message, ts: 1 });
    await ledger.append({ conversationId: "c", seq: 1, message, ts: 9 });
    expect(await ledger.read("c")).toHaveLength(1);
  });

  it("空会话的 maxSeq 是 0——第一条落盘就是 seq 1", async () => {
    const { ledger } = memoryPersistence();
    expect(await ledger.maxSeq("nope")).toBe(0);
  });

  it("seq 允许有空洞（占了号但没写成），读回来不补也不报错", async () => {
    const { ledger } = memoryPersistence();
    await ledger.append({ conversationId: "c", seq: 1, message, ts: 1 });
    await ledger.append({ conversationId: "c", seq: 5, message, ts: 2 });
    expect((await ledger.read("c")).map((row) => row.seq)).toEqual([1, 5]);
    expect(await ledger.maxSeq("c")).toBe(5);
  });
});

describe("memoryPersistence · 裁决表", () => {
  it("登记 → 结清；重复结清报 false", async () => {
    const { decisions } = memoryPersistence();
    await decisions.record({ conversationId: "c", toolCallId: "call", kind: "approval", requestedAt: 1 });
    expect(await decisions.listPending("c")).toHaveLength(1);
    expect(await decisions.settle("c", "call", { outcome: "allow", decidedAt: 2 })).toBe(true);
    expect(await decisions.listPending("c")).toHaveLength(0);
    expect(await decisions.settle("c", "call", { outcome: "deny", decidedAt: 3 })).toBe(false);
  });

  it("结清一条不存在的裁决报 false（接入层据此转 404）", async () => {
    const { decisions } = memoryPersistence();
    expect(await decisions.settle("c", "ghost", { outcome: "allow", decidedAt: 1 })).toBe(false);
  });
});

describe("memoryPersistence · 待发队列", () => {
  it("先到先发；出队即移除", async () => {
    const { queue } = memoryPersistence();
    const opts = { max: 10, onFull: "reject" as const };
    await queue.enqueue("c", { text: "a" }, opts);
    await queue.enqueue("c", { text: "b" }, opts);
    const first = await queue.dequeue("c");
    expect(first.item?.input.text).toBe("a");
    expect(first.queue).toHaveLength(1);
  });

  it("满了按 `reject` 原样返回当前队列，不截断不覆盖", async () => {
    const { queue } = memoryPersistence();
    const opts = { max: 1, onFull: "reject" as const };
    await queue.enqueue("c", { text: "a" }, opts);
    const full = await queue.enqueue("c", { text: "b" }, opts);
    expect(full.ok).toBe(false);
    expect(full.queue.map((item) => item.input.text)).toEqual(["a"]);
  });

  it("满了按 `dropOldest` 挤掉队首，保证新的一定进得来", async () => {
    const { queue } = memoryPersistence();
    const opts = { max: 2, onFull: "dropOldest" as const };
    await queue.enqueue("c", { text: "a" }, opts);
    await queue.enqueue("c", { text: "b" }, opts);
    const third = await queue.enqueue("c", { text: "c" }, opts);
    expect(third.ok).toBe(true);
    expect(third.queue.map((item) => item.input.text)).toEqual(["b", "c"]);
  });

  it("`requeueFront` 放回队首、且不受 max 约束（那是回滚一次已发生的出队）", async () => {
    const { queue } = memoryPersistence();
    const opts = { max: 1, onFull: "reject" as const };
    const enqueued = await queue.enqueue("c", { text: "a" }, opts);
    if (!enqueued.ok) {throw new Error("expected ok");}
    await queue.dequeue("c");
    await queue.enqueue("c", { text: "b" }, opts);
    const restored = await queue.requeueFront("c", enqueued.queued);
    expect(restored.map((item) => item.input.text)).toEqual(["a", "b"]);
  });

  it("删一条 / 清空", async () => {
    const { queue } = memoryPersistence();
    const opts = { max: 10, onFull: "reject" as const };
    const enqueued = await queue.enqueue("c", { text: "a" }, opts);
    if (!enqueued.ok) {throw new Error("expected ok");}
    expect(await queue.remove("c", "ghost")).toMatchObject({ removed: false });
    expect(await queue.remove("c", enqueued.queued.id)).toMatchObject({ removed: true });
    await queue.enqueue("c", { text: "b" }, opts);
    expect(await queue.clear("c")).toHaveLength(0);
  });

  it("空队列出队给 undefined", async () => {
    const { queue } = memoryPersistence();
    expect((await queue.dequeue("c")).item).toBeUndefined();
  });
});

describe("inProcessStream", () => {
  it("订阅是同步挂上的——返回之后立刻发布就能收到", () => {
    const stream = inProcessStream();
    const seen: Frame[] = [];
    stream.subscribe("c", (frame) => seen.push(frame));
    stream.publish("c", { kind: "activity", active: true });
    expect(seen).toHaveLength(1);
  });

  it("退订之后不再收到；按会话隔离", () => {
    const stream = inProcessStream();
    const seen: Frame[] = [];
    const off = stream.subscribe("c", (frame) => seen.push(frame));
    stream.publish("other", { kind: "activity", active: true });
    off();
    stream.publish("c", { kind: "activity", active: true });
    expect(seen).toHaveLength(0);
  });

  it("监听者在回调里退订不会打乱这次广播（快照再遍历）", () => {
    const stream = inProcessStream();
    const seen: string[] = [];
    const offA = stream.subscribe("c", () => {
      seen.push("a");
      offA();
    });
    stream.subscribe("c", () => seen.push("b"));
    stream.publish("c", { kind: "activity", active: true });
    expect(seen).toEqual(["a", "b"]);
  });

  it("没人订阅时发布是无操作，不报错", () => {
    const stream = inProcessStream();
    expect(() => stream.publish("nobody", { kind: "activity", active: false })).not.toThrow();
  });
});

describe("inProcessArbitration", () => {
  const seed = (value = 0) => ({ seedSeq: () => Promise.resolve(value) });

  it("同一会话同时只有一个持有者；释放后能再抢", async () => {
    const arbitration = inProcessArbitration({ holder: "node-a" });
    const first = await arbitration.acquire("c", seed());
    expect(first.ok).toBe(true);
    const second = await arbitration.acquire("c", seed());
    expect(second).toMatchObject({ ok: false, reason: "busy", holder: "node-a" });

    if (!first.ok) {throw new Error("unreachable");}
    await first.grant.release();
    expect((await arbitration.acquire("c", seed())).ok).toBe(true);
  });

  it("seq 水位跨租期延续——第二轮从第一轮停的地方接着数", async () => {
    const arbitration = inProcessArbitration();
    const first = await arbitration.acquire("c", seed(0));
    if (!first.ok) {throw new Error("unreachable");}
    expect(await first.grant.nextSeq()).toEqual({ ok: true, seq: 1 });
    expect(await first.grant.nextSeq()).toEqual({ ok: true, seq: 2 });
    await first.grant.release();

    const second = await arbitration.acquire("c", seed(999)); // seedSeq 不该再被用到
    if (!second.ok) {throw new Error("unreachable");}
    expect(await second.grant.nextSeq()).toEqual({ ok: true, seq: 3 });
  });

  it("首次抢占才回库里问水位——账本里已有 7 条时下一号是 8", async () => {
    const arbitration = inProcessArbitration();
    const acquired = await arbitration.acquire("c", seed(7));
    if (!acquired.ok) {throw new Error("unreachable");}
    expect(await acquired.grant.nextSeq()).toEqual({ ok: true, seq: 8 });
  });

  it("释放之后取号报 `lost_ownership`，不抛错", async () => {
    const arbitration = inProcessArbitration();
    const acquired = await arbitration.acquire("c", seed());
    if (!acquired.ok) {throw new Error("unreachable");}
    await acquired.grant.release();
    expect(acquired.grant.valid).toBe(false);
    expect(await acquired.grant.nextSeq()).toEqual({ ok: false, reason: "lost_ownership" });
  });

  it("`release()` 幂等；`inspect` 如实反映持有状态", async () => {
    const arbitration = inProcessArbitration({ holder: "node-a" });
    expect(await arbitration.inspect("c")).toEqual({ held: false });
    const acquired = await arbitration.acquire("c", seed());
    if (!acquired.ok) {throw new Error("unreachable");}
    expect(await arbitration.inspect("c")).toEqual({ held: true, holder: "node-a" });
    await acquired.grant.release();
    await acquired.grant.release();
    expect(await arbitration.inspect("c")).toEqual({ held: false });
  });

  it("`listStale` 恒空——标记跟进程同生共死，它看不到自己上次崩溃的残留", async () => {
    const arbitration = inProcessArbitration();
    expect(await arbitration.listStale()).toEqual([]);
    await expect(arbitration.clearStale("c")).resolves.toBeUndefined();
  });
});
