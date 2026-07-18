/**
 * @nimbo/mini-bash 公共入口（docs/tech/core-sdk.md §4.5a / docs/plans/core-sdk.md P6）：
 * `miniBash(fs)` 返回一个跑在任意 NimboFS 之上的 NimboExec 纯 TS 解释器
 * 实现——不 fork 子进程，六命令（cat/grep/find/tail/head/echo）全只读，
 * `defaultApproval: "allow"`（docs/tech/single-ledger.md §6.1，原
 * "never"）。公共 API 面按工单要求收紧到这一个函数；
 * parse()/COMMANDS 等内部细节不导出，测试用相对路径直接引用 src。
 */
export { miniBash } from "./exec.js";
