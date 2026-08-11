/**
 * Vercel 的[保活](../../../docs/terms.md)接线（docs/host/sandbox-keepalive/tech.md §5.5）。
 *
 * [续期闸门](../../../docs/terms.md)本身是通用的（`@nimbo/core` 的 `createKeepAlive`），
 * 这里只补上 Vercel 独有的两件事——**两件都与 E2B 相反**：
 *
 * 1. **能查剩余**：`sandbox.expiresAt` 是「当前会话何时到期」的 `Date`，减掉此刻
 *    就是剩余量。E2B 没有对应属性，只能本地记账。
 *    ⚠️ 不是 `sandbox.timeout`——那个是建盒时配的默认时长，不是剩余量。
 * 2. **续期是加时不是重置**：`extendTimeout(duration)` 官方原文是 "Extends timeout
 *    **by** 5 minutes, to a total of 15 minutes"。所以「补足到 target」必须自己算
 *    差额；直接传 target 就成了在现有租期上再加 target。
 *
 * 第 2 条正是既有 bug 的成因：`sandbox-manager.ts` 曾把两家当同义词，
 * 每条用户消息都盲加 5 分钟，高频对话十几轮后沙盒多活几十分钟白计费
 * （docs/agent/turn-checkpoint/tech.md §5）。闸门的补足语义 + 这里的差额计算合起来修掉它。
 */
import type { KeepAlive, KeepAliveDriver, KeepAliveOptions } from "@nimbo/core";
import { createKeepAlive } from "@nimbo/core";
import type { VercelSandboxLike } from "./types.js";

/** 沙盒实例没有 `extendTimeout` 时的指引。 */
export const KEEPALIVE_UNSUPPORTED_MESSAGE =
  "vercelWorkspace({ keepAlive }) needs the sandbox instance to expose extendTimeout(duration) — a real " +
  "@vercel/sandbox Sandbox does; a hand-written fake may not. Either pass a real sandbox, add extendTimeout " +
  "to the fake, or drop the keepAlive option (keepalive is entirely opt-in).";

/**
 * 把「补足到 targetMs」翻译成 Vercel 的「加多少」。
 *
 * 剩余未知时按 0 算（加满一个 target）——保守方向：宁可多加一次，也不能因为高估
 * 剩余而让沙盒在我们以为还活着的时候停掉。剩余为负（已过期）同样按 0 算。
 * 算出 0 表示租期本就够长，直接不调（闸门通常已经挡住了，这里是第二道）。
 */
export function extensionFor(targetMs: number, remainingMs: number | undefined): number {
  const remaining = Math.max(0, remainingMs ?? 0);
  return Math.max(0, targetMs - remaining);
}

function createDriver(sandbox: VercelSandboxLike): KeepAliveDriver {
  return {
    remainingMs: async () => {
      const expiresAt = sandbox.expiresAt;
      return expiresAt === undefined ? undefined : expiresAt.getTime() - Date.now();
    },
    renew: async (targetMs, remainingMs) => {
      if (sandbox.extendTimeout === undefined) throw new Error(KEEPALIVE_UNSUPPORTED_MESSAGE);
      const extendBy = extensionFor(targetMs, remainingMs);
      if (extendBy <= 0) return;
      await sandbox.extendTimeout(extendBy);
    },
  };
}

/**
 * 造一个绑好这个沙盒的保活器。`opts` 为 `undefined`（宿主没开保活）时返回
 * `undefined`——调用方据此整段跳过，**不开就是一次网络调用都不会发生**。
 */
export function createVercelKeepAlive(
  sandbox: VercelSandboxLike,
  opts: KeepAliveOptions | undefined,
): KeepAlive | undefined {
  if (opts === undefined) return undefined;
  // 提前失败：等到第一次续期才发现补不了期，那时错误会被闸门吞进 onRenew，很难查。
  if (sandbox.extendTimeout === undefined) throw new Error(KEEPALIVE_UNSUPPORTED_MESSAGE);
  return createKeepAlive(createDriver(sandbox), opts);
}
