/**
 * `VercelSandboxLike`：`@vercel/sandbox` 的 `Sandbox` 实例我们实际触碰的方法面，
 * 手写结构化最小子集（docs/core/core-sdk/tech.md §4.5a / docs/host/sandbox/tech.md §8.1 依赖策略）。**本文件不
 * import `@vercel/sandbox`，连 `import type` 都不出现**——工厂函数收这个接口
 * 而非具体类，宿主与我们各自安装的 SDK 副本因此不需要是同一份；类型对照只发生
 * 在 `test/type-conformance.test-d.ts`（`import type { Sandbox } from "@vercel/sandbox"`
 * 把真实实例赋给这里的接口形参，验证结构没有漂移）。
 *
 * 字段收紧到七个 NimboFS 方法 + `runCommand` 实际用到的那一份：`fs` 只列
 * `readFile/writeFile/mkdir/readdir/stat/rm/rmdir`（`rmdir` 是 `rm` 非递归删
 * 目录语义的关键——见 fs.ts 头注释的实测发现），`runCommand` 只列对象重载中
 * 非 detached 一支需要的字段。`Writable` 用 node:stream 的真实类型（node 内建
 * 类型，不是 `@vercel/sandbox` 的类型），因为我们确实要构造一个真的 `Writable`
 * 传给它。
 */
import type { KeepAliveOptions } from "@nimbo/core";
import type { Writable } from "node:stream";

/** `fs.readdir(path, { withFileTypes: true })` 的单条目——结构对齐 node `fs.Dirent`。 */
export interface VercelDirentLike {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

/** `fs.stat(path)` 的返回值——结构对齐 node `fs.Stats`，只列我们用到的字段。 */
export interface VercelStatsLike {
  isDirectory(): boolean;
  isFile(): boolean;
  size: number;
  mtimeMs: number;
}

export interface VercelFileSystemLike {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>;
  readdir(path: string, options: { withFileTypes: true }): Promise<VercelDirentLike[]>;
  stat(path: string): Promise<VercelStatsLike>;
  /** 恒递归（`{recursive:true}`）删除；非递归对目录的语义由 `rmdir` 承担（见 fs.ts）。 */
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  /** 空目录成功、非空目录抛 `ENOTEMPTY`——node `fs.rmdir` 原生语义，`fs.rm` 反而没有它。 */
  rmdir(path: string): Promise<void>;
}

export interface VercelRunCommandParams {
  cmd: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  stdout?: Writable;
  stderr?: Writable;
}

/** 非 detached 分支的 `CommandFinished`——本适配器只依赖 `exitCode`（stdout/stderr 走注入的 Writable 收集，见 exec.ts 头注释）。 */
export interface VercelCommandResultLike {
  exitCode: number;
}

export interface VercelSandboxLike {
  readonly fs: VercelFileSystemLike;
  runCommand(params: VercelRunCommandParams): Promise<VercelCommandResultLike>;
  /**
   * 当前会话什么时候到期（官方 `get expiresAt(): Date | undefined`）。**可选**，
   * 理由同 E2B 侧的 `setTimeout`：只有开[保活](../../../docs/terms.md)时才用得上，
   * 列成必填会打死既有的手写 fake。
   *
   * ⚠️ 别跟 `sandbox.timeout` 搞混——那个是**建盒时配的默认时长**（官方 d.ts 原文
   * "The default timeout of this sandbox"），不是剩余量。用错了会把「还剩多久」
   * 恒当成建盒时的配置值，补足判定整个失效。
   */
  readonly expiresAt?: Date;
  /**
   * 在**现有租期上加时**（官方 d.ts 例子原文："Extends timeout by 5 minutes, to a
   * total of 15 minutes"）——与 E2B `setTimeout` 的重置语义相反，所以补足到目标值
   * 必须自己算差额，见 `keepalive.ts`。
   */
  extendTimeout?(duration: number): Promise<void>;
}

export interface VercelWorkspaceOptions {
  /** 虚拟绝对路径锚定到的沙盒内真实目录；默认 Vercel Sandbox 的默认工作目录。 */
  root?: string;
  /**
   * 开启[保活](../../../docs/terms.md)。**不传 = 不保活**（默认行为不变）。
   *
   * `idleTimeoutMs` 应与建盒时 `Sandbox.create({ timeout })` 的值一致。
   */
  keepAlive?: KeepAliveOptions;
}

export const DEFAULT_ROOT = "/vercel/sandbox";
