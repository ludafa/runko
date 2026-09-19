/**
 * L2 运行层：**一次工具调用**的执行体。不含 loop / session 的任何东西——不维护跨调用的
 * readState（那是文件工具与 session 的职责），也不对 abort 做特判（`execute()` 因 abort 抛出
 * 时自然落进 "failed" 分支，与其它运行时错误走同一条路）。
 *
 * ## 为什么是两个函数，不是一个
 *
 * 「输入校验 → 审批 → 执行 → 输出校验」刻意**没有**揉进一个原子调用：
 *
 * 1. **`resolveToolCallApproval`**——`tool.inputSchema.safeParse` 校验模型产生的（可能畸形的）
 *    输入，失败即 "invalid" 并回填指导性错误；然后走审批链（`evaluateApproval`），
 *    `allow` / `deny` / `review` 三值直接映射成返回的 `status`。**不执行工具，不建
 *    `ToolContext`。**
 * 2. **`executeToolCall`**——只做执行：组装 `ToolContext` → 调 `tool.execute()` → 抛错即
 *    "failed" 并回填错误消息（不崩 loop）→ 声明了 `outputSchema` 就校验返回值，不匹配同样是
 *    "failed" → 成功即 "completed"。入参是第 1 步已校验、已获批的值，**这里不重复
 *    `safeParse`，也不碰审批**。
 *
 * 拆开的理由是 `review`：那条路要在两步之间先 yield 出审批请求、再 await 人工裁决，而
 * 「先产出、后阻塞」是一个 `await` 边界，塞不进一个返回 `Promise` 的普通函数里让调用方中途
 * 取值。所以中间那一段由 `loop.ts`（async generator）插入，见它的文件头。
 *
 * 由此，`ToolCallStatus` 是 "completed" / "failed" / "suspended"——**"denied" 不在这一层**。
 * 拒绝的编码（`tool-output-denied` chunk + 理由回填）整个是 `loop.ts` 的事，`executeToolCall`
 * 根本不认识「拒绝」这个概念。同理，`ToolReturn` 的模型可读序列化也不在这里做，"completed" 的
 * `output` 字段原样就是 `tool.execute()` 的返回值。
 *
 * "suspended" 是工具自己调 `ctx.suspend()` 声明的[挂起](../../../docs/terms.md)——它有
 * **两条**识别路径，见下面 `executeToolCall` 里那段注释。
 *
 * ## 派生数据为什么走「构造期回调」而不是 `ToolContext`
 *
 * `file_change` / `plan_update` 这类派生数据，生产者是具体工具的 `execute()`，消费者是 loop。
 * 中间需要一条通道，而两条显而易见的路都堵死了：`Tool.execute()` 的返回值类型是
 * `ToolReturn`（模型可读的单一值），没有第二个返回通道；`ToolContext` 的字段是定死的六个。
 *
 * 于是走**工具构造期注入**：工厂函数（如 `createUpdatePlanTool(opts)`）收下回调，`execute()`
 * 内部直接调它上报——不经过 `ToolContext`，接口形状一个字不用改。这与
 * `@runko/virtual-fs` 的 `createFileTools(opts).onFileChange` 是同一个接缝家族。
 *
 * 本文件提供 `DerivedDataCollector`：每次 `executeToolCall` 前后「清空 → 收集 → 取走」。
 * 调用方构造工具集时把它的 `recordFileChange` / `recordPlanUpdate` 接成工具的回调选项，再把
 * **同一个实例**传给每次 `executeToolCall`。runtime 因此完全不需要知道这次调的是哪个工具
 * ——它只在 `execute()` 前后各读一次收集器，把这期间新增的记录归给这次调用。
 *
 * ⚠️ **这里有一个前提：同一个收集器不会被并发的 `executeToolCall` 共享。** 目前 loop 是逐个
 * 工具顺序执行，前提成立。**将来若引入并发工具调用，必须先给收集器加调用范围隔离**，否则
 * 派生数据会串到别的调用上。
 */
import type { ApprovalContext, ApprovalPolicy, JsonValue, RunkoFS, SkillHandle, Tool, ToolContext, ToolReturn } from "./types.js";
import { evaluateApproval, type OnceApprovalMemory } from "./approval.js";
import { createSuspendRequest, requestSuspend } from "./suspend.js";

// ---- 派生数据：工具上报、loop 消费（形状与理由见文件头） ----

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

  if (resolution.outcome === "deny") {return { status: "deny", reason: resolution.reason };}
  if (resolution.outcome === "review") {
    return { status: "review", input: parsedInput.data, markOnceOnApprove: resolution.markOnceOnApprove };
  }
  return { status: "allow", input: parsedInput.data };
}

// ---- 第 2 步：executeToolCall（只执行，输入已校验/已获批） ----

export type ToolCallStatus = "completed" | "failed" | "suspended";

/**
 * **判别联合**，按 `status` 收窄：`"suspended"` 没有 `output`，因为那次调用**没有产生结果**
 * ——挂起不是一种结果，是「这一轮到此为止」。写成联合是让编译器替我们拦住「拿挂起当结果用」。
 */
export type ToolCallResult =
  | {
      status: "completed";
      /** `tool.execute()`（或其 `outputSchema.safeParse` 校验后）的原始返回值，尚未字符串化。序列化到工具部件/`tool-result` 是回填层（`loop.ts`）的职责。 */
      output: ToolReturn;
      derived: ToolCallDerivedData;
    }
  | {
      status: "failed";
      /** 给模型看的指导性错误文本。 */
      output: ToolReturn;
      derived: ToolCallDerivedData;
    }
  | {
      status: "suspended";
      /** 工具传给 `ctx.suspend()` 的理由，原样透传（core 不认识它的含义）。 */
      reason: string | undefined;
      derived: ToolCallDerivedData;
    };

export interface ExecuteToolCallOptions {
  tool: Tool;
  toolName: string;
  callId: string;
  /** 已经过 `resolveToolCallApproval` 校验/获批的输入——这里不再重复 `safeParse`。 */
  input: JsonValue;
  session: { id: string; turn: number };
  fs: RunkoFS;
  abortSignal: AbortSignal;
  /** 接到 `ctx.update(partial)`；未提供时 `ctx.update` 是无操作。 */
  onProgress?: (partial: string) => void;
  /** 本次调用期间要收集的派生数据（形状与理由见本文件头）。 */
  derivedData?: DerivedDataCollector;
  /**
   * `ctx.getSkill` 的真实现（P5，`@runko/core/skills/registry.js` 的
   * `createGetSkill`）：`session.ts` 经 `loop.ts` 把它一路传下来。未提供时退回
   * `createPlaceholderGetSkill()`（占位实现，见下）——这保持了
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
 * `@runko/virtual-fs` 的 `describeError`），只用于这一处收窄，不向外扩散
 * `unknown`：`tool.execute()` 按 `Tool` 接口的类型签名只会抛 `unknown`
 * （JS/TS 里 `throw` 的静态类型恒为 `unknown`），这是把它安全转成消息文本的
 * TypeScript 官方推荐写法本身要求的输入类型，不是绕开类型系统的手段。
 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `ctx.getSkill` 的占位实现：只在 `executeToolCall` 未接到真实
 * `getSkill`（`ExecuteToolCallOptions.getSkill`）时使用——`session.ts` 走的正常路径
 * （经 `loop.ts`）总会传入真实现（`createGetSkill`）。这个占位只为「绕过 session 直接调
 * `executeToolCall`」这种用法（比如本文件与 `loop.ts` 的单测）兜底。
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
  // 这一次调用专属的挂起标记——`ctx.suspend()` 写它（见 `suspend.ts`）。
  const suspendRequest = createSuspendRequest();
  const ctx: ToolContext = {
    fs: opts.fs,
    abortSignal: opts.abortSignal,
    callId: opts.callId,
    session: opts.session,
    getSkill: opts.getSkill ?? createPlaceholderGetSkill(),
    update: (partial) => opts.onProgress?.(partial),
    suspend: (reason) => requestSuspend(suspendRequest, reason),
  };

  // 防御性清空：确保这次调用只归集这次调用期间产生的记录，不带上任何此前
  // 调用遗留（理论上不该有，因为每次调用末尾都会 drain；这里是双重保险）。
  opts.derivedData?.drain();

  let rawOutput: ToolReturn;
  try {
    rawOutput = await opts.tool.execute(opts.input, ctx);
  } catch (error) {
    // 挂起的第一条识别路径：`SuspendSignal` 一路抛到这里（正常情形）。
    if (suspendRequest.requested) {
      return { status: "suspended", reason: suspendRequest.reason, derived: opts.derivedData?.drain() ?? emptyDerived() };
    }
    return {
      status: "failed",
      output: `Tool "${opts.toolName}" threw during execution: ${describeError(error)}.`,
      derived: opts.derivedData?.drain() ?? emptyDerived(),
    };
  }

  // 第二条识别路径：工具内部一句 `try { ... } catch { return "先跳过" }` 把信号吃掉了，
  // `execute` 正常返回。**标记才是判据**，所以这里照样算挂起，`rawOutput` 连
  // `outputSchema` 都不过——那个垫场返回值不该进账本。
  if (suspendRequest.requested) {
    return { status: "suspended", reason: suspendRequest.reason, derived: opts.derivedData?.drain() ?? emptyDerived() };
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
