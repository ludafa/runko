/**
 * 把一条已经接下的输入放回[待发队列](../../../../docs/terms.md)——**不受队列上限约束**：这是换个地方放一条
 * 已经接下的消息，不是新的入队请求。
 */
import type { TurnInput } from "../types.js";
import type { RuntimeContext } from "./context.js";

/** 放回队首（它原本就该先于队列里的其它消息跑）。 */
export async function requeueInputFront(ctx: RuntimeContext, conversationId: string, input: TurnInput): Promise<void> {
  const { queued } = await enqueueUnbounded(ctx, conversationId, input);
  if (queued === undefined) {return;}
  // 先入队尾再挪到队首：`QueueStore` 没有「带 id 插到队首」的原语，`requeueFront` 要一个现成的条目。
  const removed = await ctx.persistence.queue.remove(conversationId, queued.id);
  const queue = removed.removed ? await ctx.persistence.queue.requeueFront(conversationId, queued) : removed.queue;
  ctx.stream.publish(conversationId, { kind: "queue", queue });
}

/** 放到队尾（插话这类「本该在这一轮里，但没来得及」的输入）。 */
export async function requeueInputsBack(ctx: RuntimeContext, conversationId: string, inputs: readonly TurnInput[]): Promise<void> {
  if (inputs.length === 0) {return;}
  let queue = await ctx.persistence.queue.list(conversationId);
  for (const input of inputs) {
    queue = (await enqueueUnbounded(ctx, conversationId, input)).queue;
  }
  ctx.stream.publish(conversationId, { kind: "queue", queue });
}

async function enqueueUnbounded(ctx: RuntimeContext, conversationId: string, input: TurnInput) {
  const outcome = await ctx.persistence.queue.enqueue(conversationId, input, { max: Number.MAX_SAFE_INTEGER, onFull: "reject" });
  return outcome.ok ? { queued: outcome.queued, queue: outcome.queue } : { queued: undefined, queue: outcome.queue };
}
