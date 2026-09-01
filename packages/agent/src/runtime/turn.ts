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
  NimboChunk,
  NimboMessageMetadata,
  NimboUIMessage,
  SessionOptions,
  SessionState,
  Tool,
} from "@nimbo/core";
import { sessionStateSchema } from "@nimbo/core";

import { describeError } from "../logger.js";
import type { LedgerEntry } from "../persistence.js";
import type { TurnPreparation } from "../prepare.js";
import type { Frame, TurnStatus } from "../types.js";
import type { RuntimeContext } from "./context.js";
import { createAskUserTool } from "./ask-user.js";
import type { ActiveTurn } from "./registry.js";
import { ABORT_REASON_USER, OWNERSHIP_LOST_MESSAGE } from "./reasons.js";
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
function isDurableChunk(chunk: NimboChunk): boolean {
  if (chunk.type === "text-delta" || chunk.type === "reasoning-delta") {return false;}
  return !("transient" in chunk && chunk.transient === true);
}

/** 「用户在界面上看得见东西了」——第一段文字、第一段推理、或第一张工具调用卡片。 */
function isVisibleChunk(chunk: NimboChunk): boolean {
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
  const messages = entries.map((entry) => entry.message);
  const turn = messages.reduce((max, message) => Math.max(max, message.metadata?.turn ?? 0), 0);
  const createdAt = entries[0]?.ts ?? Date.now();
  // 复用 core 自己导出的 schema——这是反序列化边界（行可能来自 DB 的 JSON 列），
  // 与 core 内部 `createSession({resume})` 那次校验是纵深防御，不是冗余。
  return sessionStateSchema.parse({ id: conversationId, turn, messages, createdAt });
}

/** 下一轮的轮号（1-based）——起轮占位时就要知道它，好交给 `prepareTurn`。 */
export function nextTurnNumber(entries: readonly LedgerEntry[]): number {
  return entries.reduce((max, entry) => Math.max(max, entry.message.metadata?.turn ?? 0), 0) + 1;
}

interface DriveResult {
  status: TurnStatus;
}

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

  try {
    // ---- 装配 ----
    const entries = await ctx.persistence.ledger.read(conversationId);
    const resume = buildResumeState(conversationId, entries);
    const priorMessageCount = resume.messages.length;

    if (turn.aborted) {return await finishAborted(ctx, turn, publish);}

    const preparation = await ctx.prepareTurn({
      conversationId,
      input: turn.input,
      turnNumber: turn.turnNumber,
      signal: turn.abortController.signal,
    });

    // 停止检查点：装配那几个远程调用（取沙盒、扫 skill）掐不断，但既然已经知道用户
    // 要停，就别再往下白跑建 session。
    if (turn.aborted) {
      await runDispose(ctx, preparation, conversationId);
      return await finishAborted(ctx, turn, publish);
    }

    const session = await ctx.sessionFactory(
      buildAgentDefinition(ctx, turn, preparation),
      buildSessionOptions(ctx, turn, preparation, resume),
    );

    if (turn.aborted) {
      await runDispose(ctx, preparation, conversationId);
      return await finishAborted(ctx, turn, publish);
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
        modelText: preparation.modelText ?? turn.input.text,
        startedAt,
      });
    } finally {
      await runDispose(ctx, preparation, conversationId);
    }
  } catch (error) {
    // 走到这里意味着装配自己抛了（凭据、沙盒、建 session）——这一轮从没启动，core 不会
    // 为它产出任何东西，所以补一条形状与 core 优雅失败同源的收尾帧。
    ctx.logger.error(LOG_SCOPE, "turn assembly failed", { conversationId, error: describeError(error) });
    const metadata: NimboMessageMetadata = {
      turn: turn.turnNumber,
      usage: {},
      status: "failed",
      error: { code: "provider_error", message: describeError(error) },
    };
    publish({ kind: "chunk", chunk: { type: "message-metadata", messageMetadata: metadata } });
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
  await appendUserMessage(ctx, turn, publish);
  const metadata: NimboMessageMetadata = {
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

/** 已经写过起轮用户消息的轮——`appendUserMessage` 在几条收尾路径上都可能被调到，写两遍就是账本里两条一样的话。 */
const userMessageWritten = new WeakSet<ActiveTurn>();

/**
 * 把一条**收尾标记**写进账本：空 parts 的 assistant 消息，只承载 metadata。形状与
 * `recover()` 补的那条、以及 core 在「首步之前就失败」时造的占位消息同源。
 *
 * **为什么必须落账本、光发一帧不够**：chunk 一律不落库，只发帧的话重连的客户端
 * （以及此后任何一次回放）都看不到「已停止 / 失败」，界面上那一轮永远悬在半空。
 */
async function appendSettleMessage(
  ctx: RuntimeContext,
  turn: ActiveTurn,
  publish: (frame: Frame) => void,
  metadata: NimboMessageMetadata,
): Promise<void> {
  const allocated = await turn.grant.nextSeq();
  if (!allocated.ok) {
    ctx.logger.warn(LOG_SCOPE, "lost ownership before persisting the settle marker", { conversationId: turn.conversationId });
    return;
  }
  const message: NimboUIMessage = {
    id: `turn-${metadata.status ?? "settled"}-${String(allocated.seq)}`,
    role: "assistant",
    parts: [],
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
  const message: NimboUIMessage = {
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
  modelText: string;
  startedAt: number;
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
  await appendUserMessage(ctx, turn, publish);

  let lastMetadata: NimboMessageMetadata | undefined;
  let firstChunkReported = false;
  let firstOutputReported = false;

  // 正常收尾与「生成器抛了」两条路都要落盘，但**只能落一次**——标记在 await 之前就置上，
  // 这样 `finalize` 自己抛的时候 catch 分支也不会再跑一遍。
  let finalized = false;
  const finalizeOnce = async (): Promise<void> => {
    if (finalized) {return;}
    finalized = true;
    await finalize(ctx, turn, session, opts.priorMessageCount, publish);
  };

  try {
    const generator = session.stream(opts.modelText, { signal: turn.abortController.signal });
    let step = await generator.next();
    while (!step.done) {
      const chunk = step.value;
      const arrivedAt = Date.now();
      if (chunk.type === "message-metadata") {lastMetadata = chunk.messageMetadata;}
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

    await finalizeOnce();
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
    const failure: NimboMessageMetadata = {
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
  priorMessageCount: number,
  publish: (frame: Frame) => void,
): Promise<void> {
  turn.draft.length = 0;

  let state: SessionState;
  try {
    state = session.toJSON();
  } catch (error) {
    ctx.logger.error(LOG_SCOPE, "session.toJSON() threw; nothing to persist for this turn", {
      conversationId: turn.conversationId,
      error: describeError(error),
    });
    return;
  }

  const newMessages = state.messages.slice(priorMessageCount + 1);
  const written: Frame[] = [];
  for (const message of newMessages) {
    const allocated = await turn.grant.nextSeq();
    if (!allocated.ok) {
      ctx.logger.warn(LOG_SCOPE, "lost ownership mid-finalize; stopping here", { conversationId: turn.conversationId });
      break;
    }
    const result = await ctx.persistence.ledger.append({
      conversationId: turn.conversationId,
      seq: allocated.seq,
      message,
      ts: Date.now(),
    });
    if (!result.ok) {
      ctx.logger.warn(LOG_SCOPE, "ledger write rejected mid-finalize; stopping here", {
        conversationId: turn.conversationId,
        seq: allocated.seq,
      });
      break;
    }
    written.push({ kind: "message", seq: allocated.seq, message });
  }

  for (const frame of written) {publish(frame);}
  ctx.logger.debug(LOG_SCOPE, "turn persistence finalized", {
    conversationId: turn.conversationId,
    messageCount: written.length,
  });
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
