import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createOnceApprovalMemory } from "../src/approval.js";
import { createDerivedDataCollector, executeToolCall, resolveToolCallApproval } from "../src/runtime.js";
import type { ExecuteToolCallOptions, ResolveToolCallApprovalOptions } from "../src/runtime.js";
import { createPlanStore, createUpdatePlanTool } from "../src/tools/builtin/update-plan.js";
import type { ApprovalOutcome, JsonValue, NimboFS, Tool, ToolContext, ToolReturn } from "../src/types.js";

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

function baseApprovalOptions(
  overrides: Partial<ResolveToolCallApprovalOptions> = {},
): Omit<ResolveToolCallApprovalOptions, "tool" | "input"> {
  return {
    toolName: "test_tool",
    callId: "call_1",
    session: { id: "sess_1", turn: 0 },
    ...overrides,
  };
}

/**
 * P13-5-2c (docs/tech/single-ledger.md §6.4) split the old atomic `executeToolCall`
 * (validate → approve → execute) into two independent steps so `loop.ts` can yield a
 * `tool-approval-request` chunk *before* awaiting a human reviewer — `resolveToolCallApproval`
 * (input validation + the approval chain, no execution) and `executeToolCall` (execution only,
 * input already validated/approved). `evaluateApproval`'s own matrix (per-tool/session
 * combinations, once-memory, no-arbiter deny) is exhaustively covered in approval.test.ts; the
 * tests here only lock the wiring — that `resolveToolCallApproval` calls `inputSchema.safeParse`
 * first and then threads `tool.approval`/`onApproval`/`onceMemory` into `evaluateApproval`
 * correctly, mapping its `ApprovalResolution` onto `ToolCallApprovalOutcome`.
 */
describe("resolveToolCallApproval", () => {
  describe("input validation (tool.inputSchema.safeParse) — happens before the approval chain", () => {
    it("returns status:'invalid' with a guidance message on malformed input, without evaluating approval (even for a 'deny' tool)", async () => {
      const tool: Tool = {
        description: "d",
        inputSchema: z.object({ path: z.string() }),
        approval: "deny",
        execute: () => "unused",
      };

      const outcome = await resolveToolCallApproval({ ...baseApprovalOptions(), tool, input: { path: 42 } });

      expect(outcome.status).toBe("invalid");
      expect(outcome.status === "invalid" ? outcome.message : "").toContain('"test_tool"');
    });

    it("does not throw — a malformed call resolves normally instead of rejecting", async () => {
      const tool: Tool = { description: "d", inputSchema: z.object({ path: z.string() }), execute: () => "unused" };
      await expect(resolveToolCallApproval({ ...baseApprovalOptions(), tool, input: null })).resolves.toMatchObject({
        status: "invalid",
      });
    });
  });

  describe("approval chain wiring (delegates to approval.ts's evaluateApproval — see approval.test.ts for the exhaustive outcome matrix)", () => {
    it("status:'allow' carries the validated input through, via the default policy ('allow' when unconfigured)", async () => {
      const tool: Tool = { description: "d", inputSchema: z.object({}), execute: () => "unused" };
      const outcome = await resolveToolCallApproval({ ...baseApprovalOptions(), tool, input: {} });
      expect(outcome).toEqual({ status: "allow", input: {} });
    });

    it("status:'deny' carries the resolved reason from a per-tool 'deny' policy", async () => {
      const tool: Tool = { description: "d", inputSchema: z.object({}), approval: "deny", execute: () => "unused" };
      const outcome = await resolveToolCallApproval({ ...baseApprovalOptions(), tool, input: {} });
      expect(outcome).toEqual({ status: "deny", reason: "Tool call denied." });
    });

    it("status:'deny' with no-arbiter guidance when per-tool is 'review' and no session classifier is configured", async () => {
      const tool: Tool = { description: "d", inputSchema: z.object({}), approval: "review", execute: () => "unused" };
      const outcome = await resolveToolCallApproval({ ...baseApprovalOptions(), tool, input: {} });
      expect(outcome.status).toBe("deny");
      expect(outcome.status === "deny" ? outcome.reason : "").toContain("no approver configured");
    });

    it("status:'review' carries the validated input and markOnceOnApprove:false when a session classifier callback itself resolves to 'review'", async () => {
      const tool: Tool = { description: "d", inputSchema: z.object({ command: z.string() }), approval: "review", execute: () => "unused" };
      const onApproval = (): ApprovalOutcome => "review";

      const outcome = await resolveToolCallApproval({
        ...baseApprovalOptions(),
        tool,
        input: { command: "rm -rf /" },
        onApproval,
      });

      expect(outcome).toEqual({ status: "review", input: { command: "rm -rf /" }, markOnceOnApprove: false });
    });

    it("threads onceMemory through so a 'review-once' policy is escalated only once (second call short-circuits to allow without calling onApproval again)", async () => {
      const onApproval = vi.fn((): ApprovalOutcome => "allow");
      const onceMemory = createOnceApprovalMemory();
      const tool: Tool = { description: "d", inputSchema: z.object({}), approval: "review-once", execute: () => "ok" };

      const first = await resolveToolCallApproval({ ...baseApprovalOptions(), tool, input: {}, onApproval, onceMemory });
      const second = await resolveToolCallApproval({ ...baseApprovalOptions(), tool, input: {}, onApproval, onceMemory });

      expect(first).toEqual({ status: "allow", input: {} });
      expect(second).toEqual({ status: "allow", input: {} });
      expect(onApproval).toHaveBeenCalledTimes(1);
    });
  });
});

describe("executeToolCall", () => {
  describe("does not validate input or evaluate approval — that is resolveToolCallApproval's job (P13-5-2c split, docs/tech/single-ledger.md §6.4)", () => {
    it("passes input straight to execute() even when it does not satisfy the tool's own inputSchema", async () => {
      const execute = vi.fn(() => "ran anyway");
      const tool: Tool = { description: "d", inputSchema: z.object({ path: z.string() }), execute };

      const result = await executeToolCall({ ...baseOptions(), tool, input: { path: 42 } });

      expect(result.status).toBe("completed");
      expect(execute).toHaveBeenCalledWith({ path: 42 }, expect.anything());
    });

    it("ignores tool.approval entirely — a 'deny'-policy tool still executes when called directly", async () => {
      const execute = vi.fn(() => "ran");
      const tool: Tool = { description: "d", inputSchema: z.object({}), approval: "deny", execute };

      const result = await executeToolCall({ ...baseOptions(), tool, input: {} });

      expect(result.status).toBe("completed");
      expect(execute).toHaveBeenCalledTimes(1);
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

    it("integrates end-to-end with the real update-plan tool: derived.items matches the request", async () => {
      const collector = createDerivedDataCollector();
      const store = createPlanStore();
      const tool = createUpdatePlanTool({ store, onPlanUpdate: collector.recordPlanUpdate });

      const items = [
        { text: "write approval.ts", completed: true },
        { text: "write runtime.ts", completed: false },
      ];
      const result = await executeToolCall({
        ...baseOptions({ toolName: "update-plan" }),
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
