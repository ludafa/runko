/**
 * L1 定义层：`defineAgent` + `BuiltinToolName` + `READ_ONLY_TOOLS`
 * （docs/tech/core-sdk.md §4.1；`BuiltinToolName` 联合与 `READ_ONLY_TOOLS` 见
 * docs/tech/builtin-tools.md §3）。
 */
import type { LanguageModel } from "ai";
import type { Tool } from "./types.js";
import type { Skill } from "./skill.js";

/**
 * 内置工具名联合（docs/tech/builtin-tools.md §3）：九个默认全开、可经
 * `builtinTools` 裁剪的文件/计划工具。`load-skill` 由 agent 是否配置
 * `skills` 隐式控制、`bash` 由 session 是否注入 `NimboExec` 隐式控制——
 * 二者是条件内置，不在这个可裁剪列表里（§3 原文括注）。
 */
export type BuiltinToolName =
  | "read-file"
  | "write-file"
  | "edit-file"
  | "delete-file"
  | "move-file"
  | "list-dir"
  | "glob"
  | "grep"
  | "update-plan";

/** 只读审查场景一行开箱的预设组合（docs/tech/builtin-tools.md §3），纯类型层面的常量、非新机制。 */
export const READ_ONLY_TOOLS = [
  "read-file",
  "list-dir",
  "glob",
  "grep",
] as const satisfies readonly BuiltinToolName[];

/** agent 定义：纯声明，无运行状态（docs/tech/core-sdk.md §4.1）。 */
export interface AgentDefinition {
  /** AI SDK 模型实例或 "provider/model" gateway 字符串。 */
  model: LanguageModel;
  /** 系统提示正文（L3 会从 instructions.md 填入）。 */
  instructions?: string;
  /** key 即工具名（对应 eve 的"文件名即工具名"）。 */
  tools?: Record<string, Tool>;
  /** 默认全部文件工具；false 关闭。 */
  builtinTools?: BuiltinToolName[] | false;
  skills?: Skill[];
  /** 默认 40（默认值在 L2 runtime 生效，此处仅为可选字段）。 */
  maxTurnsPerRun?: number;
  maxOutputTokens?: number;
  /**
   * v1 显式上下文上限（§4.8"上下文管理"，P4-2 施工回填——spec 原文只描述行为
   * 未点名承载字段）：估算 token 数（字符数/4 起步，每步 usage 回填校准，见
   * `loop.ts`）超过此值即 `turn.failed`/`context_overflow`。未设置则不做检查
   * （opt-in，与 `maxTurnsPerRun` 不同，这里没有隐式默认值）。
   */
  maxContextTokens?: number;
}

/** 恒等函数：价值在类型推导与将来扩展位，不做任何运行时校验/拷贝。 */
export function defineAgent(def: AgentDefinition): AgentDefinition {
  return def;
}
