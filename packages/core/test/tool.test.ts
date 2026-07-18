import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { defineTool } from "../src/tool.js";
import type { ApprovalContext, ApprovalOutcome, ApprovalPolicy, JsonValue, Tool, ToolContext } from "../src/types.js";

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
    const tools: Record<string, Tool> = { "read-file": readTool, search: searchTool };

    expect(Object.keys(tools)).toEqual(["read-file", "search"]);
  });

  describe("approval (docs/tech/single-ledger.md §6.1 三值重构)", () => {
    it("accepts the four approval literals at the type level", () => {
      expectTypeOf<"allow">().toExtend<ApprovalPolicy>();
      expectTypeOf<"review">().toExtend<ApprovalPolicy>();
      expectTypeOf<"review-once">().toExtend<ApprovalPolicy>();
      expectTypeOf<"deny">().toExtend<ApprovalPolicy>();
    });

    it("accepts an approval callback returning ApprovalOutcome at the type level", () => {
      expectTypeOf<
        (input: JsonValue, ctx: ApprovalContext) => Promise<ApprovalOutcome> | ApprovalOutcome
      >().toExtend<ApprovalPolicy>();
    });

    it("rejects an arbitrary string at the type level", () => {
      expectTypeOf<"sometimes">().not.toExtend<ApprovalPolicy>();
    });

    it("rejects the retired 'never'/'always'/'once' literals at the type level (2026-07-15 三值重构, docs/tech/single-ledger.md §6.1)", () => {
      expectTypeOf<"never">().not.toExtend<ApprovalPolicy>();
      expectTypeOf<"always">().not.toExtend<ApprovalPolicy>();
      expectTypeOf<"once">().not.toExtend<ApprovalPolicy>();
    });

    it("threads each of the four approval kinds through defineTool at runtime", () => {
      const literalKinds = ["allow", "review", "review-once", "deny"] as const;
      for (const approval of literalKinds) {
        const tool = defineTool({ description: "a", inputSchema: z.object({}), approval, execute: () => "ok" });
        expect(tool.approval).toBe(approval);
      }

      const callback: ApprovalPolicy = () => "allow";
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
