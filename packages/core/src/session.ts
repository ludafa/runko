/**
 * L2 运行层：`createSession`/`Session`（tech-spec §4.2 全节 / §4.8 终止与恢复
 * 边界）。持有一个会话跨 turn 的全部持久状态，把"给定状态跑一个 turn"的活
 * 委派给 `loop.ts` 的 `runTurn`——本文件只做状态的所有权与生命周期、输入/
 * 输出的组装、以及 `send()` 相对 `stream()` 的缓冲语义。
 *
 * ---- 本工单范围内 vs 明确推迟（工单原文逐条对应） ----
 *
 * - `toJSON()`/`resume`/`send<T>(...outputSchema)` 重载（P7-2，本文件落地）：
 *   见下方"结构化输出 + 序列化/恢复（P7-2）"一节。默认 `MemoryFS` 装配仍归
 *   `@nimbo/sdk`（P7-3 起）——本文件不 import `@nimbo/virtual-fs`，理由同下一条。
 * - 文件工具八件套的实例化：归 `@nimbo/sdk` 默认装配——本文件只认
 *   `agent.tools` 里已经存在的工具 + 自己拼的 `update_plan`，不 import
 *   `@nimbo/virtual-fs`（那会在 core ↔ virtual-fs 之间成环，virtual-fs 的
 *   `createFileTools` 反过来依赖 `@nimbo/core` 的类型）。集成测试改为宿主
 *   姿态：外部调用方自己 `createFileTools({ readState: session.readState, ... })`
 *   再塞进 `agent.tools`——这正是下面 `readState` 要在 `Session` 上对外暴露
 *   一份的原因（结构上与 virtual-fs 的 `ReadStateStore` 兼容，见
 *   `SessionReadState`，不需要跨包导入类型，纯粹靠结构类型兼容）。
 *
 *   这条链路还缺一环："宿主构造的 `createFileTools({ onFileChange })` 怎么让
 *   `write_file` 的变更最终长成一个 `file_change` `SessionItem`？"——派生数据
 *   要落进 `loop.ts` 执行期间读取的**同一个** `DerivedDataCollector`
 *   （`executeToolCall` 的 `derivedData` 选项），而这个收集器是 session 内部
 *   状态，`update_plan` 能这样接是因为 `assembleTools` 在 session 内部就把
 *   `onPlanUpdate` 接上了它；文件工具在 session 外部构造，没有这条内部通路。
 *   因此这里再暴露一份 `derivedData`（`SessionDerivedDataRecorder`，
 *   `DerivedDataCollector` 去掉 `drain` 的窄接口——宿主只应该"上报"，`drain`
 *   是 loop.ts 每次工具调用前后自己的簿记，暴露出去会被宿主意外清空）：宿主把
 *   `onFileChange: (changes) => changes.forEach((c) => session.derivedData.recordFileChange(c))`
 *   接上，就补全了这条链路，不需要 core 认识 virtual-fs 的 `FileChange` 类型
 *   （结构兼容，同 `readState` 的做法）。
 *
 * ---- fs 缺省：不能依赖 @nimbo/virtual-fs（工单原文） ----
 *
 * `SessionOptions.fs` 未注入时不能默认造一个 `MemoryFS`——那需要依赖
 * `@nimbo/virtual-fs`，而 virtual-fs 反过来依赖 `@nimbo/core`（`createFileTools`
 * 的类型来自这里），core 依赖 virtual-fs 会成环。`createUnconfiguredFS()`
 * 因此是一个全方法都会抛指导性错误的占位实现——调用其中任何一个方法都会
 * 得到"注入 fs，或改用 @nimbo/sdk"的错误消息；`@nimbo/sdk` 是允许依赖两者的
 * 门面包，默认 `MemoryFS` 装配归 P7 落在那里。
 *
 * ---- exec/workspace 与 bash 的条件内置（P6-2 施工回填，tech-spec §4.5a） ----
 *
 * `SessionOptions.exec?: NimboExec` 注入才会在 `assembleTools` 里出现内置
 * `bash` 工具——与 `load_skill` 由 `agent.skills` 隐式控制是同一族"条件内置"
 * 机制（`assembleTools` 里 `exec !== undefined` 的分支），只是触发条件是
 * "这次 session 有没有命令执行面"而非"有没有配置 skills"。不注入 `exec` 时
 * 工具列表里没有 `bash`，默认安全不变（spec §4.5a"激活"原文）。
 *
 * `SessionOptions.workspace?: NimboFS & NimboExec` 是"同源工作区"（§4.5a
 * 模式 A）的语法糖——一个对象同时实现两个接口，一次注入替代分别传
 * `{ fs, exec }`。与 `fs`/`exec` 是刻意的**互斥**关系（工单原文"同时提供抛
 * 配置错误"）：`workspace` 已经同时提供了两者，再单独传 `fs` 或 `exec` 要么
 * 是重复（自找麻烦：两个对象容易在宿主后续维护时演化出不一致）要么是矛盾
 * （宿主可能没意识到自己传了两份不同源的 fs/exec），两种情况都值得在
 * `createSession(...)` 调用的当下就同步抛错，而不是放行后留一个"用了 workspace
 * 却又传了别的 fs/exec，实际生效的是哪个"的隐性歧义。判断与报错落在
 * `resolveExecutionSurfaces`。
 *
 * ---- 结构化输出 + 序列化/恢复（P7-2，tech-spec §4.2/§4.8） ----
 *
 * `send<T>(...outputSchema)` 的实际生成逻辑（`generateText`+`Output`+重试）
 * 全部在 `structured.ts`；本文件只做"正常 turn 收尾后要不要多走一轮"的调度
 * （见 `send` 的实现）。
 *
 * `TurnOptions` **不**携带 spec §4.2 字面量 `interface TurnOptions {
 * outputSchema?: z.ZodType; signal?: AbortSignal; }` 里的裸 `outputSchema`
 * 字段——那个字面签名下 `z.ZodType`（不带类型参数）的 Output 落在 zod4 的
 * 默认值 `unknown`，会让 `unknown` 泄漏进公共类型，违反本仓硬性规范。
 * `outputSchema` 只经 `send<T>` 重载的交叉类型 `TurnOptions & { outputSchema:
 * z.ZodType<T> }` 出现（精确到 `T`，无 `unknown`）——这是 spec 同一段落里另一
 * 处已经给出的、类型精确的写法，两处写法本就有一处更精确，选精确的那处。
 *
 * `toJSON({ includeFs })`/`resume` 的 fs 快照能力（`snapshot()`/`restore()`）
 * 走结构类型探测（`hasSnapshotCapability`/`hasRestoreCapability`），不 import
 * `@nimbo/virtual-fs` 的 `MemoryFSSnapshot`/`OverlayFSSnapshot` 类型——理由
 * 同上方"fs 缺省"一节（core 不依赖 virtual-fs）。探测到的方法签名钉死为
 * `snapshot(): JsonValue`/`restore(snapshot: JsonValue): void`——这是我们自己
 * 声明的"期望契约"，不是对真实实现类型的静态验证；真实实现（如 `MemoryFS`）
 * 的具体快照形状是否与之吻合，是运行时的产出/消费两端约定（同一份实现的
 * `snapshot()` 产出恰好是它自己 `restore()` 能吃的形状），类型守卫函数本身
 * 就是"信任声明"，不需要也无法在这里被结构验证（与 `state.ts` 的
 * `isModelMessage` 同款受控模式）。
 *
 * `resume` 经 `sessionStateSchema`（P1-1，`state.ts`）校验；`hasStarted` 的
 * 恢复语义（工单原文"恢复后 session.started 不再重发"，裁量点）：把
 * `hasStarted` 初始化为 `resumedState !== undefined`——即"resume 意味着这个
 * session 之前已经跑过至少一轮"，不区分"resume 的 state 里 turn 是否为 0"这种
 * 边界（`turn: 0` 且仍传了 `resume` 是调用方在传一个从未真正 send 过的
 * `SessionState`，属于误用场景，`hasStarted: true` 在这种误用下的代价——少发一次
 * `session.started`——小于"resume 之后又意外重发一次 `session.started`"的代价，
 * 后者更容易让宿主的事件消费逻辑重复初始化状态。
 */
import { randomUUID } from "node:crypto";
import type { FilePart, LanguageModel, ModelMessage, TextPart, UserModelMessage } from "ai";
import type { z } from "zod";
import type { AgentDefinition, BuiltinToolName } from "./agent.js";
import { createOnceApprovalMemory } from "./approval.js";
import { runTurn } from "./loop.js";
import { createDerivedDataCollector } from "./runtime.js";
import type { DerivedDataCollector } from "./runtime.js";
import type { Skill } from "./skill.js";
import { buildAvailableSkillsBlock, createGetSkill, mountSkillFiles } from "./skills/registry.js";
import { sessionStateSchema } from "./state.js";
import type { SessionState } from "./state.js";
import { generateStructuredOutput } from "./structured.js";
import { createBashTool } from "./tools/builtin/bash.js";
import { createLoadSkillTool } from "./tools/builtin/load-skill.js";
import { createPlanStore, createUpdatePlanTool } from "./tools/builtin/update-plan.js";
import type { PlanStore } from "./tools/builtin/update-plan.js";
import { jsonValueSchema } from "./types.js";
import type { ApprovalPolicy, DirEntry, FileStat, JsonValue, NimboExec, NimboFS, Tool } from "./types.js";
import type { NimboError, SessionEvent, SessionItem, Usage } from "./events.js";

// ---- Input / InputBlock（tech-spec §4.2） ----

export type InputBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string | Uint8Array; mediaType: string };

export type Input = string | InputBlock[];

// ---- TurnOptions / TurnResult（tech-spec §4.2；outputSchema 见本文件头"结构化输出"一节） ----

export interface TurnOptions {
  signal?: AbortSignal;
}

export interface TurnResult {
  items: SessionItem[];
  finalResponse: string;
  usage: Usage;
}

/**
 * session 范围的"路径 → 上次读取版本"存储；get/set 形状与
 * `@nimbo/virtual-fs` 的 `ReadStateStore` 结构兼容（version = `stat().mtime`），
 * 结构类型兼容即可互操作，不需要跨包 import 类型（core 不依赖 virtual-fs，
 * 理由见本文件头）。八件套文件工具落地前（P7），这里只是把存储的所有权放在
 * session 里、并对外暴露，供宿主/集成测试把它接给外部构造的 `createFileTools`。
 */
export interface SessionReadState {
  get(path: string): number | undefined;
  set(path: string, version: number): void;
}

/** `SessionReadState` 的便利默认实现，纯内存 `Map`——见下方 `SessionOptions.readState`。 */
export function createSessionReadState(): SessionReadState {
  const versions = new Map<string, number>();
  return {
    get: (path) => versions.get(path),
    set: (path, version) => {
      versions.set(path, version);
    },
  };
}

// ---- SessionOptions（tech-spec §4.2；exec/workspace 见下方字段注释） ----

export interface SessionOptions {
  fs?: NimboFS;
  /** 注入即激活内置 `bash` 工具（§4.5a）；与 `workspace` 互斥，理由见本文件头。 */
  exec?: NimboExec;
  /** 语法糖：同源工作区一次注入 fs + exec（§4.5a 模式 A）；与 `fs`/`exec` 互斥，理由见本文件头。 */
  workspace?: NimboFS & NimboExec;
  onApproval?: ApprovalPolicy;
  /** 在 agent 定义的 instructions 之上追加（§4.2，多租户注入场景）。 */
  instructions?: { append: string };
  /**
   * 反序列化恢复（§4.2 `resume?: SessionState` 原文；P7-2 落地，见本文件头
   * "结构化输出 + 序列化/恢复"一节）。经 `sessionStateSchema` 校验后恢复
   * `id`/`turn`/`messages`/`createdAt`；`fsSnapshot` 存在时经结构探测调用
   * `fs.restore(...)`——因此 `resume` 里带 `fsSnapshot` 时必须同时注入一个支持
   * `restore()` 的 `fs`（如 `@nimbo/virtual-fs` 的 `MemoryFS`/`OverlayFS`），
   * 否则抛指导性错误。
   */
  resume?: SessionState;
  /**
   * 装配顺序缺口的修补（P4-2 施工发现，工单原文只点名 fs/onApproval/instructions
   * 三个字段——这里是在集成测试落地时暴露的必要补充，理由见下）：
   *
   * `agent.tools`（含依赖 `readState`/`derivedData` 的外部工具，如
   * `@nimbo/virtual-fs` 的 `createFileTools`）在 `createSession(agent, opts)`
   * 调用时就被读取、冻结进闭包（`assembleTools`），但 `session.readState`/
   * `session.derivedData` 只有 session **构造完成后**才存在——宿主没有办法
   * "先拿到 session 的 store，再把它塞进 agent.tools，再传回 createSession"，
   * 这是一个先有鸡还是先有蛋的顺序问题。修法是允许宿主**预先构造**这两个
   * store（`createSessionReadState()` / `createDerivedDataCollector()`，均已
   * 导出）、传给 `createFileTools(...)`拼工具、再把同一份 store 经这里注入
   * `createSession`——session 使用注入的实例（而不是自己另起一份），
   * `session.readState`/`session.derivedData` 对外暴露的还是这同一个对象。
   * 未注入时行为不变（session 自己创建一份），因此是纯新增、向后兼容的扩展。
   */
  readState?: SessionReadState;
  /** 同上，用于外部工具的派生数据（`file_change`/`plan_update`）上报通道。 */
  derivedData?: DerivedDataCollector;
}

/**
 * `DerivedDataCollector` 去掉 `drain`——宿主/外部构造的工具只应该"上报"派生
 * 数据（如 `createFileTools` 的 `onFileChange`），`drain` 是 `loop.ts` 每次
 * 工具调用前后自己的簿记，不对外暴露（见本文件头"这条链路还缺一环"一节）。
 */
export type SessionDerivedDataRecorder = Pick<DerivedDataCollector, "recordFileChange" | "recordPlanUpdate">;

// ---- Session（tech-spec §4.2） ----

export interface Session {
  readonly id: string;
  readonly fs: NimboFS;
  /** 见上方 `SessionReadState` 注释：本工单范围内的接缝，非 spec §4.2 原文字段。 */
  readonly readState: SessionReadState;
  /** 见上方"这条链路还缺一环"注释：同为本工单范围内的接缝，非 spec §4.2 原文字段。 */
  readonly derivedData: SessionDerivedDataRecorder;
  send(input: Input, opts?: TurnOptions): Promise<TurnResult>;
  /** 结构化输出（§4.8；实现见本文件头"结构化输出"一节 / `structured.ts`）。 */
  send<T>(input: Input, opts: TurnOptions & { outputSchema: z.ZodType<T> }): Promise<TurnResult & { structuredOutput: T }>;
  stream(input: Input, opts?: TurnOptions): AsyncGenerator<SessionEvent, TurnResult>;
  /** 会话恢复用的可序列化快照（§4.2/§4.8；`includeFs` 见本文件头"结构化输出 + 序列化/恢复"一节）。 */
  toJSON(opts?: { includeFs?: boolean }): SessionState;
}

/**
 * `turn.failed` 时 `send()` 抛出的错误（§4.2"send() 在 stream() 之上实现——
 * turn.failed 时 throw"）。`code` 直接携带 `NimboError.code`，`message` 走
 * `Error` 的标准通道——调用方可以 `error instanceof NimboSessionError` 收窄，
 * 不需要在 `catch` 里对 `unknown` 做字段猜测。
 */
export class NimboSessionError extends Error {
  readonly code: NimboError["code"];

  constructor(error: NimboError) {
    super(error.message);
    this.name = "NimboSessionError";
    this.code = error.code;
  }
}

const FS_NOT_CONFIGURED_MESSAGE =
  "This session has no NimboFS injected (SessionOptions.fs). Either pass { fs } to createSession(...), " +
  "or use @nimbo/sdk's session factory, which wires up a default MemoryFS for you.";

/**
 * 每个方法都签了 `Promise<T>` 的返回类型（`NimboFS` 接口原文）——调用方合理预期
 * 失败以**拒绝的 promise**到达（可 `.catch()`/`await` 吞掉），而不是同步 throw
 * 炸穿调用栈。`fail<T>()` 因此返回 `Promise.reject(...)`，不是同步抛错。
 */
function fail<T>(): Promise<T> {
  return Promise.reject(new Error(FS_NOT_CONFIGURED_MESSAGE));
}

/** 占位 `NimboFS`：任何方法调用都以拒绝的 promise 给出指导性错误，理由见本文件头"fs 缺省"一节。 */
function createUnconfiguredFS(): NimboFS {
  return {
    readFile: (): Promise<Uint8Array> => fail(),
    writeFile: (): Promise<void> => fail(),
    rm: (): Promise<void> => fail(),
    mkdir: (): Promise<void> => fail(),
    readdir: (): Promise<DirEntry[]> => fail(),
    stat: (): Promise<FileStat> => fail(),
    glob: (): Promise<string[]> => fail(),
  };
}

/**
 * P5 补充：`agent.skills` 非空时在 instructions 之后追加 `<available_skills>`
 * 段（tech-spec §4.6 第 1 点）。拼装顺序是"人写的 instructions 在前、skills 元
 * 数据在后"——后者是运行时派生的补充信息，不是 instructions 本文的一部分。
 */
function buildSystemPrompt(agent: AgentDefinition, opts: SessionOptions): string | undefined {
  const base = agent.instructions;
  const append = opts.instructions?.append;
  const instructions = base === undefined ? append : append === undefined ? base : `${base}\n\n${append}`;

  const skillsBlock = buildAvailableSkillsBlock(agent.skills ?? []);
  if (skillsBlock === undefined) return instructions;
  return instructions === undefined ? skillsBlock : `${instructions}\n\n${skillsBlock}`;
}

/**
 * `InputBlock`'s `image` variant maps onto AI SDK's `FilePart` with `mediaType`, not the
 * `ImagePart` type its field names (`data`/`mediaType`) otherwise resemble — `ImagePart` is
 * `@deprecated` in `ai@7` (superseded by `FilePart` with an image `mediaType`), and using it
 * emits a runtime deprecation warning on every image turn. `FilePart.data` accepts a bare
 * `DataContent` (`string | Uint8Array | ...`), which `InputBlock`'s `data` field already is.
 */
function toUserModelMessage(input: Input): UserModelMessage {
  if (typeof input === "string") return { role: "user", content: input };
  return {
    role: "user",
    content: input.map((block): TextPart | FilePart =>
      block.type === "text" ? { type: "text", text: block.text } : { type: "file", data: block.data, mediaType: block.mediaType },
    ),
  };
}

/** `builtinTools` 是否包含 `update_plan`（默认全开；`false` 全关；数组按成员判断）。 */
function isUpdatePlanEnabled(builtinTools: BuiltinToolName[] | false | undefined): boolean {
  if (builtinTools === false) return false;
  if (builtinTools === undefined) return true;
  return builtinTools.includes("update_plan");
}

/**
 * `load_skill` 是条件内置（04-builtin-tools.md §1.9 / §3 括注）：不经
 * `builtinTools` 裁剪，只看 `agent.skills` 是否配置了至少一个 skill——与
 * `bash` 由 `NimboExec` 注入触发是同一族"条件内置"机制，但触发条件各自独立。
 */
function isLoadSkillEnabled(skills: Skill[] | undefined): boolean {
  return skills !== undefined && skills.length > 0;
}

/**
 * `agent.tools` + core 自带的内置工具（`update_plan` 恒定、`load_skill`/
 * `bash` 条件内置，文件工具八件套归 P7）。宿主同名工具覆盖内置实现
 * （04-builtin-tools.md §3），因此展开顺序是内置在前、`agent.tools` 在后。
 */
function assembleTools(agent: AgentDefinition, planStore: PlanStore, derivedData: DerivedDataCollector, exec: NimboExec | undefined): Record<string, Tool> {
  const builtins: Record<string, Tool> = {};
  if (isUpdatePlanEnabled(agent.builtinTools)) {
    builtins.update_plan = createUpdatePlanTool({
      store: planStore,
      onPlanUpdate: (items) => derivedData.recordPlanUpdate(items),
    });
  }
  if (isLoadSkillEnabled(agent.skills)) {
    builtins.load_skill = createLoadSkillTool({ skills: agent.skills ?? [] });
  }
  if (exec !== undefined) {
    builtins.bash = createBashTool({ exec });
  }
  return { ...builtins, ...(agent.tools ?? {}) };
}

const WORKSPACE_EXCLUSIVITY_MESSAGE =
  "SessionOptions.workspace is mutually exclusive with fs/exec — workspace (NimboFS & NimboExec) already " +
  "provides both from a single same-source object (tech-spec §4.5a mode A). Pass either { workspace } alone, " +
  "or { fs, exec } (either or both) without workspace — mixing the two leaves it ambiguous which fs/exec " +
  "actually took effect.";

/**
 * `fs`/`exec`/`workspace` 的互斥求解（工单 2："workspace...与 fs/exec 互斥
 * ——同时提供抛配置错误"）。同步抛错而非返回错误值——这是一次性的、纯静态的
 * 装配期误用（不依赖任何 I/O 时机判定），与 `createUnconfiguredFS()` 那种
 * "延迟到实际调用才知道错在哪"的场景不同，值得在 `createSession(...)` 调用的
 * 当下立刻失败。
 */
function resolveExecutionSurfaces(opts: SessionOptions): { fs: NimboFS; exec: NimboExec | undefined } {
  if (opts.workspace !== undefined && (opts.fs !== undefined || opts.exec !== undefined)) {
    throw new Error(WORKSPACE_EXCLUSIVITY_MESSAGE);
  }
  const fs = opts.fs ?? opts.workspace ?? createUnconfiguredFS();
  const exec = opts.exec ?? opts.workspace;
  return { fs, exec };
}

// ---- toJSON/resume 的 fs 快照能力结构探测（本文件头"结构化输出 + 序列化/恢复"一节） ----

interface FSSnapshotCapable {
  snapshot(): JsonValue;
}

/** 类型守卫（非结构验证，是信任声明）：探测 `fs` 是否有 `snapshot()`，理由见本文件头。 */
function hasSnapshotCapability(candidate: NimboFS): candidate is NimboFS & FSSnapshotCapable {
  return "snapshot" in candidate && typeof candidate.snapshot === "function";
}

interface FSRestorable {
  restore(snapshot: JsonValue): void;
}

/** 同上，探测 `restore()`。 */
function hasRestoreCapability(candidate: NimboFS): candidate is NimboFS & FSRestorable {
  return "restore" in candidate && typeof candidate.restore === "function";
}

/**
 * `fs.snapshot()` 只是"结构上像 JsonValue"的信任声明（`FSSnapshotCapable`），不是
 * 运行时保证——施工中实测发现 `@nimbo/virtual-fs` 的 `MemoryFS.snapshot()` 会在
 * 从未设置过 mimeType 的文件条目上留一个显式 `mimeType: undefined` 键（不是
 * 键缺失，是键存在、值为 `undefined`），这精确地落在 `jsonValueSchema` 的
 * `z.record` 拒绝范围内（`undefined` 不是合法 JSON 值），即便 `JSON.stringify`
 * 会默默丢掉这个键。这是 virtual-fs／state.ts 两侧既有实现之间的一个真实接缝
 * gap，但两个文件都不在本工单改动范围内（virtual-fs 是另一个包；state.ts 不在
 * 工单文件清单里）——因此在 `toJSON()` 自己的信任边界上做防御性规整：真的过一遍
 * `JSON.stringify`/`JSON.parse`（正是 `SessionState` 打算被持久化时会经历的
 * 编解码），再交给已导出的 `jsonValueSchema` 收窄回精确类型（同 `model/step.ts`
 * `toJsonValue()` 的既有 `unknown → JsonValue` 收窄写法，`JSON.parse` 的 `any`
 * 结果从不被赋给具名变量，只作为 `.parse()` 的实参一次性经过）。
 */
function toCleanJsonValue(value: JsonValue): JsonValue {
  return jsonValueSchema.parse(JSON.parse(JSON.stringify(value)));
}

const FS_SNAPSHOT_NOT_SUPPORTED_MESSAGE =
  "toJSON({ includeFs: true }) requires a NimboFS that implements snapshot() (e.g. @nimbo/virtual-fs's " +
  "MemoryFS/OverlayFS) — this session's fs does not expose one. Inject a snapshot-capable fs, or call " +
  "toJSON() without includeFs.";

const FS_RESTORE_NOT_SUPPORTED_MESSAGE =
  "SessionOptions.resume includes fsSnapshot, but this session's fs does not implement restore() (e.g. " +
  "@nimbo/virtual-fs's MemoryFS/OverlayFS do) — inject a matching fs, or resume from a SessionState " +
  "without fsSnapshot.";

/**
 * `resume` 经 `sessionStateSchema` 校验（P1-1）——同步抛错，理由同
 * `resolveExecutionSurfaces`：一次性的、纯静态的装配期输入校验，值得在
 * `createSession(...)` 调用的当下立刻失败，不留到后续某次 `send()`/`stream()`
 * 才暴露"resume 的数据其实是坏的"。
 */
function resolveResumedState(resume: SessionState | undefined): SessionState | undefined {
  if (resume === undefined) return undefined;
  const parsed = sessionStateSchema.safeParse(resume);
  if (!parsed.success) {
    throw new Error(
      `SessionOptions.resume failed sessionStateSchema validation — pass a SessionState produced by ` +
        `Session.toJSON(...), not an arbitrary object. Zod error: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

export function createSession(agent: AgentDefinition, opts: SessionOptions = {}): Session {
  const resumedState = resolveResumedState(opts.resume);
  const id = resumedState?.id ?? randomUUID();
  const createdAt = resumedState?.createdAt ?? Date.now();
  const { fs, exec } = resolveExecutionSurfaces(opts);
  if (resumedState?.fsSnapshot !== undefined) {
    if (!hasRestoreCapability(fs)) throw new Error(FS_RESTORE_NOT_SUPPORTED_MESSAGE);
    fs.restore(resumedState.fsSnapshot);
  }
  const system = buildSystemPrompt(agent, opts);
  const model: LanguageModel = agent.model;
  const maxTurnsPerRun = agent.maxTurnsPerRun ?? 40;
  const maxContextTokens = agent.maxContextTokens;
  const maxOutputTokens = agent.maxOutputTokens;

  const messages: ModelMessage[] = resumedState !== undefined ? [...resumedState.messages] : [];
  const readState = opts.readState ?? createSessionReadState();
  const onceMemory = createOnceApprovalMemory();
  const derivedData = opts.derivedData ?? createDerivedDataCollector();
  const planStore = createPlanStore();
  const tools = assembleTools(agent, planStore, derivedData, exec);
  const getSkill = createGetSkill(agent.skills ?? []);
  /**
   * P5：附属文件挂载"createSession 时"触发（tech-spec §4.6 第 3 点原文）——
   * `mountSkillFiles(...)` 在这里被调用（不是等到第一次 `stream()`），只是它的
   * 完成（`await`）挪到 `stream()` 顶部，理由是 `createSession` 本身是同步函数、
   * 不能在这里 `await` 一个可能真异步的 `NimboFS.writeFile`（真实沙盒实现）；
   * 挪到 `stream()` 顶部仍能保证"任何工具真正执行前挂载已完成"，同时不需要
   * `createSession` 变成 `Promise<Session>`（会是破坏性的签名变更）。
   */
  const skillFilesMounted = mountSkillFiles(fs, agent.skills ?? []);

  let turn = resumedState?.turn ?? 0;
  /**
   * resume 后不再重发 `session.started`（工单原文；裁量理由见本文件头
   * "结构化输出 + 序列化/恢复"一节）。
   */
  let hasStarted = resumedState !== undefined;

  async function* stream(input: Input, turnOpts: TurnOptions = {}): AsyncGenerator<SessionEvent, TurnResult> {
    await skillFilesMounted;

    turn += 1;
    if (!hasStarted) {
      hasStarted = true;
      yield { type: "session.started", sessionId: id };
    }
    yield { type: "turn.started", turn };

    messages.push(toUserModelMessage(input));

    return yield* runTurn({
      model,
      system,
      messages,
      tools,
      maxTurnsPerRun,
      maxContextTokens,
      maxOutputTokens,
      fs,
      session: { id, turn },
      signal: turnOpts.signal,
      onApproval: opts.onApproval,
      onceMemory,
      derivedData,
      getSkill,
    });
  }

  async function send(input: Input, turnOpts?: TurnOptions): Promise<TurnResult>;
  async function send<T>(
    input: Input,
    turnOpts: TurnOptions & { outputSchema: z.ZodType<T> },
  ): Promise<TurnResult & { structuredOutput: T }>;
  async function send<T>(
    input: Input,
    turnOpts: TurnOptions & { outputSchema?: z.ZodType<T> } = {},
  ): Promise<TurnResult | (TurnResult & { structuredOutput: T })> {
    const gen = stream(input, turnOpts);
    let failure: NimboError | undefined;
    let step = await gen.next();
    while (!step.done) {
      if (step.value.type === "turn.failed") failure = step.value.error;
      step = await gen.next();
    }
    if (failure !== undefined) throw new NimboSessionError(failure);

    const turnResult = step.value;
    if (turnOpts.outputSchema === undefined) return turnResult;

    const structuredOutput = await generateStructuredOutput({
      model,
      system,
      messages,
      outputSchema: turnOpts.outputSchema,
      maxOutputTokens,
      signal: turnOpts.signal,
    });
    return { ...turnResult, structuredOutput };
  }

  function toJSON(toJSONOpts: { includeFs?: boolean } = {}): SessionState {
    const state: SessionState = { id, turn, messages: [...messages], createdAt };
    if (toJSONOpts.includeFs === true) {
      if (!hasSnapshotCapability(fs)) throw new Error(FS_SNAPSHOT_NOT_SUPPORTED_MESSAGE);
      state.fsSnapshot = toCleanJsonValue(fs.snapshot());
    }
    return state;
  }

  return { id, fs, readState, derivedData, send, stream, toJSON };
}
