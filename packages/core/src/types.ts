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
 * "list_dir 行尾标注类型与 description"/"非文本文件带 mimeType"/
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
}

// ---- NimboExec：命令执行的接口倒置，与 NimboFS 同构（§4.5a） ----

export interface NimboExec {
  exec(req: ExecRequest, opts?: ExecOptions): Promise<ExecResult>;
  /** 环境自描述（OS/网络/cwd 语义），拼进 bash 工具描述。 */
  describe?(): string;
  /** 实现自声明的审批默认值（本地实现 "always"，沙盒实现通常 "never"）。 */
  defaultApproval?: ApprovalPolicy;
}

// ---- 审批链（§4.1 / §4.5） ----

export interface ApprovalContext {
  toolName: string;
  callId: string;
  session: { id: string; turn: number };
}

export type ApprovalDecision =
  | { behavior: "allow"; updatedInput?: JsonValue }
  | { behavior: "deny"; message?: string };

export type ApprovalPolicy =
  | "never"
  | "always"
  | "once"
  | ((input: JsonValue, ctx: ApprovalContext) => Promise<ApprovalDecision> | ApprovalDecision);

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
  execute(input: JsonValue, ctx: ToolContext): Promise<ToolReturn> | ToolReturn;
}
