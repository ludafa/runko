/** `tail [-n N] [file...]`：默认 N=10；多文件带 `==> file <==` 头；无参数消费 stdin。 */
import { joinLines, parseCountArgs, readFileForCommand, splitLines } from "./shared.js";
import type { CommandFn } from "./types.js";

/**
 * 不用 `lines.slice(-n)`：当 n 恰为 0 时 `-0 === 0`，`slice(0)` 会返回
 * 整个数组而不是空数组——这是 JS 众所周知的 `-0` 坑，显式判断更清楚。
 */
function takeTail(lines: string[], n: number): string[] {
  if (n <= 0) {return [];}
  if (n >= lines.length) {return lines;}
  return lines.slice(lines.length - n);
}

export const tail: CommandFn = async (args, ctx) => {
  const parsed = parseCountArgs(args, "tail");
  if ("error" in parsed) {
    return { stdout: "", stderr: `${parsed.error}\n`, exitCode: 1 };
  }
  const { n, files } = parsed;

  if (files.length === 0) {
    const lines = splitLines(ctx.stdin ?? "");
    return { stdout: joinLines(takeTail(lines, n)), stderr: "", exitCode: 0 };
  }

  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  const showHeader = files.length > 1;
  for (let idx = 0; idx < files.length; idx++) {
    const rawPath = files[idx];
    if (rawPath === undefined) {continue;}
    const outcome = await readFileForCommand(ctx.fs, ctx.cwd, "tail", rawPath);
    if (!outcome.ok) {
      stderr += `${outcome.message}\n`;
      exitCode = 1;
      continue;
    }
    if (showHeader) {stdout += `${idx > 0 ? "\n" : ""}==> ${rawPath} <==\n`;}
    stdout += joinLines(takeTail(splitLines(outcome.text), n));
  }
  return { stdout, stderr, exitCode };
};
