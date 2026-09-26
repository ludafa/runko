/**
 * 替**已经没人管的那一轮**补一条「已停止」标记——[孤儿轮](../../../../docs/terms.md)在
 * [账本](../../../../docs/terms.md)里的收尾。
 *
 * 三处调用，形状必须完全一致（界面靠同一个 `status` 显示「已停止」，只有理由文案不同）：
 *
 * | 调用方 | 什么时候 | 理由 |
 * |---|---|---|
 * | `recover()`（`runtime.ts`） | 进程启动时扫出的陈旧[起轮标记](../../../../docs/terms.md) | `ABORT_REASON_SHUTDOWN` |
 * | `settleDisplacedTurn()`（`queue.ts`，由 `runToCompletion` 调） | 起轮时顶掉了一个过期持有者（`AcquireResult.takeover`） | `ABORT_REASON_HOLDER_LOST` |
 * | `stopUnfinished()`（`runtime.ts`） | [交权](../../../../docs/terms.md)之后还没人接着跑，用户按了停止 | `ABORT_REASON_USER` |
 *
 * `settleDisplacedTurn` 存在的理由：多副本下常常是**别的副本先接手**，接手时租约行被覆盖，启动扫描此后再也
 * 扫不到那一轮。见[多副本部署 · 技术方案 §9](../../../../docs/host/node/tech/multi-replica.md)。
 *
 * **它只收账本这一半**，[裁决表](../../../../docs/terms.md)那一半由调用方另调
 * `settleOrphanedDecisionsSafely`（`./orphaned-decisions.js`）——两件事的判据不同，塞进一个函数会把
 * 职责搅浑。
 */
import { pendingCallIds } from "@runko/core";
import type { RunkoUIMessage } from "@runko/core";

import type { Grant } from "../arbitration.js";
import type { Persistence } from "../persistence.js";

export type InterruptedMarkerOutcome =
  | { written: true; seq: number; message: RunkoUIMessage }
  /** `awaiting_human`：账本末尾有悬空调用，这个会话还在挂起——不写（见文件头）。 */
  | { written: false; reason: "lost_ownership" | "rejected" | "awaiting_human" };

/**
 * ## 账本末尾有悬空调用时，不写
 *
 * 那说明这个会话正处于[挂起](../../../../docs/terms.md)状态，崩掉的是一次没做完的恢复轮——它开轮时
 * 账本末尾就是悬空调用，还没来得及落盘就没了。这时补一条标记会**永久弄坏这个会话**：标记成了最后
 * 一条，悬空调用就被埋在历史中间，此后每一次调模型都会 400。不写，这个会话就还在「挂起」，答案也
 * 还在裁决表里，下一次推一把会重新恢复。见
 * [挂起与恢复 · 技术方案](../../../../docs/logic/orchestration/tech/suspend-resume.md) §5.9。
 */
export async function appendInterruptedMarker(
  persistence: Persistence,
  grant: Grant,
  reason: string,
): Promise<InterruptedMarkerOutcome> {
  if (await ledgerEndsWithPendingCalls(persistence, grant.conversationId)) {
    return { written: false, reason: "awaiting_human" };
  }
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

/**
 * 账本末尾那条消息里有没有悬空调用。只读最后一条（取最大 seq、读它）——悬空调用只可能在
 * 那里（挂起与恢复 · 技术方案 §5.3）。起轮守卫、收尾标记、孤儿裁决行三处都靠它判断「这个会话是不是挂起着」。
 */
export async function ledgerEndsWithPendingCalls(persistence: Persistence, conversationId: string): Promise<boolean> {
  return (await pendingCallIdsAtLedgerEnd(persistence, conversationId)).length > 0;
}

/** 账本末尾那条消息里悬着的 callId。 */
export async function pendingCallIdsAtLedgerEnd(persistence: Persistence, conversationId: string): Promise<string[]> {
  return pendingCallIds(await readLedgerEnd(persistence, conversationId));
}

/**
 * 账本末尾说明这份对话**还没说完**：上一轮[交权](../../../../docs/terms.md)时停在模型输出段或两步之间，
 * 接手的一方要接着调模型（`continueTurn`）。判据是末尾那条的收尾状态为 `handed-over`、而且没有悬空调用
 * （有的话走恢复，不是这里）。core 在第一步就交权时也会补一条带这个状态的占位，所以只认它就够了。
 *
 * **不拿「末尾是用户消息」当判据**：持有者写完用户消息就崩了也是这个样子，那种情况归崩溃恢复补「已停止」。
 */
export function needsContinuation(tail: RunkoUIMessage[]): boolean {
  const last = tail[tail.length - 1];
  if (last === undefined) {return false;}
  if (pendingCallIds(tail).length > 0) {return false;}
  return last.metadata?.status === "handed-over";
}

/** 账本的最后一条（空账本是空数组）。两次打库：取最大 seq、读它。 */
export async function readLedgerEnd(persistence: Persistence, conversationId: string): Promise<RunkoUIMessage[]> {
  const maxSeq = await persistence.ledger.maxSeq(conversationId);
  if (maxSeq === 0) {return [];}
  const tail = await persistence.ledger.read(conversationId, { afterSeq: maxSeq - 1 });
  return tail.map((entry) => entry.message);
}
