/**
 * 测试共享辅助（不是 *.test.ts，vitest 不会当测试文件收集）。同
 * `@nimbo/just-bash`/`@nimbo/mini-bash` 的 `test/helpers.ts` 先例。
 *
 * `FakeVercelSandbox` 实现 `VercelSandboxLike`，进程内跑，不碰网络：
 * - `fs`：一棵内存路径树，精确复刻实测过的 node `fs.promises` 怪癖——
 *   `rm(path)`（非递归）对**任何**目录都抛 `ERR_FS_EISDIR`（不分空/非空），
 *   `rmdir(path)` 才是"空成功、非空 ENOTEMPTY"的那一个（`src/fs.ts` 头注释
 *   记录的实测发现，这里在 fake 里复现，好让契约测试真的锁住这条分流逻辑，
 *   而不是被一个"过于宽容"的 fake 悄悄放过）；`writeFile` 要求父目录已存在
 *   （node 原生不会自动建父目录，`src/fs.ts` 的 `ensureParentDir` 正是为了
 *   补这一课）。
 * - `runCommand`：默认实现只记录调用、立即 resolve `exitCode: 0`；每个测试
 *   按需传入 `runCommandImpl` 精确控制输出时序/超时/异常，覆盖 exec 契约。
 */
import { Writable } from "node:stream";
import type {
  VercelDirentLike,
  VercelFileSystemLike,
  VercelRunCommandParams,
  VercelSandboxLike,
  VercelStatsLike,
} from "../src/types.js";

/** 构造带 `.code` 字符串字段的 Error——`Object.assign` 而非类型断言，结构天然满足 `NodeJS.ErrnoException`。 */
function errnoError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

type Entry = { kind: "file"; data: Uint8Array; mtimeMs: number } | { kind: "dir"; mtimeMs: number };

function dirnameOf(path: string): string {
  if (path === "/") return "/";
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? "/" : path.slice(0, idx);
}

function basenameOf(path: string): string {
  if (path === "/") return "/";
  return path.slice(path.lastIndexOf("/") + 1);
}

/** 内存路径树 + node `fs.promises` 怪癖复刻。键是完整真实路径（如 `/vercel/sandbox/a.txt`）。 */
export class FakeFileSystem implements VercelFileSystemLike {
  private entries = new Map<string, Entry>();
  private clock = 0;

  /** `files` 的键是虚拟路径（"/a.txt"）——按 `root` 前缀换算成真实路径后再入树，与 `src/path.ts` 的锚定约定一致。 */
  constructor(root: string, files: Record<string, string | Uint8Array> = {}) {
    this.entries.set(root, { kind: "dir", mtimeMs: this.nextMtime() });
    this.ensureDir(dirnameOf(root));
    for (const [virtualPath, data] of Object.entries(files)) {
      const realPath = root === "/" ? virtualPath : `${root}${virtualPath}`;
      this.ensureDir(dirnameOf(realPath));
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
      this.entries.set(realPath, { kind: "file", data: bytes, mtimeMs: this.nextMtime() });
    }
  }

  private nextMtime(): number {
    this.clock += 1;
    return this.clock;
  }

  private ensureDir(path: string): void {
    if (this.entries.has(path)) return;
    if (path !== "/") this.ensureDir(dirnameOf(path));
    this.entries.set(path, { kind: "dir", mtimeMs: this.nextMtime() });
  }

  private kindOf(path: string): "file" | "dir" | undefined {
    const entry = this.entries.get(path);
    return entry?.kind;
  }

  async readFile(path: string): Promise<Uint8Array> {
    const entry = this.entries.get(path);
    if (entry === undefined) throw errnoError("ENOENT", `ENOENT: no such file or directory, open '${path}'`);
    if (entry.kind === "dir") throw errnoError("EISDIR", `EISDIR: illegal operation on a directory, read '${path}'`);
    return entry.data;
  }

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    const parentKind = this.kindOf(dirnameOf(path));
    if (parentKind === undefined) throw errnoError("ENOENT", `ENOENT: no such file or directory, open '${path}'`);
    if (parentKind === "file") throw errnoError("ENOTDIR", `ENOTDIR: not a directory, open '${path}'`);
    if (this.kindOf(path) === "dir") throw errnoError("EISDIR", `EISDIR: illegal operation on a directory, open '${path}'`);
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    this.entries.set(path, { kind: "file", data: bytes, mtimeMs: this.nextMtime() });
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined> {
    if (this.kindOf(path) === "dir") return undefined;
    if (this.kindOf(path) === "file") throw errnoError("EEXIST", `EEXIST: file already exists, mkdir '${path}'`);
    if (options?.recursive) {
      this.ensureDir(path);
      return path;
    }
    const parentKind = this.kindOf(dirnameOf(path));
    if (parentKind !== "dir") throw errnoError("ENOENT", `ENOENT: no such file or directory, mkdir '${path}'`);
    this.entries.set(path, { kind: "dir", mtimeMs: this.nextMtime() });
    return path;
  }

  async readdir(path: string, _options: { withFileTypes: true }): Promise<VercelDirentLike[]> {
    const kind = this.kindOf(path);
    if (kind === undefined) throw errnoError("ENOENT", `ENOENT: no such file or directory, scandir '${path}'`);
    if (kind === "file") throw errnoError("ENOTDIR", `ENOTDIR: not a directory, scandir '${path}'`);
    const results: VercelDirentLike[] = [];
    for (const [candidate, entry] of this.entries) {
      if (candidate === path) continue;
      if (dirnameOf(candidate) !== path) continue;
      const name = basenameOf(candidate);
      results.push({ name, isDirectory: () => entry.kind === "dir", isFile: () => entry.kind === "file" });
    }
    return results;
  }

  async stat(path: string): Promise<VercelStatsLike> {
    const entry = this.entries.get(path);
    if (entry === undefined) throw errnoError("ENOENT", `ENOENT: no such file or directory, stat '${path}'`);
    return {
      isDirectory: () => entry.kind === "dir",
      isFile: () => entry.kind === "file",
      size: entry.kind === "file" ? entry.data.byteLength : 0,
      mtimeMs: entry.mtimeMs,
    };
  }

  /** 实测的真实 node 怪癖：非递归对**任何**目录恒抛 EISDIR，不区分空/非空——见本文件头注释、`src/fs.ts` 头注释。 */
  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    const kind = this.kindOf(path);
    if (kind === undefined) {
      if (options?.force) return;
      throw errnoError("ENOENT", `ENOENT: no such file or directory, rm '${path}'`);
    }
    if (kind === "dir" && !options?.recursive) {
      throw errnoError("ERR_FS_EISDIR", `Path is a directory: rm returned EISDIR (is a directory) ${path}`);
    }
    if (kind === "dir" && options?.recursive) {
      const prefix = `${path}/`;
      for (const candidate of [...this.entries.keys()]) {
        if (candidate.startsWith(prefix)) this.entries.delete(candidate);
      }
    }
    this.entries.delete(path);
  }

  /** 真实 node 怪癖：空目录成功、非空 ENOTEMPTY——`src/fs.ts` 靠这个方法而非 `rm()` 实现非递归删除目录。 */
  async rmdir(path: string): Promise<void> {
    const kind = this.kindOf(path);
    if (kind === undefined) throw errnoError("ENOENT", `ENOENT: no such file or directory, rmdir '${path}'`);
    if (kind === "file") throw errnoError("ENOTDIR", `ENOTDIR: not a directory, rmdir '${path}'`);
    const prefix = `${path}/`;
    const hasChildren = [...this.entries.keys()].some((candidate) => candidate.startsWith(prefix));
    if (hasChildren) throw errnoError("ENOTEMPTY", `ENOTEMPTY: directory not empty, rmdir '${path}'`);
    this.entries.delete(path);
  }
}

export interface FakeRunCommandCall {
  cmd: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  stdout?: Writable;
  stderr?: Writable;
  signal?: AbortSignal;
}

export type FakeRunCommandImpl = (call: FakeRunCommandCall) => Promise<{ exitCode: number }>;

/** 默认实现：不产生任何输出，立即以 exitCode 0 完成——只关心 fs 契约的测试不需要关心 exec。 */
const defaultRunCommandImpl: FakeRunCommandImpl = () => Promise.resolve({ exitCode: 0 });

export interface FakeVercelSandboxOptions {
  root?: string;
  files?: Record<string, string | Uint8Array>;
  runCommandImpl?: FakeRunCommandImpl;
}

export class FakeVercelSandbox implements VercelSandboxLike {
  readonly fs: FakeFileSystem;
  readonly calls: FakeRunCommandCall[] = [];
  private readonly runCommandImpl: FakeRunCommandImpl;

  constructor(opts: FakeVercelSandboxOptions = {}) {
    const root = opts.root ?? "/vercel/sandbox";
    this.fs = new FakeFileSystem(root, opts.files ?? {});
    this.runCommandImpl = opts.runCommandImpl ?? defaultRunCommandImpl;
  }

  async runCommand(params: VercelRunCommandParams): Promise<{ exitCode: number }> {
    const call: FakeRunCommandCall = {
      cmd: params.cmd,
      args: params.args ?? [],
      cwd: params.cwd,
      env: params.env,
      timeoutMs: params.timeoutMs,
      stdout: params.stdout,
      stderr: params.stderr,
      signal: params.signal,
    };
    this.calls.push(call);
    return this.runCommandImpl(call);
  }
}

/** 把字符串按若干小块顺序写进一个 Writable，模拟增量流式输出。 */
export async function writeChunks(stream: Writable | undefined, chunks: string[]): Promise<void> {
  if (stream === undefined) return;
  for (const chunk of chunks) {
    await new Promise<void>((resolve, reject) => {
      stream.write(chunk, (error?: Error | null) => (error ? reject(error) : resolve()));
    });
  }
}
