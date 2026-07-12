/** `echo`：唯一支持的旗标是 `-n`（抑制结尾换行）。不读文件/stdin，无副作用。 */
import type { CommandFn } from "./types.js";

export const echo: CommandFn = (args) => {
  const noNewline = args[0] === "-n";
  const words = noNewline ? args.slice(1) : args;
  const text = words.join(" ");
  return Promise.resolve({ stdout: noNewline ? text : `${text}\n`, stderr: "", exitCode: 0 });
};
