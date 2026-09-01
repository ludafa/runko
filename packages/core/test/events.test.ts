import { describe, expect, it } from "vitest";
import { nimboMessageMetadataSchema } from "../src/state.js";
import type { NimboChunk, NimboDataParts, NimboMessageMetadata } from "../src/state.js";
import type { NimboError, Usage } from "../src/events.js";

/**
 * 编译期穷尽性断言（docs/tech/single-ledger.md §5 单-2 工单原文
 * "改写为对 NimboChunk/NimboDataParts/NimboMessageMetadata 的等价穷尽性检查，
 * 保持漏成员编译即炸的防线精神"）：只要下面任一 switch 漏了一个变体，
 * default 分支里的实参类型就不再是 never，`pnpm typecheck` 直接编译失败。
 */
function assertNever(x: never): never {
  throw new Error(`unreachable variant: ${JSON.stringify(x)}`);
}

/** 穷尽 `NimboChunk`（ai 的 `UIMessageChunk` 词汇表，对 `NimboUIMessage` 实例化）的全部 32 个 `type` 判别值（含 chat 可观测性新增的 `data-tool-timing`）。 */
function describeChunk(chunk: NimboChunk): string {
  switch (chunk.type) {
    case "text-start":
      return `text-start:${chunk.id}`;
    case "text-delta":
      return `text-delta:${chunk.id}:${chunk.delta}`;
    case "text-end":
      return `text-end:${chunk.id}`;
    case "reasoning-start":
      return `reasoning-start:${chunk.id}`;
    case "reasoning-delta":
      return `reasoning-delta:${chunk.id}:${chunk.delta}`;
    case "reasoning-end":
      return `reasoning-end:${chunk.id}`;
    case "custom":
      return `custom:${chunk.kind}`;
    case "error":
      return `error:${chunk.errorText}`;
    case "tool-input-available":
      return `tool-input-available:${chunk.toolCallId}:${chunk.toolName}`;
    case "tool-input-error":
      return `tool-input-error:${chunk.toolCallId}:${chunk.errorText}`;
    case "tool-approval-request":
      return `tool-approval-request:${chunk.approvalId}:${chunk.toolCallId}`;
    case "tool-approval-response":
      return `tool-approval-response:${chunk.approvalId}:${String(chunk.approved)}`;
    case "tool-output-available":
      return `tool-output-available:${chunk.toolCallId}`;
    case "tool-output-error":
      return `tool-output-error:${chunk.toolCallId}:${chunk.errorText}`;
    case "tool-output-denied":
      return `tool-output-denied:${chunk.toolCallId}`;
    case "tool-input-start":
      return `tool-input-start:${chunk.toolCallId}:${chunk.toolName}`;
    case "tool-input-delta":
      return `tool-input-delta:${chunk.toolCallId}:${chunk.inputTextDelta}`;
    case "source-url":
      return `source-url:${chunk.sourceId}`;
    case "source-document":
      return `source-document:${chunk.sourceId}`;
    case "file":
      return `file:${chunk.url}`;
    case "reasoning-file":
      return `reasoning-file:${chunk.url}`;
    case "data-file-change":
      return `data-file-change:${chunk.data.changes.length}`;
    case "data-plan-update":
      return `data-plan-update:${chunk.data.items.length}`;
    case "data-error":
      return `data-error:${chunk.data.message}`;
    case "data-tool-progress":
      return `data-tool-progress:${chunk.data.toolCallId}:${chunk.data.text}:transient=${String(chunk.transient)}`;
    case "data-tool-timing":
      return `data-tool-timing:${chunk.data.toolCallId}:${String(chunk.data.completedAt !== undefined)}`;
    case "start-step":
      return "start-step";
    case "finish-step":
      return "finish-step";
    case "start":
      return `start:${chunk.messageId ?? ""}`;
    case "finish":
      return `finish:${chunk.finishReason ?? ""}`;
    case "abort":
      return `abort:${chunk.reason ?? ""}`;
    case "message-metadata":
      return `message-metadata:${chunk.messageMetadata.status ?? ""}`;
    default:
      return assertNever(chunk);
  }
}

describe("NimboChunk", () => {
  it("covers all 31 UIMessageChunk variants exhaustively (docs/tech/single-ledger.md §5-2)", () => {
    const chunks: NimboChunk[] = [
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "hi" },
      { type: "text-end", id: "t1" },
      { type: "reasoning-start", id: "r1" },
      { type: "reasoning-delta", id: "r1", delta: "thinking" },
      { type: "reasoning-end", id: "r1" },
      { type: "custom", kind: "provider.thing" },
      { type: "error", errorText: "boom" },
      { type: "tool-input-available", toolCallId: "call_1", toolName: "bash", input: { command: "ls" } },
      { type: "tool-input-error", toolCallId: "call_2", toolName: "bash", input: null, errorText: "malformed" },
      { type: "tool-approval-request", approvalId: "call_3", toolCallId: "call_3" },
      { type: "tool-approval-response", approvalId: "call_3", approved: false, reason: "denied by policy" },
      { type: "tool-output-available", toolCallId: "call_1", output: "ok" },
      { type: "tool-output-error", toolCallId: "call_4", errorText: "failed" },
      { type: "tool-output-denied", toolCallId: "call_3" },
      { type: "tool-input-start", toolCallId: "call_5", toolName: "read-file" },
      { type: "tool-input-delta", toolCallId: "call_5", inputTextDelta: '{"path":' },
      { type: "source-url", sourceId: "src_1", url: "https://example.com" },
      { type: "source-document", sourceId: "src_2", mediaType: "application/pdf", title: "doc" },
      { type: "file", url: "data:text/plain;base64,aGk=", mediaType: "text/plain" },
      { type: "reasoning-file", url: "data:text/plain;base64,aGk=", mediaType: "text/plain" },
      { type: "data-file-change", id: "fc_1", data: { changes: [{ path: "a.txt", kind: "add" }] } },
      { type: "data-plan-update", id: "plan-update", data: { items: [{ text: "step 1", completed: true }] } },
      { type: "data-error", id: "err_1", data: { message: "non-fatal" } },
      {
        type: "data-tool-progress",
        id: "call_5",
        data: { toolCallId: "call_5", text: "50%" },
        transient: true,
      },
      { type: "data-tool-timing", id: "call_1", data: { toolCallId: "call_1", startedAt: 1_700_000_000_000, completedAt: 1_700_000_000_500 } },
      { type: "start-step" },
      { type: "finish-step" },
      { type: "start", messageId: "msg_1" },
      { type: "finish", finishReason: "stop" },
      { type: "abort", reason: "signal aborted" },
      { type: "message-metadata", messageMetadata: { turn: 1, status: "completed" } },
    ];

    expect(chunks.map(describeChunk)).toEqual([
      "text-start:t1",
      "text-delta:t1:hi",
      "text-end:t1",
      "reasoning-start:r1",
      "reasoning-delta:r1:thinking",
      "reasoning-end:r1",
      "custom:provider.thing",
      "error:boom",
      "tool-input-available:call_1:bash",
      "tool-input-error:call_2:malformed",
      "tool-approval-request:call_3:call_3",
      "tool-approval-response:call_3:false",
      "tool-output-available:call_1",
      "tool-output-error:call_4:failed",
      "tool-output-denied:call_3",
      "tool-input-start:call_5:read-file",
      'tool-input-delta:call_5:{"path":',
      "source-url:src_1",
      "source-document:src_2",
      "file:data:text/plain;base64,aGk=",
      "reasoning-file:data:text/plain;base64,aGk=",
      "data-file-change:1",
      "data-plan-update:1",
      "data-error:non-fatal",
      "data-tool-progress:call_5:50%:transient=true",
      "data-tool-timing:call_1:true",
      "start-step",
      "finish-step",
      "start:msg_1",
      "finish:stop",
      "abort:signal aborted",
      "message-metadata:completed",
    ]);
  });
});

/**
 * 穷尽 `NimboDataParts` 的全部五个 data 部件名（docs/tech/single-ledger.md
 * §2.2b：`tool-progress` 是 transient；`tool-timing` 是 chat 可观测性新增的
 * **持久**部件，与 `tool-progress` 相反——见 state.ts 头注释）。
 */
function describeDataPartName(name: keyof NimboDataParts): string {
  switch (name) {
    case "file-change":
      return "file-change";
    case "plan-update":
      return "plan-update";
    case "error":
      return "error";
    case "tool-progress":
      return "tool-progress";
    case "tool-timing":
      return "tool-timing";
    default:
      return assertNever(name);
  }
}

describe("NimboDataParts", () => {
  it("covers all five data part names exhaustively", () => {
    const names: (keyof NimboDataParts)[] = ["file-change", "plan-update", "error", "tool-progress", "tool-timing"];
    expect(names.map(describeDataPartName)).toEqual(["file-change", "plan-update", "error", "tool-progress", "tool-timing"]);
  });
});

/**
 * 穷尽 `NimboMessageMetadata.status` 的四态（`interrupted` 对应 `NimboError.code === "aborted"`，
 * loop.ts 的 `statusForError`）。
 *
 * `suspended` 目前**只有类型、没有产出方**——它是[挂起](../../../docs/architecture/tech/agent-kernel.md)
 * 的收尾态，等 K3 落地才会真的被写出来（`finalizeTurn` 的 `status` 参数至今仍是三值联合）。
 * 先进联合类型是为了让宿主/界面提前占好渲染分支。这条穷尽性测试保证它别被遗漏。
 */
function describeStatus(status: NonNullable<NimboMessageMetadata["status"]>): string {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "interrupted":
      return "interrupted";
    case "suspended":
      return "suspended";
    default:
      return assertNever(status);
  }
}

describe("NimboMessageMetadata.status", () => {
  it("covers completed/failed/interrupted/suspended exhaustively", () => {
    const statuses: NonNullable<NimboMessageMetadata["status"]>[] = [
      "completed",
      "failed",
      "interrupted",
      "suspended",
    ];
    expect(statuses.map(describeStatus)).toEqual(["completed", "failed", "interrupted", "suspended"]);
  });

  it("schema 也认 suspended（类型与 zod 两处不能漂）", () => {
    expect(nimboMessageMetadataSchema.safeParse({ status: "suspended" }).success).toBe(true);
    expect(nimboMessageMetadataSchema.safeParse({ status: "nope" }).success).toBe(false);
  });
});

/** 穷尽 `NimboError.code` 的四个错误码。 */
function describeErrorCode(code: NimboError["code"]): string {
  switch (code) {
    case "max_turns":
      return "max_turns";
    case "context_overflow":
      return "context_overflow";
    case "provider_error":
      return "provider_error";
    case "aborted":
      return "aborted";
    default:
      return assertNever(code);
  }
}

describe("NimboError.code", () => {
  it("only allows the four defined error codes", () => {
    const codes: NimboError["code"][] = ["max_turns", "context_overflow", "provider_error", "aborted"];
    expect(codes.map(describeErrorCode)).toEqual(["max_turns", "context_overflow", "provider_error", "aborted"]);
  });
});

describe("Usage", () => {
  it("allows every token field to be absent", () => {
    const usage: Usage = {};
    expect(usage.totalTokens).toBeUndefined();
  });
});
