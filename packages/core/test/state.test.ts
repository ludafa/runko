import { describe, expect, expectTypeOf, it } from "vitest";
import { nimboDataPartSchemas, sessionStateSchema, validateSessionMessages, type NimboUIMessage, type SessionState } from "../src/state.js";

const validState: SessionState = {
  id: "sess_1",
  turn: 2,
  createdAt: 1_700_000_000_000,
  messages: [
    { id: "msg_1", role: "system", parts: [{ type: "text", text: "you are a helpful agent" }] },
    { id: "msg_2", role: "user", parts: [{ type: "text", text: "read a.txt" }] },
    {
      id: "msg_3",
      role: "assistant",
      parts: [
        { type: "step-start" },
        {
          type: "tool-read-file",
          toolCallId: "call_1",
          state: "output-available",
          input: { path: "a.txt" },
          output: "hello",
        },
        { type: "text", text: "the file says hello", state: "done" },
      ],
      metadata: { turn: 1, status: "completed", usage: { totalTokens: 10 } },
    },
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
      messages: [{ id: "m1", role: "narrator", parts: [{ type: "text", text: "once upon a time" }] }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a message missing an id", () => {
    const result = sessionStateSchema.safeParse({
      ...validState,
      messages: [{ role: "user", parts: [{ type: "text", text: "no id" }] }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a message whose parts is not an array", () => {
    const result = sessionStateSchema.safeParse({
      ...validState,
      messages: [{ id: "m1", role: "user", parts: "not-an-array" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a message with a part missing a string type field", () => {
    const result = sessionStateSchema.safeParse({
      ...validState,
      messages: [{ id: "m1", role: "user", parts: [{ text: "no type field here" }] }],
    });
    expect(result.success).toBe(false);
  });
});

describe("SessionState.messages type", () => {
  it("is NimboUIMessage[] (the single-ledger working format, docs/agent/single-ledger/tech.md §5-2)", () => {
    expectTypeOf<SessionState["messages"]>().toEqualTypeOf<NimboUIMessage[]>();

    const fromLedger: NimboUIMessage[] = [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }];
    const state: SessionState = { id: "s", turn: 0, createdAt: 0, messages: fromLedger };
    const backToLedger: NimboUIMessage[] = state.messages;

    expect(backToLedger).toBe(fromLedger);
  });
});

// ---- data-tool-timing（chat 可观测性：工具起止时间戳，state.ts 的 toolTimingDataSchema） ----

describe('nimboDataPartSchemas["tool-timing"]', () => {
  it("accepts { toolCallId, startedAt } with completedAt omitted (still in flight, or a crash-residue record)", () => {
    expect(nimboDataPartSchemas["tool-timing"].safeParse({ toolCallId: "call_1", startedAt: 1000 }).success).toBe(true);
  });

  it("accepts { toolCallId, startedAt, completedAt } (settled)", () => {
    expect(nimboDataPartSchemas["tool-timing"].safeParse({ toolCallId: "call_1", startedAt: 1000, completedAt: 1500 }).success).toBe(true);
  });

  it("rejects a value missing startedAt — the one required timestamp", () => {
    expect(nimboDataPartSchemas["tool-timing"].safeParse({ toolCallId: "call_1", completedAt: 1500 }).success).toBe(false);
  });

  it("rejects a value missing toolCallId", () => {
    expect(nimboDataPartSchemas["tool-timing"].safeParse({ startedAt: 1000 }).success).toBe(false);
  });

  it("rejects non-numeric startedAt/completedAt", () => {
    expect(nimboDataPartSchemas["tool-timing"].safeParse({ toolCallId: "call_1", startedAt: "1000" }).success).toBe(false);
    expect(nimboDataPartSchemas["tool-timing"].safeParse({ toolCallId: "call_1", startedAt: 1000, completedAt: "1500" }).success).toBe(false);
  });
});

describe("validateSessionMessages() — data-tool-timing deep validation (ai's validateUIMessages(), state.ts 头注释「恢复校验的深层通路」)", () => {
  /**
   * `validState`（本文件顶部，已知能通过 `sessionStateSchema` 的浅层校验）
   * 的第三条消息本身就带一个合法的 output-available 工具部件——复用这个真实
   * 消息骨架，只在它的 `parts` 末尾追加一个 `data-tool-timing` 部件，而不是
   * 从零手搭一整条消息去猜 ai 的深层校验对其它字段的具体要求。返回
   * `unknown[]`（不是 `NimboUIMessage[]`）——`validateSessionMessages(raw:
   * unknown)` 本就接受 `unknown`，这里刻意不需要给 `data` 字段做任何类型断言
   * 就能构造出"结构基本合法，只有这一个 data 部件可能不合法"的输入。
   */
  function messagesWithTimingData(data: object): unknown[] {
    const [system, user, assistant] = validState.messages;
    return [
      system,
      user,
      { ...assistant, parts: [...(assistant?.parts ?? []), { type: "data-tool-timing", id: "call_1", data }] },
    ];
  }

  it("accepts a data-tool-timing part with only startedAt", async () => {
    const messages = await validateSessionMessages(messagesWithTimingData({ toolCallId: "call_1", startedAt: 1000 }));
    expect(messages).toHaveLength(3);
  });

  it("accepts a data-tool-timing part with both startedAt and completedAt", async () => {
    const messages = await validateSessionMessages(
      messagesWithTimingData({ toolCallId: "call_1", startedAt: 1000, completedAt: 1500 }),
    );
    expect(messages).toHaveLength(3);
  });

  it("rejects (reject()s the promise) when the data-tool-timing part is missing startedAt", async () => {
    await expect(validateSessionMessages(messagesWithTimingData({ toolCallId: "call_1", completedAt: 1500 }))).rejects.toThrow();
  });

  it("rejects when startedAt is not a number", async () => {
    await expect(
      validateSessionMessages(messagesWithTimingData({ toolCallId: "call_1", startedAt: "not-a-number" })),
    ).rejects.toThrow();
  });
});
