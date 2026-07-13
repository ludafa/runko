/**
 * L2 运行层的事件模型（tech-spec §4.2）：session/turn 生命周期命名靠 eve，
 * item 粒度沿 codex-sdk。纯类型，不含 loop/session 运行时实现（P4）。
 */
import type { JsonValue, ToolReturn } from "./types.js";

/**
 * spec 未单列 Usage 的字段，只在 TurnResult / turn.completed 里引用了
 * 类型名。这里按 AI SDK LanguageModelUsage 的顶层三个聚合维度收窄为
 * nimbo 自己的精简版——nimbo 的 Usage 是会话/轮次级别展示给宿主的聚合值，
 * 不需要 AI SDK 内部的 cache/reasoning token 明细（那些留在 L0 模型层
 * 内部核算，回填进这里的三个和）。provider 未汇报的维度用 undefined
 * 承接，不用 0 掩盖"未知"。
 */
export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /**
   * Cached (prompt-cache-hit) input tokens read, summed across the turn's
   * steps — from the provider's `usage.inputTokenDetails.cacheReadTokens`
   * (e.g. DeepSeek's automatic prefix cache). `undefined` when the provider
   * doesn't report caching; `0` on a cache miss.
   */
  cachedInputTokens?: number;
}

/** `turn.failed` 的 error 载荷；code 联合照 §4.2/§4.8 逐字。 */
export interface NimboError {
  code: "max_turns" | "context_overflow" | "provider_error" | "aborted";
  message: string;
}

/**
 * tool_call item 里回填给模型/暴露给宿主的工具结果。spec 未单独定义
 * ToolOutput 的字段，语义上就是 L1 `defineTool` 的 `execute()` 返回值
 * （ToolReturn）流转到事件里的那份数据，因此直接复用同一类型。
 */
export type ToolOutput = ToolReturn;

// ---- SessionEvent（§4.2） ----

export type SessionEvent =
  | { type: "session.started"; sessionId: string }
  | { type: "turn.started"; turn: number }
  | { type: "item.started" | "item.updated" | "item.completed"; item: SessionItem }
  | { type: "turn.completed"; usage: Usage }
  | { type: "turn.failed"; error: NimboError };

// ---- SessionItem（§4.2） ----

export type SessionItem =
  | { id: string; type: "agent_message"; text: string }
  | { id: string; type: "reasoning"; text: string }
  /** turn 进行中经 `Session.steer()` 注入的用户消息（STEER-1）——发起 turn 的输入本身不产生 item。 */
  | { id: string; type: "user_message"; text: string }
  | {
      id: string;
      type: "tool_call";
      toolName: string;
      input: JsonValue;
      output?: ToolOutput;
      status: "in_progress" | "completed" | "failed" | "denied";
    }
  | { id: string; type: "file_change"; changes: { path: string; kind: "add" | "update" | "delete" }[] }
  | { id: string; type: "plan_update"; items: { text: string; completed: boolean }[] }
  | { id: string; type: "error"; message: string };
