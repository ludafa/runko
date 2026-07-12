import { describe, expect, expectTypeOf, it } from "vitest";
import { defineAgent, READ_ONLY_TOOLS } from "../src/agent.js";
import type { AgentDefinition, BuiltinToolName } from "../src/agent.js";

const model = "anthropic/claude-sonnet-5";

describe("defineAgent", () => {
  it("is an identity function (returns the same reference)", () => {
    const def: AgentDefinition = { model };
    expect(defineAgent(def)).toBe(def);
  });

  it("accepts builtinTools: false to disable all builtin tools", () => {
    const def = defineAgent({ model, builtinTools: false });
    expect(def.builtinTools).toBe(false);
  });

  it("accepts a curated builtinTools allowlist", () => {
    const def = defineAgent({ model, builtinTools: ["read_file"] });
    expect(def.builtinTools).toEqual(["read_file"]);
  });

  it("accepts the full spec field set without mutating or dropping fields", () => {
    const tools = {};
    const skills: AgentDefinition["skills"] = [];
    const def = defineAgent({
      model,
      instructions: "be helpful",
      tools,
      skills,
      maxTurnsPerRun: 10,
      maxOutputTokens: 4096,
    });

    expect(def.instructions).toBe("be helpful");
    expect(def.tools).toBe(tools);
    expect(def.skills).toBe(skills);
    expect(def.maxTurnsPerRun).toBe(10);
    expect(def.maxOutputTokens).toBe(4096);
  });
});

describe("BuiltinToolName", () => {
  it("is exactly the nine file/plan tool names", () => {
    const names: BuiltinToolName[] = [
      "read_file",
      "write_file",
      "edit_file",
      "delete_file",
      "move_file",
      "list_dir",
      "glob",
      "grep",
      "update_plan",
    ];
    expect(names).toHaveLength(9);
  });

  it("excludes load_skill and bash at the type level (both are conditionally-activated, not user-toggled)", () => {
    expectTypeOf<"load_skill">().not.toExtend<BuiltinToolName>();
    expectTypeOf<"bash">().not.toExtend<BuiltinToolName>();
  });

  it("rejects an illegal builtin tool name on AgentDefinition.builtinTools at the type level", () => {
    expectTypeOf<["load_skill"]>().not.toExtend<AgentDefinition["builtinTools"]>();
  });
});

describe("READ_ONLY_TOOLS", () => {
  it("is read_file/list_dir/glob/grep", () => {
    expect(READ_ONLY_TOOLS).toEqual(["read_file", "list_dir", "glob", "grep"]);
  });

  it("is a readonly literal tuple (as const)", () => {
    expectTypeOf(READ_ONLY_TOOLS).toEqualTypeOf<readonly ["read_file", "list_dir", "glob", "grep"]>();
  });

  it("is assignable to BuiltinToolName[] and usable directly as an agent's builtinTools", () => {
    const tools: BuiltinToolName[] = [...READ_ONLY_TOOLS];
    const def = defineAgent({ model, builtinTools: [...READ_ONLY_TOOLS] });

    expect(tools).toEqual(["read_file", "list_dir", "glob", "grep"]);
    expect(def.builtinTools).toEqual(["read_file", "list_dir", "glob", "grep"]);
  });
});
