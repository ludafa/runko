/**
 * **起轮与排队**——`enqueue` 的三路分流、[起轮占位](../../../../docs/terms.md)、收尾之后
 * 的[自动出队](../../../../docs/terms.md)，以及 [`conversation-drained`](../../../../docs/terms.md)
 * 那个竞态的兜底，全在这里实现**一次**。
 *
 * 这正是「队列归框架，策略归构建者」的落地点：**排不排队、上限几条、要不要插话**归
 * 构建者配（`QueueConfig`）；**队列的读写、收尾时取下一条、跟归属释放之间的竞态**归
 * 框架。构建者只调一句 `enqueue(conversationId, input)`，不需要知道有竞态这回事。
 */
import { pendingCallIds, resolveResumeTarget } from "@runko/core";
import type { RunkoUIMessage, Settlement } from "@runko/core";

import { describeError } from "../logger.js";
import type { DecisionRecord, DecisionStore } from "../persistence.js";
import type { EnqueueResult, Frame, QueuedInput, TurnInput } from "../types.js";
import type { RuntimeContext } from "./context.js";
import { appendInterruptedMarker, ledgerEndsWithPendingCalls, pendingCallIdsAtLedgerEnd, readLedgerEnd } from "./interrupted-marker.js";
import { settleOrphanedDecisionsSafely } from "./orphaned-decisions.js";
import { ASK_USER_TIMEOUT_MESSAGE } from "./ask-user.js";
import { ABORT_REASON_HOLDER_LOST } from "./reasons.js";
import { createActiveTurn } from "./registry.js";
import type { ActiveTurn } from "./registry.js";
import { driveTurn, nextTurnNumber } from "./turn.js";

const LOG_SCOPE = "agent:queue";

export interface EnqueueOptions {
  /** `'queue'`（默认）排队到下一轮，`'steer'` 插进当前这一轮。没有进行中的一轮时两者都起新轮。 */
  intent?: "queue" | "steer";
}

type StartOutcome =
  | { started: true }
  /** `awaiting_human`：账本末尾有[挂起](../../../../docs/terms.md)留下的悬空调用，只能等人答完、跑恢复轮。 */
  | { started: false; reason: "busy" | "shutting_down" | "held_by_other" | "awaiting_human"; holder?: string };

/**
 * 起一轮。
 *
 * **[起轮占位](../../../../docs/terms.md)是装配的第一件事**（`arbitration.acquire` +
 * 登记），不是装配完才登记：装配可能要好几秒（取沙盒、扫 skill），这段窗口里若登记表
 * 是空的，用户按停止会被当成「没有轮可停」，同会话后来的消息会被当成「可以起新轮」
 * ——两个都是错的。
 */
export async function startTurn(ctx: RuntimeContext, conversationId: string, input: TurnInput): Promise<StartOutcome> {
  if (ctx.isShuttingDown()) {return { started: false, reason: "shutting_down" };}
  if (ctx.registry.has(conversationId)) {return { started: false, reason: "busy" };}

  const acquired = await ctx.arbitration.acquire(conversationId, {
    seedSeq: () => ctx.persistence.ledger.maxSeq(conversationId),
  });
  if (!acquired.ok) {
    // 本进程自己已经在跑 = `busy`（409）；别的节点持有 = `held_by_other`（**转发**，
    // 不是错误）。两者处置完全不同，混报的话宿主很可能把第三种当成错误返回给用户。
    const local = ctx.registry.has(conversationId);
    return local
      ? { started: false, reason: "busy" }
      : { started: false, reason: "held_by_other", ...(acquired.holder !== undefined ? { holder: acquired.holder } : {}) };
  }

  // 记下这次的 holder：`subscribe` 靠它把「本进程正在收尾」与「归属在别的副本」分开。
  ctx.registry.lastHolder = acquired.grant.holder;
  const turn = createActiveTurn({
    conversationId,
    grant: acquired.grant,
    input,
    turnNumber: 1,
    ...(acquired.takeover !== undefined ? { takeover: acquired.takeover } : {}),
  });
  ctx.registry.set(turn);

  // **有悬空调用的会话不能开普通轮**：挂起那一轮在账本末尾留了一次「发出去了、还没结果」的
  // 调用，后面再接一条用户消息，模型服务商会直接 400（挂起与恢复 · 技术方案 §5.3 的实测）。
  // 所以这时只入队、不起轮，等人答完由恢复轮收尾时再出队。
  //
  // 必须查在**抢到归属之后**：这时别的副本写不进这份账本，查到什么就是什么。查在前面的话，
  // 查完到抢到之间别的副本可能刚好挂起了一轮——然后这里照常起轮、把用户消息追加在悬空调用
  // 后面，这份账本就再也恢复不了了。
  // 也必须在登记之后：查的这一次打库期间，本进程同会话的另一条请求要看到「有人在跑」而排队，
  // 而不是去抢归属、抢不到又把自己误报成 `held_by_other`。
  let awaitingHuman: boolean;
  try {
    awaitingHuman = await ledgerEndsWithPendingCalls(ctx.persistence, conversationId);
  } catch (error) {
    await backOut(ctx, turn);
    throw error;
  }
  if (awaitingHuman) {
    await backOutWaiting(ctx, turn);
    await resumeIfAnsweredMeanwhile(ctx, conversationId);
    return { started: false, reason: "awaiting_human" };
  }

  publish(ctx, conversationId, { kind: "activity", active: true, ...(acquired.grant.holder !== "" ? { holder: acquired.grant.holder } : {}) });

  // 刻意不 await：一轮的寿命与任何一个请求都无关——调用方只负责把它**启动**起来，
  // 内容走 `subscribe`。**必须接 `.catch`**：`runToCompletion` 内部虽已逐步兜底，
  // 但一个没接住的 rejection 在 Node 默认的 `--unhandled-rejections=throw` 下会直接
  // 把进程带走，那比丢一轮严重得多。
  void runToCompletion(ctx, turn).catch((error: unknown) => {
    ctx.logger.error(LOG_SCOPE, "turn settle path rejected unexpectedly", {
      conversationId,
      error: describeError(error),
    });
  });
  return { started: true };
}

/**
 * 起轮占位之后又决定不起了：撤登记、还归属。**撤登记必须在还归属之前**，理由同收尾第③步。
 * 还归属失败只记一行——占着的归属会随租约过期自己放掉，不值得为它把调用方打挂。
 */
async function backOut(ctx: RuntimeContext, turn: ActiveTurn): Promise<void> {
  ctx.registry.delete(turn);
  try {
    await turn.grant.release();
  } catch (error) {
    ctx.logger.error(LOG_SCOPE, "failed to release ownership after backing out of a turn", {
      conversationId: turn.conversationId,
      error: describeError(error),
    });
  }
  turn.markSettled();
}

/**
 * 这一轮以[挂起](../../../../docs/terms.md)收尾时，还没注入的插话只活在它的内存里，一收尾就没了——而用户
 * 已经被告知「插进去了」。挂起之后又不能把它们追加进账本（悬空调用后面接用户消息会 400），所以转进
 * 待发队列：人答完、恢复那一轮收尾后，它们作为普通消息发出（技术方案 §4.3）。
 *
 * 不受队列上限约束：这是把一条已经接下的消息换个地方放，不是新的入队请求。
 */
async function requeueUndeliveredSteers(ctx: RuntimeContext, turn: ActiveTurn): Promise<void> {
  const undelivered = turn.steered.slice(turn.steersDelivered);
  if (undelivered.length === 0) {return;}
  let queue: QueuedInput[] = [];
  for (const input of undelivered) {
    queue = (await ctx.persistence.queue.enqueue(turn.conversationId, input, { max: Number.MAX_SAFE_INTEGER, onFull: "reject" })).queue;
  }
  publish(ctx, turn.conversationId, { kind: "queue", queue });
  ctx.logger.info(LOG_SCOPE, "turn suspended before these steers reached the model; queued them for after the resume", {
    conversationId: turn.conversationId,
    count: undelivered.length,
  });
}

/**
 * 因为会话在等人（或无事可做）而撤回。这次抢归属要是**顶掉了**一个过期持有者，得先替它收尾：撤回就
 * 不会走 `runToCompletion`，那里的接管收尾永远轮不到；而租约行已经被这次覆盖，下一次抢归属也看不出
 * 曾经有人被顶掉。不收的话，它留下的孤儿行一直悬着（会话列表永远显示「在等你」）。
 */
async function backOutWaiting(ctx: RuntimeContext, turn: ActiveTurn): Promise<void> {
  if (turn.takeover !== undefined) {await settleDisplacedTurn(ctx, turn);}
  await backOut(ctx, turn);
}

/**
 * 驱动 + 全部收尾。**收尾的顺序是硬要求**，每一步的理由见行内注释。
 */
async function runToCompletion(ctx: RuntimeContext, turn: ActiveTurn): Promise<void> {
  const { conversationId } = turn;
  let status: Awaited<ReturnType<typeof driveTurn>>["status"] = "crashed";
  // **先替上一轮收尾，再开这一轮。** 必须在读账本之前：标记要排在这一轮的用户消息前面，
  // 回放时才读得通（「上一轮停了 → 你又说了一句」）。
  if (turn.takeover !== undefined) {
    await settleDisplacedTurn(ctx, turn);
  }
  try {
    // 轮号要等读过账本才知道——`driveTurn` 读完第一时间回填（`prepareTurn` 与钩子都要用）。
    const entries = await ctx.persistence.ledger.read(conversationId);
    turn.turnNumber = nextTurnNumber(entries);
    ({ status } = await driveTurn(ctx, turn));
  } catch (error) {
    // `driveTurn` 自己已经兜住了所有抛出，走到这里意味着**连它的兜底也抛了**。仍然必须
    // 把下面的收尾跑完——否则登记表里这一轮永不删除，这个会话就被永久锁死（此后所有
    // 消息只会排队、再也起不了轮）。
    ctx.logger.error(LOG_SCOPE, "turn driver rejected unexpectedly", {
      conversationId,
      error: describeError(error),
    });
  }

  // **每一步都单独兜底。** 这五步里有三步会碰宿主实现（流分发、归属仲裁、持久化），
  // 而契约明说它们遇到基础设施故障仍然抛。任何一步把异常放出去，后面几步就全被跳过：
  // 登记表里这一轮永不删除 → **这个会话被永久锁死**，此后所有消息只排队、再也起不了
  // 轮。所以宁可某一步失败，也要把剩下的跑完。
  const step = async (name: string, run: () => void | Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      ctx.logger.error(LOG_SCOPE, `settle step failed, continuing`, {
        conversationId,
        step: name,
        error: describeError(error),
      });
    }
  };

  // ① 防御性清挂起：正常情况下两个 Map 早就空了（core 自己在 `await` 那些 promise，
  //    还挂着就跑不到收尾）。还留着的是真泄漏，在这儿被拦下而不是永远悬着。
  await step("settle-pending", () =>
    ctx.human.settleAllPending(turn, "The turn this request belonged to has already ended."),
  );

  // ①½ 挂起时还没注入的插话转进待发队列。排在广播「没有轮在跑了」之前：订阅者收到那一帧就收线，
  //     队列快照要赶在它前面送到。
  if (status === "suspended") {
    await step("requeue-undelivered-steers", () => requeueUndeliveredSteers(ctx, turn));
  }

  // ② 先广播「没有轮在跑了」，再删登记——订阅者靠这一帧收线。
  turn.done = true;
  await step("publish-inactive", () => {
    publish(ctx, conversationId, { kind: "activity", active: false });
  });

  // 裁决表登记等齐再放手：挂起之后别的副本随时可能来恢复，它要读的那几行必须已经在库里。
  // 这些 promise 从不 reject（失败在里面记日志），`step` 只是一层保险。
  await step("await-decision-writes", async () => {
    await Promise.all(turn.decisionWrites);
  });

  // ③ 删登记 + 释放归属（[起轮标记](../../../../docs/terms.md)随之抹掉）。**必须在起下
  //    一轮之前**：`startTurn` 开头就有「已有进行中的一轮就拒绝」的守卫，顺序反了下一轮
  //    必然被自己这一轮挡掉。
  //    `registry.delete` 与 `markSettled` 都是同步的、不会抛，中间那步会碰宿主所以要兜。
  ctx.registry.delete(turn);
  await step("release-grant", () => turn.grant.release());
  turn.markSettled();

  // ④ 通知排在起下一轮**之前**：宿主的队列抑制逻辑要读的是「这一轮结束时队列里还有没有
  //    货」，而出队的第一件事就是把队首拿走。顺序反了，最后一条排队消息起轮时队列刚好
  //    空了，就会误报一次「跑完了」。
  try {
    ctx.hooks.onTurnSettled?.({ conversationId, turn: turn.turnNumber, status, input: turn.input });
  } catch (error) {
    ctx.logger.error(LOG_SCOPE, "onTurnSettled hook threw", { conversationId, error: describeError(error) });
  }

  // ⑤ 交棒：看这个会话接下来该干什么。同样兜一层——要碰持久化，抛错不该反噬到已经收好的这一轮。
  //    - 普通轮正常收尾（completed / failed / interrupted）：账本末尾不可能有悬空调用，直接出队。
  //    - 挂起了、或者这是一轮恢复：末尾可能还悬着，走 `advance`——有已经答过的就接着恢复，
  //      一个都没答就原地不动；**绝不出队普通消息**（技术方案 §4.3、§5.7）。
  //    - 这一轮是恢复、而它要结清的那个调用**还悬着**：**不立刻再试**。那说明这次恢复没做成——
  //      装配失败、生成器抛了、或者改写后的那条没写进账本。立刻再试就是热循环，而最后一种情况下
  //      工具已经执行过了，再试一次就**再执行一次**，一直循环下去。答案还在裁决表里，下一次有人
  //      推一把（比如用户又发了一条）时重来（技术方案 §5.8）。
  const mayBeSuspended = status === "suspended" || turn.resume !== undefined;
  if (!mayBeSuspended) {
    await step("start-next-queued", () => startNextQueued(ctx, conversationId));
  } else {
    await step("advance", async () => {
      const unfinished =
        turn.resume !== undefined &&
        (await pendingCallIdsAtLedgerEnd(ctx.persistence, conversationId)).includes(turn.resume.callId);
      if (unfinished) {
        ctx.logger.warn(LOG_SCOPE, "resume did not settle its call; not retrying until the next nudge", {
          conversationId,
          callId: turn.resume?.callId,
          status,
        });
      }
      await advance(ctx, conversationId, { resume: !unfinished });
    });
  }
}

/**
 * 起轮时顶掉了一个过期持有者：替它那一轮补「已停止」，并广播给已经挂在本进程上的订阅者
 * （不广播的话他们要等下次重连回放才看得到）。
 *
 * **失败只记一行，不拦这一轮**：补不上的后果是界面上少一个标记；为它把用户这一轮也搭进去
 * 不划算。取号被拒（`lost_ownership`）说明刚抢到就又丢了——那时 `grant.signal` 已经 abort，
 * `driveTurn` 一开头就会发现并走中断收尾（它挂监听之后会补查一次「是不是已经丢了」）。
 */
async function settleDisplacedTurn(ctx: RuntimeContext, turn: ActiveTurn): Promise<void> {
  const { conversationId } = turn;
  try {
    // 裁决表那一半：上一个持有者要是正在内存里等人，那一行再也不会有人结清了。它失败不能挡住下面补标记。
    await settleOrphanedDecisionsSafely(ctx.persistence, ctx.logger, conversationId);
    const marker = await appendInterruptedMarker(ctx.persistence, turn.grant, ABORT_REASON_HOLDER_LOST);
    if (!marker.written) {
      // 挂起中的会话不补标记——崩掉的是一次没做完的恢复，这是正常分支，不是故障。
      const log = marker.reason === "awaiting_human" ? ctx.logger.info : ctx.logger.warn;
      log.call(ctx.logger, LOG_SCOPE, "did not settle the displaced holder's turn", { conversationId, reason: marker.reason });
      return;
    }
    publish(ctx, conversationId, { kind: "message", seq: marker.seq, message: marker.message });
    ctx.logger.warn(LOG_SCOPE, "took over from a stale holder, settled its turn as interrupted", {
      conversationId,
      ...(turn.takeover?.holder !== undefined ? { previousHolder: turn.takeover.holder } : {}),
      seq: marker.seq,
    });
  } catch (error) {
    ctx.logger.error(LOG_SCOPE, "settling the displaced holder's turn threw", { conversationId, error: describeError(error) });
  }
}

/**
 * **推一把**：这个会话接下来该干什么。它是「收尾之后」「人答了之后」「挂起中来了消息」三处的
 * 共同入口（技术方案 §5.7）：
 *
 * 1. 本进程已经有轮在跑 → 不管，它收尾时会再推一把；
 * 2. 账本末尾有悬空调用 → 有已经答过的就开一轮恢复（`resume: false` 时连这个也不做）；
 *    **绝不出队普通消息**——那会把用户消息追加在悬空调用后面；
 * 3. 没有悬空调用 → 照旧出队。
 *
 * 第 2 步前面那次查是**不占归属**的粗筛（省掉普通会话每次都抢一回归属）；真正作数的那次在
 * `startResume` 里、抢到归属之后。
 */
export async function advance(ctx: RuntimeContext, conversationId: string, opts: { resume?: boolean } = {}): Promise<void> {
  if (ctx.isShuttingDown() || ctx.registry.has(conversationId)) {return;}
  if (await ledgerEndsWithPendingCalls(ctx.persistence, conversationId)) {
    if (opts.resume ?? true) {await startResume(ctx, conversationId);}
    return;
  }
  await startNextQueued(ctx, conversationId);
}

type ResumeStartOutcome = "started" | "busy" | "not_suspended" | "nothing_answered";

/**
 * 开一轮[恢复](../../../../docs/terms.md)：找账本末尾第一个**已经答过**的悬空调用，从裁决表读回答案，
 * 起一轮去结清它。
 *
 * 占位的顺序跟 `startTurn` 一样：先抢归属、先登记，再读——读的那几次打库期间本进程同会话的请求
 * 要看到「有人在跑」。读完发现无事可做就撤回。
 */
export async function startResume(
  ctx: RuntimeContext,
  conversationId: string,
  retriesLeft = MEANWHILE_RETRIES,
): Promise<ResumeStartOutcome> {
  if (ctx.isShuttingDown() || ctx.registry.has(conversationId)) {return "busy";}

  const acquired = await ctx.arbitration.acquire(conversationId, {
    seedSeq: () => ctx.persistence.ledger.maxSeq(conversationId),
  });
  // 抢不到就算了：占着的那一轮收尾时会自己推一把，读到这份答案（技术方案 §5.7「为什么不会漏」）。
  if (!acquired.ok) {return "busy";}

  ctx.registry.lastHolder = acquired.grant.holder;
  const turn = createActiveTurn({
    conversationId,
    grant: acquired.grant,
    input: { text: "" },
    turnNumber: 1,
    ...(acquired.takeover !== undefined ? { takeover: acquired.takeover } : {}),
  });
  ctx.registry.set(turn);

  let found: AnsweredCall | "not_suspended" | undefined;
  try {
    found = await findAnsweredCall(ctx, conversationId);
  } catch (error) {
    await backOut(ctx, turn);
    throw error;
  }
  if (found === "not_suspended") {
    await backOutWaiting(ctx, turn);
    return "not_suspended";
  }
  if (found === undefined) {
    await backOutWaiting(ctx, turn);
    // 放手之后再看一眼：我们占着归属读裁决表的那一段里，答案可能刚好写进来（见 `resumeIfAnsweredMeanwhile`）。
    if (retriesLeft > 0 && typeof (await findAnsweredCall(ctx, conversationId, { quiet: true })) === "object") {
      return await startResume(ctx, conversationId, retriesLeft - 1);
    }
    return "nothing_answered";
  }
  const picked = found;

  turn.resume = { callId: picked.callId, settlement: picked.settlement };
  turn.input = { text: "", ...(picked.decidedBy !== undefined ? { userId: picked.decidedBy } : {}) };
  publish(ctx, conversationId, { kind: "activity", active: true, ...(acquired.grant.holder !== "" ? { holder: acquired.grant.holder } : {}) });
  ctx.logger.info(LOG_SCOPE, "resuming suspended turn", { conversationId, callId: picked.callId, kind: picked.settlement.kind });
  void runToCompletion(ctx, turn).catch((error: unknown) => {
    ctx.logger.error(LOG_SCOPE, "resume turn settle path rejected unexpectedly", { conversationId, error: describeError(error) });
  });
  return "started";
}

/** 放手之后最多再接几次手。正常一次就够；上限只是防止两个副本来回让位时无穷递归。 */
const MEANWHILE_RETRIES = 3;

interface AnsweredCall {
  callId: string;
  settlement: Settlement;
  decidedBy: string | undefined;
}

/**
 * 账本末尾第一个**已经答过、而且答案对得上**的悬空调用。账本末尾没有悬空调用时返回
 * `"not_suspended"`，都还没答时返回 `undefined`。
 *
 * `quiet`：放手之后那次复查用——跳过的那几条上一次已经记过日志了，别再记一遍。
 */
async function findAnsweredCall(
  ctx: RuntimeContext,
  conversationId: string,
  opts: { quiet?: boolean } = {},
): Promise<AnsweredCall | "not_suspended" | undefined> {
  const tail = await readLedgerEnd(ctx.persistence, conversationId);
  const pending = pendingCallIds(tail);
  if (pending.length === 0) {return "not_suspended";}
  for (const callId of pending) {
    const record = await ctx.persistence.decisions.get(conversationId, callId);
    if (record?.decidedAt === undefined) {continue;}
    const settlement = settlementFromRecord(record);
    // 裁决表里的答案与账本里那个部件对不上（比如自定义工具在审批通过之后又调了
    // `ctx.suspend()`——它没有自己的那一行）：这一条 agent 层恢复不了，跳过，免得每推一把
    // 就起一轮必败的恢复（技术方案 §12 的已知限制）。
    if (!canResume(tail, callId, settlement)) {
      if (opts.quiet !== true) {
        ctx.logger.warn(LOG_SCOPE, "answered call cannot be resumed from its decision record; skipping", { conversationId, callId });
      }
      continue;
    }
    return { callId, settlement, decidedBy: record.decidedBy };
  }
  return undefined;
}

/**
 * **放手之后再看一眼裁决表**（技术方案 §5.7「为什么不会漏」）。
 *
 * 「不会漏」靠的是两边成对：写答案的一方「先写、再抢归属」，占着归属的一方「先放、再查答案」。
 * 因为某个会话在等人而撤回的那两条路（起普通轮时发现有悬空调用、开恢复轮时发现还没人答），
 * 原本是「先查、再放」：查的那一刻答案还没到，答案写进来、推一把时撞上我们占着，抢不到就走了，
 * 它不会再推第二次——而我们随后放手，谁也没接上。所以放手之后必须再查一次。
 *
 * 失败只记日志：它是补救，不是撤回本身的一部分；答案还在库里，下一次推一把照样读得到。
 */
async function resumeIfAnsweredMeanwhile(ctx: RuntimeContext, conversationId: string): Promise<void> {
  try {
    const found = await findAnsweredCall(ctx, conversationId, { quiet: true });
    if (typeof found === "object") {await startResume(ctx, conversationId);}
  } catch (error) {
    ctx.logger.error(LOG_SCOPE, "re-check after backing out failed; the next nudge will pick the answer up", {
      conversationId,
      error: describeError(error),
    });
  }
}

/** 裁决表里答过的一行 → core 的 `Settlement`。 */
function settlementFromRecord(record: DecisionRecord): Settlement {
  if (record.kind === "question") {
    // 提问只有 `answered` 一种正经结局；`timeout` 是停止或孤儿收拾留下的，不该出现在还悬着的调用上，
    // 真遇到就按「这一轮被停止了」那句交给模型。
    return { kind: "output", output: record.outcome === "answered" ? (record.message ?? "") : ASK_USER_TIMEOUT_MESSAGE };
  }
  if (record.outcome === "allow") {return { kind: "approval", behavior: "allow" };}
  return { kind: "approval", behavior: "deny", ...(record.message !== undefined ? { message: record.message } : {}) };
}

/** 这份答案能不能结清账本末尾那个部件——用 core 自己的判定，不在这里另写一套。 */
function canResume(tail: RunkoUIMessage[], callId: string, settlement: Settlement): boolean {
  try {
    resolveResumeTarget(tail, callId, settlement);
    return true;
  } catch {
    return false;
  }
}

/**
 * 人答了一个**已经不在本进程内存里**的等人项（挂起了，或者在别的副本上等着）：把答案写进裁决表
 * 那一行，然后推一把（技术方案 §5.7）。
 *
 * `false` = 接入层转 404，分四种：没有这一行；种类对不上（拿提问的答案去答审批）；**那次调用不在
 * 账本末尾悬着**；已经答过了。
 *
 * 「在账本末尾悬着」这一条挡住两种错答：孤儿行（崩溃留下的，答了也没有东西可恢复）；以及这一轮正被
 * 停止、停止那边还没把拒绝写进去的一瞬——那时写进一个「允许」，审计表就会与实际发生的相反。
 *
 * 已经答过、但那次调用还悬着（恢复没做成，比如装配失败）：照样返回 `false`，但**顺手推一把**——人再
 * 点一次，就是想让它接着跑。
 *
 * **写进去就算成功**，推不动（没抢到归属、打库失败）也返回 `true`：答案已经落库，占着的那一轮
 * 收尾时会读到，或者下一次推一把时读到。
 */
export async function answerSuspended(
  ctx: RuntimeContext,
  conversationId: string,
  callId: string,
  kind: DecisionRecord["kind"],
  settlement: Parameters<DecisionStore["settle"]>[2],
): Promise<boolean> {
  const record = await ctx.persistence.decisions.get(conversationId, callId);
  if (record === undefined || record.kind !== kind) {return false;}
  if (!(await pendingCallIdsAtLedgerEnd(ctx.persistence, conversationId)).includes(callId)) {return false;}
  if (record.decidedAt !== undefined) {
    await nudge(ctx, conversationId, callId);
    return false;
  }
  const settled = await ctx.persistence.decisions.settle(conversationId, callId, settlement);
  if (!settled) {return false;}
  await nudge(ctx, conversationId, callId);
  return true;
}

/** 推一把，失败只记日志：答案已经在库里，下一次推一把照样读得到。 */
async function nudge(ctx: RuntimeContext, conversationId: string, callId: string): Promise<void> {
  try {
    await advance(ctx, conversationId);
  } catch (error) {
    ctx.logger.error(LOG_SCOPE, "answer recorded but resume could not be started; the next nudge will pick it up", {
      conversationId,
      callId,
      error: describeError(error),
    });
  }
}

/**
 * [自动出队](../../../../docs/terms.md)：取[待发队列](../../../../docs/terms.md)队首起下一轮。
 *
 * **失败不吞消息**：起轮失败就 `requeueFront` 放回队首并记一行，**不重试、不设定时器**
 * ——靠「下一次有轮收尾」自然重试，避免沙盒持续不可用时后台无限重试烧钱。
 *
 * 两个例外**不放回**：会话已被停止过（用户按的就是停止，放回等于没停）、进程正在关闭
 * 时压根没出队。
 */
export async function startNextQueued(ctx: RuntimeContext, conversationId: string): Promise<void> {
  if (ctx.isShuttingDown()) {return;}
  if (ctx.registry.has(conversationId)) {return;}

  const { item, queue } = await ctx.persistence.queue.dequeue(conversationId);
  if (item === undefined) {
    // [`conversation-drained`](../../../../docs/terms.md)：一个**诚实的断言**——「我放手的
    // 时候队列是空的」。它不声称队列一定是空的；`enqueue` 那一侧的兜底负责另一半。
    return;
  }
  publish(ctx, conversationId, { kind: "queue", queue });

  ctx.logger.info(LOG_SCOPE, "dequeued input, starting next turn", { conversationId, itemId: item.id });
  const outcome = await startTurn(ctx, conversationId, item.input);
  if (outcome.started) {return;}

  if (outcome.reason === "shutting_down") {
    const restored = await ctx.persistence.queue.requeueFront(conversationId, item);
    publish(ctx, conversationId, { kind: "queue", queue: restored });
    ctx.logger.info(LOG_SCOPE, "shutting down, queued input put back", { conversationId, itemId: item.id });
    return;
  }
  if (outcome.reason === "awaiting_human") {
    // 挂起中：放回队首，等人答完、恢复轮收尾时再取。这是正常状态，不是故障。
    const restored = await ctx.persistence.queue.requeueFront(conversationId, item);
    publish(ctx, conversationId, { kind: "queue", queue: restored });
    ctx.logger.info(LOG_SCOPE, "conversation is waiting for a human, queued input put back", { conversationId, itemId: item.id });
    return;
  }
  // `busy`/`held_by_other`：别人已经在跑这个会话了——放回队首，那一轮收尾时会取到它。
  const restored = await ctx.persistence.queue.requeueFront(conversationId, item);
  publish(ctx, conversationId, { kind: "queue", queue: restored });
  ctx.logger.warn(LOG_SCOPE, "failed to start queued turn, input put back", {
    conversationId,
    itemId: item.id,
    reason: outcome.reason,
  });
}

/**
 * **一个函数管三种情况**（[技术方案 §6.1](../../../../docs/logic/orchestration/tech/agent-runtime.md)
 * 的判定表）：空闲就起新轮、忙就排队或插话、装配中一律排队。
 */
export async function enqueue(
  ctx: RuntimeContext,
  conversationId: string,
  input: TurnInput,
  opts: EnqueueOptions = {},
): Promise<EnqueueResult> {
  if (ctx.isShuttingDown()) {
    return { mode: "rejected", reason: "shutting_down", message: "The server is shutting down; retry shortly." };
  }

  const active = ctx.registry.get(conversationId);
  if (active !== undefined) {
    if (wantsSteer(ctx, input, opts) && active.phase === "running" && active.steer?.(input.text) === true) {
      active.steered.push(input);
      return { mode: "steered" };
    }
    // `steer` 报 false 有两种原因，处置不同：这一轮还卡在[起轮装配](../../../../docs/terms.md)
    // 里（`preparing`，还没有 session 可插）→ 转成排队，它收尾时会自动出队，用户的话不会丢；
    // 回落去起新一轮是**错的**（会被这一轮自己的占位挡成 busy）。另一种是「这一轮刚好
    // 结束」的窄竞态——那时登记表里已经没有它了，走不到这里。
    return await enqueueOnly(ctx, conversationId, input);
  }

  const outcome = await startTurn(ctx, conversationId, input);
  if (outcome.started) {return { mode: "started" };}
  if (outcome.reason === "shutting_down") {
    return { mode: "rejected", reason: "shutting_down", message: "The server is shutting down; retry shortly." };
  }
  if (outcome.reason === "awaiting_human") {
    // 挂起中来的新消息排队，等人答完再跑（技术方案 §9.3）。队列关着就只能拒——报 `busy`
    // 语义最近（会话不空闲），文案说清是在等人，不是「有轮在跑」。
    if (!ctx.queue.enabled) {
      return {
        mode: "rejected",
        reason: "busy",
        message: "This conversation is waiting for a person to answer a pending request; answer it first (queueing is disabled).",
      };
    }
    return await enqueueOnly(ctx, conversationId, input);
  }
  if (outcome.reason === "held_by_other") {
    // `holder` 既进 `message`（给人看）也单独出一个字段（给接入层转发用）。两者同源，
    // 但接入层只能用后者——把地址从文案里抠出来，等于让一句英文成为协议。
    return {
      mode: "rejected",
      reason: "held_by_other",
      message: `This conversation is owned by ${outcome.holder ?? "another node"}; forward the request there.`,
      ...(outcome.holder !== undefined ? { holder: outcome.holder } : {}),
    };
  }
  // `busy`：窄竞态——另一条请求在这两步之间抢先起了一轮。排队是正确回落。
  return await enqueueOnly(ctx, conversationId, input);
}

/** 只入队（+ 兜底推进），不尝试起轮。 */
async function enqueueOnly(ctx: RuntimeContext, conversationId: string, input: TurnInput): Promise<EnqueueResult> {
  if (!ctx.queue.enabled) {
    return { mode: "rejected", reason: "busy", message: "A turn is already running and queueing is disabled." };
  }
  const result = await ctx.persistence.queue.enqueue(conversationId, input, {
    max: ctx.queue.max,
    onFull: ctx.queue.onFull,
  });
  if (!result.ok) {
    return {
      mode: "rejected",
      reason: "queue_full",
      message: `The pending queue is full (max ${String(ctx.queue.max)}).`,
    };
  }
  publish(ctx, conversationId, { kind: "queue", queue: result.queue });

  // **入队方也负责推进**——`conversation-drained` 的另一半。上一轮可能恰好在「查完队列
  // 没活儿了」到「真正释放归属」之间，这条消息就落在缝里；这里补一脚，谁都没在跑就
  // 自己把它拉起来。抢不到就什么都不做（那说明确实有人在跑，它收尾时会看到）。
  // 挂起中也走这里：`advance` 会先看有没有已经答过、还没恢复的调用（比如上一次恢复轮失败了），
  // 用户发一条消息就顺手把它重试一遍。
  if (!ctx.registry.has(conversationId)) {
    void advance(ctx, conversationId).catch((error: unknown) => {
      ctx.logger.error(LOG_SCOPE, "drain fallback failed", { conversationId, error: describeError(error) });
    });
  }
  return { mode: "queued", queued: result.queued, queue: result.queue };
}

/**
 * 这条输入要不要插进正在跑的那一轮。见 `SteerPolicy`。
 *
 * **回调抛错一律当 `false`（排队）**：排队是安全的回落——用户的话进队列、这一轮收尾时
 * 自动出队，什么都不丢。让它往上抛会把整个 `enqueue` 打挂，那条消息就真没了；宿主写错
 * 一个策略回调不该有这种后果。
 */
function wantsSteer(ctx: RuntimeContext, input: TurnInput, opts: EnqueueOptions): boolean {
  const policy = ctx.queue.steer;
  if (policy === "never") {return false;}
  if (policy === "always") {return true;}
  if (policy === "onRequest") {return opts.intent === "steer";}
  try {
    return policy(input);
  } catch (error: unknown) {
    ctx.logger.error(LOG_SCOPE, "steer policy threw; falling back to queueing", { error: describeError(error) });
    return false;
  }
}

function publish(ctx: RuntimeContext, conversationId: string, frame: Frame): void {
  ctx.stream.publish(conversationId, frame);
}

/** 广播一份队列快照（删一条/清空之后用）。 */
export function publishQueue(ctx: RuntimeContext, conversationId: string, queue: QueuedInput[]): void {
  publish(ctx, conversationId, { kind: "queue", queue });
}
