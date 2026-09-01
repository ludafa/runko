/**
 * 文件工具八件套的横切类型与辅助函数（docs/tech/builtin-tools.md §0 横切规则，
 * 消费于 §1.1–§1.8 各工具）。
 *
 * ---- P4 接缝设计说明（工单要求写清理由） ----
 * readState 与 file_change 派生"真正应该"归属 session/ToolRuntime（tech-spec
 * §4.2/§4.5，P4 尚未实现）：readState 本该是整个 session 生命周期内、跨全部
 * 工具调用共享的一份状态；file_change 本该经 SessionEvent 广播给宿主。P2 阶段
 * core 的运行层还不存在，因此这里把两者收窄成本包自己定义的最小接口，经
 * `createFileTools(opts)` 从外部注入——工具内部只认这两个接口的形状，不关心
 * 背后是测试用的 Map、还是 P4 落地后真正的 session 状态对象：
 *
 *   - `ReadStateStore`：get/set(path, version) 两个方法，version 判据用
 *     `stat().mtime`（§0.4 原文）。P4 落地后大概率就是一个 `Map<string, number>`
 *     包一层 session 生命周期管理，这里先给接口而非具体类型，让 P4 能在不改
 *     本包一行代码的前提下换成真正的、可能带持久化/序列化的实现。
 *   - `onFileChange`：一个普通回调，不是事件总线——工具本身不发 SessionEvent
 *     （§0.6："写类工具成功后由 ToolRuntime 派生 file_change item...工具自身
 *     不负责发事件"）。P4 的 ToolRuntime 把这个回调接到真正的 file_change item
 *     派生 + `item.completed` 事件上；本包对"事件"完全无感知，回调只是搬运
 *     一份 `FileChange[]` 数据。
 *
 * `FileChange.kind` 用 `add|update|delete`，是刻意与 `diff.ts` 的
 * `FileDiff.kind`（`created|modified|deleted`）不同的一个表面——前者对应
 * docs/tech/core-sdk.md §4.2 `SessionItem` 的 `file_change` 事件面，后者是
 * `diff()/writeBack()` 的宿主导出面；两者语义相邻但服务不同消费者，P2-1 已在
 * docs/tech/core-sdk.md §4.4"语义澄清"里定过一次，这里是 P2-2 侧的落地（orchitector 补充 a）。
 */
import type { JsonValue, NimboFS } from "@nimbo/core";
import { DEFAULT_MIME_TYPE } from "../mime.js";
import { globToRegExp, isIgnoredPath } from "../path.js";

/** session 范围的"路径 → 上次读取版本"存储；version 判据是 `stat().mtime`（§0.4）。 */
export interface ReadStateStore {
  get(path: string): number | undefined;
  set(path: string, version: number): void;
}

/**
 * file_change 派生数据的单条记录（docs/tech/core-sdk.md §4.2 `SessionItem` 的
 * `file_change.changes[]`）。kind 集合是 add/update/delete——不要跟本包
 * `diff.ts` 的 `FileDiff.kind`（created/modified/deleted）混用，两者是刻意
 * 不同的表面（见本文件顶部注释）。
 */
export interface FileChange {
  path: string;
  kind: "add" | "update" | "delete";
}

export interface CreateFileToolsOptions {
  readState: ReadStateStore;
  /** 写类工具成功后上报派生的 file_change 记录；工具自身不发 SessionEvent（§0.6）。 */
  onFileChange?: (changes: FileChange[]) => void;
}

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

export function decode(data: Uint8Array): string {
  return textDecoder.decode(data);
}

export function byteLength(text: string): number {
  return textEncoder.encode(text).length;
}

/**
 * 每个失败的工具调用都用这个包一层——统一 `{ isError: true, content }` 形状（§0.5）。
 * 显式带 `[key: string]: JsonValue` 索引签名，而不是留给 TS 对"新鲜对象字面量"的
 * 隐式索引签名推断——`errorResult(...)` 的返回值要经一个具名 `interface` 变量
 * （不是内联字面量）流回 `ToolReturn`（`JsonValue` 的对象分支即 `{[k:string]:JsonValue}`），
 * 具名 interface 类型必须显式声明索引签名才能满足这个联合分支，否则 tsc 报
 * "Index signature ... is missing"——这不是要放宽类型（`isError`/`content` 仍是
 * 精确字面量/`string`），只是把"这个对象类型可以当任意 JsonValue 记录使用"的
 * 既有事实显式化，同款处理见 core `tool.ts` 顶部注释里的两处型变阻力。
 */
export interface ToolErrorResult {
  isError: true;
  content: string;
  [key: string]: JsonValue;
}

/** content 必须包含下一步建议（§0.5），调用方在每个失败分支自行把建议写进消息里。 */
export function errorResult(content: string): ToolErrorResult {
  return { isError: true, content };
}

/**
 * catch 子句里从 `unknown` 安全窄化出可读消息——受控例外，同款用法见
 * `dir.ts` 的 `isErrnoException` 注释：只用于这一处收窄，不向外扩散 `unknown`。
 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const BINARY_MIME_TYPES = new Set<string>([
  "application/pdf",
  "application/zip",
  "application/gzip",
  "application/x-tar",
  "application/wasm",
  "application/vnd.android.package-archive",
]);
const BINARY_MIME_PREFIXES = ["image/", "audio/", "video/"];

/**
 * 设计裁量（工单未 resolve 的歧义，按最合理解读实现）：`mime.ts` 的
 * `DEFAULT_MIME_TYPE` 兜底同时覆盖"真二进制/未知格式"和"没有可识别扩展名的
 * 常见文本文件"（Makefile/Dockerfile/.gitignore/.env 等，v1 只按扩展名推断，
 * 没有内容嗅探，两者无法区分，见 mime.ts 顶部注释）。这里选择乐观策略：把
 * 默认兜底类型当文本处理（read-file 直接尝试展示），只把明确识别的二进制
 * 格式（图片/音视频/pdf/压缩包/wasm/apk）当二进制——比"默认当二进制"更贴合
 * 真实代码库的常见情况，也是 Claude Code 的 Read 工具的实际行为。
 */
export function isTextMimeType(mimeType: string | undefined): boolean {
  if (mimeType === undefined || mimeType === DEFAULT_MIME_TYPE) {return true;}
  if (mimeType.startsWith("text/")) {return true;}
  if (BINARY_MIME_TYPES.has(mimeType)) {return false;}
  return !BINARY_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix));
}

/**
 * write-file/edit-file/move-file 写成功后调用：把写入后的新 mtime 登记进
 * readState，使"连续编辑无需重读"成立（docs/tech/builtin-tools.md §4："read→edit→
 * 再 edit，第二次无需重读"）。
 */
export async function registerWrite(fs: NimboFS, path: string, readState: ReadStateStore): Promise<void> {
  const stat = await fs.stat(path);
  if (stat.mtime !== undefined) {readState.set(path, stat.mtime);}
}

/**
 * read-before-write 强制（§0.4）：`write-file` 覆盖已存在文件、`edit-file`
 * 都要过这一关。返回 `undefined` 表示放行；否则返回可直接塞进 `errorResult(...)`
 * 的指导性错误文案。
 */
export function checkReadBeforeWrite(path: string, currentMtime: number | undefined, readState: ReadStateStore): string | undefined {
  const lastRead = readState.get(path);
  if (lastRead === undefined) {
    return `"${path}" has not been read in this session yet. Call read-file on it first, then retry.`;
  }
  if (currentMtime !== undefined && lastRead !== currentMtime) {
    return (
      `"${path}" has changed since it was last read (its mtime no longer matches what was read) — it was likely ` +
      "modified outside this tool (e.g. by bash) or by a concurrent edit. Call read-file again to see the current content, then retry."
    );
  }
  return undefined;
}

/** `path`(scope) + `pattern`(relative) → 单个绝对 glob 模式串，喂给 `NimboFS.glob()`。 */
export function joinGlobPattern(base: string, pattern: string): string {
  const normalizedBase = base === "/" ? "" : base.replace(/\/+$/, "");
  const normalizedPattern = pattern.startsWith("/") ? pattern.slice(1) : pattern;
  return `${normalizedBase}/${normalizedPattern}`;
}

/** 每个失败/截断消息统一带上这个前缀，方便模型和测试都能可靠识别（§0.3）。 */
export function truncationNotice(reason: string, hint: string): string {
  return `[truncated: ${reason}] ${hint}`;
}

// ---- 输出预算常量（docs/tech/builtin-tools.md §1.1–§1.8 逐条给出的数字） ----
export const READ_FILE_MAX_LINES = 2000;
export const READ_FILE_MAX_BYTES = 256 * 1024;
export const LIST_DIR_MAX_ENTRIES = 500;
export const GLOB_MAX_MATCHES = 1000;
export const GREP_MAX_FILES = 100;
export const GREP_MAX_LINES = 500;

/**
 * grep/glob 的默认忽略集合（docs/tech/sandbox.md §4 原生搜索接缝）：`.git` 元数据
 * 与 `node_modules` 依赖树体积大、几乎从不是模型想搜的目标，两条路径
 * （native 适配器 / JS 回退）都要应用同一份默认值，保证行为一致。
 */
export const DEFAULT_SEARCH_IGNORE: string[] = ["**/.git", "**/node_modules"];

/**
 * 计算某次 grep/glob 调用生效的默认忽略集合：`path` 若显式指向某个默认忽略
 * 目录本身或其内部（ancestor-or-self 命中），说明模型明确要搜进去，对应的
 * 默认项就此放行——默认忽略只是省心的缺省值，不是安全边界，模型可以覆盖。
 */
export function resolveDefaultIgnore(base: string): string[] {
  return DEFAULT_SEARCH_IGNORE.filter((pattern) => !isIgnoredPath(base, [globToRegExp(pattern)]));
}
