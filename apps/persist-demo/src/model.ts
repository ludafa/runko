/**
 * 模型：**这个 demo 只用回声模型，不接任何真 provider。**
 *
 * 回声模型不是玩具摆设——它让这个 demo **不需要任何外部账号就能跑起来**。这个 demo
 * 要展示的是持久化，一上来先要人配 API key 是没必要的门槛。真要接 provider 的写法
 * 看 `apps/node-server/src/agent/model.ts`。
 */
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
