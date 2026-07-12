/** `pwd`：打印当前生效的工作目录（链内随 `cd` 变化）+ 换行；忽略任何参数；纯只读，不接触 fs。 */
import type { CommandFn } from "./types.js";

export const pwd: CommandFn = (_args, ctx) => {
  return Promise.resolve({ stdout: `${ctx.cwd}\n`, stderr: "", exitCode: 0 });
};
