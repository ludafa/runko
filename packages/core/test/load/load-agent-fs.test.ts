/**
 * `loadAgentFromFS` (P7-3 task 3, docs/tech/core-sdk.md §4.7) — the virtual-FS counterpart
 * of `loadAgent`, deliberately narrower: only `instructions.md` and `skills/`
 * are read; `agent.ts`/`agent.json`/`tools/*` are never touched (§4.7 "不引入
 * 任意代码执行面"). `@nimbo/virtual-fs` is a devDependency (not a runtime
 * dependency of `@nimbo/core`), same pattern as `test/e2e-minibash.test.ts`
 * and `test/skills.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { fromMemory } from "@nimbo/virtual-fs";
import { loadAgentFromFS } from "../../src/load/load-agent-fs.js";
import type { ToolContext } from "../../src/index.js";

function stubToolContext(): ToolContext {
  return {
    fs: fromMemory({}),
    abortSignal: new AbortController().signal,
    callId: "call_1",
    session: { id: "sess_1", turn: 0 },
    getSkill: () => ({ file: () => ({ text: async () => "" }) }),
    update: () => {},
  };
}

describe("loadAgentFromFS() — golden path", () => {
  it("loads instructions.md and both skill forms from a virtual FS", async () => {
    const fs = fromMemory({
      "instructions.md": "You are a virtual-FS agent.",
      "skills/quick-note.md": "Jot down a quick note.",
      "skills/deep-dive/SKILL.md": "---\ndescription: Investigate deeply.\n---\n\n# Deep dive\n",
      "skills/deep-dive/checklist.md": "- [ ] step one",
    });

    const agent = await loadAgentFromFS(fs, "/", { model: "test-provider/fixture-model" });

    expect(agent.model).toBe("test-provider/fixture-model");
    expect(agent.instructions).toBe("You are a virtual-FS agent.");
    expect((agent.skills ?? []).map((s) => s.name).sort()).toEqual(["deep-dive", "quick-note"]);

    const deepDive = agent.skills?.find((s) => s.name === "deep-dive");
    expect(deepDive?.description).toBe("Investigate deeply.");
    expect(Object.keys(deepDive?.files ?? {})).toEqual(["checklist.md"]);
  });

  it("works from a non-root dir argument", async () => {
    const fs = fromMemory({
      "agents/support/instructions.md": "Support agent instructions.",
    });
    const agent = await loadAgentFromFS(fs, "/agents/support", { model: "x/y" });
    expect(agent.instructions).toBe("Support agent instructions.");
  });
});

describe("loadAgentFromFS() — instructions.md required (or opts.instructions fallback)", () => {
  it("throws a guidance error when instructions.md is missing and opts.instructions is not given", async () => {
    const fs = fromMemory({});
    await expect(loadAgentFromFS(fs, "/", { model: "x/y" })).rejects.toThrow(/instructions\.md/);
  });

  it("falls back to opts.instructions when instructions.md is missing", async () => {
    const fs = fromMemory({});
    const agent = await loadAgentFromFS(fs, "/", { model: "x/y", instructions: "fallback" });
    expect(agent.instructions).toBe("fallback");
  });

  it("prefers the file's content over opts.instructions when both are present", async () => {
    const fs = fromMemory({ "instructions.md": "from fs" });
    const agent = await loadAgentFromFS(fs, "/", { model: "x/y", instructions: "should be ignored" });
    expect(agent.instructions).toBe("from fs");
  });
});

describe("loadAgentFromFS() — model is always required from opts (never read from fs)", () => {
  it("throws a guidance error when opts.model is not given", async () => {
    const fs = fromMemory({ "instructions.md": "hi" });
    await expect(loadAgentFromFS(fs, "/")).rejects.toThrow(/no model configured/);
  });

  it("the error explicitly cites 'no arbitrary code execution' rather than pointing at agent.ts/agent.json", async () => {
    const fs = fromMemory({ "instructions.md": "hi" });
    await expect(loadAgentFromFS(fs, "/")).rejects.toThrow(/code execution/);
  });
});

describe("loadAgentFromFS() — no-code-evaluation boundary (§4.7)", () => {
  it("never evaluates agent.ts/agent.json even when present in the fs — model still comes only from opts", async () => {
    const fs = fromMemory({
      "instructions.md": "hi",
      "agent.json": JSON.stringify({ model: "should-never-be-used/x" }),
      "agent.ts": "export default { model: 'should-never-be-used/y' };",
    });
    const agent = await loadAgentFromFS(fs, "/", { model: "actually-used/model" });
    expect(agent.model).toBe("actually-used/model");
  });

  it("a tools/ directory in the fs is completely ignored — agent.tools is undefined without opts.tools", async () => {
    const fs = fromMemory({
      "instructions.md": "hi",
      "tools/greet.js": "export default { description: 'x', inputSchema: {}, execute: () => 'x' };",
    });
    const agent = await loadAgentFromFS(fs, "/", { model: "x/y" });
    expect(agent.tools).toBeUndefined();
  });

  it("garbage/unparsable content in tools/ never causes a syntax/eval error — it's simply never read as code", async () => {
    const fs = fromMemory({
      "instructions.md": "hi",
      "tools/broken.js": "this is not even valid javascript {{{ ] ) ---",
    });
    // If loadAgentFromFS ever tried to import()/eval this, it would throw a SyntaxError.
    // Resolving cleanly is the proof that tools/ content is never evaluated.
    await expect(loadAgentFromFS(fs, "/", { model: "x/y" })).resolves.toBeDefined();
  });

  it("opts.tools (host-provided, already-constructed Tool objects) is passed through as-is", async () => {
    const fs = fromMemory({ "instructions.md": "hi" });
    const hostTool = {
      description: "host tool",
      inputSchema: {} as never,
      execute: (): string => "from host",
    };
    const agent = await loadAgentFromFS(fs, "/", { model: "x/y", tools: { host_tool: hostTool } });
    expect(agent.tools?.host_tool).toBe(hostTool);
    const output = await agent.tools?.host_tool?.execute({}, stubToolContext());
    expect(output).toBe("from host");
  });
});

describe("loadAgentFromFS() — remaining opts pass through verbatim (none of these are ever read from fs)", () => {
  it("builtinTools/maxTurnsPerRun/maxOutputTokens/maxContextTokens all come from opts", async () => {
    const fs = fromMemory({ "instructions.md": "hi" });
    const agent = await loadAgentFromFS(fs, "/", {
      model: "x/y",
      builtinTools: ["read-file"],
      maxTurnsPerRun: 3,
      maxOutputTokens: 111,
      maxContextTokens: 2222,
    });
    expect(agent.builtinTools).toEqual(["read-file"]);
    expect(agent.maxTurnsPerRun).toBe(3);
    expect(agent.maxOutputTokens).toBe(111);
    expect(agent.maxContextTokens).toBe(2222);
  });

  it("omits builtinTools/maxTurnsPerRun/... entirely when opts doesn't provide them", async () => {
    const fs = fromMemory({ "instructions.md": "hi" });
    const agent = await loadAgentFromFS(fs, "/", { model: "x/y" });
    expect(agent.builtinTools).toBeUndefined();
    expect(agent.maxTurnsPerRun).toBeUndefined();
    expect(agent.maxOutputTokens).toBeUndefined();
    expect(agent.maxContextTokens).toBeUndefined();
  });
});

describe("loadAgentFromFS() — skills/ directory edge cases", () => {
  it("no skills/ directory at all: agent.skills is undefined", async () => {
    const fs = fromMemory({ "instructions.md": "hi" });
    const agent = await loadAgentFromFS(fs, "/", { model: "x/y" });
    expect(agent.skills).toBeUndefined();
  });

  it("a packaged-skill-shaped subdirectory without SKILL.md is silently skipped", async () => {
    const fs = fromMemory({
      "instructions.md": "hi",
      "skills/not-a-skill/notes.txt": "just some file",
    });
    const agent = await loadAgentFromFS(fs, "/", { model: "x/y" });
    expect(agent.skills).toBeUndefined();
  });

  it("a reference entry under skills/ (no local bytes) does not break loading", async () => {
    const fs = fromMemory({
      "instructions.md": "hi",
      "skills/quick-note.md": "A quick note skill.",
      "skills/external.bin": { ref: "https://example.com/asset" },
    });
    const agent = await loadAgentFromFS(fs, "/", { model: "x/y" });
    expect((agent.skills ?? []).map((s) => s.name)).toEqual(["quick-note"]);
  });
});
