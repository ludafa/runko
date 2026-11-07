/**
 * chat 应用的[起轮装配](../../../../docs/terms.md)与运行时挂钩——**两个服务端共用的那一份**。
 *
 * 这里只放真正属于 chat 应用的东西：
 *
 * - **起轮装配**（`prepareTurn`）：取沙盒 → 续期 → 回写 E2B [重连令牌](../../../../docs/terms.md) →
 *   扫 skill 并刷新[清单](../../../../docs/terms.md)缓存 → 拼 instructions → 装[审批分类器](../../../../docs/terms.md)。
 * - **挂钩**（`hooks`）：会话「活跃」时间、遥测打点、推送通知、本地沙盒快照。
 *
 * 宿主各自把这两样交给 `@runko/agent`：Node 版配租约仲裁与交权（`node-server` 的 `agent/runtime.ts`），
 * Cloudflare 版配会话对象（`@runko/durable-object`）。轮的生命周期全在框架里，这里一行都不写。
 */
import type { RuntimeHooks, TurnPreparation, TurnPreparer } from '@runko/agent';
import type {
  ApprovalPolicy,
  JsonValue,
  RunkoExec,
  RunkoFS,
  SessionTelemetry,
  Tool,
} from '@runko/core';
import type { LanguageModel } from 'ai';

import type { EnvLike } from '../env.js';
import { processEnv } from '../env.js';
import type { Logger } from '../logger.js';
import { logger as defaultLogger } from '../logger.js';
import { classifyApproval, resolveApprovalMode } from './approval-policy.js';
import { buildInstructions, gateWorkspace } from './chat-agent.js';
import { hasConversationGrant } from './conversation-grants.js';
import type { GithubApp, GithubRepoRef } from './github-app.js';
import { GithubRepoForbiddenError, splitFullName } from './github-app.js';
import { LocalWorkspaceTooLargeError } from './local-sandbox.js';
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

/** 遥测的写口（Node 版的 `TelemetryStore` 满足它）。 */
export interface TurnTelemetryRecorder {
  record(
    eventType: string,
    functionId: string | undefined,
    event: unknown,
  ): void;
}

/** 推送通知的三个时机（Node 版的 `ChatNotifier` 满足它；Cloudflare 版不发推送）。 */
export interface TurnNotifier {
  approvalPending(input: {
    conversationId: string;
    userId: string;
    callId: string;
    toolName: string;
    input: JsonValue;
    timeoutMs: number;
  }): void;
  questionPending(input: {
    conversationId: string;
    userId: string;
    question: string;
    timeoutMs: number;
  }): void;
  turnSettled(input: {
    conversationId: string;
    userId: string;
    status: Parameters<NonNullable<RuntimeHooks['onTurnSettled']>>[0]['status'];
  }): void;
}

export interface ChatTurnAssemblyDeps {
  /** 会话表与授权表所在的库：Node 版的共享库，Cloudflare 版的 D1。 */
  db: Db;
  sandboxManager: SandboxManager;
  resolveModel: () => LanguageModel;
  /** 起轮时取安装令牌用。 */
  githubApp: GithubApp;
  /** telemetry 事件集成（透传给 core，逐 turn 的模型调用事件）。缺省 = 不采集。 */
  telemetry?: SessionTelemetry;
  /** 遥测**写侧**的落库口——本文件用它写起轮装配的两条事件。缺省 = 不采集。 */
  telemetryStore?: TurnTelemetryRecorder;
  /** 推送通知。缺省 = 不发。 */
  notifier?: TurnNotifier;
  logger?: Logger;
  /** [联网搜索](../../../../docs/terms.md)工具——不传时按 `EXA_API_KEY` 决定注不注册；显式传入用于测试。 */
  webSearchTool?: Tool;
  /** 读审批档位、联网搜索 key 的地方。缺省 `process.env`。 */
  env?: EnvLike;
}

export interface ChatTurnAssembly {
  prepareTurn: TurnPreparer;
  hooks: RuntimeHooks;
}

/**
 * 造出 chat 应用的起轮装配与挂钩。每个运行时一份（里面有按会话暂存的装配耗时）。
 */
export function createChatTurnAssembly(
  deps: ChatTurnAssemblyDeps,
): ChatTurnAssembly {
  const log = deps.logger ?? defaultLogger;
  const githubApp = deps.githubApp;
  const env = deps.env ?? processEnv();
  /** 每一轮的装配耗时，按 conversationId 暂存，等第一个 chunk 抵达时取走。 */
  const pendingTimings = new Map<string, LaunchTimings>();

  /**
   * 会话「活跃」这件事的**唯一写入点**。
   *
   * DTO 里的 `sleeping` 是**读时推**的（`Date.now() - lastActiveAt > 空闲超时`），所以
   * 这一列没人写，所有会话过了空闲窗口就会显示「休眠」，哪怕正在跑。**起轮和收尾各写一次**：
   * 只在收尾写的话，一轮跑得比空闲窗口还久时，界面中途就会把它显示成休眠。
   */
  const markActive = (conversationId: string): void => {
    // 不等它写完：纯展示用的一列，这一轮没必要为它多等一次往返。
    void updateConversation(deps.db, conversationId, {
      status: 'active',
      lastActiveAt: new Date(),
    }).catch((error: unknown) => {
      // 写失败不该反噬到这一轮。
      log.warn(LOG_SCOPE, 'failed to refresh lastActiveAt', {
        conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
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
      // [已交权](../../../../docs/terms.md)不是结束：这一轮由别的节点接着跑，那边收尾时才通知。但沙盒快照照存——
      // 接手节点要用它。
      // [本地沙盒](../../../../docs/terms.md)的文件在内存里，这里存一份快照下来——进程没了、
      // 或者下一轮落在别的副本上，都还能接着用。别的档是空操作。
      void deps.sandboxManager
        .persist(conversationId)
        .catch((error: unknown) => {
          // 太大存不下是要人处理的（重启就丢改动），记 error；别的失败下一轮收尾会再存。
          const level =
            error instanceof LocalWorkspaceTooLargeError ? 'error' : 'warn';
          log[level](LOG_SCOPE, 'failed to persist local workspace', {
            conversationId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      if (status === 'handed-over') {
        return;
      }
      // 接着跑、恢复工具收尾的那一轮没有「谁发的」（框架给的 `userId` 是空的）：通知发给会话的主人。
      void resolveOwner(conversationId, input.userId).then((userId) => {
        deps.notifier?.turnSettled({ conversationId, userId, status });
      });
    },
    // [本地沙盒](../../../../docs/terms.md)的文件在内存里：交权放手之前、以及工具在本节点上收尾跑完、结果写库之前，
    // 都要**等**快照存好——接手节点随时会开始读它。别的档是空操作。
    onHandOff: async ({ conversationId }) => {
      await deps.sandboxManager.persist(conversationId);
    },
    onToolTailFinished: async ({ conversationId }) => {
      await deps.sandboxManager.persist(conversationId);
    },
    // 接手节点起的轮（接着跑、恢复工具收尾）没有「谁发的」：推送发给会话的主人。
    onApprovalPending: ({
      conversationId,
      callId,
      toolName,
      input,
      userId,
      timeoutMs,
    }) => {
      void resolveOwner(conversationId, userId).then((owner) => {
        deps.notifier?.approvalPending({
          conversationId,
          userId: owner,
          callId,
          toolName,
          input,
          timeoutMs,
        });
      });
    },
    onQuestionPending: ({ conversationId, question, userId, timeoutMs }) => {
      void resolveOwner(conversationId, userId).then((owner) => {
        deps.notifier?.questionPending({
          conversationId,
          userId: owner,
          question,
          timeoutMs,
        });
      });
    },
  };

  async function resolveOwner(
    conversationId: string,
    userId: string | undefined,
  ): Promise<string> {
    if (userId !== undefined && userId !== '') {
      return userId;
    }
    const row = await getConversationById(deps.db, conversationId).catch(
      () => undefined,
    );
    return row?.userId ?? '';
  }

  const prepareTurn: TurnPreparer = async ({
    conversationId,
    input,
    signal,
  }) => {
    const launchStopwatch = startStopwatch();
    const row = await getConversationById(deps.db, conversationId);
    if (row === undefined) {
      throw new Error(`Conversation ${conversationId} no longer exists.`);
    }

    const model = deps.resolveModel();
    // [本地沙盒](../../../../docs/terms.md)没有 git：仓库与令牌这两个配置这一档不读，
    // 什么都没配也起得来。
    const usesGit = row.provider !== 'local';
    let repoRef: GithubRepoRef | undefined;
    let githubToken: string | undefined;
    if (usesGit) {
      // 老会话：按全局仓库建的那批，没有安装/仓库 id——它们不再能开新一轮
      // （docs/ingress/tech/github-repo-access.md §7），历史照常能看。
      if (
        row.repo === null ||
        row.githubInstallationId === null ||
        row.githubRepoId === null
      ) {
        throw new Error('这个会话建于按用户授权之前，请新建会话');
      }
      repoRef = splitFullName(row.repo);
      try {
        const minted = await githubApp.getRepoToken({
          userId: row.userId,
          installationId: row.githubInstallationId,
          repoId: row.githubRepoId,
        });
        githubToken = minted.token;
      } catch (error) {
        if (error instanceof GithubRepoForbiddenError) {
          throw new Error('没有权限访问这个仓库了', { cause: error });
        }
        throw error;
      }
    }

    const acquireStopwatch = startStopwatch();
    const acquired = await deps.sandboxManager.acquire({
      conversationId,
      provider: row.provider,
      sandboxName: row.sandboxName,
      // Vercel 按名字恢复；E2B 按落库的 sandboxId（null 视同全新，重建）。
      resumeToken:
        row.provider === 'e2b' ? (row.sandboxId ?? undefined) : row.sandboxName,
      ...(row.branchName !== null ? { branchName: row.branchName } : {}),
      ...(repoRef !== undefined ?
        {
          repoCloneUrl: repoRef.cloneUrl,
          repoOwner: repoRef.owner,
          repoName: repoRef.repo,
        }
      : {}),
      ...(githubToken !== undefined ? { githubToken } : {}),
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
      await updateConversation(deps.db, conversationId, {
        sandboxId: acquired.resumeToken,
      });
    }

    const buildStopwatch = startStopwatch();
    const skills = await loadSkillsFromWorkspace(acquired.workspace, log);
    // 顺手刷新 [skill 清单](../../../../docs/terms.md)缓存——用户这一路让 agent 往
    // `.agents/skills/` 装的新 skill 就是靠这里进菜单的，也是「清单最多滞后一轮」的出处。
    // 清单没变时不发 UPDATE（绝大多数轮次都是这样）。
    await syncAvailableSkills(
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

    const approvalMode = resolveApprovalMode(env);
    const userId = input.userId ?? row.userId;
    // [审批分类器](../../../../docs/terms.md)：产品决策，归 chat 层。
    // [会话级授权](../../../../docs/terms.md)先行——这次具体调用（tool + 入参指纹）若已被
    // **本轮发起者**在本会话「会话内都允许」过，直接放行；未命中才回落到危险命令分类。
    const onApproval: ApprovalPolicy = async (approvalInput, ctx) => {
      const granted = await hasConversationGrant(
        deps.db,
        conversationId,
        userId,
        ctx.toolName,
        approvalInput,
      );
      return granted ? 'allow' : (
          classifyApproval(approvalMode, ctx.toolName, approvalInput)
        );
    };

    const tools: Record<string, Tool> = {};
    const webSearchTool = deps.webSearchTool ?? createWebSearchToolFromEnv(env);
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
      instructions: buildInstructions(
        repoRef === undefined || row.branchName === null ?
          { kind: 'local', hasWebSearch: tools['web-search'] !== undefined }
        : {
            kind: 'repo',
            repoOwner: repoRef.owner,
            repoName: repoRef.repo,
            defaultBranch: acquired.defaultBranch,
            branchName: row.branchName,
            hasWebSearch: tools['web-search'] !== undefined,
          },
      ),
      onApproval,
      modelText,
      ...(Object.keys(tools).length > 0 ? { tools } : {}),
      ...(deps.telemetry !== undefined ? { telemetry: deps.telemetry } : {}),
    };
    return preparation;
  };

  return { prepareTurn, hooks };
}

/**
 * 把几组挂钩合成一组：同一个时机按传入顺序逐个调。两个异步时机（`onToolTailFinished`、`onHandOff`）
 * 依次等完——框架等的就是它们。
 *
 * `satisfies Required<RuntimeHooks>`：框架加了新时机而这里没跟上，编译就过不去，不会悄悄丢掉。
 */
export function mergeHooks(...groups: RuntimeHooks[]): RuntimeHooks {
  return {
    onTurnStart: (event) => {
      for (const group of groups) {
        group.onTurnStart?.(event);
      }
    },
    onTurnSettled: (event) => {
      for (const group of groups) {
        group.onTurnSettled?.(event);
      }
    },
    onFirstChunk: (event) => {
      for (const group of groups) {
        group.onFirstChunk?.(event);
      }
    },
    onFirstOutput: (event) => {
      for (const group of groups) {
        group.onFirstOutput?.(event);
      }
    },
    onApprovalPending: (event) => {
      for (const group of groups) {
        group.onApprovalPending?.(event);
      }
    },
    onQuestionPending: (event) => {
      for (const group of groups) {
        group.onQuestionPending?.(event);
      }
    },
    onToolTailFinished: async (event) => {
      for (const group of groups) {
        await group.onToolTailFinished?.(event);
      }
    },
    onHandOff: async (event) => {
      for (const group of groups) {
        await group.onHandOff?.(event);
      }
    },
  } satisfies Required<RuntimeHooks>;
}
