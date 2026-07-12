/**
 * `grep`（04-builtin-tools.md §1.8）：正则、files/content 双模式、±context、
 * 100 文件/500 行上限、ignore_case。纯 JS 正则逐文件扫描（虚拟 FS 内容本来
 * 就在内存/overlay 里，无需 ripgrep）。
 */
import { z } from "zod";
import { defineTool } from "@nimbo/core";
import type { NimboFS, Tool, ToolReturn } from "@nimbo/core";
import { GREP_MAX_FILES, GREP_MAX_LINES, decode, describeError, errorResult, isTextMimeType, joinGlobPattern, truncationNotice } from "./shared.js";

const inputSchema = z.object({
  pattern: z.string(),
  path: z.string().optional(),
  glob: z.string().optional(),
  mode: z.enum(["files", "content"]).optional(),
  context: z.number().int().min(0).optional(),
  ignore_case: z.boolean().optional(),
});

/** Directories/references/binary files are not text-searchable; returns undefined to skip them. */
async function readTextOrSkip(fs: NimboFS, path: string): Promise<string | undefined> {
  let stat;
  try {
    stat = await fs.stat(path);
  } catch {
    return undefined;
  }
  if (stat.type !== "file" || !isTextMimeType(stat.mimeType)) return undefined;
  try {
    return decode(await fs.readFile(path));
  } catch {
    return undefined;
  }
}

function describePattern(pattern: string, ignoreCase: boolean | undefined): string {
  return `/${pattern}/${ignoreCase ? "i" : ""}`;
}

async function grepFiles(fs: NimboFS, candidates: string[], regex: RegExp, base: string, pattern: string, ignoreCase: boolean | undefined): Promise<ToolReturn> {
  const matched: string[] = [];
  for (const path of candidates) {
    const text = await readTextOrSkip(fs, path);
    if (text !== undefined && regex.test(text)) matched.push(path);
  }
  if (matched.length === 0) {
    return `No files under "${base}" match ${describePattern(pattern, ignoreCase)}.`;
  }
  const truncated = matched.length > GREP_MAX_FILES;
  const shown = truncated ? matched.slice(0, GREP_MAX_FILES) : matched;
  let body = shown.join("\n");
  if (truncated) {
    body += `\n${truncationNotice(`showing ${GREP_MAX_FILES} of ${matched.length} matching files`, "Narrow the pattern, path, or glob to see the rest.")}`;
  }
  return body;
}

interface ContentLine {
  lineNumber: number;
  content: string;
  isMatch: boolean;
}

interface FileMatchGroup {
  path: string;
  lines: ContentLine[];
}

function collectFileMatches(text: string, regex: RegExp, context: number): ContentLine[] | undefined {
  const lines = text.length === 0 ? [] : text.split("\n");
  const matchedIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i] ?? "")) matchedIdx.push(i);
  }
  if (matchedIdx.length === 0) return undefined;

  const included = new Set<number>();
  for (const idx of matchedIdx) {
    const from = Math.max(0, idx - context);
    const to = Math.min(lines.length - 1, idx + context);
    for (let j = from; j <= to; j++) included.add(j);
  }
  const matchedSet = new Set(matchedIdx);
  return [...included].sort((a, b) => a - b).map((i) => ({ lineNumber: i + 1, content: lines[i] ?? "", isMatch: matchedSet.has(i) }));
}

async function grepContent(
  fs: NimboFS,
  candidates: string[],
  regex: RegExp,
  context: number,
  base: string,
  pattern: string,
  ignoreCase: boolean | undefined,
): Promise<ToolReturn> {
  const groups: FileMatchGroup[] = [];
  for (const path of candidates) {
    const text = await readTextOrSkip(fs, path);
    if (text === undefined) continue;
    const lines = collectFileMatches(text, regex, context);
    if (lines !== undefined) groups.push({ path, lines });
  }

  if (groups.length === 0) {
    return `No matches for ${describePattern(pattern, ignoreCase)} under "${base}".`;
  }

  const fileCapped = groups.length > GREP_MAX_FILES;
  const cappedGroups = fileCapped ? groups.slice(0, GREP_MAX_FILES) : groups;

  const output: string[] = [];
  let lineCapped = false;
  outer: for (const group of cappedGroups) {
    for (const line of group.lines) {
      if (output.length >= GREP_MAX_LINES) {
        lineCapped = true;
        break outer;
      }
      const sep = line.isMatch ? ":" : "-";
      output.push(`${group.path}${sep}${line.lineNumber}${sep}${line.content}`);
    }
  }

  let body = output.join("\n");
  if (fileCapped || lineCapped) {
    const reason = fileCapped ? `showing ${GREP_MAX_FILES} of ${groups.length} matching files` : `hit the ${GREP_MAX_LINES}-line output cap`;
    body += `\n${truncationNotice(reason, "Narrow the pattern, path, or glob, or reduce context, to see the rest.")}`;
  }
  return body;
}

export function createGrepTool(): Tool {
  return defineTool({
    description:
      "Search file contents with a JavaScript regular expression (not POSIX/PCRE). mode:'files' (default) " +
      "returns the list of matching file paths; mode:'content' returns matching lines with line numbers " +
      "('path:line:text' for a match, 'path-line-text' for ±context lines). Scope with path/glob, expand context " +
      "with context (lines of surrounding text per match), and set ignore_case for case-insensitive matching. " +
      "Capped at 100 matching files / 500 output lines, whichever hits first. Binary files are skipped.",
    inputSchema,
    execute: async (input, ctx): Promise<ToolReturn> => {
      let regex: RegExp;
      try {
        regex = new RegExp(input.pattern, input.ignore_case ? "i" : "");
      } catch (error) {
        return errorResult(
          `Invalid regular expression "${input.pattern}": ${describeError(error)}. nimbo grep uses JavaScript ` +
            "RegExp syntax (not POSIX/PCRE) — check for unsupported syntax.",
        );
      }

      const base = input.path ?? "/";
      const scopePattern = joinGlobPattern(base, input.glob ?? "**");
      let candidates: string[];
      try {
        candidates = await ctx.fs.glob(scopePattern);
      } catch (error) {
        return errorResult(`grep failed to list files under "${base}": ${describeError(error)}.`);
      }
      candidates = [...candidates].sort();

      const mode = input.mode ?? "files";
      if (mode === "files") {
        return grepFiles(ctx.fs, candidates, regex, base, input.pattern, input.ignore_case);
      }
      return grepContent(ctx.fs, candidates, regex, input.context ?? 0, base, input.pattern, input.ignore_case);
    },
  });
}
