/**
 * 「怎么造出这一轮的 `Session`」这个接缝。
 *
 * 默认实现就是 `@nimbo/core` 的 `createSession` 外加**文件工具八件套的默认装配**
 * ——与 `@nimbo/sdk` 的门面版同款（同一段 `createFileTools({ readState, onFileChange })`
 * 预构造 + 注入）。为什么在这里再写一遍而不是 `import { createSession } from "@nimbo/sdk"`：
 * `@nimbo/sdk` 是**门面包**（它 re-export core + virtual-fs + mini-bash），让逻辑层的
 * 轮编排反过来依赖门面，会把依赖图从「一棵指向 core 的树」变成「有一条回边」。
 * 这里付出的代价是三十行装配代码要跟 sdk 保持一致——改动 sdk 的默认装配时记得同步。
 *
 * 注入自己的 `sessionFactory` 有两个真实用途：**测试**（一对假的 `stream()`/`toJSON()`
 * 就能驱动一整轮，不牵进真模型/真沙盒），以及宿主要完全接管装配时。
 */
import type {
  AgentDefinition,
  BuiltinToolName,
  DerivedDataCollector,
  NimboChunk,
  SessionOptions,
  SessionReadState,
  SessionState,
  Tool,
  TurnResult,
} from "@nimbo/core";
import { createDerivedDataCollector, createSession as createCoreSession, createSessionReadState } from "@nimbo/core";
import type { FileChange, FileToolName } from "@nimbo/virtual-fs";
import { createFileTools } from "@nimbo/virtual-fs";

/**
 * 轮编排真正用到的那一小块 `Session` 表面——**刻意比真类型窄**，于是测试可以塞一个
 * 只实现了 `stream`/`toJSON` 的假货进来（同 `sandbox-adapter` 那条「按结构声明接口，
 * 不认具体类」的纪律）。
 */
export interface DrivenSession {
  stream(input: string, opts?: { signal?: AbortSignal }): AsyncGenerator<NimboChunk, TurnResult>;
  toJSON(): SessionState;
  steer?(input: string): boolean;
}

export type SessionFactory = (
  agent: AgentDefinition,
  options: SessionOptions,
) => DrivenSession | Promise<DrivenSession>;

/** 八件套的全部工具名（与 `@nimbo/sdk` 的 `ALL_FILE_TOOL_NAMES` 同源）。 */
const ALL_FILE_TOOL_NAMES = [
  "read-file",
  "write-file",
  "edit-file",
  "delete-file",
  "move-file",
  "list-dir",
  "glob",
  "grep",
] as const satisfies readonly FileToolName[];

/** `agent.builtinTools` 对八件套的过滤：`false` 全关；未配置默认全开；数组按白名单交集。 */
function resolveEnabledFileToolNames(builtinTools: BuiltinToolName[] | false | undefined): readonly FileToolName[] {
  if (builtinTools === false) {return [];}
  if (builtinTools === undefined) {return ALL_FILE_TOOL_NAMES;}
  const requested = new Set<BuiltinToolName>(builtinTools);
  return ALL_FILE_TOOL_NAMES.filter((name) => requested.has(name));
}

function buildDefaultFileTools(
  agent: AgentDefinition,
  readState: SessionReadState,
  derivedData: DerivedDataCollector,
): Record<string, Tool> {
  const enabledNames = resolveEnabledFileToolNames(agent.builtinTools);
  if (enabledNames.length === 0) {return {};}
  const allFileTools = createFileTools({
    readState,
    onFileChange: (changes: FileChange[]) => {
      for (const change of changes) {derivedData.recordFileChange(change);}
    },
  });
  const enabled: Record<string, Tool> = {};
  for (const name of enabledNames) {enabled[name] = allFileTools[name];}
  return enabled;
}

/**
 * 默认工厂。`readState`/`derivedData` 必须**先于** `createSession` 构造出来再注入
 * ——文件工具在 session 外部拼装，拿不到 session 内部那两个 store，这是一个先有鸡
 * 还是先有蛋的顺序问题，core 为此专门留了这两个注入位。
 */
export const defaultSessionFactory: SessionFactory = (agent, options) => {
  const readState = options.readState ?? createSessionReadState();
  const derivedData = options.derivedData ?? createDerivedDataCollector();
  const tools: Record<string, Tool> = {
    ...buildDefaultFileTools(agent, readState, derivedData),
    ...(agent.tools ?? {}),
  };
  return createCoreSession({ ...agent, tools }, { ...options, readState, derivedData });
};
