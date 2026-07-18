/**
 * NimboExec → e2b `Commands.run()` 映射（docs/tech/sandbox.md §3.2 / §8.2）。
 *
 * ---- P6-1 契约：全部失败路径 resolve，不 reject ----
 *
 * e2b 的 `commands.run()` 在命令非零退出时**抛出** `CommandExitError`——这个
 * 异常自身就实现了完整的 `CommandResult`（`exitCode`/`stdout`/`stderr`），因此
 * 可以无损转成一次正常 resolve（`isCommandExitErrorLike` 按字段形状识别，
 * 不用 instanceof，见 `errors.ts`）。E2B 自己的 `TimeoutError`（命令跑满
 * `timeoutMs` 或连接层超时）按具名结构识别后归一成退出码 124；其余未识别的
 * 异常（沙盒已停止/暂停、连接断开、鉴权失效等）一律 resolve 成非零结果并
 * 附带可操作的指引文案，而不是让原始异常裸露给调用方。
 *
 * ---- 取消：不信任远程调用会尊重 signal，独立赛跑兜底 ----
 *
 * 与 `@nimbo/just-bash`/`@nimbo/mini-bash` 的 `raceAbort` 同一处理哲学：这是
 * 一次真实网络往返，没有理由假设它一定会及时响应 abort（哪怕 e2b 的
 * `CommandRequestOpts` 确实声明了 `signal` 字段）。这里刻意**不**把
 * `signal`/`timeoutController.signal` 传给 `commands.run()`——取消完全靠
 * `raceAbort` 独立赛跑保证及时返回；命令本身可能在沙盒里继续跑到自然结束，
 * 这是"放弃等待"而非"真的杀掉远程进程"的已知限制（杀进程需要
 * `background:true` + `CommandHandle.kill()` 的另一条调用路径，不在这份
 * 结构接口内，超出本工单范围）。
 */
import type { ExecOptions, ExecRequest, ExecResult, NimboExec } from "@nimbo/core";
import { describeError, isCommandExitErrorLike, isE2bErrorNamed } from "./errors.js";
import type { PathAnchor } from "./path.js";
import type { E2bSandboxLike } from "./types.js";

const DESCRIBE = [
  "e2b: a real Firecracker microVM sandbox (E2B cloud) — full Linux userspace, not a virtual filesystem.",
  "Mode A same-source workspace: this NimboFS view and bash commands share the exact same filesystem inside",
  "the sandbox, so there is nothing to reconcile and no snapshot lag between the two.",
  "The sandbox is a real machine: commands can read, write, and cd anywhere on its disk, not just under this",
  "workspace's root — isolation (the whole VM is disposable) is the security boundary here, not path confinement",
  "the way an in-process VirtualFS enforces it.",
  "Each NimboFS file-tool call is a network round trip (tens to hundreds of milliseconds). Prefer running",
  "scan-heavy work (grep/find over many files, recursive listings) as a single bash command inside the sandbox",
  "rather than many individual file-tool calls.",
].join(" ");

class E2bExecAbortedError extends Error {
  constructor(reason: "timeout" | "signal") {
    super(reason === "timeout" ? "e2b: command timed out" : "e2b: aborted");
    this.name = "E2bExecAbortedError";
  }
}

/**
 * `signal` 先触发就立刻 reject，不等待 `work`（远程 `commands.run()`）真正
 * 落定——`work` 可能因为网络问题永久悬挂，这正是需要独立赛跑的原因。给
 * `work` 补一个空 catch，避免它在赛跑结束后才 reject 时产生 unhandled
 * rejection（`@nimbo/just-bash`/`@nimbo/mini-bash` 的同款 `raceAbort`）。
 */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const settleAborted = (): void => {
      work.catch(() => {});
      reject(new E2bExecAbortedError("signal"));
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

export function createE2bExec(sandbox: E2bSandboxLike, anchor: PathAnchor): NimboExec {
  return {
    // docs/tech/single-ledger.md §6.1（@nimbo/core 审批三值重构，P13-5-2c）：旧 "never" → "allow"（沙盒实现，隔离即边界）。
    defaultApproval: "allow",
    describe(): string {
      return DESCRIBE;
    },
    async exec(req: ExecRequest, opts?: ExecOptions): Promise<ExecResult> {
      const start = Date.now();
      const cwd = req.cwd !== undefined ? anchor.toReal(req.cwd) : anchor.rootReal;

      const timeoutController = new AbortController();
      const timer = req.timeoutMs !== undefined ? setTimeout(() => timeoutController.abort(), req.timeoutMs) : undefined;
      const combined = AbortSignal.any([req.signal, timeoutController.signal]);

      const work = sandbox.commands.run(req.command, {
        cwd,
        timeoutMs: req.timeoutMs,
        onStdout: (data) => opts?.onOutput?.({ stream: "stdout", data }),
        onStderr: (data) => opts?.onOutput?.({ stream: "stderr", data }),
      });

      try {
        const result = await raceAbort(work, combined);
        return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, durationMs: Date.now() - start };
      } catch (error) {
        if (error instanceof E2bExecAbortedError) {
          const timedOut = timeoutController.signal.aborted;
          return {
            exitCode: timedOut ? 124 : 130,
            stdout: "",
            stderr: timedOut ? `e2b: command timed out after ${String(req.timeoutMs)}ms` : "e2b: aborted",
            durationMs: Date.now() - start,
          };
        }
        if (isCommandExitErrorLike(error)) {
          return { exitCode: error.exitCode, stdout: error.stdout, stderr: error.stderr, durationMs: Date.now() - start };
        }
        if (isE2bErrorNamed(error, "TimeoutError")) {
          return {
            exitCode: 124,
            stdout: "",
            stderr: `e2b: command timed out: ${describeError(error)}`,
            durationMs: Date.now() - start,
          };
        }
        // 未识别的失败（沙盒已停止/暂停、连接断开、鉴权失效等）——契约要求
        // exec() 永不 reject（P6-1），resolve 成非零结果并给出可操作的指引。
        return {
          exitCode: 1,
          stdout: "",
          stderr:
            `e2b: sandbox command failed: ${describeError(error)}. ` +
            "The sandbox may have stopped or its connection was lost (e.g. it hit its idle/session timeout) — " +
            "extend the sandbox's timeout or recreate it and pass a fresh instance to e2bWorkspace().",
          durationMs: Date.now() - start,
        };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}
