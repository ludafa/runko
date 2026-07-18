/**
 * `loadAgent(dir, opts?)`：L3 目录约定层（docs/tech/core-sdk.md §4.7；P7-3 工单任务 2）——
 * eve 布局兼容："agent 目录"约定：`instructions.md`（必需，或 `opts.instructions`
 * 兜底）+ `agent.ts`/`agent.json`（model 等运行配置，动态 import()）+
 * `tools/*.ts`（文件名即工具名，动态 import()）+ `skills/`（flat `*.md` +
 * packaged `<name>/SKILL.md`，复用 P5 的 `skills/loader.js`）。
 *
 * ---- 动态 import() 的类型逃逸边界（P7-3R 返工："仅当确实无法避免才用类型断言"
 * 的例外前提在本文件不成立——四处字段级断言全部有等价的结构类型守卫替代，已消除） ----
 *
 * `import(pathToFileURL(filePath).href)` 对一个运行时才知道的路径，TS 编译期
 * 无法解析出模块形状——落地类型是 `any`。本文件把这个 `any` 在**唯一入口**
 * `importDefaultExport()` 里立刻收敛成显式 `unknown`，此后全部经 `isRecord()`/
 * `typeof`/具名类型谓词逐字段窄化，不允许 `unknown`/`any`/类型断言流出这个文件
 * 的私有辅助函数之外——本文件不再包含任何值级 `as`（`import * as` 是模块命名
 * 空间导入，不在此列）。三个具名类型谓词、及它们各自"检查了什么/没检查什么"：
 *
 * - `isZodSchemaLike(v)`（`tools/*.ts` 的 `inputSchema`，及可选的 `outputSchema`）：
 *   探针是"是否存在一个可调用的 `safeParse` 方法"——这能正结构性地判别出"这是一个
 *   zod schema 形状的值"，并顺带拦截最常见的误用（比如直接导出一个 JSON Schema
 *   纯数据对象，它有 `type`/`properties` 但没有 `safeParse`）。它**不**验证该值
 *   声明的具体泛型参数是否真的是 `JsonValue`/`ToolReturn`，也**不**实际调用
 *   `safeParse` 去确认其运行时行为与真正的 zod 解析器一致——一个手写的、恰好也长了
 *   同名 `safeParse` 方法但语义不同的对象一样会通过。
 * - `isLanguageModelInstance(v)`（`agent.ts` 的 `model` 字段，仅当来源允许对象
 *   形态时）：探针是 `specificationVersion`/`provider`/`modelId` 三个字符串字段
 *   ——已核对 `node_modules` 里 `ai@7`（`@ai-sdk/provider@4`）的 `LanguageModelV2`/
 *   `LanguageModelV3`/`LanguageModelV4` 实际类型定义，这三个字段是三个版本共同
 *   拥有、且唯二用于区分"这是一个 provider 实例"而非任意对象的判别字段。它**不**
 *   验证 `doGenerate`/`doStream`/`supportedUrls` 等完整方法面是否存在或签名是否
 *   正确——一个只手写了这三个字符串字段的假对象也会通过。
 *
 * 这两者都不是结构验证意义上的"证明"，而是信任声明（同 `session.ts` 的
 * `hasSnapshotCapability`/`hasRestoreCapability`）：`agent.ts`/`tools/*.ts` 是
 * 动态导入的任意用户代码，其精确形状在纯运行时反射下不可能被完全结构证明，这是
 * "动态导入任意用户代码"这个信任边界的固有属性；类型谓词把"我们选择信任到什么
 * 程度"从隐式断言变成了显式、可读、可测试的检查函数。
 */
import * as nodeFs from "node:fs/promises";
import * as nodePath from "node:path";
import * as nodeUrl from "node:url";
import type { LanguageModel } from "ai";
import type { AgentDefinition, BuiltinToolName } from "../agent.js";
import { loadSkillFromDirectory, loadSkillFromMarkdown } from "../skills/loader.js";
import type { Skill } from "../skill.js";
import type { ApprovalPolicy, Tool } from "../types.js";

export interface LoadAgentOptions {
  /** 覆盖 `agent.ts`/`agent.json` 里的 model（无论文件是否提供了 model，opts 优先，§4.7 原文）。 */
  model?: LanguageModel;
  /** `instructions.md` 缺失时的兜底来源（§4.7 表格"必需（或由 opts 提供）"）；文件存在时优先用文件内容。 */
  instructions?: string;
}

const INSTRUCTIONS_FILENAME = "instructions.md";
const AGENT_TS_FILENAME = "agent.ts";
const AGENT_JSON_FILENAME = "agent.json";
const TOOLS_DIRNAME = "tools";
const SKILLS_DIRNAME = "skills";
const SKILL_MD_FILENAME = "SKILL.md";

// ---- 受控的 unknown 窄化入口（本文件头注释） ----

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isEnoent(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await nodeFs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** 动态 import() 的唯一入口：把不可避免的 `any` 立刻收敛成 `unknown`，见本文件头。 */
async function importDefaultExport(filePath: string, label: string): Promise<Record<string, unknown>> {
  const mod: unknown = await import(nodeUrl.pathToFileURL(filePath).href);
  if (!isRecord(mod) || !("default" in mod)) {
    throw new Error(`loadAgent: "${filePath}" (${label}) has no default export.`);
  }
  const def = mod.default;
  if (!isRecord(def)) {
    throw new Error(`loadAgent: "${filePath}" (${label})'s default export must be an object, got ${typeof def}.`);
  }
  return def;
}

// ---- instructions.md（必需，或 opts.instructions 兜底） ----

async function resolveInstructions(absoluteDir: string, opts: LoadAgentOptions): Promise<string> {
  const filePath = nodePath.join(absoluteDir, INSTRUCTIONS_FILENAME);
  try {
    return await nodeFs.readFile(filePath, "utf8");
  } catch (error) {
    if (!isEnoent(error)) throw error;
    if (opts.instructions !== undefined) return opts.instructions;
    throw new Error(
      `loadAgent("${absoluteDir}"): missing required "${INSTRUCTIONS_FILENAME}" (looked for it at "${filePath}"). ` +
        `Add the file, or pass loadAgent(dir, { instructions: "..." }).`,
    );
  }
}

// ---- agent.ts / agent.json：model 等运行配置（§4.7"agent.ts 默认导出 defineAgent 部分字段"） ----

interface AgentConfigFromFile {
  model?: LanguageModel;
  builtinTools?: BuiltinToolName[] | false;
  maxTurnsPerRun?: number;
  maxOutputTokens?: number;
  maxContextTokens?: number;
}

const ALL_BUILTIN_TOOL_NAMES: readonly string[] = [
  "read-file",
  "write-file",
  "edit-file",
  "delete-file",
  "move-file",
  "list-dir",
  "glob",
  "grep",
  "update-plan",
];

function isBuiltinToolName(value: string): value is BuiltinToolName {
  return ALL_BUILTIN_TOOL_NAMES.includes(value);
}

/**
 * 判别字段探针（本文件头）：`specificationVersion`/`provider`/`modelId` 是
 * `ai@7`（`@ai-sdk/provider@4`）里 `LanguageModelV2`/`V3`/`V4` 三个版本共同
 * 拥有的字符串字段，足以把"看起来是一个 provider 实例"的对象和任意其它对象
 * 区分开——不验证 `doGenerate`/`doStream` 等完整方法面（本文件头已如实说明）。
 */
function isLanguageModelInstance(value: unknown): value is Exclude<LanguageModel, string> {
  return (
    isRecord(value) &&
    typeof value.specificationVersion === "string" &&
    typeof value.provider === "string" &&
    typeof value.modelId === "string"
  );
}

/**
 * `allowObjectModel`：`agent.ts`（动态 import，值可以是任意 JS 表达式，包括一个真实
 * provider 实例）与 `agent.json`（纯数据，JSON 语法本身就不能表达函数/方法）在这里
 * 分叉——JSON 来源的 model 只能是字符串。
 */
function readModelField(record: Record<string, unknown>, filePath: string, allowObjectModel: boolean): LanguageModel | undefined {
  const value = record.model;
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (allowObjectModel && isLanguageModelInstance(value)) {
    // `defineAgent`（agent.ts 头注释）对 model 本身也是零运行时校验的恒等函数，
    // 这里的信任级别与之一致——探针通过后原样透传用户在 agent.ts 里构造的实例。
    return value;
  }
  throw new Error(
    `loadAgent: "${filePath}"'s "model" field must be a string (AI SDK gateway id)` +
      `${allowObjectModel ? " or a LanguageModel instance (an object with string \"specificationVersion\"/\"provider\"/\"modelId\" fields)" : ""} — got ${typeof value}.`,
  );
}

function readBuiltinToolsField(record: Record<string, unknown>, filePath: string): BuiltinToolName[] | false | undefined {
  const value = record.builtinTools;
  if (value === undefined) return undefined;
  if (value === false) return false;
  if (!Array.isArray(value)) {
    throw new Error(`loadAgent: "${filePath}"'s "builtinTools" field must be false or an array of built-in tool names.`);
  }
  const names: BuiltinToolName[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !isBuiltinToolName(item)) {
      throw new Error(`loadAgent: "${filePath}"'s "builtinTools" contains an unrecognized entry: ${JSON.stringify(item)}.`);
    }
    names.push(item);
  }
  return names;
}

function readOptionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function parseAgentConfigRecord(record: Record<string, unknown>, filePath: string, allowObjectModel: boolean): AgentConfigFromFile {
  const config: AgentConfigFromFile = {};
  const model = readModelField(record, filePath, allowObjectModel);
  if (model !== undefined) config.model = model;
  const builtinTools = readBuiltinToolsField(record, filePath);
  if (builtinTools !== undefined) config.builtinTools = builtinTools;
  const maxTurnsPerRun = readOptionalNumber(record, "maxTurnsPerRun");
  if (maxTurnsPerRun !== undefined) config.maxTurnsPerRun = maxTurnsPerRun;
  const maxOutputTokens = readOptionalNumber(record, "maxOutputTokens");
  if (maxOutputTokens !== undefined) config.maxOutputTokens = maxOutputTokens;
  const maxContextTokens = readOptionalNumber(record, "maxContextTokens");
  if (maxContextTokens !== undefined) config.maxContextTokens = maxContextTokens;
  return config;
}

/**
 * 裁量（§4.7 表格只写"model 等运行配置"，未逐字段列全）：`agent.ts`/`agent.json`
 * 只承载 model/builtinTools/maxTurnsPerRun/maxOutputTokens/maxContextTokens 这五个
 * 标量/数组字段——`tools`/`skills` 刻意不从这里读取，它们各自有自己的目录约定
 * （`tools/*.ts`、`skills/`），双来源会引入"两处都写了同一个字段，谁赢"的合并歧义，
 * 且 `tools`（函数字段）/`skills`（结构对象）在动态 import 边界上比标量字段更难
 * 做有意义的结构校验——目录扫描已经是这两者的唯一事实来源，agent.ts 里写这两个
 * 字段会被静默忽略。`agent.ts` 存在时优先于 `agent.json`（代码优先于数据这条
 * 常见约定，且与 §4.7 表格里的书写顺序一致）。
 */
async function loadAgentConfigFile(absoluteDir: string): Promise<AgentConfigFromFile> {
  const tsPath = nodePath.join(absoluteDir, AGENT_TS_FILENAME);
  if (await fileExists(tsPath)) {
    const record = await importDefaultExport(tsPath, AGENT_TS_FILENAME);
    return parseAgentConfigRecord(record, tsPath, true);
  }

  const jsonPath = nodePath.join(absoluteDir, AGENT_JSON_FILENAME);
  if (await fileExists(jsonPath)) {
    let text: string;
    try {
      text = await nodeFs.readFile(jsonPath, "utf8");
    } catch (error) {
      throw new Error(`loadAgent: could not read "${jsonPath}": ${describeError(error)}`);
    }
    // JSON.parse(...) 的返回类型是 any——立刻收敛进显式 unknown 变量，不外泄（本文件头）。
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`loadAgent: "${jsonPath}" is not valid JSON: ${describeError(error)}`);
    }
    if (!isRecord(parsed)) {
      throw new Error(`loadAgent: "${jsonPath}" must contain a JSON object at its top level.`);
    }
    return parseAgentConfigRecord(parsed, jsonPath, false);
  }

  return {};
}

// ---- tools/*.ts：文件名即工具名（§4.7；动态 import()，Node ≥ 22.18 原生 TS 或宿主构建产物 .js） ----

const TOOL_FILE_EXTENSIONS = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"];

/** 隐藏文件（`.` 开头）与 `.d.ts` 声明文件不是工具实现，跳过；非以上扩展名的文件同样跳过。 */
function toolNameFromFileName(fileName: string): string | undefined {
  if (fileName.startsWith(".") || fileName.endsWith(".d.ts")) return undefined;
  const ext = TOOL_FILE_EXTENSIONS.find((candidate) => fileName.endsWith(candidate));
  return ext === undefined ? undefined : fileName.slice(0, -ext.length);
}

/**
 * `safeParse` 可调用探针（本文件头）：结构性地判别"这是一个 zod schema 形状的
 * 值"，同时用于 `inputSchema`（必需，`isToolLikeRecord` 内联使用）与
 * `outputSchema`（可选，`parseToolRecord` 单独调用、非 schema 值报错而非静默丢弃）
 * ——两处探针逻辑相同，共用同一个具名谓词。
 */
function isZodSchemaLike(value: unknown): value is NonNullable<Tool["outputSchema"]> {
  return isRecord(value) && typeof value.safeParse === "function";
}

interface ToolLikeRecord extends Record<string, unknown> {
  description: string;
  execute: Tool["execute"];
  inputSchema: Tool["inputSchema"];
}

function isToolLikeRecord(record: Record<string, unknown>): record is ToolLikeRecord {
  return typeof record.description === "string" && typeof record.execute === "function" && isZodSchemaLike(record.inputSchema);
}

/** docs/tech/single-ledger.md §6.1 三值重构：固定策略字符串是 "allow"/"review"/"review-once"/"deny"（旧 "never"/"always"/"once" 已废）。 */
function isApprovalPolicyLike(value: unknown): value is ApprovalPolicy {
  return value === "allow" || value === "review" || value === "review-once" || value === "deny" || typeof value === "function";
}

/** `tools/*.ts` 默认导出的形状核验：单一守卫 `isToolLikeRecord` 吸收 `description`/`execute`/`inputSchema`；`outputSchema` 用同一个 `isZodSchemaLike` 探针单独核验（可选字段，存在但不像 schema 时报错而非静默丢弃）。 */
function parseToolRecord(record: Record<string, unknown>, filePath: string): Tool {
  if (!isToolLikeRecord(record)) {
    throw new Error(
      `loadAgent: "${filePath}"'s default export does not look like a Tool — expected the shape produced by ` +
        "defineTool(...) ({ description, inputSchema, execute }).",
    );
  }
  const rawOutputSchema = record.outputSchema;
  let outputSchema: Tool["outputSchema"];
  if (rawOutputSchema !== undefined) {
    if (!isZodSchemaLike(rawOutputSchema)) {
      throw new Error(
        `loadAgent: "${filePath}"'s "outputSchema" field does not look like a zod schema — expected something with ` +
          `a callable "safeParse" method (e.g. z.object({...}) or z.string()), got ${typeof rawOutputSchema}. ` +
          'Omit "outputSchema" entirely if the tool does not need one.',
      );
    }
    outputSchema = rawOutputSchema;
  }
  return {
    description: record.description,
    inputSchema: record.inputSchema,
    execute: record.execute,
    outputSchema,
    approval: isApprovalPolicyLike(record.approval) ? record.approval : undefined,
  };
}

async function loadToolsDir(absoluteDir: string): Promise<Record<string, Tool>> {
  const toolsDir = nodePath.join(absoluteDir, TOOLS_DIRNAME);
  if (!(await fileExists(toolsDir))) return {};

  const entries = (await nodeFs.readdir(toolsDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  const tools: Record<string, Tool> = {};
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const toolName = toolNameFromFileName(entry.name);
    if (toolName === undefined) continue;
    const filePath = nodePath.join(toolsDir, entry.name);
    const record = await importDefaultExport(filePath, `${TOOLS_DIRNAME}/${entry.name}`);
    tools[toolName] = parseToolRecord(record, filePath);
  }
  return tools;
}

// ---- skills/：flat *.md + packaged <name>/SKILL.md（复用 P5 的 skills/loader.js） ----

async function loadSkillsDir(absoluteDir: string): Promise<Skill[]> {
  const skillsDir = nodePath.join(absoluteDir, SKILLS_DIRNAME);
  if (!(await fileExists(skillsDir))) return [];

  const entries = (await nodeFs.readdir(skillsDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  const skills: Skill[] = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      const filePath = nodePath.join(skillsDir, entry.name);
      const markdown = await nodeFs.readFile(filePath, "utf8");
      skills.push(loadSkillFromMarkdown(entry.name.slice(0, -".md".length), markdown));
    } else if (entry.isDirectory()) {
      // packaged skill 的判据是"这个子目录下有没有 SKILL.md"——没有就当成不相关的
      // 子目录静默跳过（而不是报错），因为 skills/ 下混入其它资源目录是合理场景。
      const skillMdPath = nodePath.join(skillsDir, entry.name, SKILL_MD_FILENAME);
      if (await fileExists(skillMdPath)) {
        skills.push(await loadSkillFromDirectory(nodePath.join(skillsDir, entry.name)));
      }
    }
  }
  return skills;
}

// ---- loadAgent(dir, opts?) ----

/**
 * L3 目录约定层（docs/tech/core-sdk.md §4.7）：把一个 eve 布局的 agent 目录加载成
 * `AgentDefinition`。`opts.model` 优先于 `agent.ts`/`agent.json` 里的 model；
 * 两者都没提供 model 时报错带指导。
 */
export async function loadAgent(dir: string, opts: LoadAgentOptions = {}): Promise<AgentDefinition> {
  const absoluteDir = nodePath.resolve(dir);

  const instructions = await resolveInstructions(absoluteDir, opts);
  const configFromFile = await loadAgentConfigFile(absoluteDir);
  const tools = await loadToolsDir(absoluteDir);
  const skills = await loadSkillsDir(absoluteDir);

  const model = opts.model ?? configFromFile.model;
  if (model === undefined) {
    throw new Error(
      `loadAgent("${absoluteDir}"): no model configured — set "model" in ${AGENT_TS_FILENAME} or ${AGENT_JSON_FILENAME}, ` +
        "or pass loadAgent(dir, { model }).",
    );
  }

  return {
    model,
    instructions,
    ...(Object.keys(tools).length > 0 ? { tools } : {}),
    ...(configFromFile.builtinTools !== undefined ? { builtinTools: configFromFile.builtinTools } : {}),
    ...(skills.length > 0 ? { skills } : {}),
    ...(configFromFile.maxTurnsPerRun !== undefined ? { maxTurnsPerRun: configFromFile.maxTurnsPerRun } : {}),
    ...(configFromFile.maxOutputTokens !== undefined ? { maxOutputTokens: configFromFile.maxOutputTokens } : {}),
    ...(configFromFile.maxContextTokens !== undefined ? { maxContextTokens: configFromFile.maxContextTokens } : {}),
  };
}
