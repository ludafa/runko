import { describe, expect, it } from "vitest";
import { z } from "zod";
import { convertTool, convertTools } from "../../src/model/convert.js";
import type { Tool as RunkoTool } from "../../src/types.js";

function makeRunkoTool(overrides: Partial<RunkoTool> = {}): RunkoTool {
  return {
    description: "reads a file",
    inputSchema: z.object({ path: z.string() }),
    execute: (input) => JSON.stringify(input),
    ...overrides,
  };
}

describe("convertTool", () => {
  it("passes description and inputSchema through by identity", () => {
    const inputSchema = z.object({ query: z.string() });
    const runkoTool = makeRunkoTool({ description: "search", inputSchema });

    const aiTool = convertTool(runkoTool);

    expect(aiTool.description).toBe("search");
    expect(aiTool.inputSchema).toBe(inputSchema);
  });

  it("omits execute on the returned AI SDK tool object (manual loop control point)", () => {
    const aiTool = convertTool(makeRunkoTool());

    expect("execute" in aiTool).toBe(false);
    expect(aiTool.execute).toBeUndefined();
  });

  it("does not carry over outputSchema/approval — those are runko-only concerns", () => {
    const aiTool = convertTool(
      makeRunkoTool({ outputSchema: z.string(), approval: "review" }),
    );

    expect("outputSchema" in aiTool).toBe(false);
    expect("approval" in aiTool).toBe(false);
  });
});

describe("convertTools", () => {
  it("converts an empty tool record into an empty ToolSet", () => {
    expect(convertTools({})).toEqual({});
  });

  it("converts each entry, keyed by the same tool name", () => {
    const readSchema = z.object({ path: z.string() });
    const searchSchema = z.object({ query: z.string() });

    const toolSet = convertTools({
      "read-file": makeRunkoTool({ description: "read", inputSchema: readSchema }),
      search: makeRunkoTool({ description: "search", inputSchema: searchSchema }),
    });

    expect(Object.keys(toolSet).sort()).toEqual(["read-file", "search"]);
    expect(toolSet["read-file"]?.description).toBe("read");
    expect(toolSet["read-file"]?.inputSchema).toBe(readSchema);
    expect(toolSet["search"]?.description).toBe("search");
    expect(toolSet["search"]?.inputSchema).toBe(searchSchema);
    expect("execute" in (toolSet["read-file"] ?? {})).toBe(false);
    expect("execute" in (toolSet["search"] ?? {})).toBe(false);
  });
});
