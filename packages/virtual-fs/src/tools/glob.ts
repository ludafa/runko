/**
 * `glob`（04-builtin-tools.md §1.7）：匹配路径列表，按路径排序（虚拟 FS 无
 * 有意义 mtime，不按修改时间排）；1000 条上限。
 */
import { z } from "zod";
import { defineTool } from "@nimbo/core";
import type { Tool, ToolReturn } from "@nimbo/core";
import { GLOB_MAX_MATCHES, describeError, errorResult, joinGlobPattern, truncationNotice } from "./shared.js";

const inputSchema = z.object({
  pattern: z.string(),
  path: z.string().optional(),
});

export function createGlobTool(): Tool {
  return defineTool({
    description:
      "Find files by glob pattern (e.g. '**/*.ts', 'src/**/*.test.ts'). Matches files only, never directories. " +
      "Optionally scope the search under path. Results are sorted by path (the virtual FS has no meaningful " +
      "mtime to sort by) and capped at 1000 matches — narrow the pattern or path if you hit the cap.",
    inputSchema,
    execute: async (input, ctx): Promise<ToolReturn> => {
      const base = input.path ?? "/";
      const pattern = joinGlobPattern(base, input.pattern);

      let matches: string[];
      try {
        matches = await ctx.fs.glob(pattern);
      } catch (error) {
        return errorResult(`glob failed for pattern "${input.pattern}" under "${base}": ${describeError(error)}.`);
      }

      const sorted = [...matches].sort();
      if (sorted.length === 0) {
        return `No files matched "${input.pattern}"${input.path !== undefined ? ` under "${input.path}"` : ""}. Try list_dir to see what's actually there, or widen the pattern.`;
      }

      const truncated = sorted.length > GLOB_MAX_MATCHES;
      const shown = truncated ? sorted.slice(0, GLOB_MAX_MATCHES) : sorted;
      let body = shown.join("\n");
      if (truncated) {
        body += `\n${truncationNotice(`showing ${GLOB_MAX_MATCHES} of ${sorted.length} matches`, "Narrow the pattern or path to see the rest.")}`;
      }
      return body;
    },
  });
}
