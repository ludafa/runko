/**
 * 13-uimessage-single-ledger — P13-5a-1，docs/tech/single-ledger.md
 * 的验证实验：nimbo 的 loop 改用「UIMessage 数组」做工作状态与唯一存档，
 * 每次调模型前用 AI SDK 官方 `convertToModelMessages()` 现场推导
 * `ModelMessage[]`，从此系统只有一种落盘数据。本文件不动 packages/*——
 * 直接用 `ai` 包（`streamText` + `convertToModelMessages` + `UIMessage`
 * 类型）手写一个最小 loop，复刻 docs/tech/single-ledger.md §2.1 点名的全部关键语义（工具声明
 * 不带 execute、一次审批 deny、一次 ask-user、一次 steer、每轮落盘、恢复
 * 路径、请求体取证）。
 *
 * ---- 文件命名 / 运行方式（同 examples/12 的既有约定，不复述其证明） ----
 *
 * `.e2e.test.ts` 只是文件名（docs/tech/single-ledger.md §3 P13-5a-1 工单原文指定），不是
 * vitest 用例——examples/ 不是 pnpm workspace 成员、也不在根 vitest.config.ts
 * 的 `test.projects` 里，`pnpm -r test`/`pnpm coverage` 都不会发现它。
 *
 *   node examples/13-uimessage-single-ledger.e2e.test.ts
 *
 * 类型检查：`node examples/typecheck.mjs`（等价于
 * `tsc -p examples/tsconfig.json --noEmit`，运行前需要先
 * `pnpm -r build && node examples/setup-node-modules.mjs`）。
 *
 * ---- 两段结构 ----
 *
 * 1. **离线段**（`offlineSection()`）：无凭证也能跑，手工构造一组覆盖
 *    docs/tech/single-ledger.md §2.2 全部部件形态的 UIMessage 数组（六个 data 部件、transient
 *    的 `data-tool-progress`、`tool-bash`/`tool-ask-user` 等工具部件、
 *    reasoning、两个 step-start、metadata），用 `node:assert` 断言：
 *      (a) `convertToModelMessages()` 的输出不含任何 data 部件内容；
 *      (b) 「transient 部件不进落盘存档」这条 ai@7 语义（见下方"发现 A"）；
 *      (c) 打印转换后的消息结构快照供人工比对多步分组。
 *    任何一条断言失败，`node:assert` 直接抛出，进程以非零退出码结束——
 *    这就是"进程退出码体现断言结果"的落实方式，不需要额外的 try/catch。
 *
 * 2. **真机段**（`realMachineSection()`）：沿 examples/12 的门控写法——
 *    只看 DeepSeek 凭证（`DEEPSEEK_API_BASE_URL`/`DEEPSEEK_API_TOKEN`，
 *    经 examples/shared 同款的 `loadRootDotEnv()`），缺失就打印指引后
 *    `return`（不崩溃、不用 `process.exit`，让脚本自然跑到底后以 0 退出，
 *    同 examples/12 的 `realProjectSection()` gate 写法）。工具集全部
 *    kebab-case、脚本化假实现（`bash`/`read-file`/`write-file`/
 *    `ask-user`），不需要真沙盒；`tools` 声明省略 `execute`（docs/02
 *    §4.3 手动 loop 姿态，同 `packages/core/src/model/step.ts`/
 *    `convert.ts` 的既有手法），loop 自己在 `runOneStep()` 里执行工具、
 *    写回 UIMessage 部件；每步调模型前都用 `convertToModelMessages(全量
 *    UIMessage 数组)` 现场推导，不手拼任何 ModelMessage。跑完两轮后打印
 *    docs/tech/single-ledger.md §2.4 五项验证的逐项判定。
 *
 * ---- 实现中发现的、docs/tech/single-ledger.md 撰写时未必知道的 ai@7.0.20 API 细节 ----
 *
 * **发现 A（transient 语义的真实落点）**：docs/tech/single-ledger.md §2.2b 把
 * `data-tool-progress` 描述成"transient 的 data 部件"，读起来像是
 * `UIMessage.parts` 里会有一个带 `transient: true` 标记的部件、落盘前再
 * 过滤掉。实测 ai@7.0.20 并非如此：`DataUIPart`（`UIMessage.parts` 里存的
 * 那个类型）根本没有 `transient` 字段（`ai/dist/index.d.ts` 里
 * `DataUIPart<DATA_TYPES>` 只有 `type`/`id?`/`data`）——`transient` 只存在于
 * *线协议* 层（`UIMessageChunk` 的 `transient?: boolean`），由 ai 自己的
 * 流处理器（source map 注释原文："transient parts are not added to the
 * message state"）在**写入的那一刻**直接跳过、根本不追加进
 * `state.message.parts`，而不是"先追加、序列化前再挑出来过滤"。也就是说
 * 落盘数组里从一开始就不存在可供"事后过滤"的字段——nimbo 的账本要做到同样
 * 的效果，必须在写入那一刻分流（本文件 `emitTransientDataPart()` 就是复刻
 * 这个写入期判断），而不是"先存后滤"。`demonstrateTransientDiscipline()`
 * 里对此有可运行的断言 + 详细 console 输出。
 *
 * **发现 B（ai@7 有一套 docs/tech/single-ledger.md 未提及的原生审批状态机）**：ai@7.0.20 的
 * `ToolUIPart`/`ModelMessage` 已经原生支持
 * `approval-requested`/`approval-responded`/`output-denied` 三个状态
 * （对应 `tool-approval-request`/`tool-approval-response` 两个 ModelMessage
 * part 类型），`convertToModelMessages()` 对 `output-denied` 状态会生成
 * `{ type: "error-text", value: approval.reason }` 的 tool-result——这是一套
 * 与 docs/tech/single-ledger.md §2.2a"denied 状态用 output-error + errorText + 伴随
 * data-approval"完全不同的官方机制。docs/tech/single-ledger.md 的方案早于（或独立于）这套原生
 * 状态机成型，两者都能达到"模型看到拒绝理由"的效果。本工单的工单原文明确
 * 要求按 docs/tech/single-ledger.md 字面（output-error + errorText + data-approval）实现，
 * 本文件照办，此处只如实记录这个可选的替代方案供 P13-5 立项时参考。
 *
 * **发现 C（"多步等价"要看的层次不是 provider 的线上 JSON）**：真机实测中，
 * 若直接拿 DeepSeek 收到的原始请求体（`req-<n>.json`，OpenAI 兼容格式）按
 * "content 数组里找 `{type:"tool-call"}`/`{type:"tool-result"}`" 的方式做结构
 * 校验会失败——DeepSeek 的线上 JSON 里，工具调用是 assistant 消息上一个独立的
 * 顶层 `tool_calls` 字段，工具结果是 `role:"tool"` 消息里按 `tool_call_id`
 * 关联的纯字符串 `content`，根本不是 `ModelMessage.content` 那种"每个 part 带
 * `type` 字段"的数组形状。这层转译正是 AI SDK 要抽象掉的 provider 差异——
 * "多步等价"验证的是 `convertToModelMessages()` 输出的 `ModelMessage[]`
 * 这一层（`runOneStep()` 发给 `streamText()` 之前的那个数组，见
 * `StepOutcome.requestMessages`），不是任何一个 provider 的线上字节形状；
 * 只有"前缀缓存"（验证项 4）才真的需要看线上字节，因为那是 provider 缓存
 * 命中与否的实际判据。`printVerificationReport()` 的验证项 3/4 分别对应这
 * 两个不同的层次，注释里各自点明。
 *
 * ---- 请求体取证 ----
 *
 * 模型经 `createDeepSeek({ fetch })` 注入一个自定义 fetch（见
 * `createRequestCapture()`）：每次发给 DeepSeek 的原始请求体（JSON 解析后
 * 的 `messages` 数组）原样落盘到
 * `.tmp/13-uimessage-ledger/run-<时间戳>/requests/req-<n>.json`，HTTP 状态码
 * 一并记录；这是"前缀缓存"（逐字节对比 messages 前缀）与"推理往返"（看历史
 * reasoning 是否原样出现在下一轮请求体里）两项验证的取证来源。
 */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createDeepSeek } from "@ai-sdk/deepseek";
import {
  convertToModelMessages,
  streamText,
  tool,
  validateUIMessages,
} from "ai";
import type {
  DataUIPart,
  FinishReason,
  LanguageModel,
  LanguageModelUsage,
  ModelMessage,
  ProviderMetadata,
  ReasoningUIPart,
  TextUIPart,
  ToolResultPart,
  TypedToolCall,
  UIMessage,
  UIMessagePart,
} from "ai";

// ============================================================================
// 0. 账本的类型系统 —— docs/tech/single-ledger.md §2.2 的六个 data 部件 + 四个 kebab-case 工具 +
//    消息 metadata，全部经 zod 推导（z.infer），落盘/读回都靠这份唯一定义。
// ============================================================================

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

/** docs/tech/single-ledger.md §2.2b 的六个 data 部件——键是 `data-` 前缀之后的那一半（`DataUIPart` 按此拼出 `type: "data-${NAME}"`）。 */
type LedgerDataParts = {
  approval: ApprovalData;
  "file-change": FileChangeData;
  "plan-update": PlanUpdateData;
  error: ErrorData;
  sandbox: SandboxData;
  "tool-progress": ToolProgressData;
};

const bashInputSchema = z.object({ command: z.string().describe("要在假环境里执行的 shell 命令") });
const readFileInputSchema = z.object({ path: z.string().describe("要读取的虚拟文件路径") });
const writeFileInputSchema = z.object({
  path: z.string().describe("要写入的虚拟文件路径"),
  content: z.string().describe("写入后的完整文件内容"),
});
const askUserInputSchema = z.object({ question: z.string().describe("要问人类的问题") });

type BashInput = z.infer<typeof bashInputSchema>;
type ReadFileInput = z.infer<typeof readFileInputSchema>;
type WriteFileInput = z.infer<typeof writeFileInputSchema>;
type AskUserInput = z.infer<typeof askUserInputSchema>;

/** 四个 kebab-case 工具（docs/tech/single-ledger.md §2.2 命名约定：`ask-user`/`read-file`/`write-file`，`bash` 无分隔符不受影响）。 */
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

/** docs/tech/single-ledger.md §2.2a："turn 收尾"与"steer"都落在消息 metadata（转换器不看 metadata，天然只给界面）。 */
const ledgerMetadataSchema = z.object({
  steered: z.boolean().optional(),
  status: z.enum(["completed", "failed", "interrupted"]).optional(),
  finishReason: z.string().optional(),
  usage: usageSnapshotSchema.optional(),
});
type LedgerMessageMetadata = z.infer<typeof ledgerMetadataSchema>;

type LedgerUIMessage = UIMessage<LedgerMessageMetadata, LedgerDataParts, LedgerTools>;

/** `validateUIMessages()` 恢复路径要用到——按 data 部件名索引的 zod 校验器（可选，未列出的部件名会被拒绝）。 */
const ledgerDataSchemas = {
  approval: approvalDataSchema,
  "file-change": fileChangeDataSchema,
  "plan-update": planUpdateDataSchema,
  error: errorDataSchema,
  sandbox: sandboxDataSchema,
  "tool-progress": toolProgressDataSchema,
};

/**
 * nimbo `Tool` → AI SDK `tool()`，省略 `execute`（手动 loop，docs/tech/core-sdk.md §4.3）。
 * OUTPUT 钉死为字面量 `never`、CONTEXT 钉死为 `Record<string, unknown>` 的类型论证
 * 与 `packages/core/src/model/convert.ts` 的 `convertTool()` 头注释完全相同，不在这里重复。
 */
function toolNoExecute<Input>(description: string, inputSchema: z.ZodType<Input>) {
  return tool<Input, never, Record<string, unknown>>({ description, inputSchema });
}

const modelTools = {
  bash: toolNoExecute(
    "在工作区里执行一条 shell 命令（本实验的脚本化假实现：不会真的起进程）。本轮对话里第一次调用会被审批策略拒绝，请据此调整方案，不要原样重试。",
    bashInputSchema,
  ),
  "read-file": toolNoExecute("读取内存假文件系统里的一个文件，返回其全部内容。", readFileInputSchema),
  "write-file": toolNoExecute("写入/覆盖内存假文件系统里的一个文件。", writeFileInputSchema),
  "ask-user": toolNoExecute("向人类提一个问题并等待回答；回答会作为这次调用的工具结果返回给你。", askUserInputSchema),
};

// ============================================================================
// 1. 账本写入纪律 —— upsertDataPart（非 transient，同 id 覆盖）/
//    emitTransientDataPart（transient，见文件头"发现 A"：只走 live 回调，
//    永远不touch 任何 UIMessage.parts）。离线段与真机段共用同一份实现，
//    保证两段演示的是同一套语义。
// ============================================================================

type DataPartName = keyof LedgerDataParts & string;

/**
 * 唯一的类型逃逸点（隔离于此，一处）：把 `(name, id, data)` 三元组拼成
 * `DataUIPart<LedgerDataParts>` 的某个具体成员。TS 的结构检查器无法验证
 * "泛型 NAME 与同一 NAME 索引出的 data 字段彼此对应"这件事——这是已知的编译器
 * 限制（相关背景见 microsoft/TypeScript#30581 一类的"correlated union"讨论），
 * 不是可以用类型守卫绕开的运行时判断；但按下面两个调用方（`upsertDataPart`/
 * `emitTransientDataPart`）的实际调用方式，`name`/`data` 恒来自同一个泛型
 * 实参，运行时恒成立。全文件只有这一处 `as`。
 */
function buildDataPart<NAME extends DataPartName>(
  name: NAME,
  id: string,
  data: LedgerDataParts[NAME],
): DataUIPart<LedgerDataParts> {
  const part = { type: `data-${name}`, id, data };
  return part as DataUIPart<LedgerDataParts>;
}

/** 非 transient 的 data 部件：按 `type + id` 在目标消息的 `parts` 里原地覆盖，否则追加（docs/tech/single-ledger.md §2.2b"同 id 更新"）。 */
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
 * transient 的 data 部件：只调用 `onLive`，从不出现在任何 `UIMessage.parts` 里，
 * 也就永远不会被落盘——这是复刻 ai 自己 `processUIMessageStream` 的写入期判断
 * （见文件头"发现 A"），不是"写了再删"。
 */
function emitTransientDataPart<NAME extends DataPartName>(
  name: NAME,
  id: string,
  data: LedgerDataParts[NAME],
  onLive: (chunk: DataUIPart<LedgerDataParts>) => void,
): void {
  onLive(buildDataPart(name, id, data));
}

// ============================================================================
// 2. 结构摘要 / 分组断言的共用小工具 —— 离线段（强类型 ModelMessage[]）与
//    真机段（wire 抓包回来的 unknown JSON）各有一版输入，输出同一个
//    RawMessageSummary 形状，断言逻辑只写一份。
// ============================================================================

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

/** 抓包回来的原始请求体是 `unknown` JSON——这是 JSON.parse 的序列化边界（无类型三方数据），逐层用类型守卫收窄，不用 `as`。 */
function summarizeRawMessage(message: unknown): RawMessageSummary {
  if (typeof message !== "object" || message === null) return { role: "?", partTypes: [] };
  const role = "role" in message && typeof message.role === "string" ? message.role : "?";
  if (!("content" in message)) return { role, partTypes: [] };
  const { content } = message;
  if (typeof content === "string") return { role, partTypes: ["text"] };
  if (!Array.isArray(content)) return { role, partTypes: [] };
  const partTypes = content.map((part) =>
    typeof part === "object" && part !== null && "type" in part && typeof part.type === "string" ? part.type : "?",
  );
  return { role, partTypes };
}

function summarizeRawMessages(messages: ReadonlyArray<unknown>): RawMessageSummary[] {
  return messages.map(summarizeRawMessage);
}

function formatRawMessageSummaries(summaries: RawMessageSummary[]): string {
  return summaries.map((s) => `${s.role}[${s.partTypes.join(",")}]`).join(" -> ");
}

/** docs/tech/single-ledger.md §2.4 验证项 3："assistant（含 tool-call 部件）→ tool（结果）→ …"的分组与顺序。 */
function assertAssistantToolGrouping(summaries: RawMessageSummary[]): void {
  for (const [i, current] of summaries.entries()) {
    if (current.role !== "tool") continue;
    const previous = i > 0 ? summaries.at(i - 1) : undefined;
    assert.ok(previous !== undefined, `tool 消息（第 ${String(i)} 条）之前必须有一条消息`);
    assert.equal(previous.role, "assistant", `tool 消息（第 ${String(i)} 条）之前必须紧跟 assistant 消息，实际是 "${previous.role}"`);
    assert.ok(previous.partTypes.includes("tool-call"), "tool 消息之前的 assistant 消息必须包含 tool-call 部件");
  }
}

/** 抓包请求体里是否还带着历史 reasoning 内容（docs/tech/single-ledger.md §2.4 验证项 1）。 */
function containsReasoningContent(messages: ReadonlyArray<unknown> | undefined): boolean {
  if (messages === undefined) return false;
  return messages.some((message) => {
    if (typeof message !== "object" || message === null) return false;
    if (!("content" in message) || !Array.isArray(message.content)) return false;
    return message.content.some(
      (part) => typeof part === "object" && part !== null && "type" in part && part.type === "reasoning",
    );
  });
}

// ============================================================================
// 3. 离线段 —— 无凭证也能跑，覆盖 docs/tech/single-ledger.md §2.2 全部部件形态，纯结构断言。
// ============================================================================

/** 只出现在各自 data 部件里、不该泄漏进模型可见内容的标记字符串/数字（denyReason 除外，见下方断言里的说明）。 */
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
 * 手工构造的一组 UIMessage，覆盖 docs/tech/single-ledger.md §2.2 的全部部件形态：六个 data 部件
 * （含概念上的 transient `data-tool-progress`——见文件头"发现 A"，`DataUIPart`
 * 类型本身没有 transient 字段，这里只是为了证明"即便真出现在数组里，转换器也照样
 * 丢弃"，不代表这是推荐的写入方式，真正的写入纪律见 `demonstrateTransientDiscipline()`）、
 * `tool-bash`/`tool-ask-user` 两种工具部件（含 output-available 与 output-error
 * 两种终态）、reasoning、两个 step-start（模拟两步）、assistant 消息 metadata、
 * steer 用户消息的 metadata。
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

/** docs/tech/single-ledger.md §2.4 结构断言 1："转换器输出中不含任何 data 部件"——逐部件类型检查 + 标记字符串排他性检查双重验证。 */
async function assertConverterDropsAllDataParts(fixture: LedgerUIMessage[]): Promise<ModelMessage[]> {
  const modelMessages = await convertToModelMessages(fixture);
  const serialized = JSON.stringify(modelMessages);

  for (const message of modelMessages) {
    if (typeof message.content === "string") continue;
    for (const content of message.content) {
      assert.ok(!content.type.startsWith("data-"), `convertToModelMessages 的输出不应该包含任何 data-* 部件，实际发现 ${content.type}`);
    }
  }

  for (const [name, marker] of Object.entries(MARKER)) {
    if (name === "denyReason") continue; // denyReason 走 output-error 的 errorText，理应出现在模型可见的 tool-result 里，见下方单独断言
    assert.equal(
      serialized.includes(String(marker)),
      false,
      `data 部件专属的标记 "${String(marker)}"（来自 ${name}）不应该出现在转换后的 ModelMessage 里`,
    );
  }
  assert.equal(serialized.includes(MARKER.denyReason), true, "拒绝理由（errorText）应该照常出现在 tool-result 里，它不是 data 部件");

  console.log(
    "[结构断言 1] 通过：convertToModelMessages 的输出里没有任何 data-* 部件，六个 data 部件（含各自专属标记字符串）全部被丢弃；" +
      "唯一例外是 errorText（拒绝理由）——它走标准 tool 部件的 output-error 状态，不是 data 部件，因此照常传给模型，这正是拒绝语义要保留的行为。",
  );
  return modelMessages;
}

function printModelMessageSnapshot(modelMessages: ModelMessage[]): void {
  console.log("\n[结构快照] 供人工比对多步分组：");
  const summaries = summarizeModelMessages(modelMessages);
  console.log("  " + formatRawMessageSummaries(summaries));
  assertAssistantToolGrouping(summaries);
  console.log("[结构断言 1 附加] 通过：每条 tool 消息前面紧跟着一条含 tool-call 部件的 assistant 消息（分组顺序符合预期）。");
}

/** docs/tech/single-ledger.md §2.4 结构断言 2：transient 部件不进落盘存档——见文件头"发现 A"。 */
function demonstrateTransientDiscipline(): void {
  console.log("\n[结构断言 2] transient 部件不进账本存档：");
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
  assert.equal(message.parts.some((p) => p.type === "data-tool-progress"), false, "transient 部件不应该出现在账本消息的 parts 里");
  assert.equal(serialized.includes(MARKER.progressText), false, "transient 部件的 payload 不应该出现在序列化后的账本 JSON 里");
  assert.equal(liveOnly.length, 1, "transient 部件应该恰好被 live 回调收到一次");
  assert.equal(message.parts.some((p) => p.type === "data-plan-update"), true, "非 transient 的 data 部件应该正常进账本");

  console.log(
    "  通过：data-plan-update（非 transient）出现在 message.parts 里；data-tool-progress（transient）只出现在 live 回调里，" +
      "从未写入 message.parts / 序列化 JSON。",
  );
  console.log(
    "  发现：ai@7 的 DataUIPart 类型（存进 UIMessage.parts 的那个）本身不带 transient 字段——transient 只是" +
      " UIMessageChunk（线协议）上的属性，由 ai 自己的流处理器在写入期直接判断跳过（源码注释原文：" +
      '"transient parts are not added to the message state"）。也就是说"先写进数组、序列化前再过滤掉' +
      ' transient"不是 ai 的做法，账本也没有字段可供事后过滤——必须在写入那一刻就分流，本文件的' +
      " emitTransientDataPart() 就是复刻这个写入期判断（详见文件头“发现 A”）。",
  );
}

async function offlineSection(): Promise<void> {
  console.log("=== 离线段（无凭证也可跑，进程退出码体现断言结果）===");
  const fixture = buildOfflineFixture();
  const modelMessages = await assertConverterDropsAllDataParts(fixture);
  printModelMessageSnapshot(modelMessages);
  demonstrateTransientDiscipline();
  console.log("\n离线段全部断言通过。\n");
}

// ============================================================================
// 4. 真机段：环境解析 + 请求体取证
// ============================================================================

/**
 * `process.loadEnvFile` 的抛出值在 catch 边界是 `unknown`——同款受控收窄见
 * examples/shared/model.ts 的 `isEnoentError`（这里独立重写一份而不是导入，
 * 原因同 examples/12 文件头："this file has zero dependency on shared/model.ts's
 * model-resolution behavior"——本文件需要自己的 fetch 注入，用不了
 * `resolveModel()`）。
 */
function isEnoentError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function loadRootDotEnv(): void {
  const dotEnvPath = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");
  try {
    process.loadEnvFile(dotEnvPath);
  } catch (error) {
    if (!isEnoentError(error)) throw error;
  }
}

const DEEPSEEK_DEFAULT_MODEL_ID = "deepseek-chat"; // 同 shared/model.ts 的默认值与 NIMBO_MODEL 覆盖语义

/** DeepSeek-only 门控（同 examples/12 的写法），额外注入取证用的自定义 fetch。 */
function resolveCapturingDeepSeekModel(fetchImpl: typeof fetch): LanguageModel | undefined {
  const baseURL = process.env.DEEPSEEK_API_BASE_URL?.trim();
  const apiKey = process.env.DEEPSEEK_API_TOKEN?.trim();
  if (baseURL === undefined || baseURL.length === 0 || apiKey === undefined || apiKey.length === 0) return undefined;

  const deepseek = createDeepSeek({ baseURL, apiKey, fetch: fetchImpl });
  const modelId = process.env.NIMBO_MODEL?.trim();
  return deepseek(modelId === undefined || modelId.length === 0 ? DEEPSEEK_DEFAULT_MODEL_ID : modelId);
}

interface RequestCaptureRecord {
  url: string;
  status: number;
  messages: unknown[] | undefined;
}

interface RequestCapture {
  fetch: typeof fetch;
  writtenCount: () => number;
  read: (index: number) => Promise<RequestCaptureRecord>;
}

/** 请求体里 `messages` 字段的最小、隔离的类型收窄——JSON.parse 之后的值本就是 `unknown`，这是序列化边界，不可避免。 */
function extractMessagesArray(body: unknown): unknown[] | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  if (!("messages" in body)) return undefined;
  const { messages } = body;
  return Array.isArray(messages) ? messages : undefined;
}

/**
 * 用自定义 fetch 包装记录"发给服务商的原始请求体"（docs/tech/single-ledger.md §2.1）——每次调用把
 * 解析后的 JSON body 落盘到 `<dir>/requests/req-<n>.json`，HTTP 状态码一并记录；
 * 真正发出的请求与响应完全不受影响（原样透传），只是多了一次旁路记录。
 */
function createRequestCapture(dir: string): RequestCapture {
  let counter = 0;
  const requestsDir = join(dir, "requests");
  const records: RequestCaptureRecord[] = [];

  const capturingFetch: typeof fetch = async (input, init) => {
    counter += 1;
    const index = counter;
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const bodyText = typeof init?.body === "string" ? init.body : "";

    const response = await fetch(input, init);

    const bodyJson: unknown = bodyText.length > 0 ? JSON.parse(bodyText) : null;
    const record: RequestCaptureRecord = { url, status: response.status, messages: extractMessagesArray(bodyJson) };
    records[index - 1] = record;

    await mkdir(requestsDir, { recursive: true });
    await writeFile(
      join(requestsDir, `req-${String(index)}.json`),
      JSON.stringify({ index, url, status: response.status, body: bodyJson }, null, 2),
      "utf8",
    );

    return response;
  };

  return {
    fetch: capturingFetch,
    writtenCount: () => counter,
    async read(index: number): Promise<RequestCaptureRecord> {
      const cached = records.at(index - 1);
      if (cached !== undefined) return cached;
      const raw: unknown = JSON.parse(await readFile(join(requestsDir, `req-${String(index)}.json`), "utf8"));
      if (typeof raw !== "object" || raw === null) return { url: "", status: 0, messages: undefined };
      const url = "url" in raw && typeof raw.url === "string" ? raw.url : "";
      const status = "status" in raw && typeof raw.status === "number" ? raw.status : 0;
      const messages = "body" in raw ? extractMessagesArray(raw.body) : undefined;
      return { url, status, messages };
    },
  };
}

// ============================================================================
// 5. 真机段：脚本化假环境 + 工具执行（不带 execute 的手动 loop——docs/tech/core-sdk.md §4.3）
// ============================================================================

interface FakeEnvironment {
  files: Map<string, string>;
  bashCallCount: number;
  askUserCallCount: number;
}

function createFakeEnvironment(): FakeEnvironment {
  return {
    files: new Map([["/notes.txt", "旧笔记：nimbo 单账本实验占位内容。"]]),
    bashCallCount: 0,
    askUserCallCount: 0,
  };
}

const BASH_DENY_REASON = "本次实验的审批策略拒绝了本轮第一次 bash 调用（与具体命令内容无关，用于验证 docs/tech/single-ledger.md §2.4 验证项 2：拒绝语义）。";

function scriptedBashOutput(command: string): string {
  return `$ ${command}\n(脚本化假实现，不会真的起进程) 已模拟执行，退出码 0。`;
}

const SCRIPTED_ASK_USER_ANSWERS = ["好，可以在结尾加一句「祝一切顺利」。", "都可以，你决定就好。"];

function scriptedAskUserAnswer(callIndex: number): string {
  return SCRIPTED_ASK_USER_ANSWERS.at(Math.min(callIndex, SCRIPTED_ASK_USER_ANSWERS.length) - 1) ?? "好的，你决定就好。";
}

interface ToolExecutionOutcome {
  finalPart: UIMessagePart<LedgerDataParts, LedgerTools>;
  approvalPending?: ApprovalData;
  approvalFinal?: ApprovalData;
  fileChange?: FileChangeData["changes"][number];
}

/**
 * 脚本化执行一次工具调用（不需要真沙盒）。bash 的审批策略极简且确定性：
 * **本轮对话里的第一次 bash 调用恒被拒绝**，与模型具体传了什么命令无关——
 * 这样不必对模型的自由措辞做内容匹配，同时忠实复现 docs/tech/single-ledger.md §2.1"脚本化 deny
 * 一次 bash 调用"的要求。
 */
async function executeScriptedTool(
  env: FakeEnvironment,
  call: TypedToolCall<typeof modelTools>,
  onLiveData: (chunk: DataUIPart<LedgerDataParts>) => void,
): Promise<ToolExecutionOutcome> {
  // 先按 `call.dynamic` 分流——`TypedToolCall<TOOLS> = StaticToolCall<TOOLS> | DynamicToolCall`，
  // 而 `DynamicToolCall.toolName` 是宽泛的 `string`（不是字面量），单靠 `switch (call.toolName)`
  // 排不掉这一支（TS 不能证明一个宽 string 一定不等于某个字面量），`call.input` 会退化成
  // unknown。真正的判别字段是 `call.dynamic`（`DynamicToolCall` 恒为字面量 `true`，
  // `StaticToolCall` 恒为 `false | undefined`）——这是实现过程中踩到的一个 TS 窄化坑。
  if (call.dynamic === true) {
    return {
      finalPart: {
        type: "dynamic-tool",
        toolName: call.toolName,
        toolCallId: call.toolCallId,
        state: "output-error",
        input: call.input,
        errorText: `未知工具 "${call.toolName}"，本实验没有为它提供脚本化实现。`,
      },
    };
  }
  switch (call.toolName) {
    case "bash": {
      env.bashCallCount += 1;
      const callIndex = env.bashCallCount;
      emitTransientDataPart(
        "tool-progress",
        call.toolCallId,
        { toolCallId: call.toolCallId, text: `执行中：${call.input.command}` },
        onLiveData,
      );
      if (callIndex === 1) {
        const pending: ApprovalData = {
          id: call.toolCallId,
          toolCallId: call.toolCallId,
          toolName: "bash",
          status: "pending",
          input: call.input,
        };
        const denied: ApprovalData = { ...pending, status: "denied", message: BASH_DENY_REASON };
        return {
          finalPart: {
            type: "tool-bash",
            toolCallId: call.toolCallId,
            state: "output-error",
            input: call.input,
            errorText: BASH_DENY_REASON,
          },
          approvalPending: pending,
          approvalFinal: denied,
        };
      }
      return {
        finalPart: {
          type: "tool-bash",
          toolCallId: call.toolCallId,
          state: "output-available",
          input: call.input,
          output: scriptedBashOutput(call.input.command),
        },
      };
    }
    case "read-file": {
      const content = env.files.get(call.input.path);
      return {
        finalPart: {
          type: "tool-read-file",
          toolCallId: call.toolCallId,
          state: "output-available",
          input: call.input,
          output: content ?? `(文件不存在：${call.input.path})`,
        },
      };
    }
    case "write-file": {
      const existed = env.files.has(call.input.path);
      env.files.set(call.input.path, call.input.content);
      return {
        finalPart: {
          type: "tool-write-file",
          toolCallId: call.toolCallId,
          state: "output-available",
          input: call.input,
          output: `已写入 ${call.input.path}（${String(call.input.content.length)} 字符）`,
        },
        fileChange: { path: call.input.path, kind: existed ? "update" : "add" },
      };
    }
    case "ask-user": {
      env.askUserCallCount += 1;
      return {
        finalPart: {
          type: "tool-ask-user",
          toolCallId: call.toolCallId,
          state: "output-available",
          input: call.input,
          output: scriptedAskUserAnswer(env.askUserCallCount),
        },
      };
    }
  }
}

// ============================================================================
// 6. 真机段：单步 / 单轮 / 恢复路径
// ============================================================================

interface StepOutcome {
  finishReason: FinishReason;
  toolCallCount: number;
  usage: LanguageModelUsage;
  providerMetadata: ProviderMetadata | undefined;
  assistantMessage: LedgerUIMessage;
  /** 这一步实际发给 streamText 的 ModelMessage[]（AI SDK 层，`convertToModelMessages()` 的直接输出）——"多步等价"验证项要看的是这一层，不是下面的 wire 抓包（见 `requestIndex` 注释）。 */
  requestMessages: ModelMessage[];
  requestIndex: number;
  deniedToolCallId: string | undefined;
}

/**
 * 一次 `streamText` = 一"步"（docs/tech/core-sdk.md §4.3）。**每步调模型前都用
 * `convertToModelMessages(全量 UIMessage 数组)` 现场推导**——本函数自己不手拼
 * 任何 `ModelMessage`，这是 docs/tech/single-ledger.md §2.1 的硬约束。工具调用先流式收集，
 * 流结束后再逐个脚本化执行、把结果直接以最终形态（output-available/
 * output-error）追加进这一步的 assistant 消息——不记录中间的 input-streaming/
 * input-available 占位状态（那是"直播"用的，落盘的账本只需要每个 tool 部件的
 * 最终结算态，同 P13-1"过程帧只直播不落盘"的结论）。
 */
async function runOneStep(opts: {
  model: LanguageModel;
  system: string;
  ledger: LedgerUIMessage[];
  env: FakeEnvironment;
  onLiveData: (chunk: DataUIPart<LedgerDataParts>) => void;
  capture: RequestCapture;
}): Promise<StepOutcome> {
  const { model, system, ledger, env, onLiveData, capture } = opts;

  const requestMessages = await convertToModelMessages(ledger);
  const result = streamText({ model, instructions: system, messages: requestMessages, tools: modelTools });

  const assistantMessage: LedgerUIMessage = { id: `asst-${randomUUID()}`, role: "assistant", parts: [{ type: "step-start" }] };
  ledger.push(assistantMessage);

  const openText = new Map<string, TextUIPart>();
  const openReasoning = new Map<string, ReasoningUIPart>();
  const pendingCalls: Array<TypedToolCall<typeof modelTools>> = [];

  for await (const part of result.stream) {
    switch (part.type) {
      case "text-start": {
        const textPart: TextUIPart = { type: "text", text: "", state: "streaming" };
        openText.set(part.id, textPart);
        assistantMessage.parts.push(textPart);
        break;
      }
      case "text-delta": {
        const textPart = openText.get(part.id);
        if (textPart !== undefined) textPart.text += part.text;
        break;
      }
      case "text-end": {
        const textPart = openText.get(part.id);
        if (textPart !== undefined) textPart.state = "done";
        break;
      }
      case "reasoning-start": {
        const reasoningPart: ReasoningUIPart = { type: "reasoning", text: "", state: "streaming" };
        openReasoning.set(part.id, reasoningPart);
        assistantMessage.parts.push(reasoningPart);
        break;
      }
      case "reasoning-delta": {
        const reasoningPart = openReasoning.get(part.id);
        if (reasoningPart !== undefined) reasoningPart.text += part.text;
        break;
      }
      case "reasoning-end": {
        const reasoningPart = openReasoning.get(part.id);
        if (reasoningPart !== undefined) reasoningPart.state = "done";
        break;
      }
      case "tool-call": {
        pendingCalls.push(part);
        break;
      }
      default:
        break;
    }
  }

  const finalStep = await result.finalStep;

  let deniedToolCallId: string | undefined;
  for (const call of pendingCalls) {
    // 只追加每个工具调用的最终结算态（output-available/output-error），不单独记录
    // input-streaming/input-available 的中间占位——那是"直播"用的（同 P13-1"过程帧只
    // 直播不落盘"的结论），落盘的账本每个 toolCallId 只应该出现一次工具部件；曾经
    // 误把占位态和终态都 push 进同一条消息，导致同一个 toolCallId 出现两次 tool-call，
    // 被 DeepSeek 判定为非法请求（"Duplicate value for 'tool_call_id'"）拒绝——这是本
    // 实验实测到的一个真实 bug，修复后不再有这一步。
    const outcome = await executeScriptedTool(env, call, onLiveData);
    assistantMessage.parts.push(outcome.finalPart);
    if (outcome.approvalPending !== undefined) {
      upsertDataPart(assistantMessage, "approval", outcome.approvalPending.id, outcome.approvalPending);
    }
    if (outcome.approvalFinal !== undefined) {
      upsertDataPart(assistantMessage, "approval", outcome.approvalFinal.id, outcome.approvalFinal);
      if (outcome.approvalFinal.status === "denied") deniedToolCallId = call.toolCallId;
    }
    if (outcome.fileChange !== undefined) {
      upsertDataPart(assistantMessage, "file-change", `fc-${call.toolCallId}`, { changes: [outcome.fileChange] });
    }
  }

  return {
    finishReason: finalStep.finishReason,
    toolCallCount: pendingCalls.length,
    usage: finalStep.usage,
    providerMetadata: finalStep.providerMetadata,
    assistantMessage,
    requestMessages,
    requestIndex: capture.writtenCount(),
    deniedToolCallId,
  };
}

const MAX_STEPS_PER_TURN = 6;
const PLAN_ID = "plan-main";

function initialPlanItems(): PlanUpdateData {
  return {
    items: [
      { text: "处理首次 bash 调用被拒绝的情况", completed: false },
      { text: "读取并更新 /notes.txt", completed: false },
      { text: "征求人类意见（ask-user）", completed: false },
      { text: "总结收尾", completed: false },
    ],
  };
}

function completedPlanItems(): PlanUpdateData {
  return { items: initialPlanItems().items.map((item) => ({ ...item, completed: true })) };
}

const ROUND_ONE_SYSTEM_INSTRUCTIONS = `你是 docs/tech/single-ledger.md 单账本实验里的一个最小 agent，工作在完全脚本化的假环境（没有真实文件系统、没有真实 shell）。可用工具：bash（执行一条命令）、read-file（读文件）、write-file（写文件）、ask-user（向人类提问并等待回答）。

审批策略（这是本次实验的固定规则，不代表你的命令有什么问题）：本轮对话里第一次调用 bash，无论传入什么命令，都会被拒绝执行，你会在工具结果里看到拒绝理由；请据此调整方案（比如换一种不依赖该命令的做法，或者说明你打算怎么绕过），不要用完全相同的参数原样重试。之后再次调用 bash（换一条不同的命令）通常会被允许执行。

每一步都必须真的调用对应工具完成，不要用文字假装已经做过。`;

const ROUND_ONE_USER_MESSAGE = `帮我做一件小事：
1. 先跑一条你觉得合适的 bash 命令看看当前环境（这一步预期会被拒绝，请按拒绝理由调整方案）。
2. 读取 /notes.txt 的内容。
3. 在原有内容后面加一句你自己的总结，写回 /notes.txt。
4. 用 ask-user 问我一句话——比如要不要在结尾再加一句结束语——等我回答后再继续。
5. 再跑一条和第 1 步不同的 bash 命令，确认收尾。
6. 最后用一段话总结你做了什么：第 1 步被拒绝后你是怎么应对的？我在第 4 步的回答对你有什么影响？`;

const STEER_MESSAGE_TEXT = "（插话，不用打断你正在做的事，看到后顺手回应一下就行）如果最后你要写总结，请在总结的第一句话里出现「任务完成」这四个字。";

interface RoundOneResult {
  ledger: LedgerUIMessage[];
  steps: StepOutcome[];
  steerMessage: LedgerUIMessage;
  firstStepAssistantMessage: LedgerUIMessage;
  deniedCallId: string | undefined;
  deniedStepIndex: number | undefined;
}

/**
 * 多步 turn：第一步结束后（不管 finishReason 是什么）都注入一条 steer 消息
 * （docs/tech/single-ledger.md §2.1"第二步边界注入用户插话"），并且保证第一步之后**至少再跑一步**
 * 让模型对插话有所回应；此后按标准"finishReason !== 'tool-calls' 就收尾"的规则
 * 继续，直到 MAX_STEPS_PER_TURN 兜底。
 */
async function runRoundOneTurn(opts: {
  model: LanguageModel;
  ledger: LedgerUIMessage[];
  env: FakeEnvironment;
  onLiveData: (chunk: DataUIPart<LedgerDataParts>) => void;
  capture: RequestCapture;
}): Promise<RoundOneResult> {
  const steps: StepOutcome[] = [];
  let steerMessage: LedgerUIMessage | undefined;
  let firstStepAssistantMessage: LedgerUIMessage | undefined;
  let lastOutcome: StepOutcome | undefined;
  let deniedCallId: string | undefined;
  let deniedStepIndex: number | undefined;

  for (let stepIndex = 0; stepIndex < MAX_STEPS_PER_TURN; stepIndex += 1) {
    const outcome = await runOneStep({
      model: opts.model,
      system: ROUND_ONE_SYSTEM_INSTRUCTIONS,
      ledger: opts.ledger,
      env: opts.env,
      onLiveData: opts.onLiveData,
      capture: opts.capture,
    });
    steps.push(outcome);
    lastOutcome = outcome;
    console.log(
      `  [round 1][步 ${String(steps.length)}] finishReason=${outcome.finishReason} 工具调用=${String(outcome.toolCallCount)} 次`,
    );

    if (deniedCallId === undefined && outcome.deniedToolCallId !== undefined) {
      deniedCallId = outcome.deniedToolCallId;
      deniedStepIndex = steps.length - 1;
    }

    const isFirstStep = steps.length === 1;
    if (isFirstStep) {
      firstStepAssistantMessage = outcome.assistantMessage;
      // plan-update 是本实验里唯一不经由某个工具调用产生的 data 部件——这四个
      // 工具（bash/read-file/write-file/ask-user）里没有 update-plan，真实
      // nimbo 会有专门的 update-plan 工具；这里是本实验刻意的范围裁剪（工单
      // 只要求四个工具），plan-update 由 harness 自己在步边界维护。
      upsertDataPart(outcome.assistantMessage, "plan-update", PLAN_ID, initialPlanItems());
      steerMessage = {
        id: `user-steer-${randomUUID()}`,
        role: "user",
        parts: [{ type: "text", text: STEER_MESSAGE_TEXT }],
        metadata: { steered: true },
      };
      opts.ledger.push(steerMessage);
    }

    if (outcome.finishReason !== "tool-calls" && !isFirstStep) break;
  }

  if (lastOutcome !== undefined) {
    upsertDataPart(lastOutcome.assistantMessage, "plan-update", PLAN_ID, completedPlanItems());
  }

  assert.ok(steerMessage !== undefined, "round 1 应该在第一步结束后注入 steer 消息");
  assert.ok(firstStepAssistantMessage !== undefined, "round 1 应该至少跑完第一步");

  return { ledger: opts.ledger, steps, steerMessage, firstStepAssistantMessage, deniedCallId, deniedStepIndex };
}

const ROUND_TWO_USER_MESSAGE =
  "（新的一轮，紧接着上次的工作）你还记得刚才发生了什么吗？用一两句话回顾一下：第 1 步 bash 被拒绝后你是怎么处理的，以及我中途插话让你在总结里加「任务完成」这件事你有没有照做。不需要调用任何工具。";

/** 恢复路径：模拟全新进程——从 ledger.json 读回数组 → `validateUIMessages()` 校验/收窄成 `LedgerUIMessage[]` → 转换 → 追加新用户消息 → 再跑一轮（1 步）。 */
async function runRoundTwo(opts: {
  model: LanguageModel;
  ledgerPath: string;
  env: FakeEnvironment;
  onLiveData: (chunk: DataUIPart<LedgerDataParts>) => void;
  capture: RequestCapture;
}): Promise<{ ledger: LedgerUIMessage[]; outcome: StepOutcome }> {
  const raw: unknown = JSON.parse(await readFile(opts.ledgerPath, "utf8"));
  const recoveredLedger = await validateUIMessages<LedgerUIMessage>({
    messages: raw,
    // safeValidateUIMessages 对每条消息的 metadata 无条件校验（哪怕该消息压根没有
    // metadata 字段，即 `undefined`）——`ledgerMetadataSchema` 本身对 `LedgerMessageMetadata`
    // 的类型推导要保持"要求一个对象"，这里单独 `.optional()` 一份只给校验用，不改 `ledgerMetadataSchema` 本身。
    metadataSchema: ledgerMetadataSchema.optional(),
    dataSchemas: ledgerDataSchemas,
  });

  recoveredLedger.push({
    id: `user-round2-${randomUUID()}`,
    role: "user",
    parts: [{ type: "text", text: ROUND_TWO_USER_MESSAGE }],
  });

  const outcome = await runOneStep({
    model: opts.model,
    // 复用 round 1 同一份 system instructions（不是单独一份"round 2 专属"文案）——
    // `instructions` 是 streamText 请求体里的第一条消息，真实 nimbo agent 的
    // instructions 在一个 session 的生命周期里也是恒定的；验证项 4"前缀缓存"
    // 比较的前提就是"除新增内容外，前缀字节不变"，system 消息本身当然也要在
    // 前缀范围内保持不变——这里曾经用过一份措辞不同的 round-2 专属 system
    // instructions（"这一步不需要调用任何工具"），实测直接导致前缀从第一条
    // 消息就不一致，这是本实验过程中一个真实的自曝其短的方法论错误，修复后
    // 改用同一份 instructions，工具约束改由 ROUND_TWO_USER_MESSAGE 的措辞传达。
    system: ROUND_ONE_SYSTEM_INSTRUCTIONS,
    ledger: recoveredLedger,
    env: opts.env,
    onLiveData: opts.onLiveData,
    capture: opts.capture,
  });

  if (outcome.finishReason === "tool-calls") {
    console.log(
      "  注意：round 2 的模型仍然请求了工具调用；本实验按设计只跑 1 步，未执行/回填——这是「turn 被打断」的合法存档状态，不是 bug。",
    );
  }

  return { ledger: recoveredLedger, outcome };
}

// ============================================================================
// 7. 真机段：docs/tech/single-ledger.md §2.4 五项验证的逐项判定打印
// ============================================================================

function collectReasoningTexts(ledger: LedgerUIMessage[]): string[] {
  const texts: string[] = [];
  for (const message of ledger) {
    for (const part of message.parts) {
      if (part.type === "reasoning") texts.push(part.text);
    }
  }
  return texts;
}

function collectText(message: LedgerUIMessage): string {
  let text = "";
  for (const part of message.parts) {
    if (part.type === "text") text += part.text;
  }
  return text;
}

function findToolResultPart(messages: ModelMessage[], toolCallId: string): ToolResultPart | undefined {
  for (const message of messages) {
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type === "tool-result" && part.toolCallId === toolCallId) return part;
    }
  }
  return undefined;
}

function firstAssistantTextAfterStep(steps: StepOutcome[], deniedStepIndex: number): string | undefined {
  for (const step of steps.slice(deniedStepIndex + 1)) {
    const text = collectText(step.assistantMessage);
    if (text.length > 0) return text;
  }
  const deniedStep = steps.at(deniedStepIndex);
  if (deniedStep === undefined) return undefined;
  const ownText = collectText(deniedStep.assistantMessage);
  return ownText.length > 0 ? ownText : undefined;
}

async function printVerificationReport(opts: {
  round1: RoundOneResult;
  round2: { ledger: LedgerUIMessage[]; outcome: StepOutcome };
  capture: RequestCapture;
}): Promise<void> {
  const { round1, round2, capture } = opts;
  console.log("\n=== 五项验证的逐项判定（docs/tech/single-ledger.md §2.4）===");

  const round2Request = await capture.read(round2.outcome.requestIndex);

  // ---- 1. 推理往返 ----
  console.log("\n[1] 推理往返");
  const reasoningTexts = collectReasoningTexts(round1.ledger);
  if (reasoningTexts.length === 0) {
    console.log("  模型在第一轮没有产出任何 reasoning 部件 —— 判定：无法验证（docs/tech/single-ledger.md §2.4 允许的结果，需要一个推理能力更强/开启推理的模型）。");
  } else {
    const historicalReasoningKept = containsReasoningContent(round2Request.messages);
    console.log(`  第一轮产出了 ${String(reasoningTexts.length)} 段 reasoning；第二轮请求体里${historicalReasoningKept ? "保留了" : "省略了"}历史 reasoning 内容。`);
  }
  console.log(`  第二轮请求 HTTP 状态：${String(round2Request.status)}（${round2Request.status === 200 ? "合法" : "非 200，需要人工核对"}）。`);

  // ---- 2. 拒绝语义 ----
  console.log("\n[2] 拒绝语义");
  if (round1.deniedCallId === undefined || round1.deniedStepIndex === undefined) {
    console.log("  本轮没有触发 bash 拒绝（不应该发生，脚本化策略恒拒绝第一次 bash 调用——如实记录以便排查）。");
  } else {
    const finalModelMessages = await convertToModelMessages(round1.ledger);
    const toolResult = findToolResultPart(finalModelMessages, round1.deniedCallId);
    console.log(`  转换器为被拒的 bash 调用生成的工具结果消息：${JSON.stringify(toolResult)}`);
    const followUpText = firstAssistantTextAfterStep(round1.steps, round1.deniedStepIndex);
    console.log(`  模型在被拒之后的下一段文字回应：${followUpText ?? "(该步没有文本内容)"}`);
    console.log("  人工判读：上面这段文字是「理解被拒、调整方案」还是「当工具故障盲目重试」。");
  }

  // ---- 3. 多步等价 ----
  // 用的是 AI SDK 层的 ModelMessage[]（`convertToModelMessages()` 的直接输出），不是下面
  // "前缀缓存"用的 wire 抓包——发现：DeepSeek（OpenAI 兼容）的线上 JSON 不是 ModelMessage.content
  // 数组那种"每个 part 带 type 字段"的形状，工具调用走独立的顶层 tool_calls 字段、工具结果是
  // role:"tool" 消息的纯字符串 content（按 tool_call_id 关联），而不是 content 数组里的
  // `{type:"tool-call"}`/`{type:"tool-result"}`。这层差异正是 AI SDK 要抽象掉的东西，
  // "多步等价"要看的是 AI SDK 抽象后的结构，不是某个 provider 的线上细节。
  console.log("\n[3] 多步等价");
  const step2 = round1.steps.at(1);
  if (step2 === undefined) {
    console.log(`  第一轮只跑了 ${String(round1.steps.length)} 步，没有"第二步请求体"可展示——这是真机不确定性，如实记录。`);
  } else {
    const summaries = summarizeModelMessages(step2.requestMessages);
    console.log(`  第二步请求体（ModelMessage[]，AI SDK 层）的结构：${formatRawMessageSummaries(summaries)}`);
    assertAssistantToolGrouping(summaries);
    console.log("  已确认：assistant(tool-call) -> tool(结果) 的分组与顺序符合预期。");
  }

  // ---- 4. 前缀缓存 ----
  console.log("\n[4] 前缀缓存");
  const lastStep = round1.steps.at(-1);
  assert.ok(lastStep !== undefined, "round 1 应该至少有一步");
  const round1LastRequest = await capture.read(lastStep.requestIndex);
  if (round1LastRequest.messages === undefined || round2Request.messages === undefined) {
    console.log("  取证文件里没能解析出 messages 数组，无法比较前缀（记录以便排查取证逻辑）。");
  } else {
    const expected = JSON.stringify(round1LastRequest.messages);
    const actual = JSON.stringify(round2Request.messages.slice(0, round1LastRequest.messages.length));
    const prefixMatches = actual === expected;
    console.log(`  第二轮请求 messages 的前缀与第一轮最后一次请求逐字节${prefixMatches ? "一致" : "不一致"}。`);
    if (!prefixMatches) console.log("  （不一致——这本身就是一个需要记录的发现，不强行断言通过。）");
  }
  console.log(`  第一轮最后一步 cachedInputTokens（通用别名 inputTokenDetails.cacheReadTokens）：${String(lastStep.usage.inputTokenDetails.cacheReadTokens)}`);
  console.log(`  第二轮 cachedInputTokens：${String(round2.outcome.usage.inputTokenDetails.cacheReadTokens)}`);
  console.log(`  第一轮最后一步原始 usage.raw：${JSON.stringify(lastStep.usage.raw)}`);
  console.log(`  第二轮原始 usage.raw：${JSON.stringify(round2.outcome.usage.raw)}`);
  console.log(`  第二轮 providerMetadata：${JSON.stringify(round2.outcome.providerMetadata)}`);

  // ---- 5. 中途插话 ----
  console.log("\n[5] 中途插话（steer）");
  const steerIndex = round1.ledger.indexOf(round1.steerMessage);
  const stepOneAssistantIndex = round1.ledger.indexOf(round1.firstStepAssistantMessage);
  assert.ok(steerIndex !== -1 && stepOneAssistantIndex !== -1, "steer 消息或第一步 assistant 消息没能在账本里找到");
  const positionOk = steerIndex === stepOneAssistantIndex + 1;
  console.log(`  steer 消息紧跟在第一步 assistant 消息之后：${positionOk ? "是" : "否（异常，需要排查）"}`);
  const secondStep = round1.steps.at(1);
  const secondStepText = secondStep === undefined ? undefined : collectText(secondStep.assistantMessage);
  console.log(`  第二步（插话之后）模型的响应片段：${secondStepText === undefined ? "(无第二步)" : secondStepText.slice(0, 200)}`);
}

// ============================================================================
// 8. 真机段：编排
// ============================================================================

async function realMachineSection(): Promise<void> {
  loadRootDotEnv();
  console.log("\n=== 真机段：真实 DeepSeek 模型 + 手写单账本 loop（docs/tech/single-ledger.md §2.1）===");

  // Gate：只看 DeepSeek 凭证（同 examples/12 的 gate 写法：缺失就打印指引后 return，不崩溃）。
  const runDir = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    ".tmp",
    "13-uimessage-ledger",
    `run-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  await mkdir(runDir, { recursive: true });
  const capture = createRequestCapture(runDir);

  const model = resolveCapturingDeepSeekModel(capture.fetch);
  if (model === undefined) {
    console.log(
      "[nimbo example] DeepSeek 未配置 —— 跳过真机段。\n" +
        "在仓库根 .env 设置：\n  DEEPSEEK_API_BASE_URL=...\n  DEEPSEEK_API_TOKEN=...\n" +
        `可选 NIMBO_MODEL 覆盖默认模型 "${DEEPSEEK_DEFAULT_MODEL_ID}"。`,
    );
    return;
  }

  console.log(`取证目录 -> ${runDir}`);

  const env = createFakeEnvironment();
  const onLiveData = (chunk: DataUIPart<LedgerDataParts>): void => {
    console.log(`  [live-only，按 ai 语义不进账本] ${chunk.type} id=${chunk.id ?? "(none)"} ${JSON.stringify(chunk.data)}`);
  };

  const ledger: LedgerUIMessage[] = [
    { id: `user-round1-${randomUUID()}`, role: "user", parts: [{ type: "text", text: ROUND_ONE_USER_MESSAGE }] },
  ];

  console.log("\n[round 1] 开始多步 turn ...");
  const round1 = await runRoundOneTurn({ model, ledger, env, onLiveData, capture });
  console.log(
    `[round 1] 结束：共 ${String(round1.steps.length)} 步，合计 ${String(round1.steps.reduce((n, s) => n + s.toolCallCount, 0))} 次工具调用。`,
  );

  const ledgerPath = join(runDir, "ledger.json");
  await writeFile(ledgerPath, JSON.stringify(round1.ledger, null, 2), "utf8");
  console.log(`[round 1] 落盘 -> ${ledgerPath}`);

  console.log("\n[round 2] 模拟全新进程：读回 ledger.json -> validateUIMessages -> 追加新用户消息 -> 再跑 1 步 ...");
  const round2 = await runRoundTwo({ model, ledgerPath, env, onLiveData, capture });
  await writeFile(ledgerPath, JSON.stringify(round2.ledger, null, 2), "utf8");
  console.log(`[round 2] 结束，最终账本重新落盘 -> ${ledgerPath}`);
  console.log(`[round 2] 模型响应：${collectText(round2.outcome.assistantMessage)}`);

  await printVerificationReport({ round1, round2, capture });
}

await offlineSection();
await realMachineSection();
