/**
 * L0 模型层：nimbo `Tool` → AI SDK `tool()` / `ToolSet`（docs/tech/core-sdk.md §4.3 第 1 点）。
 *
 * 刻意省略 `execute`：手动 loop 模式下 AI SDK 因此不会自动执行任何工具——
 * `finishReason === "tool-calls"` 时 tool call 原样出现在 `fullStream`/
 * `result.toolCalls` 里，交给 nimbo 的 ToolRuntime（P4/P5）完成审批链与
 * 实际执行，结果再回填为 `role: "tool"` 的 `ModelMessage` 进入下一步
 * `streamText`。这是本工单唯一的手动 loop 控制点。
 *
 * 类型逃逸说明（隔离于本文件，一处）：AI SDK 的 `tool()` 在省略
 * `execute`/`outputSchema` 时，需要显式把 OUTPUT 类型参数钉死为字面量
 * `never`——`tool<INPUT, OUTPUT, CONTEXT>({ description, inputSchema })`
 * 这个字面量（两个键都不出现）能类型检查通过，靠的是 `ToolOutputProperties`
 * 里 `NeverOptional<OUTPUT, T>` 走到 `[OUTPUT] extends [never]` 分支，把
 * execute/outputSchema 都变成可选；不显式钉死会落到 OUTPUT 推不出来、退化为
 * `unknown` 的路径，`NeverOptional` 转而要求 execute/outputSchema 二选一必填
 * 而报错。CONTEXT 显式写成 `Record<string, unknown>`——即 AI SDK 内部
 * `Context` 别名的结构（`type Context = Record<string, unknown>`，该别名
 * 本身未从 `ai` 包顶层导出，无法按名字引用）；工具对象不设置
 * `contextSchema`/`onInputStart` 等任何消费 CONTEXT 的字段，具体取值在这里
 * 从未被使用。若改用字面量 `never` 当 CONTEXT，返回值在 `needsApproval` 的
 * 逆变位置上会与 `ToolSet` 的索引签名类型发生 `any` vs `never` 的变型冲突，
 * 无法赋值给 `ToolSet`——`Record<string, unknown>` 才是使返回值同时满足
 * `tool()` 重载与 `ToolSet` 结构的精确选择。三个类型参数全是精确类型
 * （`JsonValue`/字面量 `never`/`Record<string, unknown>`），不是
 * `any`/`unknown`，不构成硬性规范意义上的类型逃逸。
 */
import { tool } from "ai";
import type { ToolSet } from "ai";
import type { JsonValue, Tool as NimboTool } from "../types.js";

/** 省略 `execute` 后的 AI SDK 工具形态：INPUT 精确到 JsonValue，OUTPUT 恒为 `never`。 */
export type ConvertedTool = ReturnType<typeof convertTool>;

/** 单个 nimbo `Tool` → AI SDK `tool()`，不做任何运行时校验/包装，字段按引用传递。 */
export function convertTool(nimboTool: NimboTool) {
  return tool<JsonValue, never, Record<string, unknown>>({
    description: nimboTool.description,
    inputSchema: nimboTool.inputSchema,
  });
}

/** `AgentDefinition.tools`（`Record<string, Tool>`）→ 可直接传给 `streamText` 的 `ToolSet`。 */
export function convertTools(tools: Record<string, NimboTool>): ToolSet {
  const toolSet: ToolSet = {};
  for (const [name, nimboTool] of Object.entries(tools)) {
    toolSet[name] = convertTool(nimboTool);
  }
  return toolSet;
}
