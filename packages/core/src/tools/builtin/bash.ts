/**
 * `bash`（docs/core/builtin-tools/tech.md §1.10 / docs/core/core-sdk/tech.md §4.5a）：条件内置——只在
 * `createSession(agent, { exec })`（或 `{ workspace }` 语法糖）注入了
 * `NimboExec` 实现时才出现在工具列表（与 `load-skill` 同款条件内置机制，接线
 * 在 `session.ts` 的 `assembleTools`，控制条件各自独立）。
 *
 * ---- 实现契约对齐（docs/core/core-sdk/tech.md §4.5a"实现契约"，P6-1 施工回填） ----
 *
 * `NimboExec.exec()` 的全部失败路径（解析错误/未知命令/超时/abort/命令级
 * 错误）应以 **resolve 的 `ExecResult`**（非零 `exitCode` + stderr）返回而非
 * reject——因此这里对"正常失败"（非零退出码、超时）不做 try/catch：
 * `exec()` resolve 的结果原样格式化为 `ToolReturn` 交回模型，`status` 仍是
 * "completed"（docs/core/builtin-tools/tech.md §1.10 验收点："超时/非零退出码作为正常 tool 结果（非
 * isError 崩溃）回填模型"）。但 `NimboExec` 是宿主可自行实现的接口
 * （§4.5a 模式 C"完全解耦"），第三方实现可能不遵守这个契约——因此仍对
 * `exec()` 的 reject 做兜底：转成一个 `{ isError: true, content }` 结构化
 * 结果（docs/core/builtin-tools/tech.md §0.5"错误即指导"），而不是让它以裸 throw 冒泡到
 * `executeToolCall` 的通用 catch（那条路径会产出一句不带诊断上下文的
 * 泛化文案）。
 */
import { z } from "zod";
import { defineTool } from "../../tool.js";
import type { ApprovalPolicy, ExecResult, JsonValue, NimboExec, Tool, ToolReturn } from "../../types.js";

/** docs/core/builtin-tools/tech.md §1.10 原文：`{ command, cwd?, timeout_ms? }`。 */
const inputSchema = z.object({
  command: z.string(),
  cwd: z.string().optional(),
  timeout_ms: z.number().int().positive().optional(),
});

export interface CreateBashToolOptions {
  exec: NimboExec;
}

/** docs/core/builtin-tools/tech.md §0.5 横切规则的一次性错误结构，索引签名理由同 `load-skill.ts` 的 `ToolErrorResult`（不从 virtual-fs 导入，core 不依赖它）。 */
interface ToolErrorResult {
  isError: true;
  content: string;
  [key: string]: JsonValue;
}

function errorResult(content: string): ToolErrorResult {
  return { isError: true, content };
}

/** 受控例外：`unknown` 只在这一处窄化为可读消息，同款先例见 `runtime.ts`/`loop.ts` 的 `describeError`。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const OUTPUT_BYTE_LIMIT = 64 * 1024; // docs/core/builtin-tools/tech.md §1.10：stdout/stderr 各自 64KB 上限

/**
 * 按字符（非字节）边界截断到 `maxBytes` 以内——逐字符累加编码后字节长度，
 * 保证不会在多字节 UTF-8 字符中间切断（与 `@nimbo/virtual-fs` 的
 * `read-file.ts` `sliceLinesWithBudget` 同一种"逐单元累加直到预算耗尽"手法，
 * 单元这里是字符而非行）。
 */
function truncateToBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) return { text, truncated: false };

  const chars = Array.from(text);
  let bytes = 0;
  let end = 0;
  for (; end < chars.length; end++) {
    const charBytes = encoder.encode(chars[end] ?? "").length;
    if (bytes + charBytes > maxBytes) break;
    bytes += charBytes;
  }
  return { text: chars.slice(0, end).join(""), truncated: true };
}

/** 每路输出各自截断并标注 `[truncated: ...]`（工单原文"截断标注 [truncated]"，与既有工具 `truncationNotice` 同风格）。 */
function formatStream(label: "stdout" | "stderr", raw: string): string | undefined {
  if (raw.length === 0) return undefined;
  const { text, truncated } = truncateToBytes(raw, OUTPUT_BYTE_LIMIT);
  const budgetKB = OUTPUT_BYTE_LIMIT / 1024;
  const body = truncated
    ? `${text}\n[truncated: ${label} exceeded the ${budgetKB}KB output budget — showing the first ${budgetKB}KB only]`
    : text;
  return `${label}:\n${body}`;
}

/** stdout/stderr 合并文本 + 退出码（docs/core/builtin-tools/tech.md §1.10 输出规格）。 */
function formatBashOutput(result: ExecResult): string {
  const parts = [formatStream("stdout", result.stdout), formatStream("stderr", result.stderr)].filter(
    (part): part is string => part !== undefined,
  );
  if (parts.length === 0) parts.push("(no output)");
  parts.push(`exit code: ${result.exitCode}`);
  return parts.join("\n\n");
}

const BASE_DESCRIPTION =
  "Execute a shell command through the session's injected command-execution environment and get back its " +
  "stdout/stderr (each capped at 64KB, excess marked '[truncated: ...]') plus exit code. A non-zero exit code " +
  "or a timeout is NOT a tool failure — it comes back as a normal result so you can read stderr and decide what " +
  "to do next (fix the command, retry, or give up on that approach). Use cwd for a specific working directory " +
  "and timeout_ms to bound long-running commands. If this session's file tools and bash share the same " +
  "workspace, files bash writes are visible to read-file immediately, but bash-made changes do not produce " +
  "file_change events, and editing a bash-modified file requires re-reading it first (its mtime changed).";

/** exec 实现的 `describe()`（§1.10"环境自描述"）拼进基础描述之后，未提供/空串时只用基础描述。 */
function buildDescription(exec: NimboExec): string {
  const env = exec.describe?.();
  if (env === undefined || env.trim() === "") return BASE_DESCRIPTION;
  return `${BASE_DESCRIPTION}\n\n---\nExecution environment:\n${env}`;
}

/**
 * bash 的 approval 默认取 `exec.defaultApproval`（§1.10"审批默认值"）。实现
 * 未声明时的兜底——spec 原文只给了两个具体实现的建议值（`localExec()` 出厂
 * "review"（旧 "always"）、沙盒实现通常 "allow"（旧 "never"），docs/agent/single-ledger/tech.md §6.1
 * 三值重构后的映射），未点名"完全没声明"这个第三种情况该怎么办。按"审批是
 * 安全机制，未知实现的安全性不该被乐观假设"的原则选择保守默认 "review"（要求
 * 宿主接入审批分类器/人审通道才能放行），而不是静默直通—— 一个没有声明
 * `defaultApproval` 的第三方 `NimboExec` 更可能是简单包装、未必经过安全考量。
 */
const CONSERVATIVE_DEFAULT_APPROVAL: ApprovalPolicy = "review";

export function createBashTool(opts: CreateBashToolOptions): Tool {
  return defineTool({
    description: buildDescription(opts.exec),
    inputSchema,
    approval: opts.exec.defaultApproval ?? CONSERVATIVE_DEFAULT_APPROVAL,
    execute: async (input, ctx): Promise<ToolReturn> => {
      let result: ExecResult;
      try {
        result = await opts.exec.exec(
          { command: input.command, cwd: input.cwd, timeoutMs: input.timeout_ms, signal: ctx.abortSignal },
          { onOutput: (chunk) => ctx.update(chunk.data) },
        );
      } catch (error) {
        // 契约要求 exec() 不 reject（见本文件头）；到这里说明注入的 NimboExec 违反了契约。
        return errorResult(
          `The injected command-execution environment rejected instead of returning a result for: ${input.command}\n` +
            `Underlying error: ${describeError(error)}\n` +
            "This is a bug in the injected NimboExec implementation (exec() should resolve an ExecResult even on " +
            "failure), not something fixable by retrying the same command.",
        );
      }
      return formatBashOutput(result);
    },
  });
}
