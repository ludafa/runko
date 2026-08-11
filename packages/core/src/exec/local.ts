/**
 * `localExec(opts?)`：`NimboExec` 的本机实现（docs/core/core-sdk/tech.md §4.5a / docs/core/builtin-tools/tech.md
 * §1.10；P7-3 工单任务 1）。用 `node:child_process` 起一个真实 OS shell 子进程
 * 执行 `command`——与 `@nimbo/mini-bash` 的纯 TS 解释器互为对偶：mini-bash 不
 * fork 子进程、只读、`defaultApproval: "allow"`（docs/agent/single-ledger/tech.md §6.1 三值重构后的
 * 映射，原 "never"）；`localExec` fork 真实进程、无只读限制、
 * `defaultApproval: "review"`（同一映射，原 "always"；出厂值，docs/core/builtin-tools/tech.md §1.10——
 * 本机执行没有天然隔离，审批是唯一的把关点）。
 *
 * ---- `exec()` 契约（docs/core/core-sdk/tech.md §4.5a"实现契约"，同 `tools/builtin/bash.ts` 头注释） ----
 *
 * "失败即 ExecResult"：解析错误、命令级非零退出、超时、abort 都必须以
 * **resolve 的 `ExecResult`**返回，不 reject。`spawnShell()`（下方）内部统一
 * 通过子进程的 `error`/`close` 事件把这些情形都收敛成一次 `resolve`，没有一条
 * 路径会 reject。真正允许 reject 的例外只有"实现自身不可用"这一档——这里对应
 * `materialize: true` 时物化临时目录失败（如磁盘写满/权限不足）：这不是"用户的
 * 命令失败了"，是 `localExec` 这个实现本身没法工作，因此让它按 Promise 正常
 * 拒绝语义冒泡，交给上层 `bash.ts` 的 reject 兜底分支处理（同一份契约的两端）。
 *
 * ---- 三种 cwd 语义的裁量（spec 未点名，工单要求"裁量并报告"） ----
 *
 * - 非 materialize（模式 C，完全解耦）：`opts.cwd`/`req.cwd` 都是**真实主机路径**，
 *   直接传给 `spawn()`；都未提供时用 `process.cwd()`。
 * - materialize（模式 B）：命令跑在被物化的临时目录里，`opts.cwd`/`req.cwd`
 *   因此按**虚拟路径**（相对 `fs` 根）解读、映射进临时目录；都未提供时 cwd 就是
 *   临时目录本身（等价于虚拟根 "/"）。这样 `bash` 工具的 `cwd` 参数在两种模式下
 *   都可用同一套心智操作："这是我这次命令要跑在哪个目录"，只是模式 B 下这个
 *   目录名字来自 `fs` 而非主机。
 *
 * ---- `materialize: true` 需要 fs 引用：注入方式（工单要求"裁量并报告"） ----
 *
 * 选了**构造参数**（`LocalExecOptions.fs`）而非"每次 `exec()` 调用单独传 fs"或
 * "从 `ExecRequest` 里挖 fs"——`ExecRequest` 是 spec §4.5a 钉死的字面签名（不带
 * fs 字段，且 `NimboExec` 要与文件工具同构、不能反过来依赖 `NimboFS` 类型的
 * 运行时实例作为每次调用的入参），只有构造期注入才有地方放。典型用法
 * `createSession({ fs, exec: localExec({ materialize: true, fs }) })`——同一个
 * `fs` 引用传两次（一次给 session 的文件工具，一次给 `localExec` 物化），这正是
 * 模式 B 需要 nimbo 自己维护一致性的体现（不像模式 A 那样只需引用一次同源对象）。
 *
 * ---- v1 不支持符号链接（工单原文"便利实现而非安全边界"） ----
 *
 * `reconcileFS()` 回收阶段只处理 `dirent.isDirectory()`/`dirent.isFile()`，
 * 命令在临时目录里创建的符号链接会被静默跳过（既不报错也不回收）。这不是安全
 * 边界（`localExec` 本来就跑在真实主机上、`defaultApproval: "review"`，信任
 * 边界在审批链而非这里）——只是 v1 图省事没做符号链接的虚拟化语义（`NimboFS`
 * 接口本身也没有 symlink 概念），因此干脆不支持，而不是花成本做一个语义模糊的
 * 近似。
 */
import * as nodeChildProcess from "node:child_process";
import type { Dirent } from "node:fs";
import * as nodeFs from "node:fs/promises";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import type { DirEntry, ExecOptions, ExecRequest, ExecResult, NimboExec, NimboFS } from "../types.js";

export interface LocalExecOptions {
  /**
   * 模式 B（§4.5a）：执行前把 `fs` 物化到随机临时目录、执行后按 mtime 回收
   * 变更写回 `fs`。为 `true` 时必须同时提供 `fs`（构造期同步报错，理由见头注释）。
   */
  materialize?: boolean;
  /** 每次 `exec()` 未显式传 `req.cwd` 时的默认 cwd；语义（真实路径 vs 虚拟路径）取决于 `materialize`，见头注释。 */
  cwd?: string;
  /** `materialize: true` 时必需——要物化/回收的 `NimboFS`。 */
  fs?: NimboFS;
}

const MATERIALIZE_REQUIRES_FS_MESSAGE =
  "localExec({ materialize: true }) requires a NimboFS reference to materialize into the temp dir and " +
  "reconcile changes back from — pass { fs } (typically the same NimboFS injected as SessionOptions.fs, " +
  "so bash and the file tools stay consistent, docs/core/core-sdk/tech.md §4.5a mode B).";

/** ≤150 token 规格（docs/core/builtin-tools/tech.md §1.10）：OS/架构/node 版本 + 网络可达假设 + 模式 B/C 的 fs 映射说明 + 默认 cwd。 */
function buildDescribe(opts: LocalExecOptions): string {
  const mode = opts.materialize === true ? "B" : "C";
  const fsNote =
    mode === "B"
      ? "mode B: the injected NimboFS is materialized into a fresh temp dir before the command and reconciled " +
        "back by mtime after it exits (symlinks are not reconciled — convenience impl, not a security boundary)."
      : "mode C: runs directly on the real local filesystem, fully decoupled from any injected NimboFS (no reconciliation).";
  return (
    `localExec: real OS shell on ${nodeOs.platform()}/${nodeOs.arch()}, Node ${process.version}. ` +
    "Network: assumed reachable — this runs on the host machine directly, not inside a sandbox. " +
    `Filesystem: ${fsNote} ` +
    `Default cwd when a call omits its own: ${opts.cwd ?? "process.cwd()"}.`
  );
}

// ---- cwd 解析（头注释"三种 cwd 语义的裁量"一节） ----

function toRealPath(tmpDir: string, virtualPath: string): string {
  const segments = virtualPath.split("/").filter((segment) => segment.length > 0);
  return nodePath.join(tmpDir, ...segments);
}

function joinVirtualPath(parentDir: string, name: string): string {
  const trimmed = parentDir === "/" ? "" : parentDir.replace(/\/+$/, "");
  return `${trimmed}/${name}`;
}

function resolveCwd(opts: LocalExecOptions, req: ExecRequest, tmpDir: string | undefined): string {
  const requested = req.cwd ?? opts.cwd;
  if (tmpDir === undefined) return requested ?? process.cwd();
  return requested === undefined ? tmpDir : toRealPath(tmpDir, requested);
}

// ---- 模式 B：物化 fs → 临时目录、执行后按 mtime 回收（头注释） ----

/** 物化整棵 `fs` 树到 `tmpDir`；返回每个已物化文件的基线 mtimeMs（回收阶段据此判断"改过没有"）。reference 条目无本地字节，跳过。 */
async function materializeFS(fs: NimboFS, tmpDir: string): Promise<Map<string, number>> {
  const baseline = new Map<string, number>();

  async function walk(virtualDir: string): Promise<void> {
    const entries: DirEntry[] = await fs.readdir(virtualDir);
    for (const entry of entries) {
      const childVirtualPath = joinVirtualPath(virtualDir, entry.name);
      const childRealPath = toRealPath(tmpDir, childVirtualPath);
      if (entry.type === "dir") {
        await nodeFs.mkdir(childRealPath, { recursive: true });
        await walk(childVirtualPath);
      } else if (entry.type === "file") {
        await nodeFs.mkdir(nodePath.dirname(childRealPath), { recursive: true });
        const data = await fs.readFile(childVirtualPath);
        await nodeFs.writeFile(childRealPath, data);
        const stat = await nodeFs.stat(childRealPath);
        baseline.set(childVirtualPath, stat.mtimeMs);
      }
      // "reference" 条目没有可物化的本地字节内容（同 virtual-fs 的 diff()/writeBack() 逻辑）。
    }
  }

  await nodeFs.mkdir(tmpDir, { recursive: true });
  await walk("/");
  return baseline;
}

/** 按 `baseline` 逐一比较 `tmpDir` 现状：新增/mtime 变新的文件写回 `fs`；基线里有但现状没有的路径视为被删除，从 `fs` 移除。符号链接跳过（头注释"v1 不支持符号链接"）。 */
async function reconcileFS(fs: NimboFS, tmpDir: string, baseline: Map<string, number>): Promise<void> {
  const seen = new Set<string>();

  async function walk(virtualDir: string): Promise<void> {
    const realDir = toRealPath(tmpDir, virtualDir);
    let dirents: Dirent[];
    try {
      dirents = await nodeFs.readdir(realDir, { withFileTypes: true });
    } catch {
      return; // 命令把这个目录整个删了：其下所有基线路径都会在下面的"未见到即删除"里被清理。
    }
    for (const dirent of dirents) {
      const childVirtualPath = joinVirtualPath(virtualDir, dirent.name);
      if (dirent.isDirectory()) {
        await walk(childVirtualPath);
        continue;
      }
      if (!dirent.isFile()) continue; // 符号链接等特殊条目：v1 不回收，理由见头注释。
      seen.add(childVirtualPath);
      const childRealPath = nodePath.join(realDir, dirent.name);
      const stat = await nodeFs.stat(childRealPath);
      const before = baseline.get(childVirtualPath);
      if (before === undefined || stat.mtimeMs > before) {
        const data = await nodeFs.readFile(childRealPath);
        await fs.writeFile(childVirtualPath, data);
      }
    }
  }

  await walk("/");
  for (const virtualPath of baseline.keys()) {
    if (!seen.has(virtualPath)) {
      await fs.rm(virtualPath).catch(() => {}); // best-effort：即使 fs 侧已经不一致也不让回收本身失败
    }
  }
}

// ---- 子进程执行：never-reject、超时/abort 语义（头注释"exec() 契约") ----

/** POSIX 惯例：因信号终止的退出码 = 128 + 信号数值（同 mini-bash 的超时 124/abort 130 一脉，见 §4.5a"实现契约"）。 */
function signalExitCode(signal: NodeJS.Signals): number {
  return 128 + (nodeOs.constants.signals[signal] ?? 0);
}

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function spawnShell(command: string, cwd: string, req: ExecRequest, execOpts: ExecOptions | undefined): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = nodeChildProcess.spawn(command, { cwd, shell: true });
    child.stdin.end(); // 不支持向命令喂 stdin——没有输入源时子进程等着读 stdin 会永久挂起。

    const stdoutDecoder = new TextDecoder();
    const stderrDecoder = new TextDecoder();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const timer =
      req.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
          }, req.timeoutMs)
        : undefined;

    const onAbort = (): void => {
      aborted = true;
      child.kill("SIGTERM");
    };
    if (req.signal.aborted) onAbort();
    else req.signal.addEventListener("abort", onAbort, { once: true });

    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      req.signal.removeEventListener("abort", onAbort);
      resolve({ exitCode, stdout, stderr });
    };

    child.stdout.on("data", (chunk: Buffer) => {
      const text = stdoutDecoder.decode(chunk, { stream: true });
      stdout += text;
      execOpts?.onOutput?.({ stream: "stdout", data: text });
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = stderrDecoder.decode(chunk, { stream: true });
      stderr += text;
      execOpts?.onOutput?.({ stream: "stderr", data: text });
    });

    // spawn 自身失败（如 shell 不存在）：这是"命令没跑起来"，不是"localExec 这个
    // 实现不可用"——按契约仍要 resolve 一个 ExecResult，不 reject（头注释）。
    child.on("error", (error) => {
      stderr += `localExec: failed to spawn command: ${error.message}\n`;
      finish(1);
    });

    child.on("close", (code, signal) => {
      if (timedOut) {
        finish(124);
      } else if (aborted) {
        finish(130);
      } else if (code !== null) {
        finish(code);
      } else if (signal !== null) {
        finish(signalExitCode(signal));
      } else {
        finish(1);
      }
    });
  });
}

async function runLocalExec(opts: LocalExecOptions, req: ExecRequest, execOpts: ExecOptions | undefined): Promise<ExecResult> {
  const start = Date.now();
  const materialize = opts.materialize === true && opts.fs !== undefined;
  let tmpDir: string | undefined;
  let baseline: Map<string, number> | undefined;

  try {
    if (materialize && opts.fs !== undefined) {
      tmpDir = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), "nimbo-local-exec-"));
      baseline = await materializeFS(opts.fs, tmpDir);
    }

    const cwd = resolveCwd(opts, req, tmpDir);
    const { exitCode, stdout, stderr } = await spawnShell(req.command, cwd, req, execOpts);

    if (tmpDir !== undefined && baseline !== undefined && opts.fs !== undefined) {
      await reconcileFS(opts.fs, tmpDir, baseline);
    }

    return { exitCode, stdout, stderr, durationMs: Date.now() - start };
  } finally {
    if (tmpDir !== undefined) await nodeFs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** `NimboExec` 的本机实现（docs/core/core-sdk/tech.md §4.5a / docs/core/builtin-tools/tech.md §1.10）。`defaultApproval: "review"` 出厂值（docs/agent/single-ledger/tech.md §6.1 三值重构后的映射，原 "always"）——本机执行没有天然隔离。 */
export function localExec(opts: LocalExecOptions = {}): NimboExec {
  if (opts.materialize === true && opts.fs === undefined) {
    throw new Error(MATERIALIZE_REQUIRES_FS_MESSAGE);
  }
  return {
    defaultApproval: "review",
    describe: (): string => buildDescribe(opts),
    exec: (req: ExecRequest, execOpts?: ExecOptions): Promise<ExecResult> => runLocalExec(opts, req, execOpts),
  };
}
