/**
 * L1 定义层：`defineTool`（docs/core/core-sdk/tech.md §4.1）。纯函数，把带精确 zod 推导的
 * 工具定义收敛成 P1-1 预铺的类型擦除态 `Tool`（`types.ts`）。
 *
 * 两处相对 spec 原文字面签名收紧的类型参数约束，理由见下，均不触碰
 * `Tool` 本身（未改宽、未加 `as`）：
 *
 * 1. `In extends z.ZodType<JsonValue>`（spec 原文：`In extends z.ZodType`，
 *    无约束）——若 `In` 不带这个约束，函数体内 `return { inputSchema: def.inputSchema, ... }`
 *    在 tsc 下实测报错：`Type 'In' is not assignable to type 'ZodType<JsonValue, ...>'`
 *    （即工单预告的"型变阻力"：泛型参数的 Output 位在类型体内是不透明的
 *    `unknown`，编译器无法确认它落在 JsonValue 内，即便所有实际传入的
 *    zod schema 具体实例化后都满足）。工具输入本来就来自模型产生的 JSON
 *    tool-call 参数，语义上 In 的 Output 恒为 JSON 可表达形状，因此用约束
 *    把这个既有事实在类型层面显式化，而不是在赋值处加 `as` 绕过。
 *    经验证不影响精度：`z.infer<In>` 仍按调用处传入的具体 schema 推导
 *    （见 test/tool.test.ts 的 expectTypeOf 断言），约束只影响"入参必须是
 *    JSON 兼容 schema"这一前提，不改变推导结果。
 * 2. `Out extends ToolReturn = ToolReturn`（spec 原文：`Out = ToolReturn`，
 *    无约束）——同一类型逃逸点：不带约束时 `outputSchema?: z.ZodType<Out>`
 *    赋给 `Tool.outputSchema?: z.ZodType<ToolReturn>` 同样在 tsc 下报错。
 *    `execute()` 的返回值本来就要落进 `ToolOutput = ToolReturn`
 *    （events.ts）才能进入事件系统，约束同样只是显式化既有运行时事实。
 */
import type { z } from "zod";
import type { ApprovalPolicy, JsonValue, Tool, ToolContext, ToolReturn } from "./types.js";

/** `defineTool(...)` 的入参形状（docs/core/core-sdk/tech.md §4.1），无 `name` 字段。 */
export interface ToolDefinition<In extends z.ZodType<JsonValue>, Out extends ToolReturn = ToolReturn> {
  description: string;
  inputSchema: In;
  outputSchema?: z.ZodType<Out>;
  approval?: ApprovalPolicy;
  /** 见 `Tool.readOnly`（types.ts）：纯读声明，整批全 readOnly 时 loop 并行结算。 */
  readOnly?: boolean;
  execute(input: z.infer<In>, ctx: ToolContext): Promise<Out> | Out;
}

/** 纯函数：收敛精确类型的工具定义为类型擦除态 `Tool`，不做任何运行时校验/包装。 */
export function defineTool<In extends z.ZodType<JsonValue>, Out extends ToolReturn = ToolReturn>(
  def: ToolDefinition<In, Out>,
): Tool {
  return {
    description: def.description,
    inputSchema: def.inputSchema,
    outputSchema: def.outputSchema,
    approval: def.approval,
    readOnly: def.readOnly,
    execute: def.execute,
  };
}
