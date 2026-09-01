/**
 * 测试共享辅助（不是 *.test.ts，vitest 不会当测试文件收集）。`FakeCfSandbox` 是
 * `CfSandboxLike` 的进程内实现——内存路径树 + 一个可编程的 `execHandler`（未提供
 * 时退化为一个极简的 echo/重定向解释器，够用来跑通 e2e 里的 bash 工具）。
 *
 * 内部路径全部是"沙盒相对路径"（沙盒自身默认 cwd 记作 "."，子路径不带前导斜杠，
 * 如 "a/b.txt"）——正是 `src/worker.ts` 里 `toSandboxPath()` 换算之后送进
 * `CfSandboxLike` 各方法的那种形状，与 NimboFS 那套 "/" 开头的虚拟绝对路径是两个
 * 独立的坐标系，测试断言时不要混用。
 */
import type {
  CfDeleteFileResult,
  CfExecOptions,
  CfExecResult,
  CfFileInfo,
  CfListFilesResult,
  CfMkdirResult,
  CfReadFileResult,
  CfSandboxLike,
  CfWriteFileResult,
  SandboxGateway,
} from "../src/worker.js";

interface FakeEntry {
  kind: "file" | "dir";
  data?: Uint8Array;
  mtimeMs: number;
}

function normalizeSandboxPath(path: string): string {
  if (path === "." || path === "" || path === "/") {return ".";}
  const segments = path.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  return segments.length === 0 ? "." : segments.join("/");
}

function sandboxDirname(path: string): string {
  if (path === ".") {return ".";}
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "." : path.slice(0, idx);
}

function sandboxBasename(path: string): string {
  if (path === ".") {return ".";}
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

/** `"echo foo"` / `"echo -n foo"` 形状的命令的文本负载；不是这类命令则 `undefined`。 */
function extractEchoText(command: string): string | undefined {
  const trimmed = command.trim();
  if (!trimmed.startsWith("echo ")) {return undefined;}
  const rest = trimmed.slice("echo ".length);
  return rest.startsWith("-n ") ? rest.slice("-n ".length) : rest;
}

export type FakeExecHandler = (command: string, options: CfExecOptions) => Promise<CfExecResult> | CfExecResult;

export interface FakeCfSandboxOptions {
  /** 初始文件：key 是沙盒相对路径（如 "a/b.txt"；根用 "." 或省略）。 */
  files?: Record<string, string | Uint8Array>;
  /** 提供时接管全部 `exec()` 调用（用于 abort/timeout/自定义退出码等场景）。 */
  execHandler?: FakeExecHandler;
}

export class FakeCfSandbox implements CfSandboxLike {
  private readonly entries = new Map<string, FakeEntry>();
  private clock = 0;
  private readonly execHandler: FakeExecHandler | undefined;

  constructor(opts: FakeCfSandboxOptions = {}) {
    this.entries.set(".", { kind: "dir", mtimeMs: this.nextMtime() });
    for (const [rawPath, content] of Object.entries(opts.files ?? {})) {
      const path = normalizeSandboxPath(rawPath);
      this.ensureParentDirs(path);
      const data = typeof content === "string" ? new TextEncoder().encode(content) : content;
      this.entries.set(path, { kind: "file", data, mtimeMs: this.nextMtime() });
    }
    this.execHandler = opts.execHandler;
  }

  /** 单调递增，同一毫秒内的连续写入也严格递增（同 MemoryFS 先例）。 */
  private nextMtime(): number {
    const now = Date.now();
    this.clock = now > this.clock ? now : this.clock + 1;
    return this.clock;
  }

  private ensureDir(path: string): void {
    if (path === ".") {return;}
    const existing = this.entries.get(path);
    if (existing?.kind === "dir") {return;}
    if (existing?.kind === "file") {throw new Error(`FakeCfSandbox: "${path}" already exists as a file`);}
    this.ensureDir(sandboxDirname(path));
    this.entries.set(path, { kind: "dir", mtimeMs: this.nextMtime() });
  }

  private ensureParentDirs(path: string): void {
    this.ensureDir(sandboxDirname(path));
  }

  async exec(command: string, options: CfExecOptions = {}): Promise<CfExecResult> {
    if (this.execHandler) {return this.execHandler(command, options);}
    return this.runBuiltinCommand(command, options);
  }

  /**
   * 内置的极简解释器：只认 `echo [-n] <text>` 与 `echo [-n] <text> > <path>` 两种形状，
   * 够用来在 e2e 测试里跑通"bash 工具产出预期输出"与"bash 重定向写入使 readState 失效"
   * 两条断言，不追求真正的 shell 语义。echo（无重定向）分两段触发 `onOutput`，模拟真实
   * 沙盒的分片流式输出——验证客户端 NDJSON 解析能正确拼回完整内容。
   */
  private runBuiltinCommand(command: string, options: CfExecOptions): CfExecResult {
    const start = Date.now();
    const trimmed = command.trim();
    const redirectIdx = trimmed.indexOf(" > ");
    if (redirectIdx !== -1) {
      const left = trimmed.slice(0, redirectIdx);
      const text = extractEchoText(left);
      if (text !== undefined) {
        const targetPath = normalizeSandboxPath(trimmed.slice(redirectIdx + 3).trim());
        this.ensureParentDirs(targetPath);
        this.entries.set(targetPath, { kind: "file", data: new TextEncoder().encode(text), mtimeMs: this.nextMtime() });
        return { exitCode: 0, stdout: "", stderr: "", duration: Date.now() - start };
      }
    }
    const text = extractEchoText(trimmed);
    if (text !== undefined) {
      const half = Math.max(1, Math.floor(text.length / 2));
      options.onOutput?.("stdout", text.slice(0, half));
      options.onOutput?.("stdout", `${text.slice(half)}\n`);
      return { exitCode: 0, stdout: `${text}\n`, stderr: "", duration: Date.now() - start };
    }
    return { exitCode: 127, stdout: "", stderr: `FakeCfSandbox: unrecognized command "${trimmed}"`, duration: Date.now() - start };
  }

  async readFile(path: string, options?: { encoding?: "utf-8" | "base64" }): Promise<CfReadFileResult> {
    const p = normalizeSandboxPath(path);
    const entry = this.entries.get(p);
    if (entry === undefined || entry.kind !== "file") {throw new Error(`FakeCfSandbox: no such file "${p}"`);}
    const data = entry.data ?? new Uint8Array();
    if (options?.encoding === "utf-8") {return { content: new TextDecoder().decode(data) };}
    return { content: Buffer.from(data).toString("base64") };
  }

  async writeFile(path: string, content: string, options?: { encoding?: "utf-8" | "base64" }): Promise<CfWriteFileResult> {
    const p = normalizeSandboxPath(path);
    if (this.entries.get(p)?.kind === "dir") {throw new Error(`FakeCfSandbox: "${p}" is a directory`);}
    this.ensureParentDirs(p);
    const data = options?.encoding === "utf-8" ? new TextEncoder().encode(content) : new Uint8Array(Buffer.from(content, "base64"));
    this.entries.set(p, { kind: "file", data, mtimeMs: this.nextMtime() });
    return { success: true };
  }

  async mkdir(path: string): Promise<CfMkdirResult> {
    this.ensureDir(normalizeSandboxPath(path));
    return { success: true };
  }

  async deleteFile(path: string): Promise<CfDeleteFileResult> {
    const p = normalizeSandboxPath(path);
    const entry = this.entries.get(p);
    if (entry === undefined) {throw new Error(`FakeCfSandbox: no such file or directory "${p}"`);}
    if (entry.kind === "dir") {
      const prefix = p === "." ? "" : `${p}/`;
      for (const key of [...this.entries.keys()]) {
        if (key !== p && (p === "." || key.startsWith(prefix))) {this.entries.delete(key);}
      }
    }
    this.entries.delete(p);
    return { success: true };
  }

  async listFiles(path: string, options?: { recursive?: boolean }): Promise<CfListFilesResult> {
    const p = normalizeSandboxPath(path);
    const dirEntry = this.entries.get(p);
    if (dirEntry === undefined || dirEntry.kind !== "dir") {throw new Error(`FakeCfSandbox: not a directory "${p}"`);}
    const recursive = options?.recursive === true;
    const prefix = p === "." ? "" : `${p}/`;
    const files: CfFileInfo[] = [];
    for (const [key, entry] of this.entries) {
      if (key === p) {continue;}
      if (!(p === "." || key.startsWith(prefix))) {continue;}
      const rest = p === "." ? key : key.slice(prefix.length);
      if (!recursive && rest.includes("/")) {continue;}
      files.push({
        name: sandboxBasename(key),
        relativePath: rest,
        type: entry.kind === "dir" ? "directory" : "file",
        size: entry.data?.byteLength ?? 0,
        modifiedAt: new Date(entry.mtimeMs).toISOString(),
      });
    }
    return { files };
  }
}

/**
 * 进程内对接客户端与网关：不发起真实网络请求，直接把 `fetch()` 的 `(input, init)`
 * 重新包成 `Request` 交给 `gateway.fetch()`——七方法 + exec 的全部编解码（zod parse、
 * base64、NDJSON 分帧）因此都走真实 wire 路径，只是省掉了真实 TCP/HTTP 层（docs/tech/sandbox.md §8.4
 * "CF 客户端+网关在进程内对接测试"）。
 */
export function fetchViaGateway(gateway: SandboxGateway): typeof fetch {
  return async (input, init) => gateway.fetch(new Request(input, init));
}
