/**
 * Skills 注入三件事（docs/tech/core-sdk.md §4.6）：① `<available_skills>` system prompt 段
 * ② `ctx.getSkill(name)` 的真实现（读 skill 定义自带的 `files`，非 FS）
 * ③ 附属文件挂载到 `/.skills/<name>/`（经 `NimboFS.writeFile`）。三者都只消费
 * `Skill[]`，不关心 skill 是程序化 `defineSkill` 出来的还是 `loader.ts` 三加载器
 * 产出的——因此收在这个文件而不是 `loader.ts`（loader 管"怎么得到一个 Skill"，
 * registry 管"session 怎么用一批 Skill"），由 `session.ts` 接线。
 */
import type { NimboFS, SkillHandle } from "../types.js";
import type { Skill } from "../skill.js";

const textDecoder = new TextDecoder();

function decodeFileContent(content: string | Uint8Array): string {
  return typeof content === "string" ? content : textDecoder.decode(content);
}

/** skill 附属文件挂载目录的约定前缀（docs/tech/builtin-tools.md §1.9 / docs/tech/core-sdk.md §4.6 第 3 点）。 */
export function skillMountPath(skillName: string, relPath?: string): string {
  const base = `/.skills/${skillName}`;
  if (relPath === undefined) {return base;}
  return `${base}/${relPath}`;
}

/**
 * `<available_skills>` 段：每 skill 一行 `name: description`（docs/tech/core-sdk.md §4.6
 * 第 1 点）。`skills` 为空数组时返回 `undefined`——"agent.skills 非空时才注入"
 * 由调用方（`session.ts`）按这个返回值分支，不在这里编码"要不要拼进 system
 * prompt"的决策（那是 session 的组装职责）。
 */
export function buildAvailableSkillsBlock(skills: readonly Skill[]): string | undefined {
  if (skills.length === 0) {return undefined;}
  const lines = skills.map((skill) => `${skill.name}: ${skill.description}`);
  return `<available_skills>\n${lines.join("\n")}\n</available_skills>`;
}

/**
 * `ctx.getSkill` 的真实现（docs/tech/core-sdk.md §4.6 第 2 点 + §4.1 `ToolContext.getSkill`）：
 * 数据源是 skill 定义本身的 `files`，不经过 FS——即便这次 session 的 FS 没配置
 * 或还没挂载完，宿主工具仍然能靠 `getSkill` 读到附属文件内容。未知 skill 名/
 * 未知文件路径都在 `.text()` 被 await 时才抛（惰性，同 P4-1 占位实现的求值时机，
 * 见 `runtime.ts` 的 `createPlaceholderGetSkill`），不在 `getSkill(name)`/
 * `.file(relPath)` 这两个同步调用点抛——`SkillHandle`/`SkillFileHandle` 的
 * 接口形状（`types.ts`）决定了只有 `.text()` 是 `Promise`，没有别的地方能安全
 * reject。
 */
export function createGetSkill(skills: readonly Skill[]): (name: string) => SkillHandle {
  const index = new Map(skills.map((skill) => [skill.name, skill]));

  return (name: string): SkillHandle => ({
    file: (relPath: string) => ({
      text: async (): Promise<string> => {
        const skill = index.get(name);
        if (skill === undefined) {
          const available = [...index.keys()].join(", ") || "(none configured)";
          throw new Error(`getSkill("${name}") — no skill with that name is configured on this agent. Available skills: ${available}.`);
        }
        const content = skill.files?.[relPath];
        if (content === undefined) {
          const availableFiles = Object.keys(skill.files ?? {}).join(", ") || "(none)";
          throw new Error(
            `getSkill("${name}").file("${relPath}") — skill "${name}" has no attached file at "${relPath}". ` +
              `Its attached files: ${availableFiles}.`,
          );
        }
        return decodeFileContent(content);
      },
    }),
  });
}

/**
 * catch 子句里从 `unknown` 安全窄化出可读消息——受控例外，同款用法见
 * `runtime.ts`/`loop.ts`/`loader.ts` 的 `describeError`：只用于这一处收窄。
 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 附属文件挂载（docs/tech/core-sdk.md §4.6 第 3 点）：把每个 skill 的 `files` 经
 * `NimboFS.writeFile` 写入 `/.skills/<name>/`。"只读层"语义（挂载后 agent 不该
 * 能改写它）留给 P7 的门面（OverlayFS base 层）——这里只负责把字节写进去，用的
 * 是普通 `NimboFS` 接口，不假设具体实现。
 *
 * fs 未注入（`session.ts` 的占位 FS）且某个 skill 带 `files` 时，第一次
 * `writeFile` 调用本身就会以"注入 fs"为指引的错误 reject（占位 FS 的
 * `createUnconfiguredFS()` 每个方法都是如此）——这里捕获后再包一层技能名/路径
 * 上下文重新抛出，保留"指向注入 fs"的指引文案，同时让报错更好定位是哪个 skill
 * 的哪个文件触发的（工单原文"给指导性报错（指向注入 fs）"）。没有任何 skill
 * 带 `files` 时，这个函数完全不触碰 `fs`（不 `import`/不调用任何 FS 方法），因此
 * 占位 FS + 无附属文件的 skills 不受影响，与既有"fs 缺省"测试零冲突。
 */
export async function mountSkillFiles(fs: NimboFS, skills: readonly Skill[]): Promise<void> {
  for (const skill of skills) {
    if (skill.files === undefined) {continue;}
    for (const [relPath, content] of Object.entries(skill.files)) {
      const targetPath = skillMountPath(skill.name, relPath);
      try {
        await fs.writeFile(targetPath, content);
      } catch (error) {
        throw new Error(`Failed to mount skill "${skill.name}"'s attached file "${relPath}" to "${targetPath}": ${describeError(error)}`);
      }
    }
  }
}
