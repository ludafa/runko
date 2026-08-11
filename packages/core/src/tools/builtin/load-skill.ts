/**
 * `load-skill`（docs/core/builtin-tools/tech.md §1.9）：调用返回该 skill 的 markdown 正文 +
 * 附属文件清单（提示可用 `read-file` 读 `/.skills/<name>/...`）。"loading a
 * skill adds instructions, never a new execution surface"（docs/core/core-sdk/tech.md §4.6 第
 * 2 点，eve 原话）——这个工具只返回文本，不触发任何副作用。
 *
 * 条件内置：仅在 `agent.skills` 非空时出现在工具列表，接线在 `session.ts` 的
 * `assembleTools`（与 `update-plan` 同款机制，但控制条件不同——不经
 * `builtinTools` 裁剪，只看 skills 是否配置，见 docs/core/builtin-tools/tech.md §3 原文
 * 括注）。
 */
import { z } from "zod";
import { defineTool } from "../../tool.js";
import type { JsonValue, Tool, ToolReturn } from "../../types.js";
import type { Skill } from "../../skill.js";
import { skillMountPath } from "../../skills/registry.js";

/**
 * docs/core/builtin-tools/tech.md §0.5 的"错误即指导"横切规则对全部工具生效（不止文件
 * 八件套）：失败返回 `{ isError: true, content }`，`content` 带下一步建议。
 * 索引签名的显式声明理由同 `@nimbo/virtual-fs` 的 `ToolErrorResult`（具名
 * interface 要落进 `ToolReturn` 的 `JsonValue` 对象分支，必须显式声明索引签名，
 * 否则 tsc 报"Index signature ... is missing"）——这里独立定义一份而不是从
 * virtual-fs 导入，因为 core 不能依赖 virtual-fs（见 `session.ts` 顶部注释
 * "fs 缺省"一节，同样的单向依赖约束）。
 */
interface ToolErrorResult {
  isError: true;
  content: string;
  [key: string]: JsonValue;
}

function errorResult(content: string): ToolErrorResult {
  return { isError: true, content };
}

const inputSchema = z.object({ name: z.string() });

export interface CreateLoadSkillToolOptions {
  skills: readonly Skill[];
}

function formatAttachedFiles(skill: Skill): string {
  const relPaths = Object.keys(skill.files ?? {});
  if (relPaths.length === 0) return "";
  const list = relPaths.map((relPath) => `- ${skillMountPath(skill.name, relPath)}`).join("\n");
  return `\n\n---\nAttached files (read them with read-file):\n${list}`;
}

export function createLoadSkillTool(opts: CreateLoadSkillToolOptions): Tool {
  const index = new Map(opts.skills.map((skill) => [skill.name, skill]));

  return defineTool({
    description:
      "Load the full instructions for a skill listed in <available_skills> by name. Loading a skill adds " +
      "instructions to follow — it does not grant any new capability or execution surface. Call this before " +
      "attempting a task that one of the available skills covers.",
    inputSchema,
    execute: (input): ToolReturn => {
      const skill = index.get(input.name);
      if (skill === undefined) {
        const available = [...index.keys()].join(", ") || "(none available)";
        return errorResult(`No skill named "${input.name}" is available. Available skills: ${available}.`);
      }
      return `${skill.markdown}${formatAttachedFiles(skill)}`;
    },
  });
}
