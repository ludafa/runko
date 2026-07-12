import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { defineTool } from "../src/tool.js";
import type { ApprovalContext, ApprovalDecision, ApprovalPolicy, JsonValue, Tool, ToolContext } from "../src/types.js";

function makeCtx(): ToolContext {
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

describe("defineTool", () => {
  it("infers execute's input precisely from a zod object inputSchema", async () => {
    const inputSchema = z.object({ path: z.string(), limit: z.number().optional() });

    const tool = defineTool({
      description: "reads a file with an optional line limit",
      inputSchema,
      execute: (input) => {
        expectTypeOf(input).toEqualTypeOf<{ path: string; limit?: number }>();
        return input.limit === undefined ? input.path : `${input.path}:${input.limit}`;
      },
    });

    // Tool.execute is type-erased to JsonValue, but the precise-typed execute
    // above still runs underneath: the assertion covers the definition site.
    expect(await tool.execute({ path: "a.txt" }, makeCtx())).toBe("a.txt");
    expect(await tool.execute({ path: "a.txt", limit: 10 }, makeCtx())).toBe("a.txt:10");
  });

  it("rejects a zod schema whose inferred output is not JSON-shaped", () => {
    // z.date()'s Output is `Date`, which is not assignable to JsonValue —
    // this is exactly what the `In extends z.ZodType<JsonValue>` bound
    // (tool.ts's documented deviation from the spec's unconstrained `In`) exists to catch.
    expectTypeOf<z.ZodType<Date>>().not.toExtend<z.ZodType<JsonValue>>();
  });

  it("passes description/inputSchema/outputSchema through untouched, by identity", () => {
    const inputSchema = z.object({ query: z.string() });
    const outputSchema = z.string();

    const tool = defineTool({
      description: "search",
      inputSchema,
      outputSchema,
      execute: (input) => input.query,
    });

    expect(tool.description).toBe("search");
    expect(tool.inputSchema).toBe(inputSchema);
    expect(tool.outputSchema).toBe(outputSchema);
  });

  it("omits outputSchema/approval on the returned Tool when not supplied", () => {
    const tool = defineTool({
      description: "noop",
      inputSchema: z.object({}),
      execute: () => "ok",
    });

    expect(tool.outputSchema).toBeUndefined();
    expect(tool.approval).toBeUndefined();
  });

  it("returns a value assignable to Record<string, Tool>, alongside a differently-shaped tool", () => {
    const readTool = defineTool({
      description: "read a file",
      inputSchema: z.object({ path: z.string() }),
      execute: (input) => input.path,
    });
    const searchTool = defineTool({
      description: "search text",
      inputSchema: z.object({ query: z.string(), limit: z.number().optional() }),
      execute: (input) => input.query,
    });

    // The point of this test is that the next line type-checks at all: two
    // `defineTool` results with unrelated `In`/`Out` generics both collapse
    // to `Tool` and coexist in one Record.
    const tools: Record<string, Tool> = { read_file: readTool, search: searchTool };

    expect(Object.keys(tools)).toEqual(["read_file", "search"]);
  });

  describe("approval", () => {
    it("accepts the three approval literals at the type level", () => {
      expectTypeOf<"never">().toExtend<ApprovalPolicy>();
      expectTypeOf<"always">().toExtend<ApprovalPolicy>();
      expectTypeOf<"once">().toExtend<ApprovalPolicy>();
    });

    it("accepts an approval callback at the type level", () => {
      expectTypeOf<
        (input: JsonValue, ctx: ApprovalContext) => Promise<ApprovalDecision> | ApprovalDecision
      >().toExtend<ApprovalPolicy>();
    });

    it("rejects an arbitrary string at the type level", () => {
      expectTypeOf<"sometimes">().not.toExtend<ApprovalPolicy>();
    });

    it("threads each of the four approval kinds through defineTool at runtime", () => {
      const literalKinds = ["never", "always", "once"] as const;
      for (const approval of literalKinds) {
        const tool = defineTool({ description: "a", inputSchema: z.object({}), approval, execute: () => "ok" });
        expect(tool.approval).toBe(approval);
      }

      const callback: ApprovalPolicy = () => ({ behavior: "allow" });
      const withCallback = defineTool({
        description: "a",
        inputSchema: z.object({}),
        approval: callback,
        execute: () => "ok",
      });
      expect(withCallback.approval).toBe(callback);
    });
  });
});
