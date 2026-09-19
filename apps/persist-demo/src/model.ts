/**
 * 模型：**这个 demo 只用回声模型，不接任何真 provider。**
 *
 * 回声模型不是玩具摆设——它让这个 demo **不需要任何外部账号就能跑起来**。这个 demo
 * 要展示的是持久化，一上来先要人配 API key 是没必要的门槛。真要接 provider 的写法
 * 看 `apps/node-server/src/agent/model.ts`。
 */
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { simulateReadableStream } from "ai";
import type { LanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";

const USAGE = {
  inputTokens: { total: 8, noCache: 8, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 4, text: 4, reasoning: undefined },
} as const;

/** 一步就收尾、把给定文本吐出来的假模型。 */
export function scriptedModel(text: string): LanguageModel {
  return new MockLanguageModelV4({
    doStream: [
      {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start" as const, warnings: [] },
            { type: "text-start" as const, id: "t1" },
            { type: "text-delta" as const, id: "t1", delta: text },
            { type: "text-end" as const, id: "t1" },
            {
              type: "finish" as const,
              finishReason: { unified: "stop" as const, raw: undefined },
              usage: USAGE,
            },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      },
    ],
  });
}

/**
 * **慢一点的回声模型**——给多副本 e2e 用：让「这一轮还在跑」在**另一个进程**里也是个
 * 确定事实。`gatedModel` 的闸门是进程内的 promise，跨进程递不过去。
 *
 * **等待要能被中断**，跟真 provider 一样（它们的 HTTP 请求会随 `abortSignal` 断掉）。否则
 * 一轮被停止、或持有者[自我围栏](../../../docs/terms.md)停手之后，它仍要睡满整段才结束——
 * 验证环境里「这一轮是自己停的」与「模型睡完自然结束的」就分不出来了。
 */
export function slowModel(text: string, delayMs: number): LanguageModel {
  return new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => {
      await sleep(delayMs, undefined, abortSignal === undefined ? {} : { signal: abortSignal });
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start" as const, warnings: [] },
            { type: "text-start" as const, id: "t1" },
            { type: "text-delta" as const, id: "t1", delta: text },
            { type: "text-end" as const, id: "t1" },
            {
              type: "finish" as const,
              finishReason: { unified: "stop" as const, raw: undefined },
              usage: USAGE,
            },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      };
    },
  });
}

/**
 * **会调工具的脚本模型**——给[挂起](../../../docs/terms.md)与恢复的 e2e 用：第一步调一次工具，
 * 看到工具结果之后回一句话收尾。
 *
 * 按**提示词里最后一条是不是工具结果**来决定这一步做什么，而不是按调用次数：每一轮都会新拿一个
 * 模型实例，恢复那一轮开场先结清那次调用、再调模型——那时模型看到的最后一条正是工具结果，
 * 它该收尾，而不是再调一次工具。
 */
export function toolScriptModel(call: "bash" | "ask-user"): LanguageModel {
  return new MockLanguageModelV4({
    doStream: ({ prompt }) => {
      const last = prompt.at(-1);
      if (last?.role === "tool") {
        return Promise.resolve({
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start" as const, warnings: [] },
              { type: "text-start" as const, id: "t1" },
              { type: "text-delta" as const, id: "t1", delta: "拿到结果了，这一轮做完。" },
              { type: "text-end" as const, id: "t1" },
              { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage: USAGE },
            ],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        });
      }
      const input =
        call === "bash" ? { command: "echo resumed-from-ledger" } : { question: "要不要继续？", options: ["要", "不要"] };
      return Promise.resolve({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start" as const, warnings: [] },
            { type: "tool-call" as const, toolCallId: `call-${randomUUID()}`, toolName: call, input: JSON.stringify(input) },
            { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: undefined }, usage: USAGE },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      });
    },
  });
}

/** 缺省的「回声」模型：不联网，回一句固定话。 */
export function echoModel(): LanguageModel {
  return scriptedModel("（回声模型：没配 API key，所以我只会说这一句。持久化照样在工作。）");
}

/**
 * **可以卡住的模型**——给 e2e 用。
 *
 * `doStream` 传函数（而不是现成的 stream），它 `await` 一个闸门再返回。于是「这一轮
 * 还在跑」变成一个**确定事实**，而不是靠「假模型很快、消息发得更快」这种时序侥幸。
 *
 * 为什么必须有它：测「队列满了回 409」要求第二、三条消息到达时第一轮**仍在跑**。
 * SQLite 是同步的、微秒级，侥幸能成立；换成走网络的 Postgres/MySQL，往返延迟就足够
 * 让第一轮先跑完，于是第二条消息去起了新轮，测试红给你看——**红得对，是测试写错了**。
 */
export function gatedModel(text: string): { model: LanguageModel; release: () => void } {
  let open = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const model = new MockLanguageModelV4({
    doStream: async () => {
      await gate;
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start" as const, warnings: [] },
            { type: "text-start" as const, id: "t1" },
            { type: "text-delta" as const, id: "t1", delta: text },
            { type: "text-end" as const, id: "t1" },
            {
              type: "finish" as const,
              finishReason: { unified: "stop" as const, raw: undefined },
              usage: USAGE,
            },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      };
    },
  });
  return { model, release: () => { open(); } };
}
