/**
 * `justBash(fs, opts?)`：`NimboExec` 的全语法档实现（tech-spec §4.5b），
 * 用 `just-bash` 的 `Bash` 类跑在注入的 `NimboFS` 之上（经 `fs-adapter.ts`
 * 翻译成 `IFileSystem`）。模式 A（同源工作区）的典型消费方式与 mini-bash
 * 一致：`createSession({ fs, exec: justBash(fs) })`。
 *
 * ---- cwd 持久化：一个实测推翻工单原文断言的发现 ----
 *
 * §4.5b 原文说"脚本内 `cd` 实例级持久——与 mini-bash P6-4 语义一致，just-bash
 * 原生如此"。**实测证明这个"原生如此"不成立**：`Bash.exec()` 每次调用都是
 * 无状态的——`cd` 造成的 cwd 变化只体现在那次调用自己的返回值
 * （`BashExecResult.env.PWD`）里，不会保留到下一次 `.exec()` 调用（`bash.getCwd()`
 * 在调用后仍返回构造时的初始值，与调用是否传了 `ExecOptions.cwd` 无关）；
 * 变量/环境也是同样的"每次调用完全独立"。因此 cwd 的跨调用持久化必须由
 * **本适配器自己维护**，不是 `Bash` 的免费特性：
 *   1. 闭包变量 `instanceCwd` 是唯一的跨调用状态来源（`Bash` 实例本身只在
 *      构造时创建一次，用于复用命令注册表/解析器，不用于状态持久化）；
 *   2. 每次 `exec()` 都显式把 `instanceCwd`（或 `req.cwd` 覆盖后的值）通过
 *      `ExecOptions.cwd` 传给 `bash.exec()`——不传就会退回 just-bash 自己的
 *      构造期默认值，而不是"沿用上次";
 *   3. 调用结束后从 `result.env.PWD` 读出这次脚本实际落脚的目录，只有当它
 *      与这次调用的起点不同时才回写 `instanceCwd`——精确复刻
 *      mini-bash `exec.ts` 的" `req.cwd` 只是这次调用的起点，没有 cd 就不
 *      转正为永久记忆"规则（同一份 P6-4 语义，靠适配器自己而非引擎实现）。
 *
 * ---- 超时/中止：不能信任 just-bash 自己的"协作式取消" ----
 *
 * `ExecOptions.signal` 文档说"停在下一个语句边界"，但这只在解释器本身持有
 * 控制权时才有效——若脚本正卡在**我们注入的 fs**的一次永不 resolve 的
 * `await`（比如测试用的"悬挂 fs"）上，控制权根本没回到解释器循环，协作式
 * 检查永远等不到下一次机会（已用一个"读 fs 永远 pending"的 stub 实测验证：
 * 已中止的 signal 完全救不回来，`bash.exec()` 会真的挂住）。因此和
 * mini-bash 同款处理：整个 `bash.exec(...)` 调用被 `raceAbort` 包一层——
 * 中止/超时信号一响就立即用合成的 `ExecResult` resolve，不等底层 Promise
 * 真正落定（底层调用留在后台自生自灭，补一个空 `catch` 防止 unhandled
 * rejection，这也是 mini-bash `raceAbort` 的原话）。超时 124 / abort 130
 * 对齐 §4.5a 既有契约，不采信 just-bash 自己返回的退出码（实测过它并不总
 * 是可靠：同一个"已中止 signal"在不同命令上观察到过 124 和 0 两种不一致
 * 结果，见工单调研，不能作为判据）。
 *
 * ---- getAllPaths 缓存的刷新时机 ----
 *
 * `fs-adapter.ts` 的 `getAllPaths()` 依赖一份异步预热的同步缓存（sync/async
 * 接口不匹配，见该文件头注释）。这里选择在每次顶层 `exec()` 调用**开始时**
 * 刷新一次，且刷新动作也被纳入同一个 `raceAbort` 保护之下（`fs.glob("**")`
 * 本身也是注入方实现，同样可能挂起，不能豁免于"绝不挂起"的契约）。代价是
 * 每次 `exec()` 都多一次 `glob("**")` 往返，换来的是"脚本开始跑之前，`**`
 * 展开至少反映脚本开始那一刻的 fs 状态"——脚本运行期间的新写入要下一次
 * `exec()` 才可见，是已知且如实记录的限制（同文件头注释）。
 */
import type { ExecOptions, ExecRequest, ExecResult, NimboExec, NimboFS } from "@nimbo/core";
import type { BashExecResult, BashOptions } from "just-bash";
import { Bash } from "just-bash";
import { createFsAdapter } from "./fs-adapter.js";
import { resolvePath } from "./path.js";

/**
 * `just-bash` 不从包顶层导出 `ExecutionLimits` 这个类型名（`Bash.ts` 内部
 * 有 `export type { ExecutionLimits } from "./limits.js"`，但顶层
 * `index.ts` 的重导出列表里漏了它——实测 `tsc` 报 "has no exported member
 * 'ExecutionLimits'" 确认）。改用索引访问类型从确实导出的 `BashOptions`
 * 上派生同一个类型——结构上与直接导出完全等价，只是不依赖一个未导出的
 * 名字；这不是类型逃逸（不是 `any`/断言），是用类型系统本身收窄出真实形状。
 */
export type ExecutionLimits = NonNullable<BashOptions["executionLimits"]>;

export interface JustBashOptions {
  /** 执行限额覆盖——与默认收紧值逐字段合并（未指定的字段沿用默认值）。 */
  limits?: ExecutionLimits;
}

/**
 * 默认收紧值（工单裁量：just-bash 自己的出厂默认——如 maxCommandCount 1万、
 * maxLoopIterations 1万、maxOutputSize 10MB——是为通用 CLI 场景设的，对
 * "一次 agent 工具调用里跑的一段脚本"明显过宽。这里按"典型 agent 脚本远小
 * 于这些量级，但仍留足够余量不误伤正常用例"的原则整体收紧一个数量级左右；
 * 全部字段都能被 `opts.limits` 逐个覆盖。）
 */
const DEFAULT_EXECUTION_LIMITS: ExecutionLimits = {
  maxCallDepth: 20,
  maxCommandCount: 2000,
  maxLoopIterations: 2000,
  maxAwkIterations: 2000,
  maxSedIterations: 2000,
  maxJqIterations: 2000,
  maxSqliteTimeoutMs: 3000,
  maxGlobOperations: 5000,
  maxStringLength: 2 * 1024 * 1024,
  maxArrayElements: 10_000,
  maxHeredocSize: 1024 * 1024,
  maxSubstitutionDepth: 20,
  maxBraceExpansionResults: 2000,
  maxOutputSize: 1024 * 1024,
  maxFileDescriptors: 256,
  maxSourceDepth: 20,
};

const DESCRIBE = [
  "just-bash: full-syntax bash interpreter (vercel-labs/just-bash), running entirely on the injected NimboFS",
  "(mode A same-source workspace — bash and the file tools share one filesystem, nothing to reconcile).",
  "Supports the full control-flow surface: if/elif/else, for (list and C-style `for ((i=0;i<n;i++))`),",
  "while, until, case, functions with local variables, variable/parameter expansion, glob expansion,",
  "pipes, `&&`/`||`, and redirections (`>`, `>>`, `<`, `2>&1`).",
  "No symlinks: symlink/link/readlink always fail, and stat never reports a symbolic link.",
  "No network: curl/wget are not registered (no fetch/network config is wired in).",
  "No python/js sub-interpreters: disabled by default for reduced execution surface.",
  "Output is NOT streamed: just-bash reports stdout/stderr only once the whole script has finished, so",
  "onOutput fires at most once per stream, after the command completes (not incrementally as it runs).",
  "cwd is persistent on this instance: a `cd` inside a script carries over to the next exec() call on the",
  "same justBash(fs) instance (same semantics as @nimbo/mini-bash); an explicit req.cwd only overrides the",
  "starting point for that one call and is not promoted to permanent memory unless a cd actually runs.",
  "Execution limits are enforced (loop iterations, command count, call depth, output size, and more) to",
  "bound runaway scripts; see justBash(fs, { limits }) to override the defaults.",
].join(" ");

class JustBashAbortedError extends Error {
  constructor(reason: "timeout" | "signal") {
    super(reason === "timeout" ? "just-bash: command timed out" : "just-bash: aborted");
    this.name = "JustBashAbortedError";
  }
}

/**
 * 同 `@nimbo/mini-bash` 的 `raceAbort`：`signal` 先触发就立刻 reject，不等
 * `work` 真正落定（`work` 可能因为注入的 fs/glob 永久 pending，这正是需要
 * 竞速的原因）。给 `work` 补一个空 catch，避免它在竞速结束后才 reject/resolve
 * 时产生 unhandled rejection 噪音。
 */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const settleAborted = (): void => {
      work.catch(() => {});
      reject(new JustBashAbortedError("signal"));
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

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `result.env.PWD` 的类型安全读取——`noUncheckedIndexedAccess` 下 `Record<string,string>` 索引即 `string | undefined`，用 typeof 守卫而非断言。 */
function endingCwdOf(result: BashExecResult, fallback: string): string {
  const pwd = result.env.PWD;
  return typeof pwd === "string" ? pwd : fallback;
}

export function justBash(fs: NimboFS, opts: JustBashOptions = {}): NimboExec {
  const adapter = createFsAdapter(fs);
  const bash = new Bash({
    fs: adapter,
    cwd: "/",
    executionLimits: { ...DEFAULT_EXECUTION_LIMITS, ...opts.limits },
    // 网络默认禁用（不传 fetch/network，curl/wget 不会被注册）；python/js
    // 子解释器同样按 §4.5b"零额外执行面"精神显式关闭（本来也是出厂默认值）。
    python: false,
    javascript: false,
  });
  let instanceCwd = "/";

  return {
    defaultApproval: "never",
    describe(): string {
      return DESCRIBE;
    },
    async exec(req: ExecRequest, execOpts?: ExecOptions): Promise<ExecResult> {
      const start = Date.now();
      const startCwd = req.cwd !== undefined ? resolvePath("/", req.cwd) : instanceCwd;

      const timeoutController = new AbortController();
      const timer = req.timeoutMs !== undefined ? setTimeout(() => timeoutController.abort(), req.timeoutMs) : undefined;
      const combined = AbortSignal.any([req.signal, timeoutController.signal]);

      const work = (async (): Promise<BashExecResult> => {
        await adapter.refreshAllPaths();
        return bash.exec(req.command, { cwd: startCwd, signal: combined });
      })();

      try {
        const result = await raceAbort(work, combined);

        const endCwd = endingCwdOf(result, startCwd);
        if (endCwd !== startCwd) instanceCwd = endCwd;

        if (result.stdout.length > 0) execOpts?.onOutput?.({ stream: "stdout", data: result.stdout });
        if (result.stderr.length > 0) execOpts?.onOutput?.({ stream: "stderr", data: result.stderr });

        return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, durationMs: Date.now() - start };
      } catch (error) {
        const timedOut = timeoutController.signal.aborted;
        if (error instanceof JustBashAbortedError || timedOut) {
          return {
            exitCode: timedOut ? 124 : 130,
            stdout: "",
            stderr: timedOut ? `just-bash: command timed out after ${String(req.timeoutMs)}ms` : "just-bash: aborted",
            durationMs: Date.now() - start,
          };
        }
        // 契约要求 exec() 不 reject（§4.5a）——到这里说明 just-bash 内部抛出了一个
        // 非正常失败路径（语法错误/未知命令/超时都已经在上面正常 resolve 了）的
        // 真实异常，兜底成一个 ExecResult 而不是让它冒泡。
        return { exitCode: 1, stdout: "", stderr: `just-bash: internal error: ${describeError(error)}`, durationMs: Date.now() - start };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}
