/**
 * Skill 三加载器（tech-spec §4.1 `Skill.fromDirectory`/`fromFS`/`fromMarkdown`；
 * frontmatter 规则同 §4.1 末段 + 04-builtin-tools.md §1.9）。纯加载逻辑，不含
 * 注入/挂载/prompt 拼装（那些在 `registry.ts`，由 `session.ts` 接线）。
 *
 * frontmatter 自实现（工单要求不引 yaml/frontmatter 三方库）：只认文件最开头的
 * `---\n...\n---\n` 块，块内是逐行 `key: value`（可选引号包裹的值），不支持嵌套
 * 结构/多行值——这与 Anthropic 官方 SKILL.md 和 eve 的实际用法（仅
 * name/description/license 等标量字段）相符，够用即止。
 *
 * 两个 packaged 加载器（fromDirectory 读真实磁盘、fromFS 读 NimboFS）共享同一套
 * frontmatter 解析与"缺 description 即报错"规则，只是取文件内容/枚举附属文件的
 * I/O 后端不同——因此下方把两者的"解析 SKILL.md 正文"部分收敛成一个共享函数
 * `parsePackagedSkillMarkdown`，读文件与遍历目录的部分各自实现（分别用
 * `node:fs/promises` 与 `NimboFS`，无法共享）。
 */
import * as nodeFs from "node:fs/promises";
import * as nodePath from "node:path";
import type { NimboFS } from "../types.js";
import type { Skill } from "../skill.js";

// ---- frontmatter：--- 块 + 简单 key: value，无第三方依赖 ----

interface ParsedFrontmatter {
  data: Record<string, string>;
  /** frontmatter 块（含首尾 `---` 分隔行）被剥离后的剩余正文；无 frontmatter 时等于原文本。 */
  body: string;
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;

function stripQuotes(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

/** frontmatter 只在文本最开头才生效（标准约定），不允许前导空行/空白。 */
function parseFrontmatter(text: string): ParsedFrontmatter {
  const match = text.match(FRONTMATTER_PATTERN);
  if (match === null) return { data: {}, body: text };

  const rawBlock = match[1] ?? "";
  const body = text.slice(match[0].length);
  const data: Record<string, string> = {};
  for (const line of rawBlock.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) continue; // 不识别的行（如嵌套列表）直接忽略，够用即止
    const key = line.slice(0, separatorIndex).trim();
    const value = stripQuotes(line.slice(separatorIndex + 1).trim());
    if (key !== "") data[key] = value;
  }
  return { data, body };
}

/**
 * flat skill 无 frontmatter（或 frontmatter 缺 description）时的兜底：取首个
 * 非空、非代码块的行，原样（trim 后）作为 description。代码块用 ``` / ~~~
 * 围栏识别，围栏行本身与围栏内的行都跳过。找不到合格行时返回空字符串——不是
 * 工单要求的报错场景（那是 packaged skill 专属规则）。
 */
function deriveDescriptionFromFirstLine(markdown: string): string {
  let inFencedBlock = false;
  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("```") || line.startsWith("~~~")) {
      inFencedBlock = !inFencedBlock;
      continue;
    }
    if (inFencedBlock) continue;
    if (line === "") continue;
    return line;
  }
  return "";
}

/**
 * catch 子句里从 `unknown` 安全窄化出可读消息——受控例外，同款用法见
 * `runtime.ts`/`loop.ts` 的 `describeError`：只用于这一处收窄。
 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** packaged skill 的 SKILL.md 正文解析：两个 I/O 后端（fromDirectory/fromFS）共享。 */
function parsePackagedSkillMarkdown(raw: string, name: string, sourceDescription: string): { markdown: string; description: string } {
  const { data, body } = parseFrontmatter(raw);
  const description = data.description;
  if (description === undefined || description === "") {
    throw new Error(
      `Skill "${name}" (${sourceDescription}) is missing the required "description" frontmatter field. ` +
        'Packaged skills must start SKILL.md with a frontmatter block, e.g.:\n---\ndescription: what this skill does and when to use it\n---',
    );
  }
  return { markdown: body, description };
}

function toFilesRecord(files: Record<string, Uint8Array>): Record<string, Uint8Array> | undefined {
  return Object.keys(files).length > 0 ? files : undefined;
}

// ---- fromDirectory：packaged skill 在真实磁盘上的形态 ----

const SKILL_MD_FILENAME = "SKILL.md";

async function collectRealDirectoryFiles(rootDir: string, exclude: string): Promise<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = {};

  async function walk(dir: string, relDir: string): Promise<void> {
    const entries = (await nodeFs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (relDir === "" && entry.name === exclude) continue;
      const relPath = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
      const fullPath = nodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath, relPath);
      } else if (entry.isFile()) {
        files[relPath] = await nodeFs.readFile(fullPath);
      }
    }
  }

  await walk(rootDir, "");
  return files;
}

/** packaged skill：读 `<path>/SKILL.md` + 附属文件（tech-spec §4.1）；`name` 取目录 basename。 */
export async function loadSkillFromDirectory(path: string): Promise<Skill> {
  const name = nodePath.basename(path);
  const skillMdPath = nodePath.join(path, SKILL_MD_FILENAME);

  let raw: string;
  try {
    raw = await nodeFs.readFile(skillMdPath, "utf8");
  } catch (error) {
    throw new Error(
      `Skill.fromDirectory("${path}") could not read "${skillMdPath}": ${describeError(error)} ` +
        "A packaged skill directory must contain a SKILL.md file.",
    );
  }

  const { markdown, description } = parsePackagedSkillMarkdown(raw, name, `${path}/${SKILL_MD_FILENAME}`);
  const files = toFilesRecord(await collectRealDirectoryFiles(path, SKILL_MD_FILENAME));
  return { name, description, markdown, ...(files !== undefined ? { files } : {}) };
}

// ---- fromFS：packaged skill 跑在 NimboFS 上（同语义，I/O 后端换成 fs） ----

function joinVirtualPath(base: string, segment: string): string {
  const trimmedBase = base === "/" ? "" : base.replace(/\/+$/, "");
  return `${trimmedBase}/${segment}`;
}

function virtualBasename(path: string): string {
  const segments = path.split("/").filter((s) => s.length > 0);
  return segments[segments.length - 1] ?? path;
}

async function collectFSFiles(fs: NimboFS, rootPath: string, exclude: string): Promise<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = {};
  const normalizedRoot = rootPath === "/" ? "/" : rootPath.replace(/\/+$/, "");

  async function walk(dirPath: string, relDir: string): Promise<void> {
    const entries = [...(await fs.readdir(dirPath))].sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (relDir === "" && entry.name === exclude) continue;
      const relPath = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
      const fullPath = joinVirtualPath(dirPath, entry.name);
      if (entry.type === "dir") {
        await walk(fullPath, relPath);
      } else if (entry.type === "file") {
        files[relPath] = await fs.readFile(fullPath);
      }
      // "reference" 条目跳过：没有可读取的本地字节内容（tech-spec §4.4），skill
      // 附属文件语义要求可直接读到内容，reference 条目不满足这个前提。
    }
  }

  await walk(normalizedRoot, "");
  return files;
}

/** packaged skill，同语义跑在 `NimboFS` 上（tech-spec §4.1）。 */
export async function loadSkillFromFS(fs: NimboFS, path: string): Promise<Skill> {
  const name = virtualBasename(path);
  const skillMdPath = joinVirtualPath(path, SKILL_MD_FILENAME);

  let raw: string;
  try {
    raw = new TextDecoder().decode(await fs.readFile(skillMdPath));
  } catch (error) {
    throw new Error(
      `Skill.fromFS(fs, "${path}") could not read "${skillMdPath}": ${describeError(error)} ` +
        "A packaged skill directory must contain a SKILL.md file.",
    );
  }

  const { markdown, description } = parsePackagedSkillMarkdown(raw, name, `${path}/${SKILL_MD_FILENAME}`);
  const files = toFilesRecord(await collectFSFiles(fs, path, SKILL_MD_FILENAME));
  return { name, description, markdown, ...(files !== undefined ? { files } : {}) };
}

// ---- fromMarkdown：flat skill（eve 的 skills/*.md 形态） ----

/**
 * flat skill：无文件系统可推导 name，调用方显式传入。frontmatter 可选——有就取
 * `description` 字段（body 剥离 frontmatter 块）；没有（或没写 description）则从
 * 首个非空非代码行推导，此时 `markdown` 就是原始文本（无需剥离，因为没找到块）。
 */
export function loadSkillFromMarkdown(name: string, markdown: string): Skill {
  const { data, body } = parseFrontmatter(markdown);
  if (data.description !== undefined && data.description !== "") {
    return { name, description: data.description, markdown: body };
  }
  return { name, description: deriveDescriptionFromFirstLine(body), markdown: body };
}
