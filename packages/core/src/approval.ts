/**
 * L2 运行层：审批链求值（docs/agent/single-ledger/tech.md §6，P13-5-2c 三值
 * 重构；两层组合语义沿自 docs/core/core-sdk/tech.md §4.5"审批链（求值顺序）"，逐字保留，只是
 * 结果值从二值 `ApprovalDecision`（allow/deny）换成三值 `ApprovalOutcome`
 * （allow/review/deny）——本文件是这次重构里"语义不变"的落地点）：
 *
 *   per-tool `approval` 策略先行——`"allow"` 直接放行、回调直接产出
 *   `ApprovalOutcome`、`"review"`/`"review-once"` 触发升级 → 升级请求交给
 *   session 级"审批分类器"（也是 `ApprovalPolicy` 形态，即原 `onApproval`）
 *   裁决 → 两者都未配置默认放行。
 *
 * ---- spec 空白点（P4-1 工单原文，语义随三值化整体保留） ----
 *
 * 1. **per-tool 为 `"review"`/`"review-once"` 但 session 未配置分类器**：字面读
 *    "两者都未配置默认放行"会让这种组合放行，但那会让 `"review"` 形同虚设——
 *    工具作者显式要求"每次都要有人把关"，宿主却没接分类器，默认放行等于
 *    悄悄丢弃了这个把关意图。本实现在这种组合下改为 **deny**，附带"配置
 *    session 审批分类器或调低该工具 approval"的指导文案（见
 *    `noArbiterResolution`）。"两者都未配置默认放行"这句话因此只在字面意义上
 *    成立：per-tool 未配置（落 `"allow"` 快速通道，见下）+ session 分类器未
 *    配置——根本不会走到审批请求这一步，不存在矛盾。
 * 2. **session 分类器本身字面是 `"review"`/`"review-once"`**（类型上合法，
 *    `ApprovalPolicy` 本来就是 per-tool 与 session 共用的类型）：审批链只有
 *    两级（per-tool → session），session 之上没有第三级仲裁者，因此
 *    session 的 `"review"`/`"review-once"` 无法被"进一步"批准——除非
 *    `"review-once"` 恰好已经在 once 记忆里命中过（同一处记忆，按 toolName
 *    键入，无论批准发生在哪一级）。命中不了时，与"未配置分类器"归入同一个
 *    deny 分支——两者的本质都是"这一步需要一个决策者，但没有"。这是本实现为
 *    保持两级结构一致性做出的裁量，spec 原文未提及（P4-1 工单只点名了第 1 点）。
 *
 * once 记忆（`OnceApprovalMemory`）按 toolName 键入、存储形状由调用方注入
 * （P4-1 工单原文："记忆存储由调用方注入，形状自定"）——这里只定义接口与一个
 * 便利的 `Set` 实现，所有权（跨轮次持久与否）留给 session（P4-2）。
 *
 * ---- once 记忆的标记时机（P13-5-2c 新语义，docs/agent/single-ledger/tech.md §6.1 "review-once：…
 * once 记忆的标记时机改为「人工裁决 allow 之后」") ----
 *
 * 只要某一级的策略解析在**这次 `evaluateApproval` 调用内部**就同步落到了
 * `allow`（例如 session 分类器是一个直接返回 `"allow"` 的回调，从未真的问过
 * 人），`review-once` 那一级立刻在这里标记 once 记忆——这与三值化之前的行为
 * 完全一致（"问"在两层模型里指"问上一级仲裁者"，不特指"问真人"）。只有当
 * 解析结果**冒泡到 `review`**（意味着这次调用要么在 per-tool/session 的回调
 * 里被直接判定需要真人、要么升级到头仍无法在本函数内部同步落定），本函数才
 * 无法自己标记——此时返回的 `ApprovalResolution` 带上 `markOnceOnApprove: true`，
 * 把"人工裁决 allow 后要不要标记"这个决定权交给 `loop.ts`（`review-once` 第
 * 一次 review 被真人批准后才记住，被拒不记）。
 */
import type { ApprovalContext, ApprovalOutcome, ApprovalPolicy, JsonValue } from "./types.js";

/** 同一 session 内、按工具名记忆"是否已批准过一次"（`review-once` 语义）。形状由调用方注入。 */
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

/**
 * `evaluateApproval` 的产出：核心语义是 `outcome`（`ApprovalOutcome` 三值），
 * 判别联合按 outcome 精确到调用方无需再猜——`deny` 恒带 `reason`（回填模型的
 * 拒绝理由：无仲裁者指导文案，或策略/分类器 `deny` 的默认文案，docs/agent/single-ledger/tech.md §6.4
 * "拒绝理由 = 无仲裁者指导文案或分类器 deny 的默认文案"——三值化后
 * `ApprovalOutcome` 是裸字符串，策略/分类器无法附带自定义理由，这与旧
 * `ApprovalDecision.deny.message` 相比是刻意的能力收窄，见本次工单回报）；
 * `review` 恒带 `markOnceOnApprove`（是否要在人工 allow 后标记 once 记忆，
 * 理由见本文件头）。
 */
export type ApprovalResolution =
  | { outcome: "allow" }
  | { outcome: "deny"; reason: string }
  | { outcome: "review"; markOnceOnApprove: boolean };

export interface EvaluateApprovalInput {
  toolName: string;
  input: JsonValue;
  ctx: ApprovalContext;
  /** 对应 `Tool.approval`；`undefined` 与 spec 注释 "allow（默认放行）" 同义。 */
  toolApproval: ApprovalPolicy | undefined;
  /** 对应 session 审批分类器（原 `SessionOptions.onApproval`）；`undefined` 表示宿主未接。 */
  onApproval: ApprovalPolicy | undefined;
  onceMemory?: OnceApprovalMemory;
}

/** 分类器/策略 `deny` 的默认拒绝文案——`ApprovalOutcome` 是裸字符串，无法附带自定义理由（见 `ApprovalResolution` 注释）。 */
export const DEFAULT_DENY_MESSAGE = "Tool call denied.";

/**
 * "无仲裁者"指导文案——两处复用同一份文本：(a) 本文件内，session 分类器未
 * 配置时的兜底；(b) `loop.ts`，`evaluateApproval` 解析出 `review` 但会话没有
 * 注入 `onReview`（人审通道）时——docs/agent/single-ledger/tech.md §6.4"未注入时：review 无人可裁 →
 * 视同无仲裁者 deny（附指导文案）"，两种"没有人能裁决"殊途同归，文案一致。
 */
export function noArbiterDenyReason(toolName: string): string {
  return (
    `Tool "${toolName}" requires approval ("review"/"review-once") but there is no approver configured to decide it. ` +
    'Configure a session approval classifier (or an ApprovalReviewer via onReview), or lower this tool\'s approval policy (e.g. to "allow").'
  );
}

function noArbiterResolution(toolName: string): ApprovalResolution {
  return { outcome: "deny", reason: noArbiterDenyReason(toolName) };
}

/**
 * 求值一个已知非 `undefined` 的 `ApprovalPolicy`（`"allow"`/回调/`"review"`/
 * `"review-once"`/`"deny"`）。`escalate` 是这一级判定"需要请求裁决"时该做
 * 什么——per-tool 级传入"转交 session"，session 级传入"无人可转交，返回
 * no-arbiter deny"（见 `evaluateApproval`）。两级共用这一份逻辑，唯一的差异
 * （"未配置时怎么办"）留在各自的调用处处理，不塞进这个函数——固定策略/回调
 * 四种取值在两级的语义完全一致，只有"未配置"的默认行为按级不同。
 */
async function resolvePolicy(
  policy: ApprovalPolicy,
  toolName: string,
  input: JsonValue,
  ctx: ApprovalContext,
  onceMemory: OnceApprovalMemory | undefined,
  escalate: () => Promise<ApprovalResolution>,
): Promise<ApprovalResolution> {
  if (policy === "allow") return { outcome: "allow" };
  if (policy === "deny") return { outcome: "deny", reason: DEFAULT_DENY_MESSAGE };

  if (typeof policy === "function") {
    const outcome: ApprovalOutcome = await policy(input, ctx);
    if (outcome === "allow") return { outcome: "allow" };
    if (outcome === "deny") return { outcome: "deny", reason: DEFAULT_DENY_MESSAGE };
    // 回调直接决定，不升级（同旧行为"per-tool 回调决定不咨询 onApproval"）——
    // 回调本身返回 "review" 就是这一级的终局判断，交给 loop 去问真人。
    return { outcome: "review", markOnceOnApprove: false };
  }

  // policy is "review" | "review-once"
  if (policy === "review-once" && onceMemory?.hasApproved(toolName) === true) {
    return { outcome: "allow" };
  }

  const resolution = await escalate();
  if (policy === "review-once") {
    if (resolution.outcome === "allow") {
      onceMemory?.markApproved(toolName);
    } else if (resolution.outcome === "review") {
      return { ...resolution, markOnceOnApprove: true };
    }
  }
  return resolution;
}

/** 审批链主入口：per-tool → session 分类器，求值顺序与语义见本文件头注释。 */
export async function evaluateApproval(opts: EvaluateApprovalInput): Promise<ApprovalResolution> {
  const { toolName, input, ctx, toolApproval, onApproval, onceMemory } = opts;

  const escalateToSession = (): Promise<ApprovalResolution> => {
    if (onApproval === undefined) return Promise.resolve(noArbiterResolution(toolName));
    return resolvePolicy(onApproval, toolName, input, ctx, onceMemory, () =>
      Promise.resolve(noArbiterResolution(toolName)),
    );
  };

  if (toolApproval === undefined) return { outcome: "allow" };
  return resolvePolicy(toolApproval, toolName, input, ctx, onceMemory, escalateToSession);
}
