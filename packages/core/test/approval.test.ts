import { describe, expect, it, vi } from "vitest";
import { DEFAULT_DENY_MESSAGE, createOnceApprovalMemory, evaluateApproval, noArbiterDenyReason } from "../src/approval.js";
import type { ApprovalResolution } from "../src/approval.js";
import type { ApprovalContext, ApprovalOutcome } from "../src/types.js";

function ctx(overrides: Partial<ApprovalContext> = {}): ApprovalContext {
  return { toolName: "read-file", callId: "call_1", session: { id: "sess_1", turn: 0 }, ...overrides };
}

describe("evaluateApproval", () => {
  describe("per-tool 'allow' / unconfigured — default allow (§4.5, docs/tech/single-ledger.md §6.1)", () => {
    it("allows when per-tool approval is 'allow', without consulting the session classifier", async () => {
      const onApproval = vi.fn();
      const resolution = await evaluateApproval({
        toolName: "read-file",
        input: {},
        ctx: ctx(),
        toolApproval: "allow",
        onApproval,
      });
      expect(resolution).toEqual<ApprovalResolution>({ outcome: "allow" });
      expect(onApproval).not.toHaveBeenCalled();
    });

    it("allows when per-tool approval is unconfigured (undefined), without consulting the session classifier", async () => {
      const onApproval = vi.fn();
      const resolution = await evaluateApproval({
        toolName: "read-file",
        input: {},
        ctx: ctx(),
        toolApproval: undefined,
        onApproval,
      });
      expect(resolution).toEqual<ApprovalResolution>({ outcome: "allow" });
      expect(onApproval).not.toHaveBeenCalled();
    });

    it("allows when neither per-tool approval nor the session classifier is configured", async () => {
      const resolution = await evaluateApproval({
        toolName: "read-file",
        input: {},
        ctx: ctx(),
        toolApproval: undefined,
        onApproval: undefined,
      });
      expect(resolution).toEqual<ApprovalResolution>({ outcome: "allow" });
    });
  });

  describe("per-tool 'deny' — denies immediately with the default message, without consulting the session classifier", () => {
    it("denies via a bare 'deny' per-tool policy", async () => {
      const onApproval = vi.fn();
      const resolution = await evaluateApproval({
        toolName: "bash",
        input: {},
        ctx: ctx({ toolName: "bash" }),
        toolApproval: "deny",
        onApproval,
      });
      expect(resolution).toEqual<ApprovalResolution>({ outcome: "deny", reason: DEFAULT_DENY_MESSAGE });
      expect(onApproval).not.toHaveBeenCalled();
    });
  });

  describe("per-tool callback — decides directly from its ApprovalOutcome, never escalates to the session classifier", () => {
    it("allows via a per-tool callback returning 'allow'", async () => {
      const callback = vi.fn((): ApprovalOutcome => "allow");
      const resolution = await evaluateApproval({
        toolName: "search",
        input: { query: "x" },
        ctx: ctx({ toolName: "search" }),
        toolApproval: callback,
        onApproval: undefined,
      });
      expect(resolution).toEqual<ApprovalResolution>({ outcome: "allow" });
      expect(callback).toHaveBeenCalledWith({ query: "x" }, ctx({ toolName: "search" }));
    });

    it("denies via a per-tool callback returning 'deny' — capability-narrowed to the default message (docs/tech/single-ledger.md §6.4: a custom deny text is no longer expressible here, only via review + HumanDecision.deny.message)", async () => {
      const callback = (): ApprovalOutcome => "deny";
      const resolution = await evaluateApproval({
        toolName: "bash",
        input: { command: "rm -rf /" },
        ctx: ctx({ toolName: "bash" }),
        toolApproval: callback,
        onApproval: undefined,
      });
      expect(resolution).toEqual<ApprovalResolution>({ outcome: "deny", reason: DEFAULT_DENY_MESSAGE });
    });

    it("returns 'review' via a per-tool callback with markOnceOnApprove:false — the callback's own verdict is the terminus, loop.ts must ask a human", async () => {
      const callback = (): ApprovalOutcome => "review";
      const resolution = await evaluateApproval({
        toolName: "write-file",
        input: { path: "/etc/passwd" },
        ctx: ctx({ toolName: "write-file" }),
        toolApproval: callback,
        onApproval: undefined,
      });
      expect(resolution).toEqual<ApprovalResolution>({ outcome: "review", markOnceOnApprove: false });
    });

    it("does not consult the session classifier when the per-tool policy is a callback, regardless of its outcome", async () => {
      const onApproval = vi.fn();
      await evaluateApproval({
        toolName: "search",
        input: {},
        ctx: ctx({ toolName: "search" }),
        toolApproval: () => "review",
        onApproval,
      });
      expect(onApproval).not.toHaveBeenCalled();
    });
  });

  describe("'review' — every call escalates to the session classifier (docs/tech/single-ledger.md §6.1)", () => {
    it("escalates to the session classifier on every call, never short-circuiting", async () => {
      const onApproval = vi.fn((): ApprovalOutcome => "allow");
      for (let i = 0; i < 3; i++) {
        const resolution = await evaluateApproval({
          toolName: "bash",
          input: { command: `echo ${i}` },
          ctx: ctx({ toolName: "bash" }),
          toolApproval: "review",
          onApproval,
        });
        expect(resolution).toEqual<ApprovalResolution>({ outcome: "allow" });
      }
      expect(onApproval).toHaveBeenCalledTimes(3);
    });

    it("propagates a 'deny' outcome from the session classifier", async () => {
      const onApproval = (): ApprovalOutcome => "deny";
      const resolution = await evaluateApproval({
        toolName: "bash",
        input: {},
        ctx: ctx({ toolName: "bash" }),
        toolApproval: "review",
        onApproval,
      });
      expect(resolution).toEqual<ApprovalResolution>({ outcome: "deny", reason: DEFAULT_DENY_MESSAGE });
    });

    it("propagates a 'review' outcome from the session classifier with markOnceOnApprove:false (the per-tool policy itself isn't 'review-once')", async () => {
      const onApproval = (): ApprovalOutcome => "review";
      const resolution = await evaluateApproval({
        toolName: "bash",
        input: {},
        ctx: ctx({ toolName: "bash" }),
        toolApproval: "review",
        onApproval,
      });
      expect(resolution).toEqual<ApprovalResolution>({ outcome: "review", markOnceOnApprove: false });
    });
  });

  describe("'review-once' — first call escalates, an approved call is remembered by tool name (docs/tech/single-ledger.md §6.1 review-once 语义)", () => {
    it("asks the session classifier the first time, then allows subsequent calls without asking again", async () => {
      const onApproval = vi.fn((): ApprovalOutcome => "allow");
      const onceMemory = createOnceApprovalMemory();

      const first = await evaluateApproval({
        toolName: "bash",
        input: { command: "ls" },
        ctx: ctx({ toolName: "bash" }),
        toolApproval: "review-once",
        onApproval,
        onceMemory,
      });
      const second = await evaluateApproval({
        toolName: "bash",
        input: { command: "pwd" },
        ctx: ctx({ toolName: "bash" }),
        toolApproval: "review-once",
        onApproval,
        onceMemory,
      });

      expect(first).toEqual<ApprovalResolution>({ outcome: "allow" });
      expect(second).toEqual<ApprovalResolution>({ outcome: "allow" });
      expect(onApproval).toHaveBeenCalledTimes(1);
      expect(onceMemory.hasApproved("bash")).toBe(true);
    });

    it("does not remember a denied 'review-once' call — asks again next time", async () => {
      const onApproval = vi
        .fn<(...args: unknown[]) => ApprovalOutcome>()
        .mockReturnValueOnce("deny")
        .mockReturnValueOnce("allow");
      const onceMemory = createOnceApprovalMemory();

      const first = await evaluateApproval({
        toolName: "bash",
        input: {},
        ctx: ctx({ toolName: "bash" }),
        toolApproval: "review-once",
        onApproval,
        onceMemory,
      });
      const second = await evaluateApproval({
        toolName: "bash",
        input: {},
        ctx: ctx({ toolName: "bash" }),
        toolApproval: "review-once",
        onApproval,
        onceMemory,
      });

      expect(first).toEqual<ApprovalResolution>({ outcome: "deny", reason: DEFAULT_DENY_MESSAGE });
      expect(second).toEqual<ApprovalResolution>({ outcome: "allow" });
      expect(onApproval).toHaveBeenCalledTimes(2);
      expect(onceMemory.hasApproved("bash")).toBe(true);
    });

    it("keys once-memory by tool name — approving one tool doesn't approve another", async () => {
      const onApproval = vi.fn((): ApprovalOutcome => "allow");
      const onceMemory = createOnceApprovalMemory();

      await evaluateApproval({
        toolName: "bash",
        input: {},
        ctx: ctx({ toolName: "bash" }),
        toolApproval: "review-once",
        onApproval,
        onceMemory,
      });
      await evaluateApproval({
        toolName: "write-file",
        input: {},
        ctx: ctx({ toolName: "write-file" }),
        toolApproval: "review-once",
        onApproval,
        onceMemory,
      });

      expect(onApproval).toHaveBeenCalledTimes(2);
    });

    it("without an onceMemory, behaves like 'review' (asks every time, never marks anything)", async () => {
      const onApproval = vi.fn((): ApprovalOutcome => "allow");
      await evaluateApproval({
        toolName: "bash",
        input: {},
        ctx: ctx({ toolName: "bash" }),
        toolApproval: "review-once",
        onApproval,
      });
      await evaluateApproval({
        toolName: "bash",
        input: {},
        ctx: ctx({ toolName: "bash" }),
        toolApproval: "review-once",
        onApproval,
      });
      expect(onApproval).toHaveBeenCalledTimes(2);
    });

    it("P13-5-2c once-memory timing: a session classifier that resolves synchronously to 'allow' marks once-memory immediately inside evaluateApproval — loop.ts never has to (approval.ts 头注释)", async () => {
      const onceMemory = createOnceApprovalMemory();
      const resolution = await evaluateApproval({
        toolName: "bash",
        input: {},
        ctx: ctx({ toolName: "bash" }),
        toolApproval: "review-once",
        onApproval: "allow",
        onceMemory,
      });
      expect(resolution).toEqual<ApprovalResolution>({ outcome: "allow" });
      expect(onceMemory.hasApproved("bash")).toBe(true);
    });

    it("P13-5-2c: when escalation bubbles up to 'review' (session classifier itself defers to a human), markOnceOnApprove is set true — the marking decision is handed to loop.ts, not decided here", async () => {
      const onceMemory = createOnceApprovalMemory();
      const onApproval = (): ApprovalOutcome => "review";
      const resolution = await evaluateApproval({
        toolName: "bash",
        input: {},
        ctx: ctx({ toolName: "bash" }),
        toolApproval: "review-once",
        onApproval,
        onceMemory,
      });
      expect(resolution).toEqual<ApprovalResolution>({ outcome: "review", markOnceOnApprove: true });
      expect(onceMemory.hasApproved("bash")).toBe(false);
    });
  });

  describe("spec gap: 'review'/'review-once' with no session classifier configured — deny with guidance (docs/tech/single-ledger.md §6.4 无仲裁者)", () => {
    it("denies a 'review' tool call when the session classifier is not configured", async () => {
      const resolution = await evaluateApproval({
        toolName: "bash",
        input: {},
        ctx: ctx({ toolName: "bash" }),
        toolApproval: "review",
        onApproval: undefined,
      });
      expect(resolution).toEqual<ApprovalResolution>({ outcome: "deny", reason: noArbiterDenyReason("bash") });
    });

    it("denies a first-time 'review-once' tool call when the session classifier is not configured, and does not mark once-memory", async () => {
      const onceMemory = createOnceApprovalMemory();
      const resolution = await evaluateApproval({
        toolName: "bash",
        input: {},
        ctx: ctx({ toolName: "bash" }),
        toolApproval: "review-once",
        onApproval: undefined,
        onceMemory,
      });
      expect(resolution.outcome).toBe("deny");
      expect(onceMemory.hasApproved("bash")).toBe(false);
    });

    it("the guidance message names the tool and mentions both remedies: configuring a session classifier/onReview, or lowering the tool's approval", async () => {
      const resolution = await evaluateApproval({
        toolName: "bash",
        input: {},
        ctx: ctx({ toolName: "bash" }),
        toolApproval: "review",
        onApproval: undefined,
      });
      const message = resolution.outcome === "deny" ? resolution.reason : "";
      expect(message).toContain('"bash"');
      expect(message).toContain("approval classifier");
      expect(message).toContain("onReview");
      expect(message).toContain("allow");
    });
  });

  describe("session classifier itself is a bare 'allow'/'review'/'review-once'/'deny' literal (not a callback)", () => {
    it("onApproval: 'allow' allows any escalated request", async () => {
      const resolution = await evaluateApproval({
        toolName: "bash",
        input: {},
        ctx: ctx({ toolName: "bash" }),
        toolApproval: "review",
        onApproval: "allow",
      });
      expect(resolution).toEqual<ApprovalResolution>({ outcome: "allow" });
    });

    it("onApproval: 'deny' literal denies with the default message", async () => {
      const resolution = await evaluateApproval({
        toolName: "bash",
        input: {},
        ctx: ctx({ toolName: "bash" }),
        toolApproval: "review",
        onApproval: "deny",
      });
      expect(resolution).toEqual<ApprovalResolution>({ outcome: "deny", reason: DEFAULT_DENY_MESSAGE });
    });

    it("onApproval: 'review' literal (no callback) has no arbiter beyond it — denies (approval.ts spec gap #2)", async () => {
      const resolution = await evaluateApproval({
        toolName: "bash",
        input: {},
        ctx: ctx({ toolName: "bash" }),
        toolApproval: "review",
        onApproval: "review",
      });
      expect(resolution.outcome).toBe("deny");
    });

    it("onApproval: 'review-once' literal (no callback) denies since there is nobody to ever grant it, on every call", async () => {
      const onceMemory = createOnceApprovalMemory();
      const first = await evaluateApproval({
        toolName: "bash",
        input: {},
        ctx: ctx({ toolName: "bash" }),
        toolApproval: "review",
        onApproval: "review-once",
        onceMemory,
      });
      const second = await evaluateApproval({
        toolName: "bash",
        input: {},
        ctx: ctx({ toolName: "bash" }),
        toolApproval: "review",
        onApproval: "review-once",
        onceMemory,
      });
      expect(first.outcome).toBe("deny");
      expect(second.outcome).toBe("deny");
    });

    it("session 'review-once' already approved in once-memory short-circuits to allow even when per-tool policy is plain 'review'", async () => {
      const onceMemory = createOnceApprovalMemory();
      onceMemory.markApproved("bash");
      const resolution = await evaluateApproval({
        toolName: "bash",
        input: {},
        ctx: ctx({ toolName: "bash" }),
        toolApproval: "review",
        onApproval: "review-once",
        onceMemory,
      });
      expect(resolution).toEqual<ApprovalResolution>({ outcome: "allow" });
    });

    it("per-tool 'review-once' escalating to a session classifier that is itself the bare 'review' literal has no further arbiter — denies without marking (approval.ts 头注释 spec gap #2)", async () => {
      const onceMemory = createOnceApprovalMemory();
      const resolution = await evaluateApproval({
        toolName: "bash",
        input: {},
        ctx: ctx({ toolName: "bash" }),
        toolApproval: "review-once",
        onApproval: "review",
        onceMemory,
      });
      expect(resolution.outcome).toBe("deny");
      expect(onceMemory.hasApproved("bash")).toBe(false);
    });
  });

  describe("createOnceApprovalMemory", () => {
    it("starts empty and reflects markApproved per tool name", () => {
      const memory = createOnceApprovalMemory();
      expect(memory.hasApproved("bash")).toBe(false);
      memory.markApproved("bash");
      expect(memory.hasApproved("bash")).toBe(true);
      expect(memory.hasApproved("write-file")).toBe(false);
    });
  });

  describe("DEFAULT_DENY_MESSAGE / noArbiterDenyReason", () => {
    it("DEFAULT_DENY_MESSAGE is the fixed backfill text for policy/classifier 'deny' outcomes", () => {
      expect(DEFAULT_DENY_MESSAGE).toBe("Tool call denied.");
    });

    it("noArbiterDenyReason names the specific tool and both remedies (session classifier or onReview; or lower the policy)", () => {
      const message = noArbiterDenyReason("bash");
      expect(message).toContain('"bash"');
      expect(message).toContain("onReview");
      expect(message).toContain("allow");
    });
  });
});
