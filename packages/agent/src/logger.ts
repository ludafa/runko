/**
 * 框架自己的日志出口——**刻意不写 `console`**：一个库不该替宿主决定日志往哪去、
 * 长什么样。不注入就是彻底静音（`noopLogger`），注入的话形状与 `apps/node-server`
 * 的 `Logger` 结构兼容，宿主直接把自己那份传进来即可。
 */

/** 日志载荷：一层的普通对象。刻意不收 `unknown`——真要记复杂对象，宿主自己先 stringify。 */
export type LogFields = Record<string, string | number | boolean | undefined>;

export interface Logger {
  debug(scope: string, message: string, fields?: LogFields): void;
  info(scope: string, message: string, fields?: LogFields): void;
  warn(scope: string, message: string, fields?: LogFields): void;
  error(scope: string, message: string, fields?: LogFields): void;
}

export const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
