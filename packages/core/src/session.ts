/**
 * L2 运行层：`createSession`/`Session`（docs/logic/engine/tech/core-sdk.md §4.2 全节 / §4.8 终止与恢复
 * 边界）。持有一个会话跨 turn 的全部持久状态，把"给定状态跑一个 turn"的活
 * 委派给 `loop.ts` 的 `runTurn`——本文件只做状态的所有权与生命周期、输入/
 * 输出的组装、以及 `send()` 相对 `stream()` 的缓冲语义。
 *
 * ## 一条贯穿全文件的约束：core 不许依赖 `@runko/virtual-fs`
 *
 * 会成环——virtual-fs 的 `createFileTools` 反过来依赖 `@runko/core` 的类型。由此推出本文件
 * 好几处看起来绕的写法：
 *
 * - **`fs` 没注入时不默认造一个 `MemoryFS`**，而是给一个全方法都抛指导性错误的占位实现
 *   （`createUnconfiguredFS()`）：错误消息会告诉你「注入 fs，或改用 `@runko/sdk`」。
 *   `@runko/sdk` 是允许同时依赖两者的门面包，默认装配归它。
 * - **文件工具八件套不在这里实例化**，由宿主自己 `createFileTools(...)` 再塞进 `agent.tools`。
 * - `Session` 因此要对外暴露两样东西，好让宿主把那套外部构造的工具接回来：
 *   - `readState`（`SessionReadState`）——与 virtual-fs 的 `ReadStateStore` **结构兼容**，
 *     不跨包导入类型；
 *   - `derivedData`（`SessionDerivedDataRecorder`）——宿主把
 *     `onFileChange: (changes) => changes.forEach((c) => session.derivedData.recordFileChange(c))`
 *     接上，文件变更才能进到 `loop.ts` 执行期间读的**同一个**收集器里。
 *     它刻意是 `DerivedDataCollector` **去掉 `drain` 的窄接口**：宿主只该「上报」，而 `drain`
 *     是 loop 每次工具调用前后自己的簿记，暴露出去会被宿主意外清空。
 * - `toJSON({ includeFs })` / `resume` 的 fs 快照能力走**结构探测**
 *   （`hasSnapshotCapability` / `hasRestoreCapability`），不导入 virtual-fs 的快照类型。
 *   探测到的签名钉死成 `snapshot(): JsonValue` / `restore(snapshot: JsonValue): void`
 *   ——这是我们声明的**期望契约**，不是对真实实现的静态验证。快照的具体形状由产出、消费
 *   两端在运行时约定（同一份实现的 `snapshot()` 产出恰好是它自己 `restore()` 吃得下的）。
 *
 * ## 条件内置：注入了执行面才有 `bash`
 *
 * `SessionOptions.exec` 注入了，`assembleTools` 才会装内置 `bash`——与 `load-skill` 由
 * `agent.skills` 隐式控制是同一族机制。不注入就没有 `bash`，默认安全。
 *
 * `workspace`（一个对象同时实现 `RunkoFS & RunkoExec`）是「同源工作区」的语法糖，与
 * `fs` / `exec` **互斥**：同时传会在 `createSession(...)` 当场抛错（`resolveExecutionSurfaces`）。
 * 不这么做的话会留下「用了 workspace 又传了别的 fs，实际生效的是哪个」这种隐性歧义。
 *
 * ## `outputSchema` 只走 `send<T>` 重载，不进 `TurnOptions`
 *
 * 裸写 `outputSchema?: z.ZodType` 的话，不带类型参数的 `z.ZodType` 在 zod4 下 Output 落成
 * `unknown`，会把 `unknown` 泄漏进公共类型——本仓硬性规范不允许。只经交叉类型
 * `TurnOptions & { outputSchema: z.ZodType<T> }` 出现，精确到 `T`。
 *
 * 生成逻辑（`generateText` + `Output` + 重试）全在 `structured.ts`，本文件只调度「正常 turn
 * 收尾后要不要多走一轮」。
 *
 * ## `resume` 的深层校验是**异步**的，会推迟到第一次 `stream()` / `send()`
 *
 * `sessionStateSchema` 只做浅层结构校验；深层语义校验走 `validateSessionMessages()`
 * （底下是 ai 官方的 `validateUIMessages()`，天生异步），在同步的 `createSession` 里跑不完。
 *
 * 做法是同步发起、不 await：`messages` 先用浅层校验通过的原始账本 scaffold，
 * `stream()` / `send()` 顶部再 `await` 校验结果、用规范化过的账本整体替换。这保证了
 * **任何工具真正执行前、任何 `convertToModelMessages()` 调用前，账本已经过深层校验**。
 *
 * ⚠️ 代价是：「结构合法但深层语义不合法」这类错误**不在 `createSession(...)` 当场抛**，
 * 而是推迟到第一次 `stream()` / `send()` 才 reject。想让它当场抛，就得把 `createSession`
 * 改成异步——那是破坏性签名变更。
 */
import { randomUUID } from "node:crypto";
import { convertToModelMessages } from "ai";
import type { FileUIPart, LanguageModel, TextUIPart } from "ai";
import type { z } from "zod";
import type { AgentDefinition, BuiltinToolName } from "./agent.js";
import { createOnceApprovalMemory } from "./approval.js";
import { runTurn } from "./loop.js";
import type { SessionTelemetry } from "./loop.js";
import { createDerivedDataCollector } from "./runtime.js";
import type { DerivedDataCollector } from "./runtime.js";
import type { Skill } from "./skill.js";
import { buildAvailableSkillsBlock, createGetSkill, mountSkillFiles } from "./skills/registry.js";
import { sessionStateSchema, validateSessionMessages } from "./state.js";
import type { RunkoChunk, RunkoMessageMetadata, RunkoUIMessage, SessionState } from "./state.js";
import { generateStructuredOutput } from "./structured.js";
import { createBashTool } from "./tools/builtin/bash.js";
import { createLoadSkillTool } from "./tools/builtin/load-skill.js";
import { createPlanStore, createUpdatePlanTool } from "./tools/builtin/update-plan.js";
import type { PlanStore } from "./tools/builtin/update-plan.js";
import { jsonValueSchema } from "./types.js";
import type {
  ActivitySignal,
  ApprovalPolicy,
  ApprovalReviewer,
  DirEntry,
  FileStat,
  JsonValue,
  RunkoActivityAware,
  RunkoExec,
  RunkoFS,
  Tool,
} from "./types.js";
import type { RunkoError, Usage } from "./events.js";

// ---- Input / InputBlock（docs/logic/engine/tech/core-sdk.md §4.2） ----

export type InputBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string | Uint8Array; mediaType: string };

export type Input = string | InputBlock[];

// ---- TurnOptions / TurnResult（docs/logic/engine/tech/core-sdk.md §4.2；outputSchema 见本文件头"结构化输出"一节） ----

export interface TurnOptions {
  signal?: AbortSignal;
}

/**
 * 「这个 turn 发生了什么」直接读账本本身（`Session.toJSON().messages` 的部件与 metadata），
 * 没有一份平行的清单。
 *
 * `finalResponse` = 该轮最后一次产出非空文本的 assistant 消息里全部 `text` 部件拼接
 * （`loop.ts` 的 `collectMessageText`）；`usage` 是该轮累计 token 用量。
 */
export interface TurnResult {
  finalResponse: string;
  usage: Usage;
}

/**
 * session 范围的"路径 → 上次读取版本"存储；get/set 形状与
 * `@runko/virtual-fs` 的 `ReadStateStore` 结构兼容（version = `stat().mtime`），
 * 结构类型兼容即可互操作，不需要跨包 import 类型（core 不依赖 virtual-fs，
 * 理由见本文件头）。这里只是把存储的所有权放在
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

// ---- SessionOptions（docs/logic/engine/tech/core-sdk.md §4.2；exec/workspace 见下方字段注释） ----

export interface SessionOptions {
  fs?: RunkoFS;
  /** 注入即激活内置 `bash` 工具（§4.5a）；与 `workspace` 互斥，理由见本文件头。 */
  exec?: RunkoExec;
  /** 语法糖：同源工作区一次注入 fs + exec（§4.5a 模式 A）；与 `fs`/`exec` 互斥，理由见本文件头。 */
  workspace?: RunkoFS & RunkoExec;
  /** 审批分类器（docs/logic/orchestration/tech/single-ledger.md §6.2，取代旧的 `shouldAutoAllow`）——per-tool 升级到这里的兜底判定，见 `@runko/core/approval.js` 头注释。 */
  onApproval?: ApprovalPolicy;
  /**
   * 人审通道（`ApprovalReviewer`，见 `types.ts`）：
   * `evaluateApproval` 解析出 `review` 后，`loop.ts` 先 yield
   * `tool-approval-request` chunk 再 `await` 这个函数拿到人工裁决——与
   * `onApproval`（同步的三值分类）是两个独立的注入点。未注入时 `review`
   * 视同无仲裁者 deny（附指导文案）。
   */
  onReview?: ApprovalReviewer;
  /** 在 agent 定义的 instructions 之上追加（§4.2，多租户注入场景）。 */
  instructions?: { append: string };
  /**
   * 反序列化恢复。经 `sessionStateSchema` 校验后恢复
   * `id`/`turn`/`messages`/`createdAt`；`fsSnapshot` 存在时经结构探测调用
   * `fs.restore(...)`——因此 `resume` 里带 `fsSnapshot` 时必须同时注入一个支持
   * `restore()` 的 `fs`（如 `@runko/virtual-fs` 的 `MemoryFS`/`OverlayFS`），
   * 否则抛指导性错误。
   */
  resume?: SessionState;
  /**
   * 装配顺序缺口的修补：
   *
   * `agent.tools`（含依赖 `readState`/`derivedData` 的外部工具，如
   * `@runko/virtual-fs` 的 `createFileTools`）在 `createSession(agent, opts)`
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
  /**
   * telemetry 事件集成透传（`SessionTelemetry`，loop.ts）：注入后每次
   * `streamText` 的生命周期事件（step/model call 的 usage、performance 等）
   * 发给这些集成，事件自带 `functionId = "<sessionId>#<turn>"` 关联键。
   * 不注入 = 无事件（loop 只留 functionId 元数据，零开销）。
   */
  telemetry?: SessionTelemetry;
}

/**
 * `DerivedDataCollector` 去掉 `drain`——宿主/外部构造的工具只应该"上报"派生
 * 数据（如 `createFileTools` 的 `onFileChange`），`drain` 是 `loop.ts` 每次
 * 工具调用前后自己的簿记，不对外暴露（见本文件头"这条链路还缺一环"一节）。
 */
export type SessionDerivedDataRecorder = Pick<DerivedDataCollector, "recordFileChange" | "recordPlanUpdate">;

// ---- Session（docs/logic/engine/tech/core-sdk.md §4.2） ----

export interface Session {
  readonly id: string;
  readonly fs: RunkoFS;
  /** 给宿主接外部构造的文件工具用，见文件头。 */
  readonly readState: SessionReadState;
  /** 同上：宿主把工具的 `onFileChange` 接到这里，派生数据才进得了 loop。 */
  readonly derivedData: SessionDerivedDataRecorder;
  send(input: Input, opts?: TurnOptions): Promise<TurnResult>;
  /** 结构化输出（§4.8；实现见本文件头"结构化输出"一节 / `structured.ts`）。 */
  send<T>(input: Input, opts: TurnOptions & { outputSchema: z.ZodType<T> }): Promise<TurnResult & { structuredOutput: T }>;
  /** ai 的 UIMessageChunk 词汇表（对 `RunkoUIMessage` 实例化，`state.ts` 的 `RunkoChunk`）——任何 AI SDK 兼容客户端可直接消费（docs/logic/orchestration/tech/single-ledger.md §5 单-2 目标架构 2）。 */
  stream(input: Input, opts?: TurnOptions): AsyncGenerator<RunkoChunk, TurnResult>;
  /**
   * 软 steer（STEER-1，docs/logic/engine/tech/core-sdk.md §4.2）：turn 进行中调用则把 `input` 排队、在
   * 下一个 step checkpoint 注入为一条 user 消息（不打断进行中的模型流式输出
   * 或工具执行）并返回 `true`；没有进行中的 turn（尚未 `send`/`stream`，或上
   * 一个 turn 已经收尾）返回 `false`——调用方此时应改用 `send`/`stream` 发起
   * 新的一轮。队列是 turn 作用域：turn 结束（正常收尾或抛错）时清空残留。
   */
  steer(input: Input): boolean;
  /** 会话恢复用的可序列化快照（§4.2/§4.8；`includeFs` 见本文件头"结构化输出 + 序列化/恢复"一节）。 */
  toJSON(opts?: { includeFs?: boolean }): SessionState;
}

/**
 * `turn.failed` 时 `send()` 抛出的错误（§4.2"send() 在 stream() 之上实现——
 * turn.failed 时 throw"）。`code` 直接携带 `RunkoError.code`，`message` 走
 * `Error` 的标准通道——调用方可以 `error instanceof RunkoSessionError` 收窄，
 * 不需要在 `catch` 里对 `unknown` 做字段猜测。
 */
export class RunkoSessionError extends Error {
  readonly code: RunkoError["code"];

  constructor(error: RunkoError) {
    super(error.message);
    this.name = "RunkoSessionError";
    this.code = error.code;
  }
}

const FS_NOT_CONFIGURED_MESSAGE =
  "This session has no RunkoFS injected (SessionOptions.fs). Either pass { fs } to createSession(...), " +
  "or use @runko/sdk's session factory, which wires up a default MemoryFS for you.";

/**
 * 每个方法都签了 `Promise<T>` 的返回类型（`RunkoFS` 接口原文）——调用方合理预期
 * 失败以**拒绝的 promise**到达（可 `.catch()`/`await` 吞掉），而不是同步 throw
 * 炸穿调用栈。`fail<T>()` 因此返回 `Promise.reject(...)`，不是同步抛错。
 */
function fail<T>(): Promise<T> {
  return Promise.reject(new Error(FS_NOT_CONFIGURED_MESSAGE));
}

/** 占位 `RunkoFS`：任何方法调用都以拒绝的 promise 给出指导性错误，理由见本文件头"fs 缺省"一节。 */
function createUnconfiguredFS(): RunkoFS {
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
 * `agent.skills` 非空时在 instructions 之后追加 `<available_skills>`
 * 段（docs/logic/engine/tech/core-sdk.md §4.6 第 1 点）。拼装顺序是"人写的 instructions 在前、skills 元
 * 数据在后"——后者是运行时派生的补充信息，不是 instructions 本文的一部分。
 */
function buildSystemPrompt(agent: AgentDefinition, opts: SessionOptions): string | undefined {
  const base = agent.instructions;
  const append = opts.instructions?.append;
  const instructions = base === undefined ? append : append === undefined ? base : `${base}\n\n${append}`;

  const skillsBlock = buildAvailableSkillsBlock(agent.skills ?? []);
  if (skillsBlock === undefined) {return instructions;}
  return instructions === undefined ? skillsBlock : `${instructions}\n\n${skillsBlock}`;
}

/**
 * `InputBlock` 的 `image` 落到 UIMessage 的 `FileUIPart` 上。
 *
 * **`FileUIPart.url` 永远是个 URL 字符串**（内联字节就是 `data:` URL），不像
 * `ModelMessage` 的 `FilePart` 直接收 `DataContent`。`convertToModelMessages()` 会把它转回
 * `FilePart`（`data: { type: 'url', url: new URL(part.url) }`）再交给模型——对着 `ai@7.0.20`
 * 的转换源码核过。
 *
 * `data` 是 `string` 时**当作已经是 base64**（沿用 `DataContent` 的既有约定）；是
 * `Uint8Array` 就在这里编码。
 */
function toUserUIMessagePart(block: InputBlock): TextUIPart | FileUIPart {
  if (block.type === "text") {return { type: "text", text: block.text };}
  const base64 = typeof block.data === "string" ? block.data : Buffer.from(block.data).toString("base64");
  return { type: "file", mediaType: block.mediaType, url: `data:${block.mediaType};base64,${base64}` };
}

/** `Input` → 一条 user `RunkoUIMessage`——初始 turn 输入与 steer 插话共用（`metadata` 由调用方决定，steer 传 `{steered:true}`）。 */
function toUserUIMessage(input: Input, metadata?: RunkoMessageMetadata): RunkoUIMessage {
  const parts: (TextUIPart | FileUIPart)[] = typeof input === "string" ? [{ type: "text", text: input }] : input.map(toUserUIMessagePart);
  return { id: randomUUID(), role: "user", parts, metadata };
}

/** `builtinTools` 是否包含 `update-plan`（默认全开；`false` 全关；数组按成员判断）。 */
function isUpdatePlanEnabled(builtinTools: BuiltinToolName[] | false | undefined): boolean {
  if (builtinTools === false) {return false;}
  if (builtinTools === undefined) {return true;}
  return builtinTools.includes("update-plan");
}

/**
 * `load-skill` 是条件内置（docs/logic/engine/tech/builtin-tools.md §1.9 / §3 括注）：不经
 * `builtinTools` 裁剪，只看 `agent.skills` 是否配置了至少一个 skill——与
 * `bash` 由 `RunkoExec` 注入触发是同一族"条件内置"机制，但触发条件各自独立。
 */
function isLoadSkillEnabled(skills: Skill[] | undefined): boolean {
  return skills !== undefined && skills.length > 0;
}

/**
 * `agent.tools` + core 自带的内置工具（`update-plan` 恒定、`load-skill`/
 * `bash` 条件内置，文件工具八件套归宿主装配）。宿主同名工具覆盖内置实现
 * （docs/logic/engine/tech/builtin-tools.md §3），因此展开顺序是内置在前、`agent.tools` 在后。
 */
function assembleTools(agent: AgentDefinition, planStore: PlanStore, derivedData: DerivedDataCollector, exec: RunkoExec | undefined): Record<string, Tool> {
  const builtins: Record<string, Tool> = {};
  if (isUpdatePlanEnabled(agent.builtinTools)) {
    builtins["update-plan"] = createUpdatePlanTool({
      store: planStore,
      onPlanUpdate: (items) => derivedData.recordPlanUpdate(items),
    });
  }
  if (isLoadSkillEnabled(agent.skills)) {
    builtins["load-skill"] = createLoadSkillTool({ skills: agent.skills ?? [] });
  }
  if (exec !== undefined) {
    builtins.bash = createBashTool({ exec });
  }
  return { ...builtins, ...(agent.tools ?? {}) };
}

const WORKSPACE_EXCLUSIVITY_MESSAGE =
  "SessionOptions.workspace is mutually exclusive with fs/exec — workspace (RunkoFS & RunkoExec) already " +
  "provides both from a single same-source object (docs/logic/engine/tech/core-sdk.md §4.5a mode A). Pass either { workspace } alone, " +
  "or { fs, exec } (either or both) without workspace — mixing the two leaves it ambiguous which fs/exec " +
  "actually took effect.";

/**
 * `fs` / `exec` / `workspace` 的互斥求解。同步抛错而非返回错误值——这是一次性的、纯静态的
 * 装配期误用（不依赖任何 I/O 时机判定），与 `createUnconfiguredFS()` 那种
 * "延迟到实际调用才知道错在哪"的场景不同，值得在 `createSession(...)` 调用的
 * 当下立刻失败。
 */
function resolveExecutionSurfaces(opts: SessionOptions): { fs: RunkoFS; exec: RunkoExec | undefined } {
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
function hasSnapshotCapability(candidate: RunkoFS): candidate is RunkoFS & FSSnapshotCapable {
  return "snapshot" in candidate && typeof candidate.snapshot === "function";
}

interface FSRestorable {
  restore(snapshot: JsonValue): void;
}

/** 同上，探测 `restore()`。 */
function hasRestoreCapability(candidate: RunkoFS): candidate is RunkoFS & FSRestorable {
  return "restore" in candidate && typeof candidate.restore === "function";
}

// ---- 活动信号（docs/logic/orchestration/tech/sandbox-keepalive.md §5.2） ----

/**
 * core 侧节流间隔，**只为降噪**：一轮里 chunk 可能每秒来几十个，逐个通知远端
 * 毫无意义。它**不是**保活策略——真正「多久续一次」由适配器的[续期闸门](../../../docs/terms.md)
 * 按自己知道的沙盒超时值决定。正因如此这个值可以写死：core 不知道、也不该被迫
 * 决定沙盒的超时是 5 分钟还是 1 小时。
 */
const ACTIVITY_THROTTLE_MS = 5_000;

/** 结构探测（同 `hasSnapshotCapability`，是信任声明不是结构验证）：这个工作区面收不收活动信号。 */
function hasActivityCapability<T extends object>(
  candidate: T,
): candidate is T & Required<RunkoActivityAware> {
  return "onActivity" in candidate && typeof candidate.onActivity === "function";
}

/**
 * 把 `fs`/`exec` 两个面上所有能收活动信号的实现收成一个通知函数（同一个对象同时
 * 当 fs 和 exec 时只收一次——[模式 A（同源工作区）](../../../docs/terms.md)正是这种形态）。
 * 都不支持就返回 `undefined`，调用点据此整段跳过。
 */
function collectActivityTargets(
  fs: RunkoFS,
  exec: RunkoExec | undefined,
): ((signal: ActivitySignal) => void) | undefined {
  const targets: Required<RunkoActivityAware>[] = [];
  if (hasActivityCapability(fs)) {targets.push(fs);}
  if (exec !== undefined && hasActivityCapability(exec) && !targets.includes(exec)) {targets.push(exec);}
  if (targets.length === 0) {return undefined;}
  return (signal) => {
    for (const target of targets) {target.onActivity(signal);}
  };
}

/**
 * `fs.snapshot()` 只是"结构上像 JsonValue"的信任声明（`FSSnapshotCapable`），不是
 * 运行时保证——施工中实测发现 `@runko/virtual-fs` 的 `MemoryFS.snapshot()` 会在
 * 从未设置过 mimeType 的文件条目上留一个显式 `mimeType: undefined` 键（不是
 * 键缺失，是键存在、值为 `undefined`），这精确地落在 `jsonValueSchema` 的
 * `z.record` 拒绝范围内（`undefined` 不是合法 JSON 值），即便 `JSON.stringify`
 * 会默默丢掉这个键。这是 virtual-fs／state.ts 两侧既有实现之间的一个真实接缝
 * gap——因此在 `toJSON()` 自己的信任边界上做防御性规整：真的过一遍
 * `JSON.stringify`/`JSON.parse`（正是 `SessionState` 打算被持久化时会经历的
 * 编解码），再交给已导出的 `jsonValueSchema` 收窄回精确类型（同 `model/step.ts`
 * `toJsonValue()` 的既有 `unknown → JsonValue` 收窄写法，`JSON.parse` 的 `any`
 * 结果从不被赋给具名变量，只作为 `.parse()` 的实参一次性经过）。
 */
function toCleanJsonValue(value: JsonValue): JsonValue {
  return jsonValueSchema.parse(JSON.parse(JSON.stringify(value)));
}

const FS_SNAPSHOT_NOT_SUPPORTED_MESSAGE =
  "toJSON({ includeFs: true }) requires a RunkoFS that implements snapshot() (e.g. @runko/virtual-fs's " +
  "MemoryFS/OverlayFS) — this session's fs does not expose one. Inject a snapshot-capable fs, or call " +
  "toJSON() without includeFs.";

const FS_RESTORE_NOT_SUPPORTED_MESSAGE =
  "SessionOptions.resume includes fsSnapshot, but this session's fs does not implement restore() (e.g. " +
  "@runko/virtual-fs's MemoryFS/OverlayFS do) — inject a matching fs, or resume from a SessionState " +
  "without fsSnapshot.";

/**
 * `resume` 经 `sessionStateSchema` 校验——同步抛错，理由同
 * `resolveExecutionSurfaces`：一次性的、纯静态的装配期输入校验，值得在
 * `createSession(...)` 调用的当下立刻失败。这只是**浅层**校验（`state.ts`
 * 头注释）——深层的 `validateSessionMessages()` 异步跑在 `createSession` 内部
 * （不 await），`stream()`/`send()` 顶部才真正等它，理由见本文件头。
 */
function resolveResumedState(resume: SessionState | undefined): SessionState | undefined {
  if (resume === undefined) {return undefined;}
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
  /** 见 `collectActivityTargets`：装配期探测一次，之后 `stream()` 里零探测开销；都不支持时恒为 `undefined`。 */
  const notifyActivityTarget = collectActivityTargets(fs, exec);
  if (resumedState?.fsSnapshot !== undefined) {
    if (!hasRestoreCapability(fs)) {throw new Error(FS_RESTORE_NOT_SUPPORTED_MESSAGE);}
    fs.restore(resumedState.fsSnapshot);
  }
  const system = buildSystemPrompt(agent, opts);
  const model: LanguageModel = agent.model;
  const maxTurnsPerRun = agent.maxTurnsPerRun ?? 100;
  const maxContextTokens = agent.maxContextTokens;
  const maxOutputTokens = agent.maxOutputTokens;

  /**
   * `messages` 先用浅层校验（`resolveResumedState`）通过的原始账本 scaffold；
   * `messagesReady` 在下面异步跑深层校验（ai 的 `validateUIMessages()`），成功
   * 后整体替换成收窄/规范化过的账本——`stream()`/`send()` 顶部 `await` 它，
   * 理由见本文件头"结构化输出 + 序列化/恢复"一节。未 resume 时无需校验，
   * `messagesReady` 是一个已 resolve 的 no-op。
   */
  let messages: RunkoUIMessage[] = resumedState !== undefined ? [...resumedState.messages] : [];
  /**
   * **空账本跳过深层校验**：ai 的 `validateUIMessages()` 对空数组直接报
   * "Messages array must not be empty"，但「resume 一个还没产出任何消息的会话」是完全
   * 合法的（`sessionStateSchema` 本来就允许 `messages: []`）——宿主想让会话 id 从第一轮
   * 起就稳定（`@runko/agent` 拿 conversationId 当 session id，遥测的关联键靠它）时，
   * 传的正是这种空 state。没有消息可校验，也就没有什么可拒绝的。
   */
  const messagesReady: Promise<void> =
    resumedState !== undefined && resumedState.messages.length > 0
      ? validateSessionMessages(resumedState.messages).then((validated) => {
          messages = validated;
        })
      : Promise.resolve();
  const readState = opts.readState ?? createSessionReadState();
  const onceMemory = createOnceApprovalMemory();
  const derivedData = opts.derivedData ?? createDerivedDataCollector();
  const planStore = createPlanStore();
  const tools = assembleTools(agent, planStore, derivedData, exec);
  const getSkill = createGetSkill(agent.skills ?? []);
  /**
   * 附属文件挂载在 `createSession` 时触发——
   * `mountSkillFiles(...)` 在这里被调用（不是等到第一次 `stream()`），只是它的
   * 完成（`await`）挪到 `stream()` 顶部，理由是 `createSession` 本身是同步函数、
   * 不能在这里 `await` 一个可能真异步的 `RunkoFS.writeFile`（真实沙盒实现）；
   * 挪到 `stream()` 顶部仍能保证"任何工具真正执行前挂载已完成"，同时不需要
   * `createSession` 变成 `Promise<Session>`（会是破坏性的签名变更）。
   */
  const skillFilesMounted = mountSkillFiles(fs, agent.skills ?? []);

  let turn = resumedState?.turn ?? 0;

  /**
   * STEER-1：turn 作用域的 steer 队列 + 活动标志。`stream()` 生成器体开头置
   * `turnActive = true`，`try/finally` 保证无论 `runTurn` 正常收尾还是抛错都
   * 复位标志并清空队列——队列绝不跨 turn 存活。`steer()` 只在 `turnActive` 为
   * 真时接受新条目；实际的排空/注入发生在 `loop.ts` 的两个 drain checkpoint
   * （经下面 `drainSteers` 回调传入）。
   */
  let turnActive = false;
  let pendingSteers: RunkoUIMessage[] = [];

  /**
   * `steer()`'s known gap (STEER-1 §4.2 / STEER-1F): a turn-failure raised
   * by the model or tool-execution error paths (`aborted`/`provider_error`
   * catches in `loop.ts`) doesn't drain the queue first — content queued
   * during that in-flight model call/tool execution is dropped when the turn
   * fails that way, not injected. Not fixed by this method; see loop.ts's
   * `runTurn` header and docs/logic/engine/tech/core-sdk.md §4.2 for the up-to-date list of which
   * termination paths do drain.
   */
  function steer(input: Input): boolean {
    if (!turnActive) {return false;}
    pendingSteers.push(toUserUIMessage(input, { steered: true }));
    return true;
  }

  async function* stream(input: Input, turnOpts: TurnOptions = {}): AsyncGenerator<RunkoChunk, TurnResult> {
    turnActive = true;
    try {
      await Promise.all([skillFilesMounted, messagesReady]);

      turn += 1;
      messages.push(toUserUIMessage(input));

      /**
       * [活动信号](../../../docs/terms.md)的 turn 作用域节流状态（docs/logic/orchestration/tech/sandbox-keepalive.md §5.2）。
       * 每轮重置，所以一轮的第一个 chunk 必定发信号——新一轮开始就该让远端知道。
       */
      let lastActivityAt = 0;
      let lastSignalWasApproval = false;
      const notifyActivity = (chunk: RunkoChunk): void => {
        if (notifyActivityTarget === undefined) {return;}
        const isApprovalRequest = chunk.type === "tool-approval-request";
        /**
         * 两种边沿必须立刻送达、不能被节流吃掉：
         *   1. **进入**等人状态——`loop.ts` 产出 `tool-approval-request` 后就去
         *      `await` 人审通道了，在裁决落定前不再产出任何 chunk（可能几小时）；
         *   2. **离开**等人状态——实现方靠这一条停掉自己的审批保活，晚一拍都是多烧的钱。
         *      裁决后必定有后续 chunk（`loop.ts` 允许/拒绝两条路径都 yield
         *      `tool-approval-response`），所以这条边沿一定等得到。
         */
        const isEdge = isApprovalRequest || lastSignalWasApproval;
        const now = Date.now();
        if (!isEdge && now - lastActivityAt < ACTIVITY_THROTTLE_MS) {return;}
        lastActivityAt = now;
        lastSignalWasApproval = isApprovalRequest;
        notifyActivityTarget({
          session: { id, turn },
          reason: isApprovalRequest ? "awaiting-approval" : "progress",
        });
      };

      const turnGen = runTurn({
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
        onReview: opts.onReview,
        onceMemory,
        derivedData,
        getSkill,
        drainSteers: () => pendingSteers.splice(0, pendingSteers.length),
        telemetry: opts.telemetry,
      });

      /**
       * STEER-3A Finding 4 (§4.2): manual delegation instead of a bare
       * `yield* turnGen` — the `message-metadata` chunk `runTurn` always ends
       * on (`loop.ts`'s `finalizeTurn`, exactly once per turn) is the
       * terminal signal, but a plain `yield*` only lets the consumer observe
       * it *after* it's already been produced, at which point `steer()`
       * would still (incorrectly) report an in-flight turn. Flipping
       * `turnActive = false` the instant that chunk arrives — strictly
       * *before* yielding it onward — makes a `steer()` call made in
       * reaction to seeing it honestly return `false`, instead of `true`
       * immediately followed by the content being silently dropped by the
       * `finally` block below.
       */
      let next = await turnGen.next();
      while (!next.done) {
        const chunk = next.value;
        if (chunk.type === "message-metadata") {
          turnActive = false;
        }
        // 在 `yield` **之前**：`yield` 把控制权交给消费者，消费者可能很慢，
        // 而「还在干活」这个事实此刻就已成立。
        notifyActivity(chunk);
        yield chunk;
        next = await turnGen.next();
      }
      return next.value;
    } finally {
      turnActive = false;
      pendingSteers = [];
    }
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
    let failure: RunkoError | undefined;
    let step = await gen.next();
    while (!step.done) {
      // `finalizeTurn`（loop.ts）writes exactly one `message-metadata` chunk
      // per turn, carrying `{turn, usage, status, error?}` — `error` present
      // is the ground truth for "this turn failed" (regardless of which of
      // the three failure `status` labels it got), same as the old
      // `turn.failed` event's role.
      if (step.value.type === "message-metadata" && step.value.messageMetadata.error !== undefined) {
        failure = step.value.messageMetadata.error;
      }
      step = await gen.next();
    }
    if (failure !== undefined) {throw new RunkoSessionError(failure);}

    const turnResult = step.value;
    if (turnOpts.outputSchema === undefined) {return turnResult;}

    const requestMessages = await convertToModelMessages(messages);
    const structuredOutput = await generateStructuredOutput({
      model,
      system,
      messages: requestMessages,
      outputSchema: turnOpts.outputSchema,
      maxOutputTokens,
      signal: turnOpts.signal,
    });
    return { ...turnResult, structuredOutput };
  }

  function toJSON(toJSONOpts: { includeFs?: boolean } = {}): SessionState {
    const state: SessionState = { id, turn, messages: [...messages], createdAt };
    if (toJSONOpts.includeFs === true) {
      if (!hasSnapshotCapability(fs)) {throw new Error(FS_SNAPSHOT_NOT_SUPPORTED_MESSAGE);}
      state.fsSnapshot = toCleanJsonValue(fs.snapshot());
    }
    return state;
  }

  return { id, fs, readState, derivedData, send, stream, steer, toJSON };
}
