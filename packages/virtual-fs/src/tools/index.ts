/**
 * 文件工具八件套的工厂入口（04-builtin-tools.md §1.1–§1.8, §4；tech-spec §4.5）。
 * `createFileTools(opts)` 是 P4（core session/ToolRuntime）落地前的可注入接缝——
 * 设计理由见 `shared.ts` 顶部注释。
 */
import type { BuiltinToolName, Tool } from "@nimbo/core";
import { createDeleteFileTool } from "./delete-file.js";
import { createEditFileTool } from "./edit-file.js";
import { createGlobTool } from "./glob.js";
import { createGrepTool } from "./grep.js";
import { createListDirTool } from "./list-dir.js";
import { createMoveFileTool } from "./move-file.js";
import { createReadFileTool } from "./read-file.js";
import type { CreateFileToolsOptions } from "./shared.js";
import { createWriteFileTool } from "./write-file.js";

export type { CreateFileToolsOptions, FileChange, ReadStateStore } from "./shared.js";

/** 八件套的工具名集合：`BuiltinToolName` 去掉 `update_plan`（那个归 core/P4）。 */
export type FileToolName = Exclude<BuiltinToolName, "update_plan">;

export function createFileTools(opts: CreateFileToolsOptions): Record<FileToolName, Tool> {
  return {
    read_file: createReadFileTool(opts),
    write_file: createWriteFileTool(opts),
    edit_file: createEditFileTool(opts),
    delete_file: createDeleteFileTool(opts),
    move_file: createMoveFileTool(opts),
    list_dir: createListDirTool(),
    glob: createGlobTool(),
    grep: createGrepTool(),
  };
}
