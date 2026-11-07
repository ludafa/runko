/**
 * 跨 RPC 传帧：编成 NDJSON 的字节流再解回来。先在同一个 isolate 里验编解码本身，
 * 再走一次真的 Durable Object RPC（`AgentObject.live()`），验字节流与 cancel 都能跨过去。
 */
import type { Frame } from "@runko/agent";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import { framesToStream, readFrames } from "../src/index.js";
import { runOneTurn } from "./helpers/fake-session.js";

const SAMPLE: Frame[] = [
  { kind: "message", seq: 1, message: { id: "u1", role: "user", parts: [{ type: "text", text: "你好" }] } },
  { kind: "chunk", chunk: { type: "text-delta", id: "t1", delta: "世界\n换行也没事" } },
  { kind: "queue", queue: [] },
  { kind: "activity", active: true, holder: "durable-object" },
  { kind: "reconnect" },
];

async function collect(source: AsyncIterable<Frame>): Promise<Frame[]> {
  const frames: Frame[] = [];
  for await (const frame of source) {
    frames.push(frame);
  }
  return frames;
}

describe("编解码", () => {
  it("帧往返：内容不变，帧源收尾时流也收尾", async () => {
    const stream = framesToStream(async function* () {
      yield* SAMPLE;
    });
    expect(await collect(readFrames(stream))).toEqual(SAMPLE);
  });

  it("消费方提前 break：底层流被 cancel，帧源的 signal abort、帧源也收了尾", async () => {
    let seen: AbortSignal | undefined;
    let finished = false;
    const stream = framesToStream(async function* (signal) {
      seen = signal;
      try {
        yield { kind: "activity", active: true };
        await new Promise((resolve) => {
          signal.addEventListener("abort", resolve, { once: true });
        });
        yield { kind: "activity", active: false };
      } finally {
        finished = true;
      }
    });

    for await (const frame of readFrames(stream)) {
      expect(frame).toEqual({ kind: "activity", active: true });
      break;
    }
    expect(seen?.aborted).toBe(true);
    await vi.waitFor(() => {
      expect(finished).toBe(true);
    });
  });

  it("认不出的行跳过不崩；一帧被拆在两块里、多字节字符被从中间劈开也解得对", async () => {
    const text = [
      "not json",
      JSON.stringify({ kind: "nope" }),
      JSON.stringify({ kind: "activity", active: "yes" }),
      JSON.stringify({ kind: "message", seq: "1", message: {} }),
      "",
      JSON.stringify(SAMPLE[1]),
      // 最后一行不带换行符。
      JSON.stringify({ kind: "reconnect" }),
    ].join("\n");
    const bytes = new TextEncoder().encode(text);
    // 「世」是三个字节，劈在它的第二个字节上。
    const cut = bytes.indexOf(0xe4) + 1;
    const stream = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(bytes.slice(0, cut));
        controller.enqueue(bytes.slice(cut));
        controller.close();
      },
    });
    expect(await collect(readFrames(stream))).toEqual([SAMPLE[1], { kind: "reconnect" }]);
  });

  it("等下一帧时按间隔写保活空行，之后的帧照常到", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stream = framesToStream(
      async function* () {
        yield { kind: "queue", queue: [] };
        await gate;
        yield { kind: "reconnect" };
      },
      { keepAlive: "20ms" },
    );
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const read = async (): Promise<string> => decoder.decode((await reader.read()).value);
    expect(await read()).toBe(`${JSON.stringify({ kind: "queue", queue: [] })}\n`);
    expect(await read()).toBe("\n");
    release();
    // 保活空行与帧之间可能还夹着一两行空行，跳过它们。
    let line = await read();
    while (line === "\n") {
      line = await read();
    }
    expect(line).toBe(`${JSON.stringify({ kind: "reconnect" })}\n`);
    expect((await reader.read()).done).toBe(true);
  });

  it("帧源抛错：消费方的循环跟着抛", async () => {
    const stream = framesToStream(async function* () {
      yield { kind: "queue", queue: [] };
      throw new Error("source broke");
    });
    await expect(collect(readFrames(stream))).rejects.toThrow();
  });
});

describe("跨 Durable Object 的 RPC", () => {
  it("对象那一侧的 subscribe 编成字节流传过来：回放 + 两帧快照，一轮没在跑就收线", async () => {
    const stub = env.AGENT.get(env.AGENT.idFromName(`frames/${crypto.randomUUID()}`));
    expect(await stub.send("c1", "hello")).toBe("started");
    await runInDurableObject(stub, async (instance) => {
      await runOneTurn(await instance.sessions.next(), "hi");
      await vi.waitFor(async () => {
        expect((await instance.agent.runtime.getActivity("c1")).active).toBe(false);
      });
    });

    const frames = await collect(readFrames(await stub.live("c1")));
    expect(frames.map((frame) => frame.kind)).toEqual(["message", "message", "queue", "activity"]);
    expect(frames.at(-1)).toEqual({ kind: "activity", active: false });
  });

  it("消费方提前 cancel、之后再没有新帧：靠保活空行发现对面没了，对象那一侧 subscribe 的 signal abort", async () => {
    const stub = env.AGENT.get(env.AGENT.idFromName(`frames/${crypto.randomUUID()}`));
    for await (const frame of readFrames(await stub.live("c1", "forever"))) {
      if (frame.kind === "activity") {
        break;
      }
    }
    await vi.waitFor(async () => {
      expect(await runInDurableObject(stub, (instance) => instance.liveSignals[0]?.aborted)).toBe(true);
    });
    // 订阅收了尾，对象就回收得掉（没有保活空行时这一步会卡到超时）。
    await evictDurableObject(stub);
  });

  it("保活空行不会变成帧：消费方只看得到真帧", async () => {
    const stub = env.AGENT.get(env.AGENT.idFromName(`frames/${crypto.randomUUID()}`));
    const frames: Frame[] = [];
    const stream = await stub.live("c1", "forever");
    let sent = false;
    for await (const frame of readFrames(stream)) {
      frames.push(frame);
      if (!sent && frame.kind === "activity") {
        sent = true;
        // 先让几行保活空行过去，再起一轮。
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(await stub.send("c1", "hello")).toBe("started");
      }
      if (frame.kind === "message") {
        break;
      }
    }
    expect(frames.map((frame) => frame.kind)).toEqual(["queue", "activity", "activity", "message"]);
  });
});
