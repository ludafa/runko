/**
 * 文件工具八件套的工厂入口（docs/tech/builtin-tools.md §1.1–§1.8, §4；docs/tech/core-sdk.md §4.5）。
 * `createFileTools(opts)` 是 P4（core session/ToolRuntime）落地前的可注入接缝——
 * 设计理由见 `shared.ts` 顶部注释。
 */
import type { BuiltinToolName, Tool } from "@runko/core";
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

/** 八件套的工具名集合：`BuiltinToolName` 去掉 `update-plan`（那个归 core/P4）。 */
export type FileToolName = Exclude<BuiltinToolName, "update-plan">;

export function createFileTools(opts: CreateFileToolsOptions): Record<FileToolName, Tool> {
  return {
    "read-file": createReadFileTool(opts),
    "write-file": createWriteFileTool(opts),
    "edit-file": createEditFileTool(opts),
    "delete-file": createDeleteFileTool(opts),
    "move-file": createMoveFileTool(opts),
    "list-dir": createListDirTool(),
    glob: createGlobTool(),
    grep: createGrepTool(),
  };
}
