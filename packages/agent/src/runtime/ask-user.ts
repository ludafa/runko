/**
 * 内置的 `ask-user` 工具——agent 在一轮进行中直接向用户提问并阻塞等回答。
 *
 * 它是**产品能力，不是安全闸**：不设 `approval`（问用户本身就是那个人在回路的步骤，
 * 上面没什么可再拦的），也不受审批模式影响。超时返回一段提示文案而非抛错——这样它在
 * loop 眼里就是一次正常完成的工具调用，模型可以自己决定接下来怎么办，而不是整轮死掉。
 *
 * 放在框架里而不是让每个宿主自己写：它的另一半（把回答送回来）本来就是框架的
 * [人在回路桥](./human.js)，拆开写等于把一条通道的两头分给两个包。
 */
import type { Tool } from "@runko/core";
import { defineTool } from "@runko/core";
import { z } from "zod";

import type { AskUserOutcome } from "./registry.js";

const askUserInputSchema = z.object({
  question: z.string().min(1),
  options: z.array(z.string()).optional(),
});

/** 超时时交回模型的文案——一个正常的工具结果，不是错误。 */
export const ASK_USER_TIMEOUT_MESSAGE =
  "The user did not respond within the time limit. Proceed with your best judgment, or ask again later.";

export function createAskUserTool(
  ask: (req: { callId: string; question: string; options?: string[] }) => Promise<AskUserOutcome>,
): Tool {
  return defineTool({
    description:
      "Ask the user a question and wait for their answer. Use this when you need the user to make a decision, " +
      "clarify a requirement, or choose between multiple options — not to request approval to run a command " +
      "(the approval chain handles that automatically; you never need to ask for it yourself). `options`, if " +
      "given, are quick-reply suggestions shown to the user — they can still answer freely instead of picking one.",
    inputSchema: askUserInputSchema,
    execute: async (input, ctx) => {
      const outcome = await ask({
        callId: ctx.callId,
        question: input.question,
        ...(input.options !== undefined ? { options: input.options } : {}),
      });
      return outcome.outcome === "answered" ? outcome.answer : ASK_USER_TIMEOUT_MESSAGE;
    },
  });
}
