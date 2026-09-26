/**
 * **一轮的一生**：装配 → 驱动 → 收尾。[起轮占位](../../../../docs/terms.md)已经由
 * `queue.ts` 的 `startTurn` 抢在这之前占下了（那是硬要求，见那边的注释）；本文件从
 * 「位子已经占住、可以开始装配」这一刻接手。
 *
 * `driveTurn` **从不 reject**——它返回「这一轮是怎么结束的」。所有抛出都在内部兜住并
 * 转成一条形状与 core 优雅失败同源的收尾帧，界面因此不需要多一个分支。
 */
import { randomUUID } from "node:crypto";
import type {
  AgentDefinition,
  ApprovalPolicy,
  ApprovalReviewer,
  RunkoChunk,
  RunkoMessageMetadata,
  RunkoUIMessage,
  SessionOptions,
  SessionState,
  Settlement,
  Tool,
  TurnResult,
} from "@runko/core";
import { sessionStateSchema } from "@runko/core";

import { describeError } from "../logger.js";
import type { LedgerEntry } from "../persistence.js";
import type { TurnPreparation } from "../prepare.js";
import type { Frame, TurnStatus } from "../types.js";
import type { RuntimeContext } from "./context.js";
import { createAskUserTool } from "./ask-user.js";
import type { ActiveTurn } from "./registry.js";
import { ledgerEndsWithPendingCalls } from "./interrupted-marker.js";
import { ABORT_DENY_MESSAGE, ABORT_REASON_USER, OWNERSHIP_LOST_MESSAGE } from "./reasons.js";
import { requeueInputFront } from "./requeue.js";
import type { DrivenSession } from "./session-factory.js";

const LOG_SCOPE = "agent:turn";

/**
 * 哪些 chunk 值得留进[进行中草稿](../../../../docs/terms.md)。
 *
 * 写成「除了这三类都留」而不是白名单：core 以后新增 chunk 类型时这条规则自动仍然
 * 正确，不需要这里跟着长一个 case。
 *
 * - `text-delta` / `reasoning-delta`：真正的流式增量，只直播不留（留了也没用——重连
 *   时整份重发，增量按顺序重放才有意义，而草稿是一次性整发的）。
 * - 显式标了 `transient: true` 的（今天只有 `data-tool-progress`）：同上。
 */
function isDurableChunk(chunk: RunkoChunk): boolean {
  if (chunk.type === "text-delta" || chunk.type === "reasoning-delta") {return false;}
  return !("transient" in chunk && chunk.transient === true);
}

/** 「用户在界面上看得见东西了」——第一段文字、第一段推理、或第一张工具调用卡片。 */
function isVisibleChunk(chunk: RunkoChunk): boolean {
  return chunk.type === "text-start" || chunk.type === "reasoning-start" || chunk.type === "tool-input-available";
}

/**
 * 从[账本](../../../../docs/terms.md)重建 `SessionState`。
 *
 * 三个标量字段全部**从账本自己推**，不另开一张会话头表：
 * - `id` 用 `conversationId`（稳定、跨进程一致）；
 * - `turn` 取全部消息 metadata 里最大的那个轮号——core 的 `finalizeTurn` 保证每一轮
 *   恰好把 `{turn, usage, status}` 落在该轮最后一条 assistant 消息的 `.metadata` 上；
 * - `createdAt` 用第一行的落盘时刻。
 *
 * **空账本也返回一个 state**（`messages: []`、`turn: 0`），不是 `undefined`：让 core 自己
 * mint 一个随机 session id 的话，同一个会话第一轮与后续轮的 `session.id` 会不一样，
 * 凡是拿它当关联键的东西（遥测的 `"<sessionId>#<turn>"`）都会在第一轮之后断掉。
 * 会话 id 本来就稳定且唯一，直接拿它当 session id。
 */
export function buildResumeState(conversationId: string, entries: readonly LedgerEntry[]): SessionState {
  // **滤掉 parts 为空的行**。ai 的 `validateUIMessages()` 拒绝空 parts，而这一步的结果
  // 每一轮都要过它一次——账本里只要有一条这样的行，这个会话就**永远起不了新轮**。
  //
  // 本包不再产出这种行（收尾标记改成了 `[{ type: "step-start" }]`），但 0.0.x 早期版本
  // 写下的存量行还在别人库里躺着，滤掉它们才能让那些会话自愈。丢掉也不损失什么：
  // 空 parts 的那条只承载 metadata，模型上下文里本来就看不到它。
  const messages = foldById(entries).filter((message) => message.parts.length > 0);
  const turn = entries.reduce((max, entry) => Math.max(max, entry.message.metadata?.turn ?? 0), 0);
  const createdAt = entries[0]?.ts ?? Date.now();
  // 复用 core 自己导出的 schema——这是反序列化边界（行可能来自 DB 的 JSON 列），
  // 与 core 内部 `createSession({resume})` 那次校验是纵深防御，不是冗余。
  return sessionStateSchema.parse({ id: conversationId, turn, messages, createdAt });
}

/**
 * 按 `message.id` 折叠账本：**位置取首次出现，内容取最新一条**（seq 最大的那条）。
 *
 * 同一个 id 出现两次只有一个来源：[恢复](../../../../docs/terms.md)轮原地改写了挂起那一轮的最后一条
 * 消息（结清了悬空调用），以新 seq 追加了一遍。不折叠的话同一个 `toolCallId` 会出现两次，模型服务商
 * 直接 400。见[挂起与恢复 · 技术方案](../../../../docs/logic/orchestration/tech/suspend-resume.md) §5.4。
 *
 * 这与直播流的规则一致——前端本来就按消息 id 覆盖、不追加。**宿主自己读账本**（`readLedger`、
 * `subscribe` 的回放）时拿到的是原始行，同一个 id 可能出现两次，要么用它折叠，要么按 id 覆盖。
 */
export function foldById(entries: readonly { message: RunkoUIMessage }[]): RunkoUIMessage[] {
  const positions = new Map<string, number>();
  const folded: RunkoUIMessage[] = [];
  for (const entry of entries) {
    const at = positions.get(entry.message.id);
    if (at === undefined) {
      positions.set(entry.message.id, folded.length);
      folded.push(entry.message);
    } else {
      folded[at] = entry.message;
    }
  }
  return folded;
}

/** 下一轮的轮号（1-based）——起轮占位时就要知道它，好交给 `prepareTurn`。 */
export function nextTurnNumber(entries: readonly LedgerEntry[]): number {
  return entries.reduce((max, entry) => Math.max(max, entry.message.metadata?.turn ?? 0), 0) + 1;
}

interface DriveResult {
  status: TurnStatus;
}

/** `finalize` 有没有把这一轮的成品消息全部写进账本。 */
type FinalizeOutcome = "complete" | "incomplete";

/** 系统异常给用户看的那句话：不含细节，细节只进日志。 */
const INTERNAL_ERROR_MESSAGE = "Internal error; this turn could not be completed.";

/**
 * 驱动一轮。**从不 reject**（见文件头）。
 *
 * 注意它不负责收尾登记（`registry.delete`、`grant.release`、出队起下一轮）——那些在
 * `queue.ts` 的 `startTurn` 里，顺序是硬要求。
 */
export async function driveTurn(ctx: RuntimeContext, turn: ActiveTurn): Promise<DriveResult> {
  const { conversationId } = turn;
  const startedAt = Date.now();
  const publish = (frame: Frame): void => {
    ctx.stream.publish(conversationId, frame);
  };

  // 「失去独占权」并进这一轮的中止信号——租约版下这条路走通了，走的就是既有的中断
  // 收尾，不需要任何新形状。内存版的 `grant.signal` 永不 abort，这一段是死代码，
  // 但接口上必须有它（不写，换成租约版就是静默数据损坏）。
  const onOwnershipLost = (): void => {
    if (turn.aborted) {return;}
    turn.aborted = true;
    turn.abortReason = OWNERSHIP_LOST_MESSAGE;
    turn.abortController.abort(new Error(OWNERSHIP_LOST_MESSAGE));
  };
  turn.grant.signal.addEventListener("abort", onOwnershipLost, { once: true });
  // **挂监听之前就已经丢了，监听永远不会响**（DOM 规范：给已经 abort 的信号加监听不会补发事件）。
  // 从抢到归属到走到这一行，中间隔着几次打库：读账本，以及接管时替上一轮补「已停止」
  // （`queue.ts` 的 `settleDisplacedTurn`）。库卡住超过自我围栏的余量时，心跳会在这段空档里
  // 把 grant 停掉——不补这一句，这一轮会照常装配、跑模型、动沙盒，而每一次写账本都被拒。
  if (turn.grant.signal.aborted) {onOwnershipLost();}

  try {
    // ---- 装配 ----
    const entries = await ctx.persistence.ledger.read(conversationId);
    const resume = buildResumeState(conversationId, entries);
    const priorMessageCount = resume.messages.length;
    // 三个停止检查点**只对普通轮生效**。恢复轮不走「停止就补一条用户消息 + 已停止」的捷径——
    // 那会把收尾标记追加在悬空调用后面，永久弄坏这个会话（技术方案 §5.9）。它必须走到 core，
    // 在那里把停止当成「拒绝」来结清那次调用（`openTurnStream`）。
    const stopBeforeCore = (): boolean => turn.aborted && turn.resume === undefined;
    // [交权](../../../../docs/terms.md)落在装配阶段：中止装配、**什么都不写**，普通轮的输入放回待发队列最前面，
    // 接手的一方出队重来（docs/logic/orchestration/tech/handover.md §6 第一行）。
    const handedOverBeforeCore = (): boolean => turn.handoverController.signal.aborted;

    // 停止优先于交权：用户按了停止，就按停止收尾，别把他取消的事交给别的节点重做。
    if (stopBeforeCore()) {return await finishAborted(ctx, turn, publish);}
    if (handedOverBeforeCore()) {return await finishHandedOverBeforeCore(ctx, turn);}

    const preparation = await ctx.prepareTurn({
      conversationId,
      input: turn.input,
      turnNumber: turn.turnNumber,
      signal: AbortSignal.any([turn.abortController.signal, turn.handoverController.signal]),
      ...(turn.resume !== undefined ? { resume: { callId: turn.resume.callId } } : {}),
      ...(turn.continuation === true ? { continuation: true as const } : {}),
    });

    // 停止 / 交权检查点：装配那几个远程调用（取沙盒、扫 skill）掐不断，但既然已经知道
    // 用户要停（或节点要走），就别再往下白跑建 session。
    if (stopBeforeCore()) {
      await runDispose(ctx, preparation, conversationId);
      return await finishAborted(ctx, turn, publish);
    }
    if (handedOverBeforeCore()) {
      await runDispose(ctx, preparation, conversationId);
      return await finishHandedOverBeforeCore(ctx, turn);
    }

    const session = await ctx.sessionFactory(
      buildAgentDefinition(ctx, turn, preparation),
      buildSessionOptions(ctx, turn, preparation, resume),
    );

    if (stopBeforeCore()) {
      await runDispose(ctx, preparation, conversationId);
      return await finishAborted(ctx, turn, publish);
    }
    if (handedOverBeforeCore()) {
      await runDispose(ctx, preparation, conversationId);
      return await finishHandedOverBeforeCore(ctx, turn);
    }

    // ---- 就地升级成真正在跑的那一轮 ----
    turn.phase = "running";
    turn.steer = (input: string): boolean => session.steer?.(input) ?? false;
    notifyHook(ctx, () => {
      ctx.hooks.onTurnStart?.({ conversationId, turn: turn.turnNumber, input: turn.input });
    });

    try {
      return await consumeStream(ctx, turn, session, {
        publish,
        priorMessageCount,
        baselineLast: resume.messages[priorMessageCount - 1],
        modelText: preparation.modelText ?? turn.input.text,
        startedAt,
      });
    } finally {
      // 交权时还有工具在这一轮的执行面上跑（[工具收尾](../../../../docs/terms.md)）：等它们跑完再收拾，
      // 不然工具跑到一半沙盒就被宿主关了。
      const tails = turn.handedOverCalls.map((call) => call.outcome);
      if (tails.length === 0) {
        await runDispose(ctx, preparation, conversationId);
      } else {
        void Promise.all(tails).then(() => runDispose(ctx, preparation, conversationId));
      }
    }
  } catch (error) {
    // 装配被交权打断（取沙盒之类的远程调用收到信号就抛）：与上面的检查点同一个结局，不算失败。
    // 已经走过那条路、是它自己抛的（放回队列时库出错）就别再走一遍——放回队列不能安全地重做。
    if (turn.handoverController.signal.aborted && !turn.aborted && !handedOverFinishTried.has(turn)) {
      return await finishHandedOverBeforeCore(ctx, turn);
    }
    // 恢复轮与接着跑的那一轮装配失败：**账本一个字不写**——不写用户消息（人没说话），也不写收尾标记
    // （恢复轮会补在悬空调用后面；接着跑的会盖掉交权标记，那半轮就再也接不上了）。下一次推一把时重来；
    // 收尾第⑤步也不会立刻重试，免得沙盒持续不可用时变成热循环（技术方案 §5.8）。
    if (turn.resume !== undefined || turn.continuation === true) {
      ctx.logger.error(LOG_SCOPE, "resume or continuation turn assembly failed; the ledger is left as it was", {
        conversationId,
        callId: turn.resume?.callId,
        error: describeError(error),
      });
      return { status: "crashed" };
    }
    // 走到这里意味着装配自己抛了（凭据、沙盒、建 session）——这一轮从没启动，core 不会
    // 为它产出任何东西，所以补一条形状与 core 优雅失败同源的收尾帧。
    ctx.logger.error(LOG_SCOPE, "turn assembly failed", { conversationId, error: describeError(error) });
    const metadata: RunkoMessageMetadata = {
      turn: turn.turnNumber,
      usage: {},
      status: "failed",
      error: { code: "provider_error", message: describeError(error) },
    };
    // **用户那句话必须落账本**：`enqueue` 早就回了 `mode:'started'`、宿主已经告诉用户
    // 「发出去了」，装配失败不该让它凭空消失（刷新页面后什么都没有）。这跟同文件
    // `finishAborted` 的立场一致——「用户确实发出了它」。收尾标记同理，见
    // `appendSettleMessage` 的注释。落库失败只记日志，不能再往外抛：这里已经是最外层
    // 的兜底，抛出去收尾五步就跑不完了。
    try {
      await appendUserMessage(ctx, turn, publish);
      await appendSettleMessage(ctx, turn, publish, metadata);
    } catch (persistError) {
      ctx.logger.error(LOG_SCOPE, "failed to persist the failed turn", {
        conversationId,
        error: describeError(persistError),
      });
    }
    // 收尾帧排在用户消息与收尾标记的成品消息帧之后（单一账本 · 技术方案 §6.1）：
    // 前端一收到它就当这一轮结束了。落库失败也照发，用户不该干等。
    publish({ kind: "chunk", chunk: { type: "message-metadata", messageMetadata: metadata } });
    return { status: "crashed" };
  } finally {
    turn.grant.signal.removeEventListener("abort", onOwnershipLost);
  }
}

/**
 * 这一轮在[起轮装配](../../../../docs/terms.md)窗口里就被停止了——它从没启动过，所以
 * 界面上「你发的那条消息 + 已停止」两帧只能由这里补。
 *
 * 用户消息**照样落账本**：用户确实发出了它，下一轮的模型上下文里该有这句话。
 */
async function finishAborted(
  ctx: RuntimeContext,
  turn: ActiveTurn,
  publish: (frame: Frame) => void,
): Promise<DriveResult> {
  ctx.logger.info(LOG_SCOPE, "turn stopped before it started", { conversationId: turn.conversationId });
  // 接着跑的那一轮没有用户说话，不补用户消息，只写「已停止」。
  if (turn.continuation !== true) {await appendUserMessage(ctx, turn, publish);}
  const metadata: RunkoMessageMetadata = {
    turn: turn.turnNumber,
    usage: {},
    status: "interrupted",
    error: { code: "aborted", message: turn.abortReason ?? ABORT_REASON_USER },
  };
  // 直播帧给还连着的客户端（界面据它立刻把这一轮标成「已停止」）……
  publish({ kind: "chunk", chunk: { type: "message-metadata", messageMetadata: metadata } });
  // ……账本那条给重连的和以后回放的。两者缺一都会有人看不到这个标记。
  await appendSettleMessage(ctx, turn, publish, metadata);
  return { status: "interrupted" };
}

/**
 * [交权](../../../../docs/terms.md)落在装配阶段：账本一个字不写。普通轮把输入放回待发队列最前面——用户已经被告知
 * 「发出去了」，接手的一方出队重来；恢复轮与接着跑的那一轮什么都不用放，账本本身就说明了接下来该干什么。
 */
/** 已经走过 `finishHandedOverBeforeCore` 的轮。 */
const handedOverFinishTried = new WeakSet<ActiveTurn>();

async function finishHandedOverBeforeCore(ctx: RuntimeContext, turn: ActiveTurn): Promise<DriveResult> {
  handedOverFinishTried.add(turn);
  ctx.logger.info(LOG_SCOPE, "handover arrived before the turn reached the model; nothing written", {
    conversationId: turn.conversationId,
  });
  if (turn.resume === undefined && turn.continuation !== true) {
    await requeueInputFront(ctx, turn.conversationId, turn.input);
  }
  return { status: "handed-over" };
}

/** 已经写过起轮用户消息的轮——`appendUserMessage` 在几条收尾路径上都可能被调到，写两遍就是账本里两条一样的话。 */
const userMessageWritten = new WeakSet<ActiveTurn>();

/**
 * 把一条**收尾标记**写进账本：只有一个 `step-start` 的 assistant 消息，不带内容、
 * 只承载 metadata。形状与 `recover()` 补的那条、以及 core 在「首步之前就失败」时造的
 * 占位消息同源。
 *
 * **为什么必须落账本、光发一帧不够**：chunk 一律不落库，只发帧的话重连的客户端
 * （以及此后任何一次回放）都看不到「已停止 / 失败」，界面上那一轮永远悬在半空。
 */
async function appendSettleMessage(
  ctx: RuntimeContext,
  turn: ActiveTurn,
  publish: (frame: Frame) => void,
  metadata: RunkoMessageMetadata,
): Promise<void> {
  // 账本末尾有悬空调用时**不写**：标记会把它埋进历史中间，此后每次调模型都 400（技术方案 §5.9）。
  // 走到这里通常是一次没做完的恢复轮——这个会话本来就还在挂起。
  if (await ledgerEndsWithPendingCalls(ctx.persistence, turn.conversationId)) {
    ctx.logger.info(LOG_SCOPE, "conversation is suspended; not appending a settle marker after a pending call", {
      conversationId: turn.conversationId,
    });
    return;
  }
  const allocated = await turn.grant.nextSeq();
  if (!allocated.ok) {
    ctx.logger.warn(LOG_SCOPE, "lost ownership before persisting the settle marker", { conversationId: turn.conversationId });
    return;
  }
  const message: RunkoUIMessage = {
    id: `turn-${metadata.status ?? "settled"}-${String(allocated.seq)}`,
    role: "assistant",
    // **必须至少有一个 part**：ai 的 `validateUIMessages()` 拒绝空 parts
    // （`Message must contain at least one part`），而每一轮起轮都要拿整个账本过一次
    // 校验——写进去一条空的，这个会话此后**永远起不了新轮**。
    // `step-start` 是 core 自己在「首步之前就失败」时用的同一个占位（`loop.ts` 的
    // `placeholder`）：结构帧、不带内容、不会污染下一轮的模型上下文。
    parts: [{ type: "step-start" }],
    metadata,
  };
  const written = await ctx.persistence.ledger.append({
    conversationId: turn.conversationId,
    seq: allocated.seq,
    message,
    ts: Date.now(),
  });
  if (!written.ok) {
    ctx.logger.warn(LOG_SCOPE, "settle marker rejected by the ledger", { conversationId: turn.conversationId, seq: allocated.seq });
    return;
  }
  publish({ kind: "message", seq: allocated.seq, message });
}

/** 起轮那条用户消息：拿一个 seq、落账本、广播。**用户原话**，不是喂给模型的那份。 */
async function appendUserMessage(ctx: RuntimeContext, turn: ActiveTurn, publish: (frame: Frame) => void): Promise<void> {
  // 幂等：装配抛错那条路会在 `consumeStream` 之外再调一次，写两遍就是重复的用户消息。
  if (userMessageWritten.has(turn)) {return;}
  userMessageWritten.add(turn);
  const message: RunkoUIMessage = {
    id: randomUUID(),
    role: "user",
    parts: [{ type: "text", text: turn.input.text }],
  };
  const allocated = await turn.grant.nextSeq();
  if (!allocated.ok) {
    ctx.logger.warn(LOG_SCOPE, "lost ownership before persisting the user message", { conversationId: turn.conversationId });
    return;
  }
  const written = await ctx.persistence.ledger.append({
    conversationId: turn.conversationId,
    seq: allocated.seq,
    message,
    ts: Date.now(),
  });
  if (!written.ok) {
    ctx.logger.warn(LOG_SCOPE, "user message write rejected", { conversationId: turn.conversationId, seq: allocated.seq });
    return;
  }
  publish({ kind: "message", seq: allocated.seq, message });
}

interface ConsumeOptions {
  publish: (frame: Frame) => void;
  priorMessageCount: number;
  /** 开轮时账本的最后一条。恢复轮会原地改写它；收尾时拿它比对，没变就不再写一遍。 */
  baselineLast: RunkoUIMessage | undefined;
  modelText: string;
  startedAt: number;
}

/**
 * 开这一轮的流：普通轮 `stream(text)`，恢复轮 `settleAndRun(callId, settlement)`。
 *
 * **停止键在恢复轮里等于「拒绝」**（技术方案 §5.8）：人点了允许、恢复轮还在装配时他又点了停止，
 * 那就不执行，改用拒绝结清。这跟内存窗口内点停止的结果一致。开轮之后再点停止，由 core 用中止
 * 信号处理（跟普通轮一样）。
 */
function openTurnStream(turn: ActiveTurn, session: DrivenSession, modelText: string): AsyncGenerator<RunkoChunk, TurnResult> {
  // 结清之后就停（工具收尾期间用户按了停止）：给 core 一个已经 abort 的信号——恢复开场照样结清那次调用，
  // 然后第一个检查点就以「已停止」收尾，不再调模型。
  const signal = turn.stopAfterSettle === true ? AbortSignal.abort(new Error(ABORT_REASON_USER)) : turn.abortController.signal;
  const opts = { signal, handover: turn.handoverController.signal };
  if (turn.continuation === true) {
    if (session.continueTurn === undefined) {
      throw new Error("This session factory's sessions cannot continue a handed-over turn (DrivenSession.continueTurn is missing).");
    }
    return session.continueTurn(opts);
  }
  if (turn.resume === undefined) {return session.stream(modelText, opts);}
  if (session.settleAndRun === undefined) {
    throw new Error("This session factory's sessions cannot resume a suspended turn (DrivenSession.settleAndRun is missing).");
  }
  const { callId, settlement } = turn.resume;
  const effective: Settlement =
    turn.aborted && settlement.kind === "approval" && settlement.behavior === "allow"
      ? { kind: "approval", behavior: "deny", message: ABORT_DENY_MESSAGE }
      : settlement;
  const also = turn.resume.also ?? [];
  return session.settleAndRun(callId, effective, also.length > 0 ? { ...opts, alsoSettle: also } : opts);
}

/** 一轮的主循环：把 `session.stream()` 吐出的每个 chunk「攒进草稿 → 推给订阅者」，跑完落盘。 */
async function consumeStream(
  ctx: RuntimeContext,
  turn: ActiveTurn,
  session: DrivenSession,
  opts: ConsumeOptions,
): Promise<DriveResult> {
  const { conversationId } = turn;
  const { publish } = opts;

  // 起轮那条用户消息在**开始消费流之前**就上线，所以它必定排在这一轮任何产出之前。
  // core 自己也会往内部账本 push 一条结构相同（id 不同、文本可能是 modelText）的
  // 副本——收尾时 `slice(priorMessageCount + 1)` 正是为了跳过那一条，不重复落盘。
  // 恢复轮没有这一条：人没说话，他只是答了一张卡片。
  if (turn.resume === undefined && turn.continuation !== true) {await appendUserMessage(ctx, turn, publish);}

  let lastMetadata: RunkoMessageMetadata | undefined;
  // 收尾帧**扣到成品消息写进账本之后**再发（docs/logic/orchestration/tech/single-ledger.md §6.1）：
  // 前端一收到它就当这一轮结束了，先发的话会有一段「前端以为完了、库还没写」的空档。
  let heldMetadata: RunkoMessageMetadata | undefined;
  let firstChunkReported = false;
  let firstOutputReported = false;

  // 正常收尾与「生成器抛了」两条路都要落盘，但**只能落一次**——标记在 await 之前就置上，
  // 这样 `finalize` 自己抛的时候 catch 分支也不会再跑一遍。
  let finalized = false;
  const finalizeOnce = async (): Promise<FinalizeOutcome> => {
    if (finalized) {return "complete";}
    finalized = true;
    return await finalize(ctx, turn, session, opts, publish);
  };

  try {
    const generator = openTurnStream(turn, session, opts.modelText);
    let step = await generator.next();
    while (!step.done) {
      const chunk = step.value;
      const arrivedAt = Date.now();
      if (chunk.type === "message-metadata") {
        lastMetadata = chunk.messageMetadata;
        heldMetadata = chunk.messageMetadata;
        step = await generator.next();
        continue;
      }
      if (isDurableChunk(chunk)) {turn.draft.push(chunk);}
      publish({ kind: "chunk", chunk });

      if (!firstChunkReported) {
        firstChunkReported = true;
        reportMilestone(ctx, session, "onFirstChunk", conversationId, arrivedAt - opts.startedAt);
      }
      if (!firstOutputReported && isVisibleChunk(chunk)) {
        firstOutputReported = true;
        reportMilestone(ctx, session, "onFirstOutput", conversationId, arrivedAt - opts.startedAt);
      }
      step = await generator.next();
    }
    // 交权那一刻还在跑的调用：core 把它们交回给我们继续持有，收尾时登记成[工具收尾](../../../../docs/terms.md)。
    turn.handedOverCalls = step.value.handedOver?.running ?? [];

    if ((await finalizeOnce()) === "incomplete") {
      return await finishUnsaved(ctx, turn, publish, lastMetadata);
    }
    if (heldMetadata !== undefined) {
      publish({ kind: "chunk", chunk: { type: "message-metadata", messageMetadata: heldMetadata } });
    }
    ctx.logger.info(LOG_SCOPE, "turn finished", {
      conversationId,
      status: lastMetadata?.status,
      durationMs: Date.now() - opts.startedAt,
    });
    // 一个 metadata 都没见到也算正常收尾——缺 metadata 是 core 侧的可选字段问题，
    // 不该被报成失败。
    return { status: lastMetadata?.status ?? "completed" };
  } catch (error) {
    // 生成器自己抛了——真正意外的失败，没有 `TurnResult` 可报，也没有一条账本消息可以
    // 挂失败 metadata。补一条独立的收尾帧（形状与 core 的优雅失败同源）。
    ctx.logger.error(LOG_SCOPE, "turn threw unexpectedly", {
      conversationId,
      error: describeError(error),
      durationMs: Date.now() - opts.startedAt,
    });
    // 已经产出的成品消息仍然要落盘——它们是这一轮唯一的记录，丢了界面就什么都看不到。
    // `finalizeOnce` 保证不会重跑：try 里那次若是**它自己**抛的，重跑会从
    // `session.toJSON()` 重新 slice 同一批消息、重新取号，seq 不同、账本的
    // `(conversationId, seq)` 幂等挡不住 —— 同一条回复写出两行。
    await finalizeOnce();
    const failure: RunkoMessageMetadata = {
      turn: turn.turnNumber,
      usage: {},
      status: "failed",
      error: { code: "provider_error", message: describeError(error) },
    };
    publish({ kind: "chunk", chunk: { type: "message-metadata", messageMetadata: failure } });
    // 收尾标记同样要落账本，否则重连的客户端看不到这一轮失败了。
    await appendSettleMessage(ctx, turn, publish, failure);
    return { status: "crashed" };
  }
}

/**
 * 收尾落盘：把本轮新追加的成品消息整批写下，写完再一起广播。
 *
 * **草稿在第一个 `await` 之前就同步清空**——这是「重连请求不可能看到写了一半的状态」
 * 那条保证的落地：清空之后连上来的订阅者只会看到「已落盘的部分」，缺的那几条会经它
 * 自己那条已经挂好的订阅补上（订阅先于回放，所以不会漏）。反过来（先写后清）则会让
 * 订阅者同时拿到「成品消息」和「同一条消息的半成品草稿」，后者覆盖前者。
 */
async function finalize(
  ctx: RuntimeContext,
  turn: ActiveTurn,
  session: DrivenSession,
  opts: Pick<ConsumeOptions, "priorMessageCount" | "baselineLast">,
  publish: (frame: Frame) => void,
): Promise<FinalizeOutcome> {
  turn.draft.length = 0;

  let state: SessionState;
  try {
    state = session.toJSON();
  } catch (error) {
    ctx.logger.error(LOG_SCOPE, "session.toJSON() threw; nothing to persist for this turn", {
      conversationId: turn.conversationId,
      error: describeError(error),
    });
    return "incomplete";
  }

  const newMessages = messagesToPersist(turn, state.messages, opts);
  // core 按先进先出注入插话，数一下进了账本的有几条，剩下的由收尾时转进待发队列（挂起时）。
  turn.steersDelivered = newMessages.filter((message) => message.role === "user" && message.metadata?.steered === true).length;
  const written: Frame[] = [];
  let outcome: FinalizeOutcome = "complete";
  try {
    for (const message of newMessages) {
      const allocated = await turn.grant.nextSeq();
      if (!allocated.ok) {
        ctx.logger.error(LOG_SCOPE, "lost ownership mid-finalize; stopping here", { conversationId: turn.conversationId });
        outcome = "incomplete";
        break;
      }
      const result = await ctx.persistence.ledger.append({
        conversationId: turn.conversationId,
        seq: allocated.seq,
        message,
        ts: Date.now(),
      });
      if (!result.ok) {
        ctx.logger.error(LOG_SCOPE, "ledger write rejected mid-finalize; stopping here", {
          conversationId: turn.conversationId,
          seq: allocated.seq,
        });
        outcome = "incomplete";
        break;
      }
      written.push({ kind: "message", seq: allocated.seq, message });
    }
  } catch (error) {
    // 库出错不往外抛：调用方据 `incomplete` 改发「系统异常」，细节只在这一行日志里。
    ctx.logger.error(LOG_SCOPE, "ledger write threw mid-finalize; stopping here", {
      conversationId: turn.conversationId,
      error: describeError(error),
    });
    outcome = "incomplete";
  }

  // 写进去了的照样广播：它们已经在账本里，重连回放也会拿到，直播这边不能少。
  for (const frame of written) {publish(frame);}
  ctx.logger.debug(LOG_SCOPE, "turn persistence finalized", {
    conversationId: turn.conversationId,
    messageCount: written.length,
    outcome,
  });
  return outcome;
}

/**
 * 这一轮的成品消息没能全部写进账本：扣住的收尾帧（多半是「完成了」）**作废**，改发「系统异常」，
 * 并尽量补一条失败标记（docs/logic/orchestration/tech/single-ledger.md §6.1）。
 *
 * **先发帧、再补标记**：库出错时补标记可能要等到连接超时，用户不该跟着干等。
 * **归属已经丢了就不补**：这份对话不归本节点管了（库连不上时自我围栏也走到这里），再碰库只会卡住收尾；
 * 接手的节点会补「已中断」。
 * 失败标记也写不进去时只记日志、不抛：收尾剩下的几步（广播「没有轮在跑了」、放手）必须跑完，
 * 不然这份对话会被锁死。
 */
async function finishUnsaved(
  ctx: RuntimeContext,
  turn: ActiveTurn,
  publish: (frame: Frame) => void,
  lastMetadata: RunkoMessageMetadata | undefined,
): Promise<DriveResult> {
  const failure: RunkoMessageMetadata = {
    turn: turn.turnNumber,
    usage: lastMetadata?.usage ?? {},
    status: "failed",
    error: { code: "internal_error", message: INTERNAL_ERROR_MESSAGE },
  };
  publish({ kind: "chunk", chunk: { type: "message-metadata", messageMetadata: failure } });
  if (turn.grant.signal.aborted) {return { status: "failed" };}
  try {
    await appendSettleMessage(ctx, turn, publish, failure);
  } catch (error) {
    ctx.logger.error(LOG_SCOPE, "failed to persist the settle marker of an unsaved turn", {
      conversationId: turn.conversationId,
      error: describeError(error),
    });
  }
  return { status: "failed" };
}

/**
 * 这一轮要落盘哪几条。
 *
 * - 普通轮：跳过开轮时 core 自己 push 的那条用户消息（`appendUserMessage` 已经写过了）。
 * - 恢复轮：**从开轮时的最后一条开始**——core 原地改写了它（结清那次悬空调用），它以新 seq、
 *   同 id 追加，读账本时按 id 折叠（技术方案 §5.4）。它要是一个字没变（恢复在结清之前就失败了），
 *   就别再写一遍。
 */
function messagesToPersist(
  turn: ActiveTurn,
  messages: RunkoUIMessage[],
  opts: Pick<ConsumeOptions, "priorMessageCount" | "baselineLast">,
): RunkoUIMessage[] {
  if (turn.continuation === true) {return messages.slice(opts.priorMessageCount);}
  if (turn.resume === undefined) {return messages.slice(opts.priorMessageCount + 1);}
  const revised = messages[opts.priorMessageCount - 1];
  const unchanged = revised === undefined || opts.baselineLast === undefined || sameJson(revised, opts.baselineLast);
  return messages.slice(unchanged ? opts.priorMessageCount : opts.priorMessageCount - 1);
}

/**
 * 两条消息内容是否一样，**不看键的顺序**：账本读出来的那份与 session 里的那份各自过了一遍 zod，
 * 键序可能不同，直接比 `JSON.stringify` 会把没变的误判成变了（那只会多写一行，读时会被折叠掉，
 * 但没必要）。
 */
function sameJson(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {return `[${value.map(canonicalJson).join(",")}]`;}
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** `agent` 定义 + 这一轮的覆盖项（模型/指令/skills/工具）。 */
function buildAgentDefinition(ctx: RuntimeContext, turn: ActiveTurn, preparation: TurnPreparation): AgentDefinition {
  // 顺序即优先级：内置 `ask-user` 垫底，`agent.tools` 覆盖它，这一轮的 `preparation.tools`
  // 再覆盖前两者——宿主永远能用同名工具换掉框架给的那个。
  const tools: Record<string, Tool> = {
    ...(ctx.askUser
      ? { "ask-user": createAskUserTool((req) => ctx.human.requestAnswer(turn.conversationId, req)) }
      : {}),
    ...(ctx.agent.tools ?? {}),
    ...(preparation.tools ?? {}),
  };
  return {
    ...ctx.agent,
    ...(preparation.model !== undefined ? { model: preparation.model } : {}),
    ...(preparation.instructions !== undefined ? { instructions: preparation.instructions } : {}),
    ...(preparation.skills !== undefined ? { skills: preparation.skills } : {}),
    tools,
  };
}

function buildSessionOptions(
  ctx: RuntimeContext,
  turn: ActiveTurn,
  preparation: TurnPreparation,
  resume: SessionState,
): SessionOptions {
  // [人审通道](../../../../docs/terms.md)恒由框架自己接——宿主不该另开一条（那会变成
  // 两份互相打架的挂起状态）。宿主能配的只有**分类器**（要不要人），见 `prepare.ts`。
  const onReview: ApprovalReviewer = (request) =>
    ctx.human.requestReview(turn.conversationId, {
      callId: request.ctx.callId,
      toolName: request.toolName,
      input: request.input,
    });
  const onApproval: ApprovalPolicy | undefined = preparation.onApproval;

  return {
    ...(preparation.workspace !== undefined
      ? { workspace: preparation.workspace }
      : {
          ...(preparation.fs !== undefined ? { fs: preparation.fs } : {}),
          ...(preparation.exec !== undefined ? { exec: preparation.exec } : {}),
        }),
    resume,
    ...(onApproval !== undefined ? { onApproval } : {}),
    onReview,
    ...(preparation.instructionsAppend !== undefined ? { instructions: { append: preparation.instructionsAppend } } : {}),
    ...(preparation.telemetry !== undefined ? { telemetry: preparation.telemetry } : {}),
    ...(ctx.toolTimeoutMs !== undefined ? { toolTimeoutMs: ctx.toolTimeoutMs } : {}),
  };
}

async function runDispose(ctx: RuntimeContext, preparation: TurnPreparation, conversationId: string): Promise<void> {
  if (preparation.dispose === undefined) {return;}
  try {
    await preparation.dispose();
  } catch (error) {
    ctx.logger.error(LOG_SCOPE, "prepareTurn dispose threw", { conversationId, error: describeError(error) });
  }
}

function reportMilestone(
  ctx: RuntimeContext,
  session: DrivenSession,
  hook: "onFirstChunk" | "onFirstOutput",
  conversationId: string,
  sinceStartMs: number,
): void {
  const handler = ctx.hooks[hook];
  if (handler === undefined) {return;}
  notifyHook(ctx, () => {
    // `session.toJSON()` 抛错（防御性，不预期）只跳过这次报告，不让整轮崩掉。
    const state = session.toJSON();
    handler({ conversationId, sessionId: state.id, turn: state.turn, sinceStartMs });
  });
}

/** 宿主钩子抛错就地吞掉——观测/通知绝不该污染这一轮。 */
function notifyHook(ctx: RuntimeContext, fn: () => void): void {
  try {
    fn();
  } catch (error) {
    ctx.logger.error(LOG_SCOPE, "runtime hook threw", { error: describeError(error) });
  }
}
