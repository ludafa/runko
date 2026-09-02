/**
 * Vercel [保活](../../../docs/terms.md)接线验收测试 —— KA-3。
 *
 * 规格见 docs/tech/sandbox-keepalive.md §5.5，验收清单见
 * docs/plans/sandbox-keepalive.md KA-3。
 *
 * [续期闸门](../../../docs/terms.md)本身（补足语义、审批状态机、两个上限）已在
 * `@runko/core` 的 `test/keepalive.test.ts` 里测透，这里只覆盖 Vercel 这一层——
 * 而这一层与 E2B **正好相反**的两点正是重点：
 *
 * 1. `extendTimeout` 是**加时**，所以要算差额；
 * 2. `expiresAt` 能查真实到期时刻（E2B 查不到）。
 *
 * 其中「连发多条消息租期不累加」是一条**回归测试**：既有实现把两家当同义词
 * （`sandbox-manager.ts` 的 `extendIdle`），每条消息盲加 5 分钟。
 *
 * 全程假时钟 + 进程内假沙盒，零网络零凭证。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extensionFor, vercelWorkspace } from "../src/index.js";
import { KEEPALIVE_UNSUPPORTED_MESSAGE } from "../src/keepalive.js";
import type { VercelSandboxLike } from "../src/types.js";

const IDLE = 300_000;
const TICK = IDLE / 2;

interface KeepAliveFake extends VercelSandboxLike {
  readonly extensions: number[];
  /** 平台侧的真实到期时刻，`extendTimeout` 会把它往后推——模拟「加时」语义。 */
  expiresAt: Date | undefined;
  hangNextCommand(): () => void;
}

/**
 * ⚠️ `initialRemainingMs` 刻意**没有默认值**：写成 `= IDLE` 的话，
 * `keepAliveFake(undefined)`（「这个沙盒报不出到期时刻」用例）会因为默认参数的语义
 * 反而拿到 IDLE，测出来的是满水位、一次都不续——施工中真踩过这个坑。
 */
function keepAliveFake(initialRemainingMs: number | undefined): KeepAliveFake {
  const extensions: number[] = [];
  let gate: Promise<void> | undefined;
  let openGate: (() => void) | undefined;

  const fake: KeepAliveFake = {
    extensions,
    expiresAt: initialRemainingMs === undefined ? undefined : new Date(Date.now() + initialRemainingMs),
    hangNextCommand() {
      gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
      return () => openGate?.();
    },
    fs: {
      readFile: async () => Buffer.from(""),
      writeFile: async () => {},
      readdir: async () => [],
      stat: async () => ({ isDirectory: () => false, isFile: () => true, size: 0, mtimeMs: 0 }),
      mkdir: async () => {},
      rm: async () => {},
      rmdir: async () => {},
    },
    runCommand: async () => {
      if (gate !== undefined) {
        const waiting = gate;
        gate = undefined;
        await waiting;
      }
      return { exitCode: 0 };
    },
    extendTimeout: async (duration: number) => {
      extensions.push(duration);
      // 真实平台语义：在**现有**到期时刻上加时，不是重置。
      const base = fake.expiresAt?.getTime() ?? Date.now();
      fake.expiresAt = new Date(base + duration);
    },
  };
  return fake;
}

/** 没有保活能力的沙盒（既有 fake 的形态）——用来证明最小结构面没被打破。 */
function bareFake(): VercelSandboxLike {
  const withKeepAlive = keepAliveFake(IDLE);
  return {
    fs: withKeepAlive.fs,
    runCommand: withKeepAlive.runCommand,
  };
}

const signal = new AbortController().signal;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("KA-3 Vercel：差额计算（加时语义的核心）", () => {
  it("剩余 1 分钟、目标 5 分钟 → 加 4 分钟", () => {
    expect(extensionFor(IDLE, 60_000)).toBe(240_000);
  });

  it("剩余未知 → 加满一个目标（保守方向：宁可多加，不能高估剩余）", () => {
    expect(extensionFor(IDLE, undefined)).toBe(IDLE);
  });

  it("剩余为负（已过期）按 0 算，加满一个目标", () => {
    expect(extensionFor(IDLE, -10_000)).toBe(IDLE);
  });

  it("剩余已超过目标 → 加 0（不调用）", () => {
    expect(extensionFor(IDLE, IDLE * 2)).toBe(0);
  });
});

describe("KA-3 Vercel：租期不累加（回归「每条消息盲加 5 分钟」）", () => {
  it("连调 10 次 keepAlive，租期稳定在目标水位，不递增", async () => {
    const sandbox = keepAliveFake(IDLE);
    const workspace = vercelWorkspace(sandbox, { keepAlive: { idleTimeoutMs: IDLE } });

    for (let i = 0; i < 10; i++) {await workspace.keepAlive?.(IDLE);}

    expect(sandbox.extensions).toHaveLength(0); // 一直满水位，一次都没打网络
    expect(sandbox.expiresAt?.getTime()).toBe(Date.now() + IDLE);
  });

  it("水位跌下去再补，补完仍是目标水位而不是叠加", async () => {
    const sandbox = keepAliveFake(IDLE);
    const workspace = vercelWorkspace(sandbox, { keepAlive: { idleTimeoutMs: IDLE } });

    vi.setSystemTime(Date.now() + IDLE * 0.5); // 剩余 50%，低于判定线
    await workspace.keepAlive?.(IDLE);

    expect(sandbox.extensions).toEqual([IDLE * 0.5]); // 只补差额
    expect(sandbox.expiresAt?.getTime()).toBe(Date.now() + IDLE); // 正好回到目标水位
  });
});

describe("KA-3 Vercel：保活是纯 opt-in", () => {
  it("不传 keepAlive：工作区上根本没有 onActivity / keepAlive", () => {
    const workspace = vercelWorkspace(keepAliveFake(IDLE));
    expect(workspace.onActivity).toBeUndefined();
    expect(workspace.keepAlive).toBeUndefined();
  });

  it("不传 keepAlive：跑命令一次 extendTimeout 都不会调", async () => {
    const sandbox = keepAliveFake(IDLE);
    const workspace = vercelWorkspace(sandbox);
    await workspace.exec({ command: "echo hi", signal });
    expect(sandbox.extensions).toHaveLength(0);
  });

  it("没有 extendTimeout 的沙盒不传 keepAlive 时照常工作", async () => {
    const workspace = vercelWorkspace(bareFake());
    const result = await workspace.exec({ command: "echo hi", signal });
    expect(result.exitCode).toBe(0);
  });

  it("没有 extendTimeout 却传了 keepAlive：构造时就抛", () => {
    expect(() => vercelWorkspace(bareFake(), { keepAlive: { idleTimeoutMs: IDLE } })).toThrow(
      KEEPALIVE_UNSUPPORTED_MESSAGE,
    );
  });
});

describe("KA-3 Vercel：expiresAt 查不到时退回本地记账", () => {
  it("沙盒不报 expiresAt 也能保活（首次加满，之后按本地账走）", async () => {
    const sandbox = keepAliveFake(undefined);
    const workspace = vercelWorkspace(sandbox, { keepAlive: { idleTimeoutMs: IDLE } });
    await workspace.keepAlive?.(IDLE);
    expect(sandbox.extensions).toEqual([IDLE]);
  });
});

describe("KA-3 Vercel：exec 期间自打点", () => {
  it("一条跑很久的命令期间按 idleTimeout/2 续期，命令返回后停", async () => {
    const sandbox = keepAliveFake(IDLE);
    const workspace = vercelWorkspace(sandbox, { keepAlive: { idleTimeoutMs: IDLE } });

    const release = sandbox.hangNextCommand();
    const running = workspace.exec({ command: "npm install", signal });

    await vi.advanceTimersByTimeAsync(TICK);
    expect(sandbox.extensions).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(TICK);
    expect(sandbox.extensions).toHaveLength(2);

    release();
    await running;

    await vi.advanceTimersByTimeAsync(TICK * 3);
    expect(sandbox.extensions).toHaveLength(2);
  });

  it("整个过程中租期始终维持在目标水位附近，不无限增长", async () => {
    const sandbox = keepAliveFake(IDLE);
    const workspace = vercelWorkspace(sandbox, { keepAlive: { idleTimeoutMs: IDLE } });

    const release = sandbox.hangNextCommand();
    const running = workspace.exec({ command: "long", signal });
    await vi.advanceTimersByTimeAsync(TICK * 6); // 跑满 3 个 idleTimeout
    release();
    await running;

    const remaining = (sandbox.expiresAt?.getTime() ?? 0) - Date.now();
    expect(remaining).toBeLessThanOrEqual(IDLE);
    expect(remaining).toBeGreaterThan(0);
  });
});

describe("KA-3 Vercel：活动信号驱动", () => {
  it("progress 信号在水位低时触发续期", async () => {
    const sandbox = keepAliveFake(60_000); // 只剩 1 分钟
    const workspace = vercelWorkspace(sandbox, { keepAlive: { idleTimeoutMs: IDLE } });
    workspace.onActivity?.({ session: { id: "s1", turn: 1 }, reason: "progress" });
    await vi.advanceTimersByTimeAsync(0);
    expect(sandbox.extensions).toEqual([240_000]);
  });
});
