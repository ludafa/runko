/**
 * `./worker`：Cloudflare Sandbox 网关（部署在宿主自己的 wrangler 项目里）。
 * 把 `src/protocol.ts` 的八个端点翻译成对注入的 `CfSandboxLike` 的调用——本文件
 * **零 `@cloudflare/sandbox` import**（该包加载依赖 `cloudflare:workers` 内置模块，
 * Node 下不可加载，见 docs/host/sandbox/tech.md §8.2/§4"包本体零
 * cloudflare import"）：`CfSandboxLike` 是以该包 0.12.3 版本 `ISandbox` d.ts 为
 * 蓝本手写的结构化最小子集，真实装配（`getSandbox(env.Sandbox, id)` 返回值天然
 * 结构兼容本接口）留给宿主项目经 `createSandboxGateway({ getSandbox })` 注入。
 *
 * ---- 路径锚定：虚拟根 "/" ↔ 沙盒默认 cwd（工单裁量，见协议表 §8.3 附近注释）----
 *
 * `@cloudflare/sandbox` 的文件/目录方法把"/"开头的路径当作容器真实绝对路径、
 * 把不带前导斜杠的路径当作相对于沙盒自身默认工作目录（其官方文档称之为
 * "/workspace"）解析——这与 E2B/Vercel 适配器"client 端 `opts.root` 选项做
 * 虚拟根↔真实目录换算"的形状不同：Cloudflare 网关没有 root 配置（`cloudflareWorkspace`
 * 的选项里也确实没有 root 字段），换算发生在**网关**这一侧、且是隐式的——
 * `toSandboxPath()` 把客户端送来的虚拟绝对路径（`normalizePath()` 产出，形如
 * "/" 或 "/a/b.txt"）去掉前导斜杠变成沙盒相对路径（"." 或 "a/b.txt"），从而让
 * 沙盒自己的默认工作目录天然充当虚拟根——不需要任何一侧显式配置真实目录。
 */
import { basename, dirname, matchesGlob, normalizePath } from "@nimbo/virtual-fs";
import { z } from "zod";
import {
  AUTH_HEADER,
  DEFAULT_SANDBOX_ID,
  ENDPOINTS,
  execExitEventSchema,
  execRequestSchema,
  globRequestSchema,
  mkdirRequestSchema,
  NDJSON_CONTENT_TYPE,
  readRequestSchema,
  readdirRequestSchema,
  rmRequestSchema,
  SANDBOX_ID_HEADER,
  statRequestSchema,
  writeRequestSchema,
} from "./protocol.js";
import type {
  ErrorBody,
  ErrorCode,
  ExecRequestBody,
  ExecStreamEvent,
  GlobResponse,
  OkResponse,
  ReadResponse,
  ReaddirResponse,
  StatResponse,
  WireDirEntry,
} from "./protocol.js";

// ---- CfSandboxLike：@cloudflare/sandbox ISandbox 的结构化最小子集 ----

export interface CfExecOptions {
  cwd?: string;
  timeout?: number;
  signal?: AbortSignal;
  stream?: boolean;
  onOutput?: (stream: "stdout" | "stderr", data: string) => void;
}

export interface CfExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** 毫秒——真实 SDK 字段名是 `duration`（非 `durationMs`），网关翻译时改名对齐协议。 */
  duration: number;
}

export interface CfReadFileResult {
  content: string;
}

export interface CfWriteFileResult {
  success: boolean;
}

export interface CfMkdirResult {
  success: boolean;
}

export interface CfDeleteFileResult {
  success: boolean;
}

export type CfFileInfoType = "file" | "directory" | "symlink" | "other";

export interface CfFileInfo {
  name: string;
  /** 相对 `listFiles()` 调用的 `path` 参数；glob 端点据此拼回虚拟绝对路径。 */
  relativePath: string;
  type: CfFileInfoType;
  size: number;
  /** ISO 8601——网关翻译成 epoch ms 填 `StatResponse.mtime`。 */
  modifiedAt: string;
}

export interface CfListFilesResult {
  files: CfFileInfo[];
}

/**
 * `@cloudflare/sandbox` 0.12.3 的 `ISandbox` 接口的结构化最小子集——只收本网关
 * 实际调用的方法面（`exec`/`readFile`/`writeFile`/`mkdir`/`deleteFile`/`listFiles`）。
 */
export interface CfSandboxLike {
  exec(command: string, options?: CfExecOptions): Promise<CfExecResult>;
  readFile(path: string, options?: { encoding?: "utf-8" | "base64" }): Promise<CfReadFileResult>;
  writeFile(path: string, content: string, options?: { encoding?: "utf-8" | "base64" }): Promise<CfWriteFileResult>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<CfMkdirResult>;
  deleteFile(path: string): Promise<CfDeleteFileResult>;
  listFiles(path: string, options?: { recursive?: boolean }): Promise<CfListFilesResult>;
}

export interface SandboxGatewayOptions {
  token: string;
  getSandbox: (sandboxId: string) => CfSandboxLike | Promise<CfSandboxLike>;
}

export interface SandboxGateway {
  fetch(request: Request): Promise<Response>;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jsonResponse<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function errorResponse(status: number, code: ErrorCode, message: string): Response {
  const body: ErrorBody = { code, message };
  return jsonResponse(body, status);
}

/** 虚拟绝对路径 → 沙盒路径：见文件头"路径锚定"注释。 */
function toSandboxPath(virtualPath: string): string {
  return virtualPath === "/" ? "." : virtualPath.slice(1);
}

type NormalizeResult = { ok: true; path: string } | { ok: false; response: Response };

function normalizeOrBadRequest(rawPath: string): NormalizeResult {
  try {
    return { ok: true, path: normalizePath(rawPath) };
  } catch (error) {
    return { ok: false, response: errorResponse(400, "bad_request", `invalid path "${rawPath}": ${describeError(error)}`) };
  }
}

async function withValidatedBody<Req>(
  request: Request,
  schema: z.ZodType<Req>,
  handler: (body: Req) => Promise<Response>,
): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse(400, "bad_request", "request body is not valid JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, "bad_request", `request body failed validation: ${parsed.error.message}`);
  }
  return handler(parsed.data);
}

/** `read/mkdir/readdir/stat` 四个 `{ path }` 形状的端点共用：先校验+规范化 path 再交给业务 handler。 */
async function withNormalizedPath<Req extends { path: string }>(
  body: Req,
  handler: (virtualPath: string, body: Req) => Promise<Response>,
): Promise<Response> {
  const normalized = normalizeOrBadRequest(body.path);
  if (!normalized.ok) return normalized.response;
  return handler(normalized.path, body);
}

/** stat("/") 没有对应的"父目录条目"可查——合成一个恒为目录的条目代表虚拟根本身。 */
const ROOT_ENTRY: CfFileInfo = { name: "", relativePath: "", type: "directory", size: 0, modifiedAt: new Date(0).toISOString() };

type EntryLookup = { found: true; entry: CfFileInfo } | { found: false };

/** 工单要求的 "stat 经 listFiles(dirname) 找条目" 策略——stat/readdir/rm 三个端点共用。 */
async function findEntry(sandbox: CfSandboxLike, virtualPath: string): Promise<EntryLookup> {
  if (virtualPath === "/") return { found: true, entry: ROOT_ENTRY };
  const parentVirtual = dirname(virtualPath);
  let listing: CfListFilesResult;
  try {
    listing = await sandbox.listFiles(toSandboxPath(parentVirtual), { recursive: false });
  } catch {
    return { found: false };
  }
  const name = basename(virtualPath);
  const entry = listing.files.find((f) => f.name === name);
  return entry === undefined ? { found: false } : { found: true, entry };
}

/** `CfFileInfo.type` → `FileStat.type`：沙盒工作区没有 reference 概念（§3.1），symlink/other 一律按 file 呈现。 */
function mapEntryType(type: CfFileInfoType): "file" | "dir" {
  return type === "directory" ? "dir" : "file";
}

function toStatResponse(entry: CfFileInfo): StatResponse {
  const type = mapEntryType(entry.type);
  const mtimeMs = Date.parse(entry.modifiedAt);
  return {
    type,
    ...(type === "file" ? { size: entry.size } : {}),
    ...(Number.isFinite(mtimeMs) ? { mtime: mtimeMs } : {}),
  };
}

/** existence/kind 查不出更具体原因时的兜底翻译：找不到→404，是目录→400 not_dir，否则→500 sandbox_error。 */
async function translateFsError(sandbox: CfSandboxLike, virtualPath: string, error: unknown): Promise<Response> {
  const lookup = await findEntry(sandbox, virtualPath);
  if (!lookup.found) return errorResponse(404, "not_found", `no such file or directory: "${virtualPath}"`);
  if (lookup.entry.type === "directory") return errorResponse(400, "not_dir", `"${virtualPath}" is a directory: ${describeError(error)}`);
  return errorResponse(500, "sandbox_error", `sandbox operation failed for "${virtualPath}": ${describeError(error)}`);
}

async function handleRead(sandbox: CfSandboxLike, virtualPath: string): Promise<Response> {
  try {
    const result = await sandbox.readFile(toSandboxPath(virtualPath), { encoding: "base64" });
    return jsonResponse<ReadResponse>({ dataBase64: result.content });
  } catch (error) {
    return translateFsError(sandbox, virtualPath, error);
  }
}

async function handleWrite(sandbox: CfSandboxLike, virtualPath: string, dataBase64: string): Promise<Response> {
  try {
    // NimboFS.writeFile() 隐含 "mkdir -p" 父目录的语义（MemoryFS/OverlayFS 皆如此，见
    // packages/virtual-fs/src/memory.ts 的 ensureParentDirs）——沙盒侧显式补上这一步。
    await sandbox.mkdir(toSandboxPath(dirname(virtualPath)), { recursive: true });
    await sandbox.writeFile(toSandboxPath(virtualPath), dataBase64, { encoding: "base64" });
    return jsonResponse<OkResponse>({ ok: true });
  } catch (error) {
    return translateFsError(sandbox, virtualPath, error);
  }
}

async function handleMkdir(sandbox: CfSandboxLike, virtualPath: string): Promise<Response> {
  try {
    await sandbox.mkdir(toSandboxPath(virtualPath), { recursive: true });
    return jsonResponse<OkResponse>({ ok: true });
  } catch (error) {
    return translateFsError(sandbox, virtualPath, error);
  }
}

async function handleReaddir(sandbox: CfSandboxLike, virtualPath: string): Promise<Response> {
  const lookup = await findEntry(sandbox, virtualPath);
  if (!lookup.found) return errorResponse(404, "not_found", `no such file or directory: "${virtualPath}"`);
  if (lookup.entry.type !== "directory") return errorResponse(400, "not_dir", `"${virtualPath}" is not a directory`);
  try {
    const listing = await sandbox.listFiles(toSandboxPath(virtualPath), { recursive: false });
    const entries: WireDirEntry[] = listing.files.map((f) => ({ name: f.name, type: mapEntryType(f.type) }));
    return jsonResponse<ReaddirResponse>({ entries });
  } catch (error) {
    return errorResponse(500, "sandbox_error", `failed to list "${virtualPath}": ${describeError(error)}`);
  }
}

async function handleStat(sandbox: CfSandboxLike, virtualPath: string): Promise<Response> {
  const lookup = await findEntry(sandbox, virtualPath);
  if (!lookup.found) return errorResponse(404, "not_found", `no such file or directory: "${virtualPath}"`);
  return jsonResponse<StatResponse>(toStatResponse(lookup.entry));
}

async function handleGlob(sandbox: CfSandboxLike, pattern: string): Promise<Response> {
  try {
    // 递归列出沙盒默认 cwd（虚拟根 "."）下的全部条目，网关侧用 matchesGlob 过滤——
    // 不依赖沙盒内 `find` 命令是否存在，行为与 E2B/Vercel 两个适配器一致（docs/host/sandbox/tech.md §4.4）。
    const listing = await sandbox.listFiles(".", { recursive: true });
    const paths = listing.files
      .filter((f) => f.type !== "directory") // NimboFS.glob 只匹配文件（MemoryFS 先例）
      .map((f) => `/${f.relativePath}`)
      .filter((virtualPath) => matchesGlob(pattern, virtualPath))
      .sort();
    return jsonResponse<GlobResponse>({ paths });
  } catch (error) {
    return errorResponse(500, "sandbox_error", `glob failed for pattern "${pattern}": ${describeError(error)}`);
  }
}

async function handleRm(sandbox: CfSandboxLike, virtualPath: string, recursive: boolean | undefined): Promise<Response> {
  if (virtualPath === "/") return errorResponse(400, "bad_request", 'cannot remove the virtual root "/"');

  const lookup = await findEntry(sandbox, virtualPath);
  if (!lookup.found) return errorResponse(404, "not_found", `no such file or directory: "${virtualPath}"`);

  const sandboxPath = toSandboxPath(virtualPath);
  if (lookup.entry.type === "directory" && recursive !== true) {
    let childCount = 0;
    try {
      const children = await sandbox.listFiles(sandboxPath, { recursive: false });
      childCount = children.files.length;
    } catch {
      childCount = 0;
    }
    if (childCount > 0) {
      return errorResponse(409, "dir_not_empty", `directory not empty (pass { recursive: true } to delete): "${virtualPath}"`);
    }
  }

  try {
    await sandbox.deleteFile(sandboxPath);
    return jsonResponse<OkResponse>({ ok: true });
  } catch (error) {
    return errorResponse(500, "sandbox_error", `failed to delete "${virtualPath}": ${describeError(error)}`);
  }
}

const textEncoder = new TextEncoder();

function ndjsonLine(event: ExecStreamEvent): Uint8Array {
  return textEncoder.encode(`${JSON.stringify(event)}\n`);
}

/**
 * `/exec`：NDJSON 流式响应。响应对象立即返回（`readable` 端交给 `Response`），
 * 真正跑命令的工作在一个不 await 的后台 IIFE 里进行，通过 `TransformStream` 的
 * `writable` 端把 N 个 output 事件 + 1 个终块 exit 事件逐行写入——客户端读到
 * 流结束（`writer.close()`）即视为命令完成。
 */
async function handleExec(sandbox: CfSandboxLike, body: ExecRequestBody, requestSignal: AbortSignal): Promise<Response> {
  let sandboxCwd: string | undefined;
  if (body.cwd !== undefined) {
    const normalized = normalizeOrBadRequest(body.cwd);
    if (!normalized.ok) return normalized.response;
    sandboxCwd = toSandboxPath(normalized.path);
  }

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const writeEvent = (event: ExecStreamEvent): void => {
    void writer.write(ndjsonLine(event)).catch(() => {});
  };

  void (async (): Promise<void> => {
    const start = Date.now();
    try {
      const result = await sandbox.exec(body.command, {
        cwd: sandboxCwd,
        timeout: body.timeoutMs,
        signal: requestSignal,
        stream: true,
        onOutput: (stream, data) => writeEvent({ type: "output", stream, data }),
      });
      const exitEvent = execExitEventSchema.parse({
        type: "exit",
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.duration,
      });
      writeEvent(exitEvent);
    } catch (error) {
      writeEvent({
        type: "exit",
        exitCode: 1,
        stdout: "",
        stderr: `sandbox exec failed: ${describeError(error)}`,
        durationMs: Date.now() - start,
      });
    } finally {
      await writer.close().catch(() => {});
    }
  })();

  return new Response(readable, { status: 200, headers: { "content-type": NDJSON_CONTENT_TYPE } });
}

export function createSandboxGateway(opts: SandboxGatewayOptions): SandboxGateway {
  return {
    async fetch(request: Request): Promise<Response> {
      const authHeader = request.headers.get(AUTH_HEADER);
      if (authHeader !== `Bearer ${opts.token}`) {
        return errorResponse(401, "unauthorized", "missing or invalid bearer token");
      }

      const sandboxId = request.headers.get(SANDBOX_ID_HEADER) ?? DEFAULT_SANDBOX_ID;
      let sandbox: CfSandboxLike;
      try {
        sandbox = await opts.getSandbox(sandboxId);
      } catch (error) {
        return errorResponse(500, "sandbox_error", `getSandbox("${sandboxId}") failed: ${describeError(error)}`);
      }

      const pathname = new URL(request.url).pathname;
      switch (pathname) {
        case ENDPOINTS.read:
          return withValidatedBody(request, readRequestSchema, (body) => withNormalizedPath(body, (path) => handleRead(sandbox, path)));
        case ENDPOINTS.write:
          return withValidatedBody(request, writeRequestSchema, (body) =>
            withNormalizedPath(body, (path, b) => handleWrite(sandbox, path, b.dataBase64)),
          );
        case ENDPOINTS.rm:
          return withValidatedBody(request, rmRequestSchema, (body) =>
            withNormalizedPath(body, (path, b) => handleRm(sandbox, path, b.recursive)),
          );
        case ENDPOINTS.mkdir:
          return withValidatedBody(request, mkdirRequestSchema, (body) => withNormalizedPath(body, (path) => handleMkdir(sandbox, path)));
        case ENDPOINTS.readdir:
          return withValidatedBody(request, readdirRequestSchema, (body) => withNormalizedPath(body, (path) => handleReaddir(sandbox, path)));
        case ENDPOINTS.stat:
          return withValidatedBody(request, statRequestSchema, (body) => withNormalizedPath(body, (path) => handleStat(sandbox, path)));
        case ENDPOINTS.glob:
          return withValidatedBody(request, globRequestSchema, (body) => handleGlob(sandbox, body.pattern));
        case ENDPOINTS.exec:
          return withValidatedBody(request, execRequestSchema, (body) => handleExec(sandbox, body, request.signal));
        default:
          return errorResponse(404, "not_found", `unknown endpoint: ${pathname}`);
      }
    },
  };
}
