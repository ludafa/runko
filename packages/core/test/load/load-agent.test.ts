/**
 * `loadAgent` (P7-3 task 2, docs/tech/core-sdk.md §4.7). The golden-path/full-field
 * assertions run against the committed fixture `test/fixtures/agent-dir/`
 * (instructions.md + agent.json + tools/*.js + skills/ flat & packaged).
 * Edge/error paths use ephemeral `mkdtemp()` directories so we don't need to
 * commit extra fixture variants (missing files, malformed exports, etc.) for
 * every branch.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAgent } from "../../src/load/load-agent.js";
import type { AgentDefinition, ToolContext } from "../../src/index.js";

const FIXTURE_DIR = join(import.meta.dirname, "..", "fixtures", "agent-dir");

/** Dynamic `import()` of a `.ts` file inside `loadAgent()` needs either Node's native TypeScript
 * stripping (>= 22.18) or a host build step producing `.js` (the ticket's own guidance, hence the
 * committed fixture's `tools/*.js`). Under vitest these imports actually go through Vite's own
 * transform pipeline regardless of the host Node version, but we still gate per the ticket's
 * instruction ("按运行时 node 版本条件跳过该用例，不做硬依赖") so this suite doesn't assume a
 * capability the *real*, non-vitest `loadAgent()` caller might not have. */
function nodeSupportsNativeTypeScript(): boolean {
  const [major, minor] = process.versions.node.split(".").map((part) => Number(part));
  if (major === undefined || minor === undefined) {return false;}
  return major > 22 || (major === 22 && minor >= 18);
}

function stubToolContext(): ToolContext {
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

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "runko-load-agent-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("loadAgent() — golden path (test/fixtures/agent-dir)", () => {
  it("loads instructions.md verbatim", async () => {
    const agent = await loadAgent(FIXTURE_DIR);
    expect(agent.instructions).toContain("Fixture Agent");
    expect(agent.instructions).toContain("fixture");
  });

  it("takes model from agent.json (string, passed through verbatim) when opts.model is not given", async () => {
    const agent = await loadAgent(FIXTURE_DIR);
    expect(agent.model).toBe("test-provider/fixture-model");
  });

  it("opts.model overrides agent.json's model even though agent.json has one", async () => {
    const override = "anthropic/claude-sonnet-5";
    const agent = await loadAgent(FIXTURE_DIR, { model: override });
    expect(agent.model).toBe(override);
  });

  it("reads maxTurnsPerRun/maxOutputTokens/maxContextTokens/builtinTools from agent.json", async () => {
    const agent = await loadAgent(FIXTURE_DIR);
    expect(agent.maxTurnsPerRun).toBe(7);
    expect(agent.maxOutputTokens).toBe(512);
    expect(agent.maxContextTokens).toBe(8000);
    expect(agent.builtinTools).toEqual(["read-file", "grep"]);
  });

  describe("tools/*.js — file name is the tool name", () => {
    it("discovers both fixture tools, keyed by their file's basename", async () => {
      const agent = await loadAgent(FIXTURE_DIR);
      expect(Object.keys(agent.tools ?? {}).sort()).toEqual(["greet", "search"]);
    });

    it("greet.js's description/execute/inputSchema all round-trip and execute() actually runs", async () => {
      const agent = await loadAgent(FIXTURE_DIR);
      const greet = agent.tools?.greet;
      expect(greet?.description).toBe("Greet a person by name.");
      expect(greet?.approval).toBeUndefined();
      expect(greet?.inputSchema).toMatchObject({ _fixtureNote: expect.any(String) });

      const output = await greet?.execute({ name: "Ada" }, stubToolContext());
      expect(output).toBe("Hello, Ada!");
    });

    it("search.js's approval field ('review-once') round-trips", async () => {
      const agent = await loadAgent(FIXTURE_DIR);
      expect(agent.tools?.search?.approval).toBe("review-once");
      const output = await agent.tools?.search?.execute({}, stubToolContext());
      expect(output).toBe("no results (fixture)");
    });
  });

  describe("skills/ — both flat and packaged forms", () => {
    it("discovers exactly the two fixture skills, by name", async () => {
      const agent = await loadAgent(FIXTURE_DIR);
      expect((agent.skills ?? []).map((s) => s.name).sort()).toEqual(["deep-dive", "quick-note"]);
    });

    it("flat skill (quick-note.md): description derived from the first non-empty line", async () => {
      const agent = await loadAgent(FIXTURE_DIR);
      const quickNote = agent.skills?.find((s) => s.name === "quick-note");
      expect(quickNote?.description).toBe("Jot down a quick note for later without leaving the current task.");
      expect(quickNote?.files).toBeUndefined();
    });

    it("packaged skill (deep-dive/SKILL.md): frontmatter description + attached files", async () => {
      const agent = await loadAgent(FIXTURE_DIR);
      const deepDive = agent.skills?.find((s) => s.name === "deep-dive");
      expect(deepDive?.description).toBe("Investigate a topic in depth across multiple fixture sources, citing each one.");
      expect(deepDive?.markdown).toContain("# Deep dive");
      expect(deepDive?.markdown).not.toContain("description:"); // frontmatter stripped
      expect(Object.keys(deepDive?.files ?? {})).toEqual(["checklist.md"]);
    });
  });

  it("returns a well-formed AgentDefinition end to end (no unexpected extra fields)", async () => {
    const agent: AgentDefinition = await loadAgent(FIXTURE_DIR, { model: "anthropic/claude-sonnet-5" });
    expect(agent.model).toBe("anthropic/claude-sonnet-5");
    expect(typeof agent.instructions).toBe("string");
    expect(Object.keys(agent.tools ?? {}).length).toBe(2);
    expect((agent.skills ?? []).length).toBe(2);
  });
});

describe("loadAgent() — instructions.md required (or opts.instructions fallback)", () => {
  it("throws a guidance error when instructions.md is missing and opts.instructions is not given", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "agent.json"), JSON.stringify({ model: "x/y" }));
      await expect(loadAgent(dir)).rejects.toThrow(/instructions\.md/);
    });
  });

  it("falls back to opts.instructions when instructions.md is missing", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "agent.json"), JSON.stringify({ model: "x/y" }));
      const agent = await loadAgent(dir, { instructions: "fallback instructions" });
      expect(agent.instructions).toBe("fallback instructions");
    });
  });

  it("prefers the file's content over opts.instructions when both are present", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "instructions.md"), "from the file");
      await writeFile(join(dir, "agent.json"), JSON.stringify({ model: "x/y" }));
      const agent = await loadAgent(dir, { instructions: "should be ignored" });
      expect(agent.instructions).toBe("from the file");
    });
  });
});

describe("loadAgent() — model required from somewhere", () => {
  it("throws a guidance error when neither agent.ts/agent.json nor opts provide a model", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "instructions.md"), "hi");
      await expect(loadAgent(dir)).rejects.toThrow(/no model configured/);
    });
  });
});

describe("loadAgent() — agent.json parsing", () => {
  it("rejects a non-object top-level JSON value", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "instructions.md"), "hi");
      await writeFile(join(dir, "agent.json"), JSON.stringify(["not", "an", "object"]));
      await expect(loadAgent(dir)).rejects.toThrow(/JSON object/);
    });
  });

  it("rejects invalid JSON syntax with a guidance error", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "instructions.md"), "hi");
      await writeFile(join(dir, "agent.json"), "{ not valid json");
      await expect(loadAgent(dir)).rejects.toThrow(/not valid JSON/);
    });
  });

  it("rejects a non-string model in agent.json (JSON can't encode a LanguageModel instance)", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "instructions.md"), "hi");
      await writeFile(join(dir, "agent.json"), JSON.stringify({ model: { not: "a string" } }));
      await expect(loadAgent(dir)).rejects.toThrow(/must be a string/);
    });
  });

  it("rejects an unrecognized builtinTools entry", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "instructions.md"), "hi");
      await writeFile(join(dir, "agent.json"), JSON.stringify({ model: "x/y", builtinTools: ["not_a_real_tool"] }));
      await expect(loadAgent(dir)).rejects.toThrow(/builtinTools/);
    });
  });

  it("rejects a builtinTools value that is neither false nor an array", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "instructions.md"), "hi");
      await writeFile(join(dir, "agent.json"), JSON.stringify({ model: "x/y", builtinTools: "oops-not-an-array" }));
      await expect(loadAgent(dir)).rejects.toThrow(/builtinTools.*must be false or an array/);
    });
  });

  it("wraps a read failure on an existing-but-unreadable agent.json with a guidance error (agent.json is a directory)", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "instructions.md"), "hi");
      await mkdir(join(dir, "agent.json")); // exists (passes fileExists), but readFile on a dir throws EISDIR
      await expect(loadAgent(dir)).rejects.toThrow(/could not read/);
    });
  });

  it("accepts builtinTools: false and passes it through", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "instructions.md"), "hi");
      await writeFile(join(dir, "agent.json"), JSON.stringify({ model: "x/y", builtinTools: false }));
      const agent = await loadAgent(dir);
      expect(agent.builtinTools).toBe(false);
    });
  });
});

describe("loadAgent() — directories that simply don't have tools/ or skills/", () => {
  it("omits agent.tools and agent.skills entirely rather than returning empty containers", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "instructions.md"), "hi");
      await writeFile(join(dir, "agent.json"), JSON.stringify({ model: "x/y" }));
      const agent = await loadAgent(dir);
      expect(agent.tools).toBeUndefined();
      expect(agent.skills).toBeUndefined();
    });
  });
});

describe("loadAgent() — tools/ directory edge cases", () => {
  it("skips hidden files and .d.ts declaration files, but still loads real tool files", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "instructions.md"), "hi");
      await writeFile(join(dir, "agent.json"), JSON.stringify({ model: "x/y" }));
      await mkdir(join(dir, "tools"));
      await writeFile(join(dir, "tools", ".hidden.js"), "export default { description: 'x', inputSchema: {}, execute: () => 'x' };");
      await writeFile(join(dir, "tools", "shared.d.ts"), "export {};");
      await writeFile(
        join(dir, "tools", "real.js"),
        // A minimal zod-schema-shaped stub (a callable `safeParse`) rather than a real `import "zod"` —
        // this file lives outside the workspace's node_modules resolution tree (ephemeral mkdtemp() dir),
        // and isToolLikeRecord()'s probe only cares that `safeParse` is callable (see load-agent.ts's
        // isZodSchemaLike/isToolLikeRecord).
        "export default { description: 'real tool', inputSchema: { safeParse: () => ({ success: true, data: {} }) }, execute: () => 'ran' };",
      );

      const agent = await loadAgent(dir);
      expect(Object.keys(agent.tools ?? {})).toEqual(["real"]);
    });
  });

  it("throws a guidance error when a tool file's default export doesn't look like a Tool", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "instructions.md"), "hi");
      await writeFile(join(dir, "agent.json"), JSON.stringify({ model: "x/y" }));
      await mkdir(join(dir, "tools"));
      await writeFile(join(dir, "tools", "broken.js"), "export default { description: 'missing execute' };");

      await expect(loadAgent(dir)).rejects.toThrow(/does not look like a Tool/);
    });
  });

  it("throws a guidance error when a tool file has no default export", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "instructions.md"), "hi");
      await writeFile(join(dir, "agent.json"), JSON.stringify({ model: "x/y" }));
      await mkdir(join(dir, "tools"));
      await writeFile(join(dir, "tools", "no-default.js"), "export const notDefault = {};");

      await expect(loadAgent(dir)).rejects.toThrow(/default export/);
    });
  });

  it("throws a guidance error when a tool file's default export is not an object at all (e.g. a bare string)", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "instructions.md"), "hi");
      await writeFile(join(dir, "agent.json"), JSON.stringify({ model: "x/y" }));
      await mkdir(join(dir, "tools"));
      await writeFile(join(dir, "tools", "not-an-object.js"), "export default 'just a string';");

      await expect(loadAgent(dir)).rejects.toThrow(/must be an object/);
    });
  });

  it("rejects a tool file whose inputSchema has no callable safeParse (e.g. an exported JSON Schema object, not a zod schema), with a guidance error", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "instructions.md"), "hi");
      await writeFile(join(dir, "agent.json"), JSON.stringify({ model: "x/y" }));
      await mkdir(join(dir, "tools"));
      // A plausible misuse: exporting a plain JSON Schema object (has "type"/"properties" but no
      // "safeParse") where a zod schema was expected — isZodSchemaLike()'s probe must reject this.
      await writeFile(
        join(dir, "tools", "json-schema.js"),
        "export default { description: 'looks like JSON Schema, not zod', " +
          "inputSchema: { type: 'object', properties: {} }, execute: () => 'x' };",
      );

      await expect(loadAgent(dir)).rejects.toThrow(/does not look like a Tool/);
    });
  });

  it("outputSchema round-trips when it looks like a zod schema (a callable safeParse)", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "instructions.md"), "hi");
      await writeFile(join(dir, "agent.json"), JSON.stringify({ model: "x/y" }));
      await mkdir(join(dir, "tools"));
      await writeFile(
        join(dir, "tools", "with-output.js"),
        "export default { description: 'has an output schema', " +
          "inputSchema: { safeParse: () => ({ success: true, data: {} }) }, " +
          "outputSchema: { safeParse: () => ({ success: true, data: 'ok' }) }, " +
          "execute: () => 'ran' };",
      );

      const agent = await loadAgent(dir);
      expect(agent.tools?.["with-output"]?.outputSchema).toBeDefined();
      expect(typeof agent.tools?.["with-output"]?.outputSchema?.safeParse).toBe("function");
    });
  });

  it("rejects a tool file whose outputSchema is present but doesn't look like a zod schema (no callable safeParse), with a guidance error instead of silently dropping it", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "instructions.md"), "hi");
      await writeFile(join(dir, "agent.json"), JSON.stringify({ model: "x/y" }));
      await mkdir(join(dir, "tools"));
      await writeFile(
        join(dir, "tools", "bad-output.js"),
        "export default { description: 'bad output schema', " +
          "inputSchema: { safeParse: () => ({ success: true, data: {} }) }, " +
          "outputSchema: { not: 'a schema' }, " +
          "execute: () => 'ran' };",
      );

      await expect(loadAgent(dir)).rejects.toThrow(/"outputSchema".*does not look like a zod schema/);
    });
  });

  it.runIf(nodeSupportsNativeTypeScript())(
    "dynamically imports a tools/*.ts file (gated on Node's native TS support)",
    async () => {
      await withTempDir(async (dir) => {
        await writeFile(join(dir, "instructions.md"), "hi");
        await writeFile(join(dir, "agent.json"), JSON.stringify({ model: "x/y" }));
        await mkdir(join(dir, "tools"));
        await writeFile(
          join(dir, "tools", "typed.ts"),
          "import { z } from 'zod';\n" +
            "import type { Tool } from '../../../../src/types.js';\n" +
            "const tool: Tool = { description: 'typed tool', inputSchema: z.object({}), execute: () => 'from-ts' };\n" +
            "export default tool;\n",
        );

        const agent = await loadAgent(dir);
        const output = await agent.tools?.typed?.execute({}, stubToolContext());
        expect(output).toBe("from-ts");
      });
    },
  );
});

describe("loadAgent() — agent.ts / agent.json precedence", () => {
  it.runIf(nodeSupportsNativeTypeScript())("agent.ts wins over agent.json when both are present", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "instructions.md"), "hi");
      await writeFile(join(dir, "agent.json"), JSON.stringify({ model: "from-json/model" }));
      await writeFile(join(dir, "agent.ts"), "export default { model: 'from-ts/model' };\n");

      const agent = await loadAgent(dir);
      expect(agent.model).toBe("from-ts/model");
    });
  });

  it.runIf(nodeSupportsNativeTypeScript())(
    "agent.ts's model may be an already-constructed object (not just a gateway string) and is passed through as-is",
    async () => {
      await withTempDir(async (dir) => {
        await writeFile(join(dir, "instructions.md"), "hi");
        await writeFile(
          join(dir, "agent.ts"),
          "export default { model: { specificationVersion: 'v2-fixture', provider: 'fixture-provider', modelId: 'fixture-object-model' } };\n",
        );

        const agent = await loadAgent(dir);
        expect(agent.model).toMatchObject({
          specificationVersion: "v2-fixture",
          provider: "fixture-provider",
          modelId: "fixture-object-model",
        });
      });
    },
  );

  it.runIf(nodeSupportsNativeTypeScript())(
    "rejects an agent.ts model object that doesn't look like a LanguageModel instance (missing specificationVersion/provider/modelId)",
    async () => {
      await withTempDir(async (dir) => {
        await writeFile(join(dir, "instructions.md"), "hi");
        await writeFile(join(dir, "agent.ts"), "export default { model: { justSome: 'field' } };\n");

        await expect(loadAgent(dir)).rejects.toThrow(/must be a string/);
      });
    },
  );
});

describe("loadAgent() — skills/ directory edge cases", () => {
  it("a subdirectory without SKILL.md is silently skipped, not treated as a packaged skill", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "instructions.md"), "hi");
      await writeFile(join(dir, "agent.json"), JSON.stringify({ model: "x/y" }));
      await mkdir(join(dir, "skills", "not-a-skill"), { recursive: true });
      await writeFile(join(dir, "skills", "not-a-skill", "notes.txt"), "just some file, not a skill");

      const agent = await loadAgent(dir);
      expect(agent.skills).toBeUndefined();
    });
  });
});
