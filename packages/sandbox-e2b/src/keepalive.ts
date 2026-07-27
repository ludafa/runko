/**
 * E2B 的[保活](../../../docs/terms.md)接线（docs/tech/sandbox-keepalive.md §5.5）。
 *
 * [续期闸门](../../../docs/terms.md)本身是通用的（`@nimbo/core` 的 `createKeepAlive`），
 * 这里只补上 E2B 独有的两件事：
 *
 * 1. **怎么查剩余**——查不了。E2B 没有「还剩多少」的属性（Vercel 有 `sandbox.timeout`），
 *    所以 `remainingMs()` 恒返回 `undefined`，闸门退回本地记账。因为 `setTimeout` 是
 *    **重置**语义，本地账不准的后果只是多续一次，不会让沙盒意外死掉。
 * 2. **怎么补**——`setTimeout(targetMs)` 直接把倒计时重置成 targetMs，天然幂等，
 *    不需要算差额（Vercel 那边是加时，必须算）。
 */
import type { KeepAlive, KeepAliveDriver, KeepAliveOptions } from "@nimbo/core";
import { createKeepAlive } from "@nimbo/core";
import type { E2bSandboxLike } from "./types.js";

/** 沙盒实例没有 `setTimeout` 时的指引——出现在这里说明宿主传了保活配置，但传进来的对象补不了期。 */
export const KEEPALIVE_UNSUPPORTED_MESSAGE =
  "e2bWorkspace({ keepAlive }) needs the sandbox instance to expose setTimeout(timeoutMs) — a real e2b " +
  "Sandbox does; a hand-written fake may not. Either pass a real sandbox, add setTimeout to the fake, or " +
  "drop the keepAlive option (keepalive is entirely opt-in).";

function createDriver(sandbox: E2bSandboxLike): KeepAliveDriver {
  return {
    // E2B 没有「还剩多少」的查询面——本地记账即可，见文件头。
    remainingMs: async () => undefined,
    renew: async (targetMs) => {
      if (sandbox.setTimeout === undefined) throw new Error(KEEPALIVE_UNSUPPORTED_MESSAGE);
      await sandbox.setTimeout(targetMs);
    },
  };
}

/**
 * 造一个绑好这个沙盒的保活器。`opts` 为 `undefined`（宿主没开保活）时返回
 * `undefined`——调用方据此整段跳过，**不开就是一次网络调用都不会发生**。
 */
export function createE2bKeepAlive(
  sandbox: E2bSandboxLike,
  opts: KeepAliveOptions | undefined,
): KeepAlive | undefined {
  if (opts === undefined) return undefined;
  // 提前失败：等到第一次续期才发现补不了期，那时错误会被闸门吞进 onRenew，很难查。
  if (sandbox.setTimeout === undefined) throw new Error(KEEPALIVE_UNSUPPORTED_MESSAGE);
  return createKeepAlive(createDriver(sandbox), opts);
}
