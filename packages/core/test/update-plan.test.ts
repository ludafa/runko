import { describe, expect, it, vi } from "vitest";
import { createPlanStore, createUpdatePlanTool } from "../src/tools/builtin/update-plan.js";
import type { ToolContext } from "../src/types.js";

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

describe("createPlanStore", () => {
  it("starts empty", () => {
    const store = createPlanStore();
    expect(store.getItems()).toEqual([]);
  });

  it("setItems replaces the whole table (not a merge)", () => {
    const store = createPlanStore();
    store.setItems([{ text: "a", completed: false }]);
    store.setItems([{ text: "b", completed: true }]);
    expect(store.getItems()).toEqual([{ text: "b", completed: true }]);
  });
});

describe("createUpdatePlanTool", () => {
  it("declares a snake_case-consistent description and a schema for { items: {text, completed}[] }", () => {
    const tool = createUpdatePlanTool({ store: createPlanStore() });
    expect(typeof tool.description).toBe("string");
    expect(tool.description.length).toBeGreaterThan(0);

    const parsed = tool.inputSchema.safeParse({ items: [{ text: "step 1", completed: false }] });
    expect(parsed.success).toBe(true);
  });

  it("rejects malformed items via inputSchema (missing completed field)", () => {
    const tool = createUpdatePlanTool({ store: createPlanStore() });
    const parsed = tool.inputSchema.safeParse({ items: [{ text: "step 1" }] });
    expect(parsed.success).toBe(false);
  });

  it("replaces the store's full table and returns a confirmation string", async () => {
    const store = createPlanStore();
    const tool = createUpdatePlanTool({ store });

    const output = await tool.execute({ items: [{ text: "write tests", completed: false }] }, makeCtx());

    expect(typeof output).toBe("string");
    expect(output).toContain("1");
    expect(store.getItems()).toEqual([{ text: "write tests", completed: false }]);
  });

  it("second call overwrites the first call's items entirely (full-table replace)", async () => {
    const store = createPlanStore();
    const tool = createUpdatePlanTool({ store });

    await tool.execute({ items: [{ text: "a", completed: false }, { text: "b", completed: false }] }, makeCtx());
    await tool.execute({ items: [{ text: "c", completed: true }] }, makeCtx());

    expect(store.getItems()).toEqual([{ text: "c", completed: true }]);
  });

  it("reports the count of completed items in the confirmation text", async () => {
    const store = createPlanStore();
    const tool = createUpdatePlanTool({ store });

    const output = await tool.execute(
      {
        items: [
          { text: "a", completed: true },
          { text: "b", completed: true },
          { text: "c", completed: false },
        ],
      },
      makeCtx(),
    );

    expect(output).toContain("3");
    expect(output).toContain("2");
  });

  it("calls onPlanUpdate with the new items on every successful call", async () => {
    const onPlanUpdate = vi.fn();
    const tool = createUpdatePlanTool({ store: createPlanStore(), onPlanUpdate });

    const firstItems = [{ text: "a", completed: false }];
    const secondItems = [{ text: "a", completed: true }];
    await tool.execute({ items: firstItems }, makeCtx());
    await tool.execute({ items: secondItems }, makeCtx());

    expect(onPlanUpdate).toHaveBeenNthCalledWith(1, firstItems);
    expect(onPlanUpdate).toHaveBeenNthCalledWith(2, secondItems);
    expect(onPlanUpdate).toHaveBeenCalledTimes(2);
  });

  it("does not require onPlanUpdate — omitting it does not throw", async () => {
    const tool = createUpdatePlanTool({ store: createPlanStore() });
    const output = await tool.execute({ items: [] }, makeCtx());
    expect(output).toBeDefined();
  });

  it("accepts an empty items array (clears the plan)", async () => {
    const store = createPlanStore();
    const tool = createUpdatePlanTool({ store });
    store.setItems([{ text: "stale", completed: false }]);

    await tool.execute({ items: [] }, makeCtx());

    expect(store.getItems()).toEqual([]);
  });
});
