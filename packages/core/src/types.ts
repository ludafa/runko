/**
 * L0 原语层：Tool/ToolContext/Approval 系列、NimboFS、NimboExec（tech-spec
 * §4.1 / §4.4 / §4.5a）。纯接口与基础类型，不含任何运行时实现——
 * MemoryFS/OverlayFS 落在 @nimbo/virtual-fs（P2），NimboExec 的默认实现落在
 * @nimbo/mini-bash（P6），defineAgent/defineTool/defineSkill 落在 P1-2。
 */
import { z } from "zod";

/** JSON 值：自引用，覆盖 `JSON.stringify` 可表达的全部结构。 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * JsonValue 的运行时 zod 校验。z.lazy 处理联合体的自引用，不需要放宽
 * 类型逃逸——递归引用本身就是 zod 官方文档记录的标准写法。
 */
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

/** 工具/资源向模型返回的结果：字符串直传；对象会 JSON.stringify 给模型（§4.1）。 */
export type ToolReturn = string | JsonValue;

// ---- NimboFS：虚拟文件系统（§4.4） ----

export interface FileStat {
  type: "file" | "dir" | "reference";
  size?: number;
  mtime?: number;
  mimeType?: string;
  href?: string;
  annotations?: { description?: string; tags?: string[] };
}

/**
 * readdir() 的单条目。spec §4.4 未单列 DirEntry 的字段，但其验收点——
 * "list-dir 行尾标注类型与 description"/"非文本文件带 mimeType"/
 * "reference 条目带 → href"——需要的信息与 stat() 的返回值完全一致，
 * 因此 DirEntry 定义为 FileStat 的字段集合再加 name，readdir 的实现
 * 不必为目录里每个条目再发一次 stat()。
 */
export interface DirEntry extends FileStat {
  name: string;
}

export interface ExecRequest {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  signal: AbortSignal;
}

export interface ExecOutputChunk {
  stream: "stdout" | "stderr";
  data: string;
}

export interface ExecOptions {
  onOutput?: (chunk: ExecOutputChunk) => void;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface NimboFS {
  /** reference 条目：默认抛 ReferenceNotResolvable，注入 resolver 后返回解析内容。 */
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  rm(path: string, opts?: { recursive?: boolean }): Promise<void>;
  mkdir(path: string): Promise<void>;
  readdir(path: string): Promise<DirEntry[]>;
  stat(path: string): Promise<FileStat>;
  glob(pattern: string): Promise<string[]>;
  /**
   * 原生搜索能力接缝（docs/host/sandbox/tech.md §4）：实现了 = 该底座能一次调用在
   * 内部完成整个文件名搜索（典型如远端沙盒在沙盒里跑一条脚本），`grep`/`glob`
   * 工具会优先调用；抛 `SearchUnsupportedError` 会被工具静默捕获、回退现有
   * `glob()` + JS 过滤逐文件扫描。**内存态/覆盖态实现故意不实现这两个方法**——
   * `OverlayFS` 罩着远端 base 时，base 的 native 搜索看不见 overlay 的脏写，
   * 回退到走 `glob()`（会经过 overlay 合并视图）才是正确语义。
   */
  searchFiles?(query: FileSearchQuery): Promise<FileSearchResult>;
  /** 同 `searchFiles`，覆盖 grep 的正则内容搜索（files/content 双模式）。 */
  searchContent?(query: ContentSearchQuery): Promise<ContentSearchResult>;
}

/** `NimboFS.searchFiles` 的查询参数（对应 `glob` 工具的一次调用）。 */
export interface FileSearchQuery {
  // 绝对虚拟 glob 模式：joinGlobPattern 拼好 scope 与 pattern 后的形态，如 "/app/**" 或 "/**" + "/*.ts"
  // 这类跨目录通配（注意：本行是 // 注释而非 /** */，因为形态本身含有会提前闭合块注释的 "*/" 子串）。
  pattern: string;
  /** 忽略模式：命中路径本身或其任一祖先目录即整棵子树跳过（与 `DirFS` `ignorePatterns` 同语义）。 */
  ignore?: string[];
  /** 源头截断：`paths` 最多返回条数；`total` 不受这个上限影响，仍是全量计数。 */
  limit: number;
}

/** `paths` 已按路径升序排列、只含文件（不含目录）。 */
export interface FileSearchResult {
  paths: string[];
  total: number;
}

/** `NimboFS.searchContent` 的查询参数（对应 `grep` 工具的一次调用）。 */
export interface ContentSearchQuery {
  /** JavaScript RegExp 的 source（调用侧已校验过是合法正则）。 */
  pattern: string;
  ignoreCase?: boolean;
  /** 候选集：绝对虚拟 glob 模式，形态同 `FileSearchQuery.pattern`。 */
  scope: string;
  ignore?: string[];
  mode: "files" | "content";
  /** `content` 模式下每个匹配 ±N 行上下文；`files` 模式忽略这个字段。 */
  context?: number;
  /** 命中文件数闸（grep 固定 100）。 */
  maxFiles: number;
  /** `content` 模式下的输出行数闸（grep 固定 500）；`files` 模式忽略这个字段。 */
  maxLines: number;
}

/** `content` 模式下的一行：`match` 为 true 表示命中行本身，false 表示 ±context 的周边行。 */
export interface ContentSearchLine {
  line: number;
  text: string;
  match: boolean;
}

/** 一个文件的搜索结果分组；`files` 模式下 `lines` 恒为 `[]`。 */
export interface ContentSearchGroup {
  path: string;
  lines: ContentSearchLine[];
}

export interface ContentSearchResult {
  groups: ContentSearchGroup[];
  /** 命中文件总数（未经 `maxFiles` 截断的全量计数）。 */
  totalFiles: number;
  /** `content` 模式下是否因触达 `maxLines` 而提前截断（`files` 模式恒为 false）。 */
  lineCapped: boolean;
}

// ---- NimboExec：命令执行的接口倒置，与 NimboFS 同构（§4.5a） ----

export interface NimboExec {
  exec(req: ExecRequest, opts?: ExecOptions): Promise<ExecResult>;
  /** 环境自描述（OS/网络/cwd 语义），拼进 bash 工具描述。 */
  describe?(): string;
  /** 实现自声明的审批默认值（本地实现 "review"，沙盒实现通常 "allow"）。 */
  defaultApproval?: ApprovalPolicy;
}

// ---- 活动信号：让远端工作区知道「这一轮还在干活」（docs/host/sandbox-keepalive/tech.md §5.1） ----

/**
 * 一次[活动信号](../../../docs/terms.md)的载荷。
 *
 * `reason` 区分两种「还活着」：`progress` 是这一轮在正常推进（模型在产出、工具在
 * 交付结果）；`awaiting-approval` 是 loop 已经停在 `tool-approval-request` 上、
 * 正 `await` 人审通道。两者值得区别对待——干活该续期，等人可能只该续一小会儿
 * （云沙盒适配器据此给两者不同的预算，见 `@nimbo/sandbox-e2b` 的 `keepAlive`）。
 */
export interface ActivitySignal {
  /** 会话与轮次。实现方据此识别「新的一轮开始了」，重置自己的预算计数。 */
  session: { id: string; turn: number };
  /** 现在在等什么。 */
  reason: "progress" | "awaiting-approval";
}

/**
 * 工作区的可选能力：接收[活动信号](../../../docs/terms.md)。
 *
 * 与 `NimboFS.searchFiles?` / `NimboExec.describe?` 同类——远端实现（云沙盒适配器）
 * 实现它来做[保活](../../../docs/terms.md)，内存态/本机实现不实现，core 结构探测
 * 后直接跳过，**没实现就完全不发生任何事**。
 *
 * **必须同步返回 void，绝不能返回 Promise、绝不能抛错。** core 是在 chunk 流的
 * 推进路径上调它的（`session.ts` 的 `stream()`），既不 `await` 也不 `catch`：
 * 续期是网络往返，要是 core 等它，整条流就被拖住，用户看到的打字机效果会一顿一顿。
 * 实现方内部自己 fire-and-forget、自己吞错。
 */
export interface NimboActivityAware {
  onActivity?(signal: ActivitySignal): void;
}

/**
 * 工作区的可选能力：**手动**把沙盒存活时长补足一次（[保活](../../../docs/terms.md)）。
 *
 * 与 `NimboActivityAware` 分工不同——那条是 core 在一轮**进行中**自动推的，这条是
 * 宿主在轮**之外**主动调的（起轮前、审批路由等 core 的轮还没起或已经结束的时刻）。
 * 自动那套内部就建在这个动作上，两者打同一个[续期闸门](../../../docs/terms.md)。
 */
export interface NimboKeepAliveCapable {
  keepAlive?(targetMs: number): Promise<void>;
}

// ---- 审批链（docs/agent/single-ledger/tech.md §6，P13-5-2c 三值重构；术语见 docs/terms.md §4） ----

export interface ApprovalContext {
  toolName: string;
  callId: string;
  session: { id: string; turn: number };
}

/**
 * 一次工具调用的审批结果三选一（docs/agent/single-ledger/tech.md §6.1）：`allow` 直接执行；`review`
 * 人工审批（loop 先 yield `tool-approval-request` chunk 再阻塞等真人，见
 * `loop.ts`）；`deny` 直接拒绝。旧 `ApprovalDecision`（allow+updatedInput /
 * deny+message 二值）已删除——`updatedInput`（允许时改模型填的参数）随之整体
 * 移除（2026-07-15 定案，见 docs/agent/single-ledger/tech.md §6.3：chat 卡片从来只有允许/拒绝两个按钮，
 * 没有编辑框）。
 */
export type ApprovalOutcome = "allow" | "review" | "deny";

/**
 * 策略 vs 结果分层（docs/agent/single-ledger/tech.md §6.1）：策略是配在工具上（`Tool.approval`）/注入
 * 会话（原 `SessionOptions.onApproval`，现审批分类器）的规则，解析出每次调用
 * 的结果三值之一。旧字符串 `"never"`/`"always"`/`"once"` 全废——
 * `"never"` → `"allow"`、`"always"` → `"review"`、`"once"` → `"review-once"`。
 * `"review"`：每次调用都问。`"review-once"`：第一次问、批准后本会话记住、之后
 * `"allow"`（复用现有 once 记忆）。回调形态直接产出 `ApprovalOutcome`——这正是
 * §6.2 的「审批分类器」形态，per-tool 与 session 共用同一个类型。
 */
export type ApprovalPolicy =
  | "allow"
  | "review"
  | "review-once"
  | "deny"
  | ((input: JsonValue, ctx: ApprovalContext) => Promise<ApprovalOutcome> | ApprovalOutcome);

/**
 * 人工裁决（docs/agent/single-ledger/tech.md §6.3）：分类器返回 `review` 后弹给真人的卡片，真人只答
 * 两值——`updatedInput`（改参数）彻底删除，"让它换个做法"用「拒绝+理由」或
 * steer 更直白。`deny.message` = 拒绝理由，回填模型。
 */
export type HumanDecision = { behavior: "allow" } | { behavior: "deny"; message?: string };

/** `ApprovalReviewer`（session 的人审通道，见 `loop.ts`）收到的一次待裁决请求。 */
export interface ApprovalReviewRequest {
  toolName: string;
  input: JsonValue;
  ctx: ApprovalContext;
}

/**
 * session 级注入的「等真人」通道（docs/agent/single-ledger/tech.md §6.4 施工回报新增接口，P13-5-2c）：
 * `evaluateApproval` 解析出 `review` 后，`loop.ts` 先 yield
 * `tool-approval-request` chunk（界面弹卡片），再 `await` 这个函数拿到人工裁决。
 * 未注入（`undefined`）时 `review` 视同无仲裁者——按 deny + 现有指导文案处理，
 * 语义与"session 未配置分类器"一致。与旧 `SessionOptions.onApproval`
 * （现在的审批分类器，仍是 `ApprovalPolicy`）是两个独立的注入点：分类器是同步
 * 的三值判断，这个是真正的异步"等人"步骤。
 */
export type ApprovalReviewer = (request: ApprovalReviewRequest) => Promise<HumanDecision>;

// ---- Skills：仅类型（§4.1；defineSkill 与加载实现见 P1-2 起） ----

export interface SkillFileHandle {
  text(): Promise<string>;
}

/** eve 形态：`ctx.getSkill(name).file(relPath).text()` 读取 skill 附属文件。 */
export interface SkillHandle {
  file(relPath: string): SkillFileHandle;
}

// ---- Tool / ToolContext（§4.1） ----

export interface ToolContext {
  fs: NimboFS;
  abortSignal: AbortSignal;
  callId: string;
  session: { id: string; turn: number };
  getSkill(name: string): SkillHandle;
  /** 流式进度 → item.updated。 */
  update(partial: string): void;
}

/**
 * `defineTool(...)` 的返回类型（P1-2 实现）：`AgentDefinition.tools` 是
 * `Record<string, Tool>`，因此这里是类型擦除后的非泛型形态——具体工具的
 * 输入类型经 `defineTool` 的泛型 `In`（`z.infer<In>`）在定义处收敛，
 * 一旦放进 tools 记录里就统一走 JsonValue（工具调用的实参本来就是模型
 * 产生的 JSON）。
 */
export interface Tool {
  description: string;
  inputSchema: z.ZodType<JsonValue>;
  outputSchema?: z.ZodType<ToolReturn>;
  approval?: ApprovalPolicy;
  /**
   * 声明该工具无副作用（纯读：不写工作区、不产生 file-change/plan-update 等
   * 派生数据）。同一 step 的一批 tool call **全部** readOnly 时，loop 并行
   * 结算（loop.ts `runOneStep`——模型同批调用本就是一组独立操作，parallel
   * tool use 契约允许并行）；缺省视为有副作用，整批退回串行。
   */
  readOnly?: boolean;
  execute(input: JsonValue, ctx: ToolContext): Promise<ToolReturn> | ToolReturn;
}
