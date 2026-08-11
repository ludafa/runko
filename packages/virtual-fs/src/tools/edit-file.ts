/**
 * `edit-file`（docs/core/builtin-tools/tech.md §1.3）：精确子串替换，唯一命中或
 * `replace_all`；未命中/多命中返回指导性错误；要求先读且 mtime 一致（§0.4）。
 */
import { z } from "zod";
import { defineTool } from "@nimbo/core";
import type { Tool, ToolReturn } from "@nimbo/core";
import { NotFoundError, ReferenceNotResolvable } from "../memory.js";
import { checkReadBeforeWrite, type CreateFileToolsOptions, decode, describeError, errorResult, registerWrite } from "./shared.js";

const inputSchema = z.object({
  path: z.string(),
  old_string: z.string(),
  new_string: z.string(),
  replace_all: z.boolean().optional(),
});

function countOccurrences(text: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = text.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = text.indexOf(needle, idx + needle.length);
  }
  return count;
}

function replaceFirst(text: string, needle: string, replacement: string): string {
  const idx = text.indexOf(needle);
  return text.slice(0, idx) + replacement + text.slice(idx + needle.length);
}

export function createEditFileTool(opts: CreateFileToolsOptions): Tool {
  return defineTool({
    description:
      "Replace an exact-match substring (old_string) with new_string in a file already read-file'd in this " +
      "session. old_string must match exactly once unless replace_all is set — include enough surrounding " +
      "context (e.g. a full line or more) to make it unique. The file must be unchanged since it was last read " +
      "(mtime-checked); if it may have changed (e.g. an earlier edit-file call, or a bash command), read-file it " +
      "again first, except that this tool itself keeps the file 'known' after a successful edit, so consecutive " +
      "edit-file calls do not require re-reading in between.",
    inputSchema,
    execute: async (input, ctx): Promise<ToolReturn> => {
      if (input.old_string === input.new_string) {
        return errorResult("old_string and new_string are identical — there is nothing to change.");
      }

      let stat;
      try {
        stat = await ctx.fs.stat(input.path);
      } catch (error) {
        if (error instanceof NotFoundError) {
          return errorResult(`"${input.path}" does not exist. Use write-file to create a new file instead of edit-file.`);
        }
        return errorResult(`Failed to stat "${input.path}": ${describeError(error)}.`);
      }

      if (stat.type === "dir") {
        return errorResult(`"${input.path}" is a directory; edit-file only operates on files.`);
      }

      const failure = checkReadBeforeWrite(input.path, stat.mtime, opts.readState);
      if (failure !== undefined) return errorResult(failure);

      let text: string;
      try {
        text = decode(await ctx.fs.readFile(input.path));
      } catch (error) {
        if (error instanceof ReferenceNotResolvable) {
          return errorResult(
            `"${input.path}" is a reference entry with no resolvable local content (href=${error.href}); ` +
              "edit-file cannot edit it. Inject a resolveReference() to read it, or edit a different path.",
          );
        }
        return errorResult(`Failed to read "${input.path}": ${describeError(error)}.`);
      }

      const occurrences = countOccurrences(text, input.old_string);
      if (occurrences === 0) {
        return errorResult(
          `old_string was not found in "${input.path}". It must match the file's current content exactly, ` +
            "including whitespace and line breaks. Call read-file again to see the exact current text, then " +
            "copy old_string from there.",
        );
      }
      if (occurrences > 1 && !input.replace_all) {
        return errorResult(
          `old_string matches ${occurrences} locations in "${input.path}". Either pass replace_all:true to ` +
            "replace all of them, or make old_string longer/more specific (include more surrounding lines) so " +
            "it uniquely identifies a single location.",
        );
      }

      const newText = input.replace_all ? text.split(input.old_string).join(input.new_string) : replaceFirst(text, input.old_string, input.new_string);

      await ctx.fs.writeFile(input.path, newText);
      await registerWrite(ctx.fs, input.path, opts.readState);
      opts.onFileChange?.([{ path: input.path, kind: "update" }]);

      return `Edited "${input.path}" (${occurrences} replacement${occurrences === 1 ? "" : "s"}).`;
    },
  });
}
