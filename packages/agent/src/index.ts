/**
 * `@nimbo/agent`——[轮编排](../../docs/terms.md)运行时。
 *
 * `@nimbo/core` 给的是「跑一轮」，本包给的是「**一轮接一轮地跑下去，而且换个部署形态
 * 不用改业务代码**」。四样宿主能力（沙盒 · 持久化 · [流分发](../../docs/terms.md) ·
 * [归属仲裁机制](../../docs/terms.md)）的接口在这里定，内置的平凡实现也在这里——所以
 * 零配置就能跑。
 *
 * 文档：[功能](../../docs/logic/orchestration/features/agent-runtime.md) ·
 * [技术方案](../../docs/logic/orchestration/tech/agent-runtime.md) ·
 * [架构总纲](../../docs/architecture/tech/agent-kernel.md)。
 */
export const NIMBO_AGENT_VERSION = "0.0.0" as const;

// 门面
export * from "./runtime.js";

// 公共词汇
export * from "./types.js";

// 四样宿主能力的接口
export * from "./persistence.js";
export * from "./stream.js";
export * from "./arbitration.js";
export * from "./prepare.js";

// 内置的平凡实现
export * from "./builtin/memory-persistence.js";
export * from "./builtin/in-process-stream.js";
export * from "./builtin/in-process-arbitration.js";

// 宿主可能要接的几个小东西
export * from "./logger.js";
export type { RuntimeHooks, QueueConfig, SteerPolicy } from "./runtime/context.js";
export type { AskUserOutcome } from "./runtime/registry.js";
export type { ApprovalPendingEvent, QuestionPendingEvent, SubmittedDecision } from "./runtime/human.js";
export type { DrivenSession, SessionFactory } from "./runtime/session-factory.js";
/** 默认工厂——宿主要在它之上再包一层（而不是整个换掉）时用得上。 */
export { defaultSessionFactory } from "./runtime/session-factory.js";
export { ASK_USER_TIMEOUT_MESSAGE } from "./runtime/ask-user.js";
export {
  ABORT_DENY_MESSAGE,
  ABORT_REASON_SHUTDOWN,
  ABORT_REASON_USER,
  OWNERSHIP_LOST_MESSAGE,
} from "./runtime/reasons.js";
