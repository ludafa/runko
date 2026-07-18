/**
 * `createVercelExec(sandbox, root)`：NimboExec 在 `sandbox.runCommand` 上的实现
 * （docs/tech/sandbox.md §3.2 / §8.2 Vercel 列）。
 *
 * ---- argv 语义：整段脚本是单个 argv，零字符串拼接 ----
 *
 * `runCommand` 不是 shell——`cmd`/`args` 是 argv 数组，不经过任何 shell 展开。
 * 管道/重定向/变量展开等 nimbo `ExecRequest.command`（一段 shell 脚本字符串）
 * 依赖的语法，靠把整段脚本原样塞进 `bash -lc` 的第二个 argv 元素得到：
 * `runCommand({ cmd: "bash", args: ["-lc", req.command], ... })`——`args` 数组
 * 恒为两个元素，`req.command` 从不被拆分/拼接/转义，bash 自己解析这段脚本。
 *
 * ---- 超时：SDK 有原生 `timeoutMs` 字段，但契约仍自己用 AbortController 兜底 ----
 *
 * 工单研究文档（docs/tech/sandbox.md §2/§8.2）说 Vercel "无 timeout 选项"，但实测当前安装的
 * `@vercel/sandbox@2.5.0` d.ts（`session.d.ts` 的 `RunCommandParams`）其实已经
 * 有 `timeoutMs?: number`（"sandbox 侧到点 SIGKILL"）——工单研究文档这一点已过
 * 时，这里如实记录偏差。但仍按工单指示自建 `AbortController` 竞速作为 124/130
 * 契约的唯一权威来源（与 mini-bash/just-bash 的 `raceAbort` 同款先例，不信任
 * 任何底层 SDK 自报的退出码/计时），原生 `timeoutMs` 只作为"我们已经提前
 * resolve 之后，沙盒侧仍会真的杀掉后台残留进程"的兜底——避免我们的竞速提前
 * 放弃等待后，脚本在沙盒里无限期继续跑、占用资源。
 *
 * ---- 流式：自定义 Writable 收集全文，不调用 CommandFinished.stdout()/stderr() ----
 *
 * 实测 `@vercel/sandbox` 的 `session.cjs`（`runCommand` 的非 detached 分支）：
 * 传入 `stdout`/`stderr` 这两个 `Writable` 后，SDK 内部对同一份 `onLog` 增量
 * 数据做了两件事——写进这两个 Writable，以及自己攒起来塞进返回的
 * `CommandFinished` 的输出缓存（供 `.stdout()`/`.stderr()` 用）。两条路径读到
 * 的是同一份数据，因此“Writable 收集”与“事后调用 `.stdout()`”是等价的
 * （工单点名的“二选一”）。这里选 Writable：既然已经为逐块 `onOutput` 回调接了
 * 一个 Writable，顺手用同一份增量文本累计全文，不必再对返回值发起额外调用；
 * 副作用是我们的 `VercelSandboxLike.runCommand` 返回类型只需要 `exitCode`，
 * 结构面更小、离真实 SDK 的耦合更低。
 */
import type { ExecOptions, ExecRequest, ExecResult, NimboExec } from "@nimbo/core";
import { Writable } from "node:stream";
import { execFailureGuidance } from "./errors.js";
import { resolveCwd } from "./path.js";
import type { VercelSandboxLike } from "./types.js";

const DESCRIBE = [
  "Vercel Sandbox: real Linux (Amazon Linux 2023) in an isolated Firecracker microVM — not a virtual FS.",
  "The default user has passwordless sudo, so `sudo ...` works directly inside commands. Commands run via",
  '`bash -lc "<script>"`, a full real bash shell (pipes, redirects, globs, variable expansion — everything works',
  "natively, nothing is emulated). Mode A (same-source workspace): the fs tools (read-file/write-file/list-dir/...)",
  "are anchored to a configured root directory inside the sandbox (default /vercel/sandbox) and reject `..` past",
  "it, but bash itself is NOT confined to that root — it can cd/read/write anywhere in the sandbox's real",
  "filesystem; the isolation boundary is the sandbox/VM itself, not this root. Prefer bash for scanning-heavy",
  "work (grep/find across many files) over many individual glob/read-file calls — each fs tool call is a network",
  "round trip to the sandbox.",
].join(" ");

class VercelExecAbortedError extends Error {
  constructor(reason: "timeout" | "signal") {
    super(reason === "timeout" ? "vercel sandbox: command timed out" : "vercel sandbox: aborted");
    this.name = "VercelExecAbortedError";
  }
}

/**
 * 同 mini-bash/just-bash 的 `raceAbort` 先例：`signal` 先触发就立刻 reject，
 * 不等 `work`（一次到沙盒的网络往返）真正落定；`work` 补一个空 catch 避免
 * 竞速结束后才 settle 时产生 unhandled rejection。
 */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const settleAborted = (): void => {
      work.catch(() => {});
      reject(new VercelExecAbortedError("signal"));
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

/** `base` 非空时换行拼接，避免空 stderr 前面挂一个孤零零的换行符。 */
function appendNote(base: string, note: string): string {
  return base.length > 0 ? `${base}\n${note}` : note;
}

/** 逐块转发 onOutput 的同时把全文累计进 `append`；沙盒侧写入的 chunk 可能是 Buffer 也可能是 string。 */
function collectorStream(stream: "stdout" | "stderr", onOutput: ExecOptions["onOutput"], append: (text: string) => void): Writable {
  return new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      append(text);
      onOutput?.({ stream, data: text });
      callback();
    },
  });
}

export function createVercelExec(sandbox: VercelSandboxLike, root: string): NimboExec {
  return {
    // docs/tech/single-ledger.md §6.1（@nimbo/core 审批三值重构，P13-5-2c）：旧 "never" → "allow"（沙盒实现，隔离即边界）。
    defaultApproval: "allow",
    describe(): string {
      return DESCRIBE;
    },
    async exec(req: ExecRequest, execOpts?: ExecOptions): Promise<ExecResult> {
      const start = Date.now();
      const cwd = resolveCwd(root, req.cwd);

      const timeoutController = new AbortController();
      const timer = req.timeoutMs !== undefined ? setTimeout(() => timeoutController.abort(), req.timeoutMs) : undefined;
      const combined = AbortSignal.any([req.signal, timeoutController.signal]);

      let stdout = "";
      let stderr = "";
      const stdoutStream = collectorStream("stdout", execOpts?.onOutput, (text) => {
        stdout += text;
      });
      const stderrStream = collectorStream("stderr", execOpts?.onOutput, (text) => {
        stderr += text;
      });

      const work = sandbox.runCommand({
        cmd: "bash",
        args: ["-lc", req.command],
        cwd,
        signal: combined,
        stdout: stdoutStream,
        stderr: stderrStream,
        ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
      });

      try {
        const result = await raceAbort(work, combined);
        return { exitCode: result.exitCode, stdout, stderr, durationMs: Date.now() - start };
      } catch (error) {
        const timedOut = timeoutController.signal.aborted;
        if (error instanceof VercelExecAbortedError || timedOut) {
          return {
            exitCode: timedOut ? 124 : 130,
            stdout,
            stderr: appendNote(
              stderr,
              timedOut ? `vercel sandbox: command timed out after ${String(req.timeoutMs)}ms` : "vercel sandbox: aborted",
            ),
            durationMs: Date.now() - start,
          };
        }
        // P6-1：exec() 契约不 reject——runCommand 本身抛出的真实错误（最常见是
        // 沙盒已停止/会话过期）翻译成带指导文案的非零结果，而不是让它冒泡。
        return {
          exitCode: 1,
          stdout,
          stderr: appendNote(stderr, execFailureGuidance(error)),
          durationMs: Date.now() - start,
        };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}
