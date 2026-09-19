/**
 * 内置的 `ask-user` 工具——agent 在一轮进行中直接向用户提问并阻塞等回答。
 *
 * 它是**产品能力，不是安全闸**：不设 `approval`（问用户本身就是那个人在回路的步骤，
 * 上面没什么可再拦的），也不受审批模式影响。
 *
 * **等不到人就[挂起](../../../../docs/terms.md)**：[内存窗口](../../../../docs/terms.md)走完还没人答，
 * 它调 `ctx.suspend()`——这次调用原样留在账本里，这一轮收尾、放掉机器；人几小时后回来答，由
 * 新的一轮把答案接上。不是返回一句「没人回应」让模型瞎猜。
 *
 * 放在框架里而不是让每个宿主自己写：它的另一半（把回答送回来）本来就是框架的
 * [人在回路桥](./human.js)，拆开写等于把一条通道的两头分给两个包。
 *
 * **缺省注册，但可以关**：`createAgentRuntime({ human: { askUser: false } })` 之后工具列表里
 * 就没有它（装配在 `runtime/turn.ts` 的 `buildAgentDefinition`）。宿主也可以用同名工具覆盖它
 * ——内置的那个垫底，`agent.tools` 与这一轮的 `preparation.tools` 依次盖在上面。
 *
 * 内存窗口是一个进程内的 `setTimeout`，**跟着进程走**。进程崩了它也就没了，那一轮改由
 * 接管方补「已停止」收尾（见 `./interrupted-marker.js`）——崩溃不是干净边界，不走挂起。
 */
import type { Tool } from "@runko/core";
import { defineTool } from "@runko/core";
import { z } from "zod";

import type { AskUserOutcome } from "./registry.js";

const askUserInputSchema = z.object({
  question: z.string().min(1),
  options: z.array(z.string()).optional(),
});

/**
 * 提问等不到人、也不能[挂起](../../../../docs/terms.md)时交回模型的文案——一个正常的工具结果，不是错误。
 * 两种情形：这一轮被停止了；或者裁决表那一行没登记上（挂起之后没人能答）。等太久本身走挂起，不用它。
 */
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
      if (outcome.outcome === "answered") {return outcome.answer;}
      if (outcome.outcome === "suspended") {return ctx.suspend(outcome.reason);}
      return ASK_USER_TIMEOUT_MESSAGE;
    },
  });
}
