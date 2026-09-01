/**
 * `glob`（docs/tech/builtin-tools.md §1.7）：匹配路径列表，按路径排序（虚拟 FS 无
 * 有意义 mtime，不按修改时间排）；1000 条上限。默认忽略 `.git`/`node_modules`
 * （docs/tech/sandbox.md §4，`DEFAULT_SEARCH_IGNORE`）。
 *
 * 双路径自适应：`ctx.fs.searchFiles` 存在时优先一次调用在底座内部完成整个
 * 扫描（远端沙盒场景省掉逐文件网络往返）；未实现该方法、或调用时抛
 * `SearchUnsupportedError`，都静默回退现有 `glob()` + JS 过滤。两条路径统一
 * 归一成 `FileSearchResult` 中间形态，喂给同一个格式化函数，保证两种底座
 * 输出逐字符一致。
 */
import { z } from "zod";
import { defineTool, SearchUnsupportedError } from "@nimbo/core";
import type { FileSearchQuery, FileSearchResult, NimboFS, Tool, ToolReturn } from "@nimbo/core";
import { globToRegExp, isIgnoredPath } from "../path.js";
import { GLOB_MAX_MATCHES, describeError, errorResult, joinGlobPattern, resolveDefaultIgnore, truncationNotice } from "./shared.js";

const inputSchema = z.object({
  pattern: z.string(),
  path: z.string().optional(),
});

/** JS 逐文件扫描回退：`fs.glob()` 拿候选集，本地应用 ignore 过滤 + 排序 + 源头截断。 */
async function fallbackSearchFiles(fs: NimboFS, query: FileSearchQuery): Promise<FileSearchResult> {
  const matches = await fs.glob(query.pattern);
  const ignorePatterns = (query.ignore ?? []).map(globToRegExp);
  const filtered = matches.filter((path) => !isIgnoredPath(path, ignorePatterns)).sort();
  return { paths: filtered.slice(0, query.limit), total: filtered.length };
}

async function resolveFileSearch(fs: NimboFS, query: FileSearchQuery): Promise<FileSearchResult> {
  if (fs.searchFiles) {
    try {
      return await fs.searchFiles(query);
    } catch (error) {
      if (!(error instanceof SearchUnsupportedError)) {throw error;}
      // 落空则回退到下面的 JS 扫描——不是错误路径。
    }
  }
  return fallbackSearchFiles(fs, query);
}

function formatFileSearchResult(result: FileSearchResult, pattern: string, path: string | undefined): ToolReturn {
  if (result.paths.length === 0) {
    return `No files matched "${pattern}"${path !== undefined ? ` under "${path}"` : ""}. Try list-dir to see what's actually there, or widen the pattern.`;
  }
  let body = result.paths.join("\n");
  if (result.total > result.paths.length) {
    body += `\n${truncationNotice(`showing ${result.paths.length} of ${result.total} matches`, "Narrow the pattern or path to see the rest.")}`;
  }
  return body;
}

export function createGlobTool(): Tool {
  return defineTool({
    description:
      "Find files by glob pattern (e.g. '**/*.ts', 'src/**/*.test.ts'). Matches files only, never directories. " +
      "Optionally scope the search under path. Results are sorted by path (the virtual FS has no meaningful " +
      "mtime to sort by) and capped at 1000 matches — narrow the pattern or path if you hit the cap. Skips " +
      ".git and node_modules by default; point path explicitly inside one of them (e.g. path: '/.git') to search it anyway.",
    inputSchema,
    readOnly: true,
    execute: async (input, ctx): Promise<ToolReturn> => {
      const base = input.path ?? "/";
      const pattern = joinGlobPattern(base, input.pattern);
      const query: FileSearchQuery = { pattern, ignore: resolveDefaultIgnore(base), limit: GLOB_MAX_MATCHES };

      let result: FileSearchResult;
      try {
        result = await resolveFileSearch(ctx.fs, query);
      } catch (error) {
        return errorResult(`glob failed for pattern "${input.pattern}" under "${base}": ${describeError(error)}.`);
      }

      return formatFileSearchResult(result, input.pattern, input.path);
    },
  });
}
