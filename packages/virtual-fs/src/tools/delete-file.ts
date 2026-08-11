/**
 * `delete-file`（docs/core/builtin-tools/tech.md §1.4）：文件/目录删除；目录需
 * `recursive: true`（工具层的业务规则，比 FS 层的 `DirectoryNotEmptyError`
 * 更严格——空目录也必须显式 recursive，§0.2 不冲突：这不是路径安全检查）；
 * 目录展开为逐文件 delete 清单（宿主拿到精确列表，而不是一条目录级事件）。
 */
import { z } from "zod";
import { defineTool } from "@nimbo/core";
import type { Tool, ToolReturn } from "@nimbo/core";
import { NotFoundError } from "../memory.js";
import { type CreateFileToolsOptions, describeError, errorResult } from "./shared.js";
import type { FileChange } from "./shared.js";

const inputSchema = z.object({
  path: z.string(),
  recursive: z.boolean().optional(),
});

export function createDeleteFileTool(opts: CreateFileToolsOptions): Tool {
  return defineTool({
    description:
      "Delete a file, or a directory and everything under it. Deleting a directory requires recursive:true, " +
      "even for an empty one — this is the only way to remove things in nimbo, since there is no bash by default.",
    inputSchema,
    execute: async (input, ctx): Promise<ToolReturn> => {
      let stat;
      try {
        stat = await ctx.fs.stat(input.path);
      } catch (error) {
        if (error instanceof NotFoundError) {
          return errorResult(`"${input.path}" does not exist; nothing to delete.`);
        }
        return errorResult(`Failed to stat "${input.path}": ${describeError(error)}.`);
      }

      if (stat.type === "dir") {
        if (!input.recursive) {
          return errorResult(`"${input.path}" is a directory. Pass { recursive: true } to delete it and everything under it.`);
        }
        const files = await ctx.fs.glob(input.path === "/" ? "/**" : `${input.path}/**`);
        await ctx.fs.rm(input.path, { recursive: true });
        const changes: FileChange[] = files.map((path) => ({ path, kind: "delete" }));
        if (changes.length > 0) opts.onFileChange?.(changes);
        return `Deleted directory "${input.path}" and ${files.length} file${files.length === 1 ? "" : "s"} under it.`;
      }

      await ctx.fs.rm(input.path);
      opts.onFileChange?.([{ path: input.path, kind: "delete" }]);
      return `Deleted "${input.path}".`;
    },
  });
}
