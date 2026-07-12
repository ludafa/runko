/** `cat`：多文件按参数顺序原样拼接；无参数消费 stdin（管道右侧）。不支持任何旗标。 */
import { readFileForCommand } from "./shared.js";
import type { CommandFn } from "./types.js";

export const cat: CommandFn = async (args, ctx) => {
  if (args.length === 0) {
    return { stdout: ctx.stdin ?? "", stderr: "", exitCode: 0 };
  }

  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  for (const rawPath of args) {
    const outcome = await readFileForCommand(ctx.fs, ctx.cwd, "cat", rawPath);
    if (outcome.ok) {
      stdout += outcome.text;
    } else {
      stderr += `${outcome.message}\n`;
      exitCode = 1;
    }
  }
  return { stdout, stderr, exitCode };
};
