/**
 * 错误归一：结构判别，不用 `instanceof`（docs/tech/sandbox.md §8.1——宿主与本包各自安装的
 * `@vercel/sandbox` 副本类不同一，`instanceof` 天然不可靠；实测过的真实 SDK
 * 抛出物——`APIError`/`StreamError`——也都只是"带 `.code`/`.message` 字段的
 * `Error` 子类"，结构判别足够识别）。
 */
import { DirectoryNotEmptyError, NotFoundError } from "@nimbo/virtual-fs";

/**
 * catch 绑定是 `unknown`（strict 模式）——从中安全收窄出"带字符串 code 的
 * Error"是标准写法（同 `@nimbo/virtual-fs` DirFS 的 `isErrnoException` 先例），
 * 不是到处逃逸的 `unknown`。
 */
export function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * fs.* 调用失败后的统一翻译：`ENOENT` → `NotFoundError`；`ENOTEMPTY` →
 * `DirectoryNotEmptyError`；其余原样浮出但补上操作名 + 路径（远程沙盒的错误
 * 消息本身往往不含这两项上下文），并用 `cause` 保留原始错误可追溯。
 */
export function translateFsError(op: string, path: string, error: unknown): Error {
  if (isErrnoException(error)) {
    if (error.code === "ENOENT") {return new NotFoundError(path);}
    if (error.code === "ENOTEMPTY") {return new DirectoryNotEmptyError(path);}
  }
  return new Error(`vercel sandbox: fs.${op} "${path}" failed: ${describeError(error)}`, {
    cause: error instanceof Error ? error : undefined,
  });
}

/**
 * exec 失败翻译成带指导文案的说明（P6-1：不 reject，作为 `ExecResult.stderr`
 * 内容 resolve）——运行时抛出且非我们自己的超时/中止时，最常见成因就是沙盒
 * 已停止/会话过期（docs/tech/sandbox.md §4 第 7 点、§8.2），无法结构判别具体是哪一种（SDK
 * 未公开一个专门的"已停止"错误码字段），所以给通用指引而非精确诊断。
 */
export function execFailureGuidance(error: unknown): string {
  return (
    `vercel sandbox: command failed to run: ${describeError(error)}. This usually means the sandbox has been ` +
    "stopped or its session has expired (Vercel Sandboxes auto-terminate after their configured timeout). " +
    "Create a fresh Sandbox (or Sandbox.get({ name, resume: true }) / extendTimeout() before it expires) and " +
    "pass it to vercelWorkspace() again."
  );
}
