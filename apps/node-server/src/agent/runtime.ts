/**
 * chat 应用的 `@runko/agent` 装配——**取代了原先的 `turn-launcher.ts` + `turn-runner/`
 * 那九个文件**。
 *
 * 现在这里只剩下真正属于 chat 应用的东西：
 *
 * - **[起轮装配](../../../../docs/terms.md)那一段**（`prepareTurn`）：取沙盒 → 续期 →
 *   回写 E2B [重连令牌](../../../../docs/terms.md) → 扫 skill 并刷新[清单](../../../../docs/terms.md)
 *   缓存 → 拼 instructions → 装[审批分类器](../../../../docs/terms.md)。
 * - **可选外围的挂钩**：遥测打点、推送通知。
 *
 * 轮的生命周期（占位、驱动、收尾、[排队](../../../../docs/terms.md)与[出队](../../../../docs/terms.md)、
 * [停止](../../../../docs/terms.md)、[交权](../../../../docs/terms.md)、[崩溃恢复](../../../../docs/terms.md)）
 * 全在框架里，本文件一行都不写。
 */
import type {
  AgentRuntime,
  RuntimeHooks,
  SessionFactory,
  TurnPreparation,
} from '@runko/agent';
import { createAgentRuntime } from '@runko/agent';
import type {
  ApprovalPolicy,
  RunkoExec,
  RunkoFS,
  SessionTelemetry,
  Tool,
} from '@runko/core';
import { defineAgent } from '@runko/sdk';
import type { LanguageModel } from 'ai';

import type { Logger } from '../logger.js';
import { logger as defaultLogger } from '../logger.js';
import type { ChatNotifier } from '../push/notifier.js';
import type { TelemetryStore } from '../telemetry.js';
import { classifyApproval, resolveApprovalMode } from './approval-policy.js';
import { buildInstructions, gateWorkspace } from './chat-agent.js';
import { hasConversationGrant } from './conversation-grants.js';
import { resolveGithubPat, resolveRepo } from './github-repo.js';
import { createChatArbitration, createChatPersistence } from './persistence.js';
import type { AcquireMode, SandboxManager } from './sandbox-manager.js';
import {
  buildModelText,
  extractMentionedSkills,
  loadSkillsFromWorkspace,
  toSkillSummaries,
} from './skill-catalog.js';
import type { Db } from './store.js';
import {
  getConversationById,
  syncAvailableSkills,
  updateConversation,
} from './store.js';
import { createWebSearchToolFromEnv } from './web-search.js';

const LOG_SCOPE = 'runtime';

/** 见下方 `agent:` 处的注释——永远会被 `prepareTurn` 覆盖，不会被解析。 */
const PLACEHOLDER_MODEL = 'runko/overridden-per-turn';

// ---------------------------------------------------------------------------
// 起轮装配打点（docs/ingress/tech/telemetry.md §2.4）
// ---------------------------------------------------------------------------

/**
 * 一次[起轮装配](../../../../docs/terms.md)的分段耗时（毫秒，墙钟）。就地量出来、攒着，
 * 等这一轮第一个 chunk 抵达时才落库——那一刻 runko 会话 id 与轮号才确定（遥测的关联键
 * 是 `"<sessionId>#<turn>"`）。
 */
interface LaunchTimings {
  /** `sandboxManager.acquire()`——最可能的大头。 */
  acquireMs: number;
  /** 这次 acquire 走的哪条路：缓存命中 / 恢复 / 重建。 */
  acquireMode: AcquireMode;
  /** `ensureLifetime()`——沙盒续期的远程往返，每轮必做。 */
  touchMs: number;
  /** 扫沙盒 `.agents/skills/*` 加载 skill 附属文件。 */
  buildSessionMs: number;
  /** `prepareTurn` 全程。 */
  launchMs: number;
}

function startStopwatch(): () => number {
  const startedAt = Date.now();
  return () => Date.now() - startedAt;
}

export interface ChatRuntimeDeps {
  db: Db;
  sandboxManager: SandboxManager;
  resolveModel: () => LanguageModel;
  /** telemetry 事件集成（透传给 core，逐 turn 的模型调用事件）。缺省 = 不采集。 */
  telemetry?: SessionTelemetry;
  /** 遥测**写侧**的落库口——本文件用它写起轮装配的两条事件。缺省 = 不采集。 */
  telemetryStore?: TelemetryStore;
  /** 推送通知。缺省 = 不发。 */
  notifier?: ChatNotifier;
  logger?: Logger;
  /** [联网搜索](../../../../docs/terms.md)工具——不传时按 `EXA_API_KEY` 决定注不注册；显式传入用于测试。 */
  webSearchTool?: Tool;
  /**
   * 覆盖「怎么造出这一轮的 `Session`」。缺省即框架的默认工厂（core 的 `createSession`
   * + 文件工具八件套）。**集成测试用它塞一对假的 `stream()`/`toJSON()`**，于是整条轮编排
   * 链路可以在零模型、零沙盒下跑完。
   */
  sessionFactory?: SessionFactory;
}

/**
 * chat 应用的 runtime。**进程内单例**（见文件底部），测试可以自己造一个隔离的。
 */
export function createChatRuntime(deps: ChatRuntimeDeps): AgentRuntime {
  const log = deps.logger ?? defaultLogger;
  /** 每一轮的装配耗时，按 conversationId 暂存，等第一个 chunk 抵达时取走。 */
  const pendingTimings = new Map<string, LaunchTimings>();

  /**
   * 会话「活跃」这件事的**唯一写入点**。
   *
   * DTO 里的 `sleeping` 是**读时推**的（`Date.now() - lastActiveAt > 空闲超时`），所以
   * 这一列没人写 = 所有会话过了空闲窗口就永远显示「休眠」，哪怕正在跑。旧实现是每轮
   * 收尾写一次（`turn-runner/persistence.ts` 的 `finalizeTurnPersistence`），迁移时连同
   * 那个文件一起删掉了，这里补回来——**起轮和收尾各写一次**：只在收尾写的话，一轮跑得
   * 比空闲窗口还久时，界面中途就会把它显示成休眠。
   */
  const markActive = (conversationId: string): void => {
    try {
      updateConversation(deps.db, conversationId, {
        status: 'active',
        lastActiveAt: new Date(),
      });
    } catch (error) {
      // 纯展示用的一列，写失败不该反噬到这一轮。
      log.warn(LOG_SCOPE, 'failed to refresh lastActiveAt', {
        conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const hooks: RuntimeHooks = {
    onTurnStart: ({ conversationId }) => {
      markActive(conversationId);
    },
    onFirstChunk: ({ conversationId, sessionId, turn, sinceStartMs }) => {
      const timings = pendingTimings.get(conversationId);
      pendingTimings.delete(conversationId);
      if (timings === undefined) {
        return;
      }
      // 一行 info 日志与遥测同源同刻——遥测关掉了，运维照样能从 stdout 看到这一轮慢在哪
      // （遥测是耗材，日志不是）。
      log.info(LOG_SCOPE, 'turn prepared', {
        conversationId,
        ...timings,
        firstChunkMs: sinceStartMs,
      });
      try {
        deps.telemetryStore?.record(
          'turn-prepare',
          `${sessionId}#${String(turn)}`,
          { ...timings, firstChunkMs: sinceStartMs },
        );
      } catch {
        // 遥测永不影响 turn。
      }
    },
    onFirstOutput: ({ conversationId, sessionId, turn, sinceStartMs }) => {
      log.debug(LOG_SCOPE, 'turn first output', {
        conversationId,
        firstOutputMs: sinceStartMs,
      });
      try {
        deps.telemetryStore?.record(
          'turn-first-output',
          `${sessionId}#${String(turn)}`,
          { firstOutputMs: sinceStartMs },
        );
      } catch {
        // 同上。
      }
    },
    onTurnSettled: ({ conversationId, status, input }) => {
      markActive(conversationId);
      deps.notifier?.turnSettled({
        conversationId,
        userId: input.userId ?? '',
        status,
      });
    },
    onApprovalPending: ({
      conversationId,
      callId,
      toolName,
      input,
      userId,
      timeoutMs,
    }) => {
      deps.notifier?.approvalPending({
        conversationId,
        userId: userId ?? '',
        callId,
        toolName,
        input,
        timeoutMs,
      });
    },
    onQuestionPending: ({ conversationId, question, userId, timeoutMs }) => {
      deps.notifier?.questionPending({
        conversationId,
        userId: userId ?? '',
        question,
        timeoutMs,
      });
    },
  };

  return createAgentRuntime({
    // instructions/skills/tools/model 全是**逐轮**决定的（仓库、分支、沙盒里现有的
    // skill、按会话选的模型），所以这里只放一个占位——每一轮的 `prepareTurn` 都会把
    // 它整个覆盖掉，这个字符串永远不会被真正解析成模型。
    //
    // **刻意不在这里调 `deps.resolveModel()`**：本函数在模块顶层被求值（`routes/chat.ts`
    // 底部的单例），那时读环境变量会让「没配 DeepSeek 凭据」从一次请求失败升级成
    // **整个进程 import 就崩**——连不碰 agent 的端点（列会话、推送订阅）都起不来。
    agent: defineAgent({ model: PLACEHOLDER_MODEL }),
    persistence: createChatPersistence(deps.db, log),
    arbitration: createChatArbitration(deps.db),
    logger: log,
    hooks,
    ...(deps.sessionFactory !== undefined ?
      { sessionFactory: deps.sessionFactory }
    : {}),
    prepareTurn: async ({ conversationId, input, signal }) => {
      const launchStopwatch = startStopwatch();
      const row = getConversationById(deps.db, conversationId);
      if (row === undefined) {
        throw new Error(`Conversation ${conversationId} no longer exists.`);
      }

      const model = deps.resolveModel();
      const repoRef = resolveRepo();
      const githubPat = resolveGithubPat();

      const acquireStopwatch = startStopwatch();
      const acquired = await deps.sandboxManager.acquire({
        conversationId,
        provider: row.provider,
        sandboxName: row.sandboxName,
        // Vercel 按名字恢复；E2B 按落库的 sandboxId（null 视同全新，重建）。
        resumeToken:
          row.provider === 'e2b' ?
            (row.sandboxId ?? undefined)
          : row.sandboxName,
        branchName: row.branchName,
        repoCloneUrl: repoRef.cloneUrl,
        repoOwner: repoRef.owner,
        repoName: repoRef.repo,
        githubPat,
      });
      const acquireMs = acquireStopwatch();

      const touchStopwatch = startStopwatch();
      await deps.sandboxManager.ensureLifetime(conversationId);
      const touchMs = touchStopwatch();

      // E2B only：快照过期会强制重建、拿到**新的** sandboxId——落库，否则下一轮恢复的
      // 是错的那个沙盒。放在这里（而不是等这一轮跑完）是因为它是有价值的副作用：这一轮
      // 就算被停止，下一轮也该恢复到同一个沙盒。
      if (
        row.provider === 'e2b' &&
        acquired.resumeToken !== (row.sandboxId ?? undefined)
      ) {
        updateConversation(deps.db, conversationId, {
          sandboxId: acquired.resumeToken,
        });
      }

      const buildStopwatch = startStopwatch();
      const skills = await loadSkillsFromWorkspace(acquired.workspace, log);
      // 顺手刷新 [skill 清单](../../../../docs/terms.md)缓存——用户这一路让 agent 往
      // `.agents/skills/` 装的新 skill 就是靠这里进菜单的，也是「清单最多滞后一轮」的出处。
      // 清单没变时不发 UPDATE（绝大多数轮次都是这样）。
      syncAvailableSkills(
        deps.db,
        conversationId,
        row.availableSkillsJson,
        toSkillSummaries(skills),
      );
      const buildSessionMs = buildStopwatch();

      // 装配期间被[停止](../../../../docs/terms.md)：**这里只记一行，真正的拦截在框架那边。**
      //
      // 装配器不能自己抛来终止——抛出去这一轮会被收成 `status:'failed'`，而用户按的是
      // 停止、应该收成 `'interrupted'`。框架在 `prepareTurn` 返回之后、建 session 之前
      // 和建完之后各查一次 `turn.aborted`，命中就走 `finishAborted`（正确的收尾状态 +
      // `dispose`）。这一行的价值只是让日志里能看出「这一轮是在装配窗口里被停的」。
      if (signal.aborted) {
        log.debug(LOG_SCOPE, 'turn aborted during preparation', {
          conversationId,
        });
      }

      const approvalMode = resolveApprovalMode();
      const userId = input.userId ?? row.userId;
      // [审批分类器](../../../../docs/terms.md)：产品决策，归 chat 层。
      // [会话级授权](../../../../docs/terms.md)先行——这次具体调用（tool + 入参指纹）若已被
      // **本轮发起者**在本会话「会话内都允许」过，直接放行；未命中才回落到危险命令分类。
      const onApproval: ApprovalPolicy = (approvalInput, ctx) =>
        (
          hasConversationGrant(
            deps.db,
            conversationId,
            userId,
            ctx.toolName,
            approvalInput,
          )
        ) ?
          'allow'
        : classifyApproval(approvalMode, ctx.toolName, approvalInput);

      const tools: Record<string, Tool> = {};
      const webSearchTool = deps.webSearchTool ?? createWebSearchToolFromEnv();
      if (webSearchTool !== undefined) {
        tools['web-search'] = webSearchTool;
      }

      // [skill 提及](../../../../docs/terms.md)：扫出用户这条消息里点名的 skill，拼一行系统
      // 提示给模型。白名单是**这一轮真加载到的** skill 名——用户正常输入的 `/usr/local`
      // 之类不会误中。没有提及时 `buildModelText` 原样返回（同一个字符串，零副作用）。
      const modelText = buildModelText(
        input.text,
        extractMentionedSkills(
          input.text,
          skills.map((skill) => skill.name),
        ),
      );

      pendingTimings.set(conversationId, {
        acquireMs,
        acquireMode: acquired.mode,
        touchMs,
        buildSessionMs,
        launchMs: launchStopwatch(),
      });

      const workspace: RunkoFS & RunkoExec =
        approvalMode === 'off' ?
          acquired.workspace
        : gateWorkspace(acquired.workspace);

      const preparation: TurnPreparation = {
        workspace,
        model,
        skills,
        instructions: buildInstructions({
          repoOwner: repoRef.owner,
          repoName: repoRef.repo,
          defaultBranch: acquired.defaultBranch,
          branchName: row.branchName,
          hasWebSearch: tools['web-search'] !== undefined,
        }),
        onApproval,
        modelText,
        ...(Object.keys(tools).length > 0 ? { tools } : {}),
        ...(deps.telemetry !== undefined ? { telemetry: deps.telemetry } : {}),
      };
      return preparation;
    },
  });
}
