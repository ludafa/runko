import { describe, expect, it, vi } from "vitest";
import { createOnceApprovalMemory, evaluateApproval } from "../src/approval.js";
import type { ApprovalContext, ApprovalDecision } from "../src/types.js";

function ctx(overrides: Partial<ApprovalContext> = {}): ApprovalContext {
  return { toolName: "read_file", callId: "call_1", session: { id: "sess_1", turn: 0 }, ...overrides };
}

describe("evaluateApproval", () => {
  describe("per-tool 'never' / unconfigured — default allow (§4.5)", () => {
    it("allows when per-tool approval is 'never', without consulting onApproval", async () => {
      const onApproval = vi.fn();
      const decision = await evaluateApproval({
        toolName: "read_file",
        input: {},
        ctx: ctx(),
        toolApproval: "never",
        onApproval,
      });
      expect(decision).toEqual<ApprovalDecision>({ behavior: "allow" });
      expect(onApproval).not.toHaveBeenCalled();
    });

    it("allows when per-tool approval is unconfigured (undefined), without consulting onApproval", async () => {
      const onApproval = vi.fn();
      const decision = await evaluateApproval({
        toolName: "read_file",
        input: {},
        ctx: ctx(),
        toolApproval: undefined,
        onApproval,
      });
      expect(decision).toEqual<ApprovalDecision>({ behavior: "allow" });
      expect(onApproval).not.toHaveBeenCalled();
    });

    it("allows when neither per-tool approval nor onApproval is configured", async () => {
      const decision = await evaluateApproval({
        toolName: "read_file",
        input: {},
        ctx: ctx(),
        toolApproval: undefined,
        onApproval: undefined,
      });
      expect(decision).toEqual<ApprovalDecision>({ behavior: "allow" });
    });
  });

  describe("per-tool callback — decides directly, three-state (allow/deny/updatedInput)", () => {
    it("allows via a per-tool callback decision", async () => {
      const callback = vi.fn(() => ({ behavior: "allow" }) satisfies ApprovalDecision);
      const decision = await evaluateApproval({
        toolName: "search",
        input: { query: "x" },
        ctx: ctx({ toolName: "search" }),
        toolApproval: callback,
        onApproval: undefined,
      });
      expect(decision).toEqual<ApprovalDecision>({ behavior: "allow" });
      expect(callback).toHaveBeenCalledWith({ query: "x" }, ctx({ toolName: "search" }));
    });

    it("denies via a per-tool callback decision, carrying the message", async () => {
      const callback = (): ApprovalDecision => ({ behavior: "deny", message: "not allowed in this environment" });
      const decision = await evaluateApproval({
        toolName: "bash",
        input: { command: "rm -rf /" },
        ctx: ctx({ toolName: "bash" }),
        toolApproval: callback,
        onApproval: undefined,
      });
      expect(decision).toEqual<ApprovalDecision>({ behavior: "deny", message: "not allowed in this environment" });
    });

    it("allows with updatedInput via a per-tool callback decision", async () => {
      const callback = (): ApprovalDecision => ({ behavior: "allow", updatedInput: { path: "/sanitized.txt" } });
      const decision = await evaluateApproval({
        toolName: "write_file",
        input: { path: "/../etc/passwd" },
        ctx: ctx({ toolName: "write_file" }),
        toolApproval: callback,
        onApproval: undefined,
      });
      expect(decision).toEqual<ApprovalDecision>({ behavior: "allow", updatedInput: { path: "/sanitized.txt" } });
    });

    it("does not consult onApproval when per-tool approval is a callback", async () => {
      const onApproval = vi.fn();
      await evaluateApproval({
        toolName: "search",
        input: {},
        ctx: ctx({ toolName: "search" }),
        toolApproval: () => ({ behavior: "allow" }),
        onApproval,
      });
      expect(onApproval).not.toHaveBeenCalled();
    });
  });

  describe("'always' — every call produces a fresh approval request", () => {
    it("consults onApproval on every call, never short-circuiting", async () => {
      const onApproval = vi.fn(() => ({ behavior: "allow" }) satisfies ApprovalDecision);
      for (let i = 0; i < 3; i++) {
        const decision = await evaluateApproval({
          toolName: "bash",
          input: { command: `echo ${i}` },
          ctx: ctx({ toolName: "bash" }),
          toolApproval: "always",
          onApproval,
        });
        expect(decision).toEqual<ApprovalDecision>({ behavior: "allow" });
      }
      expect(onApproval).toHaveBeenCalledTimes(3);
    });

    it("propagates a deny decision from onApproval for an 'always' tool", async () => {
      const onApproval = (): ApprovalDecision => ({ behavior: "deny", message: "human declined" });
      const decision = await evaluateApproval({
        toolName: "bash",
        input: {},
        ctx: ctx({ toolName: "bash" }),
        toolApproval: "always",
        onApproval,
      });
      expect(decision).toEqual<ApprovalDecision>({ behavior: "deny", message: "human declined" });
    });
  });

  describe("'once' — first call asks, second call is auto-allowed (onApproval called exactly once)", () => {
    it("asks onApproval the first time, then allows subsequent calls without asking again", async () => {
      const onApproval = vi.fn(() => ({ behavior: "allow" }) satisfies ApprovalDecision);
      const onceMemory = createOnceApprovalMemory();

      const first = await evaluateApproval({
        toolName: "bash",
        input: { command: "ls" },
        ctx: ctx({ toolName: "bash" }),
        toolApproval: "once",
        onApproval,
        onceMemory,
      });
      const second = await evaluateApproval({
        toolName: "bash",
        input: { command: "pwd" },
        ctx: ctx({ toolName: "bash" }),
        toolApproval: "once",
        onApproval,
        onceMemory,
      });

      expect(first).toEqual<ApprovalDecision>({ behavior: "allow" });
      expect(second).toEqual<ApprovalDecision>({ behavior: "allow" });
      expect(onApproval).toHaveBeenCalledTimes(1);
    });

    it("does not remember a denied 'once' decision — asks again next time", async () => {
      const onApproval = vi
        .fn<(...args: unknown[]) => ApprovalDecision>()
        .mockReturnValueOnce({ behavior: "deny", message: "no" })
        .mockReturnValueOnce({ behavior: "allow" });
      const onceMemory = createOnceApprovalMemory();

      const first = await evaluateApproval({
        toolName: "bash",
        input: {},
        ctx: ctx({ toolName: "bash" }),
        toolApproval: "once",
        onApproval,
        onceMemory,
      });
      const second = await evaluateApproval({
        toolName: "bash",
        input: {},
        ctx: ctx({ toolName: "bash" }),
        toolApproval: "once",
        onApproval,
        onceMemory,
      });

      expect(first).toEqual<ApprovalDecision>({ behavior: "deny", message: "no" });
      expect(second).toEqual<ApprovalDecision>({ behavior: "allow" });
      expect(onApproval).toHaveBeenCalledTimes(2);
    });

    it("keys once-memory by tool name — approving one tool doesn't approve another", async () => {
      const onApproval = vi.fn(() => ({ behavior: "allow" }) satisfies ApprovalDecision);
      const onceMemory = createOnceApprovalMemory();

      await evaluateApproval({
        toolName: "bash",
        input: {},
        ctx: ctx({ toolName: "bash" }),
        toolApproval: "once",
        onApproval,
        onceMemory,
      });
      await evaluateApproval({
        toolName: "write_file",
        input: {},
        ctx: ctx({ toolName: "write_file" }),
        toolApproval: "once",
        onApproval,
        onceMemory,
      });

      expect(onApproval).toHaveBeenCalledTimes(2);
    });

    it("without an onceMemory, behaves like 'always' (asks every time)", async () => {
      const onApproval = vi.fn(() => ({ behavior: "allow" }) satisfies ApprovalDecision);
      await evaluateApproval({
        toolName: "bash",
        input: {},
        ctx: ctx({ toolName: "bash" }),
        toolApproval: "once",
        onApproval,
      });
      await evaluateApproval({
        toolName: "bash",
        input: {},
        ctx: ctx({ toolName: "bash" }),
        toolApproval: "once",
        onApproval,
      });
      expect(onApproval).toHaveBeenCalledTimes(2);
    });
  });

  describe("spec gap: 'always'/'once' with no onApproval configured — deny with guidance", () => {
    it("denies an 'always' tool call when onApproval is not configured", async () => {
      const decision = await evaluateApproval({
        toolName: "bash",
        input: {},
        ctx: ctx({ toolName: "bash" }),
        toolApproval: "always",
        onApproval: undefined,
      });
      expect(decision.behavior).toBe("deny");
      const message = decision.behavior === "deny" ? decision.message : undefined;
      expect(message).toContain("onApproval");
    });

    it("denies a first-time 'once' tool call when onApproval is not configured", async () => {
      const onceMemory = createOnceApprovalMemory();
      const decision = await evaluateApproval({
        toolName: "bash",
        input: {},
        ctx: ctx({ toolName: "bash" }),
        toolApproval: "once",
        onApproval: undefined,
        onceMemory,
      });
      expect(decision.behavior).toBe("deny");
      expect(onceMemory.hasApproved("bash")).toBe(false);
    });

    it("the guidance message mentions both remedies: configuring onApproval or lowering the tool's approval", async () => {
      const decision = await evaluateApproval({
        toolName: "bash",
        input: {},
        ctx: ctx({ toolName: "bash" }),
        toolApproval: "always",
        onApproval: undefined,
      });
      expect(decision.behavior).toBe("deny");
      const message = decision.behavior === "deny" ? (decision.message ?? "") : "";
      expect(message).toContain("onApproval");
      expect(message).toContain("never");
    });
  });

  describe("session onApproval itself is a bare 'never'/'always'/'once' literal (not a callback)", () => {
    it("onApproval: 'never' allows any escalated request", async () => {
      const decision = await evaluateApproval({
        toolName: "bash",
        input: {},
        ctx: ctx({ toolName: "bash" }),
        toolApproval: "always",
        onApproval: "never",
      });
      expect(decision).toEqual<ApprovalDecision>({ behavior: "allow" });
    });

    it("onApproval: 'always' literal (no callback) has no arbiter beyond it — denies", async () => {
      const decision = await evaluateApproval({
        toolName: "bash",
        input: {},
        ctx: ctx({ toolName: "bash" }),
        toolApproval: "always",
        onApproval: "always",
      });
      expect(decision.behavior).toBe("deny");
    });

    it("onApproval: 'once' literal (no callback) denies since there is nobody to ever grant it", async () => {
      const onceMemory = createOnceApprovalMemory();
      const first = await evaluateApproval({
        toolName: "bash",
        input: {},
        ctx: ctx({ toolName: "bash" }),
        toolApproval: "always",
        onApproval: "once",
        onceMemory,
      });
      const second = await evaluateApproval({
        toolName: "bash",
        input: {},
        ctx: ctx({ toolName: "bash" }),
        toolApproval: "always",
        onApproval: "once",
        onceMemory,
      });
      expect(first.behavior).toBe("deny");
      expect(second.behavior).toBe("deny");
    });
  });

  describe("createOnceApprovalMemory", () => {
    it("starts empty and reflects markApproved per tool name", () => {
      const memory = createOnceApprovalMemory();
      expect(memory.hasApproved("bash")).toBe(false);
      memory.markApproved("bash");
      expect(memory.hasApproved("bash")).toBe(true);
      expect(memory.hasApproved("write_file")).toBe(false);
    });
  });
});
