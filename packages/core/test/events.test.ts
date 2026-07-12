import { describe, expect, it } from "vitest";
import type { NimboError, SessionEvent, SessionItem, Usage } from "../src/events.js";

/**
 * 编译期穷尽性断言：只要 SessionEvent/SessionItem 的判别联合新增一个
 * 变体而下面的 switch 没有跟着补 case，default 分支里 event/item 就不再
 * 是 never，assertNever 的形参类型不匹配，`pnpm typecheck` 直接编译失败。
 */
function assertNever(x: never): never {
  throw new Error(`unreachable variant: ${JSON.stringify(x)}`);
}

function describeSessionEvent(event: SessionEvent): string {
  switch (event.type) {
    case "session.started":
      return `session ${event.sessionId} started`;
    case "turn.started":
      return `turn ${event.turn} started`;
    case "item.started":
    case "item.updated":
    case "item.completed":
      return `${event.type}: ${event.item.type}`;
    case "turn.completed":
      return `turn completed usage=${JSON.stringify(event.usage)}`;
    case "turn.failed":
      return `turn failed: ${event.error.code}`;
    default:
      return assertNever(event);
  }
}

function describeSessionItem(item: SessionItem): string {
  switch (item.type) {
    case "agent_message":
      return `agent_message:${item.text}`;
    case "reasoning":
      return `reasoning:${item.text}`;
    case "tool_call":
      return `tool_call:${item.toolName}:${item.status}`;
    case "file_change":
      return `file_change:${item.changes.length}`;
    case "plan_update":
      return `plan_update:${item.items.length}`;
    case "error":
      return `error:${item.message}`;
    default:
      return assertNever(item);
  }
}

describe("SessionEvent", () => {
  it("covers session.started/turn.started/item.*/turn.completed/turn.failed exhaustively", () => {
    const events: SessionEvent[] = [
      { type: "session.started", sessionId: "sess_1" },
      { type: "turn.started", turn: 1 },
      { type: "item.started", item: { id: "item_1", type: "agent_message", text: "hi" } },
      { type: "item.updated", item: { id: "item_1", type: "agent_message", text: "hi " } },
      { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "hi there" } },
      { type: "turn.completed", usage: { totalTokens: 10 } },
      { type: "turn.failed", error: { code: "max_turns", message: "hit max turns" } },
    ];

    expect(events.map(describeSessionEvent)).toEqual([
      "session sess_1 started",
      "turn 1 started",
      "item.started: agent_message",
      "item.updated: agent_message",
      "item.completed: agent_message",
      "turn completed usage={\"totalTokens\":10}",
      "turn failed: max_turns",
    ]);
  });
});

describe("SessionItem", () => {
  it("covers all six item variants exhaustively", () => {
    const items: SessionItem[] = [
      { id: "1", type: "agent_message", text: "hello" },
      { id: "2", type: "reasoning", text: "thinking..." },
      { id: "3", type: "tool_call", toolName: "read_file", input: { path: "a.txt" }, status: "completed" },
      { id: "4", type: "file_change", changes: [{ path: "a.txt", kind: "update" }] },
      { id: "5", type: "plan_update", items: [{ text: "step 1", completed: true }] },
      { id: "6", type: "error", message: "boom" },
    ];

    expect(items.map(describeSessionItem)).toEqual([
      "agent_message:hello",
      "reasoning:thinking...",
      "tool_call:read_file:completed",
      "file_change:1",
      "plan_update:1",
      "error:boom",
    ]);
  });

  it("carries an optional output alongside status on tool_call", () => {
    const inProgress: SessionItem = { id: "1", type: "tool_call", toolName: "bash", input: "ls", status: "in_progress" };
    const denied: SessionItem = {
      id: "2",
      type: "tool_call",
      toolName: "bash",
      input: "rm -rf /",
      status: "denied",
      output: "denied by policy",
    };

    expect(inProgress.output).toBeUndefined();
    expect(denied.output).toBe("denied by policy");
  });
});

describe("NimboError.code", () => {
  it("only allows the four defined error codes", () => {
    const codes: NimboError["code"][] = ["max_turns", "context_overflow", "provider_error", "aborted"];
    expect(codes).toHaveLength(4);
  });
});

describe("Usage", () => {
  it("allows every token field to be absent", () => {
    const usage: Usage = {};
    expect(usage.totalTokens).toBeUndefined();
  });
});
