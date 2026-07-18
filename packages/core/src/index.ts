/**
 * P0 脚手架占位导出，P1-1 追加 L0 原语/事件模型/SessionState 的真实类型
 * （docs/tech/core-sdk.md §4.1/§4.2/§4.4/§4.5a/§4.8），P1-2 追加 L1 定义层
 * defineAgent/defineTool/defineSkill（docs/tech/core-sdk.md §4.1）。P4-1 追加审批链 +
 * ToolRuntime + update-plan；P4-2 追加 L2 运行层 `createSession`/`runTurn`
 * （docs/tech/core-sdk.md §4.2 全节），P4 收尾。P5 追加 skills：`Skill.fromDirectory/
 * fromFS/fromMarkdown` 三加载器（`skill.js`）、`<available_skills>` 注入 +
 * `load-skill` 工具 + 附属文件挂载 + 真实 `getSkill`（`skills/loader.js`、
 * `skills/registry.js`、`tools/builtin/load-skill.js`）。P6-2 追加 `bash`
 * 条件内置工具（`tools/builtin/bash.js`）+ `SessionOptions.exec`/`workspace`
 * 接线（`session.js`）。P7-2 追加结构化输出 `generateStructuredOutput`/
 * `NimboStructuredOutputError`（`structured.js`）+ `Session.send<T>`/
 * `toJSON`/`SessionOptions.resume`（`session.js`）。原生搜索能力接缝
 * （docs/tech/sandbox.md §4）追加 `NimboFS.searchFiles?`/`searchContent?` 与配套
 * 查询/结果类型（`types.js`）+ `SearchUnsupportedError`（`search.js`）。
 */
export const NIMBO_CORE_VERSION = "0.0.0" as const;

export * from "./types.js";
export * from "./search.js";
export * from "./events.js";
export * from "./state.js";
export * from "./tool.js";
export * from "./agent.js";
export * from "./skill.js";
export * from "./skills/loader.js";
export * from "./skills/registry.js";
export * from "./structured.js";
export * from "./model/convert.js";
export * from "./model/step.js";
export * from "./approval.js";
export * from "./runtime.js";
export * from "./tools/builtin/update-plan.js";
export * from "./tools/builtin/load-skill.js";
export * from "./tools/builtin/bash.js";
export * from "./loop.js";
export * from "./session.js";
export * from "./exec/local.js";
export * from "./load.js";
