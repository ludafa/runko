/**
 * `.`：Cloudflare Sandbox 网关的纯 fetch 客户端（任意 Node ≥20 进程）——`cloudflareWorkspace(opts)`
 * 返回 `NimboFS & NimboExec`，供 `createSession({ workspace })` 一次注入（docs/tech/core-sdk.md §4.5a 模式 A）。
 * 本文件与 `./worker`（`src/worker.ts`）通过 `src/protocol.ts` 的 zod schema 共用同一份 wire 契约；
 * 不 import `@cloudflare/sandbox`——这一侧只说 HTTP，不知道也不需要知道对面跑的是不是真沙盒。
 */
import { DirectoryNotEmptyError, NotFoundError, normalizePath } from "@nimbo/virtual-fs";
import type { DirEntry, ExecOptions, ExecRequest, ExecResult, FileStat, NimboExec, NimboFS } from "@nimbo/core";
import {
  AUTH_HEADER,
  DEFAULT_SANDBOX_ID,
  ENDPOINTS,
  errorBodySchema,
  execStreamEventSchema,
  globResponseSchema,
  okResponseSchema,
  readResponseSchema,
  readdirResponseSchema,
  SANDBOX_ID_HEADER,
  statResponseSchema,
} from "./protocol.js";
import type {
  ErrorBody,
  ExecExitEvent,
  ExecRequestBody,
  GlobRequest,
  GlobResponse,
  MkdirRequest,
  OkResponse,
  ReadRequest,
  ReadResponse,
  ReaddirRequest,
  ReaddirResponse,
  RmRequest,
  StatRequest,
  StatResponse,
  WriteRequest,
} from "./protocol.js";
import { z } from "zod";

export interface CloudflareWorkspaceOptions {
  url: string;
  token: string;
  sandboxId?: string;
  /** 注入自定义传输——测试用（直连内存网关 handler）或自定义中间层。默认 `globalThis.fetch`。 */
  fetch?: typeof globalThis.fetch;
}

const DESCRIBE = [
  'cloudflareWorkspace: Cloudflare Sandbox accessed through a self-deployed HTTP gateway ("./worker"\'s',
  "createSandboxGateway, running in the host's own wrangler project) — every NimboFS/NimboExec call is one",
  "HTTP round trip (tens to hundreds of ms), not an in-process operation.",
  "Real Linux container (Cloudflare Containers). Same-origin workspace (mode A): bash and the file tools read",
  "and write the exact same filesystem, so a bash redirect write is immediately visible to read-file and",
  "vice versa — there is nothing to reconcile.",
  'The virtual root "/" is anchored at the sandbox\'s own default working directory, not the container\'s real',
  "filesystem root — but this is not a VirtualFS-style security boundary: the container is real Linux, and",
  "anything the sandbox can execute (e.g. bash `cd /`) can reach the real root. Isolation is the boundary,",
  "not path validation.",
  'readdir/stat report type "file" for symlinks and other non-regular entries (no "reference" concept here);',
  "mtime comes from the container's real file modification time (commonly second-level precision).",
  "Scanning operations (globbing a large tree, grep-like search) cost one HTTP round trip per file tool call —",
  "prefer a single bash call (`find`/`grep`) for anything beyond a handful of files.",
  "Sandbox lifecycle (idle sleep, restarts, expiry) is managed by the host's wrangler project, not by this",
  "adapter — a stopped/unreachable sandbox surfaces as a gateway error from exec()/the file methods; the host",
  "is responsible for waking or recreating it.",
].join(" ");

const textEncoder = new TextEncoder();

/**
 * `Uint8Array` ↔ base64 往返，靠全局 `btoa`/`atob`（Node ≥18 与 Cloudflare Workers 都原生提供），
 * 不用 `Buffer`——这一侧刻意保持零 Node-only 便利 API，理由与 `./worker` 零 cloudflare import
 * 同源：本包的两个入口都应该能在对方的运行时环境里被复用而不报错。
 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {binary += String.fromCharCode(byte);}
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {bytes[i] = binary.charCodeAt(i);}
  return bytes;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ClientContext {
  fetchImpl: typeof fetch;
  baseUrl: string;
  token: string;
  sandboxId: string;
}

function requestInit<Req>(ctx: ClientContext, body: Req): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [AUTH_HEADER]: `Bearer ${ctx.token}`,
      [SANDBOX_ID_HEADER]: ctx.sandboxId,
    },
    body: JSON.stringify(body),
  };
}

async function parseErrorBody(res: Response): Promise<ErrorBody> {
  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    return { code: "sandbox_error", message: `gateway returned ${String(res.status)} ${res.statusText} with a non-JSON body` };
  }
  const parsed = errorBodySchema.safeParse(raw);
  if (!parsed.success) {return { code: "sandbox_error", message: `gateway returned ${String(res.status)} with an unrecognized error body` };}
  return parsed.data;
}

/** 把网关的 `{code,message}` 翻译成调用方能 `instanceof` 判别的错误——`path` 用调用方本地已知的值，不依赖 wire 回传。 */
async function fsErrorFromResponse(res: Response, path: string): Promise<Error> {
  const body = await parseErrorBody(res);
  if (body.code === "not_found") {return new NotFoundError(path);}
  if (body.code === "dir_not_empty") {return new DirectoryNotEmptyError(path);}
  return new Error(`cloudflare sandbox gateway error (${body.code}): ${body.message}`);
}

async function fsCall<Req, Res>(
  ctx: ClientContext,
  endpoint: string,
  req: Req,
  responseSchema: z.ZodType<Res>,
  errorPath: string,
): Promise<Res> {
  const res = await ctx.fetchImpl(`${ctx.baseUrl}${endpoint}`, requestInit(ctx, req));
  if (!res.ok) {throw await fsErrorFromResponse(res, errorPath);}
  const json: unknown = await res.json();
  return responseSchema.parse(json);
}

async function readFileImpl(ctx: ClientContext, path: string): Promise<Uint8Array> {
  const p = normalizePath(path);
  const { dataBase64 } = await fsCall<ReadRequest, ReadResponse>(ctx, ENDPOINTS.read, { path: p }, readResponseSchema, p);
  return base64ToBytes(dataBase64);
}

async function writeFileImpl(ctx: ClientContext, path: string, data: Uint8Array | string): Promise<void> {
  const p = normalizePath(path);
  const bytes = typeof data === "string" ? textEncoder.encode(data) : data;
  await fsCall<WriteRequest, OkResponse>(ctx, ENDPOINTS.write, { path: p, dataBase64: bytesToBase64(bytes) }, okResponseSchema, p);
}

async function rmImpl(ctx: ClientContext, path: string, opts?: { recursive?: boolean }): Promise<void> {
  const p = normalizePath(path);
  await fsCall<RmRequest, OkResponse>(ctx, ENDPOINTS.rm, { path: p, recursive: opts?.recursive }, okResponseSchema, p);
}

async function mkdirImpl(ctx: ClientContext, path: string): Promise<void> {
  const p = normalizePath(path);
  await fsCall<MkdirRequest, OkResponse>(ctx, ENDPOINTS.mkdir, { path: p }, okResponseSchema, p);
}

async function readdirImpl(ctx: ClientContext, path: string): Promise<DirEntry[]> {
  const p = normalizePath(path);
  const { entries } = await fsCall<ReaddirRequest, ReaddirResponse>(ctx, ENDPOINTS.readdir, { path: p }, readdirResponseSchema, p);
  return entries.map((entry) => ({ name: entry.name, type: entry.type }));
}

async function statImpl(ctx: ClientContext, path: string): Promise<FileStat> {
  const p = normalizePath(path);
  const res = await fsCall<StatRequest, StatResponse>(ctx, ENDPOINTS.stat, { path: p }, statResponseSchema, p);
  return {
    type: res.type,
    ...(res.size !== undefined ? { size: res.size } : {}),
    ...(res.mtime !== undefined ? { mtime: res.mtime } : {}),
  };
}

async function globImpl(ctx: ClientContext, pattern: string): Promise<string[]> {
  const { paths } = await fsCall<GlobRequest, GlobResponse>(ctx, ENDPOINTS.glob, { pattern }, globResponseSchema, pattern);
  return paths;
}

// ---- exec：NDJSON 流式解析 + 124/130 退出码归一（mini-bash/just-bash 的 raceAbort 保底先例）----

class CloudflareExecAbortedError extends Error {
  constructor(reason: "timeout" | "signal") {
    super(reason === "timeout" ? "cloudflareWorkspace: exec timed out" : "cloudflareWorkspace: exec aborted");
    this.name = "CloudflareExecAbortedError";
  }
}

/**
 * 同 mini-bash/just-bash 的 `raceAbort`：`signal` 先触发就立刻 reject，不等 `work` 真正
 * 落定——`work` 可能因为网络分区/网关挂死而长期不 settle，仅靠 fetch 自身的 `signal` 支持
 * 不足以保证"绝不永久挂起"。给 `work` 补一个空 catch，避免它在竞速结束后才 settle 时
 * 产生 unhandled rejection。
 */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const settleAborted = (): void => {
      work.catch(() => {});
      reject(new CloudflareExecAbortedError("signal"));
    };
    if (signal.aborted) {
      settleAborted();
      return;
    }
    const onAbort = (): void => settleAborted();
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** NDJSON 逐行解析：必须正确处理一行被 chunk 边界切断的情况——按 `\n` 切分前先攒一个跨 chunk 的 buffer。 */
async function readExecResultFromStream(res: Response, onOutput: ExecOptions["onOutput"], start: number): Promise<ExecResult> {
  if (res.body === null) {
    return { exitCode: 1, stdout: "", stderr: "cloudflareWorkspace: gateway response has no body", durationMs: Date.now() - start };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let exitEvent: ExecExitEvent | undefined;

  const processLine = (line: string): void => {
    const trimmed = line.trim();
    if (trimmed.length === 0) {return;}
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      return; // 网关协议不应产出坏行；防御性丢弃而不是让整次 exec 失败
    }
    const parsed = execStreamEventSchema.safeParse(raw);
    if (!parsed.success) {return;}
    if (parsed.data.type === "output") {
      onOutput?.({ stream: parsed.data.stream, data: parsed.data.data });
    } else {
      exitEvent = parsed.data;
    }
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {break;}
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        processLine(buffer.slice(0, newlineIndex));
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) {processLine(buffer);}
  } finally {
    reader.releaseLock();
  }

  if (exitEvent === undefined) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "cloudflareWorkspace: gateway stream ended without a final exit event",
      durationMs: Date.now() - start,
    };
  }
  return { exitCode: exitEvent.exitCode, stdout: exitEvent.stdout, stderr: exitEvent.stderr, durationMs: exitEvent.durationMs };
}

async function execImpl(ctx: ClientContext, req: ExecRequest, opts: ExecOptions | undefined): Promise<ExecResult> {
  const start = Date.now();
  const timeoutController = new AbortController();
  const timer = req.timeoutMs !== undefined ? setTimeout(() => timeoutController.abort(), req.timeoutMs) : undefined;
  const combined = AbortSignal.any([req.signal, timeoutController.signal]);

  const work = (async (): Promise<ExecResult> => {
    try {
      const cwd = req.cwd !== undefined ? normalizePath(req.cwd) : undefined;
      const body: ExecRequestBody = {
        command: req.command,
        ...(cwd !== undefined ? { cwd } : {}),
        ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
      };

      const res = await ctx.fetchImpl(`${ctx.baseUrl}${ENDPOINTS.exec}`, { ...requestInit(ctx, body), signal: combined });

      if (!res.ok) {
        const errorBody = await parseErrorBody(res);
        return {
          exitCode: 1,
          stdout: "",
          stderr: `cloudflareWorkspace: gateway rejected the exec request (${errorBody.code}): ${errorBody.message}`,
          durationMs: Date.now() - start,
        };
      }

      return await readExecResultFromStream(res, opts?.onOutput, start);
    } catch (error) {
      // P6-1：网络/网关不可达也必须 resolve 而不是 reject（也覆盖了上面 normalizePath(cwd) 可能
      // 抛出的 PathEscapesRootError——同一个"这次 exec 没跑起来"桶，指导文案里带上原始错误信息）。
      return {
        exitCode: 1,
        stdout: "",
        stderr:
          `cloudflareWorkspace: exec request failed: ${describeError(error)}. If this looks like a network error, check ` +
          `that the gateway worker at "${ctx.baseUrl}" is deployed and reachable, and that url/token/sandboxId are correct.`,
        durationMs: Date.now() - start,
      };
    }
  })();

  try {
    return await raceAbort(work, combined);
  } catch (error) {
    const timedOut = timeoutController.signal.aborted;
    if (error instanceof CloudflareExecAbortedError || timedOut) {
      return {
        exitCode: timedOut ? 124 : 130,
        stdout: "",
        stderr: timedOut ? `cloudflareWorkspace: exec timed out after ${String(req.timeoutMs)}ms` : "cloudflareWorkspace: exec aborted",
        durationMs: Date.now() - start,
      };
    }
    return { exitCode: 1, stdout: "", stderr: `cloudflareWorkspace: internal error: ${describeError(error)}`, durationMs: Date.now() - start };
  } finally {
    if (timer !== undefined) {clearTimeout(timer);}
  }
}

export function cloudflareWorkspace(opts: CloudflareWorkspaceOptions): NimboFS & NimboExec {
  const ctx: ClientContext = {
    fetchImpl: opts.fetch ?? globalThis.fetch,
    baseUrl: opts.url.endsWith("/") ? opts.url.slice(0, -1) : opts.url,
    token: opts.token,
    sandboxId: opts.sandboxId ?? DEFAULT_SANDBOX_ID,
  };

  return {
    // docs/tech/single-ledger.md §6.1（@nimbo/core 审批三值重构，P13-5-2c）：旧 "never" → "allow"（沙盒实现，隔离即边界）。
    defaultApproval: "allow",
    describe(): string {
      return DESCRIBE;
    },
    readFile: (path) => readFileImpl(ctx, path),
    writeFile: (path, data) => writeFileImpl(ctx, path, data),
    rm: (path, rmOpts) => rmImpl(ctx, path, rmOpts),
    mkdir: (path) => mkdirImpl(ctx, path),
    readdir: (path) => readdirImpl(ctx, path),
    stat: (path) => statImpl(ctx, path),
    glob: (pattern) => globImpl(ctx, pattern),
    exec: (req, execOpts) => execImpl(ctx, req, execOpts),
  };
}
