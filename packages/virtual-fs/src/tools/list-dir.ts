/**
 * `list-dir`（docs/core/builtin-tools/tech.md §1.6）：目录树文本，默认根/depth 1；行尾标注
 * 非文本文件的 mimeType、reference 的 `→ href`、annotations.description；
 * 500 条目上限。
 */
import { z } from "zod";
import { defineTool } from "@nimbo/core";
import type { DirEntry, NimboFS, Tool, ToolReturn } from "@nimbo/core";
import { NotFoundError } from "../memory.js";
import { LIST_DIR_MAX_ENTRIES, describeError, errorResult, isTextMimeType, truncationNotice } from "./shared.js";

const inputSchema = z.object({
  path: z.string().optional(),
  depth: z.number().int().min(1).optional(),
});

function buildMetaSuffix(entry: DirEntry): string {
  let suffix = "";
  if (entry.type === "reference") {
    suffix += ` → ${entry.href ?? ""}`;
    if (entry.mimeType !== undefined) suffix += ` [${entry.mimeType}]`;
  } else if (entry.type === "file" && !isTextMimeType(entry.mimeType)) {
    suffix += ` [${entry.mimeType ?? "application/octet-stream"}]`;
  }
  const description = entry.annotations?.description;
  if (description) suffix += ` — ${description}`;
  return suffix;
}

interface WalkState {
  count: number;
  truncated: boolean;
}

async function walk(fs: NimboFS, dirPath: string, currentDepth: number, maxDepth: number, indent: string, lines: string[], state: WalkState): Promise<void> {
  if (state.truncated) return;
  const entries = await fs.readdir(dirPath);
  for (const entry of entries) {
    if (state.count >= LIST_DIR_MAX_ENTRIES) {
      state.truncated = true;
      return;
    }
    state.count += 1;
    const childPath = dirPath === "/" ? `/${entry.name}` : `${dirPath}/${entry.name}`;
    const suffix = buildMetaSuffix(entry);
    if (entry.type === "dir") {
      lines.push(`${indent}${entry.name}/${suffix}`);
      if (currentDepth < maxDepth) {
        await walk(fs, childPath, currentDepth + 1, maxDepth, `${indent}  `, lines, state);
        if (state.truncated) return;
      }
    } else {
      lines.push(`${indent}${entry.name}${suffix}`);
    }
  }
}

export function createListDirTool(): Tool {
  return defineTool({
    description:
      "List a directory's contents as an indented tree. Defaults to the workspace root and depth 1 (immediate " +
      "children only; subdirectories are shown but not expanded). Non-text files are annotated with [mimeType], " +
      "reference entries with '→ href', and entries with a host-provided description get it appended. Capped at " +
      "500 entries — narrow with a deeper path or use glob for a flat, pattern-filtered listing instead.",
    inputSchema,
    readOnly: true,
    execute: async (input, ctx): Promise<ToolReturn> => {
      const path = input.path ?? "/";
      const depth = input.depth ?? 1;

      let stat;
      try {
        stat = await ctx.fs.stat(path);
      } catch (error) {
        if (error instanceof NotFoundError) {
          return errorResult(`"${path}" does not exist. Check the path with glob, or list a parent directory first.`);
        }
        return errorResult(`Failed to stat "${path}": ${describeError(error)}.`);
      }
      if (stat.type === "file") {
        return errorResult(`"${path}" is a file, not a directory. Use read-file to view it.`);
      }
      if (stat.type === "reference") {
        return errorResult(`"${path}" is a reference entry, not a directory.`);
      }

      const lines: string[] = [];
      const state: WalkState = { count: 0, truncated: false };
      await walk(ctx.fs, path, 1, depth, "", lines, state);

      let body = lines.length > 0 ? lines.join("\n") : "(empty directory)";
      if (state.truncated) {
        body += `\n${truncationNotice(`reached the ${LIST_DIR_MAX_ENTRIES}-entry limit`, "Narrow the listing with a deeper/more specific path, or use glob instead.")}`;
      }
      return `${path}\n${body}`;
    },
  });
}
