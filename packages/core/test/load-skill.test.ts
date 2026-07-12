/**
 * P5 skills, session-level wiring: `load_skill` tool (unit + conditional
 * presence), `<available_skills>` system prompt injection, attached-file
 * mounting to `/.skills/<name>/`, and end-to-end `ctx.getSkill()` from a
 * host-provided tool. Loader/registry unit tests live in `test/skills.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { fromMemory } from "@nimbo/virtual-fs";
import { createLoadSkillTool } from "../src/tools/builtin/load-skill.js";
import { defineAgent } from "../src/agent.js";
import { defineSkill } from "../src/skill.js";
import { createSession } from "../src/session.js";
import type { AgentDefinition } from "../src/agent.js";
import type { Skill } from "../src/skill.js";
import type { SessionEvent, SessionItem } from "../src/events.js";
import type { Tool, ToolContext } from "../src/types.js";

// ---- shared mock-model helpers (same shape as session.test.ts / loop.test.ts) ----

function mockModel(buildOptions: () => ConstructorParameters<typeof MockLanguageModelV4>[0]): MockLanguageModelV4 {
  return new MockLanguageModelV4(buildOptions());
}

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
} as const;

function stopModel(text: string): MockLanguageModelV4 {
  return mockModel(() => ({
    doStream: {
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: text },
          { type: "text-end", id: "t1" },
          { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
        ],
        initialDelayInMs: null,
        chunkDelayInMs: null,
      }),
    },
  }));
}

function toolCallThenStopModel(toolName: string, input: unknown, stopText: string): MockLanguageModelV4 {
  return mockModel(() => ({
    doStream: [
      {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "tool-call", toolCallId: "call_1", toolName, input: JSON.stringify(input) },
            { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      },
      {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: stopText },
            { type: "text-end", id: "t1" },
            { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      },
    ],
  }));
}

function baseAgent(model: MockLanguageModelV4, overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return defineAgent({ model, ...overrides });
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

function isItemCompleted(event: SessionEvent): event is { type: "item.completed"; item: SessionItem } {
  return event.type === "item.completed";
}
function isToolCallItem(item: SessionItem): item is Extract<SessionItem, { type: "tool_call" }> {
  return item.type === "tool_call";
}

const pdfFillSkill: Skill = defineSkill({
  name: "pdf-fill",
  description: "fills PDF forms",
  markdown: "# PDF Fill\n\nFill the form.",
  files: { "reference.md": "field docs" },
});

// ---- createLoadSkillTool (unit) ----

describe("createLoadSkillTool", () => {
  it("returns the skill's markdown verbatim when it has no attached files", async () => {
    const skill = defineSkill({ name: "commit-helper", description: "d", markdown: "# Commit Helper\n\nbody" });
    const tool = createLoadSkillTool({ skills: [skill] });
    const output = await tool.execute({ name: "commit-helper" }, fakeCtx());
    expect(output).toBe("# Commit Helper\n\nbody");
  });

  it("appends an 'Attached files' section with /.skills/<name>/... paths when the skill has files", async () => {
    const tool = createLoadSkillTool({ skills: [pdfFillSkill] });
    const output = await tool.execute({ name: "pdf-fill" }, fakeCtx());
    expect(typeof output).toBe("string");
    const text = typeof output === "string" ? output : "";
    expect(text).toContain("# PDF Fill");
    expect(text).toContain("Attached files");
    expect(text).toContain("/.skills/pdf-fill/reference.md");
    expect(text).toContain("read_file");
  });

  it("returns a guidance { isError: true, content } result for an unknown skill name", async () => {
    const tool = createLoadSkillTool({ skills: [pdfFillSkill] });
    const output = await tool.execute({ name: "does-not-exist" }, fakeCtx());
    expect(output).toMatchObject({ isError: true });
    const content = typeof output === "object" && output !== null && "content" in output ? output.content : "";
    expect(String(content)).toContain("does-not-exist");
    expect(String(content)).toContain("pdf-fill"); // lists what IS available
  });

  it("rejects malformed input ({ name } missing) via inputSchema", () => {
    const tool = createLoadSkillTool({ skills: [pdfFillSkill] });
    expect(tool.inputSchema.safeParse({}).success).toBe(false);
  });

  it("lists '(none available)' when the tool was constructed with zero skills", async () => {
    const tool = createLoadSkillTool({ skills: [] });
    const output = await tool.execute({ name: "anything" }, fakeCtx());
    const content = typeof output === "object" && output !== null && "content" in output ? output.content : "";
    expect(String(content)).toContain("(none available)");
  });
});

function fakeCtx(): ToolContext {
  return {
    fs: {
      readFile: async () => new Uint8Array(),
      writeFile: async () => {},
      rm: async () => {},
      mkdir: async () => {},
      readdir: async () => [],
      stat: async () => ({ type: "file" }),
      glob: async () => [],
    },
    abortSignal: new AbortController().signal,
    callId: "call_1",
    session: { id: "sess_1", turn: 0 },
    getSkill: () => ({ file: () => ({ text: async () => "" }) }),
    update: () => {},
  };
}

// ---- session-level wiring ----

describe("session wiring: <available_skills> + load_skill conditional tool", () => {
  it("appends <available_skills> to the system prompt when agent.skills is non-empty", async () => {
    const model = stopModel("ok");
    const agent = baseAgent(model, { instructions: "Be terse.", skills: [pdfFillSkill] });
    const session = createSession(agent, { fs: fromMemory({}) });

    await drainStream(session.stream("hi"));

    expect(model.doStreamCalls[0]?.prompt[0]).toMatchObject({
      role: "system",
      content: "Be terse.\n\n<available_skills>\npdf-fill: fills PDF forms\n</available_skills>",
    });
  });

  it("does NOT append <available_skills> when agent.skills is unset or empty", async () => {
    const model = stopModel("ok");
    const session = createSession(baseAgent(model, { instructions: "Be terse." }));
    await drainStream(session.stream("hi"));
    expect(model.doStreamCalls[0]?.prompt[0]).toMatchObject({ role: "system", content: "Be terse." });
  });

  it("load_skill is absent from the tool list when agent.skills is unset (unknown tool → failed)", async () => {
    const agent = baseAgent(toolCallThenStopModel("load_skill", { name: "pdf-fill" }, "done"));
    const events = await drainStream(createSession(agent).stream("load it"));
    const completed = events.filter(isItemCompleted).map((e) => e.item).filter(isToolCallItem);
    expect(completed[0]?.status).toBe("failed");
    expect(typeof completed[0]?.output === "string" ? completed[0]?.output : "").toContain("Unknown tool");
  });

  it("load_skill is present and returns markdown + attached files when agent.skills is non-empty", async () => {
    const agent = baseAgent(toolCallThenStopModel("load_skill", { name: "pdf-fill" }, "done"), { skills: [pdfFillSkill] });
    const session = createSession(agent, { fs: fromMemory({}) });
    const events = await drainStream(session.stream("load it"));

    const completed = events.filter(isItemCompleted).map((e) => e.item).filter(isToolCallItem);
    expect(completed[0]?.status).toBe("completed");
    const output = completed[0]?.output;
    const text = typeof output === "string" ? output : "";
    expect(text).toContain("# PDF Fill");
    expect(text).toContain("/.skills/pdf-fill/reference.md");
  });

  it("a host-provided tools.load_skill overrides the builtin implementation", async () => {
    const hostTool: Tool = { description: "custom", inputSchema: z.object({ name: z.string() }), execute: () => "custom load_skill handled" };
    const agent = baseAgent(toolCallThenStopModel("load_skill", { name: "pdf-fill" }, "done"), {
      skills: [pdfFillSkill],
      tools: { load_skill: hostTool },
    });
    const events = await drainStream(createSession(agent, { fs: fromMemory({}) }).stream("load it"));
    const completed = events.filter(isItemCompleted).map((e) => e.item).filter(isToolCallItem);
    expect(completed[0]?.output).toBe("custom load_skill handled");
  });
});

describe("session wiring: attached-file mounting to /.skills/<name>/", () => {
  it("mounts a skill's attached files onto the session's fs, readable via fs.readFile", async () => {
    const fs = fromMemory({});
    const session = createSession(baseAgent(stopModel("ok"), { skills: [pdfFillSkill] }), { fs });

    await drainStream(session.stream("hi")); // mounting happens before the first turn's tool calls run

    expect(new TextDecoder().decode(await fs.readFile("/.skills/pdf-fill/reference.md"))).toBe("field docs");
  });

  it("a skill with no files never touches an unconfigured fs — no mounting error", async () => {
    const skill = defineSkill({ name: "commit-helper", description: "d", markdown: "m" }); // no files
    const session = createSession(baseAgent(stopModel("ok"), { skills: [skill] })); // fs intentionally left unconfigured
    await expect(session.send("hi")).resolves.toBeDefined();
  });

  it("fs left unconfigured + a skill WITH files → session.send() rejects with guidance pointing at injecting fs", async () => {
    const session = createSession(baseAgent(stopModel("ok"), { skills: [pdfFillSkill] })); // fs intentionally left unconfigured
    await expect(session.send("hi")).rejects.toThrow(/NimboFS|createSession/);
  });
});

describe("session wiring: ctx.getSkill() end-to-end from a host-provided tool", () => {
  it("a host tool's execute() reads a skill's attached file via ctx.getSkill(name).file(relPath).text()", async () => {
    const capturedText: string[] = [];
    const readSkillTool: Tool = {
      description: "reads pdf-fill's reference.md via getSkill",
      inputSchema: z.object({}),
      execute: async (_input, ctx) => {
        const text = await ctx.getSkill("pdf-fill").file("reference.md").text();
        capturedText.push(text);
        return "read ok";
      },
    };

    const agent = baseAgent(toolCallThenStopModel("read_skill", {}, "done"), {
      skills: [pdfFillSkill],
      tools: { read_skill: readSkillTool },
    });
    const session = createSession(agent, { fs: fromMemory({}) });
    const events = await drainStream(session.stream("go"));

    expect(capturedText).toEqual(["field docs"]);
    const completed = events.filter(isItemCompleted).map((e) => e.item).filter(isToolCallItem);
    expect(completed[0]?.status).toBe("completed");
  });

  it("ctx.getSkill() for an unknown skill name gives a guidance error surfaced through the tool's failure", async () => {
    const failingTool: Tool = {
      description: "d",
      inputSchema: z.object({}),
      execute: async (_input, ctx) => {
        await ctx.getSkill("does-not-exist").file("x.txt").text();
        return "unreachable";
      },
    };
    const agent = baseAgent(toolCallThenStopModel("failing_tool", {}, "done"), {
      skills: [pdfFillSkill],
      tools: { failing_tool: failingTool },
    });
    const session = createSession(agent, { fs: fromMemory({}) });
    const events = await drainStream(session.stream("go"));

    const completed = events.filter(isItemCompleted).map((e) => e.item).filter(isToolCallItem);
    expect(completed[0]?.status).toBe("failed");
    const output = completed[0]?.output;
    expect(typeof output === "string" ? output : "").toContain("does-not-exist");
  });
});
