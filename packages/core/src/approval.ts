/**
 * L2 运行层：审批链求值（tech-spec §4.5 "审批链（求值顺序）"逐字）：
 *
 *   per-tool `approval` 策略先行——"never" 直接放行、回调直接裁决、
 *   "always"/"once" 产生审批请求 → 审批请求交给 session 级 `onApproval`
 *   （也是 `ApprovalPolicy` 形态）裁决 → 两者都未配置默认放行。
 *
 * ---- spec 空白点（按此实现，P4-1 工单要求写清） ----
 *
 * 1. **per-tool 为 "always"/"once" 但 session 未配置 `onApproval`**：字面读
 *    "两者都未配置默认放行"会让这种组合放行，但那会让 "always" 形同虚设——
 *    工具作者显式要求"每次都要有人把关"，宿主却没接审批回调，默认放行等于
 *    悄悄丢弃了这个把关意图。本实现在这种组合下改为 **deny**，附带"配置
 *    onApproval 或调低该工具 approval"的指导文案（见 `noArbiterDecision`）。
 *    "两者都未配置默认放行"这句话因此只在字面意义上成立：per-tool 未配置
 *    （落 "never" 快速通道，见下）+ onApproval 未配置——根本不会走到审批请求
 *    这一步，不存在矛盾。
 * 2. **session `onApproval` 本身字面是 "always"/"once"**（类型上合法，
 *    `ApprovalPolicy` 本来就是 per-tool 与 session 共用的类型）：审批链只有
 *    两级（per-tool → session），session 之上没有第三级仲裁者，因此
 *    `onApproval` 的 "always"/"once" 无法被"进一步"批准——除非 "once" 恰好
 *    已经在 once 记忆里命中过（同一处记忆，按 toolName 键入，无论批准发生在
 *    哪一级）。命中不了时，与"未配置 onApproval"归入同一个 deny 分支——
 *    两者的本质都是"这一步需要一个决策者，但没有"。这是本实现为保持两级
 *    结构一致性做出的裁量，spec 原文未提及（P4-1 工单只点名了第 1 点）。
 *
 * once 记忆（`OnceApprovalMemory`）按 toolName 键入、存储形状由调用方注入
 * （P4-1 工单原文："记忆存储由调用方注入，形状自定"）——这里只定义接口与一个
 * 便利的 `Set` 实现，所有权（跨轮次持久与否）留给 session（P4-2）。
 *
 * `updatedInput` 生效（"allow 携带时替换输入再执行"）：本模块只负责把
 * `ApprovalDecision` 原样冒泡出去，`updatedInput` 是否/如何替换执行输入是
 * `runtime.ts` 的职责（`ApprovalDecision` 本身已经是该做的事）。
 */
import type { ApprovalContext, ApprovalDecision, ApprovalPolicy, JsonValue } from "./types.js";

/** 同一 session 内、按工具名记忆"是否已批准过一次"（"once" 语义）。形状由调用方注入。 */
export interface OnceApprovalMemory {
  hasApproved(toolName: string): boolean;
  markApproved(toolName: string): void;
}

/** `OnceApprovalMemory` 的便利默认实现：纯内存 `Set`，无持久化。 */
export function createOnceApprovalMemory(): OnceApprovalMemory {
  const approved = new Set<string>();
  return {
    hasApproved: (toolName) => approved.has(toolName),
    markApproved: (toolName) => {
      approved.add(toolName);
    },
  };
}

export interface EvaluateApprovalInput {
  toolName: string;
  input: JsonValue;
  ctx: ApprovalContext;
  /** 对应 `Tool.approval`；`undefined` 与 spec 注释 "never（默认放行）" 同义。 */
  toolApproval: ApprovalPolicy | undefined;
  /** 对应 `SessionOptions.onApproval`；`undefined` 表示宿主未接审批回调。 */
  onApproval: ApprovalPolicy | undefined;
  onceMemory?: OnceApprovalMemory;
}

function noArbiterDecision(toolName: string): ApprovalDecision {
  return {
    behavior: "deny",
    message:
      `Tool "${toolName}" requires approval ("always"/"once") but there is no approver configured to decide it. ` +
      'Configure a session onApproval callback, or lower this tool\'s approval policy (e.g. to "never").',
  };
}

/**
 * 求值一个已知非 `undefined` 的 `ApprovalPolicy`（"never"/回调/"always"/
 * "once"）。`escalate` 是这一级判定"需要请求裁决"时该做什么——per-tool 级传
 * 入"转交 session"，session 级传入"无人可转交，返回 no-arbiter deny"（见
 * `evaluateApproval`）。两级共用这一份逻辑，唯一的差异（"undefined 时怎么
 * 办"）留在各自的调用处处理，不塞进这个函数——"never"/回调/"always"/"once"
 * 四种取值在两级的语义完全一致，只有"未配置"的默认行为按级不同。
 */
async function resolveDefinedPolicy(
  policy: ApprovalPolicy,
  toolName: string,
  input: JsonValue,
  ctx: ApprovalContext,
  onceMemory: OnceApprovalMemory | undefined,
  escalate: () => Promise<ApprovalDecision>,
): Promise<ApprovalDecision> {
  if (policy === "never") return { behavior: "allow" };
  if (typeof policy === "function") return await policy(input, ctx);

  // policy is "always" | "once"
  if (policy === "once" && onceMemory?.hasApproved(toolName) === true) {
    return { behavior: "allow" };
  }

  const decision = await escalate();
  if (decision.behavior === "allow" && policy === "once") {
    onceMemory?.markApproved(toolName);
  }
  return decision;
}

/** 审批链主入口：per-tool → session onApproval，求值顺序与语义见本文件头注释。 */
export async function evaluateApproval(opts: EvaluateApprovalInput): Promise<ApprovalDecision> {
  const { toolName, input, ctx, toolApproval, onApproval, onceMemory } = opts;

  const escalateToSession = (): Promise<ApprovalDecision> => {
    if (onApproval === undefined) return Promise.resolve(noArbiterDecision(toolName));
    return resolveDefinedPolicy(onApproval, toolName, input, ctx, onceMemory, () =>
      Promise.resolve(noArbiterDecision(toolName)),
    );
  };

  if (toolApproval === undefined) return { behavior: "allow" };
  return resolveDefinedPolicy(toolApproval, toolName, input, ctx, onceMemory, escalateToSession);
}
