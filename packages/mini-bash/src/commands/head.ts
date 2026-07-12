/** `head [-n N] [file...]`：默认 N=10；多文件带 `==> file <==` 头（对齐 GNU coreutils）；无参数消费 stdin。 */
import { joinLines, parseCountArgs, readFileForCommand, splitLines } from "./shared.js";
import type { CommandFn } from "./types.js";

export const head: CommandFn = async (args, ctx) => {
  const parsed = parseCountArgs(args, "head");
  if ("error" in parsed) {
    return { stdout: "", stderr: `${parsed.error}\n`, exitCode: 1 };
  }
  const { n, files } = parsed;

  if (files.length === 0) {
    const lines = splitLines(ctx.stdin ?? "");
    return { stdout: joinLines(lines.slice(0, n)), stderr: "", exitCode: 0 };
  }

  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  const showHeader = files.length > 1;
  for (let idx = 0; idx < files.length; idx++) {
    const rawPath = files[idx];
    if (rawPath === undefined) continue;
    const outcome = await readFileForCommand(ctx.fs, ctx.cwd, "head", rawPath);
    if (!outcome.ok) {
      stderr += `${outcome.message}\n`;
      exitCode = 1;
      continue;
    }
    if (showHeader) stdout += `${idx > 0 ? "\n" : ""}==> ${rawPath} <==\n`;
    stdout += joinLines(splitLines(outcome.text).slice(0, n));
  }
  return { stdout, stderr, exitCode };
};
