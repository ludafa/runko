import { describe, expect, expectTypeOf, it } from "vitest";
import type { ModelMessage } from "ai";
import { sessionStateSchema, type SessionState } from "../src/state.js";

const validState: SessionState = {
  id: "sess_1",
  turn: 2,
  createdAt: 1_700_000_000_000,
  messages: [
    { role: "system", content: "you are a helpful agent" },
    { role: "user", content: "read a.txt" },
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "call_1", toolName: "read_file", input: { path: "a.txt" } }],
    },
    {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "call_1", toolName: "read_file", output: { type: "text", value: "hello" } },
      ],
    },
    { role: "assistant", content: "the file says hello" },
  ],
};

describe("sessionStateSchema", () => {
  it("round-trips a legal SessionState", () => {
    const parsed = sessionStateSchema.parse(validState);
    expect(parsed).toEqual(validState);
  });

  it("accepts an optional inlined fsSnapshot", () => {
    const withFs: SessionState = { ...validState, fsSnapshot: { "a.txt": "hello" } };
    expect(sessionStateSchema.parse(withFs)).toEqual(withFs);
  });

  it("rejects a state missing id", () => {
    const missingId = { turn: validState.turn, createdAt: validState.createdAt, messages: validState.messages };
    expect(sessionStateSchema.safeParse(missingId).success).toBe(false);
  });

  it("rejects a state whose messages is not an array", () => {
    const result = sessionStateSchema.safeParse({ ...validState, messages: "not-an-array" });
    expect(result.success).toBe(false);
  });

  it("rejects a message with an illegal role", () => {
    const result = sessionStateSchema.safeParse({
      ...validState,
      messages: [{ role: "narrator", content: "once upon a time" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an assistant message whose content array has an unrecognized part type", () => {
    const result = sessionStateSchema.safeParse({
      ...validState,
      messages: [{ role: "assistant", content: [{ type: "not-a-real-part" }] }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a tool message with a string content (tool content must be an array)", () => {
    const result = sessionStateSchema.safeParse({
      ...validState,
      messages: [{ role: "tool", content: "not allowed for tool role" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("SessionState.messages type", () => {
  it("is assignment-compatible with ai's ModelMessage[] in both directions", () => {
    expectTypeOf<SessionState["messages"]>().toEqualTypeOf<ModelMessage[]>();

    const fromAi: ModelMessage[] = [{ role: "user", content: "hi" }];
    const state: SessionState = { id: "s", turn: 0, createdAt: 0, messages: fromAi };
    const backToAi: ModelMessage[] = state.messages;

    expect(backToAi).toBe(fromAi);
  });
});
