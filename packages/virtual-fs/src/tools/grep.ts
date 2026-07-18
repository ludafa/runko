/**
 * `grep`（docs/tech/builtin-tools.md §1.8）：正则、files/content 双模式、±context、
 * 100 文件/500 行上限、ignore_case。默认忽略 `.git`/`node_modules`
 * （docs/tech/sandbox.md §4，`DEFAULT_SEARCH_IGNORE`）。
 *
 * 双路径自适应：`ctx.fs.searchContent` 存在时优先一次调用在底座内部完成整个
 * 搜索（远端沙盒场景省掉逐文件网络往返）；未实现该方法、或调用时抛
 * `SearchUnsupportedError`，都静默回退现有 JS 正则逐文件扫描（虚拟 FS 内容本来
 * 就在内存/overlay 里，无需 ripgrep）。两条路径统一归一成 `ContentSearchResult`
 * 中间形态，喂给同一个格式化函数，保证两种底座输出逐字符一致——用
 * **JavaScript 正则语义**（非 POSIX/PCRE），非法正则返回带提示错误。
 */
import { z } from "zod";
import { defineTool, SearchUnsupportedError } from "@nimbo/core";
import type { ContentSearchGroup, ContentSearchLine, ContentSearchQuery, ContentSearchResult, NimboFS, Tool, ToolReturn } from "@nimbo/core";
import { globToRegExp, isIgnoredPath } from "../path.js";
import { GREP_MAX_FILES, GREP_MAX_LINES, decode, describeError, errorResult, isTextMimeType, joinGlobPattern, resolveDefaultIgnore, truncationNotice } from "./shared.js";

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

/** ±context 行收集：命中行与其周边行按行号升序输出，match 区分命中行/上下文行。 */
function collectFileMatches(text: string, regex: RegExp, context: number): ContentSearchLine[] | undefined {
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
  return [...included].sort((a, b) => a - b).map((i) => ({ line: i + 1, text: lines[i] ?? "", match: matchedSet.has(i) }));
}

/**
 * `maxFiles`/`maxLines` 双闸：文件数超限先截断文件列表（`totalFiles` 仍是全量
 * 计数）；`content` 模式再按输出行数累加，哪个先到先截——与截断到的最后一组
 * 可能只保留部分行（不是整组丢弃），跟原 JS 实现逐行累加截断的行为一致。
 */
function capContentSearch(groups: ContentSearchGroup[], maxFiles: number, maxLines: number, mode: "files" | "content"): ContentSearchResult {
  const totalFiles = groups.length;
  const cappedGroups = groups.length > maxFiles ? groups.slice(0, maxFiles) : groups;

  if (mode === "files") {
    return { groups: cappedGroups, totalFiles, lineCapped: false };
  }

  const boundedGroups: ContentSearchGroup[] = [];
  let consumed = 0;
  let lineCapped = false;
  for (const group of cappedGroups) {
    if (consumed >= maxLines) {
      lineCapped = true;
      break;
    }
    const remaining = maxLines - consumed;
    if (group.lines.length <= remaining) {
      boundedGroups.push(group);
      consumed += group.lines.length;
    } else {
      boundedGroups.push({ path: group.path, lines: group.lines.slice(0, remaining) });
      consumed += remaining;
      lineCapped = true;
      break;
    }
  }
  return { groups: boundedGroups, totalFiles, lineCapped };
}

/** JS 正则逐文件扫描回退：候选集经 `fs.glob(scope)` 拿到，本地过滤 ignore + 排序后逐个读取匹配。 */
async function fallbackSearchContent(fs: NimboFS, regex: RegExp, query: ContentSearchQuery): Promise<ContentSearchResult> {
  const candidates = await fs.glob(query.scope);
  const ignorePatterns = (query.ignore ?? []).map(globToRegExp);
  const sorted = candidates.filter((path) => !isIgnoredPath(path, ignorePatterns)).sort();

  const groups: ContentSearchGroup[] = [];
  for (const path of sorted) {
    const text = await readTextOrSkip(fs, path);
    if (text === undefined) continue;
    if (query.mode === "files") {
      if (regex.test(text)) groups.push({ path, lines: [] });
    } else {
      const lines = collectFileMatches(text, regex, query.context ?? 0);
      if (lines !== undefined) groups.push({ path, lines });
    }
  }

  return capContentSearch(groups, query.maxFiles, query.maxLines, query.mode);
}

async function resolveContentSearch(fs: NimboFS, regex: RegExp, query: ContentSearchQuery): Promise<ContentSearchResult> {
  if (fs.searchContent) {
    try {
      return await fs.searchContent(query);
    } catch (error) {
      if (!(error instanceof SearchUnsupportedError)) throw error;
      // 落空则回退到下面的 JS 扫描——不是错误路径。
    }
  }
  return fallbackSearchContent(fs, regex, query);
}

function formatContentSearchResult(
  result: ContentSearchResult,
  base: string,
  pattern: string,
  ignoreCase: boolean | undefined,
  mode: "files" | "content",
): ToolReturn {
  if (result.groups.length === 0) {
    return mode === "files"
      ? `No files under "${base}" match ${describePattern(pattern, ignoreCase)}.`
      : `No matches for ${describePattern(pattern, ignoreCase)} under "${base}".`;
  }

  const fileCapped = result.totalFiles > GREP_MAX_FILES;

  if (mode === "files") {
    let body = result.groups.map((group) => group.path).join("\n");
    if (fileCapped) {
      body += `\n${truncationNotice(`showing ${GREP_MAX_FILES} of ${result.totalFiles} matching files`, "Narrow the pattern, path, or glob to see the rest.")}`;
    }
    return body;
  }

  const output: string[] = [];
  for (const group of result.groups) {
    for (const line of group.lines) {
      const sep = line.match ? ":" : "-";
      output.push(`${group.path}${sep}${line.line}${sep}${line.text}`);
    }
  }
  let body = output.join("\n");
  if (fileCapped || result.lineCapped) {
    const reason = fileCapped ? `showing ${GREP_MAX_FILES} of ${result.totalFiles} matching files` : `hit the ${GREP_MAX_LINES}-line output cap`;
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
      "Capped at 100 matching files / 500 output lines, whichever hits first. Binary files are skipped. Skips " +
      ".git and node_modules by default; point path explicitly inside one of them (e.g. path: '/.git') to search it anyway.",
    inputSchema,
    readOnly: true,
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
      const mode = input.mode ?? "files";
      const query: ContentSearchQuery = {
        pattern: input.pattern,
        ignoreCase: input.ignore_case,
        scope: joinGlobPattern(base, input.glob ?? "**"),
        ignore: resolveDefaultIgnore(base),
        mode,
        context: input.context,
        maxFiles: GREP_MAX_FILES,
        maxLines: GREP_MAX_LINES,
      };

      let result: ContentSearchResult;
      try {
        result = await resolveContentSearch(ctx.fs, regex, query);
      } catch (error) {
        return errorResult(`grep failed to list files under "${base}": ${describeError(error)}.`);
      }

      return formatContentSearchResult(result, base, input.pattern, input.ignore_case, mode);
    },
  });
}
