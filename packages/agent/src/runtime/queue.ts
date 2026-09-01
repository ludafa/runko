/**
 * **起轮与排队**——`enqueue` 的三路分流、[起轮占位](../../../../docs/terms.md)、收尾之后
 * 的[自动出队](../../../../docs/terms.md)，以及 [`conversation-drained`](../../../../docs/terms.md)
 * 那个竞态的兜底，全在这里实现**一次**。
 *
 * 这正是「队列归框架，策略归构建者」的落地点：**排不排队、上限几条、要不要插话**归
 * 构建者配（`QueueConfig`）；**队列的读写、收尾时取下一条、跟归属释放之间的竞态**归
 * 框架。构建者只调一句 `enqueue(conversationId, input)`，不需要知道有竞态这回事。
 */
import { describeError } from "../logger.js";
import type { EnqueueResult, Frame, QueuedInput, TurnInput } from "../types.js";
import type { RuntimeContext } from "./context.js";
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
  | { started: false; reason: "busy" | "shutting_down" | "held_by_other"; holder?: string };

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

  const turn = createActiveTurn({ conversationId, grant: acquired.grant, input, turnNumber: 1 });
  ctx.registry.set(turn);
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
 * 驱动 + 全部收尾。**收尾的顺序是硬要求**，每一步的理由见行内注释。
 */
async function runToCompletion(ctx: RuntimeContext, turn: ActiveTurn): Promise<void> {
  const { conversationId } = turn;
  let status: Awaited<ReturnType<typeof driveTurn>>["status"] = "crashed";
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

  // ② 先广播「没有轮在跑了」，再删登记——订阅者靠这一帧收线。
  turn.done = true;
  await step("publish-inactive", () => {
    publish(ctx, conversationId, { kind: "activity", active: false });
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

  // ⑤ 交棒：取队首起下一轮。同样兜一层——出队要碰持久化，抛错不该反噬到已经收好的这一轮。
  await step("start-next-queued", () => startNextQueued(ctx, conversationId));
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
  if (outcome.reason === "held_by_other") {
    return {
      mode: "rejected",
      reason: "held_by_other",
      message: `This conversation is owned by ${outcome.holder ?? "another node"}; forward the request there.`,
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
  if (!ctx.registry.has(conversationId)) {
    void startNextQueued(ctx, conversationId).catch((error: unknown) => {
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
