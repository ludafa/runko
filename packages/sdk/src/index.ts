/**
 * `@nimbo/sdk` 门面（docs/core/core-sdk/tech.md §2 "L3/L2/L1/L0" 分层里的主包定位、§4.2 全节）：
 * re-export `@nimbo/core` + `@nimbo/virtual-fs` + `@nimbo/mini-bash` 的全部公共
 * API，外加两处默认装配——`createSession`（fs 缺省 `MemoryFS`、文件工具八件套
 * 默认全开，见 `./session.js`）与 `NimboFS` 值命名空间（`fromMemory`/
 * `fromDirectory`，见 `./fs.js`）。产品文档 §4.1 的五行示例只装这一个包。
 *
 * ---- 命名冲突处理（三包 `export *` 汇合于此，逐条列出） ----
 *
 * - **`createSession`/`Session`**：`export * from "@nimbo/core"` 会带入 core 的
 *   原始版本（无默认装配：`fs` 缺省抛占位错误、不含文件工具）。下方
 *   `export { createSession, type Session } from "./session.js"` 用**具名**
 *   re-export（不是 `export *`）覆盖它——ECMAScript 模块规范下，同一模块内的
 *   本地/具名导出优先于任意 `export *` 带入的同名绑定，不产生重复导出错误；
 *   已用最小复现验证。宿主如果明确需要"无默认装配"的原始版本，可以直接
 *   `import { createSession } from "@nimbo/core"`——两个包都是独立可安装的，
 *   这条路径没有被这里的遮蔽切断。
 * - **`NimboFS`**：core 只导出**类型** `NimboFS`（接口），没有导出同名的值；
 *   下方 `export { NimboFS } from "./fs.js"` 额外带来同名的**值**（`fromMemory`/
 *   `fromDirectory` 命名空间对象）。这里同样必须用具名 re-export——如果改成
 *   `export * from "./fs.js"`，会与 `export * from "@nimbo/core"` 撞成两个
 *   `export *` 源导出同名成员的"ambiguous export"错误（TS2308；tsc 按导出名
 *   字符串判定冲突，与类型/值分属不同命名空间无关，这点比"本地声明遮蔽
 *   export *"更严格，也已用最小复现验证）。`./fs.js` 内部把类型与值拼到一起的
 *   理由见该文件头注释。
 * - 其余符号逐一核对：core 的其余导出、virtual-fs 的 `MemoryFS`/`OverlayFS`/
 *   `DirFS`/`diff`/`mime`/`path` 系列、mini-bash 的 `miniBash`，两两之间没有
 *   重名，直接经 `export *` 透传。不为 P7-2/P7-3（结构化输出/`toJSON`/
 *   `resume`/`localExec`/`loadAgent`）预留任何尚未实现的假符号——那些符号会
 *   随各自工单在 core/mini-bash 落地后自动经这里的 `export *` 透出，本文件
 *   不需要跟着改。
 */
export * from "@nimbo/core";
export * from "@nimbo/virtual-fs";
export * from "@nimbo/mini-bash";

export { NimboFS } from "./fs.js";
export { createSession, type Session } from "./session.js";
