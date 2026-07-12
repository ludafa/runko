/**
 * e2b 错误的结构判别（docs/06 §8.1："错误识别一律结构判别不用 instanceof"——
 * 宿主与本包各自安装的 `e2b` 副本类不同一，`instanceof` 天然不可靠）。
 * `instanceof Error` 本身没问题（`Error` 是当前 realm 的全局内置类，不是
 * e2b 的导出类），只有对 e2b 自家导出的错误类才不能用 instanceof。
 */

/** e2b 的具名错误（`SandboxError` 及其子类）都在构造函数里把 `this.name` 设成子类名——按这个字符串字段判别，不按类名/`instanceof`。 */
export function isE2bErrorNamed(error: unknown, ...names: readonly string[]): error is Error {
  return error instanceof Error && names.includes(error.name);
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `commands.run()` 非零退出码时，e2b 抛出一个结构形如 `CommandExitError` 的
 * 异常：`exitCode: number` + `stdout`/`stderr: string`（均为 getter，无损携带
 * 完整结果）。按这三个字段的形状识别，同样不依赖类名/`instanceof`。
 */
export interface CommandExitErrorLike {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function isCommandExitErrorLike(error: unknown): error is CommandExitErrorLike {
  if (typeof error !== "object" || error === null) return false;
  if (!("exitCode" in error) || typeof error.exitCode !== "number") return false;
  if (!("stdout" in error) || typeof error.stdout !== "string") return false;
  if (!("stderr" in error) || typeof error.stderr !== "string") return false;
  return true;
}
