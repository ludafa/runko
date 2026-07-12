/**
 * L2 运行层：`ToolRuntime` 的单次调用执行体 `executeToolCall`（tech-spec
 * §4.1 ToolContext 组装 / §4.5 审批链集成点 / §4.2 file_change/plan_update
 * 派生数据接缝）。只处理"一次工具调用"，不含 loop/session（P4-2）：不发
 * `SessionEvent`、不维护跨调用的 readState（那是文件工具 + session 的职责，
 * 见 `@nimbo/virtual-fs` 的 `createFileTools`），不做 abort 特判（execute()
 * 因 abort 抛出时自然落入 "failed" 分支，与其他运行时错误同一条路径，不需要
 * 单独语义）。
 *
 * 流程（工单原文）：`tool.inputSchema.safeParse` 校验模型产生的（可能畸形的）
 * JSON 输入 → 失败即 "failed" 并回填指导性错误，不 throw → 审批链
 * （`evaluateApproval`，见 approval.ts）→ deny 即 "denied" 并回填拒绝理由 →
 * allow 时 `updatedInput`（若有）替换输入 → 组装 `ToolContext` → 调
 * `tool.execute()` → throw 即 "failed" 并回填错误消息，不崩 loop →
 * `outputSchema`（若声明）校验返回值，不匹配同样是 "failed" → 成功即
 * "completed"。`ToolReturn` 的模型可读序列化（string 直传/对象
 * `JSON.stringify`）不在这里做——那是"回填层"（P4-2 的 loop，把 `ToolReturn`
 * 塞进 `role: "tool"` 的 `ModelMessage`）的职责，这里的 `output` 字段对
 * "completed" 状态原样是 `tool.execute()` 的返回值。
 *
 * ---- 派生数据接缝（工单要求写清形状与理由） ----
 *
 * `file_change`/`plan_update` 派生数据的"生产者"是具体工具的 `execute()`
 * 实现（如 update_plan、未来的文件工具），"消费者"是 P4-2 的 loop（用它拼
 * `SessionItem`）。两者中间需要一个通道——`Tool.execute()` 的返回值类型被
 * spec 钉死为 `ToolReturn`（模型可读的单一值），没有第二个返回通道；
 * `ToolContext` 的字段也被 spec §4.1 钉死为 fs/abortSignal/callId/session/
 * getSkill/update 六个，本工单不允许改 `types.ts`，因此不能在 `ToolContext`
 * 上加一个新字段当通道。
 *
 * 采用的方案与 `@nimbo/virtual-fs` 的 `createFileTools(opts).onFileChange`
 * 是同一个接缝家族（P2-2 已确立的先例，见该包 `tools/shared.ts` 顶部注释）：
 * 派生数据回调在**工具构造期**（`createUpdatePlanTool(opts)` 之类的工厂
 * 调用时）注入给工具，工具的 `execute()` 内部直接调用它上报——不经过
 * `ToolContext`，因此不需要改 spec 钉死的接口形状。这里的 `runtime.ts` 提供
 * `DerivedDataCollector`：一个在每次 `executeToolCall` 前后"清空 → 收集 →
 * 取走"的收集器，调用方在构造工具集时把它的 `recordFileChange`/
 * `recordPlanUpdate` 方法接成对应工具的回调选项，再把同一个收集器实例传给
 * 每次 `executeToolCall`。runtime 因此完全不需要认识"这次调用的是哪个具体
 * 工具"——它只是在 `execute()` 前后各读一次收集器的状态，把这次调用期间新
 * 增的记录归到这次调用的结果上。这个设计假设同一个收集器不会被并发的
 * `executeToolCall` 调用共享（P4-2 的 loop 目前是逐个工具调用顺序执行，
 * 该假设成立；未来若引入并发工具调用，需要给收集器加调用范围隔离，不在本
 * 工单范围）。
 */
import type { ApprovalContext, ApprovalPolicy, JsonValue, NimboFS, SkillHandle, Tool, ToolContext, ToolReturn } from "./types.js";
import { evaluateApproval, type OnceApprovalMemory } from "./approval.js";

// ---- 派生数据（tech-spec §4.2 SessionItem 的 file_change.changes / plan_update.items 字段对齐） ----

export interface ToolCallFileChange {
  path: string;
  kind: "add" | "update" | "delete";
}

export interface ToolCallPlanItem {
  text: string;
  completed: boolean;
}

export interface ToolCallDerivedData {
  /** 这次调用期间上报的文件变更，可以是多条（如 move_file = delete + add）；无变更时为空数组。 */
  changes: ToolCallFileChange[];
  /** 这次调用期间是否发生了一次整表替换的计划更新；未发生则不出现该字段。 */
  items?: ToolCallPlanItem[];
}

/** 派生数据的收集器：设计理由见本文件头"派生数据接缝"一节。 */
export interface DerivedDataCollector {
  recordFileChange(change: ToolCallFileChange): void;
  recordPlanUpdate(items: ToolCallPlanItem[]): void;
  /** 取走自上次 `drain()` 以来记录的全部数据，并把收集器清空。 */
  drain(): ToolCallDerivedData;
}

export function createDerivedDataCollector(): DerivedDataCollector {
  let changes: ToolCallFileChange[] = [];
  let items: ToolCallPlanItem[] | undefined;

  return {
    recordFileChange(change) {
      changes.push(change);
    },
    recordPlanUpdate(next) {
      items = next;
    },
    drain() {
      const snapshot: ToolCallDerivedData = items === undefined ? { changes } : { changes, items };
      changes = [];
      items = undefined;
      return snapshot;
    },
  };
}

// ---- executeToolCall ----

export type ToolCallStatus = "completed" | "failed" | "denied";

export interface ToolCallResult {
  status: ToolCallStatus;
  /**
   * "completed"：`tool.execute()`（或其 `outputSchema.safeParse` 校验后）的
   * 原始返回值，尚未字符串化。"failed"/"denied"：给模型看的指导性错误/
   * 拒绝理由文本（`string`）。序列化到 `role: "tool"` 消息是回填层的职责。
   */
  output: ToolReturn;
  derived: ToolCallDerivedData;
}

export interface ExecuteToolCallOptions {
  tool: Tool;
  toolName: string;
  callId: string;
  /** 模型产生的原始工具调用参数——可能不满足 `tool.inputSchema`（畸形/字段缺失）。 */
  input: JsonValue;
  session: { id: string; turn: number };
  fs: NimboFS;
  abortSignal: AbortSignal;
  /** session 级审批兜底（`SessionOptions.onApproval`，§4.2）。 */
  onApproval?: ApprovalPolicy;
  onceMemory?: OnceApprovalMemory;
  /** 接到 `ctx.update(partial)`；未提供时 `ctx.update` 是无操作。 */
  onProgress?: (partial: string) => void;
  /** 本次调用期间要收集的派生数据（形状与理由见本文件头）。 */
  derivedData?: DerivedDataCollector;
  /**
   * `ctx.getSkill` 的真实现（P5，`@nimbo/core/skills/registry.js` 的
   * `createGetSkill`）：`session.ts` 经 `loop.ts` 把它一路传下来。未提供时退回
   * `createPlaceholderGetSkill()`（P4-1 遗留占位，见下）——这保持了
   * `executeToolCall` 作为独立原语（不经 session/loop 直接调用，如本文件的
   * 单测）在未接线 skills 时行为不变，不需要任何调用方跟着改。
   */
  getSkill?: (name: string) => SkillHandle;
}

const DEFAULT_DENY_MESSAGE = "Tool call denied.";

function emptyDerived(): ToolCallDerivedData {
  return { changes: [] };
}

/**
 * `catch` 子句里从 `unknown` 安全窄化出可读消息——受控例外（同款用法见
 * `@nimbo/virtual-fs` 的 `describeError`），只用于这一处收窄，不向外扩散
 * `unknown`：`tool.execute()` 按 `Tool` 接口的类型签名只会抛 `unknown`
 * （JS/TS 里 `throw` 的静态类型恒为 `unknown`），这是把它安全转成消息文本的
 * TypeScript 官方推荐写法本身要求的输入类型，不是绕开类型系统的手段。
 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `ctx.getSkill` 的占位实现：只在 `executeToolCall` 未接到真实
 * `getSkill`（`ExecuteToolCallOptions.getSkill`）时使用——`session.ts` 走的
 * 正常路径（经 `loop.ts`）总会传入 P5 的真实现（`createGetSkill`），这个占位
 * 只在绕过 session 直接调用 `executeToolCall` 时（如本文件/`loop.ts` 的既有
 * 单测）保留 P4-1 的原有行为，不需要那些测试跟着 P5 改。
 */
function createPlaceholderGetSkill(): (name: string) => SkillHandle {
  return (name) => ({
    file: (relPath) => ({
      text: async () => {
        throw new Error(
          `getSkill("${name}") has no backing implementation in this call — no P5 agent.skills-backed getSkill ` +
            `was wired into this executeToolCall(...) invocation (requested file: "${relPath}"). This placeholder ` +
            "is only reached when executeToolCall() is called directly without going through createSession(); " +
            "sessions wire up the real P5 getSkill automatically once agent.skills is configured.",
        );
      },
    }),
  });
}

/** 单次工具调用的执行体：输入校验 → 审批链 → 执行 → 输出校验，逐段说明见本文件头。 */
export async function executeToolCall(opts: ExecuteToolCallOptions): Promise<ToolCallResult> {
  const parsedInput = opts.tool.inputSchema.safeParse(opts.input);
  if (!parsedInput.success) {
    return {
      status: "failed",
      output:
        `Invalid input for tool "${opts.toolName}": ${parsedInput.error.message} ` +
        "Check the tool's input schema and retry the call with corrected arguments.",
      derived: emptyDerived(),
    };
  }

  const approvalCtx: ApprovalContext = { toolName: opts.toolName, callId: opts.callId, session: opts.session };
  const decision = await evaluateApproval({
    toolName: opts.toolName,
    input: parsedInput.data,
    ctx: approvalCtx,
    toolApproval: opts.tool.approval,
    onApproval: opts.onApproval,
    onceMemory: opts.onceMemory,
  });

  if (decision.behavior === "deny") {
    return {
      status: "denied",
      output: decision.message ?? DEFAULT_DENY_MESSAGE,
      derived: emptyDerived(),
    };
  }

  const effectiveInput = decision.updatedInput ?? parsedInput.data;

  const ctx: ToolContext = {
    fs: opts.fs,
    abortSignal: opts.abortSignal,
    callId: opts.callId,
    session: opts.session,
    getSkill: opts.getSkill ?? createPlaceholderGetSkill(),
    update: (partial) => opts.onProgress?.(partial),
  };

  // 防御性清空：确保这次调用只归集这次调用期间产生的记录，不带上任何此前
  // 调用遗留（理论上不该有，因为每次调用末尾都会 drain；这里是双重保险）。
  opts.derivedData?.drain();

  let rawOutput: ToolReturn;
  try {
    rawOutput = await opts.tool.execute(effectiveInput, ctx);
  } catch (error) {
    return {
      status: "failed",
      output: `Tool "${opts.toolName}" threw during execution: ${describeError(error)}.`,
      derived: opts.derivedData?.drain() ?? emptyDerived(),
    };
  }

  const derived = opts.derivedData?.drain() ?? emptyDerived();

  if (opts.tool.outputSchema !== undefined) {
    const parsedOutput = opts.tool.outputSchema.safeParse(rawOutput);
    if (!parsedOutput.success) {
      return {
        status: "failed",
        output:
          `Tool "${opts.toolName}" returned a value that does not match its declared outputSchema: ` +
          `${parsedOutput.error.message}`,
        derived,
      };
    }
    return { status: "completed", output: parsedOutput.data, derived };
  }

  return { status: "completed", output: rawOutput, derived };
}
