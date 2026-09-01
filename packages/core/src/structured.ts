/**
 * L2 运行层：`Session.send<T>(...outputSchema)` 的结构化输出实现
 * （docs/tech/core-sdk.md §4.8 "结构化输出" 段 / §4.2 `send<T>` 重载原文）。独立于
 * session.ts 成文件，保持 session.ts 聚焦于状态生命周期本身。
 *
 * ---- 落点：正常 loop 收尾之后的独立一轮，不改 loop.ts（本工单文件范围裁剪） ----
 *
 * 本工单的文件清单只列了 structured.ts/session.ts——不含 loop.ts。因此"终轮
 * 生成走 Output/generateObject"落地为：正常 `runTurn` 跑完（`finishReason`
 * 不是 "tool-calls"、`turn.completed` 已经发出）之后，`Session.send<T>` 再
 * 追加一次独立的 `generateText({ output: Output.object(...) })` 调用，把
 * 已完成 turn 的完整消息历史（含刚生成的自由文本回答）作为上下文，请模型把
 * 它折叠成符合 schema 的 JSON。这次额外调用**不**回写 session 的持久
 * `messages`——本函数的 `messages` 入参是只读上下文，重试往来的修正对话只
 * 存在于本函数内部的 scratch 数组里。因此 `TurnResult.items`/`finalResponse`
 * 对结构化输出这条支线完全无感：`structuredOutput` 是叠加在已完成 turn 之上
 * 的附加视图，不是替换（§4.2 `TurnResult & { structuredOutput: T }` 原文
 * 用的正是"叠加"这个形状）。
 *
 * ---- generateObject 与 Output 的取舍（工单要求裁量后报告） ----
 *
 * 选 `generateText({ output: Output.object({ schema }) })`，不选
 * `generateObject`：ai@7.0.20 的类型定义原文把 `generateObject` 标记为
 * `@deprecated Use generateText with an output setting instead`——两者能力
 * 等价（同一套 `responseFormat` 协议、同一套"解析 + zod 校验"逻辑），选
 * 未弃用的那个。
 *
 * ---- "provider 不支持原生结构化输出时回退" 如何落地为一套机制 ----
 *
 * `Output.object(...).parseCompleteOutput` 本身就是"取模型最终文本 → JSON
 * 解析 → zod 校验，失败抛 `NoObjectGeneratedError`"（ai@7 源码
 * `src/generate-text/output.ts` 逐字如此）——这恰好就是 spec 描述的"回退"
 * 步骤本身，不需要我们另起一套 `JSON.parse` 手写平行实现。支持原生结构化
 * 输出的 provider 通常第一次调用就用 `responseFormat` 引导出合法 JSON，
 * 直接落进 happy path；不支持/未遵循的 provider 让模型给出自由文本，大概率
 * 解析或校验失败，触发下面这层重试。"原生路径"与"回退路径"因此在实现里
 * 收敛成同一个 `generateText` 调用 + 同一个
 * `catch (NoObjectGeneratedError.isInstance(error))` 分支，不是两套独立
 * 代码——用同一个请求形态覆盖两种 provider 能力，靠的正是
 * `NoObjectGeneratedError` 精确标记"解析/校验失败"这一失败模式。
 *
 * ---- 错误形态：throw，不新增 turn.failed code（工单要求裁量后报告） ----
 *
 * 结构化输出这一步发生在正常 turn 已经成功收尾（`turn.completed` 已发出、
 * `TurnResult.items`/`finalResponse` 已经交付）之后——它的失败不是"这个
 * turn 失败了"，是"turn 成功了，但把结果折叠成结构化 JSON 这一附加步骤
 * 没能在重试预算内完成"，语义上不适合折进 `turn.failed`（宿主会误以为整个
 * turn 的常规产出都不可信，但 items/finalResponse 其实都是好的）。此外本
 * 工单的文件清单不含 `events.ts`，往 `NimboError.code` 联合新增枚举值本就
 * 落在改动范围外。因此选择 `throw`——`NimboStructuredOutputError`，与
 * `NimboSessionError` 同级但不复用它（不是同一种失败），`Session.send<T>`
 * 让它直接从 `await` 冒出去，不经 `NimboSessionError` 包装。
 */
import { generateText, NoObjectGeneratedError, Output } from "ai";
import type { LanguageModel, ModelMessage } from "ai";
import type { z } from "zod";

/** `send<T>` 结构化输出耗尽重试预算后的明确错误（见本文件头"错误形态"一节）。 */
export class NimboStructuredOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NimboStructuredOutputError";
  }
}

export interface GenerateStructuredOutputOptions<T> {
  model: LanguageModel;
  system: string | undefined;
  /**
   * 只读上下文——已完成 turn 的完整消息历史。本函数内部构造的修正往返消息
   * 只存在于本地 scratch 副本里，不会修改这个数组（见本文件头"落点"一节）。
   */
  messages: ModelMessage[];
  outputSchema: z.ZodType<T>;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

/** "校验错误回给模型请其修正"的重试预算（spec"失败重试 ≤ 2 次"原文）——初次尝试之外最多再打 2 次。 */
const MAX_RETRIES = 2;

/** 一轮失败之后，回给模型的修正往返（失败的原始回答 + 指出错误并重新索取纯 JSON 的追问）。 */
function correctionMessages(rawText: string | undefined, validationMessage: string): ModelMessage[] {
  return [
    { role: "assistant", content: rawText ?? "" },
    {
      role: "user",
      content:
        `Your previous response could not be turned into the required structured output.\n` +
        `Validation error: ${validationMessage}\n\n` +
        `Reply again with ONLY a single JSON value matching the required schema — no prose, no code fences.`,
    },
  ];
}

/**
 * `Session.send<T>` 的结构化输出实现：`generateText` + `Output.object` 一次
 * 调用失败即重试（`NoObjectGeneratedError` 判别），耗尽预算后
 * `NimboStructuredOutputError`。
 */
export async function generateStructuredOutput<T>(opts: GenerateStructuredOutputOptions<T>): Promise<T> {
  const output = Output.object({ schema: opts.outputSchema });
  let conversation = opts.messages;
  let lastRawText: string | undefined;
  let lastValidationMessage = "unknown validation error";

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await generateText({
        model: opts.model,
        system: opts.system,
        messages: conversation,
        output,
        maxOutputTokens: opts.maxOutputTokens,
        abortSignal: opts.signal,
      });
      if (result.finishReason === "stop") {return result.output;}
      lastRawText = result.text;
      lastValidationMessage = `model did not finish with "stop" (got "${result.finishReason}") — no structured output was produced`;
    } catch (error) {
      if (!NoObjectGeneratedError.isInstance(error)) {throw error;}
      lastRawText = error.text;
      lastValidationMessage = error.message;
    }

    if (attempt === MAX_RETRIES) {break;}
    conversation = [...conversation, ...correctionMessages(lastRawText, lastValidationMessage)];
  }

  throw new NimboStructuredOutputError(
    `Structured output generation failed after ${MAX_RETRIES + 1} attempt(s): ${lastValidationMessage}` +
      (lastRawText !== undefined ? ` (last raw response: ${lastRawText})` : ""),
  );
}
