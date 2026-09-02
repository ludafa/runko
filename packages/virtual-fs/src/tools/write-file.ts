/**
 * `write-file`（docs/tech/builtin-tools.md §1.2）：整文件写入，父目录自动创建（FS 层
 * 已保证，工具层不重复实现——§0.2）；覆盖已存在且未读过的文件 → 拒绝（§0.4）。
 */
import { z } from "zod";
import { defineTool } from "@runko/core";
import type { Tool, ToolReturn } from "@runko/core";
import { NotFoundError } from "../memory.js";
import { byteLength, checkReadBeforeWrite, type CreateFileToolsOptions, describeError, errorResult, registerWrite } from "./shared.js";
import type { FileChange } from "./shared.js";

const inputSchema = z.object({
  path: z.string(),
  content: z.string(),
});

export function createWriteFileTool(opts: CreateFileToolsOptions): Tool {
  return defineTool({
    description:
      "Write the full text content of a file, creating it (and any missing parent directories) if it doesn't " +
      "exist, or replacing it entirely if it does. Overwriting an existing file requires having read-file'd it " +
      "first in this session (guards against blind overwrites) and the file must be unchanged since. For a " +
      "small change to a file you already know the content of, prefer edit-file — it's cheaper and doesn't " +
      "require restating the whole file.",
    inputSchema,
    execute: async (input, ctx): Promise<ToolReturn> => {
      let existing;
      try {
        existing = await ctx.fs.stat(input.path);
      } catch (error) {
        if (!(error instanceof NotFoundError)) {
          return errorResult(`Failed to check "${input.path}" before writing: ${describeError(error)}.`);
        }
        existing = undefined;
      }

      if (existing?.type === "dir") {
        return errorResult(
          `"${input.path}" is a directory; write-file cannot overwrite a directory. Choose a different path, or delete-file it first.`,
        );
      }

      if (existing !== undefined) {
        const failure = checkReadBeforeWrite(input.path, existing.mtime, opts.readState);
        if (failure !== undefined) {return errorResult(failure);}
      }

      await ctx.fs.writeFile(input.path, input.content);
      await registerWrite(ctx.fs, input.path, opts.readState);

      const change: FileChange = { path: input.path, kind: existing === undefined ? "add" : "update" };
      opts.onFileChange?.([change]);

      const bytes = byteLength(input.content);
      return `Wrote ${bytes} byte${bytes === 1 ? "" : "s"} to "${input.path}" (${existing === undefined ? "created" : "overwritten"}).`;
    },
  });
}
