/**
 * 「起一轮」的全部装配（docs/tech/steer-and-queue.md §3）——从 `routes/chat.ts` 的
 * `POST .../messages` handler 里整段抽出来的：解析模型/仓库凭据 → 取沙盒
 * （`sandboxManager.acquire` + `touch`）→ 回写 E2B [重连令牌](../../../../docs/terms.md)
 * → 装配[审批链](../../../../docs/terms.md)的三个回调 → 从[账本](../../../../docs/terms.md)
 * 重建 `SessionState` → `buildSession` → `turn-runner.ts` 的 `startTurn`。
 *
 * **为什么要抽**：这段装配有两个调用方，其中一个不在任何 HTTP 请求上下文里——
 *
 * 1. `routes/chat.ts` 的 `POST .../messages`（用户主动发消息、没有进行中的一轮）；
 * 2. **自动[出队](../../../../docs/terms.md)**：一轮收尾后取[待发队列](../../../../docs/terms.md)
 *    队首起下一轮（`startNextQueuedTurn`）。
 *
 * **依赖方向**（不成环，docs/tech/steer-and-queue.md §3）：
 *
 * ```
 * routes/chat.ts ──→ turn-launcher.ts ──→ turn-runner.ts（startTurn）
 *                           ↑                     │
 *                           └─── onTurnSettled ───┘（回调由本文件注入，turn-runner 不 import 本文件）
 * ```
 *
 * `turn-runner.ts` 因此完全不认识「队列」这个概念，它只多了一个「这一轮彻底结束了」
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
} from './turn-runner.js';
import { requestReview, requestUserAnswer, startTurn } from './turn-runner.js';

const LOG_SCOPE = 'turn-launcher';

// ---------------------------------------------------------------------------
// 起轮装配打点（docs/tech/telemetry.md §2.4）
// ---------------------------------------------------------------------------

/**
 * 一次[起轮装配](../../../../docs/terms.md)的分段耗时（毫秒，墙钟）。全部在
 * `launchTurn` 里就地量出来，攒到这一轮的第一个 chunk 抵达时才落库——那一刻
 * nimbo 会话 id 与轮号才确定（遥测的关联键 `"<sessionId>#<turn>"`），理由见
 * docs/tech/telemetry.md §2.4「为什么在第一个 chunk 抵达时才落库」。
 */
interface LaunchTimings {
  /** `sandboxManager.acquire()`——最可能的大头。 */
  acquireMs: number;
  /** 这次 acquire 走的哪条路（`sandbox-manager.ts` 的 `AcquireMode`）：缓存命中/恢复/重建。 */
  acquireMode: AcquireMode;
  /** `sandboxManager.touch()`——沙盒续期的远程往返，每轮必做。 */
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
  /** telemetry 事件集成（docs/tech/chat-webapp.md §11.4）——缺省 undefined = 不采集。 */
  telemetry?: SessionTelemetry;
  /**
   * 遥测**写侧**的落库口（docs/tech/telemetry.md §2.4）——本文件用它写
   * `turn-prepare`/`turn-first-output` 两条[起轮装配](../../../../docs/terms.md)事件。
   * 与 `telemetry`（模型调用事件的集成对象，交给 core 透传给 `streamText`）是同一个库
   * 的两个入口：那条路由 ai 的回调发事件，这条是本文件自己发。缺省 undefined = 不采集，
   * 与整个遥测通道「可关、可删、消费方按缺席设计」的定位一致。
   */
  telemetryStore?: TelemetryStore;
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
  /** 已有进行中的一轮（`startTurn` 的守卫）——路由转 409。窄竞态，正常流程走不到。 */
  | { ok: false; reason: 'busy' }
  /** 模型/仓库凭据/沙盒装配失败——路由转 500；自动出队遇到它把消息放回队首。 */
  | { ok: false; reason: 'error'; message: string };

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reassembles a `SessionState` from the UIMessage 单账本 (docs/tech/single-ledger.md §5 单-3): the session-scalar header (`row.agentSessionId`/
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
  // turn-start user message row (turn-runner.ts) lands the moment a turn
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
 * 起一轮：装配好一切并交给 `turn-runner.ts` 的 `startTurn` 在进程内驱动（不 `await`
 * 这一轮跑完——本函数只负责把它**启动**起来，事件走 `GET .../stream`）。
 *
 * 注入的 `onTurnSettled` 是[排队](../../../../docs/terms.md)链条的关节：这一轮彻底结束
 * 后自动接着起下一条排队消息（`startNextQueuedTurn`），从而把「一轮一条」串下去。
 */
export async function launchTurn(
  deps: TurnLauncherDeps,
  input: LaunchTurnInput,
): Promise<LaunchTurnOutcome> {
  const { conversationId, userId, text } = input;
  const log = deps.logger ?? defaultLogger;
  // 起轮装配打点（docs/tech/telemetry.md §2.4）：秒表从进入本函数就起，各段就地
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
    await deps.sandboxManager.touch(conversationId); // every user message rolls the sandbox's idle timeout forward — see docs/tech/chat-webapp.md §2.2
    touchMs = touchStopwatch();
  } catch (error) {
    return { ok: false, reason: 'error', message: describeError(error) };
  }

  // E2B only: an expired snapshot forces a re-create, giving a *new*
  // sandboxId — persist it so the next message resumes the right sandbox
  // (docs/tech/sandbox-provider.md §3.1). Vercel resumes by the stable name,
  // so its resume token never changes and this is a no-op.
  if (
    row.provider === 'e2b' &&
    acquired.resumeToken !== (row.sandboxId ?? undefined)
  ) {
    updateConversation(deps.db, conversationId, {
      sandboxId: acquired.resumeToken,
    });
  }

  // docs/tech/chat-webapp.md §2.2c（审批链）, docs/tech/single-ledger.md §6.2/§6.4: the session-level 审批分类器
  // (`ApprovalPolicy`, three-value) — `classifyApproval` decides on the
  // spot whether a call is `'allow'` or needs a human (`'review'`);
  // `@nimbo/core`'s loop only ever calls `onReview` (below) for the
  // latter, and only *after* it has already yielded a
  // `tool-approval-request` chunk. Captures `conversationId` (the *chat*
  // session id) — not `ctx.session.id`, which is `@nimbo/core`'s own internal
  // session id and means nothing to `turn-runner.ts`'s `activeTurns` map.
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

  // docs/tech/single-ledger.md §6.4: the 人审通道 (`ApprovalReviewer`) — `requestReview`
  // registers a pending decision and suspends until a human (or a
  // timeout) resolves it via `POST .../approvals/:callId`.
  const onReview: ApprovalReviewer = (request) =>
    requestReview(conversationId, {
      callId: request.ctx.callId,
      toolName: request.toolName,
      input: request.input,
    });

  // docs/tech/chat-webapp.md §2.2c（审批链）: the ask-user bridge. Always wired in
  // (unlike `onApproval`'s auto-allow branch, there's no "skip asking" mode
  // for `ask-user` — see `chat-agent.ts`'s `BuildSessionOptions.onAskUser`).
  const onAskUser = (req: RequestUserAnswerInput): Promise<AskUserOutcome> =>
    requestUserAnswer(conversationId, req);

  // docs/tech/single-ledger.md §5 单-3: this turn's newly-appended messages are found by
  // slicing `session.toJSON().messages` past however many `kind =
  // 'message'` rows already existed for this session — the exact same
  // resumed `SessionState` handed to `buildSession` below, so the count
  // agrees with what the session itself started from.
  const loadStateStopwatch = startStopwatch();
  const resumeState = loadResumeState(deps.db, row);
  const priorMessageCount = resumeState?.messages.length ?? 0;
  const loadStateMs = loadStateStopwatch();

  // docs/tech/composer-skill-mention.md §1 改动 A：扫沙盒 `.agents/skills/*` 加载
  // **全部** skill（本功能之前 `buildSession` 内部硬读 frontend-design 一个路径）。
  // 放在这里而不是 `buildSession` 里，是因为同一份结果这一轮还要另做两件事——
  // 刷新[skill 清单](../../../../docs/terms.md)缓存（§2.1）、按 skill 名解析
  // [skill 提及](../../../../docs/terms.md)（§2.2）——没理由为同一批数据扫两遍沙盒。
  //
  // 计时区间刻意仍从这里起：`buildSessionMs` 的既有语义是「准备 session 花的时间，
  // 其中几乎全部是读 skill」，加载动作换个函数放并不改变这个含义（docs/tech/telemetry.md §2.4）。
  const buildSessionStopwatch = startStopwatch();
  const skills = await loadSkillsFromWorkspace(acquired.workspace, log);
  // 顺手刷新[skill 清单](../../../../docs/terms.md)缓存（docs/tech/composer-skill-mention.md §2.1）：
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
  /** `startTurn` 返回后即定，见下方 `onMilestone` 处的注释。 */
  let launchMs = 0;

  // 轮进行期间的保活心跳（docs/tech/sandbox-provider.md §5.1）：沙盒超时是**绝对
  // 截止时间**，跑命令不会把它往后推（E2B 的 set-timeout 明说「从请求时刻起 x 秒」）。
  // 上面那次 touch 只保证「从现在起还有 idleTimeout」，一轮跑得比它长就会被平台从
  // 底下暂停掉。心跳只在这一轮存活期间跑，`onTurnSettled` 停——不能常驻，否则
  // 空闲自动暂停这套机制就整个失效了（还烧钱）。
  const stopHeartbeat = deps.sandboxManager.startHeartbeat(conversationId);

  // [skill 提及](../../../../docs/terms.md)（docs/tech/composer-skill-mention.md §2.2）：
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
    // 这一轮彻底结束（`activeTurns` 已清空）后接着起下一条排队消息——见文件头的
    // 依赖方向图。`void` 是刻意的：`turn-runner.ts` 的 `finally` 不等待也不关心它。
    onTurnSettled: () => {
      stopHeartbeat();
      void startNextQueuedTurn(deps, conversationId);
    },
    // 起轮装配打点（docs/tech/telemetry.md §2.4）。载荷是**惰性**求值的（传函数不传
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
  // 起轮被「已有进行中的一轮」守卫挡掉时 `onTurnSettled` 永远不会来，心跳得就地收掉。
  if (!started) {
    stopHeartbeat();
    return { ok: false, reason: 'busy' };
  }

  return { ok: true };
}

/**
 * 自动[出队](../../../../docs/terms.md)：取[待发队列](../../../../docs/terms.md)队首起下一轮。
 * 由上一轮的 `onTurnSettled` 触发（`turn-runner.ts` 在 `activeTurns.delete()` **之后**
 * 调用——顺序是硬要求，否则这里的 `startTurn` 会被「已有进行中的一轮」守卫挡掉）。
 *
 * 失败处理（docs/features/steer-and-queue.md §2.5「出错时不吞消息」）：起轮失败就把这条
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

  requeueFront(deps.db, conversationId, message, log);
  log.error(LOG_SCOPE, 'failed to start queued turn, message put back', {
    conversationId,
    messageId: message.id,
    reason: outcome.reason,
    ...(outcome.reason === 'error' ? { error: outcome.message } : {}),
  });
}
