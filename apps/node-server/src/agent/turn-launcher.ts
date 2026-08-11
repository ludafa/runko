/**
 * 「起一轮」的全部装配（docs/agent/steer-and-queue/tech.md §3）——从 `routes/chat.ts` 的
 * `POST .../messages` handler 里整段抽出来的：解析模型/仓库凭据 → 取沙盒
 * （`sandboxManager.acquire` + `touch`）→ 回写 E2B [重连令牌](../../../../docs/terms.md)
 * → 装配[审批链](../../../../docs/terms.md)的三个回调 → 从[账本](../../../../docs/terms.md)
 * 重建 `SessionState` → `buildSession` → `turn-runner/` 的 `startTurn`。
 *
 * **为什么要抽**：这段装配有两个调用方，其中一个不在任何 HTTP 请求上下文里——
 *
 * 1. `routes/chat.ts` 的 `POST .../messages`（用户主动发消息、没有进行中的一轮）；
 * 2. **自动[出队](../../../../docs/terms.md)**：一轮收尾后取[待发队列](../../../../docs/terms.md)
 *    队首起下一轮（`startNextQueuedTurn`）。
 *
 * **依赖方向**（不成环，docs/agent/steer-and-queue/tech.md §3）：
 *
 * ```
 * routes/chat.ts ──→ turn-launcher.ts ──→ turn-runner/（startTurn）
 *                           ↑                     │
 *                           └─── onTurnSettled ───┘（回调由本文件注入，turn-runner 不 import 本文件）
 * ```
 *
 * `turn-runner/` 因此完全不认识「队列」这个概念，它只多了一个「这一轮彻底结束了」
 * 的通知点。
 */
import type {
  ApprovalPolicy,
  ApprovalReviewer,
  SessionState,
  SessionTelemetry,
} from '@nimbo/core';
import { sessionStateSchema } from '@nimbo/core';
import type { LanguageModel } from 'ai';

import type { Logger } from '../logger.js';
import { logger as defaultLogger } from '../logger.js';
import type { ChatNotifier } from '../push/notifier.js';
import type { TelemetryStore } from '../telemetry.js';
import { classifyApproval, resolveApprovalMode } from './approval-policy.js';
import { buildSession } from './chat-agent.js';
import type { GitHubRepoRef } from './github-repo.js';
import { resolveGithubPat, resolveRepo } from './github-repo.js';
import type {
  AcquiredSandbox,
  AcquireMode,
  SandboxManager,
} from './sandbox-manager.js';
import { hasSessionGrant } from './session-grants.js';
import {
  buildModelText,
  extractMentionedSkills,
  loadSkillsFromWorkspace,
  toSkillSummaries,
} from './skill-catalog.js';
import type { ConversationRow, Db } from './store.js';
import {
  dequeueMessage,
  getConversation,
  listConversationEvents,
  requeueFront,
  syncAvailableSkills,
  updateConversation,
} from './store.js';
import type {
  AskUserOutcome,
  RequestUserAnswerInput,
  TurnMilestone,
  TurnMilestoneInfo,
  TurnReservation,
} from './turn-runner/index.js';
import {
  releaseTurn,
  requestReview,
  requestUserAnswer,
  reserveTurn,
  resolveApprovalTimeoutMs,
  resolveAskUserTimeoutMs,
  startTurn,
} from './turn-runner/index.js';

const LOG_SCOPE = 'turn-launcher';

// ---------------------------------------------------------------------------
// 起轮装配打点（docs/app/telemetry/tech.md §2.4）
// ---------------------------------------------------------------------------

/**
 * 一次[起轮装配](../../../../docs/terms.md)的分段耗时（毫秒，墙钟）。全部在
 * `launchTurn` 里就地量出来，攒到这一轮的第一个 chunk 抵达时才落库——那一刻
 * nimbo 会话 id 与轮号才确定（遥测的关联键 `"<sessionId>#<turn>"`），理由见
 * docs/app/telemetry/tech.md §2.4「为什么在第一个 chunk 抵达时才落库」。
 */
interface LaunchTimings {
  /** `sandboxManager.acquire()`——最可能的大头。 */
  acquireMs: number;
  /** 这次 acquire 走的哪条路（`sandbox-manager.ts` 的 `AcquireMode`）：缓存命中/恢复/重建。 */
  acquireMode: AcquireMode;
  /** `sandboxManager.ensureLifetime()`——沙盒续期的远程往返，每轮必做。 */
  touchMs: number;
  /** `loadResumeState()`——读全部 message 行 + zod 校验，本地 SQLite。 */
  loadStateMs: number;
  /** `buildSession()`——其中几乎全部是 `Skill.fromFS()` 从沙盒读 skill 附属文件。 */
  buildSessionMs: number;
  /** `launchTurn` 全程（≥ 上面各段之和，差额是凭据解析等零散同步开销）。 */
  launchMs: number;
}

/** 计时用的秒表：`stop()` 返回从建表到此刻的毫秒数。 */
function startStopwatch(): () => number {
  const startedAt = Date.now();
  return () => Date.now() - startedAt;
}

/**
 * 把两个里程碑写成遥测行（`turn-prepare` / `turn-first-output`）。
 *
 * 三条纪律与 `telemetry.ts` 文件头一致：遥测未启用（`telemetryStore` 缺席）就整个
 * 是无操作；写失败就地吞掉（最多丢一行遥测，绝不影响这一轮）；载荷只有数字与一个
 * 枚举字符串，没有任何正文可泄漏。
 */
function createMilestoneRecorder(
  deps: TurnLauncherDeps,
  conversationId: string,
  timings: () => LaunchTimings,
  log: Logger,
): (milestone: TurnMilestone, info: TurnMilestoneInfo) => void {
  return (milestone, info) => {
    const functionId = `${info.sessionId}#${String(info.turn)}`;
    if (milestone === 'first-chunk') {
      const prepared = timings();
      // 一行 info 日志与遥测同源同刻——遥测关掉了，运维照样能从 stdout 看到这
      // 一轮慢在哪（遥测是耗材，日志不是）。
      log.info(LOG_SCOPE, 'turn prepared', {
        conversationId,
        ...prepared,
        firstChunkMs: info.sinceStartMs,
      });
      try {
        deps.telemetryStore?.record('turn-prepare', functionId, {
          ...prepared,
          firstChunkMs: info.sinceStartMs,
        });
      } catch {
        // 遥测永不影响 turn。
      }
      return;
    }
    log.debug(LOG_SCOPE, 'turn first output', {
      conversationId,
      firstOutputMs: info.sinceStartMs,
    });
    try {
      deps.telemetryStore?.record('turn-first-output', functionId, {
        firstOutputMs: info.sinceStartMs,
      });
    } catch {
      // 同上。
    }
  };
}

export interface TurnLauncherDeps {
  db: Db;
  sandboxManager: SandboxManager;
  resolveModel: () => LanguageModel;
  /** telemetry 事件集成（docs/app/chat-webapp/tech.md §11.4）——缺省 undefined = 不采集。 */
  telemetry?: SessionTelemetry;
  /**
   * 遥测**写侧**的落库口（docs/app/telemetry/tech.md §2.4）——本文件用它写
   * `turn-prepare`/`turn-first-output` 两条[起轮装配](../../../../docs/terms.md)事件。
   * 与 `telemetry`（模型调用事件的集成对象，交给 core 透传给 `streamText`）是同一个库
   * 的两个入口：那条路由 ai 的回调发事件，这条是本文件自己发。缺省 undefined = 不采集，
   * 与整个遥测通道「可关、可删、消费方按缺席设计」的定位一致。
   */
  telemetryStore?: TelemetryStore;
  /**
   * 推送通知（docs/app/push-notification/tech.md §4）——本文件在三个已知时刻调它：要审批、
   * agent 提问、一轮结束。缺省 undefined = 不发通知，与遥测同样的「可关、可删、消费方
   * 按缺席设计」定位。生产装配见 `routes/chat.ts` 底部。
   *
   * 为什么接在本文件而不是 `turn-runner/`：那是运行内核，不该长出对可选外围功能的
   * 认识——与 `onMilestone`（遥测）完全同构的分工，见 docs/app/telemetry/tech.md §2.4。
   */
  notifier?: ChatNotifier;
  /** 缺省 stdout 单例；测试注入自己的 sink 以断言日志。 */
  logger?: Logger;
}

export interface LaunchTurnInput {
  conversationId: string;
  /**
   * 这一轮的**发起者**——不是 conversation owner 的同义词：自动出队时它来自队列条目
   * 自己的 `userId`（`schemas/chat.ts` 的 `QueuedMessageSchema`），因为
   * [会话级授权](../../../../docs/terms.md)按「本轮发起者」匹配（`session-grants.ts`）。
   */
  userId: string;
  text: string;
}

export type LaunchTurnOutcome =
  | { ok: true }
  /** 会话不存在或不属于这个 `userId`——路由转 404；自动出队遇到它只记日志（会话在排队期间被删了）。 */
  | { ok: false; reason: 'not_found' }
  /** 已有进行中的一轮（`reserveTurn`/`startTurn` 的守卫）——路由转 409。窄竞态，正常流程走不到。 */
  | { ok: false; reason: 'busy' }
  /**
   * 用户在[起轮装配](../../../../docs/terms.md)期间按了[停止](../../../../docs/terms.md)
   * （docs/agent/turn-abort/tech.md §3.3）——这一轮**从没启动**，路由转 202 `mode: 'aborted'`
   * （不是错误：用户要的结果达成了）。收尾那两帧已由 `releaseTurn` 补上。
   *
   * 自动[出队](../../../../docs/terms.md)遇到它**不 requeue**：用户按的就是停止，把这条
   * 放回队首等于没停。
   */
  | { ok: false; reason: 'aborted' }
  /**
   * 进程正在[优雅关闭](../../../../docs/terms.md)（docs/agent/graceful-shutdown/tech.md §3.3）
   * ——路由转 **503**「服务正在重启，请稍后重试」。
   *
   * 自动[出队](../../../../docs/terms.md)遇到它把消息 `requeueFront` **放回队首**
   * （那一步已经把它 dequeue 了）：服务重启不该吞掉用户排的消息，重启后下一次有轮收尾
   * 时它会被自然重试——与既有的「起轮失败不吞消息」一致。这与 `'aborted'` 那档刚好
   * 相反：那是用户主动按了停止，放回去等于没停。
   */
  | { ok: false; reason: 'shutting_down' }
  /** 模型/仓库凭据/沙盒装配失败——路由转 500；自动出队遇到它把消息放回队首。 */
  | { ok: false; reason: 'error'; message: string };

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reassembles a `SessionState` from the UIMessage 单账本 (docs/agent/single-ledger/tech.md §5 单-3): the session-scalar header (`row.agentSessionId`/
 * `agentSessionCreatedAt`/`agentSessionTurn`, `db/schema.ts`'s own doc comment) plus every
 * `kind = 'message'` row for this session, in seq order. `row.agentSessionId
 * === null` means this chat session has never completed a turn yet (no
 * nimbo `SessionState` has ever existed for it) — `undefined` here is what
 * tells `chat-agent.ts`'s `buildSession` to let `@nimbo/core` mint a fresh
 * one instead of resuming.
 *
 * Reuses `@nimbo/core`'s own exported `sessionStateSchema` (the same schema
 * `createSession({ resume })` validates against internally, defense in
 * depth, not redundant — this is the deserialization boundary) rather than
 * hand-rolling a `NimboUIMessage[]` validator here — the reassembled object
 * has the exact same shape a single `Session.toJSON()` blob used to, just
 * sourced from separate rows instead of one JSON column.
 */
export function loadResumeState(
  db: Db,
  row: ConversationRow,
): SessionState | undefined {
  // Resume off the persisted `kind = 'message'` rows, not the scalar header:
  // the header (`agentSessionId`/`agentSessionTurn`/`agentSessionCreatedAt`) is only written
  // by `finalizeTurnPersistence` on a *graceful* turn finish, but a
  // turn-start user message row (turn-runner/drive.ts) lands the moment a turn
  // begins. So a first turn that *crashed* (driveTurn's `catch`, header never
  // written) still leaves one `kind = 'message'` row — and it's replayed to
  // the UI. Gating resume on `agentSessionId !== null` used to drop exactly
  // that row from the model's context, so the user saw their message but the
  // agent had no memory of it. Gate on "are there any message rows" instead:
  // a crashed turn's user request is remembered (the model retries it next
  // turn) while its half-done assistant work — only ever `kind = 'chunk'`
  // rows, never read here — is not. When the header is absent, fall back to
  // the chat session's own id/createdAt (stable across turns until the first
  // graceful finish pins the real nimbo ids).
  const messages = listConversationEvents(db, row.id)
    .filter((eventRow) => eventRow.kind === 'message')
    .map((eventRow): unknown => JSON.parse(eventRow.payloadJson));
  if (messages.length === 0) return undefined;

  return sessionStateSchema.parse({
    id: row.agentSessionId ?? row.id,
    turn: row.agentSessionTurn ?? 0,
    messages,
    createdAt: (row.agentSessionCreatedAt ?? row.createdAt).getTime(),
  });
}

/**
 * 起一轮：装配好一切并交给 `turn-runner/` 的 `startTurn` 在进程内驱动（不 `await`
 * 这一轮跑完——本函数只负责把它**启动**起来，事件走 `GET .../stream`）。
 *
 * 注入的 `onTurnSettled` 是[排队](../../../../docs/terms.md)链条的关节：这一轮彻底结束
 * 后自动接着起下一条排队消息（`startNextQueuedTurn`），从而把「一轮一条」串下去。
 */
export async function launchTurn(
  deps: TurnLauncherDeps,
  input: LaunchTurnInput,
): Promise<LaunchTurnOutcome> {
  const log = deps.logger ?? defaultLogger;

  // [起轮占位](../../../../docs/terms.md)（docs/agent/turn-abort/tech.md §3.3）——**装配的第一
  // 件事**：从这一刻起这一轮就算「存在」，于是用户在装配期间按停止停得住它，同会话
  // 后来的消息也会走[排队](../../../../docs/terms.md)而不是再起一轮。占位之前那段空窗
  // 正是「刚发出就点停止毫无反应」这个 bug 的根因。
  const reserved = reserveTurn(input.conversationId, log);
  if (!reserved.ok) {
    // 两种拒绝原样透出：`busy` → 409（已有轮），`shutting_down` → 503（进程正在
    // [优雅关闭](../../../../docs/terms.md)，稍后重试，docs/agent/graceful-shutdown/tech.md §3.3）。
    return { ok: false, reason: reserved.reason };
  }
  const { reservation } = reserved;

  // `try/finally` 而不是在每个 `return` 前手写一次 `releaseTurn`：装配有六七条退出路径
  // （凭据、沙盒、buildSession、被停止、busy…），漏掉任何一条就把这个会话**永久锁死**
  // ——`isTurnActive` 恒真，此后所有消息只会排队、再也起不了轮。
  let handedOff = false;
  try {
    const outcome = await assembleAndStartTurn(deps, input, reservation, log);
    handedOff = outcome.ok; // 只有真的交给 `startTurn` 跑起来了才算交棒
    return outcome;
  } finally {
    if (!handedOff) {
      // 被停止过的占位会在这里补上「用户消息 + 已停止」两帧（`releaseTurn` 自己判断）；
      // 其余情况只是把登记撤掉。
      releaseTurn(deps.db, reservation, input.text, log);
    }
  }
}

/**
 * `launchTurn` 的装配主体——从 `launchTurn` 整段抽出来只为一件事：让上面那个
 * `try/finally`（[起轮占位](../../../../docs/terms.md)的撤销）能包住**全部**退出路径，
 * 而不必给这几百行重排缩进。
 *
 * `reservation` 贯穿全程：两个检查点读它的 `wasAborted()`，最后连同 session 一起交给
 * `startTurn`（就地升级成真正在跑的那一轮）。
 */
async function assembleAndStartTurn(
  deps: TurnLauncherDeps,
  input: LaunchTurnInput,
  reservation: TurnReservation,
  log: Logger,
): Promise<LaunchTurnOutcome> {
  const { conversationId, userId, text } = input;
  // 起轮装配打点（docs/app/telemetry/tech.md §2.4）：秒表从进入本函数就起，各段就地
  // 量、攒进 `timings`，等第一个 chunk 抵达才落库（见 `createMilestoneRecorder`）。
  const launchStopwatch = startStopwatch();

  const row = getConversation(deps.db, conversationId, userId);
  if (row === undefined) return { ok: false, reason: 'not_found' };

  let model: LanguageModel;
  let repoRef: GitHubRepoRef;
  let githubPat: string;
  try {
    model = deps.resolveModel();
    repoRef = resolveRepo();
    githubPat = resolveGithubPat();
  } catch (error) {
    return { ok: false, reason: 'error', message: describeError(error) };
  }

  let acquired: AcquiredSandbox;
  let acquireMs = 0;
  let touchMs = 0;
  const acquireStopwatch = startStopwatch();
  try {
    acquired = await deps.sandboxManager.acquire({
      conversationId,
      provider: row.provider,
      sandboxName: row.sandboxName,
      // Vercel resumes by name; E2B by its stored sandboxId (null → treated as brand-new and re-created).
      resumeToken:
        row.provider === 'e2b' ? (row.sandboxId ?? undefined) : row.sandboxName,
      branchName: row.branchName,
      repoCloneUrl: repoRef.cloneUrl,
      repoOwner: repoRef.owner,
      repoName: repoRef.repo,
      githubPat,
    });
    acquireMs = acquireStopwatch();
    const touchStopwatch = startStopwatch();
    await deps.sandboxManager.ensureLifetime(conversationId); // 每条用户消息把沙盒存活时长补足一次 — 见 docs/app/chat-webapp/tech.md §2.2
    touchMs = touchStopwatch();
  } catch (error) {
    return { ok: false, reason: 'error', message: describeError(error) };
  }

  // E2B only: an expired snapshot forces a re-create, giving a *new*
  // sandboxId — persist it so the next message resumes the right sandbox
  // (docs/host/sandbox-provider/tech.md §3.1). Vercel resumes by the stable name,
  // so its resume token never changes and this is a no-op.
  if (
    row.provider === 'e2b' &&
    acquired.resumeToken !== (row.sandboxId ?? undefined)
  ) {
    updateConversation(deps.db, conversationId, {
      sandboxId: acquired.resumeToken,
    });
  }

  // 停止检查点 1（docs/agent/turn-abort/tech.md §3.3）：沙盒那几个远程调用不接受
  // `AbortSignal`，掐不断（§6.5），但既然已经知道用户要停，就别再往下白跑 skill 扫描
  // 与 `buildSession`。放在上面那次 E2B [重连令牌](../../../../docs/terms.md)回写**之后**
  // ——那是有价值的副作用（下一轮要靠它恢复同一个沙盒），不该因为这一轮被停就丢掉。
  if (reservation.wasAborted()) return { ok: false, reason: 'aborted' };

  // docs/app/chat-webapp/tech.md §2.2c（审批链）, docs/agent/single-ledger/tech.md §6.2/§6.4: the session-level 审批分类器
  // (`ApprovalPolicy`, three-value) — `classifyApproval` decides on the
  // spot whether a call is `'allow'` or needs a human (`'review'`);
  // `@nimbo/core`'s loop only ever calls `onReview` (below) for the
  // latter, and only *after* it has already yielded a
  // `tool-approval-request` chunk. Captures `conversationId` (the *chat*
  // session id) — not `ctx.session.id`, which is `@nimbo/core`'s own internal
  // session id and means nothing to `turn-runner/registry.ts`'s `activeTurns` map.
  // 会话级授权先行（session-grants.ts，conversation_grants 表）：这次具体调用
  // （tool + 入参指纹）若已被**本轮发起者**（`userId`——自动出队时是排队者本人，
  // 见 `LaunchTurnInput.userId`）在本会话「会话内都允许」过，直接放行、不再进
  // 危险命令分类。未命中才回落到 classifyApproval。
  const approvalMode = resolveApprovalMode();
  const onApproval: ApprovalPolicy = (approvalInput, ctx) =>
    (
      hasSessionGrant(
        deps.db,
        conversationId,
        userId,
        ctx.toolName,
        approvalInput,
      )
    ) ?
      'allow'
    : classifyApproval(approvalMode, ctx.toolName, approvalInput);

  // docs/agent/single-ledger/tech.md §6.4: the 人审通道 (`ApprovalReviewer`) — `requestReview`
  // registers a pending decision and suspends until a human (or a
  // timeout) resolves it via `POST .../approvals/:callId`.
  const onReview: ApprovalReviewer = (request) => {
    // **顺序是硬要求**（docs/app/push-notification/tech.md §3.2）：先 `requestReview` 把
    // 挂起项登记好——审批卡片走 SSE 直播那条路，一步没改；通知是可选支路，绝不能
    // 排在它前面拖慢或拖挂它。同「观测绝不插在 chunk 送达用户的前面」。
    const decision = requestReview(conversationId, {
      callId: request.ctx.callId,
      toolName: request.toolName,
      input: request.input,
    });
    deps.notifier?.approvalPending({
      conversationId,
      userId,
      // 与上面 `requestReview` 登记用的是同一个 callId——通知上的裁决按钮就是靠它
      // 找回这条挂起项（docs/app/push-notification/tech.md §6.5）。
      callId: request.ctx.callId,
      toolName: request.toolName,
      input: request.input,
      // 与上面那次 `requestReview` 用的是同一个函数的同一次取值口径——通知的 TTL
      // 因此永远跟着审批超时走，不会各定各的（技术方案 §6.3）。
      timeoutMs: resolveApprovalTimeoutMs(),
    });
    return decision;
  };

  // docs/app/chat-webapp/tech.md §2.2c（审批链）: the ask-user bridge. Always wired in
  // (unlike `onApproval`'s auto-allow branch, there's no "skip asking" mode
  // for `ask-user` — see `chat-agent.ts`'s `BuildSessionOptions.onAskUser`).
  const onAskUser = (req: RequestUserAnswerInput): Promise<AskUserOutcome> => {
    // 同 `onReview`：先挂起、后通知。
    const outcome = requestUserAnswer(conversationId, req);
    deps.notifier?.questionPending({
      conversationId,
      userId,
      question: req.question,
      timeoutMs: resolveAskUserTimeoutMs(),
    });
    return outcome;
  };

  // docs/agent/single-ledger/tech.md §5 单-3: this turn's newly-appended messages are found by
  // slicing `session.toJSON().messages` past however many `kind =
  // 'message'` rows already existed for this session — the exact same
  // resumed `SessionState` handed to `buildSession` below, so the count
  // agrees with what the session itself started from.
  const loadStateStopwatch = startStopwatch();
  const resumeState = loadResumeState(deps.db, row);
  const priorMessageCount = resumeState?.messages.length ?? 0;
  const loadStateMs = loadStateStopwatch();

  // docs/app/composer-skill-mention/tech.md §1 改动 A：扫沙盒 `.agents/skills/*` 加载
  // **全部** skill（本功能之前 `buildSession` 内部硬读 frontend-design 一个路径）。
  // 放在这里而不是 `buildSession` 里，是因为同一份结果这一轮还要另做两件事——
  // 刷新[skill 清单](../../../../docs/terms.md)缓存（§2.1）、按 skill 名解析
  // [skill 提及](../../../../docs/terms.md)（§2.2）——没理由为同一批数据扫两遍沙盒。
  //
  // 计时区间刻意仍从这里起：`buildSessionMs` 的既有语义是「准备 session 花的时间，
  // 其中几乎全部是读 skill」，加载动作换个函数放并不改变这个含义（docs/app/telemetry/tech.md §2.4）。
  const buildSessionStopwatch = startStopwatch();
  const skills = await loadSkillsFromWorkspace(acquired.workspace, log);
  // 顺手刷新[skill 清单](../../../../docs/terms.md)缓存（docs/app/composer-skill-mention/tech.md §2.1）：
  // 用户这一路让 agent 往 `.agents/skills/` 装的新 skill，就是靠这里进菜单的——也是
  // 「清单最多滞后一轮」这句话的出处。清单没变时 `syncAvailableSkills` 不发 UPDATE
  // （绝大多数轮次都是这样），所以这不给每轮起轮加一次无谓的写。
  syncAvailableSkills(
    deps.db,
    conversationId,
    row.availableSkillsJson,
    toSkillSummaries(skills),
  );
  let session;
  try {
    session = await buildSession({
      model,
      workspace: acquired.workspace,
      skills,
      repoOwner: repoRef.owner,
      repoName: repoRef.repo,
      defaultBranch: acquired.defaultBranch,
      branchName: row.branchName,
      ...(resumeState !== undefined ? { resume: resumeState } : {}),
      onApproval,
      onReview,
      approvalMode,
      onAskUser,
      ...(deps.telemetry !== undefined ? { telemetry: deps.telemetry } : {}),
    });
  } catch (error) {
    return { ok: false, reason: 'error', message: describeError(error) };
  }
  const buildSessionMs = buildSessionStopwatch();

  // 停止检查点 2（docs/agent/turn-abort/tech.md §3.3）：装配全部做完、真正启动之前的最后一道关。
  if (reservation.wasAborted()) return { ok: false, reason: 'aborted' };

  /** `startTurn` 返回后即定，见下方 `onMilestone` 处的注释。 */
  let launchMs = 0;

  // 轮进行期间的保活**不在这里**了（docs/host/sandbox-keepalive/tech.md，KA-5）：以前这里起
  // 一个 turn 级心跳定时器，现在归适配器自己管。理由是适配器有两个这里拿不到的信号——
  // core 推来的[活动信号](../../../../docs/terms.md)、以及 exec 调用自身的进行状态
  // （一条跑十分钟的命令期间 core 一个 chunk 都不产出，只有适配器知道自己还在等）。
  // 上面那次 ensureLifetime 仍然要留：它管的是「这一轮真正开跑之前」那段。

  // [skill 提及](../../../../docs/terms.md)（docs/app/composer-skill-mention/tech.md §2.2）：
  // 扫出用户这条消息里点名的 skill，拼一行系统提示给模型。白名单是**这一轮真加载
  // 到的** skill 名——用户正常输入的 `/usr/local` 之类不会误中，点名了一个沙盒里
  // 并不存在的 skill 也不会凭空生成一句让模型去调必然失败的 load-skill。
  // 没有提及时 `buildModelText` 原样返回 `text`（同一个字符串，零副作用）。
  const modelText = buildModelText(
    text,
    extractMentionedSkills(
      text,
      skills.map((skill) => skill.name),
    ),
  );

  const { started } = startTurn({
    db: deps.db,
    conversationId,
    session,
    text,
    modelText,
    priorMessageCount,
    logger: log,
    // 交棒：把[起轮占位](../../../../docs/terms.md)就地升级成真正在跑的这一轮
    // （同一个 emitter 与 abortController，docs/agent/turn-abort/tech.md §3.3）。
    reservation,
    // 这一轮彻底结束（`activeTurns` 已清空）后接着起下一条排队消息——见文件头的
    // 依赖方向图。`void` 是刻意的：`turn-runner/` 的收尾不等待也不关心它。
    onTurnSettled: (settled) => {
      // 通知排在起下一轮**之前**：`notifier` 的队列抑制（技术方案 §5.3）要读的是
      // 「这一轮结束时队列里还有没有货」，而 `startNextQueuedTurn` 的第一件事就是
      // 出队。顺序反了，最后一条排队消息起轮时队列刚好空了，就会误报一次「跑完了」。
      // `notifier` 本身同步返回、内部自 catch，不会拖慢出队。
      deps.notifier?.turnSettled({
        conversationId,
        userId,
        status: settled.status,
      });
      void startNextQueuedTurn(deps, conversationId);
    },
    // 起轮装配打点（docs/app/telemetry/tech.md §2.4）。载荷是**惰性**求值的（传函数不传
    // 对象）只为一件事：`launchMs` 要等 `startTurn` 返回后才定下来（就在下面几行），
    // 而回调本身此刻就得交出去。回调不可能在那之前触发——`driveTurn` 在拿到第一个
    // chunk 前必然先 `await`，控制权早已回到本函数。
    onMilestone: createMilestoneRecorder(
      deps,
      conversationId,
      () => ({
        acquireMs,
        acquireMode: acquired.mode,
        touchMs,
        loadStateMs,
        buildSessionMs,
        launchMs,
      }),
      log,
    ),
  });
  launchMs = launchStopwatch();
  if (!started) return { ok: false, reason: 'busy' };

  return { ok: true };
}

/**
 * 自动[出队](../../../../docs/terms.md)：取[待发队列](../../../../docs/terms.md)队首起下一轮。
 * 由上一轮的 `onTurnSettled` 触发（`turn-runner/start.ts` 在 `activeTurns.delete()` **之后**
 * 调用——顺序是硬要求，否则这里的 `startTurn` 会被「已有进行中的一轮」守卫挡掉）。
 *
 * 失败处理（docs/agent/steer-and-queue/feature.md §2.5「出错时不吞消息」）：起轮失败就把这条
 * `requeueFront` 放回队首并记 error，**不重试、不设定时器**——靠「下一次有轮收尾」自然
 * 重试，避免沙盒持续不可用时后台无限重试烧钱。
 */
export async function startNextQueuedTurn(
  deps: TurnLauncherDeps,
  conversationId: string,
): Promise<void> {
  const log = deps.logger ?? defaultLogger;
  const { message } = dequeueMessage(deps.db, conversationId, log);
  if (message === undefined) return;

  log.info(LOG_SCOPE, 'dequeued message, starting next turn', {
    conversationId,
    messageId: message.id,
  });

  const outcome = await launchTurn(deps, {
    conversationId,
    userId: message.userId,
    text: message.text,
  });
  if (outcome.ok) return;

  if (outcome.reason === 'not_found') {
    // 会话在排队期间被删了（或不再属于排队者）——没有可放回的地方，丢弃并记一行。
    log.warn(LOG_SCOPE, 'dropped queued message: conversation not found', {
      conversationId,
      messageId: message.id,
    });
    return;
  }

  if (outcome.reason === 'aborted') {
    // 用户在这一轮的[起轮装配](../../../../docs/terms.md)期间按了[停止](../../../../docs/terms.md)
    // （docs/agent/turn-abort/tech.md §3.3）——**不 requeue**：放回队首等于没停，下一次有轮
    // 收尾时它又会被发出去。这条消息的「已停止」收尾帧已由 `releaseTurn` 落账本。
    log.info(LOG_SCOPE, 'queued message stopped before it started', {
      conversationId,
      messageId: message.id,
    });
    return;
  }

  requeueFront(deps.db, conversationId, message, log);

  if (outcome.reason === 'shutting_down') {
    // 进程正在[优雅关闭](../../../../docs/terms.md)——消息已放回队首，重启后下一次有轮
    // 收尾时自然重试。这是**正常关闭流程的一部分**，不是故障，所以记 info 不记 error。
    log.info(LOG_SCOPE, 'shutting down, queued message put back', {
      conversationId,
      messageId: message.id,
    });
    return;
  }

  log.error(LOG_SCOPE, 'failed to start queued turn, message put back', {
    conversationId,
    messageId: message.id,
    reason: outcome.reason,
    ...(outcome.reason === 'error' ? { error: outcome.message } : {}),
  });
}
