/**
 * [skill 清单](../../../../docs/terms.md)的扫描/落库形态，与
 * [skill 提及](../../../../docs/terms.md)的文本解析——docs/tech/composer-skill-mention.md
 * §5.1。
 *
 * 这个文件收着三类彼此独立、但都围绕「一个会话有哪些 skill 可用」的逻辑：
 *
 * 1. `loadSkillsFromWorkspace`：扫沙盒 `.agents/skills/*`，逐个 `Skill.fromFS`。
 *    `chat-agent.ts` 的 `buildSession` 每轮调它（取代本功能之前那行「硬读
 *    frontend-design 一个路径」）——用户在 composer 里点名的 skill 若没进
 *    `agent.skills`，模型调 `load-skill` 必然报 "No skill named ..."，所以
 *    「加载全部」是整个功能的前置条件（tech §1 改动 A）。
 * 2. `toSkillSummaries`：`Skill[]` → 可落库、可上 wire 的瘦身形态。
 *    清单缓存进 `conversations.available_skills_json` 而不是让前端现读沙盒，
 *    理由见 tech §2.1（沙盒会[休眠](../../../../docs/terms.md)，为列个菜单唤醒
 *    它，代价与收益完全不成比例）。
 * 3. `extractMentionedSkills` / `buildModelText`：把消息文本里的 `/<name>`
 *    标记翻译成给模型的一句明确指令。两个都是**纯函数、零 IO**，边界规则由
 *    单测逐行钉死（tech §5.1 那张表）。
 */
import type { RunkoFS, Skill } from '@runko/sdk';
import { Skill as SkillLoader } from '@runko/sdk';

import type { Logger } from '../logger.js';

const LOG_SCOPE = 'skill-catalog';

/**
 * 沙盒里 skill 的安装目录——与 `sandbox-manager.ts` 的安装脚本
 * （`npx skills add ... -a cursor`，落点 `.agents/skills/<name>/`）同一约定。
 * 改这里必须同步改那边的 `installSkill`/`cloneFallback`/`gitExclude` 三条脚本。
 */
export const SKILLS_DIR = '/.agents/skills';

/** 落库（`conversations.available_skills_json`）与上 wire 的清单条目。 */
export interface SkillSummary {
  /** 目录名，也是 `load-skill` 的入参与[skill 提及](../../../../docs/terms.md)的字面量。 */
  name: string;
  /** SKILL.md frontmatter 的 `description`，菜单里那行灰字。 */
  description: string;
}

/**
 * 沙盒初始化必装的那个 skill（`sandbox-manager.ts` 的 `installSkill` +
 * `cloneFallback` 两条脚本保证它一定在）——用作[skill 清单](../../../../docs/terms.md)
 * 的**兜底**。
 *
 * 为什么需要兜底：清单是缓存列，两种情况下会是空的——本功能上线**之前**建的会话
 * （那一列刚迁移出来，还没被任何一轮填过），以及缓存列因故读坏。这两种情况下沙盒里
 * 其实**装着** frontend-design，只是缓存不知道，结果就是用户打 `/` 什么都没有、
 * 以为功能坏了（2026-07-26 真机上就是这么撞见的）。
 *
 * 兜底是诚实的，不是撒谎：列的是沙盒里确实存在的东西。真实扫描结果一旦到位
 * （会话创建时、或该会话下一轮起轮时）就立刻取代它——见 `resolveSkillCatalog`。
 * 描述文案与 anthropics/skills 里 frontend-design 的 frontmatter 保持一致；那边改了
 * 这里也该跟着改，但即便暂时不同步，后果也只是菜单里那行说明略旧，不影响 `load-skill`
 * （它按名字查的是沙盒里的真身）。
 */
export const FALLBACK_SKILLS: readonly SkillSummary[] = [
  {
    name: 'frontend-design',
    description:
      'Make one focused, non-generic visual/interaction improvement to an existing web UI without rewriting it.',
  },
];

/**
 * 对外给的[skill 清单](../../../../docs/terms.md)：缓存有内容就用缓存，空了就退到
 * `FALLBACK_SKILLS`。
 *
 * 收在这一个函数里而不是散在路由和前端两处，是为了「兜底与否」只有一处判断——
 * 前端拿到的永远是一份可直接渲染的清单，不必自己关心它是扫出来的还是兜底的。
 */
export function resolveSkillCatalog(
  cached: readonly SkillSummary[],
): SkillSummary[] {
  return cached.length > 0 ? [...cached] : [...FALLBACK_SKILLS];
}

/** catch 子句里从 `unknown` 安全窄化出可读消息——受控例外，同款用法遍布本仓库。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 扫描并加载沙盒里全部 skill（docs/tech/composer-skill-mention.md §1 改动 A）。
 *
 * **best-effort，绝不抛**：这是每轮[起轮装配](../../../../docs/terms.md)的必经
 * 路径，一个坏 skill（缺 SKILL.md、缺 `description` frontmatter、读不动）不该
 * 拖垮整轮——跳过它 + 记一条 warn 就好。目录整个不存在时同理返回 `[]`，此时
 * `defineAgent` 不带 `skills`，core 走[条件内置](../../../../docs/terms.md)的既有
 * 语义（不注册 `load-skill`、不注入 `<available_skills>`），与本功能上线前逐字节
 * 一致（tech §6.3 的向后兼容约束）。
 *
 * 并发加载 + 结果按名字典序：远端沙盒上每个 skill 至少一次 `readdir` + 一次
 * `readFile`，串行就是 N+1 次网络往返；排序放在**加载之后**按名字重排，让
 * `<available_skills>` 段与前端菜单顺序一致、可预期（并发完成顺序不可预期）。
 */
export async function loadSkillsFromWorkspace(
  workspace: RunkoFS,
  log: Logger,
): Promise<Skill[]> {
  let dirNames: string[];
  try {
    const entries = await workspace.readdir(SKILLS_DIR);
    dirNames = entries
      .filter((entry) => entry.type === 'dir')
      .map((entry) => entry.name);
  } catch (error) {
    // 目录不存在是正常情形（沙盒还没装过 skill），不是错误——用 debug 档。
    log.debug(
      LOG_SCOPE,
      'skills directory not readable — no skills for this turn',
      {
        dir: SKILLS_DIR,
        error: describeError(error),
      },
    );
    return [];
  }

  const loaded = await Promise.all(
    dirNames.map(async (name): Promise<Skill | undefined> => {
      const path = `${SKILLS_DIR}/${name}`;
      try {
        return await SkillLoader.fromFS(workspace, path);
      } catch (error) {
        log.warn(LOG_SCOPE, 'skipped an unloadable skill directory', {
          path,
          error: describeError(error),
        });
        return undefined;
      }
    }),
  );

  return loaded
    .filter((skill): skill is Skill => skill !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** `Skill[]` → 落库/上 wire 的清单（丢掉 markdown 正文与附属文件）。 */
export function toSkillSummaries(skills: readonly Skill[]): SkillSummary[] {
  return skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
  }));
}

/** 正则元字符转义——skill 名来自目录名，不能直接拼进正则。 */
function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 一个 `/<name>` 命中要成立，紧跟其后的字符不得属于这一类——否则
 * `/frontend-design-extra` 会被误判成提及了 `frontend-design`，`/usr/local`
 * 会被误判成提及了 `usr`（若真有个 skill 叫这名）。行尾、空白、中英文标点都
 * 不在此列，所以 `/frontend-design，帮我...` 照常命中。
 */
const NAME_CONTINUATION = String.raw`[A-Za-z0-9_\-/]`;

/**
 * 从消息文本里扫出被提及的 skill 名（docs/tech/composer-skill-mention.md §5.1）。
 *
 * **按白名单逐个匹配**，不是「先用一个大正则捞出所有 `/xxx` 再过滤」：这样
 * 用户正常输入的路径（`/usr/local`、`cd /etc`）根本不会进入候选，也不必担心
 * 目录名里的正则元字符。命中规则两侧都收紧：
 *
 * - **左边**：必须是行首或空白。`x/frontend-design`（粘在别的字符后面，多半是
 *   条路径）不算提及。
 * - **右边**：不得是 `NAME_CONTINUATION` 那一类字符，即不做前缀匹配——已知
 *   `frontend-design` 时，`/frontend-design-extra` 不算命中。
 *
 * 返回值按 `known` 的顺序去重，同一个 skill 提两次只算一次。
 */
export function extractMentionedSkills(
  text: string,
  known: readonly string[],
): string[] {
  return known.filter((name) => {
    const pattern = new RegExp(
      String.raw`(^|\s)/${escapeForRegExp(name)}(?!${NAME_CONTINUATION})`,
    );
    return pattern.test(text);
  });
}

/**
 * 拼出发给模型的文本（docs/tech/composer-skill-mention.md §2.2）。
 *
 * **提及为空时原样返回同一个字符串**——不用这个功能的用户，喂给模型的字节与
 * 本功能上线前完全一致，零副作用。
 *
 * 这一行提示是「[软提示](../../../../docs/features/composer-skill-mention.md)」
 * 路线能真正生效的关键：只把 `/frontend-design` 留在文本里，对模型而言就是一串
 * 普通字符，没有任何理由让它去调 `load-skill`。措辞集中在这一处，方便日后按实测
 * 效果调；将来若要升级成「硬注入 SKILL.md 正文」，改动也只落在这个函数。
 */
export function buildModelText(
  text: string,
  mentioned: readonly string[],
): string {
  if (mentioned.length === 0) {
    return text;
  }
  const names = mentioned.join('、');
  return (
    `${text}\n\n` +
    `[系统提示] 用户在本条消息中显式指定了 skill：${names}。` +
    `请先调用 load-skill 工具逐个加载它们，再按其中的指引完成本次任务。`
  );
}
