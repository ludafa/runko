/**
 * L2 运行层的两个值类型：`Usage`（用量聚合）与 `RunkoError`（轮失败的载荷）。
 *
 * 它们被 `TurnResult`、`RunkoMessageMetadata` 与 `RunkoSessionError`（`session.ts`）引用。
 */

/**
 * 一次会话 / 一轮的用量聚合，**刻意比 AI SDK 的 `LanguageModelUsage` 窄**：这是给宿主看的
 * 展示值，不需要 cache / reasoning token 的明细（那些留在 L0 模型层内部核算，最后汇总进
 * 这里）。
 *
 * provider 没汇报的维度用 `undefined` 承接，**不用 `0` 掩盖「未知」**——两者对宿主是不同的
 * 意思。
 */
export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /**
   * 命中提示词缓存、被读回来的那部分输入 token，按本轮各步累加。来自 provider 的
   * `usage.inputTokenDetails.cacheReadTokens`（比如 DeepSeek 的自动前缀缓存）。
   *
   * provider 不报缓存时是 `undefined`；**缓存未命中是 `0`**——同样是「没有」与「不知道」
   * 的区别。
   */
  cachedInputTokens?: number;
}

/**
 * 轮失败的 error 载荷（`RunkoMessageMetadata.error` 与 `RunkoSessionError`）。
 *
 * `internal_error`（系统异常）core 自己不产出：留给编排层报 core 之外的故障，比如一轮的结果没能写进账本
 * （docs/logic/orchestration/tech/single-ledger.md §6.1）。它的 `message` 是一句不含细节的通用话，细节只进日志。
 */
export interface RunkoError {
  code: "max_turns" | "context_overflow" | "provider_error" | "aborted" | "internal_error";
  message: string;
}
