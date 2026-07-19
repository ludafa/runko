/**
 * single-ledger 的 convertToModelMessages 结构语义（离线、无凭证、进 CI）。
 *
 * 迁移自 examples/13-uimessage-single-ledger.e2e.test.ts 的**离线段**
 * （docs/tech/single-ledger.md §2.2/§2.4）：nimbo 的 loop 用「UIMessage 数组」
 * 做工作状态与唯一存档，每次调模型前用 AI SDK 官方 `convertToModelMessages()`
 * 现场推导 `ModelMessage[]`。本文件手工构造一组覆盖 §2.2 全部部件形态的
 * UIMessage 数组，断言转换器的结构语义：
 *   1. 输出不含任何 data-* 部件，且各 data 部件的专属标记不泄漏进模型可见内容
 *      （唯一例外 denyReason——它走 tool-result 的 errorText，是拒绝语义要保留的）；
 *   2. `assistant(含 tool-call) → tool(结果)` 的分组顺序；
 *   3. transient 部件在写入期就被分流、绝不进落盘存档（见下方 emitTransientDataPart 注释）。
 *
 * 说明：原 examples/13 还有一段「真机段」——手写一个 single-ledger loop 跑真实
 * DeepSeek、验证设计可行（推理往返/前缀缓存/多步等价等）。那是一次性的设计验证
 * 实验、CI 永远无凭证可跑，未随迁；如需查阅见 git 历史的
 * examples/13-uimessage-single-ledger.e2e.test.ts。single-ledger 的生产实现在
 * packages/core（loop.ts/session.ts/state.ts），server 是其 chunk 流的下游消费者。
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { convertToModelMessages } from "ai";
import type { DataUIPart, ModelMessage, UIMessage } from "ai";

// ---------------------------------------------------------------------------
// 账本类型系统 —— docs/tech/single-ledger.md §2.2 的六个 data 部件 + 四个 kebab-case
// 工具 + 消息 metadata，全部经 zod 推导（z.infer），是落盘/读回的唯一定义。
// ---------------------------------------------------------------------------

const approvalDataSchema = z.object({
  id: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  status: z.enum(["pending", "allowed", "denied", "timeout"]),
  message: z.string().optional(),
  input: z.unknown(),
});
type ApprovalData = z.infer<typeof approvalDataSchema>;

const fileChangeDataSchema = z.object({
  changes: z.array(z.object({ path: z.string(), kind: z.enum(["add", "update", "delete"]) })),
});
type FileChangeData = z.infer<typeof fileChangeDataSchema>;

const planUpdateDataSchema = z.object({
  items: z.array(z.object({ text: z.string(), completed: z.boolean() })),
});
type PlanUpdateData = z.infer<typeof planUpdateDataSchema>;

const errorDataSchema = z.object({ message: z.string() });
type ErrorData = z.infer<typeof errorDataSchema>;

const sandboxDataSchema = z.object({
  event: z.literal("recreated"),
  recovery: z.enum(["wip", "branch", "fresh"]),
  checkpointTurn: z.number().optional(),
  stateTurn: z.number().optional(),
});
type SandboxData = z.infer<typeof sandboxDataSchema>;

const toolProgressDataSchema = z.object({ toolCallId: z.string(), text: z.string() });
type ToolProgressData = z.infer<typeof toolProgressDataSchema>;

/** §2.2b 的六个 data 部件——键是 `data-` 前缀之后的那一半（`DataUIPart` 按此拼出 `type: "data-${NAME}"`）。 */
type LedgerDataParts = {
  approval: ApprovalData;
  "file-change": FileChangeData;
  "plan-update": PlanUpdateData;
  error: ErrorData;
  sandbox: SandboxData;
  "tool-progress": ToolProgressData;
};

const bashInputSchema = z.object({ command: z.string() });
const readFileInputSchema = z.object({ path: z.string() });
const writeFileInputSchema = z.object({ path: z.string(), content: z.string() });
const askUserInputSchema = z.object({ question: z.string() });

type BashInput = z.infer<typeof bashInputSchema>;
type ReadFileInput = z.infer<typeof readFileInputSchema>;
type WriteFileInput = z.infer<typeof writeFileInputSchema>;
type AskUserInput = z.infer<typeof askUserInputSchema>;

/** 四个 kebab-case 工具（§2.2 命名约定：`ask-user`/`read-file`/`write-file`，`bash` 无分隔符）。 */
type LedgerTools = {
  bash: { input: BashInput; output: string };
  "read-file": { input: ReadFileInput; output: string };
  "write-file": { input: WriteFileInput; output: string };
  "ask-user": { input: AskUserInput; output: string };
};

const usageSnapshotSchema = z.object({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  totalTokens: z.number().optional(),
  cachedInputTokens: z.number().optional(),
});

/** §2.2a：「turn 收尾」与「steer」都落在消息 metadata（转换器不看 metadata，天然只给界面）。 */
const ledgerMetadataSchema = z.object({
  steered: z.boolean().optional(),
  status: z.enum(["completed", "failed", "interrupted"]).optional(),
  finishReason: z.string().optional(),
  usage: usageSnapshotSchema.optional(),
});
type LedgerMessageMetadata = z.infer<typeof ledgerMetadataSchema>;

type LedgerUIMessage = UIMessage<LedgerMessageMetadata, LedgerDataParts, LedgerTools>;

// ---------------------------------------------------------------------------
// 账本写入纪律 —— upsertDataPart（非 transient，同 id 覆盖）/ emitTransientDataPart
// （transient，只走 live 回调、永不 touch 任何 UIMessage.parts）。
// ---------------------------------------------------------------------------

type DataPartName = keyof LedgerDataParts & string;

/**
 * 唯一的类型逃逸点（隔离于此，一处）：把 `(name, id, data)` 三元组拼成
 * `DataUIPart<LedgerDataParts>` 的某个具体成员。TS 的结构检查器无法验证「泛型 NAME
 * 与同一 NAME 索引出的 data 字段彼此对应」（已知的 correlated-union 编译器限制，
 * 见 microsoft/TypeScript#30581 一类讨论），不是可用类型守卫绕开的运行时判断；按下面
 * 两个调用方的实际调用方式，`name`/`data` 恒来自同一泛型实参，运行时恒成立。
 */
function buildDataPart<NAME extends DataPartName>(
  name: NAME,
  id: string,
  data: LedgerDataParts[NAME],
): DataUIPart<LedgerDataParts> {
  const part = { type: `data-${name}`, id, data };
  return part as DataUIPart<LedgerDataParts>;
}

/** 非 transient 的 data 部件：按 `type + id` 在目标消息的 `parts` 里原地覆盖，否则追加（§2.2b「同 id 更新」）。 */
function upsertDataPart<NAME extends DataPartName>(
  message: LedgerUIMessage,
  name: NAME,
  id: string,
  data: LedgerDataParts[NAME],
): void {
  const partType = `data-${name}`;
  const existingIndex = message.parts.findIndex((part) => part.type === partType && "id" in part && part.id === id);
  const nextPart = buildDataPart(name, id, data);
  if (existingIndex === -1) {
    message.parts.push(nextPart);
  } else {
    message.parts[existingIndex] = nextPart;
  }
}

/**
 * transient 的 data 部件：只调用 `onLive`，从不出现在任何 `UIMessage.parts` 里，也就
 * 永不被落盘——复刻 ai 自己 `processUIMessageStream` 的写入期判断（源码注释原文：
 * "transient parts are not added to the message state"），不是「写了再删」：ai@7 的
 * `DataUIPart` 类型本身没有 transient 字段，transient 只是线协议 `UIMessageChunk` 上的
 * 属性，账本里根本没有字段可供事后过滤，必须在写入那一刻分流。
 */
function emitTransientDataPart<NAME extends DataPartName>(
  name: NAME,
  id: string,
  data: LedgerDataParts[NAME],
  onLive: (chunk: DataUIPart<LedgerDataParts>) => void,
): void {
  onLive(buildDataPart(name, id, data));
}

// ---------------------------------------------------------------------------
// 结构摘要小工具。
// ---------------------------------------------------------------------------

interface RawMessageSummary {
  role: string;
  partTypes: string[];
}

function summarizeModelMessage(message: ModelMessage): RawMessageSummary {
  if (typeof message.content === "string") return { role: message.role, partTypes: ["text"] };
  const parts: ReadonlyArray<{ type: string }> = message.content;
  return { role: message.role, partTypes: parts.map((part) => part.type) };
}

function summarizeModelMessages(messages: ModelMessage[]): RawMessageSummary[] {
  return messages.map(summarizeModelMessage);
}

// ---------------------------------------------------------------------------
// 只出现在各自 data 部件里、不该泄漏进模型可见内容的标记（denyReason 除外——它走
// output-error 的 errorText，理应出现在模型可见的 tool-result 里）。
// ---------------------------------------------------------------------------

const MARKER = {
  approvalMessage: "MARKER_APPROVAL_MESSAGE_ONLY_IN_DATA_PART",
  denyReason: "MARKER_DENY_REASON_VISIBLE_TO_MODEL_VIA_TOOL_RESULT",
  fileChangePath: "/__marker_file_change_only__.txt",
  planItemText: "MARKER_PLAN_ITEM_ONLY_IN_DATA_PART",
  progressText: "MARKER_TOOL_PROGRESS_ONLY_IN_DATA_PART",
  errorMessage: "MARKER_ERROR_MESSAGE_ONLY_IN_DATA_PART",
  sandboxCheckpointTurn: 918273645,
} as const;

/**
 * 覆盖 §2.2 全部部件形态：六个 data 部件（含概念上 transient 的 data-tool-progress——
 * 这里放进数组只为证明「即便出现在数组里，转换器也照样丢弃」，真正的写入纪律见
 * transient 那条测试）、tool-bash/tool-ask-user（output-available 与 output-error
 * 两种终态）、reasoning、两个 step-start、assistant metadata、steer 用户消息 metadata。
 */
function buildOfflineFixture(): LedgerUIMessage[] {
  const userMessage: LedgerUIMessage = {
    id: "u1",
    role: "user",
    parts: [{ type: "text", text: "帮我看一下这个仓库，需要的话可以执行命令、读写文件。" }],
  };

  const assistantMessage: LedgerUIMessage = {
    id: "a1",
    role: "assistant",
    parts: [
      { type: "step-start" },
      { type: "reasoning", text: "先看看目录结构，再决定要不要跑命令。", state: "done" },
      { type: "text", text: "我先看一眼目录。", state: "done" },
      {
        type: "tool-bash",
        toolCallId: "call_1",
        state: "output-available",
        input: { command: "ls" },
        output: "README.md\nsrc/\n",
      },
      { type: "data-file-change", id: "fc1", data: { changes: [{ path: MARKER.fileChangePath, kind: "add" }] } },
      { type: "data-plan-update", id: "plan1", data: { items: [{ text: MARKER.planItemText, completed: false }] } },
      { type: "data-tool-progress", id: "call_1", data: { toolCallId: "call_1", text: MARKER.progressText } },
      { type: "step-start" },
      {
        type: "tool-ask-user",
        toolCallId: "call_2",
        state: "output-available",
        input: { question: "要不要顺便清一下缓存？" },
        output: "好，顺便清一下。",
      },
      {
        type: "tool-bash",
        toolCallId: "call_3",
        state: "output-error",
        input: { command: "rm -rf /" },
        errorText: MARKER.denyReason,
      },
      {
        type: "data-approval",
        id: "call_3",
        data: {
          id: "call_3",
          toolCallId: "call_3",
          toolName: "bash",
          status: "denied",
          message: MARKER.approvalMessage,
          input: { command: "rm -rf /" },
        },
      },
      { type: "data-error", data: { message: MARKER.errorMessage } },
      { type: "data-sandbox", data: { event: "recreated", recovery: "wip", checkpointTurn: MARKER.sandboxCheckpointTurn } },
    ],
    metadata: {
      status: "completed",
      finishReason: "stop",
      usage: { inputTokens: 120, outputTokens: 48, totalTokens: 168, cachedInputTokens: 32 },
    },
  };

  const steerMessage: LedgerUIMessage = {
    id: "u2",
    role: "user",
    parts: [{ type: "text", text: "（插话）等等，先别删任何东西。" }],
    metadata: { steered: true },
  };

  return [userMessage, assistantMessage, steerMessage];
}

describe("single-ledger：convertToModelMessages 的结构语义（离线、无凭证）", () => {
  it("丢弃全部 data-* 部件；data 专属标记不泄漏（denyReason 例外，走 tool-result errorText）", async () => {
    const modelMessages = await convertToModelMessages(buildOfflineFixture());
    const serialized = JSON.stringify(modelMessages);

    for (const message of modelMessages) {
      if (typeof message.content === "string") continue;
      for (const content of message.content) {
        expect(content.type.startsWith("data-"), `不应含 data-* 部件，实际发现 ${content.type}`).toBe(false);
      }
    }

    for (const [name, marker] of Object.entries(MARKER)) {
      if (name === "denyReason") continue; // denyReason 走 output-error 的 errorText，理应对模型可见
      expect(serialized.includes(String(marker)), `data 专属标记 "${String(marker)}"（来自 ${name}）不应出现在 ModelMessage 里`).toBe(false);
    }
    expect(serialized.includes(MARKER.denyReason), "拒绝理由（errorText）应照常出现在 tool-result 里").toBe(true);
  });

  it("每条 tool 消息前紧跟一条含 tool-call 部件的 assistant 消息（分组顺序）", async () => {
    const modelMessages = await convertToModelMessages(buildOfflineFixture());
    const summaries = summarizeModelMessages(modelMessages);

    for (const [i, current] of summaries.entries()) {
      if (current.role !== "tool") continue;
      const previous = i > 0 ? summaries.at(i - 1) : undefined;
      expect(previous, `tool 消息（第 ${String(i)} 条）之前必须有一条消息`).toBeDefined();
      expect(previous?.role, `tool 消息之前必须紧跟 assistant`).toBe("assistant");
      expect(previous?.partTypes.includes("tool-call"), "tool 消息之前的 assistant 必须含 tool-call 部件").toBe(true);
    }
  });

  it("transient 部件不进落盘存档；非 transient 的 data 部件正常进存档", () => {
    const message: LedgerUIMessage = { id: "demo-msg", role: "assistant", parts: [{ type: "step-start" }] };
    const liveOnly: DataUIPart<LedgerDataParts>[] = [];

    // 非 transient：走 upsertDataPart，真的进账本。
    upsertDataPart(message, "plan-update", "plan-demo", { items: [{ text: "demo", completed: false }] });
    // transient：只走 emitTransientDataPart 的 onLive 回调，从不触碰 message.parts。
    emitTransientDataPart(
      "tool-progress",
      "call-demo",
      { toolCallId: "call-demo", text: MARKER.progressText },
      (chunk) => liveOnly.push(chunk),
    );

    const serialized = JSON.stringify(message);
    expect(message.parts.some((p) => p.type === "data-tool-progress"), "transient 部件不应出现在账本消息的 parts 里").toBe(false);
    expect(serialized.includes(MARKER.progressText), "transient 部件的 payload 不应出现在序列化后的账本 JSON 里").toBe(false);
    expect(liveOnly.length, "transient 部件应恰好被 live 回调收到一次").toBe(1);
    expect(message.parts.some((p) => p.type === "data-plan-update"), "非 transient 的 data 部件应正常进账本").toBe(true);
  });
});
