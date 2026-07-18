/**
 * `nimbo/load` 子路径的落地（docs/tech/core-sdk.md §4.7 原文 `// nimbo/load` 注释——spec 写的
 * 是一个假想的裸包名子路径；P7-3 工单裁量为 `@nimbo/core` 的 `./load` subpath
 * export，见 `package.json`/`tsdown.config.ts`）。这里只是一个薄 barrel，真实实现
 * 在 `./load/load-agent.js`（`loadAgent`，任务 2）与 `./load/load-agent-fs.js`
 * （`loadAgentFromFS`，任务 3）——两者也从主入口 `index.ts` 正常导出，`./load`
 * 子路径是额外的、可选的导入方式（`import { loadAgent } from "@nimbo/core/load"`），
 * 不是唯一途径，因此不引入任何主入口没有的符号。
 */
export * from "./load/load-agent.js";
export * from "./load/load-agent-fs.js";
