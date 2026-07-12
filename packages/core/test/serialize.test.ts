/**
 * P7-2: `Session.toJSON`/`SessionOptions.resume` — tech-spec §4.2/§4.8
 * "会话恢复" 段. `@nimbo/virtual-fs` is a devDependency here (not a runtime
 * dependency of `@nimbo/core`, see `session.ts`'s header "fs 缺省" note) —
 * this file plays the same "host" role `integration.test.ts` already does,
 * supplying a real snapshot()/restore()-capable `NimboFS` to exercise the
 * structural capability probes end to end.
 */
import { describe, expect, it } from "vitest";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { fromMemory } from "@nimbo/virtual-fs";
import { defineAgent } from "../src/agent.js";
import { createSession } from "../src/session.js";
import type { AgentDefinition } from "../src/agent.js";
import type { NimboFS } from "../src/types.js";
import type { SessionEvent } from "../src/events.js";
import type { SessionState } from "../src/state.js";

function mockModel(buildOptions: () => ConstructorParameters<typeof MockLanguageModelV4>[0]): MockLanguageModelV4 {
  return new MockLanguageModelV4(buildOptions());
}

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
} as const;

function stopStream(text: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "text-start" as const, id: "t1" },
        { type: "text-delta" as const, id: "t1", delta: text },
        { type: "text-end" as const, id: "t1" },
        { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage },
      ],
      initialDelayInMs: null,
      chunkDelayInMs: null,
    }),
  };
}

function baseAgent(model: MockLanguageModelV4, overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return defineAgent({ model, ...overrides });
}

/** A `NimboFS` with exactly the base interface's 7 methods — no `snapshot()`/`restore()`, even though `inner` has them. */
function bareNimboFS(inner: NimboFS): NimboFS {
  return {
    readFile: (path) => inner.readFile(path),
    writeFile: (path, data) => inner.writeFile(path, data),
    rm: (path, opts) => inner.rm(path, opts),
    mkdir: (path) => inner.mkdir(path),
    readdir: (path) => inner.readdir(path),
    stat: (path) => inner.stat(path),
    glob: (pattern) => inner.glob(pattern),
  };
}

/**
 * 受控例外（同 `state.ts` 的"受控例外"一节）：resume 的运行时校验只在调用方
 * 绕开 TS 类型系统时才有意义（合法 TS 调用点本就构造不出结构非法的
 * `SessionState`——类型系统会在编译期挡下）。测试"运行时校验真的会拒绝
 * 结构非法的持久化数据"因此必须先制造一个绕开类型系统的值——隔离到这一个
 * 函数，只在本测试文件内使用，不流入 src。
 */
function asUntrustedSessionState(value: object): SessionState {
  return value as SessionState;
}

async function drainStream(gen: AsyncGenerator<SessionEvent, unknown>): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  let next = await gen.next();
  while (!next.done) {
    events.push(next.value);
    next = await gen.next();
  }
  return events;
}

describe("Session.toJSON", () => {
  it("returns id/turn/messages/createdAt and omits fsSnapshot when includeFs isn't requested", async () => {
    const model = mockModel(() => ({ doStream: stopStream("hi") }));
    const before = Date.now();
    const session = createSession(baseAgent(model));
    await session.send("hello");
    const after = Date.now();

    const state = session.toJSON();

    expect(state.id).toBe(session.id);
    expect(state.turn).toBe(1);
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]).toMatchObject({ role: "user" });
    expect(state.messages[1]).toMatchObject({ role: "assistant" });
    expect(state.createdAt).toBeGreaterThanOrEqual(before);
    expect(state.createdAt).toBeLessThanOrEqual(after);
    expect("fsSnapshot" in state).toBe(false);
  });

  it("returns a defensive copy of messages — mutating the returned array doesn't affect the session", async () => {
    const model = mockModel(() => ({ doStream: stopStream("hi") }));
    const session = createSession(baseAgent(model));
    await session.send("hello");

    const state = session.toJSON();
    state.messages.push({ role: "user", content: "injected" });

    expect(session.toJSON().messages).toHaveLength(2);
  });

  it("includeFs: true inlines fs.snapshot() when the fs supports it", async () => {
    const model = mockModel(() => ({ doStream: stopStream("hi") }));
    const fs = fromMemory({ "/a.txt": "hello" });
    const session = createSession(baseAgent(model), { fs });

    const state = session.toJSON({ includeFs: true });

    expect(state.fsSnapshot).toEqual(fs.snapshot());
  });

  it("includeFs: true throws a guiding error when the fs has no snapshot() capability", async () => {
    const model = mockModel(() => ({ doStream: stopStream("hi") }));
    const fs = bareNimboFS(fromMemory({ "/a.txt": "hello" }));
    const session = createSession(baseAgent(model), { fs });

    expect(() => session.toJSON({ includeFs: true })).toThrow(/snapshot/i);
  });
});

describe("SessionOptions.resume", () => {
  it("round-trips two turns through toJSON()/resume, and the third turn's prompt carries the full prior history", async () => {
    const model1 = mockModel(() => ({ doStream: [stopStream("first reply"), stopStream("second reply")] }));
    const session1 = createSession(baseAgent(model1));
    await session1.send("hello one");
    await session1.send("hello two");
    const state = session1.toJSON();

    const model2 = mockModel(() => ({ doStream: stopStream("third reply") }));
    const session2 = createSession(baseAgent(model2), { resume: state });
    const result = await session2.send("hello three");

    expect(session2.id).toBe(session1.id);
    expect(result.finalResponse).toBe("third reply");
    expect(session2.toJSON().turn).toBe(3);

    const prompt = model2.doStreamCalls[0]?.prompt ?? [];
    expect(prompt.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
  });

  it("restores fsSnapshot into an fs that supports restore()", async () => {
    const model1 = mockModel(() => ({ doStream: stopStream("ok") }));
    const fs1 = fromMemory({ "/a.txt": "hello" });
    const session1 = createSession(baseAgent(model1), { fs: fs1 });
    await session1.send("write it down");
    const state = session1.toJSON({ includeFs: true });

    const model2 = mockModel(() => ({ doStream: stopStream("ok") }));
    const fs2 = fromMemory();
    const session2 = createSession(baseAgent(model2), { fs: fs2, resume: state });

    const bytes = await session2.fs.readFile("/a.txt");
    expect(new TextDecoder().decode(bytes)).toBe("hello");
  });

  it("throws a guiding error when fsSnapshot is present but the injected fs has no restore() capability", async () => {
    const model = mockModel(() => ({ doStream: stopStream("ok") }));
    const inner = fromMemory({ "/a.txt": "hello" });
    // The exact shape of fsSnapshot doesn't matter for this test — only that it's present, which
    // is what routes createSession(...) into the restore-capability check in the first place.
    const state: SessionState = { id: "sess-x", turn: 1, createdAt: Date.now(), messages: [], fsSnapshot: { note: "irrelevant" } };

    expect(() => createSession(baseAgent(model), { resume: state, fs: bareNimboFS(inner) })).toThrow(/restore/i);
  });

  it("throws a guiding error referencing sessionStateSchema when resume fails validation", () => {
    const model = mockModel(() => ({ doStream: stopStream("ok") }));
    const malformed = asUntrustedSessionState({ turn: 1, createdAt: Date.now(), messages: [] }); // missing id

    expect(() => createSession(baseAgent(model), { resume: malformed })).toThrow(/sessionStateSchema/);
  });

  it("hasStarted semantics: a resumed session does not re-emit session.started on its next call", async () => {
    const model1 = mockModel(() => ({ doStream: stopStream("hi") }));
    const session1 = createSession(baseAgent(model1));
    await session1.send("hello");
    const state = session1.toJSON();

    const model2 = mockModel(() => ({ doStream: stopStream("hi again") }));
    const session2 = createSession(baseAgent(model2), { resume: state });

    const events = await drainStream(session2.stream("continue"));

    expect(events.some((e) => e.type === "session.started")).toBe(false);
    expect(events[0]).toEqual({ type: "turn.started", turn: 2 });
  });
});
