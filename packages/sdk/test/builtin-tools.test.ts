/**
 * P7-1 acceptance: `agent.builtinTools` filtering applies to the sdk-assembled file tools
 * eight-set (docs/core/builtin-tools/tech.md §3) — `false` turns them all off, an array whitelists a
 * subset (including the `READ_ONLY_TOOLS` preset), and a host-supplied `agent.tools` entry
 * with the same name overrides the built-in (built-ins spread first, host tools last).
 *
 * P13-5-2（docs/agent/single-ledger/tech.md）迁移：断言从 `SessionEvent`/
 * `SessionItem` 改为读账本（`session.toJSON().messages` 的工具部件，
 * `state`：output-available/output-error 取代 completed/failed）。一个工具名
 * 从未出现在 `agent.tools` 里时，模型对它的调用在 `runOneStep` 里直接被 AI
 * SDK 自己的 `parseToolCall` 拦下（`dynamic:true, invalid:true`），落
 * output-error、不经过 input-available 中间态——因此这里不再断言字面量
 * `'Unknown tool "..."'`（那是 `settleToolCall` 自己的兜底文案，这条调用路径
 * 上到不了；见 core `test/loop.test.ts` 的"unknown tool name"/"malformed
 * dynamic call"两个测试与工单回报的"发现的 src 真实缺陷"）,只断言 errorText
 * 里含工具名。
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { READ_ONLY_TOOLS, createSession, defineAgent, defineTool, fromMemory } from "../src/index.js";
import { drainStream, mockModel, stopChunk, toolCallChunk, toolCallItems } from "./helpers.js";

describe("builtinTools: false — all eight file tools are off", () => {
  it("a model tool call for a file tool comes back as an output-error, not a crash, and the turn still completes", async () => {
    const model = mockModel(() => ({
      doStream: [toolCallChunk("call_1", "read-file", { path: "/a.txt" }), stopChunk("done")],
    }));
    const agent = defineAgent({ model, builtinTools: false });
    const session = createSession(agent, { fs: fromMemory({ "a.txt": "hello" }) });

    // send() buffers the whole turn (both scripted model steps) and only resolves once it
    // completes — proving a hallucinated/disabled tool call is not fatal, not a crash.
    const result = await session.send("read a.txt");
    const calls = toolCallItems(session.toJSON().messages);
    expect(calls[0]?.state).toBe("output-error");
    expect(calls[0]?.errorText).toContain("read-file");
    expect(result.finalResponse).toBe("done");
  });
});

describe("builtinTools: [<subset>] — array whitelist", () => {
  it("only the listed file tools are available; others fail as output-error", async () => {
    const model = mockModel(() => ({
      doStream: [
        toolCallChunk("call_1", "read-file", { path: "/a.txt" }),
        toolCallChunk("call_2", "write-file", { path: "/a.txt", content: "nope" }),
        stopChunk("done"),
      ],
    }));
    const agent = defineAgent({ model, builtinTools: ["read-file", "glob"] });
    const session = createSession(agent, { fs: fromMemory({ "a.txt": "hello" }) });

    await drainStream(session.stream("read then try to write"));
    const calls = toolCallItems(session.toJSON().messages);
    expect(calls[0]?.state).toBe("output-available"); // read-file: whitelisted
    expect(calls[1]?.state).toBe("output-error"); // write-file: not in the whitelist
    expect(calls[1]?.errorText).toContain("write-file");
  });
});

describe("builtinTools: READ_ONLY_TOOLS preset", () => {
  it("read-file/list-dir/glob/grep are on; write-side tools are off", async () => {
    const model = mockModel(() => ({
      doStream: [
        toolCallChunk("call_1", "grep", { pattern: "hello" }),
        toolCallChunk("call_2", "delete-file", { path: "/a.txt" }),
        stopChunk("done"),
      ],
    }));
    const agent = defineAgent({ model, builtinTools: [...READ_ONLY_TOOLS] });
    const session = createSession(agent, { fs: fromMemory({ "a.txt": "hello world" }) });

    await drainStream(session.stream("grep then try to delete"));
    const calls = toolCallItems(session.toJSON().messages);
    expect(calls[0]?.state).toBe("output-available"); // grep: in READ_ONLY_TOOLS
    expect(calls[1]?.state).toBe("output-error"); // delete-file: not in READ_ONLY_TOOLS
    expect(calls[1]?.errorText).toContain("delete-file");
  });
});

describe("host tools override built-ins by name", () => {
  it("agent.tools.grep replaces the built-in grep implementation entirely", async () => {
    const customGrep = defineTool({
      description: "custom grep stand-in used only to prove host override wins",
      inputSchema: z.object({ pattern: z.string() }),
      execute: (input) => `custom-grep-executed:${input.pattern}`,
    });

    const model = mockModel(() => ({ doStream: [toolCallChunk("call_1", "grep", { pattern: "hello" }), stopChunk("done")] }));
    const agent = defineAgent({ model, tools: { grep: customGrep } });
    const session = createSession(agent, { fs: fromMemory({ "a.txt": "hello world" }) });

    await drainStream(session.stream("grep"));
    const calls = toolCallItems(session.toJSON().messages);
    expect(calls[0]?.state).toBe("output-available");
    expect(calls[0]?.output).toBe("custom-grep-executed:hello");
  });
});
