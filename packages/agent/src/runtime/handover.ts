/**
 * [交权](../../../../docs/terms.md)在轮编排这一层的两半（docs/logic/orchestration/tech/handover.md §6、§7、§9）：
 *
 * - **交出方**（下线的节点）：挑接手节点、把收尾时交权的对话预留给它、登记并看护[工具收尾](../../../../docs/terms.md)、
 *   最后请它接手；
 * - **接手方**：读工具收尾的结果（过了截止时间就记成「结果未知」），交给恢复轮结清。
 *
 * 真正「一轮怎么停」在 core（交权信号）与 `turn.ts`；「一轮收尾之后接下来干什么」在 `queue.ts`。
 */
import type { CallOutcome, HandedOverCall, Settlement } from "@runko/core";

import { describeError } from "../logger.js";
import type { NodeRegistry } from "../nodes.js";
import type { TailOutcome, ToolTailRecord } from "../persistence.js";
import type { RuntimeContext } from "./context.js";
import { ABORT_REASON_USER } from "./reasons.js";
import type { ActiveTurn } from "./registry.js";

const LOG_SCOPE = "agent:handover";

/** 旧节点多久查一次「持有者要求停止」。入站已关，停止只能这样传过去（交权 · 技术方案 §9）。 */
const TAIL_STOP_POLL_MS = 1_000;
/** 工具收尾的截止时间 = 开始时刻 + 工具上限 + 这点余量（给写库、通知留的时间）。 */
const TAIL_DEADLINE_MARGIN_MS = 30_000;
/** 工具不限时（`toolTimeout: 0`）时收尾截止时间用的上限。 */
const UNBOUNDED_TAIL_DEADLINE_MS = 24 * 60 * 60_000;
/** 一次「请接手」最多等多久。它只是一次出站调用，慢了就当没答应，兜底由定时回捞接上。 */
const REQUEST_TAKEOVER_TIMEOUT_MS = 5_000;
/** 挑接手节点时最多问几个候选。 */
const MAX_CANDIDATES_PROBED = 3;
/** 要等的宿主钩子（`onToolTailFinished`、`onHandOff`）最多等多久。 */
const HOST_HOOK_TIMEOUT_MS = 10_000;

/** 旧节点在截止时间前没写回结果时，交给模型的那句话（交权 · 技术方案 §9 第二行）。 */
export const TAIL_UNKNOWN_MESSAGE =
  "The server that was running this tool went offline before it reported a result, so whether the command finished " +
  "(and what it changed) is unknown. Check the current state before running it again.";

/** 工具收尾期间用户按了停止：结果写成这句，恢复那一轮结清之后就停。 */
export const TAIL_STOPPED_MESSAGE = "Stopped by the user while this tool was still running.";

/** 交权相关的配置与这次下线的状态。没配交权的 runtime 也有它（`node` 缺省为 `"local"`），只是挑不到接手节点。 */
export interface HandoverContext {
  /** 本节点地址（同租约里的 `holder`）。 */
  node: string;
  releaseSeq: number;
  nodes: NodeRegistry | undefined;
  /** 宿主给的出站「请接手」。`conversationIds` 为空 = 只问一句「你现在接不接」。 */
  requestTakeover: ((node: string, conversationIds: string[]) => Promise<boolean>) | undefined;
  reservationTtlMs: number;
  nodeFreshMs: number;
  /** 这次下线挑到的接手节点。还没开始交权、或者一个都没挑到时是 `undefined`。 */
  target: string | undefined;
  /** 这次下线交出去（或标了待接手）的对话。`shutdown` 最后统一请接手。 */
  handedOff: Set<string>;
  /** 本节点上还在跑的工具收尾——每条是「跑完、写库、通知」那一整段。 */
  tails: Set<Promise<void>>;
}

/** 带超时地请一次接手。失败、超时、对方拒绝都算 `false`——兜底由待接手标记与定时回捞接上。 */
export async function requestTakeover(ctx: RuntimeContext, node: string, conversationIds: string[]): Promise<boolean> {
  const request = ctx.handover.requestTakeover;
  if (request === undefined) {return false;}
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request(node, conversationIds),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => {
          resolve(false);
        }, REQUEST_TAKEOVER_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    ctx.logger.warn(LOG_SCOPE, "takeover request failed", { node, count: conversationIds.length, error: describeError(error) });
    return false;
  } finally {
    if (timer !== undefined) {clearTimeout(timer);}
  }
}

/**
 * 挑接手节点（交权 · 技术方案 §7.2、§7.3）：从登记表按「序号更大 → 同序号」拿候选，逐个问一句「你现在接不接」，
 * 第一个答应的就是它。**接不接由对方看自己内存里的状态决定**——登记表有时差，同批下线的节点可能还显示正常。
 */
export async function pickTakeoverTarget(ctx: RuntimeContext): Promise<string | undefined> {
  const { nodes, node, releaseSeq, nodeFreshMs } = ctx.handover;
  if (nodes === undefined || ctx.handover.requestTakeover === undefined) {return undefined;}
  let candidates;
  try {
    candidates = await nodes.candidates({ node, releaseSeq }, { freshMs: nodeFreshMs });
  } catch (error) {
    ctx.logger.warn(LOG_SCOPE, "could not read the node registry; nobody to hand over to", { error: describeError(error) });
    return undefined;
  }
  for (const candidate of candidates.slice(0, MAX_CANDIDATES_PROBED)) {
    if (await requestTakeover(ctx, candidate.node, [])) {
      ctx.logger.info(LOG_SCOPE, "picked a takeover target", { target: candidate.node, releaseSeq: candidate.releaseSeq, load: candidate.load });
      return candidate.node;
    }
    ctx.logger.info(LOG_SCOPE, "candidate declined the takeover (it is probably leaving too)", { candidate: candidate.node });
  }
  ctx.logger.warn(LOG_SCOPE, "no node accepted the takeover; conversations will wait for the periodic sweep", {
    candidates: candidates.length,
  });
  return undefined;
}

/**
 * 一轮以[已交权](../../../../docs/terms.md)收尾时的放手——取代普通的 `grant.release()`。**顺序是硬要求**：
 *
 * 1. 工具收尾先登记：接手的一方一抢到归属就要读得到它，否则会把那次悬空调用当成「在等人」；
 * 2. 打[待接手](../../../../docs/terms.md)标记：接下来无论请接手成没成，定时回捞都兜得住；
 * 3. 放手：挑到了接手节点就[交接预留](../../../../docs/terms.md)给它，预留期内谁也抢不走；否则普通放手。
 */
export async function handOffSettledTurn(ctx: RuntimeContext, turn: ActiveTurn): Promise<void> {
  const { conversationId } = turn;
  const startedAt = Date.now();
  // **每一步单独兜底**：任何一步失败都不能跳过放手——不放手，这份对话就被一个要退出的进程占着。
  // 收尾记录没登记上的调用，接手的一方会直接记成「结果未知」（见 `readTailSettlement` 的调用方）。
  for (const call of turn.handedOverCalls) {
    try {
      await beginTail(ctx, turn, call, startedAt);
    } catch (error) {
      ctx.logger.error(LOG_SCOPE, "could not register a tool tail; the taker will record its result as unknown", {
        conversationId,
        callId: call.callId,
        error: describeError(error),
      });
    }
  }
  await markAwaitingTakeover(ctx, conversationId);
  await runHostHook(ctx, conversationId, "onHandOff", () => ctx.hooks.onHandOff?.({ conversationId }));
  const target = ctx.handover.target;
  try {
    if (target !== undefined && turn.grant.releaseTo !== undefined) {
      await turn.grant.releaseTo(target, { ttlMs: ctx.handover.reservationTtlMs });
    } else {
      await turn.grant.release();
    }
  } catch (error) {
    ctx.logger.error(LOG_SCOPE, "releasing the handed-over conversation failed; it frees up when the lease expires", {
      conversationId,
      error: describeError(error),
    });
  }
  ctx.handover.handedOff.add(conversationId);
  ctx.logger.info(LOG_SCOPE, "turn handed over", {
    conversationId,
    target,
    runningTools: turn.handedOverCalls.map((call) => call.callId).join(","),
  });
  // 放手之后**马上**请接手，不等别的轮：预留期内这份对话的请求都被转给接手节点，它越早接上，
  // 用户的「停止」「发消息」越不会落空。`shutdown` 最后那次批量请求照发一遍，兜住这次没成的。
  if (target !== undefined) {await requestTakeover(ctx, target, [conversationId]);}
}

async function beginTail(ctx: RuntimeContext, turn: ActiveTurn, call: HandedOverCall, startedAt: number): Promise<void> {
  const tails = ctx.persistence.tails;
  if (tails === undefined) {return;}
  // 工具不限时：截止时间给得很宽——旧节点要是真没了，最终由它兜底记成「结果未知」。
  const deadline = startedAt + (ctx.toolTimeoutMs ?? UNBOUNDED_TAIL_DEADLINE_MS) + TAIL_DEADLINE_MARGIN_MS;
  await tails.begin({
    conversationId: turn.conversationId,
    toolCallId: call.callId,
    toolName: call.toolName,
    runner: ctx.handover.node,
    startedAt,
    deadline,
  });
  watchTail(ctx, turn, call);
}

/**
 * 看护一条在本节点上跑的工具收尾：定时查停止标记（查到就杀掉工具），跑完把结果写库、打待接手标记、
 * 通知接手节点。结果**只在那一行还空着时写得进**——截止时间过了、持有者已经记成「未知」的话，这次结果丢弃。
 */
function watchTail(ctx: RuntimeContext, turn: ActiveTurn, call: HandedOverCall): void {
  const tails = ctx.persistence.tails;
  if (tails === undefined) {return;}
  const { conversationId } = turn;
  let stopRequested = false;
  const poll = setInterval(() => {
    void tails
      .get(conversationId, call.callId)
      .then((record) => {
        if (record?.stopRequested !== true || stopRequested) {return;}
        stopRequested = true;
        ctx.logger.info(LOG_SCOPE, "stop requested for a tool tail; stopping the tool", { conversationId, callId: call.callId });
        turn.abortController.abort(new Error(ABORT_REASON_USER));
      })
      .catch((error: unknown) => {
        ctx.logger.warn(LOG_SCOPE, "could not check the tool tail's stop flag", { conversationId, error: describeError(error) });
      });
  }, TAIL_STOP_POLL_MS);
  if (typeof poll.unref === "function") {poll.unref();}

  const done = call.outcome
    .then(async (outcome) => {
      clearInterval(poll);
      await runTailFinishedHook(ctx, conversationId, call);
      const final: TailOutcome = stopRequested ? { kind: "error", errorText: TAIL_STOPPED_MESSAGE } : toTailOutcome(outcome);
      const written = await tails.complete(conversationId, call.callId, final, Date.now());
      if (!written) {
        ctx.logger.warn(LOG_SCOPE, "tool tail finished too late; its result was discarded", { conversationId, callId: call.callId });
        return;
      }
      ctx.logger.info(LOG_SCOPE, "tool tail finished; result recorded", { conversationId, callId: call.callId, kind: final.kind });
      await markAwaitingTakeover(ctx, conversationId);
      const target = ctx.handover.target;
      if (target !== undefined) {await requestTakeover(ctx, target, [conversationId]);}
    })
    .catch((error: unknown) => {
      clearInterval(poll);
      ctx.logger.error(LOG_SCOPE, "recording a tool tail's result failed; the sweep will mark it unknown after its deadline", {
        conversationId,
        callId: call.callId,
        error: describeError(error),
      });
    });
  ctx.handover.tails.add(done);
  void done.finally(() => ctx.handover.tails.delete(done));
}

async function runTailFinishedHook(ctx: RuntimeContext, conversationId: string, call: HandedOverCall): Promise<void> {
  await runHostHook(ctx, conversationId, "onToolTailFinished", () =>
    ctx.hooks.onToolTailFinished?.({ conversationId, callId: call.callId, toolName: call.toolName }),
  );
}

/** 调一个要等的宿主钩子：最多等几秒，抛错或超时只记日志。 */
async function runHostHook(
  ctx: RuntimeContext,
  conversationId: string,
  name: string,
  run: () => void | Promise<void> | undefined,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve(run()),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, HOST_HOOK_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    ctx.logger.warn(LOG_SCOPE, `${name} hook failed`, { conversationId, error: describeError(error) });
  } finally {
    if (timer !== undefined) {clearTimeout(timer);}
  }
}

function toTailOutcome(outcome: CallOutcome): TailOutcome {
  return outcome.kind === "output" ? { kind: "output", output: outcome.output } : outcome;
}

export async function markAwaitingTakeover(ctx: RuntimeContext, conversationId: string): Promise<void> {
  try {
    await ctx.arbitration.markAwaitingTakeover?.(conversationId);
  } catch (error) {
    ctx.logger.warn(LOG_SCOPE, "could not mark the conversation as awaiting takeover", { conversationId, error: describeError(error) });
  }
}

/** 接手方读一条工具收尾：有结果就交给恢复轮；还在跑就返回 `undefined`；过了截止时间没结果就记成「结果未知」。 */
export async function readTailSettlement(
  ctx: RuntimeContext,
  record: ToolTailRecord,
): Promise<{ settlement: Settlement; stopAfterSettle: boolean } | undefined> {
  let outcome = record.outcome;
  if (outcome === undefined) {
    if (Date.now() < record.deadline) {return undefined;}
    const unknown: TailOutcome = { kind: "error", errorText: TAIL_UNKNOWN_MESSAGE };
    const written = (await ctx.persistence.tails?.complete(record.conversationId, record.toolCallId, unknown, Date.now())) ?? false;
    // 没写进去说明旧节点刚好赶在这一刻写回了结果——以它为准。
    outcome = written ? unknown : ((await ctx.persistence.tails?.get(record.conversationId, record.toolCallId))?.outcome ?? unknown);
    if (written) {
      ctx.logger.warn(LOG_SCOPE, "tool tail missed its deadline; recorded its result as unknown", {
        conversationId: record.conversationId,
        callId: record.toolCallId,
        runner: record.runner,
      });
    }
  }
  const settlement: Settlement = outcome.kind === "output" ? { kind: "output", output: outcome.output } : outcome;
  return { settlement, stopAfterSettle: record.stopRequested };
}
