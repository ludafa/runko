/**
 * `@nimbo/sdk` 的默认装配版 `createSession`（docs/tech/core-sdk.md §2 门面定位 / §4.2 L2 运行层
 * / docs/tech/builtin-tools.md §3 `builtinTools` 语义）。包装 `@nimbo/core` 的原始
 * `createSession`——`@nimbo/core` 本身刻意不依赖 `@nimbo/virtual-fs`（避免
 * core ↔ virtual-fs 成环，见 core `session.ts` 文件头"fs 缺省"一节），因此
 * "fs 缺省时默认 `MemoryFS`"与"文件工具八件套默认全开"这两条 batteries-included
 * 承诺只能在这个允许同时依赖 core 与 virtual-fs 的门面包里兑现。
 *
 * ---- 与 core 原始 `createSession`/`Session` 的名字冲突（工单要求显式处理） ----
 *
 * 本文件的 `createSession`/`Session` 与 core 同名但语义不同（默认装配 vs.
 * 无装配的原语）。`index.ts` 用具名 `export { createSession, type Session } from
 * "./session.js"` 覆盖 `export * from "@nimbo/core"` 带入的同名绑定——ECMAScript
 * 模块规范下，同一模块内的"本地声明/具名导出"优先于 `export *` 带入的同名绑定，
 * 不产生重复导出错误（已用最小复现验证）；宿主明确需要 core 未加装配的原始
 * `createSession`/`Session` 时，可以直接 `import { createSession } from "@nimbo/core"`
 * ——两个包各自可独立安装，这条路径没有被这里的遮蔽切断。
 * `SessionOptions` 字段形状不变（`fs?`/`workspace?` 仍是 `NimboFS`/`NimboFS & NimboExec`，
 * 只是运行时默认值变了），因此直接复用 core 的类型，本文件不重新声明。
 *
 * ---- fs 的具体类型保留（工单要求 4：`session.fs.diff()` 必须能编译） ----
 *
 * core 的 `Session.fs` 类型固定为接口 `NimboFS`（七个方法，没有 `diff()`/`writeBack()`
 * 这类 MemoryFS/OverlayFS 的"附加能力"）。产品文档 §4.1 五行示例里
 * `session.fs.diff()` 要求 `createSession(...)` 返回值上的 `fs` 保留调用方传入的
 * 具体子类型。做法：三个重载 + 一个"擦除后"的宽实现签名——
 *   1. `opts.fs: F`（`F extends NimboFS`）→ `Session<F>`：F 从实参具体类型推导
 *      （如 `NimboFS.fromDirectory(...)` 返回 `OverlayFS`，`session.fs` 即为 `OverlayFS`）。
 *   2. `opts.workspace: W`（`W extends NimboFS & NimboExec`，§4.5a 模式 A 语法糖）→
 *      `Session<W>`：同一对象既是 fs 又是 exec，`session.fs` 保留它的具体类型。
 *   3. 两者都不给 → `Session<MemoryFS>`：默认装配的 `new MemoryFS()` 有 `.diff()`，
 *      五行示例不显式传 `fs` 时同样能编译（虽然产品文档的例子用的是 `fromDirectory`）。
 * 实现体本身按最宽的擦除类型写（`opts: SessionOptions`，返回 core 原始 `Session`，
 * fs 位是接口 `NimboFS`）——TypeScript 检查重载实现时，只要求实现签名与每个重载
 * "调用兼容"（形参逆变、不逐一比对返回类型的具体实参分支），不需要在函数体内部
 * "证明"运行时省略 `fs` 就等于类型层的默认 `F = MemoryFS`（那是分支 3 单靠 TS
 * 控制流分析做不到的事，重载在这里恰好绕开了这个限制，不需要任何类型断言）。
 * 已用最小复现验证这个组合可以过 tsc/tsgo 严格模式检查。
 *
 * 已知的类型精度缺口（工单要求"取舍注释"处，非 bug）：若调用方把 `{ fs, workspace }`
 * 装进一个**预先声明的变量**（非对象字面量）再传入，三个重载里"仅 fs"与"仅
 * workspace"两个重载都不会因为对方字段的存在而报错（对象字面量的多余属性检查
 * 只在字面量场景生效，变量场景下结构类型允许多余字段）——这种误用在类型层不会
 * 被拦下，但 core 的 `resolveExecutionSurfaces` 在运行时仍会同步 throw
 * （`WORKSPACE_EXCLUSIVITY_MESSAGE`），正确性由运行时兜底，类型层的这点不精确
 * 只是体验上少了一次编译期报错，不影响功能正确性。
 */
import type { AgentDefinition, BuiltinToolName, DerivedDataCollector, NimboExec, NimboFS, SessionReadState, Tool } from "@nimbo/core";
import { createDerivedDataCollector, createSession as createCoreSession, createSessionReadState } from "@nimbo/core";
import type { Session as CoreSession, SessionOptions as CoreSessionOptions } from "@nimbo/core";
import type { FileChange, FileToolName } from "@nimbo/virtual-fs";
import { createFileTools, MemoryFS } from "@nimbo/virtual-fs";

/** sdk 门面版 `Session`：与 core 的原始 `Session` 完全一致，只是 `fs` 保留调用方传入的具体类型。 */
export type Session<F extends NimboFS = NimboFS> = Omit<CoreSession, "fs"> & { readonly fs: F };

/** 八件套的全部工具名，按 docs/tech/builtin-tools.md §1.1–§1.8 的声明顺序列出。 */
const ALL_FILE_TOOL_NAMES = [
  "read-file",
  "write-file",
  "edit-file",
  "delete-file",
  "move-file",
  "list-dir",
  "glob",
  "grep",
] as const satisfies readonly FileToolName[];

/**
 * `agent.builtinTools` 对文件工具八件套的过滤（docs/tech/builtin-tools.md §3）：
 * `false` 全关；`undefined`（未配置）默认全开；数组按白名单交集（数组里
 * 出现的 `update-plan`/其他非文件工具名对这里无意义，交集自然把它们滤掉——
 * `update-plan` 的开关逻辑仍由 core 自己的 `isUpdatePlanEnabled` 负责，两条
 * 过滤各自独立、互不影响）。
 */
function resolveEnabledFileToolNames(builtinTools: BuiltinToolName[] | false | undefined): readonly FileToolName[] {
  if (builtinTools === false) return [];
  if (builtinTools === undefined) return ALL_FILE_TOOL_NAMES;
  const requested = new Set<BuiltinToolName>(builtinTools);
  return ALL_FILE_TOOL_NAMES.filter((name) => requested.has(name));
}

/**
 * 预构造 `readState`/`derivedData` store 并拼出过滤后的文件工具八件套——
 * 沿用 core `session.ts` 文件头记录的宿主装配姿态（`createFileTools({ readState,
 * onFileChange })`，`onFileChange` 把 `FileChange[]` 逐条转发进
 * `derivedData.recordFileChange`），只是这里由 sdk 在 `createSession(...)` 内部
 * 自动完成，宿主不需要再手写这段拼装（P4-2 集成测试里手写的那段，正是这里的
 * 落地位置）。
 */
function buildDefaultFileTools(agent: AgentDefinition, readState: SessionReadState, derivedData: DerivedDataCollector): Record<string, Tool> {
  const enabledNames = resolveEnabledFileToolNames(agent.builtinTools);
  if (enabledNames.length === 0) return {};

  const allFileTools = createFileTools({
    readState,
    onFileChange: (changes: FileChange[]) => {
      for (const change of changes) derivedData.recordFileChange(change);
    },
  });

  const enabled: Record<string, Tool> = {};
  for (const name of enabledNames) enabled[name] = allFileTools[name];
  return enabled;
}

/** `fs`/`workspace` 都未提供时才注入默认 `MemoryFS`——两者任一存在都原样透传给 core 自行解析（含互斥校验与 exec 派生）。 */
function withDefaultFs(opts: CoreSessionOptions): CoreSessionOptions {
  if (opts.fs !== undefined || opts.workspace !== undefined) return opts;
  return { ...opts, fs: new MemoryFS() };
}

// ---- 重载：fs 具体类型的保留（见本文件头"fs 的具体类型保留"一节） ----

export function createSession<F extends NimboFS>(
  agent: AgentDefinition,
  opts: Omit<CoreSessionOptions, "fs" | "workspace"> & { fs: F },
): Session<F>;
export function createSession<W extends NimboFS & NimboExec>(
  agent: AgentDefinition,
  opts: Omit<CoreSessionOptions, "fs" | "workspace"> & { workspace: W },
): Session<W>;
export function createSession(agent: AgentDefinition, opts?: CoreSessionOptions): Session<MemoryFS>;
export function createSession(agent: AgentDefinition, opts: CoreSessionOptions = {}): CoreSession {
  const readState = opts.readState ?? createSessionReadState();
  const derivedData = opts.derivedData ?? createDerivedDataCollector();

  const tools: Record<string, Tool> = { ...buildDefaultFileTools(agent, readState, derivedData), ...(agent.tools ?? {}) };
  const assembledAgent: AgentDefinition = { ...agent, tools };

  const coreOpts = withDefaultFs({ ...opts, readState, derivedData });
  return createCoreSession(assembledAgent, coreOpts);
}
