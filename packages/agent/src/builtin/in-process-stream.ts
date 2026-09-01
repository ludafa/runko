/**
 * 内置的**平凡[流分发](../../../docs/terms.md)**：一个 `Map<conversationId, Set<listener>>`。
 *
 * 单进程下流分发平时是看不见的——发布方与订阅方在同一个进程里，转发一下就完了。
 * 跨实例时才需要外部实现（Redis Streams，`@nimbo/stream-redis`）。
 *
 * 刻意不用 `node:events` 的 `EventEmitter`：那东西有 maxListeners 警告要关、有
 * `error` 事件的特殊语义要绕，而这里要的只是「一组回调」。一个 `Set` 更直白，也天然
 * 满足「`subscribe` 同步返回时订阅已挂上」这条硬约束。
 */
import type { StreamFanout } from "../stream.js";
import type { Frame } from "../types.js";

export function inProcessStream(): StreamFanout {
  const listeners = new Map<string, Set<(frame: Frame) => void>>();

  return {
    publish(conversationId: string, frame: Frame): void {
      const set = listeners.get(conversationId);
      if (set === undefined) {return;}
      // 快照再遍历：监听者在回调里退订（正常的——tail 断开就会）不能边删边迭代。
      for (const listener of [...set]) {listener(frame);}
    },
    subscribe(conversationId: string, listener: (frame: Frame) => void): () => void {
      const set = listeners.get(conversationId) ?? new Set<(frame: Frame) => void>();
      set.add(listener);
      listeners.set(conversationId, set);
      return () => {
        set.delete(listener);
        if (set.size === 0) {listeners.delete(conversationId);}
      };
    },
  };
}
