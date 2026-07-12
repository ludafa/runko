/**
 * `loadAgentFromFS(fs, dir, opts?)`：L3 目录约定层的虚拟 FS 版本（tech-spec
 * §4.7；P7-3 工单任务 3）——nimbo 独有（eve 没有这个形态）："agent 定义本身也
 * 可以是虚拟的"。只加载 `instructions.md` 与 `skills/`（复用 `Skill.fromFS`），
 * **刻意不加载 `agent.ts`/`agent.json`/`tools/*.ts`**——§4.7 原文："不引入任意
 * 代码执行面"，`loadAgent`（`load-agent.ts`）的 `import()` 对真实磁盘路径尚且
 * 只是"读取宿主本来就信任的本地文件"，但虚拟 FS 里的内容可能来自任意来源
 * （网络下载、模型自己写入的文件、另一个沙盒……），对它做代码求值就是在这些
 * 来源上开一个执行面，与虚拟 FS 想要提供的沙盒边界直接冲突。
 *
 * ---- `agent.json` 为什么也不读（裁量，工单原文只写"只加载 instructions 与
 * skills"，未单列 agent.json） ----
 *
 * `agent.json` 本身是纯数据、JSON.parse 不构成代码执行，单看这一点它和
 * `instructions.md`/skills 的风险级别一致，本可以加载。但不读的理由是**保持
 * 这个函数的事实来源单一、可预测**：`loadAgentFromFS` 的心智模型是"model 等
 * 运行配置永远来自 `opts`，`dir` 只提供 instructions/skills 这两类内容资产"——
 * 一旦 `agent.json` 也能覆盖 model/maxTurnsPerRun 等字段，调用方要同时检查
 * `opts` 与虚拟 FS 里的 `agent.json` 才能确定最终配置，且需要一套新的"两者都有
 * 时谁赢"优先级规则（`loadAgent` 里 `opts.model` 覆盖 `agent.ts` 的规则不能
 * 直接照搬，因为 `loadAgentFromFS` 没有"先读文件再决定要不要用 opts 覆盖"的
 * 中间态）。工单原文的措辞（"只加载 instructions 与 skills"）与这个更简单的
 * 心智模型一致，因此按字面实现。
 *
 * ---- `dir` 下存在 `tools/` 时的行为（工单裁量点，建议"忽略") ----
 *
 * 选择**忽略**（不读取、不报错、不警告）：`tools/*.ts` 本来就是"不引入任意代码
 * 执行面"这条规则的直接冲突对象（工具的 `execute()` 是真正会被调用执行的代码，
 * 比 `agent.json` 的数据读取更进一步），刻意不做任何特殊处理——虚拟 FS 里有没有
 * `tools/` 目录对这个函数的行为完全不可见。工具改为**宿主程序化传入**
 * （`opts.tools`，与 `agent.tools` 字段同形状），这是 `Tool` 对象本来就该经代码
 * 构造（`defineTool(...)`）而非从数据反序列化的自然延伸——宿主本来就要在自己的
 * 进程里写这些 `Tool` 实现，`loadAgentFromFS` 没有理由替它去虚拟 FS 里"发现"。
 */
import type { LanguageModel } from "ai";
import type { AgentDefinition, BuiltinToolName } from "../agent.js";
import { loadSkillFromFS, loadSkillFromMarkdown } from "../skills/loader.js";
import type { Skill } from "../skill.js";
import type { DirEntry, NimboFS, Tool } from "../types.js";

export interface LoadAgentFromFSOptions {
  /** 必需——见本文件头，永远不从 `dir` 读取。 */
  model?: LanguageModel;
  /** `instructions.md` 缺失时的兜底来源；文件存在时优先用文件内容。 */
  instructions?: string;
  /** 宿主程序化传入的工具（本文件头"tools/ 时的行为"一节）；不从 `dir` 加载。 */
  tools?: Record<string, Tool>;
  builtinTools?: BuiltinToolName[] | false;
  maxTurnsPerRun?: number;
  maxOutputTokens?: number;
  maxContextTokens?: number;
}

const INSTRUCTIONS_FILENAME = "instructions.md";
const SKILLS_DIRNAME = "skills";
const SKILL_MD_FILENAME = "SKILL.md";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function joinVirtualPath(parentDir: string, name: string): string {
  const trimmed = parentDir === "/" ? "" : parentDir.replace(/\/+$/, "");
  return `${trimmed}/${name}`;
}

async function resolveInstructionsFromFS(fs: NimboFS, dir: string, opts: LoadAgentFromFSOptions): Promise<string> {
  const path = joinVirtualPath(dir, INSTRUCTIONS_FILENAME);
  try {
    return new TextDecoder().decode(await fs.readFile(path));
  } catch (error) {
    if (opts.instructions !== undefined) return opts.instructions;
    throw new Error(
      `loadAgentFromFS(fs, "${dir}"): could not read required "${INSTRUCTIONS_FILENAME}" at "${path}": ` +
        `${describeError(error)} Add the file, or pass loadAgentFromFS(fs, dir, { instructions: "..." }).`,
    );
  }
}

/** `stat()` 用于探测 packaged skill 目录下有没有 SKILL.md；探测失败（不存在/任意错误）一律当"没有"处理，不让探测本身抛错中断加载。 */
async function hasEntry(fs: NimboFS, path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function loadSkillsDirFromFS(fs: NimboFS, dir: string): Promise<Skill[]> {
  const skillsDir = joinVirtualPath(dir, SKILLS_DIRNAME);
  let entries: DirEntry[];
  try {
    entries = await fs.readdir(skillsDir);
  } catch {
    return []; // 没有 skills/ 目录：不是错误，只是这个 agent 没有 skill。
  }

  const skills: Skill[] = [];
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const childPath = joinVirtualPath(skillsDir, entry.name);
    if (entry.type === "file" && entry.name.endsWith(".md")) {
      const markdown = new TextDecoder().decode(await fs.readFile(childPath));
      skills.push(loadSkillFromMarkdown(entry.name.slice(0, -".md".length), markdown));
    } else if (entry.type === "dir") {
      // packaged skill 的判据同 load-agent.ts：子目录下有没有 SKILL.md；没有就跳过，不报错。
      if (await hasEntry(fs, joinVirtualPath(childPath, SKILL_MD_FILENAME))) {
        skills.push(await loadSkillFromFS(fs, childPath));
      }
    }
    // "reference" 条目：不是可能包含 skill 的本地内容，跳过。
  }
  return skills;
}

/**
 * L3 目录约定层，虚拟 FS 版本（tech-spec §4.7）。只读 `instructions.md` 与
 * `skills/`（本文件头）；`opts.model` 必需——本函数从不读取/求值
 * `agent.ts`/`agent.json`/`tools/*.ts`。
 */
export async function loadAgentFromFS(fs: NimboFS, dir: string, opts: LoadAgentFromFSOptions = {}): Promise<AgentDefinition> {
  const instructions = await resolveInstructionsFromFS(fs, dir, opts);
  const skills = await loadSkillsDirFromFS(fs, dir);

  const model = opts.model;
  if (model === undefined) {
    throw new Error(
      `loadAgentFromFS(fs, "${dir}"): no model configured — this loader never evaluates agent.ts/agent.json ` +
        "(tech-spec §4.7: no arbitrary code execution surface over a virtual FS), so pass " +
        "loadAgentFromFS(fs, dir, { model }).",
    );
  }

  return {
    model,
    instructions,
    ...(opts.tools !== undefined && Object.keys(opts.tools).length > 0 ? { tools: opts.tools } : {}),
    ...(opts.builtinTools !== undefined ? { builtinTools: opts.builtinTools } : {}),
    ...(skills.length > 0 ? { skills } : {}),
    ...(opts.maxTurnsPerRun !== undefined ? { maxTurnsPerRun: opts.maxTurnsPerRun } : {}),
    ...(opts.maxOutputTokens !== undefined ? { maxOutputTokens: opts.maxOutputTokens } : {}),
    ...(opts.maxContextTokens !== undefined ? { maxContextTokens: opts.maxContextTokens } : {}),
  };
}
