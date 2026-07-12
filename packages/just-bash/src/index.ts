/**
 * @nimbo/just-bash 公共入口（tech-spec §4.5b）：`justBash(fs, opts?)` 返回一个
 * 跑在任意 NimboFS 之上的全语法档 `NimboExec`（if/for/while/case/函数等，见
 * `exec.ts`）。公共 API 面按工单要求收紧到这一个函数 + 它需要的选项/限额类型
 * ——`createFsAdapter`/`IFileSystem` 适配细节不导出，测试用相对路径直接引用
 * src（同 `@nimbo/mini-bash` 的 `parse()`/`COMMANDS` 先例）。
 */
export { justBash } from "./exec.js";
export type { ExecutionLimits, JustBashOptions } from "./exec.js";
