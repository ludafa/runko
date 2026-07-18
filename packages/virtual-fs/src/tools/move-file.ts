/**
 * `move-file`（docs/tech/builtin-tools.md §1.5）：重命名/移动；`to` 已存在且未
 * `overwrite` → 拒绝；事件为 `delete(from)` + `add(to)`（v1 不引入 rename kind）。
 *
 * 目录内含 reference 条目时拒绝整体移动而不是静默丢弃——设计裁量：`NimboFS`
 * 接口只有 `readFile`/`writeFile`，没有"复制一个 reference 条目的元信息"的
 * 通用原语（`writeReference` 是 `MemoryFS` 的附加能力，不在接口里，工具不能
 * 依赖具体实现）。若不做这个前置检查，目录移动流程会先把普通文件搬过去、
 * 再对整个 `from` 目录做 `rm(recursive:true)`——那一步会把还没搬走的
 * reference 条目一并删掉，造成静默数据丢失。宁可拒绝并告知原因。
 */
import { z } from "zod";
import { defineTool } from "@nimbo/core";
import type { Tool, ToolReturn } from "@nimbo/core";
import { NotFoundError, ReferenceNotResolvable } from "../memory.js";
import { normalizePath } from "../path.js";
import { type CreateFileToolsOptions, describeError, errorResult, registerWrite } from "./shared.js";
import type { FileChange } from "./shared.js";

const inputSchema = z.object({
  from: z.string(),
  to: z.string(),
  overwrite: z.boolean().optional(),
});

export function createMoveFileTool(opts: CreateFileToolsOptions): Tool {
  return defineTool({
    description:
      "Move or rename a file or directory. Fails if `to` already exists unless overwrite:true. Produces a " +
      "delete(from) + add(to) file_change pair (nimbo v1 has no dedicated rename kind).",
    inputSchema,
    execute: async (input, ctx): Promise<ToolReturn> => {
      const from = normalizePath(input.from);
      const to = normalizePath(input.to);

      if (from === to) {
        return errorResult(`from and to are the same path ("${from}"); nothing to move.`);
      }

      let fromStat;
      try {
        fromStat = await ctx.fs.stat(from);
      } catch (error) {
        if (error instanceof NotFoundError) return errorResult(`"${from}" does not exist.`);
        return errorResult(`Failed to stat "${from}": ${describeError(error)}.`);
      }

      if (fromStat.type === "dir" && to.startsWith(`${from}/`)) {
        return errorResult(`Cannot move directory "${from}" into its own subtree ("${to}").`);
      }

      let toExists = true;
      try {
        await ctx.fs.stat(to);
      } catch (error) {
        if (error instanceof NotFoundError) toExists = false;
        else return errorResult(`Failed to stat destination "${to}": ${describeError(error)}.`);
      }
      if (toExists && !input.overwrite) {
        return errorResult(`"${to}" already exists. Pass { overwrite: true } to replace it, or choose a different destination.`);
      }

      const changes: FileChange[] = [];

      if (fromStat.type === "dir") {
        const files = await ctx.fs.glob(`${from}/**`);
        const entries = await Promise.all(files.map(async (path) => ({ path, stat: await ctx.fs.stat(path) })));
        const referenceEntry = entries.find((entry) => entry.stat.type === "reference");
        if (referenceEntry !== undefined) {
          return errorResult(
            `"${from}" contains a reference entry at "${referenceEntry.path}" that move-file cannot relocate ` +
              "(there is no generic way to copy a reference entry's metadata through the NimboFS interface). " +
              "Move the regular files individually instead, or leave this subtree where it is.",
          );
        }
        for (const entry of entries) {
          const relative = entry.path.slice(from.length);
          const destPath = `${to}${relative}`;
          const data = await ctx.fs.readFile(entry.path);
          await ctx.fs.writeFile(destPath, data);
          await registerWrite(ctx.fs, destPath, opts.readState);
          changes.push({ path: entry.path, kind: "delete" }, { path: destPath, kind: "add" });
        }
        await ctx.fs.rm(from, { recursive: true });
      } else {
        let data: Uint8Array;
        try {
          data = await ctx.fs.readFile(from);
        } catch (error) {
          if (error instanceof ReferenceNotResolvable) {
            return errorResult(
              `"${from}" is a reference entry with no resolvable local content (href=${error.href}); move-file ` +
                "cannot relocate it (no generic way to copy a reference entry's metadata through the NimboFS interface).",
            );
          }
          return errorResult(`Failed to read "${from}": ${describeError(error)}.`);
        }
        await ctx.fs.writeFile(to, data);
        await registerWrite(ctx.fs, to, opts.readState);
        await ctx.fs.rm(from);
        changes.push({ path: from, kind: "delete" }, { path: to, kind: "add" });
      }

      if (changes.length > 0) opts.onFileChange?.(changes);
      return `Moved "${from}" to "${to}".`;
    },
  });
}
