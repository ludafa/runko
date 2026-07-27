/**
 * E2B [保活](../../../docs/terms.md)接线验收测试 —— KA-2 的 E2B 专属部分。
 *
 * 规格见 docs/tech/sandbox-keepalive.md §5.5，验收清单见
 * docs/plans/sandbox-keepalive.md KA-2。
 *
 * [续期闸门](../../../docs/terms.md)本身（补足语义、审批状态机、两个上限）已在
 * `@nimbo/core` 的 `test/keepalive.test.ts` 里测透，这里只覆盖 E2B 这一层：
 * 开关是否真的可选、`setTimeout` 是不是按**重置**语义直接传目标值（不算差额）、
 * exec 期间有没有自打点、沙盒不支持时是否提前失败。
 *
 * 全程假时钟 + 进程内假沙盒，零网络零凭证。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { e2bWorkspace } from "../src/workspace.js";
import { KEEPALIVE_UNSUPPORTED_MESSAGE } from "../src/keepalive.js";
import { createFakeE2bSandbox } from "./helpers.js";
import type { E2bCommandResult, E2bSandboxLike } from "../src/types.js";

const IDLE = 300_000;
const TICK = IDLE / 2;

interface KeepAliveFake extends E2bSandboxLike {
  readonly timeoutCalls: number[];
  /** 让下一条命令挂起不返回，模拟一条跑很久的命令；调返回的函数把它放行。 */
  hangNextCommand(): () => void;
}

/**
 * 带 `setTimeout` 的最小假沙盒。文件面不实现真语义（本文件不碰文件工具），
 * 只保证 `e2bWorkspace()` 能把它包起来。
 */
function keepAliveFake(): KeepAliveFake {
  const timeoutCalls: number[] = [];
  let gate: Promise<void> | undefined;
  let openGate: (() => void) | undefined;

  const ok: E2bCommandResult = { exitCode: 0, stdout: "", stderr: "" };
  return {
    timeoutCalls,
    hangNextCommand() {
      gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
      return () => openGate?.();
    },
    files: {
      read: async () => new Uint8Array(),
      write: async (path) => ({ name: path, path }),
      list: async () => [],
      remove: async () => {},
      makeDir: async () => true,
      getInfo: async (path) => ({ name: path, type: "file", path, size: 0 }),
    },
    commands: {
      run: async () => {
        if (gate !== undefined) {
          const waiting = gate;
          gate = undefined;
          await waiting;
        }
        return ok;
      },
    },
    setTimeout: async (timeoutMs: number) => {
      timeoutCalls.push(timeoutMs);
    },
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

describe("KA-2 E2B：保活是纯 opt-in", () => {
  it("不传 keepAlive：工作区上根本没有 onActivity / keepAlive 两个方法", () => {
    const workspace = e2bWorkspace(keepAliveFake());
    expect(workspace.onActivity).toBeUndefined();
    expect(workspace.keepAlive).toBeUndefined();
  });

  it("不传 keepAlive：跑命令一次 setTimeout 都不会调", async () => {
    const sandbox = keepAliveFake();
    const workspace = e2bWorkspace(sandbox);
    await workspace.exec({ command: "echo hi", signal });
    expect(sandbox.timeoutCalls).toHaveLength(0);
  });

  it("传了 keepAlive：两个方法都挂上了", () => {
    const workspace = e2bWorkspace(keepAliveFake(), { keepAlive: { idleTimeoutMs: IDLE } });
    expect(typeof workspace.onActivity).toBe("function");
    expect(typeof workspace.keepAlive).toBe("function");
  });

  it("既有的假沙盒（没有 setTimeout）不传 keepAlive 时照常工作——最小结构面没被打破", async () => {
    const workspace = e2bWorkspace(createFakeE2bSandbox());
    await workspace.writeFile("/notes.txt", "hello");
    const bytes = await workspace.readFile("/notes.txt");
    expect(new TextDecoder().decode(bytes)).toBe("hello");
  });

  it("沙盒没有 setTimeout 却传了 keepAlive：构造时就抛，不拖到第一次续期才失败", () => {
    expect(() => e2bWorkspace(createFakeE2bSandbox(), { keepAlive: { idleTimeoutMs: IDLE } })).toThrow(
      KEEPALIVE_UNSUPPORTED_MESSAGE,
    );
  });
});

describe("KA-2 E2B：重置语义（不算差额）", () => {
  it("续期直接把目标值传给 setTimeout", async () => {
    const sandbox = keepAliveFake();
    const workspace = e2bWorkspace(sandbox, { keepAlive: { idleTimeoutMs: IDLE } });
    await workspace.keepAlive?.(IDLE);
    expect(sandbox.timeoutCalls).toEqual([IDLE]);
  });

  it("水位还满时不重复调——补足语义在 E2B 上同样生效", async () => {
    const sandbox = keepAliveFake();
    const workspace = e2bWorkspace(sandbox, { keepAlive: { idleTimeoutMs: IDLE } });
    await workspace.keepAlive?.(IDLE);
    await workspace.keepAlive?.(IDLE);
    await workspace.keepAlive?.(IDLE);
    expect(sandbox.timeoutCalls).toEqual([IDLE]);
  });
});

describe("KA-2 E2B：活动信号驱动", () => {
  it("progress 信号触发续期", async () => {
    const sandbox = keepAliveFake();
    const workspace = e2bWorkspace(sandbox, { keepAlive: { idleTimeoutMs: IDLE } });
    workspace.onActivity?.({ session: { id: "s1", turn: 1 }, reason: "progress" });
    await vi.advanceTimersByTimeAsync(0);
    expect(sandbox.timeoutCalls).toEqual([IDLE]);
  });

  it("onRenew 把每次真实续期报给宿主", async () => {
    const sandbox = keepAliveFake();
    const seen: { ok: boolean; trigger: string }[] = [];
    const workspace = e2bWorkspace(sandbox, {
      keepAlive: {
        idleTimeoutMs: IDLE,
        onRenew: (info) => seen.push({ ok: info.ok, trigger: info.trigger }),
      },
    });
    await workspace.keepAlive?.(IDLE);
    expect(seen).toEqual([{ ok: true, trigger: "manual" }]);
  });
});

describe("KA-2 E2B：exec 期间自打点（core 此刻零 chunk，只能靠适配器自己）", () => {
  it("一条跑很久的命令期间按 idleTimeout/2 续期，命令返回后停", async () => {
    const sandbox = keepAliveFake();
    const workspace = e2bWorkspace(sandbox, { keepAlive: { idleTimeoutMs: IDLE } });

    const release = sandbox.hangNextCommand();
    const running = workspace.exec({ command: "npm install", signal });

    await vi.advanceTimersByTimeAsync(TICK);
    expect(sandbox.timeoutCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(TICK);
    expect(sandbox.timeoutCalls).toHaveLength(2);

    release();
    await running;

    await vi.advanceTimersByTimeAsync(TICK * 3);
    expect(sandbox.timeoutCalls).toHaveLength(2); // 命令结束就不再续
  });

  it("命令失败/抛错时打点同样会被清掉（走 finally）", async () => {
    const sandbox = keepAliveFake();
    sandbox.commands.run = async () => {
      throw new Error("boom");
    };
    const workspace = e2bWorkspace(sandbox, { keepAlive: { idleTimeoutMs: IDLE } });

    await workspace.exec({ command: "explode", signal }); // 契约：不 reject，resolve 成非零
    await vi.advanceTimersByTimeAsync(TICK * 3);
    expect(sandbox.timeoutCalls).toHaveLength(0);
  });
});
