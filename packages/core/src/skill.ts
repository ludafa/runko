/**
 * L1 定义层：Skill 数据类型、`defineSkill`、三个加载器（docs/tech/core-sdk.md §4.1）。
 * SKILL.md 解析/frontmatter 规则/附属文件枚举的实际实现在 `./skills/loader.js`
 * （P5）；本文件只做数据类型 + `defineSkill` 恒等函数 + 把三个加载器函数收敛
 * 成 spec 字面签名的 `Skill.fromDirectory/fromFS/fromMarkdown` 呈现形态。
 *
 * ---- 类型/值同名的呈现形态（工单要求"选定后注释说明"） ----
 *
 * spec §4.1 原文：
 *   const Skill: { fromDirectory(path): Promise<Skill>; fromFS(fs, path): Promise<Skill>; fromMarkdown(name, md): Skill; };
 * 这里按字面实现——`export interface Skill {...}`（上方，类型空间）与下方
 * `export const Skill = {...}`（值空间）在同一模块内共存，两者互不冲突：
 * TypeScript 的接口声明只占用类型空间，`const` 声明只占用值空间，`Skill` 这个
 * 标识符因此可以同时是"一个类型"和"一个值"而不产生声明冲突或合并——这与
 * `NimboFS` 的先例（P2-1 `fromMemory`/`fromDirectory` 改成独立导出函数）是
 * 不同的情形：那里 `NimboFS` 类型在 `@nimbo/core`、构造函数要放在
 * `@nimbo/virtual-fs`，是**跨包**的 interface+namespace 合并，TS 不支持跨模块
 * 合并声明；这里类型和值在同一个文件里各自声明，根本不涉及"合并"，只是两个
 * 独立声明恰好同名、分别落在类型/值两个空间，合法且是常见的 TS 惯用法（例如
 * `interface Foo {} const Foo = { create(): Foo {...} }`）。选择这个形态而非
 * 独立导出函数（`fromDirectory`/`fromFS`/`fromMarkdown`），是因为这里同名不冲突、
 * 能忠实还原 spec 的 `Skill.xxx(...)` 调用形态，给 eve 迁移用户零心智差异。
 */
import { loadSkillFromDirectory, loadSkillFromFS, loadSkillFromMarkdown } from "./skills/loader.js";
import type { NimboFS } from "./types.js";

/** 程序化定义的 skill（eve 同款）。SKILL.md 正文 + 可选附属文件。 */
export interface Skill {
  /** 程序化定义需显式 name（无文件名可推导）。 */
  name: string;
  description: string;
  /** SKILL.md 正文。 */
  markdown: string;
  files?: Record<string, string | Uint8Array>;
}

/** 恒等函数：价值在类型推导与将来扩展位，不做任何运行时校验/拷贝。 */
export function defineSkill(def: Skill): Skill {
  return def;
}

/**
 * 三个加载器（docs/tech/core-sdk.md §4.1，规则见 `./skills/loader.js` 头注释）：
 * - `fromDirectory(path)`：packaged skill，真实磁盘上的 `<path>/SKILL.md` + 附属文件；
 * - `fromFS(fs, path)`：同语义，跑在任意 `NimboFS` 上；
 * - `fromMarkdown(name, md)`：flat skill（eve 的 `skills/*.md` 形态），同步。
 *
 * 三者对 frontmatter 的处理一致：packaged（fromDirectory/fromFS）要求
 * `description` frontmatter，缺失即抛错；flat（fromMarkdown）frontmatter 可选，
 * 缺失（或缺 description 字段）时取首个非空非代码行推导 description。
 */
export const Skill: {
  fromDirectory(path: string): Promise<Skill>;
  fromFS(fs: NimboFS, path: string): Promise<Skill>;
  fromMarkdown(name: string, md: string): Skill;
} = {
  fromDirectory: loadSkillFromDirectory,
  fromFS: loadSkillFromFS,
  fromMarkdown: loadSkillFromMarkdown,
};
