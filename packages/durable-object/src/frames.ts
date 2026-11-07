/**
 * 跨 Durable Object 的 RPC 传[直播流](../../../docs/terms.md)的帧。
 *
 * DO 的 RPC 传不了 `AsyncIterable` 和 `AbortSignal`，能传的是字节流 `ReadableStream<Uint8Array>`。
 * 所以对象那一侧把 `runtime.subscribe()` 编成 NDJSON（一行一帧），调用方那一侧再解回来。
 * 调用方不想看了就 cancel 流，cancel 会一路传回对象那一侧，变成 `subscribe` 的 `signal` abort。
 *
 * ## 保活空行
 *
 * 跨 RPC 时 cancel 不是立刻传回来的：对象那一侧要等**下一次往流里写**才发现对面没了（实测）。
 * 一条没有新帧的订阅（`follow: "forever"`、会话闲着）于是一直挂着，对象也一直回收不掉。
 * 所以等下一帧的时候每隔一段写一个空行，`readFrames` 跳过它。
 */
import type { Duration, Frame } from "@runko/agent";

import { durationToMs } from "./duration.js";

const FRAME_KINDS = new Set(["message", "chunk", "queue", "activity", "reconnect"]);

const DEFAULT_KEEP_ALIVE: Duration = "10s";

export interface FramesToStreamOptions {
  /** 等下一帧时多久写一个保活空行（见文件头）。缺省 `"10s"`；`0` = 不写。 */
  keepAlive?: Duration;
}

/**
 * 对象那一侧：把帧源编成字节流。`source` 收到的 `signal` 在消费方 cancel 流时 abort，
 * 通常直接交给 `runtime.subscribe(conversationId, { signal })`。
 */
export function framesToStream(
  source: (signal: AbortSignal) => AsyncIterable<Frame>,
  opts: FramesToStreamOptions = {},
): ReadableStream<Uint8Array> {
  const keepAliveMs = durationToMs(opts.keepAlive ?? DEFAULT_KEEP_ALIVE, "keepAlive");
  const controller = new AbortController();
  const encoder = new TextEncoder();
  let iterator: AsyncIterator<Frame> | undefined;
  /** 只在等帧时挂着：帧源一直有货就一个空行都不写，流收尾了也就不再钉住对象。 */
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  const stopKeepAlive = (): void => {
    if (keepAlive !== undefined) {
      clearInterval(keepAlive);
      keepAlive = undefined;
    }
  };
  // 内容就是 UTF-8 字节，所以用字节流（`type: "bytes"`）。
  return new ReadableStream({
    type: "bytes",
    start(): void {
      iterator = source(controller.signal)[Symbol.asyncIterator]();
    },
    async pull(stream): Promise<void> {
      if (keepAliveMs > 0) {
        keepAlive = setInterval(() => {
          try {
            stream.enqueue(encoder.encode("\n"));
          } catch {
            // 流已经关了：不再写。
            stopKeepAlive();
          }
        }, keepAliveMs);
      }
      try {
        const next = await iterator?.next();
        if (next === undefined || next.done === true) {
          stream.close();
          return;
        }
        stream.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`));
      } finally {
        stopKeepAlive();
      }
    },
    cancel(reason: unknown): void {
      // 帧源要是不理 `signal`、卡在 `next()` 里，`finally` 轮不到；定时器在这里就得停。
      stopKeepAlive();
      controller.abort(reason);
      // 不 await：同样的理由，`return()` 会一直排在卡住的那次 `next()` 后面。
      void iterator?.return?.().catch(() => undefined);
    },
  });
}

/**
 * 调用方那一侧：把字节流解回帧。认不出的行（不是 JSON、`kind` 不认识、形状不对）跳过。
 * 提前 `break` 或抛错退出循环时会 cancel 底层流，对象那一侧随之收线。
 */
export async function* readFrames(stream: ReadableStream<Uint8Array>): AsyncGenerator<Frame, void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let drained = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffered += decoder.decode(value, { stream: true });
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        const frame = parseFrame(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        if (frame !== undefined) {
          yield frame;
        }
        newline = buffered.indexOf("\n");
      }
    }
    drained = true;
    const last = parseFrame(buffered + decoder.decode());
    if (last !== undefined) {
      yield last;
    }
  } finally {
    if (!drained) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}

/** 一行 → 一帧。只做最小校验：`kind` 认识、它那一种的关键字段类型对。 */
function parseFrame(line: string): Frame | undefined {
  if (line.trim() === "") {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  return isFrame(value) ? value : undefined;
}

function isFrame(value: unknown): value is Frame {
  if (typeof value !== "object" || value === null || !("kind" in value)) {
    return false;
  }
  const kind = value.kind;
  if (typeof kind !== "string" || !FRAME_KINDS.has(kind)) {
    return false;
  }
  switch (kind) {
    case "message":
      return "seq" in value && typeof value.seq === "number" && "message" in value && isObject(value.message);
    case "chunk":
      return "chunk" in value && isObject(value.chunk);
    case "queue":
      return "queue" in value && Array.isArray(value.queue);
    case "activity":
      return "active" in value && typeof value.active === "boolean";
    default:
      return true;
  }
}

function isObject(value: unknown): boolean {
  return typeof value === "object" && value !== null;
}
