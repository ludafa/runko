/**
 * chat 应用 Node 版的 `@runko/agent` 装配。
 *
 * [起轮装配](../../../../docs/terms.md)与挂钩是两个服务端共用的（`@runko-chat/shared/agent/turn-assembly`）；
 * 这里只放 Node 版自己的宿主能力：租约版[归属仲裁机制](../../../../docs/terms.md)（共享库）、
 * [交权](../../../../docs/terms.md)、跨副本的[流分发](../../../../docs/terms.md)、可调的[内存窗口](../../../../docs/terms.md)。
 *
 * 轮的生命周期（占位、驱动、收尾、[排队](../../../../docs/terms.md)与[出队](../../../../docs/terms.md)、
 * [停止](../../../../docs/terms.md)、[崩溃恢复](../../../../docs/terms.md)）全在框架里，本文件一行都不写。
 */
import type {
  AgentRuntime,
  NodeRegistry,
  SessionFactory,
  StreamFanout,
} from '@runko/agent';
import { createAgentRuntime } from '@runko/agent';
import type { SessionTelemetry, Tool } from '@runko/core';
import { defineAgent } from '@runko/sdk';
import type { GithubApp } from '@runko-chat/shared/agent/github-app';
import type { SandboxManager } from '@runko-chat/shared/agent/sandbox-manager';
import type { Db } from '@runko-chat/shared/agent/store';
import { createChatTurnAssembly } from '@runko-chat/shared/agent/turn-assembly';
import type { Logger } from '@runko-chat/shared/logger';
import { logger as defaultLogger } from '@runko-chat/shared/logger';
import type { LanguageModel } from 'ai';

import type { ChatNotifier } from '../push/notifier.js';
import type { TelemetryStore } from '../telemetry.js';
import { defaultGithubApp } from './github.js';
import {
  createChatArbitration,
  createChatPersistence,
  readMs,
} from './persistence.js';

/** 见下方 `agent:` 处的注释——永远会被 `prepareTurn` 覆盖，不会被解析。 */
const PLACEHOLDER_MODEL = 'runko/overridden-per-turn';

export interface ChatRuntimeDeps {
  db: Db;
  /**
   * [流分发](../../../../docs/terms.md)：多副本时传 Redis 那份（见 `agent/stream.ts`），
   * 不传就是框架内置的进程内 fan-out。
   */
  stream?: StreamFanout;
  sandboxManager: SandboxManager;
  resolveModel: () => LanguageModel;
  /** 同 `routes/chat.ts` 的 `ChatRouteDeps.githubApp`：起轮时取安装令牌用。缺省用生产单例。 */
  githubApp?: GithubApp;
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
   * [交权](../../../../docs/terms.md)：本节点地址、[发布序号](../../../../docs/terms.md)、[节点登记表](../../../../docs/terms.md)与出站「请接手」。
   * 不传 = 单进程跑法：下线时挑不到接手节点，对话打上待接手标记，下一个进程起来时接走。
   */
  handover?: {
    node: string;
    releaseSeq: number;
    nodes?: NodeRegistry;
    requestTakeover?: (
      node: string,
      conversationIds: string[],
    ) => Promise<boolean>;
  };
  /**
   * 覆盖「怎么造出这一轮的 `Session`」。缺省即框架的默认工厂（core 的 `createSession`
   * + 文件工具八件套）。**集成测试用它塞一对假的 `stream()`/`toJSON()`**，于是整条轮编排
   * 链路可以在零模型、零沙盒下跑完。
   */
  sessionFactory?: SessionFactory;
}

/** `setTimeout` 能等的上限——框架对更长的窗口直接报错，而这个函数在模块顶层被求值，报错会让进程起不来。 */
const MAX_MEMORY_WINDOW_MS = 2_147_483_647;

/**
 * [内存窗口](../../../../docs/terms.md)：等人先在内存里等多久（毫秒），等不到这一轮就
 * [挂起](../../../../docs/terms.md)。读 `CHAT_SUSPEND_MEMORY_WINDOW`；不配或写错（含超过定时器上限）
 * 就返回 `undefined`，交给框架缺省（5 分钟，与沙盒的审批保活预算对齐）。`0` = 一等人就挂起。
 */
export function resolveMemoryWindowMs(
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const raw = env.CHAT_SUSPEND_MEMORY_WINDOW?.trim();
  if (raw === undefined || raw.length === 0) {
    return undefined;
  }
  const parsed = Number(raw);
  return (
      Number.isFinite(parsed) && parsed >= 0 && parsed <= MAX_MEMORY_WINDOW_MS
    ) ?
      parsed
    : undefined;
}

/**
 * chat 应用的 runtime。**进程内单例**（见 `routes/chat.ts` 底部），测试可以自己造一个隔离的。
 */
export function createChatRuntime(deps: ChatRuntimeDeps): AgentRuntime {
  const log = deps.logger ?? defaultLogger;
  const { prepareTurn, hooks } = createChatTurnAssembly({
    db: deps.db,
    sandboxManager: deps.sandboxManager,
    resolveModel: deps.resolveModel,
    githubApp: deps.githubApp ?? defaultGithubApp,
    logger: log,
    ...(deps.telemetry !== undefined ? { telemetry: deps.telemetry } : {}),
    ...(deps.telemetryStore !== undefined ?
      { telemetryStore: deps.telemetryStore }
    : {}),
    ...(deps.notifier !== undefined ? { notifier: deps.notifier } : {}),
    ...(deps.webSearchTool !== undefined ?
      { webSearchTool: deps.webSearchTool }
    : {}),
  });

  const memoryWindowMs = resolveMemoryWindowMs();
  const toolTimeoutMs = readMs('RUNKO_TOOL_TIMEOUT_MS', process.env);
  return createAgentRuntime({
    // instructions/skills/tools/model 全是**逐轮**决定的（仓库、分支、沙盒里现有的
    // skill、按会话选的模型），所以这里只放一个占位——每一轮的 `prepareTurn` 都会把
    // 它整个覆盖掉，这个字符串永远不会被真正解析成模型。
    //
    // **刻意不在这里调 `deps.resolveModel()`**：本函数在模块顶层被求值（`routes/chat.ts`
    // 底部的单例），那时读环境变量会让「没配 DeepSeek 凭据」从一次请求失败升级成
    // **整个进程 import 就崩**——连不碰 agent 的端点（列会话、推送订阅）都起不来。
    agent: defineAgent({ model: PLACEHOLDER_MODEL }),
    persistence: createChatPersistence(deps.db),
    arbitration: createChatArbitration(
      deps.db,
      deps.handover !== undefined ? { holder: deps.handover.node } : {},
    ),
    ...(deps.handover !== undefined ? { handover: deps.handover } : {}),
    ...(toolTimeoutMs !== undefined ? { toolTimeout: toolTimeoutMs } : {}),
    ...(deps.stream !== undefined ? { stream: deps.stream } : {}),
    logger: log,
    ...(memoryWindowMs !== undefined ?
      { suspend: { memoryWindow: memoryWindowMs } }
    : {}),
    hooks,
    ...(deps.sessionFactory !== undefined ?
      { sessionFactory: deps.sessionFactory }
    : {}),
    prepareTurn,
  });
}
