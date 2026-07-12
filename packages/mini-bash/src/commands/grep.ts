/**
 * `grep [-i] [-n] [-c] [-l] [-E] PATTERN [file...]`：JS RegExp 实现（不是
 * POSIX/PCRE）。`-E` 是兼容旗标——JS RegExp 本身已是"扩展"语法（`|`/`+`/
 * `?`/`{}` 原生可用），接受它但不改变匹配行为，与 describe() 的措辞一致。
 * 多文件时输出前缀文件名（对齐 GNU grep 惯例）；无匹配 exit 1，读取/正则
 * 错误 exit 2（与"无匹配"区分，对齐 POSIX grep 的三态退出码）。
 */
import { describeError, readFileForCommand, splitLines } from "./shared.js";
import type { CommandFn } from "./types.js";

interface GrepOptions {
  ignoreCase: boolean;
  showLineNumber: boolean;
  count: boolean;
  listFilesOnly: boolean;
  extendedRegex: boolean;
}

interface GrepArgs {
  options: GrepOptions;
  pattern: string;
  files: string[];
}

function parseArgs(args: string[]): GrepArgs | { error: string } {
  const options: GrepOptions = {
    ignoreCase: false,
    showLineNumber: false,
    count: false,
    listFilesOnly: false,
    extendedRegex: false,
  };
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg !== undefined && arg.length > 1 && arg.startsWith("-") && arg !== "--") {
      for (const ch of arg.slice(1)) {
        switch (ch) {
          case "i":
            options.ignoreCase = true;
            break;
          case "n":
            options.showLineNumber = true;
            break;
          case "c":
            options.count = true;
            break;
          case "l":
            options.listFilesOnly = true;
            break;
          case "E":
            options.extendedRegex = true;
            break;
          default:
            return { error: `grep: unknown option -- '${ch}'` };
        }
      }
      i += 1;
      continue;
    }
    break;
  }
  const pattern = args[i];
  if (pattern === undefined) return { error: "grep: missing pattern operand" };
  return { options, pattern, files: args.slice(i + 1) };
}

interface Source {
  label: string;
  text: string;
}

export const grep: CommandFn = async (args, ctx) => {
  const parsed = parseArgs(args);
  if ("error" in parsed) {
    return { stdout: "", stderr: `${parsed.error}\n`, exitCode: 2 };
  }
  const { options, pattern, files } = parsed;

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, options.ignoreCase ? "i" : "");
  } catch (error) {
    return { stdout: "", stderr: `grep: invalid regular expression: ${describeError(error)}\n`, exitCode: 2 };
  }

  const sources: Source[] = [];
  let stderr = "";
  let hadError = false;

  if (files.length === 0) {
    sources.push({ label: "(standard input)", text: ctx.stdin ?? "" });
  } else {
    for (const rawPath of files) {
      const outcome = await readFileForCommand(ctx.fs, ctx.cwd, "grep", rawPath);
      if (outcome.ok) {
        sources.push({ label: rawPath, text: outcome.text });
      } else {
        stderr += `${outcome.message}\n`;
        hadError = true;
      }
    }
  }

  const showLabel = files.length > 1;
  const outputLines: string[] = [];
  let anyMatch = false;

  for (const source of sources) {
    const lines = splitLines(source.text);
    const matchedLineNumbers: number[] = [];
    for (let idx = 0; idx < lines.length; idx++) {
      if (regex.test(lines[idx] ?? "")) matchedLineNumbers.push(idx + 1);
    }
    if (matchedLineNumbers.length > 0) anyMatch = true;

    if (options.count) {
      outputLines.push(showLabel ? `${source.label}:${matchedLineNumbers.length}` : String(matchedLineNumbers.length));
      continue;
    }
    if (matchedLineNumbers.length === 0) continue;
    if (options.listFilesOnly) {
      outputLines.push(source.label);
      continue;
    }
    for (const lineNo of matchedLineNumbers) {
      const content = lines[lineNo - 1] ?? "";
      const parts: string[] = [];
      if (showLabel) parts.push(source.label);
      if (options.showLineNumber) parts.push(String(lineNo));
      parts.push(content);
      outputLines.push(parts.join(":"));
    }
  }

  const stdout = outputLines.length > 0 ? `${outputLines.join("\n")}\n` : "";
  if (hadError && sources.length === 0) {
    return { stdout: "", stderr, exitCode: 2 };
  }
  return { stdout, stderr, exitCode: hadError ? 2 : anyMatch ? 0 : 1 };
};
