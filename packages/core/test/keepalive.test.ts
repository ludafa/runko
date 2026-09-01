/**
 * 续期闸门（`createKeepAlive`）验收测试 —— KA-2 的通用部分。
 *
 * 规格见 docs/tech/sandbox-keepalive.md §5.4/§5.5，验收清单见
 * docs/plans/sandbox-keepalive.md KA-2 / KA-3。
 *
 * 这里测的是与厂商无关的闸门本身：补足语义、三个信号源、审批状态机、两个上限、
 * 失败不外溢。厂商差异（E2B 的重置 vs Vercel 的加时）经 `KeepAliveDriver` 注入，
 * 用不同的假 driver 分别覆盖——真实 SDK 的对接在各适配器包里测。
 *
 * **两类 driver 分工**（这是读这个文件的关键）：
 * - `resetDriver` / `addDriver`：用来测**补足语义本身**——水位够不够、差额算得对不对。
 * - `thirstyDriver`：恒报「已到期」，于是闸门想续就一定会续。用来测**状态机**
 *   （打点节奏、审批进出、上限），把补足判定这个变量从等式里消掉，否则一个断言会
 *   同时依赖两套逻辑，失败时读不出是哪边坏了。
 *
 * 全程假时钟：闸门内部用 `setInterval` + `Date.now()`，`vi.advanceTimersByTimeAsync`
 * 能确定地驱动它们（`Async` 版会顺带排空微任务，闸门里的 `await` 才会推进）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createKeepAlive } from "../src/keepalive.js";
import type { KeepAliveDriver, KeepAliveOptions, RenewInfo } from "../src/keepalive.js";
import type { ActivitySignal } from "../src/types.js";

const IDLE = 300_000; // 5 分钟，与 chat 应用的默认值一致
const TICK = IDLE / 2; // 闸门的打点周期

interface RenewCall {
  targetMs: number;
  remainingMs: number | undefined;
  at: number;
}

interface TestDriver extends KeepAliveDriver {
  readonly calls: RenewCall[];
  failNext?: Error;
}

/** E2B 形态：查不到剩余（`remainingMs` 恒 `undefined`），闸门靠本地记账。 */
function resetDriver(): TestDriver {
  const calls: RenewCall[] = [];
  const driver: TestDriver = {
    calls,
    failNext: undefined,
    remainingMs: async () => undefined,
    renew: async (targetMs, remainingMs) => {
      if (driver.failNext !== undefined) {
        const error = driver.failNext;
        driver.failNext = undefined;
        throw error;
      }
      calls.push({ targetMs, remainingMs, at: Date.now() });
    },
  };
  return driver;
}

/** Vercel 形态：能查真实剩余，续期是「加时」——闸门要把刚查到的剩余交给它算差额。 */
function addDriver(initialRemaining: number): TestDriver & { remaining: number } {
  const calls: RenewCall[] = [];
  const driver = {
    calls,
    remaining: initialRemaining,
    remainingMs: async (): Promise<number | undefined> => driver.remaining,
    renew: async (targetMs: number, remainingMs: number | undefined): Promise<void> => {
      calls.push({ targetMs, remainingMs, at: Date.now() });
      driver.remaining = targetMs; // 模拟「补到目标」之后的效果
    },
  };
  return driver;
}

/** 恒报已到期：闸门只要想续就一定会续。测状态机时用它把补足判定这个变量消掉。 */
function thirstyDriver(): TestDriver {
  const calls: RenewCall[] = [];
  return {
    calls,
    remainingMs: async () => 0,
    renew: async (targetMs, remainingMs) => {
      calls.push({ targetMs, remainingMs, at: Date.now() });
    },
  };
}

function signal(reason: ActivitySignal["reason"], turn = 1): ActivitySignal {
  return { session: { id: "s1", turn }, reason };
}

function make(driver: KeepAliveDriver, opts: Partial<KeepAliveOptions> = {}) {
  const renews: RenewInfo[] = [];
  const keepAlive = createKeepAlive(driver, {
    idleTimeoutMs: IDLE,
    onRenew: (info) => renews.push(info),
    ...opts,
  });
  return { keepAlive, renews };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("KA-2 闸门：补足语义", () => {
  it("首次必定真的续（从没续过 = 当作已到期）", async () => {
    const driver = resetDriver();
    const { keepAlive } = make(driver);
    await keepAlive.keepAlive(IDLE);
    expect(driver.calls).toHaveLength(1);
    expect(driver.calls[0]?.targetMs).toBe(IDLE);
  });

  it("水位还够时什么都不做", async () => {
    const driver = resetDriver();
    const { keepAlive } = make(driver);
    await keepAlive.keepAlive(IDLE);

    vi.setSystemTime(Date.now() + 30_000); // 才过 30 秒，剩余 90%
    await keepAlive.keepAlive(IDLE);
    expect(driver.calls).toHaveLength(1);
  });

  it("水位跌破判定线后才真的补", async () => {
    const driver = resetDriver();
    const { keepAlive } = make(driver);
    await keepAlive.keepAlive(IDLE);

    vi.setSystemTime(Date.now() + IDLE * 0.3); // 剩余 70%，低于 75% 判定线
    await keepAlive.keepAlive(IDLE);
    expect(driver.calls).toHaveLength(2);
  });

  it("判定线必须高于打点周期占比，否则定时器会把自己挡掉（回归 off-by-one）", async () => {
    const driver = resetDriver();
    const { keepAlive } = make(driver);
    await keepAlive.keepAlive(IDLE);

    // 定时器触发的那一刻，剩余正好是目标的一半——必须放行
    vi.setSystemTime(Date.now() + TICK);
    await keepAlive.keepAlive(IDLE);
    expect(driver.calls).toHaveLength(2);
  });

  it("连调 10 次只续第一次——这是 Vercel「每条消息盲加 5 分钟」的回归测试", async () => {
    const driver = addDriver(IDLE);
    const { keepAlive } = make(driver);
    for (let i = 0; i < 10; i++) {await keepAlive.keepAlive(IDLE);}
    expect(driver.calls).toHaveLength(0); // driver 一直报满水位，一次都不该放行
    expect(driver.remaining).toBe(IDLE);
  });

  it("「加时」型 driver 拿得到刚查到的剩余，好算差额", async () => {
    const driver = addDriver(60_000); // 只剩 1 分钟，远低于判定线
    const { keepAlive } = make(driver);
    await keepAlive.keepAlive(IDLE);
    expect(driver.calls).toHaveLength(1);
    expect(driver.calls[0]?.remainingMs).toBe(60_000);
  });

  it("平台报得出剩余时以它为准，不被本地记账覆盖", async () => {
    const driver = addDriver(IDLE);
    const { keepAlive } = make(driver);
    await keepAlive.keepAlive(IDLE);
    // 本地从没记过账（首次），但平台说满——听平台的，不续
    expect(driver.calls).toHaveLength(0);
  });

  it("查剩余抛错时退回本地记账，不当成一次失败", async () => {
    const calls: RenewCall[] = [];
    const driver: KeepAliveDriver = {
      remainingMs: async () => {
        throw new Error("network");
      },
      renew: async (targetMs, remainingMs) => {
        calls.push({ targetMs, remainingMs, at: Date.now() });
      },
    };
    const { keepAlive, renews } = make(driver);
    await keepAlive.keepAlive(IDLE);
    expect(calls).toHaveLength(1);
    expect(renews[0]?.ok).toBe(true);
  });
});

describe("KA-2 闸门：失败处理", () => {
  it("续期失败只走 onRenew({ok:false})，不抛出、不产生未处理拒绝", async () => {
    const driver = resetDriver();
    driver.failNext = new Error("sandbox gone");
    const { keepAlive, renews } = make(driver);
    await expect(keepAlive.keepAlive(IDLE)).resolves.toBeUndefined();
    expect(renews).toHaveLength(1);
    expect(renews[0]?.ok).toBe(false);
    expect(renews[0]?.error).toBeInstanceOf(Error);
  });

  it("成功时 onRenew 带上预计到期时刻，供宿主同步自己的账", async () => {
    const driver = resetDriver();
    const { keepAlive, renews } = make(driver);
    await keepAlive.keepAlive(IDLE);
    expect(renews[0]).toMatchObject({ ok: true, trigger: "manual" });
    expect(renews[0]?.expiresAt).toBe(Date.now() + IDLE);
  });
});

describe("KA-2 闸门：exec 期间自打点", () => {
  it("远程调用进行期间按 idleTimeout/2 续期，结束就停", async () => {
    const driver = thirstyDriver();
    const { keepAlive } = make(driver);
    const stop = keepAlive.beginExec();

    await vi.advanceTimersByTimeAsync(TICK);
    expect(driver.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(TICK);
    expect(driver.calls).toHaveLength(2);

    stop();
    await vi.advanceTimersByTimeAsync(TICK * 3);
    expect(driver.calls).toHaveLength(2);
  });

  it("triggers 标成 exec", async () => {
    const driver = thirstyDriver();
    const { keepAlive, renews } = make(driver);
    const stop = keepAlive.beginExec();
    await vi.advanceTimersByTimeAsync(TICK);
    stop();
    expect(renews[0]?.trigger).toBe("exec");
  });

  it("并发的多次 exec 共用一个定时器，最后一个结束才停", async () => {
    const driver = thirstyDriver();
    const { keepAlive } = make(driver);
    const stopA = keepAlive.beginExec();
    const stopB = keepAlive.beginExec();

    await vi.advanceTimersByTimeAsync(TICK);
    expect(driver.calls).toHaveLength(1); // 两个 exec 只打一次网络，不是两次

    stopA();
    await vi.advanceTimersByTimeAsync(TICK);
    expect(driver.calls).toHaveLength(2); // B 还在跑

    stopB();
    await vi.advanceTimersByTimeAsync(TICK * 3);
    expect(driver.calls).toHaveLength(2);
  });

  it("停止函数幂等：重复调用不会把引用计数弄乱", async () => {
    const driver = thirstyDriver();
    const { keepAlive } = make(driver);
    const stopA = keepAlive.beginExec();
    const stopB = keepAlive.beginExec();

    stopA();
    stopA();
    stopA();
    await vi.advanceTimersByTimeAsync(TICK);
    expect(driver.calls).toHaveLength(1); // B 仍在跑

    stopB();
    await vi.advanceTimersByTimeAsync(TICK * 2);
    expect(driver.calls).toHaveLength(1);
  });
});

describe("KA-2 闸门：活动信号", () => {
  it("progress 信号触发一次补足", async () => {
    const driver = thirstyDriver();
    const { keepAlive, renews } = make(driver);
    keepAlive.onActivity(signal("progress"));
    await vi.advanceTimersByTimeAsync(0);
    expect(driver.calls).toHaveLength(1);
    expect(renews[0]?.trigger).toBe("activity");
  });

  it("密集的 progress 信号被补足语义挡掉，不会每条都打网络", async () => {
    const driver = resetDriver();
    const { keepAlive } = make(driver);
    for (let i = 0; i < 20; i++) {keepAlive.onActivity(signal("progress"));}
    await vi.advanceTimersByTimeAsync(0);
    expect(driver.calls).toHaveLength(1);
  });
});

describe("KA-2 闸门：审批状态机", () => {
  const generousBudget = { approvalBudgetMs: 10 * 60_000 };

  it("awaiting-approval 起审批打点，progress 立刻停掉它", async () => {
    const driver = thirstyDriver();
    const { keepAlive } = make(driver, generousBudget);

    keepAlive.onActivity(signal("awaiting-approval"));
    await vi.advanceTimersByTimeAsync(0);
    expect(driver.calls).toHaveLength(1); // 进入时立刻补一次

    await vi.advanceTimersByTimeAsync(TICK);
    expect(driver.calls).toHaveLength(2);

    keepAlive.onActivity(signal("progress"));
    await vi.advanceTimersByTimeAsync(0);
    const afterLeave = driver.calls.length;
    await vi.advanceTimersByTimeAsync(TICK * 3);
    expect(driver.calls).toHaveLength(afterLeave); // 审批打点已停
  });

  it("审批期间的续期标成 approval，便于宿主分辨钱花在哪", async () => {
    const driver = thirstyDriver();
    const { keepAlive, renews } = make(driver, generousBudget);
    keepAlive.onActivity(signal("awaiting-approval"));
    await vi.advanceTimersByTimeAsync(0);
    expect(renews[0]?.trigger).toBe("approval");
  });

  it("审批预算配 0：等人期间一次都不续", async () => {
    const driver = thirstyDriver();
    const { keepAlive } = make(driver, { approvalBudgetMs: 0 });

    keepAlive.onActivity(signal("awaiting-approval"));
    await vi.advanceTimersByTimeAsync(TICK * 5);
    expect(driver.calls).toHaveLength(0);
  });

  it("审批预算耗尽后自己停，不用等 progress", async () => {
    const driver = thirstyDriver();
    const { keepAlive } = make(driver, { approvalBudgetMs: TICK + 1_000 });

    keepAlive.onActivity(signal("awaiting-approval"));
    await vi.advanceTimersByTimeAsync(TICK * 6);
    const settled = driver.calls.length;

    await vi.advanceTimersByTimeAsync(TICK * 6);
    expect(driver.calls).toHaveLength(settled);
  });

  it("重复的 awaiting-approval（并行工具各发一个）不会起出多个定时器", async () => {
    const driver = thirstyDriver();
    const { keepAlive } = make(driver, generousBudget);

    keepAlive.onActivity(signal("awaiting-approval"));
    keepAlive.onActivity(signal("awaiting-approval"));
    keepAlive.onActivity(signal("awaiting-approval"));
    await vi.advanceTimersByTimeAsync(0);
    const afterEnter = driver.calls.length;

    await vi.advanceTimersByTimeAsync(TICK);
    expect(driver.calls.length - afterEnter).toBe(1); // 一个定时器就该只多一次
  });

  it("新的一轮开始时，上一轮遗留的审批打点被清掉", async () => {
    const driver = thirstyDriver();
    const { keepAlive } = make(driver, generousBudget);

    keepAlive.onActivity(signal("awaiting-approval", 1));
    await vi.advanceTimersByTimeAsync(0);
    keepAlive.onActivity(signal("progress", 2)); // 新一轮
    await vi.advanceTimersByTimeAsync(0);
    const settled = driver.calls.length;

    await vi.advanceTimersByTimeAsync(TICK * 3);
    expect(driver.calls).toHaveLength(settled);
  });
});

describe("KA-2 闸门：单轮保活上限", () => {
  it("超过 maxTurnMs 之后 activity 不再续期", async () => {
    const driver = thirstyDriver();
    const { keepAlive } = make(driver, { maxTurnMs: 60_000 });

    keepAlive.onActivity(signal("progress"));
    await vi.advanceTimersByTimeAsync(0);
    expect(driver.calls).toHaveLength(1);

    vi.setSystemTime(Date.now() + 61_000);
    keepAlive.onActivity(signal("progress"));
    await vi.advanceTimersByTimeAsync(0);
    expect(driver.calls).toHaveLength(1);
  });

  it("超限后连 exec 打点也停", async () => {
    const driver = thirstyDriver();
    const { keepAlive } = make(driver, { maxTurnMs: 60_000 });

    keepAlive.onActivity(signal("progress"));
    await vi.advanceTimersByTimeAsync(0);
    const stop = keepAlive.beginExec();

    vi.setSystemTime(Date.now() + 61_000);
    const settled = driver.calls.length;
    await vi.advanceTimersByTimeAsync(TICK * 3);
    expect(driver.calls).toHaveLength(settled);
    stop();
  });

  it("新的一轮重置上限计时", async () => {
    const driver = thirstyDriver();
    const { keepAlive } = make(driver, { maxTurnMs: 60_000 });

    keepAlive.onActivity(signal("progress", 1));
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(Date.now() + 61_000);

    keepAlive.onActivity(signal("progress", 2));
    await vi.advanceTimersByTimeAsync(0);
    expect(driver.calls).toHaveLength(2);
  });

  it("手动 keepAlive 不受单轮上限约束（宿主明确要求的就照做）", async () => {
    const driver = thirstyDriver();
    const { keepAlive } = make(driver, { maxTurnMs: 60_000 });

    keepAlive.onActivity(signal("progress"));
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(Date.now() + 10 * 60_000);

    await keepAlive.keepAlive(IDLE);
    expect(driver.calls).toHaveLength(2);
  });
});
