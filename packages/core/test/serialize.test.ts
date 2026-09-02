/**
 * P7-2: `Session.toJSON`/`SessionOptions.resume` — docs/tech/core-sdk.md §4.2/§4.8
 * "会话恢复" 段. `@runko/virtual-fs` is a devDependency here (not a runtime
 * dependency of `@runko/core`, see `session.ts`'s header "fs 缺省" note) —
 * this file plays the same "host" role `integration.test.ts` already does,
 * supplying a real snapshot()/restore()-capable `RunkoFS` to exercise the
 * structural capability probes end to end.
 *
 * P13-5-2（docs/tech/single-ledger.md）迁移：messages 从 `ModelMessage[]`
 * 换成 `RunkoUIMessage[]`；"resume 后不重发 session.started" 一节随
 * `session.started`/`turn.started` 事件整体退役直接删除（`session.ts` 头注释：
 * 两者不再有对应 chunk，没有"重发抑制"这回事）；新增两条 resume 边界用例
 * （state.ts 头注释"恢复校验的深层通路"）：`toJSON()` 不需要等后台的深层
 * `validateSessionMessages()` 跑完；深层校验失败推迟到首次 `stream()`/`send()`
 * 才 reject，不在 `createSession(...)` 调用的当下同步抛错。
 */
import { describe, expect, it } from "vitest";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { fromMemory } from "@runko/virtual-fs";
import { defineAgent } from "../src/agent.js";
import { createSession } from "../src/session.js";
import { sessionStateSchema } from "../src/state.js";
import type { AgentDefinition } from "../src/agent.js";
import type { RunkoFS, Tool } from "../src/types.js";
import type { RunkoUIMessage, SessionState } from "../src/state.js";
import { toolTimingPartFor } from "./helpers/runko-chunks.js";

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

/** A `RunkoFS` with exactly the base interface's 7 methods — no `snapshot()`/`restore()`, even though `inner` has them. */
function bareRunkoFS(inner: RunkoFS): RunkoFS {
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
    state.messages.push({ id: "injected", role: "user", parts: [{ type: "text", text: "injected" }] });

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
    const fs = bareRunkoFS(fromMemory({ "/a.txt": "hello" }));
    const session = createSession(baseAgent(model), { fs });

    expect(() => session.toJSON({ includeFs: true })).toThrow(/snapshot/i);
  });

  describe("data-tool-timing persistence (chat 可观测性：工具起止时间戳，state.ts 的 toolTimingDataSchema)", () => {
    /** A tool-call-then-stop `doStream` script — same shape as `loop.test.ts`/`session.test.ts`'s own `toolCallThenStopModel`. */
    function toolCallThenStopStream(toolName: string, input: unknown, stopText: string) {
      const usage = {
        inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 5, text: 5, reasoning: undefined },
      } as const;
      return [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start" as const, warnings: [] },
              { type: "tool-call" as const, toolCallId: "call_1", toolName, input: JSON.stringify(input) },
              { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: undefined }, usage },
            ],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start" as const, warnings: [] },
              { type: "text-start" as const, id: "t1" },
              { type: "text-delta" as const, id: "t1", delta: stopText },
              { type: "text-end" as const, id: "t1" },
              { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage },
            ],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        },
      ];
    }

    it("a tool call's data-tool-timing part survives a JSON.stringify/JSON.parse round trip, with both timestamps intact", async () => {
      const tool: Tool = { description: "d", inputSchema: z.object({}), execute: () => "done" };
      const model = mockModel(() => ({ doStream: toolCallThenStopStream("t", {}, "ok") }));
      const session = createSession(baseAgent(model, { tools: { t: tool } }));
      await session.send("go");

      const before = toolTimingPartFor(session.toJSON().messages, "call_1");
      expect(before).toBeDefined();
      expect(before?.completedAt).toBeDefined();

      // `sessionStateSchema.parse(...)` (not a type assertion) is the typed way
      // back from the JSON round trip — `JSON.parse`'s `any` return flows
      // straight into `.parse()`'s `unknown` parameter, no cast needed, same
      // discipline `session.ts`'s own `jsonValueSchema.parse(JSON.parse(...))`
      // precedent uses.
      const roundTripped = sessionStateSchema.parse(JSON.parse(JSON.stringify(session.toJSON())));
      const after = toolTimingPartFor(roundTripped.messages, "call_1");

      expect(after).toEqual(before);
    });
  });
});

describe("SessionOptions.resume", () => {
  it("**接受空账本**（messages: []）——恢复一个还没说过话的会话是合法的", async () => {
    // ai 的 `validateUIMessages()` 会拒绝空数组，所以这条路必须绕开深校验。
    // **失败姿态是异步的**：`createSession()` 当场不报错，要到第一次 `stream()`/`send()`
    // 才 reject——所以没有这条用例的话，把那个 `messages.length > 0` 判断删掉，
    // 现有的 resume 用例一条都不会红。
    //
    // 真实调用方是 `@runko/agent`：它每一轮都从账本重建 `SessionState` 再 resume，
    // 会话的第一轮账本必然是空的。传 `undefined` 让 core 自己 mint 一个 id 也不行——
    // 那样第一轮与后续轮的 `session.id` 会不一样，遥测的 `"<sessionId>#<turn>"` 键就断了。
    const model = mockModel(() => ({ doStream: stopStream("first reply") }));
    const session = createSession(baseAgent(model), {
      resume: { id: "conv-empty", turn: 0, messages: [], createdAt: Date.now() },
    });

    expect(session.toJSON().id).toBe("conv-empty");
    const result = await session.send("hello");
    expect(result.finalResponse).toBe("first reply");
    // id 跨轮稳定——这正是传空账本而不是传 undefined 的理由。
    expect(session.toJSON().id).toBe("conv-empty");
  });

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

    expect(() => createSession(baseAgent(model), { resume: state, fs: bareRunkoFS(inner) })).toThrow(/restore/i);
  });

  it("throws a guiding error referencing sessionStateSchema when resume fails validation", () => {
    const model = mockModel(() => ({ doStream: stopStream("ok") }));
    const malformed = asUntrustedSessionState({ turn: 1, createdAt: Date.now(), messages: [] }); // missing id

    expect(() => createSession(baseAgent(model), { resume: malformed })).toThrow(/sessionStateSchema/);
  });

  it("toJSON() called synchronously right after resume (no await in between) returns the resumed messages without waiting on the background deep validation", () => {
    const model = mockModel(() => ({ doStream: stopStream("hi") }));
    const priorMessages: RunkoUIMessage[] = [
      { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
      { id: "m2", role: "assistant", parts: [{ type: "text", text: "hello" }], metadata: { turn: 1, status: "completed" } },
    ];
    const state: SessionState = { id: "sess-sync", turn: 1, createdAt: Date.now(), messages: priorMessages };

    // createSession(...) is synchronous and starts the deep validateSessionMessages() pass in
    // the background (not awaited) — toJSON() called immediately after, with no `await`
    // anywhere in between, must still return the resumed ledger from the shallow-validated
    // scaffold (state.ts header: "messages 先用浅层校验通过的原始账本 scaffold").
    const session = createSession(baseAgent(model), { resume: state });
    expect(session.toJSON().messages).toEqual(priorMessages);
  });

  it("a resume state that passes shallow sessionStateSchema but fails deep validateUIMessages rejects on the first stream()/send(), not at createSession()", async () => {
    const model = mockModel(() => ({ doStream: stopStream("hi") }));
    // `metadata.status: "not-a-real-status"` satisfies the shallow envelope check (state.ts's
    // `isUIMessageShape` only looks at id/role/parts) but violates `runkoMessageMetadataSchema`'s
    // status enum — exactly the "structure ok, deep semantics not ok" case `state.ts`'s header
    // describes as deferred to `validateSessionMessages()`.
    const malformed = asUntrustedSessionState({
      id: "sess-bad-metadata",
      turn: 1,
      createdAt: Date.now(),
      messages: [
        {
          id: "m1",
          role: "assistant",
          parts: [{ type: "text", text: "hello", state: "done" }],
          metadata: { status: "not-a-real-status" },
        },
      ],
    });

    // createSession() itself does not throw — only the async deep validation catches this.
    const session = createSession(baseAgent(model), { resume: malformed });

    await expect(session.send("continue")).rejects.toThrow();
  });
});
