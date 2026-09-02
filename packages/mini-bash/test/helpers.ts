/** 测试共享辅助（不是 *.test.ts，vitest 不会当测试文件收集）。 */
import type { ExecOptions, ExecOutputChunk, ExecResult, FileStat, RunkoFS } from "@runko/core";
import { miniBash } from "../src/index.js";

export interface RunOpts {
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onOutput?: ExecOptions["onOutput"];
}

/** `miniBash(fs).exec(...)` 的薄封装：默认给一个从未 abort 的 signal，省得每条用例都手写。 */
export function run(fs: RunkoFS, command: string, opts: RunOpts = {}): Promise<ExecResult> {
  const bash = miniBash(fs);
  return bash.exec(
    { command, cwd: opts.cwd, timeoutMs: opts.timeoutMs, signal: opts.signal ?? new AbortController().signal },
    opts.onOutput ? { onOutput: opts.onOutput } : undefined,
  );
}

export function collectOutput(): { chunks: ExecOutputChunk[]; onOutput: NonNullable<ExecOptions["onOutput"]> } {
  const chunks: ExecOutputChunk[] = [];
  return { chunks, onOutput: (chunk) => chunks.push(chunk) };
}

/**
 * 一个 `stat()` 立即成功、`readFile()` 永不 resolve 的假 RunkoFS——专门用来
 * 测试 timeout/abort：cat 会先 stat 成功再卡在 readFile 上，模拟"注入的 fs
 * 挂住了"的场景，验证 exec() 在这种情况下仍能按 timeoutMs/signal 及时返回
 * 而不是永久挂起。其余方法用不到，返回 reject 让误用立刻暴露。
 */
export function makeHangingFs(): RunkoFS {
  const notImplemented = (op: string) => Promise.reject(new Error(`hanging fake fs: ${op} should not be called by this test`));
  const fileStat: FileStat = { type: "file" };
  return {
    readFile: () => new Promise(() => {}),
    writeFile: () => notImplemented("writeFile"),
    rm: () => notImplemented("rm"),
    mkdir: () => notImplemented("mkdir"),
    readdir: () => notImplemented("readdir"),
    stat: () => Promise.resolve(fileStat),
    glob: () => Promise.resolve([]),
  };
}

/**
 * 包一层：`readFile(path)` 在指定路径上强制失败，其余方法原样代理给底层 fs。
 * 用于模拟"stat() 说是可读文件，但 readFile() 仍然失败"这类第三方 RunkoFS
 * 实现可能出现的不一致（例如某些 reference 变体），验证 readFileForCommand
 * 的兜底 catch 分支。
 */
export function withFailingReadFile(fs: RunkoFS, path: string, error: Error): RunkoFS {
  return {
    readFile: (p) => (p === path ? Promise.reject(error) : fs.readFile(p)),
    writeFile: (p, d) => fs.writeFile(p, d),
    rm: (p, o) => fs.rm(p, o),
    mkdir: (p) => fs.mkdir(p),
    readdir: (p) => fs.readdir(p),
    stat: (p) => fs.stat(p),
    glob: (p) => fs.glob(p),
  };
}

/** 同上，但作用于 `readdir(path)`——用于验证 find 遍历途中目录读取失败时的兜底分支。 */
export function withFailingReaddir(fs: RunkoFS, path: string, error: Error): RunkoFS {
  return {
    readFile: (p) => fs.readFile(p),
    writeFile: (p, d) => fs.writeFile(p, d),
    rm: (p, o) => fs.rm(p, o),
    mkdir: (p) => fs.mkdir(p),
    readdir: (p) => (p === path ? Promise.reject(error) : fs.readdir(p)),
    stat: (p) => fs.stat(p),
    glob: (p) => fs.glob(p),
  };
}
