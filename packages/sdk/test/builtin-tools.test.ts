/**
 * P7-1 acceptance: `agent.builtinTools` filtering applies to the sdk-assembled file tools
 * eight-set (04-builtin-tools.md §3) — `false` turns them all off, an array whitelists a
 * subset (including the `READ_ONLY_TOOLS` preset), and a host-supplied `agent.tools` entry
 * with the same name overrides the built-in (built-ins spread first, host tools last).
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { READ_ONLY_TOOLS, createSession, defineAgent, defineTool, fromMemory } from "../src/index.js";
import { drainStream, isToolCallItem, mockModel, stopChunk, toolCallChunk, toolCallItems } from "./helpers.js";

describe("builtinTools: false — all eight file tools are off", () => {
  it("a model tool call for a file tool comes back as an 'unknown tool' failure, not a crash, and the turn still completes", async () => {
    const model = mockModel(() => ({
      doStream: [toolCallChunk("call_1", "read_file", { path: "/a.txt" }), stopChunk("done")],
    }));
    const agent = defineAgent({ model, builtinTools: false });
    const session = createSession(agent, { fs: fromMemory({ "a.txt": "hello" }) });

    // send() buffers the whole turn (both scripted model steps) and only resolves once it
    // completes — proving a hallucinated/disabled tool call is not fatal, not a crash.
    const result = await session.send("read a.txt");
    const calls = result.items.filter(isToolCallItem);
    expect(calls[0]?.status).toBe("failed");
    expect(String(calls[0]?.output)).toContain('Unknown tool "read_file"');
    expect(result.finalResponse).toBe("done");
  });
});

describe("builtinTools: [<subset>] — array whitelist", () => {
  it("only the listed file tools are available; others fail as unknown", async () => {
    const model = mockModel(() => ({
      doStream: [
        toolCallChunk("call_1", "read_file", { path: "/a.txt" }),
        toolCallChunk("call_2", "write_file", { path: "/a.txt", content: "nope" }),
        stopChunk("done"),
      ],
    }));
    const agent = defineAgent({ model, builtinTools: ["read_file", "glob"] });
    const session = createSession(agent, { fs: fromMemory({ "a.txt": "hello" }) });

    const events = await drainStream(session.stream("read then try to write"));
    const calls = toolCallItems(events);
    expect(calls[0]?.status).toBe("completed"); // read_file: whitelisted
    expect(calls[1]?.status).toBe("failed"); // write_file: not in the whitelist
    expect(String(calls[1]?.output)).toContain('Unknown tool "write_file"');
  });
});

describe("builtinTools: READ_ONLY_TOOLS preset", () => {
  it("read_file/list_dir/glob/grep are on; write-side tools are off", async () => {
    const model = mockModel(() => ({
      doStream: [
        toolCallChunk("call_1", "grep", { pattern: "hello" }),
        toolCallChunk("call_2", "delete_file", { path: "/a.txt" }),
        stopChunk("done"),
      ],
    }));
    const agent = defineAgent({ model, builtinTools: [...READ_ONLY_TOOLS] });
    const session = createSession(agent, { fs: fromMemory({ "a.txt": "hello world" }) });

    const events = await drainStream(session.stream("grep then try to delete"));
    const calls = toolCallItems(events);
    expect(calls[0]?.status).toBe("completed"); // grep: in READ_ONLY_TOOLS
    expect(calls[1]?.status).toBe("failed"); // delete_file: not in READ_ONLY_TOOLS
    expect(String(calls[1]?.output)).toContain('Unknown tool "delete_file"');
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

    const events = await drainStream(session.stream("grep"));
    const calls = toolCallItems(events);
    expect(calls[0]?.status).toBe("completed");
    expect(calls[0]?.output).toBe("custom-grep-executed:hello");
  });
});
