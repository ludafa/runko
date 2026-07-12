import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createOnceApprovalMemory } from "../src/approval.js";
import { createDerivedDataCollector, executeToolCall } from "../src/runtime.js";
import type { ExecuteToolCallOptions } from "../src/runtime.js";
import { createPlanStore, createUpdatePlanTool } from "../src/tools/builtin/update-plan.js";
import type { ApprovalDecision, JsonValue, NimboFS, Tool, ToolContext, ToolReturn } from "../src/types.js";

/**
 * `ToolCallResult.output` is `ToolReturn` (`string | JsonValue`); several assertions here need
 * the string content specifically. A `typeof` guard narrows it without a type assertion — if a
 * given call site's output turns out not to be a string, the `expect` below fails loudly instead
 * of the test silently comparing against `undefined`.
 */
function expectStringOutput(output: ToolReturn): string {
  expect(typeof output).toBe("string");
  return typeof output === "string" ? output : "";
}

function fakeFs(): NimboFS {
  return {
    readFile: async () => new Uint8Array(),
    writeFile: async () => {},
    rm: async () => {},
    mkdir: async () => {},
    readdir: async () => [],
    stat: async () => ({ type: "file" }),
    glob: async () => [],
  };
}

function baseOptions(overrides: Partial<ExecuteToolCallOptions> = {}): Omit<ExecuteToolCallOptions, "tool" | "input"> {
  return {
    toolName: "test_tool",
    callId: "call_1",
    session: { id: "sess_1", turn: 0 },
    fs: fakeFs(),
    abortSignal: new AbortController().signal,
    ...overrides,
  };
}

describe("executeToolCall", () => {
  describe("input validation (tool.inputSchema.safeParse)", () => {
    it("returns failed with a guidance message on malformed input, without calling execute", async () => {
      const execute = vi.fn(() => "unused");
      const tool: Tool = { description: "d", inputSchema: z.object({ path: z.string() }), execute };

      const result = await executeToolCall({ ...baseOptions(), tool, input: { path: 42 } });

      expect(result.status).toBe("failed");
      expect(expectStringOutput(result.output)).toContain('"test_tool"');
      expect(execute).not.toHaveBeenCalled();
      expect(result.derived).toEqual({ changes: [] });
    });

    it("does not throw — a malformed call resolves normally instead of rejecting", async () => {
      const tool: Tool = { description: "d", inputSchema: z.object({ path: z.string() }), execute: () => "unused" };
      await expect(executeToolCall({ ...baseOptions(), tool, input: null })).resolves.toMatchObject({
        status: "failed",
      });
    });
  });

  describe("approval chain integration", () => {
    it("denies and puts the rejection reason in the backfill output", async () => {
      const execute = vi.fn(() => "unused");
      const tool: Tool = {
        description: "d",
        inputSchema: z.object({}),
        approval: (): ApprovalDecision => ({ behavior: "deny", message: "no bash in prod" }),
        execute,
      };

      const result = await executeToolCall({ ...baseOptions(), tool, input: {} });

      expect(result.status).toBe("denied");
      expect(result.output).toBe("no bash in prod");
      expect(execute).not.toHaveBeenCalled();
    });

    it("falls back to a default deny message when the decision carries none", async () => {
      const tool: Tool = {
        description: "d",
        inputSchema: z.object({}),
        approval: (): ApprovalDecision => ({ behavior: "deny" }),
        execute: () => "unused",
      };

      const result = await executeToolCall({ ...baseOptions(), tool, input: {} });
      expect(result.status).toBe("denied");
      expect(result.output).toBe("Tool call denied.");
    });

    it("denies 'always' with no session onApproval configured, with guidance", async () => {
      const execute = vi.fn(() => "unused");
      const tool: Tool = { description: "d", inputSchema: z.object({}), approval: "always", execute };

      const result = await executeToolCall({ ...baseOptions(), tool, input: {} });

      expect(result.status).toBe("denied");
      expect(expectStringOutput(result.output)).toContain("onApproval");
      expect(execute).not.toHaveBeenCalled();
    });

    it("executes when the approval chain allows ('never' default)", async () => {
      const execute = vi.fn(() => "ok");
      const tool: Tool = { description: "d", inputSchema: z.object({}), execute };

      const result = await executeToolCall({ ...baseOptions(), tool, input: {} });

      expect(result.status).toBe("completed");
      expect(result.output).toBe("ok");
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("replaces the input with updatedInput from an allow decision before calling execute", async () => {
      const execute = vi.fn((input: JsonValue) => input);
      const tool: Tool = {
        description: "d",
        inputSchema: z.object({ path: z.string() }),
        approval: (): ApprovalDecision => ({ behavior: "allow", updatedInput: { path: "/sanitized.txt" } }),
        execute,
      };

      const result = await executeToolCall({ ...baseOptions(), tool, input: { path: "/../etc/passwd" } });

      expect(result.status).toBe("completed");
      expect(execute).toHaveBeenCalledWith({ path: "/sanitized.txt" }, expect.anything());
      expect(result.output).toEqual({ path: "/sanitized.txt" });
    });

    it("threads onceMemory through so a session-level 'once' onApproval is asked only once", async () => {
      const onApproval = vi.fn(() => ({ behavior: "allow" }) satisfies ApprovalDecision);
      const onceMemory = createOnceApprovalMemory();
      const tool: Tool = { description: "d", inputSchema: z.object({}), approval: "once", execute: () => "ok" };

      await executeToolCall({ ...baseOptions(), tool, input: {}, onApproval, onceMemory });
      const second = await executeToolCall({ ...baseOptions(), tool, input: {}, onApproval, onceMemory });

      expect(second.status).toBe("completed");
      expect(onApproval).toHaveBeenCalledTimes(1);
    });
  });

  describe("execute() failures", () => {
    it("catches a thrown error and returns failed instead of rejecting the promise", async () => {
      const tool: Tool = {
        description: "d",
        inputSchema: z.object({}),
        execute: () => {
          throw new Error("disk on fire");
        },
      };

      const result = await executeToolCall({ ...baseOptions(), tool, input: {} });

      expect(result.status).toBe("failed");
      expect(expectStringOutput(result.output)).toContain("disk on fire");
    });

    it("stringifies a non-Error throw value", async () => {
      const tool: Tool = {
        description: "d",
        inputSchema: z.object({}),
        execute: () => {
          throw "boom";
        },
      };

      const result = await executeToolCall({ ...baseOptions(), tool, input: {} });
      expect(result.status).toBe("failed");
      expect(expectStringOutput(result.output)).toContain("boom");
    });
  });

  describe("outputSchema validation", () => {
    it("returns completed with the parsed value when outputSchema matches", async () => {
      const tool: Tool = {
        description: "d",
        inputSchema: z.object({}),
        outputSchema: z.string(),
        execute: () => "a valid string",
      };
      const result = await executeToolCall({ ...baseOptions(), tool, input: {} });
      expect(result.status).toBe("completed");
      expect(result.output).toBe("a valid string");
    });

    it("returns failed with a guidance message when the return value violates outputSchema", async () => {
      const tool: Tool = {
        description: "d",
        inputSchema: z.object({}),
        outputSchema: z.string(),
        // execute()'s declared return type is ToolReturn (string | JsonValue); returning a
        // number is legal against that type but illegal against this tool's own outputSchema.
        execute: () => 42,
      };
      const result = await executeToolCall({ ...baseOptions(), tool, input: {} });
      expect(result.status).toBe("failed");
      expect(expectStringOutput(result.output)).toContain("test_tool");
    });

    it("skips validation entirely when outputSchema is not declared", async () => {
      const tool: Tool = { description: "d", inputSchema: z.object({}), execute: () => ({ arbitrary: "shape" }) };
      const result = await executeToolCall({ ...baseOptions(), tool, input: {} });
      expect(result.status).toBe("completed");
      expect(result.output).toEqual({ arbitrary: "shape" });
    });
  });

  describe("ToolContext assembly", () => {
    it("passes fs/callId/session through to ctx", async () => {
      const fs = fakeFs();
      const execute = vi.fn((_input: JsonValue, _ctx: ToolContext) => "ok");
      const tool: Tool = { description: "d", inputSchema: z.object({}), execute };

      await executeToolCall({
        ...baseOptions({ fs, callId: "call_42", session: { id: "sess_9", turn: 3 } }),
        tool,
        input: {},
      });

      expect(execute).toHaveBeenCalledWith(
        {},
        expect.objectContaining({ fs, callId: "call_42", session: { id: "sess_9", turn: 3 } }),
      );
    });

    it("wires ctx.update(partial) to the injected onProgress callback", async () => {
      const onProgress = vi.fn();
      const tool: Tool = {
        description: "d",
        inputSchema: z.object({}),
        execute: (_input, ctx) => {
          ctx.update("halfway there");
          return "done";
        },
      };

      const result = await executeToolCall({ ...baseOptions({ onProgress }), tool, input: {} });

      expect(result.status).toBe("completed");
      expect(onProgress).toHaveBeenCalledWith("halfway there");
    });

    it("does not throw when onProgress is not provided and the tool calls ctx.update", async () => {
      const tool: Tool = {
        description: "d",
        inputSchema: z.object({}),
        execute: (_input, ctx) => {
          ctx.update("progress with nobody listening");
          return "done";
        },
      };
      const result = await executeToolCall({ ...baseOptions(), tool, input: {} });
      expect(result.status).toBe("completed");
    });

    it("getSkill() returns a placeholder handle whose text() rejects with a P5 guidance error", async () => {
      let capturedError: unknown;
      const tool: Tool = {
        description: "d",
        inputSchema: z.object({}),
        execute: async (_input, ctx) => {
          try {
            await ctx.getSkill("pdf-fill").file("notes.txt").text();
          } catch (error) {
            capturedError = error;
          }
          return "done";
        },
      };

      await executeToolCall({ ...baseOptions(), tool, input: {} });

      expect(capturedError).toBeInstanceOf(Error);
      const message = capturedError instanceof Error ? capturedError.message : "";
      expect(message).toContain("P5");
      expect(message).toContain("pdf-fill");
      expect(message).toContain("notes.txt");
    });
  });

  describe("derived data collection (file_change/plan_update seam)", () => {
    it("attaches file changes recorded by the tool during this call, and clears between calls", async () => {
      const collector = createDerivedDataCollector();
      const tool: Tool = {
        description: "d",
        inputSchema: z.object({}),
        execute: () => {
          collector.recordFileChange({ path: "/a.txt", kind: "add" });
          collector.recordFileChange({ path: "/b.txt", kind: "update" });
          return "ok";
        },
      };

      const first = await executeToolCall({ ...baseOptions(), tool, input: {}, derivedData: collector });
      expect(first.derived.changes).toEqual([
        { path: "/a.txt", kind: "add" },
        { path: "/b.txt", kind: "update" },
      ]);

      const readOnlyTool: Tool = { description: "d", inputSchema: z.object({}), execute: () => "noop" };
      const second = await executeToolCall({ ...baseOptions(), tool: readOnlyTool, input: {}, derivedData: collector });
      expect(second.derived.changes).toEqual([]);
    });

    it("attaches file changes even when execute() ultimately throws", async () => {
      const collector = createDerivedDataCollector();
      const tool: Tool = {
        description: "d",
        inputSchema: z.object({}),
        execute: () => {
          collector.recordFileChange({ path: "/partial.txt", kind: "add" });
          throw new Error("failed after partial write");
        },
      };

      const result = await executeToolCall({ ...baseOptions(), tool, input: {}, derivedData: collector });
      expect(result.status).toBe("failed");
      expect(result.derived.changes).toEqual([{ path: "/partial.txt", kind: "add" }]);
    });

    it("defaults to an empty derived payload when no collector is provided", async () => {
      const tool: Tool = { description: "d", inputSchema: z.object({}), execute: () => "ok" };
      const result = await executeToolCall({ ...baseOptions(), tool, input: {} });
      expect(result.derived).toEqual({ changes: [] });
    });

    it("integrates end-to-end with the real update_plan tool: derived.items matches the request", async () => {
      const collector = createDerivedDataCollector();
      const store = createPlanStore();
      const tool = createUpdatePlanTool({ store, onPlanUpdate: collector.recordPlanUpdate });

      const items = [
        { text: "write approval.ts", completed: true },
        { text: "write runtime.ts", completed: false },
      ];
      const result = await executeToolCall({
        ...baseOptions({ toolName: "update_plan" }),
        tool,
        input: { items },
        derivedData: collector,
      });

      expect(result.status).toBe("completed");
      expect(result.derived.items).toEqual(items);
      expect(result.derived.changes).toEqual([]);
      expect(store.getItems()).toEqual(items);
    });
  });
});
