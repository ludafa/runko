/** 测试共享辅助（不是 *.test.ts，vitest 不会当测试文件收集）。同 `@runko/mini-bash` 的 `test/helpers.ts` 先例。 */
import type { ExecOptions, ExecOutputChunk, ExecResult, FileStat, RunkoFS } from "@runko/core";
import { justBash } from "../src/index.js";

export interface RunOpts {
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onOutput?: ExecOptions["onOutput"];
}

/** `justBash(fs).exec(...)` 的薄封装：默认给一个从未 abort 的 signal，省得每条用例都手写。每次调用都是新实例——需要跨调用状态（cwd 持久化）的用例自己持有 `justBash(fs)`。 */
export function run(fs: RunkoFS, command: string, opts: RunOpts = {}): Promise<ExecResult> {
  const bash = justBash(fs);
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
 * 测试 timeout/abort：`cat`/命令解析路径会先 `stat` 成功再卡在 `readFile` 上，
 * 模拟"注入的 fs 挂住了"，验证 `justBash(fs).exec()` 在这种情况下仍能按
 * `timeoutMs`/`signal` 及时返回而不是永久挂起（工单调研已实测确认 just-bash
 * 自身的协作式取消救不回这种"卡在 fs 一次 await 上"的场景，见 `exec.ts` 头
 * 注释——这正是本文件存在的理由）。其余方法按需返回，`glob` 返回空数组（避免
 * `getAllPaths` 预热缓存本身也无限期挂起）。
 */
export function makeHangingFs(): RunkoFS {
  const notImplemented = (op: string) => Promise.reject(new Error(`hanging fake fs: ${op} should not be called by this test`));
  const fileStat: FileStat = { type: "file", size: 3, mtime: 1 };
  return {
    readFile: () => new Promise(() => {}),
    writeFile: () => notImplemented("writeFile"),
    rm: () => notImplemented("rm"),
    mkdir: () => notImplemented("mkdir"),
    readdir: () => Promise.resolve([]),
    stat: () => Promise.resolve(fileStat),
    glob: () => Promise.resolve([]),
  };
}
