/**
 * L2 运行层：`ToolRuntime` 的单次调用执行体（docs/tech/core-sdk.md §4.1 ToolContext 组装 /
 * §4.5 审批链集成点 / §4.2 file_change/plan_update 派生数据接缝；
 * docs/tech/single-ledger.md §6 P13-5-2c 三值重构）。只处理"一次工具
 * 调用"，不含 loop/session（P4-2）：不发 `SessionEvent`、不维护跨调用的
 * readState（那是文件工具 + session 的职责，见 `@nimbo/virtual-fs` 的
 * `createFileTools`），不做 abort 特判（execute() 因 abort 抛出时自然落入
 * "failed" 分支，与其他运行时错误同一条路径，不需要单独语义）。
 *
 * ---- 拆分为两步（P13-5-2c 核心变化，docs/tech/single-ledger.md §6.4） ----
 *
 * 旧实现把"输入校验 → 审批链 → 执行 → 输出校验"揉进一个原子 `executeToolCall`
 * 调用，`review`（旧 "always"/"once"）结果因此只能在**审批已经做完**之后被
 * 编码成 chunk——挂起等人审期间界面看不到待审批信号（P13-5-2c 工单原文，
 * docs/tech/single-ledger.md §6 引言"事后补记只对模型恢复正确，对直播交互失效"）。三值化之后，
 * `review` 需要 loop 先 `yield tool-approval-request` chunk、再 `await` 人工
 * 裁决——这个"先产出后阻塞"的中间点是一次 `await` 边界，不可能塞进一个返回
 * `Promise` 的普通函数内部让调用方在中途取值，因此本文件把原子调用拆成两个
 * 独立函数，由 `loop.ts`（一个 async generator）在中间插入 yield/await：
 *
 *   1. `resolveToolCallApproval`：`tool.inputSchema.safeParse` 校验模型产生
 *      的（可能畸形的）JSON 输入 → 失败即 "invalid" 并回填指导性错误 →
 *      审批链（`evaluateApproval`，见 approval.ts）→ `allow`/`deny`/`review`
 *      三值直接映射为返回的 `status`；`deny` 回填拒绝理由，`review` 额外带
 *      `markOnceOnApprove`（是否要在人工 allow 后标记 once 记忆，见
 *      approval.ts 头注释）。这一步不执行工具、不建 `ToolContext`。
 *   2. `executeToolCall`：只做"执行"——组装 `ToolContext` → 调
 *      `tool.execute()` → throw 即 "failed" 并回填错误消息，不崩 loop →
 *      `outputSchema`（若声明）校验返回值，不匹配同样是 "failed" → 成功即
 *      "completed"。输入是调用方（`loop.ts`）已经从第 1 步拿到的、已校验/已
 *      获批的 `JsonValue`——这里不再重复 `safeParse`，也不再触碰审批。
 *
 * `loop.ts` 对每次工具调用先调 1，`allow` 时立即调 2；`review` 时先 yield
 * 审批请求 chunk、`await` 人审通道拿到 `HumanDecision`，`allow` 才调 2、
 * `deny` 直接回填人工给出的理由；`deny`（第 1 步自己的结果）不调 2。
 * `ToolCallStatus`/`ToolCallResult` 因此只剩 "completed"/"failed"——"denied"
 * 整体从这一层移除，denial 的编码（`tool-output-denied` chunk + 拒绝理由回填）
 * 完全是 `loop.ts` 的职责，`executeToolCall` 不再需要认识"拒绝"这个概念。
 * `ToolReturn` 的模型可读序列化（string 直传/对象 `JSON.stringify`）同样不在
 * 这里做——那是"回填层"（`loop.ts`，把 `ToolReturn` 塞进工具部件/`tool-result`）
 * 的职责，这里 "completed" 状态的 `output` 字段原样是 `tool.execute()` 的
 * 返回值。
 *
 * ---- 派生数据接缝（工单要求写清形状与理由） ----
 *
 * `file_change`/`plan_update` 派生数据的"生产者"是具体工具的 `execute()`
 * 实现（如 update-plan、未来的文件工具），"消费者"是 P4-2 的 loop（用它拼
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

// ---- 派生数据（docs/tech/core-sdk.md §4.2 SessionItem 的 file_change.changes / plan_update.items 字段对齐） ----

export interface ToolCallFileChange {
  path: string;
  kind: "add" | "update" | "delete";
}

export interface ToolCallPlanItem {
  text: string;
  completed: boolean;
}

export interface ToolCallDerivedData {
  /** 这次调用期间上报的文件变更，可以是多条（如 move-file = delete + add）；无变更时为空数组。 */
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

// ---- 第 1 步：resolveToolCallApproval（输入校验 + 审批链，不执行工具） ----

/**
 * `resolveToolCallApproval` 的产出：判别联合按 `status` 精确到调用方无需再
 * 猜——`invalid`/`deny` 恒带给模型看的文本，`allow`/`review` 恒带
 * `input`（已经过 `tool.inputSchema.safeParse` 校验/规范化的值，`loop.ts`
 * 后续调 `executeToolCall` 时原样传入，不重复校验），`review` 额外带
 * `markOnceOnApprove`（透传自 `ApprovalResolution`，见 approval.ts）。
 */
export type ToolCallApprovalOutcome =
  | { status: "invalid"; message: string }
  | { status: "allow"; input: JsonValue }
  | { status: "deny"; reason: string }
  | { status: "review"; input: JsonValue; markOnceOnApprove: boolean };

export interface ResolveToolCallApprovalOptions {
  tool: Tool;
  toolName: string;
  callId: string;
  /** 模型产生的原始工具调用参数——可能不满足 `tool.inputSchema`（畸形/字段缺失）。 */
  input: JsonValue;
  session: { id: string; turn: number };
  /** session 级审批分类器（原 `SessionOptions.onApproval`，§4.2）。 */
  onApproval?: ApprovalPolicy;
  onceMemory?: OnceApprovalMemory;
}

/** 单次工具调用的审批解析：输入校验 → 审批链，不执行工具，逐段说明见本文件头"拆分为两步"一节。 */
export async function resolveToolCallApproval(opts: ResolveToolCallApprovalOptions): Promise<ToolCallApprovalOutcome> {
  const parsedInput = opts.tool.inputSchema.safeParse(opts.input);
  if (!parsedInput.success) {
    return {
      status: "invalid",
      message:
        `Invalid input for tool "${opts.toolName}": ${parsedInput.error.message} ` +
        "Check the tool's input schema and retry the call with corrected arguments.",
    };
  }

  const approvalCtx: ApprovalContext = { toolName: opts.toolName, callId: opts.callId, session: opts.session };
  const resolution = await evaluateApproval({
    toolName: opts.toolName,
    input: parsedInput.data,
    ctx: approvalCtx,
    toolApproval: opts.tool.approval,
    onApproval: opts.onApproval,
    onceMemory: opts.onceMemory,
  });

  if (resolution.outcome === "deny") return { status: "deny", reason: resolution.reason };
  if (resolution.outcome === "review") {
    return { status: "review", input: parsedInput.data, markOnceOnApprove: resolution.markOnceOnApprove };
  }
  return { status: "allow", input: parsedInput.data };
}

// ---- 第 2 步：executeToolCall（只执行，输入已校验/已获批） ----

export type ToolCallStatus = "completed" | "failed";

export interface ToolCallResult {
  status: ToolCallStatus;
  /**
   * "completed"：`tool.execute()`（或其 `outputSchema.safeParse` 校验后）的
   * 原始返回值，尚未字符串化。"failed"：给模型看的指导性错误文本（`string`）。
   * 序列化到工具部件/`tool-result` 是回填层（`loop.ts`）的职责。
   */
  output: ToolReturn;
  derived: ToolCallDerivedData;
}

export interface ExecuteToolCallOptions {
  tool: Tool;
  toolName: string;
  callId: string;
  /** 已经过 `resolveToolCallApproval` 校验/获批的输入——这里不再重复 `safeParse`。 */
  input: JsonValue;
  session: { id: string; turn: number };
  fs: NimboFS;
  abortSignal: AbortSignal;
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

/** 单次工具调用的执行体：只执行 + 输出校验，输入已经过 `resolveToolCallApproval`，逐段说明见本文件头"拆分为两步"一节。 */
export async function executeToolCall(opts: ExecuteToolCallOptions): Promise<ToolCallResult> {
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
    rawOutput = await opts.tool.execute(opts.input, ctx);
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
