/**
 * 会话后端的 Cloudflare 实现：会话里的一切动作都交给这个会话的会话对象（JS RPC）。
 *
 * 只有列表那一处不叫醒会话对象：一次要给全部会话的实时状态，挨个叫醒太贵，所以读会话对象
 * 回写在 D1 的副本（`db/live-state.ts`）。详情只看一个会话，直接问会话对象。
 */
import type { Frame } from '@runko/agent';
import { readFrames } from '@runko/durable-object';
import type {
  ConversationBackend,
  ConversationLiveState,
  ConversationRuntime,
} from '@runko-chat/shared/routes/chat';

import type { ConversationObject } from './conversation-object.js';
import { chatDb } from './db/instance.js';
import { readLiveStates } from './db/live-state.js';
import type { Env } from './env.js';

/** 会话对象上 Worker 要调的那些方法。 */
type ConversationObjectRpc = Pick<
  ConversationObject,
  | 'enqueue'
  | 'abort'
  | 'removeQueued'
  | 'clearQueue'
  | 'listQueue'
  | 'getActivity'
  | 'readLedger'
  | 'subscribe'
  | 'submitDecision'
  | 'submitAnswer'
  | 'listPendingDecisions'
  | 'liveState'
  | 'provision'
  | 'extendSandboxLifetime'
>;

/**
 * 拿会话对象的 stub。按对象自己的方法签名看它：workers-types 给 stub 推的 RPC 类型要把返回值
 * 逐层套一遍可序列化检查，碰上 `RunkoUIMessage` 这种深类型会让 tsc 报「实例化过深」。
 * 运行时 stub 的这些方法就是「对象方法 + 结构化克隆」，这几个方法的参数和返回值都是纯数据
 * （或字节流），按原签名看不会看错。
 */
function stubFor(env: Env, conversationId: string): ConversationObjectRpc {
  const stub: unknown = env.CONVERSATION.get(
    env.CONVERSATION.idFromName(conversationId),
  );
  return stub as ConversationObjectRpc;
}

/**
 * 直播流跨 RPC 是一条字节流。调用方的 `signal` 跨不过去，所以在这一侧把它接到流上：
 * abort 时管道断开、源头被 cancel，cancel 一路传回会话对象，那边的订阅随之收线。
 */
async function* subscribeViaRpc(
  env: Env,
  conversationId: string,
  opts: { after?: number; signal?: AbortSignal } = {},
): AsyncGenerator<Frame, void> {
  const stream = await stubFor(env, conversationId).subscribe(
    conversationId,
    opts.after,
  );
  const signal = opts.signal;
  const source =
    signal === undefined ? stream : (
      stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), {
        signal,
      })
    );
  try {
    yield* readFrames(source);
  } catch (error) {
    if (signal?.aborted === true) {
      return; // 人自己走的，不是错误
    }
    throw error;
  }
}

export function createCloudflareBackend(env: Env): ConversationBackend {
  const runtime: ConversationRuntime = {
    enqueue: (id, input, opts) => stubFor(env, id).enqueue(id, input, opts),
    abort: (id) => stubFor(env, id).abort(id),
    removeQueued: (id, messageId) =>
      stubFor(env, id).removeQueued(id, messageId),
    clearQueue: (id) => stubFor(env, id).clearQueue(id),
    listQueue: (id) => stubFor(env, id).listQueue(id),
    getActivity: (id) => stubFor(env, id).getActivity(id),
    readLedger: (id, opts) => stubFor(env, id).readLedger(id, opts),
    subscribe: (id, opts) => subscribeViaRpc(env, id, opts),
    submitDecision: (id, callId, decision) =>
      stubFor(env, id).submitDecision(id, callId, decision),
    submitAnswer: (id, callId, answer, opts) =>
      stubFor(env, id).submitAnswer(id, callId, answer, opts),
  };

  return {
    runtime,
    listPendingDecisions: (id) => stubFor(env, id).listPendingDecisions(id),
    async liveStates(conversationIds) {
      const [only] = conversationIds;
      if (conversationIds.length === 1 && only !== undefined) {
        const live: ConversationLiveState = await stubFor(env, only).liveState(
          only,
        );
        return new Map([[only, live]]);
      }
      return readLiveStates(chatDb(env.DB), conversationIds);
    },
    provision: (input) => stubFor(env, input.conversationId).provision(input),
    extendSandboxLifetime: (id) => stubFor(env, id).extendSandboxLifetime(id),
  };
}
