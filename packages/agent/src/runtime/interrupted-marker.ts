/**
 * 替**已经没人管的那一轮**补一条「已停止」标记——[孤儿轮](../../../../docs/terms.md)的收尾。
 *
 * 两处调用，形状必须完全一致（界面靠同一个 `status` 显示「已停止」，只有理由文案不同）：
 *
 * | 调用方 | 什么时候 | 理由 |
 * |---|---|---|
 * | `runtime.recover()` | 进程启动时扫出的陈旧[起轮标记](../../../../docs/terms.md) | `ABORT_REASON_SHUTDOWN` |
 * | `runToCompletion`（`queue.ts`） | 起轮时顶掉了一个过期持有者（`AcquireResult.takeover`） | `ABORT_REASON_HOLDER_LOST` |
 *
 * 第二处存在的理由：多副本下常常是**别的副本先接手**，接手时租约行被覆盖，启动扫描此后再也
 * 扫不到那一轮。见[多副本部署 · 技术方案 §9](../../../../docs/host/node/tech/multi-replica.md)。
 */
import type { RunkoUIMessage } from "@runko/core";

import type { Grant } from "../arbitration.js";
import type { Persistence } from "../persistence.js";

export type InterruptedMarkerOutcome =
  | { written: true; seq: number; message: RunkoUIMessage }
  | { written: false; reason: "lost_ownership" | "rejected" };

export async function appendInterruptedMarker(
  persistence: Persistence,
  grant: Grant,
  reason: string,
): Promise<InterruptedMarkerOutcome> {
  const allocated = await grant.nextSeq();
  if (!allocated.ok) {return { written: false, reason: "lost_ownership" };}
  // 一条**只有 `step-start` 的 assistant 消息**承载收尾 metadata——形状与 core 自己在「首步
  // 之前就失败」时造的占位消息同源（`loop.ts` 的 `placeholder`），界面据 `status` 显示「已停止」。
  // **不能写空 parts**：ai 的 `validateUIMessages()` 拒绝它，而每一轮起轮都要拿整个账本过一次
  // 校验——写进去一条空的，这个会话此后永远起不了新轮。
  const message: RunkoUIMessage = {
    id: `turn-interrupted-${String(allocated.seq)}`,
    role: "assistant",
    parts: [{ type: "step-start" }],
    metadata: {
      usage: {},
      status: "interrupted",
      error: { code: "aborted", message: reason },
    },
  };
  const written = await persistence.ledger.append({
    conversationId: grant.conversationId,
    seq: allocated.seq,
    message,
    ts: Date.now(),
  });
  if (!written.ok) {return { written: false, reason: "rejected" };}
  return { written: true, seq: allocated.seq, message };
}
