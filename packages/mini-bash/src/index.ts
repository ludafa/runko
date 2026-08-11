/**
 * @nimbo/mini-bash 公共入口（docs/core/core-sdk/tech.md §4.5a / docs/core/core-sdk/plan.md P6）：
 * `miniBash(fs)` 返回一个跑在任意 NimboFS 之上的 NimboExec 纯 TS 解释器
 * 实现——不 fork 子进程，六命令（cat/grep/find/tail/head/echo）全只读，
 * `defaultApproval: "allow"`（docs/agent/single-ledger/tech.md §6.1，原
 * "never"）。公共 API 面按工单要求收紧到这一个函数；
 * parse()/COMMANDS 等内部细节不导出，测试用相对路径直接引用 src。
 */
export { miniBash } from "./exec.js";
