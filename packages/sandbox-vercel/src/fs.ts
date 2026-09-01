/**
 * `createVercelFs(sandbox, root)`：NimboFS 七方法在 `sandbox.fs`（node:fs/promises
 * 兼容子集）上的直译（docs/tech/sandbox.md §3.1 / §8.2 Vercel 列）。
 *
 * ---- 一个实测推翻工单研究原文的发现：`fs.rm()` 无法承担"非递归删非空目录
 * 拒绝"的语义 ----
 *
 * docs/tech/sandbox.md §8.2 原文说 Vercel 的 `fs.rm(p, {recursive})` "原生对齐"——本地实测
 * `node:fs/promises`（Vercel Sandbox 的 `fs.*` 是这套 API 的兼容子集，语义应
 * 一致）证明并不成立：`fs.rm(path)`（`recursive` 缺省/false）对**任何**目录都
 * 抛 `ERR_FS_EISDIR`，不区分空/非空——用它去实现"非递归删空目录成功、删非空
 * 目录报 DirectoryNotEmptyError"（NimboFS 的 `rm(path,{recursive?})` 契约，
 * 对齐 MemoryFS 行为）完全对不上。真正带有"空则成功、非空则 ENOTEMPTY"语义
 * 的是 `fs.rmdir()`（同样实测确认）。因此非递归删除按目标类型分流：文件走
 * `fs.rm()`；目录走 `fs.rmdir()`（拿到真正的 `ENOTEMPTY` 可翻译）；`recursive:
 * true` 时统一走 `fs.rm(path, {recursive:true, force:true})`。代价是非递归删
 * 目录多一次 `stat` 判断类型，可接受（docs/tech/sandbox.md §4 第 6 点本就预期扫描类操作
 * 走 bash，单次 rm 调用的额外 RTT 量级不在那条建议的射程内）。
 *
 * ---- readdir 不逐条目 stat 取 size/mtime ----
 *
 * `DirFS`（本地磁盘）的 readdir 会为每个文件条目额外 stat 一次拿 size/mtime；
 * 这里不跟随——那是本地磁盘的免费操作，在远程沙盒上是 N 次额外网络往返。审计
 * 了 `list-dir`/`glob` 等消费方（`virtual-fs/src/tools/*.ts`）：readdir 结果的
 * size/mtime 实际未被任何工具读取（`FileStat.mtime` 的唯一消费点是 `stat()`
 * 单独调用，走 read-file/edit-file 等的 readState 判据），只有 `mimeType` 有
 * 用（list-dir 用它标注非文本文件）——mimeType 是按扩展名推断的纯函数，零 RTT
 * 代价。因此 readdir 条目只填 name/type/mimeType，size/mtime 留空（FileStat 里
 * 两者本就是可选字段），需要精确 mtime 时调用方本就该单独 `stat()` 该路径。
 *
 * ---- 原生搜索快路径（docs/tech/sandbox.md §4）：`searchFiles`/`searchContent` + `glob` 重写 ----
 *
 * `NimboFS.searchFiles?`/`searchContent?` 是 grep/glob 工具的能力接缝（实现了就优先调，
 * 否则/`SearchUnsupportedError` 时回退现有 JS 逐文件扫描，见 `@nimbo/virtual-fs`
 * `tools/{grep,glob}.ts`）。这里的实现是"一次网络往返"：把整棵树的扫描交给沙盒
 * 自己的 `node`（`sandbox.runCommand({cmd:"node", args:["-e", SEARCH_SCRIPT, "--", payload]})`），
 * 脚本体见 `search-script.ts`（其头注释详述了"为什么是裸字符串常量""语义零漂移"
 * "ignore 剪枝算法重复实现的原因"等取舍，不在这里重复）。既有的 7 方法之一
 * `glob()` 同样重写为这套脚本载体的一次往返（`ignore:[]`、`limit` 给一个实践中
 * 不可能触达的上限，语义与重写前的 `walkFiles` 逐文件扫描完全一致）；`walkFiles`
 * 函数保留在文件底部，只在探测到"这个沙盒没有可用 node"时才被 `glob()` 当回退
 * 路径调用——`searchFiles`/`searchContent` 没有类似回退，直接把 `SearchUnsupportedError`
 * 抛给调用方（grep/glob 工具），由工具层负责回退。
 *
 * node 可用性判定分两种，只有第一种会被缓存（`SearchScriptState.nodeUnsupported`，
 * 每个 `createVercelFs()` 实例各一份，一旦判定就此实例生命周期内不再尝试）：
 *   1. `runCommand()` 直接拒绝（不管什么原因）、或以 exitCode 127（"command not found"
 *      的 POSIX 惯例）落定——两者都视为"这个沙盒大概率没有可执行的 node"，缓存判定，
 *      抛 `SearchUnsupportedError`。
 *   2. 脚本真的跑起来了（exitCode 是别的非零值，或 exitCode 0 但 stdout 不是合法
 *      JSON）——这是脚本自身的 bug 或环境的别的问题，不代表"没有 node"，因此不缓存，
 *      按普通 `Error` 上浮（带 stderr/stdout 摘要辅助定位）。
 * 我们自己的 60s 本地超时（`withTimeout`）单独归为第三类：远端挂死不代表"没有
 * node"，同样不缓存，直接作为普通 `Error` 上浮——用一个仅本文件内部可见的
 * `SearchScriptTimeoutError` 标记加以区分，避免被误判进第 1 类。
 */
import type {
  ContentSearchGroup,
  ContentSearchLine,
  ContentSearchQuery,
  ContentSearchResult,
  DirEntry,
  FileSearchQuery,
  FileSearchResult,
  FileStat,
  NimboFS,
} from "@nimbo/core";
import { SearchUnsupportedError } from "@nimbo/core";
import { globToRegExp, inferMimeType, matchesGlob } from "@nimbo/virtual-fs";
import { Writable } from "node:stream";
import { describeError, isErrnoException, translateFsError } from "./errors.js";
import { toRealPath } from "./path.js";
import { SEARCH_SCRIPT } from "./search-script.js";
import type { VercelSandboxLike } from "./types.js";

const SEARCH_TIMEOUT_MS = 60_000;

function toFileStat(stats: { isDirectory(): boolean; size: number; mtimeMs: number }, virtualPath: string): FileStat {
  if (stats.isDirectory()) {return { type: "dir", mtime: Math.round(stats.mtimeMs) };}
  return { type: "file", size: stats.size, mtime: Math.round(stats.mtimeMs), mimeType: inferMimeType(virtualPath) };
}

// ---- 原生搜索：payload/输出的线格式，及从 JSON.parse() 的 `unknown` 安全窄化 ----
// （同 `core/src/load/load-agent.ts` 的 `isRecord` 先例：JSON.parse 的返回值天生是
// `unknown`/`any`，这是一处不可避免的序列化边界，收敛成一个具名类型谓词，不让
// `unknown`/`any`/类型断言流出这几个函数之外。）

interface FilesSearchPayload {
  op: "files";
  rootPrefix: string;
  startReal: string;
  patternSource: string;
  ignoreSources: string[];
  limit: number;
}

interface ContentSearchPayload {
  op: "content";
  rootPrefix: string;
  startReal: string;
  scopeSource: string;
  ignoreSources: string[];
  patternSource: string;
  ignoreCase: boolean;
  mode: "files" | "content";
  context: number;
  maxFiles: number;
  maxLines: number;
}

type SearchScriptPayload = FilesSearchPayload | ContentSearchPayload;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function parseFileSearchScriptOutput(raw: unknown): FileSearchResult {
  if (!isRecord(raw) || !isStringArray(raw.paths) || typeof raw.total !== "number") {
    throw new Error(`vercel sandbox: native search script produced an unexpected "files" result shape: ${JSON.stringify(raw)}`);
  }
  return { paths: raw.paths, total: raw.total };
}

function isContentSearchLine(value: unknown): value is ContentSearchLine {
  return isRecord(value) && typeof value.line === "number" && typeof value.text === "string" && typeof value.match === "boolean";
}

function isContentSearchGroup(value: unknown): value is ContentSearchGroup {
  return isRecord(value) && typeof value.path === "string" && Array.isArray(value.lines) && value.lines.every(isContentSearchLine);
}

function parseContentSearchScriptOutput(raw: unknown): ContentSearchResult {
  if (
    !isRecord(raw) ||
    !Array.isArray(raw.groups) ||
    !raw.groups.every(isContentSearchGroup) ||
    typeof raw.totalFiles !== "number" ||
    typeof raw.lineCapped !== "boolean"
  ) {
    throw new Error(`vercel sandbox: native search script produced an unexpected "content" result shape: ${JSON.stringify(raw)}`);
  }
  return { groups: raw.groups, totalFiles: raw.totalFiles, lineCapped: raw.lineCapped };
}

/** `root` 去掉末尾斜杠后的真实前缀（"/" 视为空前缀）——与 `path.ts` 私有的 `cleanRoot`
 * 同一算法。这里独立维护一份而不是从 `path.ts` 导出复用：脚本 payload 要的是这个更
 * 底层的"可直接从真实路径切掉的前缀字符串"，`path.ts` 只对外暴露组合好的
 * `toRealPath`/`resolveCwd`，为这一处用途扩大它的导出面不划算。 */
function rootPrefixOf(root: string): string {
  if (root === "/") {return "";}
  return root.endsWith("/") ? root.slice(0, -1) : root;
}

/**
 * 从虚拟 glob 模式里抠出不含通配符的最长前缀目录（第一个含 `*`/`?` 的路径段
 * 之前）——脚本据此把 `readdirSync` 递归的起点收窄到这个目录，而不是每次都从
 * 整个工作区根扫描。这只是一个遍历范围的优化：模式要求这段前缀必须逐字匹配，
 * 起点之外的路径结构上不可能匹配整条正则，收窄范围不改变匹配结果。
 *
 * 整条 pattern/scope 完全不含通配符时是特例：这种输入本身就是一条具体路径，
 * 它的最后一段可能是叶子文件（而不是目录）——`walk()` 会对 `startReal` 执行
 * `readdirSync`，如果把整条路径当前缀返回，遇到叶子文件会 ENOTDIR 被 catch
 * 静默吞掉，导致该文件永远搜不到。因此这种情况下退一级，返回最后一段的
 * 父目录（等价于 `dirname`），交给 `walk()` 从父目录读一层：无论最后一段
 * 实际是文件还是目录，都能在这一层 `readdirSync` 里出现并继续正确处理。
 * 只要 pattern 里还有至少一个通配符段，前缀段必然是目录（通配符段本身不
 * 计入前缀），这条分支不生效，既有行为不变。
 */
function staticPrefixDir(pattern: string): string {
  const segments = pattern.split("/").filter((segment) => segment.length > 0);
  const prefix: string[] = [];
  let hasWildcardSegment = false;
  for (const segment of segments) {
    if (segment.includes("*") || segment.includes("?")) {
      hasWildcardSegment = true;
      break;
    }
    prefix.push(segment);
  }
  if (!hasWildcardSegment) {prefix.pop();}
  return prefix.length === 0 ? "/" : `/${prefix.join("/")}`;
}

/** 仅本文件内部使用的标记类——把"我们自己的本地超时"和"runCommand() 真的拒绝了"区分开
 * （见文件头注释"node 可用性判定分两种"）：前者不代表沙盒没有 node，不应缓存判定。 */
class SearchScriptTimeoutError extends Error {}

/**
 * 本地兜底：即便远端 `runCommand()` 永远不落定（网络分区/沙盒挂死），也保证不
 * 无限期挂起——同 `exec.ts` `raceAbort` 的先例。这里没有调用方传入的外部
 * `signal`（`searchFiles`/`searchContent` 契约没有取消语义），所以只起一个内部
 * `AbortController`：计时器到点既 reject 本地 Promise，也把 `signal` 传给
 * `startWork`，让 SDK 有机会真的去取消远端还在跑的脚本（而不只是本地放弃等待），
 * 避免超时后远端进程无主孤儿式地继续跑。`work` 补一个空 catch，避免竞速结束后
 * 才 settle 时产生 unhandled rejection。
 */
function withTimeout<T>(startWork: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  const work = startWork(controller.signal);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      work.catch(() => {});
      reject(new SearchScriptTimeoutError(`vercel sandbox: native search timed out after ${String(ms)}ms`));
    }, ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** 一次 `createVercelFs()` 实例生命周期内共享的"node 是否可用"判定缓存（见文件头注释）。 */
interface SearchScriptState {
  nodeUnsupported: boolean;
}

/** 收集一个 Writable 写入的全部文本——只关心攒起来的完整字符串，不需要 exec.ts 那种逐块 onOutput 转发。 */
function collectText(): { stream: Writable; text: () => string } {
  let buffer = "";
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      callback();
    },
  });
  return { stream, text: () => buffer };
}

/**
 * 一次 `sandbox.runCommand({cmd:"node", ...})` 网络往返，跑 `SEARCH_SCRIPT` 并解析
 * 它单行 JSON 写到 stdout 的结果。失败分支的分类详见文件头注释；这里只返回未经
 * 结构验证的 `unknown`——调用方（`searchFilesNative`/`searchContentNative`/`glob`）
 * 立刻用 `parseFileSearchScriptOutput`/`parseContentSearchScriptOutput` 窄化。
 */
async function runSearchScript(sandbox: VercelSandboxLike, state: SearchScriptState, payload: SearchScriptPayload): Promise<unknown> {
  if (state.nodeUnsupported) {
    throw new SearchUnsupportedError(
      'vercel sandbox: a previous call already found no usable "node" in this sandbox — native search stays disabled for this workspace instance.',
    );
  }

  const stdout = collectText();
  const stderr = collectText();

  let result: { exitCode: number };
  try {
    result = await withTimeout(
      (signal) =>
        sandbox.runCommand({
          cmd: "node",
          args: ["-e", SEARCH_SCRIPT, "--", JSON.stringify(payload)],
          signal,
          timeoutMs: SEARCH_TIMEOUT_MS,
          stdout: stdout.stream,
          stderr: stderr.stream,
        }),
      SEARCH_TIMEOUT_MS,
    );
  } catch (error) {
    if (error instanceof SearchScriptTimeoutError) {throw error;} // 真超时不是"没有 node"的证据，原样上浮，不缓存。
    state.nodeUnsupported = true;
    throw new SearchUnsupportedError(
      `vercel sandbox: could not invoke "node" for native search (${describeError(error)}) — falling back to per-file scanning.`,
    );
  }

  if (result.exitCode === 127) {
    state.nodeUnsupported = true;
    throw new SearchUnsupportedError('vercel sandbox: "node" was not found in this sandbox (exit 127) — falling back to per-file scanning.');
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `vercel sandbox: native search script exited ${String(result.exitCode)}: ${stderr.text().slice(0, 500) || "(no stderr output)"}`,
    );
  }

  try {
    return JSON.parse(stdout.text());
  } catch (error) {
    throw new Error(
      `vercel sandbox: native search script produced non-JSON output: ${describeError(error)} (stdout: "${stdout.text().slice(0, 200)}")`,
    );
  }
}

async function searchFilesNative(
  sandbox: VercelSandboxLike,
  root: string,
  state: SearchScriptState,
  query: FileSearchQuery,
): Promise<FileSearchResult> {
  const payload: FilesSearchPayload = {
    op: "files",
    rootPrefix: rootPrefixOf(root),
    startReal: toRealPath(root, staticPrefixDir(query.pattern)),
    patternSource: globToRegExp(query.pattern).source,
    ignoreSources: (query.ignore ?? []).map((pattern) => globToRegExp(pattern).source),
    limit: query.limit,
  };
  return parseFileSearchScriptOutput(await runSearchScript(sandbox, state, payload));
}

async function searchContentNative(
  sandbox: VercelSandboxLike,
  root: string,
  state: SearchScriptState,
  query: ContentSearchQuery,
): Promise<ContentSearchResult> {
  const payload: ContentSearchPayload = {
    op: "content",
    rootPrefix: rootPrefixOf(root),
    startReal: toRealPath(root, staticPrefixDir(query.scope)),
    scopeSource: globToRegExp(query.scope).source,
    ignoreSources: (query.ignore ?? []).map((pattern) => globToRegExp(pattern).source),
    patternSource: query.pattern,
    ignoreCase: query.ignoreCase ?? false,
    mode: query.mode,
    context: query.context ?? 0,
    maxFiles: query.maxFiles,
    maxLines: query.maxLines,
  };
  return parseContentSearchScriptOutput(await runSearchScript(sandbox, state, payload));
}

export function createVercelFs(sandbox: VercelSandboxLike, root: string): NimboFS {
  const real = (virtualPath: string): string => toRealPath(root, virtualPath);
  const searchState: SearchScriptState = { nodeUnsupported: false };

  async function statOrUndefined(realPath: string): Promise<{ isDirectory(): boolean; isFile(): boolean } | undefined> {
    try {
      return await sandbox.fs.stat(realPath);
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") {return undefined;}
      throw error;
    }
  }

  async function ensureParentDir(realPath: string): Promise<void> {
    const idx = realPath.lastIndexOf("/");
    const parent = idx <= 0 ? "/" : realPath.slice(0, idx);
    await sandbox.fs.mkdir(parent, { recursive: true });
  }

  async function walkFiles(virtualDir: string): Promise<string[]> {
    let entries;
    try {
      entries = await sandbox.fs.readdir(real(virtualDir), { withFileTypes: true });
    } catch {
      // 目录不可读（不存在/不是目录/权限）——glob 视为该子树无文件，与 DirFS 的 walkFiles 同一取舍。
      return [];
    }
    const results: string[] = [];
    for (const entry of entries) {
      const childPath = virtualDir === "/" ? `/${entry.name}` : `${virtualDir}/${entry.name}`;
      if (entry.isDirectory()) {
        results.push(...(await walkFiles(childPath)));
      } else if (entry.isFile()) {
        results.push(childPath);
      }
    }
    return results;
  }

  return {
    async readFile(path: string): Promise<Uint8Array> {
      try {
        return await sandbox.fs.readFile(real(path));
      } catch (error) {
        throw translateFsError("readFile", path, error);
      }
    },

    async writeFile(path: string, data: Uint8Array | string): Promise<void> {
      const realPath = real(path);
      try {
        // NimboFS.writeFile 隐含"自动创建中间目录"（MemoryFS.ensureParentDirs 的
        // 契约），而 node:fs/promises 的 writeFile 不会——显式 mkdir 一次补齐。
        await ensureParentDir(realPath);
        await sandbox.fs.writeFile(realPath, data);
      } catch (error) {
        throw translateFsError("writeFile", path, error);
      }
    },

    async rm(path: string, opts?: { recursive?: boolean }): Promise<void> {
      const realPath = real(path);
      try {
        if (opts?.recursive) {
          await sandbox.fs.rm(realPath, { recursive: true, force: true });
          return;
        }
        const stats = await statOrUndefined(realPath);
        if (stats === undefined) {throw new NoSuchEntryError(realPath);}
        if (stats.isDirectory()) {
          await sandbox.fs.rmdir(realPath); // 空目录成功；非空抛 ENOTEMPTY（见头注释）。
        } else {
          await sandbox.fs.rm(realPath);
        }
      } catch (error) {
        throw translateFsError("rm", path, error);
      }
    },

    async mkdir(path: string): Promise<void> {
      try {
        await sandbox.fs.mkdir(real(path), { recursive: true });
      } catch (error) {
        throw translateFsError("mkdir", path, error);
      }
    },

    async readdir(path: string): Promise<DirEntry[]> {
      let entries;
      try {
        entries = await sandbox.fs.readdir(real(path), { withFileTypes: true });
      } catch (error) {
        throw translateFsError("readdir", path, error);
      }
      const result: DirEntry[] = entries.map((entry) => {
        const childPath = path === "/" ? `/${entry.name}` : `${path}/${entry.name}`;
        return entry.isDirectory()
          ? { name: entry.name, type: "dir" as const }
          : { name: entry.name, type: "file" as const, mimeType: inferMimeType(childPath) };
      });
      result.sort((a, b) => a.name.localeCompare(b.name));
      return result;
    },

    async stat(path: string): Promise<FileStat> {
      try {
        const stats = await sandbox.fs.stat(real(path));
        return toFileStat(stats, path);
      } catch (error) {
        throw translateFsError("stat", path, error);
      }
    },

    async glob(pattern: string): Promise<string[]> {
      const payload: FilesSearchPayload = {
        op: "files",
        rootPrefix: rootPrefixOf(root),
        startReal: toRealPath(root, staticPrefixDir(pattern)),
        patternSource: globToRegExp(pattern).source,
        ignoreSources: [], // 语义与重写前完全一致：不忽略任何路径（含 .git/node_modules）。
        limit: Number.MAX_SAFE_INTEGER, // 语义与重写前完全一致：不截断。
      };
      try {
        const result = parseFileSearchScriptOutput(await runSearchScript(sandbox, searchState, payload));
        return result.paths;
      } catch (error) {
        if (!(error instanceof SearchUnsupportedError)) {throw error;}
        const files = await walkFiles("/");
        return files.filter((p) => matchesGlob(pattern, p)).sort();
      }
    },

    searchFiles: (query: FileSearchQuery): Promise<FileSearchResult> => searchFilesNative(sandbox, root, searchState, query),
    searchContent: (query: ContentSearchQuery): Promise<ContentSearchResult> => searchContentNative(sandbox, root, searchState, query),
  };
}

/** `statOrUndefined` 判定路径不存在后，`rm` 内部合成的占位错误——立刻被 `translateFsError` 的 ENOENT 码翻译成 `NotFoundError`，不向外浮出。 */
class NoSuchEntryError extends Error {
  readonly code = "ENOENT";
  constructor(path: string) {
    super(`ENOENT: no such file or directory, rm '${path}'`);
  }
}
