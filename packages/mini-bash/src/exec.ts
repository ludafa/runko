/**
 * `miniBash(fs)`：RunkoExec 的纯 TS 解释器实现（docs/tech/core-sdk.md §4.5a）。不 fork
 * 子进程，全部命令跑在注入的 RunkoFS 七方法上，只读。模式 A（同源工作区）
 * 的典型消费方式是 `createSession({ fs, exec: miniBash(fs) })`——同一个
 * fs 实例既是文件工具的后端，也是 bash 命令的执行环境，天然一致。
 */
import type { ExecOptions, ExecRequest, ExecResult, RunkoExec, RunkoFS } from "@runko/core";
import { COMMANDS } from "./commands/index.js";
import type { CommandContext, CommandFn } from "./commands/index.js";
import type { ParsedChain, ParsedPipeline, ParsedScript } from "./parse.js";
import { MiniBashParseError, parse } from "./parse.js";
import { resolvePath } from "./path.js";

const DESCRIBE = [
  "mini-bash: 纯 TypeScript 解释器，跑在注入的 RunkoFS 上（模式 A 同源工作区——",
  "bash 与文件工具共享同一份虚拟文件系统，数据只有一份，不存在同步/竞态）。",
  "全部命令只读、无副作用；不 fork 子进程，不访问真实文件系统或网络。",
  "支持命令：",
  "  cat [file...]                          多文件按参数顺序原样拼接；无参数消费 stdin。",
  "  grep [-i] [-n] [-c] [-l] [-E] PATTERN [file...]",
  "                                          JavaScript RegExp 语法（非 POSIX/PCRE）；",
  "                                          -E 为兼容旗标，JS RegExp 已是扩展语法，不改变匹配行为；",
  "                                          无参数消费 stdin；无匹配 exit 1。",
  "  find [path] [-name GLOB] [-type f|d]   从 path（默认 .）递归；-name 只匹配单段 basename。",
  "  tail [-n N] [file...]                  默认 N=10；无参数消费 stdin。",
  "  head [-n N] [file...]                  默认 N=10；无参数消费 stdin。",
  "  echo [-n] [text...]                    -n 抑制结尾换行。",
  "  cd [dir]                               无参数回根 \"/\"；目标不存在或非目录 → 非零 exit + stderr，成功静默 exit 0；",
  "                                          只做 stat 校验，零写操作；不支持 cd -（明确报错，不静默）。",
  "                                          cd 会改变同一 exec() 调用内 `;`/`&&`/`||` 链间后续命令的工作目录",
  "                                          （如 `cd src; cat index.ts`），并跨调用持久化——同一 miniBash(fs) 实例",
  "                                          记住最近一次 cd 的目录，下次 exec() 若未显式传 req.cwd 则以此为起点；",
  "                                          req.cwd 显式提供时优先于该记忆，仅作为那次调用的起点，调用内的 cd 仍会",
  "                                          更新实例记忆。管道内的 cd（如 `cd x | cat`）按 POSIX 子 shell 语义——",
  "                                          执行成功但对链/实例状态均无效果。",
  "  pwd                                    打印当前生效的工作目录（随链内 cd 变化）+ 换行。",
  "控制操作符：",
  "  |          单层管道：左侧 stdout → 右侧 stdin，管道退出码取最后一个命令。",
  "  ;          顺序执行：依次跑完，stdout/stderr 分别拼接，退出码取最后一个命令。",
  "  &&         前一个管道 exit 0 才执行下一个（短路）。",
  "  ||         前一个管道非 0 才执行下一个（短路）。",
  "  优先级对齐 POSIX：| 最紧（先组成一个管道）；&& 与 || 同级、左结合；",
  "  ; 最松，把命令行切成多条独立链，链之间总是全部依次执行，不因退出码跳过。",
  "  2>&1       该命令的 stderr 并入其 stdout（出现在命令末尾参数位；管道场景下",
  "             如 `cmd 2>&1 | grep x`，右侧命令能读到原本的 stderr 内容）；",
  "             不写 2>&1 时 stderr 仍照常单独输出，不受影响。",
  "不支持（解析阶段直接报错，不静默降级）：",
  "  重定向 (>, >>, <)——写文件请改用 write-file 工具，读文件请直接 cat <file>；",
  "  变量展开 ($var, ${var})、子 shell/命令替换 ($(...), `...`)、后台执行 (&)、",
  "  通配符展开（*、? 等按字面字符传给命令，不做文件名展开）。",
].join("\n");

class MiniBashAbortedError extends Error {
  constructor(reason: "timeout" | "signal") {
    super(reason === "timeout" ? "mini-bash: command timed out" : "mini-bash: aborted");
    this.name = "MiniBashAbortedError";
  }
}

/**
 * 把 `work` 和 `signal` 的 abort 事件赛跑：signal 先触发就立刻 reject，
 * 不等待 `work` 本身结束（`work` 可能因为注入的 fs 一直不 resolve 而永久
 * 挂起，这也是 RunkoExec 需要 abort 语义的原因）。给 `work` 补一个空
 * catch，避免其在赛跑结束后才 reject 时产生 unhandled rejection。
 */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const settleAborted = (): void => {
      work.catch(() => {});
      reject(new MiniBashAbortedError("signal"));
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

interface ResolvedStage {
  command: CommandFn;
  args: string[];
  mergeStderr: boolean;
}

type ResolvedPipeline = { ok: true; stages: ResolvedStage[] } | { ok: false; message: string };

/**
 * 管道每个阶段的命令名在执行前一次性校验完——找不到就整条管道都不跑（不
 * 留下"跑了一半"的只读副作用）。校验只发生在这个管道**真的要跑**的时候
 * 才调用（由 `runChain` 决定），未命中的短路分支（`&&`/`||` 跳过的一
 * 侧）里即使有拼写错误的命令名也不会触发"command not found"——这与真实
 * shell 的运行时惰性解析一致，不在解析阶段/执行前做整脚本级别的预校验。
 */
function resolvePipeline(pipeline: ParsedPipeline): ResolvedPipeline {
  const stages: ResolvedStage[] = [];
  for (const stage of pipeline) {
    const name = stage.argv[0];
    if (name === undefined) {return { ok: false, message: "mini-bash: 管道中出现空命令" };}
    const command = COMMANDS[name];
    if (command === undefined) {return { ok: false, message: `${name}: command not found` };}
    stages.push({ command, args: stage.argv.slice(1), mergeStderr: stage.mergeStderr });
  }
  return { ok: true, stages };
}

interface PipelineOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** 该管道跑完后"生效"的 cwd——多数命令不改变它，原样回传输入的 cwd。 */
  cwd: string;
}

/**
 * 跑一个管道（`|` 连接的阶段序列）：阶段间 stdout→stdin 接力，退出码取
 * 最后一个阶段；命令名解析失败时整个管道不跑，直接返回 127（见
 * `resolvePipeline` 注释）。`mergeStderr` 的阶段把自己的 stderr 并入
 * stdout 再往下传（管道右侧读到的 stdin 里就含有它），且不再贡献到管道
 * 对外的 stderr——`2>&1` 的语义就是"这条命令的 stderr 从此不算 stderr"。
 * stdout 的 onOutput 只在整个管道跑完后触发一次（对外只关心这个管道的
 * 最终产出），stderr 则每个阶段各自触发一次（贴近"错误发生时就通知"）。
 *
 * 所有阶段共用同一个输入 `cwd`（不随阶段推进而演变）——这正是管道内
 * `cd` 的 POSIX 子 shell 语义：`cd x | pwd` 里 pwd 看到的仍是管道开始
 * 前的目录，因为两个阶段本该是各自独立的子 shell，一个的 `cd` 不会影响
 * 另一个。只有当整个管道退化成单一阶段（没有真正的 `|`）且那个阶段是
 * `cd` 并成功时，才把它的新 cwd 当作这个管道对外的 `cwd`——`runChain`/
 * `exec()` 据此决定要不要把状态穿透给后续链/持久化到实例。
 */
async function runPipeline(
  fs: RunkoFS,
  pipeline: ParsedPipeline,
  cwd: string,
  signal: AbortSignal,
  opts: ExecOptions | undefined,
): Promise<PipelineOutcome> {
  const resolved = resolvePipeline(pipeline);
  if (!resolved.ok) {
    return { stdout: "", stderr: resolved.message, exitCode: 127, cwd };
  }

  let stdin: string | undefined;
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  let nextCwd = cwd;

  for (const stage of resolved.stages) {
    const ctx: CommandContext = { fs, cwd, stdin, signal };
    const result = await raceAbort(stage.command(stage.args, ctx), signal);

    const stageStdout = stage.mergeStderr ? result.stdout + result.stderr : result.stdout;
    const stageStderr = stage.mergeStderr ? "" : result.stderr;

    if (stageStderr.length > 0) {
      stderr += stageStderr;
      opts?.onOutput?.({ stream: "stderr", data: stageStderr });
    }
    stdin = stageStdout;
    stdout = stageStdout;
    exitCode = result.exitCode;

    if (resolved.stages.length === 1 && result.cwd !== undefined) {
      nextCwd = result.cwd;
    }
  }

  if (stdout.length > 0) {opts?.onOutput?.({ stream: "stdout", data: stdout });}

  return { stdout, stderr, exitCode, cwd: nextCwd };
}

/**
 * 跑一条 `&&`/`||` 左结合链：第一个管道总跑；此后每个管道是否跑，取决于
 * 它前面那个操作符与"当前状态"（上一个**实际跑过**的管道的退出码，被跳
 * 过的管道不改变这个状态——这正是短路语义：`a && b || c` 里若 a 失败，
 * b 被跳过，但状态仍是 a 的退出码，`|| c` 据此判断该不该跑 c）。cwd 按同
 * 样的方式穿透：每跑完一个管道就把它对外的 cwd 当作链上后续管道的输入
 * cwd（`cd src && cat index.ts` 里 cat 因此能看到 cd 之后的目录）；被跳
 * 过的管道自然不改变 cwd，与不改变退出码状态是同一回事。
 */
async function runChain(fs: RunkoFS, chain: ParsedChain, cwd: string, signal: AbortSignal, opts: ExecOptions | undefined): Promise<PipelineOutcome> {
  const [first, ...rest] = chain;
  if (first === undefined) {
    return { stdout: "", stderr: "mini-bash: 管道中出现空命令", exitCode: 2, cwd };
  }

  let stdout = "";
  let stderr = "";
  let currentCwd = cwd;
  let current = await runPipeline(fs, first.pipeline, currentCwd, signal, opts);
  stdout += current.stdout;
  stderr += current.stderr;
  currentCwd = current.cwd;
  let connector = first.next;

  for (const link of rest) {
    const shouldRun = connector === "&&" ? current.exitCode === 0 : connector === "||" ? current.exitCode !== 0 : true;
    if (shouldRun) {
      current = await runPipeline(fs, link.pipeline, currentCwd, signal, opts);
      stdout += current.stdout;
      stderr += current.stderr;
      currentCwd = current.cwd;
    }
    connector = link.next;
  }

  return { stdout, stderr, exitCode: current.exitCode, cwd: currentCwd };
}

export function miniBash(fs: RunkoFS): RunkoExec {
  // 实例状态：这个 miniBash(fs) 闭包记住的"当前目录"，被 cd 成功更新，
  // 作为后续 exec() 调用在 req.cwd 未显式提供时的默认起点（跨调用持久化，
  // 见 DESCRIBE 与 cd.ts 顶部注释）。每次调用 miniBash(fs) 都产生一个新
  // 闭包 / 新的 instanceCwd，两个实例天然互不影响。
  let instanceCwd = "/";

  return {
    // docs/tech/single-ledger.md §6.1（@runko/core 审批三值重构，
    // P13-5-2c）：旧 "never" → "allow"（沙盒/只读实现，隔离即边界）。
    defaultApproval: "allow",
    describe(): string {
      return DESCRIBE;
    },
    async exec(req: ExecRequest, opts?: ExecOptions): Promise<ExecResult> {
      const start = Date.now();
      // req.cwd 显式提供时以它为这次调用的起点（覆盖实例记忆）；否则
      // 落回实例当前记住的目录。无论走哪条分支，这次调用内的 cd 都会
      // 更新 instanceCwd（在下面的循环里逐链同步）。
      let currentCwd = req.cwd !== undefined ? resolvePath("/", req.cwd) : instanceCwd;

      let script: ParsedScript;
      try {
        script = parse(req.command);
      } catch (error) {
        const message = error instanceof MiniBashParseError ? error.message : error instanceof Error ? error.message : String(error);
        return { exitCode: 2, stdout: "", stderr: message, durationMs: Date.now() - start };
      }

      const timeoutController = new AbortController();
      const timer = req.timeoutMs !== undefined ? setTimeout(() => timeoutController.abort(), req.timeoutMs) : undefined;
      const combined = AbortSignal.any([req.signal, timeoutController.signal]);

      try {
        // `;` 分隔的每条链总是全部依次跑（不因前一条的退出码跳过），
        // stdout/stderr 按执行顺序拼接，exitCode 取最后一条链的结果
        // （链内部因 && / || 被跳过的管道不产生输出，也不参与这个结果）。
        // cwd 在链之间穿透（`cd src; cat index.ts` 里 cat 因此看到 cd 之后
        // 的目录）。instanceCwd 只在某条链真的把 cwd 改掉时才同步（`result.cwd
        // !== currentCwd` 就是"这条链里跑过一次生效的顶层 cd"的信号）——单纯
        // 因为这次调用传了 req.cwd、但脚本里其实没有 cd，不应该悄悄把这个临时
        // 起点也记成实例的长期状态，否则就违背了"req.cwd 只是这次调用的起点"
        // 这条设计（见 DESCRIBE）。改动一旦发生就立刻同步，不等脚本跑完——
        // 即便后面的链因超时/abort 中断，已经跑过的 cd 效果也不应回滚（真实
        // shell 里已执行命令的副作用不会因为后续命令被打断而撤销）。
        let stdout = "";
        let stderr = "";
        let exitCode = 0;

        for (const chain of script) {
          const result = await runChain(fs, chain, currentCwd, combined, opts);
          stdout += result.stdout;
          stderr += result.stderr;
          exitCode = result.exitCode;
          if (result.cwd !== currentCwd) {instanceCwd = result.cwd;}
          currentCwd = result.cwd;
        }

        return { exitCode, stdout, stderr, durationMs: Date.now() - start };
      } catch (error) {
        const timedOut = timeoutController.signal.aborted;
        const message =
          error instanceof MiniBashAbortedError || timedOut
            ? timedOut
              ? `mini-bash: command timed out after ${String(req.timeoutMs)}ms`
              : "mini-bash: aborted"
            : error instanceof Error
              ? error.message
              : String(error);
        return { exitCode: timedOut ? 124 : 130, stdout: "", stderr: message, durationMs: Date.now() - start };
      } finally {
        if (timer !== undefined) {clearTimeout(timer);}
      }
    },
  };
}
