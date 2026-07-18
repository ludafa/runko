/**
 * L2 运行层的 usage/error 类型（docs/tech/single-ledger.md §5 单-2：
 * `SessionEvent`/`SessionItem` 联合退役——UIMessage 单账本下，session 的过程
 * 数据改由 `NimboChunk`（ai 的 UIMessageChunk 词汇表，`state.ts`）+
 * `NimboUIMessage` 的部件/metadata 表达，见 `loop.ts`/`session.ts`。`Usage`/
 * `NimboError` 两个类型不属于那个退役的事件联合本身——`Usage` 是
 * `TurnResult`/`NimboMessageMetadata` 引用的聚合值类型，`NimboError` 是
 * `NimboMessageMetadata.error` 与 `NimboSessionError`（`session.ts`）的载荷
 * 类型——两者继续导出。
 *
 * 已消失的概念（迁移前 SessionEvent/SessionItem 的完整清单，供 P13-5-3/
 * tester 对照）：`SessionEvent`（session.started/turn.started/
 * item.started|updated|completed/turn.completed/turn.failed）与
 * `SessionItem`（agent_message/reasoning/user_message/tool_call/
 * file_change/plan_update/error）、`ToolOutput`（= `ToolReturn` 的别名，
 * 只被 `SessionItem.tool_call.output` 引用，随其退役）——语义映射表见
 * `session.ts`/`loop.ts` 文件头与本次工单回报。
 */
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

/** 轮失败的 error 载荷（`NimboMessageMetadata.error`/`NimboSessionError`）；code 联合照 §4.2/§4.8 逐字。 */
export interface NimboError {
  code: "max_turns" | "context_overflow" | "provider_error" | "aborted";
  message: string;
}
