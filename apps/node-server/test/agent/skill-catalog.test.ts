/**
 * `agent/skill-catalog.ts`（docs/tech/composer-skill-mention.md §5.1）：
 *
 * 1. `loadSkillsFromWorkspace` —— 扫沙盒 `.agents/skills/*`。重点是**它绝不抛**：
 *    这是每轮[起轮装配](../../../../docs/terms.md)的必经路径，一个坏 skill 不该
 *    拖垮整轮。
 * 2. `toSkillSummaries` —— 瘦身成可落库形态。
 * 3. `extractMentionedSkills` / `buildModelText` —— 纯函数，边界规则逐行钉死
 *    （tech §5.1 那张表就是下面的用例）。
 */
import { MemoryFS } from '@nimbo/sdk';
import { describe, expect, it } from 'vitest';

import {
  buildModelText,
  extractMentionedSkills,
  FALLBACK_SKILLS,
  loadSkillsFromWorkspace,
  resolveSkillCatalog,
  toSkillSummaries,
} from '../../src/agent/skill-catalog.js';
import { createLogger } from '../../src/logger.js';
import { silentLogger } from '../helpers/silent-logger.js';

function skillMarkdown(description: string, title: string): string {
  return `---\ndescription: ${description}\n---\n# ${title}\n`;
}

async function fsWithSkills(
  entries: Record<string, string>,
): Promise<MemoryFS> {
  const fs = new MemoryFS();
  for (const [path, content] of Object.entries(entries)) {
    await fs.writeFile(path, content);
  }
  return fs;
}

describe('loadSkillsFromWorkspace', () => {
  it('loads every skill directory and sorts them by name', async () => {
    const fs = await fsWithSkills({
      '/.agents/skills/frontend-design/SKILL.md': skillMarkdown(
        'Improve an existing web UI.',
        'frontend-design',
      ),
      '/.agents/skills/code-review/SKILL.md': skillMarkdown(
        'Review a diff for defects.',
        'code-review',
      ),
    });

    const skills = await loadSkillsFromWorkspace(fs, silentLogger);

    // 字典序，不是文件系统返回顺序——`<available_skills>` 段与前端菜单要一致可预期。
    expect(skills.map((s) => s.name)).toEqual([
      'code-review',
      'frontend-design',
    ]);
    expect(skills[0]?.description).toBe('Review a diff for defects.');
  });

  it('returns an empty array (never throws) when the skills directory does not exist', async () => {
    const fs = new MemoryFS();

    await expect(loadSkillsFromWorkspace(fs, silentLogger)).resolves.toEqual(
      [],
    );
  });

  it('skips an unloadable skill directory and keeps the good ones, logging a warning', async () => {
    const fs = await fsWithSkills({
      '/.agents/skills/frontend-design/SKILL.md': skillMarkdown(
        'Improve an existing web UI.',
        'frontend-design',
      ),
      // 有目录、没 SKILL.md —— `Skill.fromFS` 会抛，必须被吞掉
      '/.agents/skills/broken/README.md': '# not a skill',
    });
    const lines: string[] = [];
    const log = createLogger({
      level: 'debug',
      sink: (line) => lines.push(line),
    });

    const skills = await loadSkillsFromWorkspace(fs, log);

    expect(skills.map((s) => s.name)).toEqual(['frontend-design']);
    expect(
      lines.some(
        (line) =>
          line.includes('skipped an unloadable skill directory') &&
          line.includes('broken'),
      ),
    ).toBe(true);
  });

  it('skips a packaged skill whose frontmatter has no description', async () => {
    const fs = await fsWithSkills({
      '/.agents/skills/no-desc/SKILL.md': '# no frontmatter at all\n',
      '/.agents/skills/frontend-design/SKILL.md': skillMarkdown(
        'Improve an existing web UI.',
        'frontend-design',
      ),
    });

    const skills = await loadSkillsFromWorkspace(fs, silentLogger);

    expect(skills.map((s) => s.name)).toEqual(['frontend-design']);
  });

  it('ignores plain files sitting next to the skill directories', async () => {
    const fs = await fsWithSkills({
      '/.agents/skills/README.md': '# these are the skills',
      '/.agents/skills/frontend-design/SKILL.md': skillMarkdown(
        'Improve an existing web UI.',
        'frontend-design',
      ),
    });

    const skills = await loadSkillsFromWorkspace(fs, silentLogger);

    expect(skills.map((s) => s.name)).toEqual(['frontend-design']);
  });
});

describe('toSkillSummaries', () => {
  it('keeps only name + description, dropping markdown and attached files', () => {
    const summaries = toSkillSummaries([
      {
        name: 'frontend-design',
        description: 'Improve an existing web UI.',
        markdown: '# a very long body\n'.repeat(100),
        files: { 'ref.md': 'attached' },
      },
    ]);

    expect(summaries).toEqual([
      { name: 'frontend-design', description: 'Improve an existing web UI.' },
    ]);
  });
});

describe('resolveSkillCatalog', () => {
  it('uses the cached catalog when it has anything in it', () => {
    const cached = [{ name: 'code-review', description: 'Review a diff.' }];

    expect(resolveSkillCatalog(cached)).toEqual(cached);
  });

  it('falls back to the always-installed skill when the cache is empty', () => {
    // 本功能上线前建的会话就是这一档：缓存列刚迁移出来、还没被任何一轮填过，
    // 但沙盒里其实装着 frontend-design。不兜底的话用户打 `/` 什么都没有。
    const resolved = resolveSkillCatalog([]);

    expect(resolved.map((s) => s.name)).toEqual(['frontend-design']);
    expect(resolved[0]?.description).not.toBe('');
  });

  it('never hands back the shared fallback array itself', () => {
    // 返回的是拷贝——调用方（路由把它塞进 DTO）改动结果不该污染模块级常量。
    const a = resolveSkillCatalog([]);
    const b = resolveSkillCatalog([]);

    expect(a).not.toBe(b);
    expect(a).not.toBe(FALLBACK_SKILLS);
  });
});

describe('extractMentionedSkills', () => {
  const known = ['frontend-design', 'code-review'];

  it('finds a mention at the start of the message', () => {
    expect(
      extractMentionedSkills('/frontend-design 帮我看看首页排版', known),
    ).toEqual(['frontend-design']);
  });

  it('finds a mention after whitespace, mid-message', () => {
    expect(extractMentionedSkills('先读一下 /code-review 再说', known)).toEqual(
      ['code-review'],
    );
  });

  it('finds a mention at the very end of the message', () => {
    expect(extractMentionedSkills('按这个来做 /code-review', known)).toEqual([
      'code-review',
    ]);
  });

  it('finds several distinct mentions in one message', () => {
    expect(
      extractMentionedSkills('/frontend-design 然后 /code-review', known),
    ).toEqual(['frontend-design', 'code-review']);
  });

  it('de-duplicates a skill mentioned twice', () => {
    expect(
      extractMentionedSkills('/frontend-design 和 /frontend-design', known),
    ).toEqual(['frontend-design']);
  });

  it('ignores a path that merely looks like a mention', () => {
    // 这是最重要的一条：用户正常聊到路径，不该被当成提及。
    expect(extractMentionedSkills('看一下 /usr/local 目录', known)).toEqual([]);
  });

  it('ignores a slash-name glued to a preceding character', () => {
    expect(extractMentionedSkills('x/frontend-design', known)).toEqual([]);
    expect(extractMentionedSkills('src/code-review', known)).toEqual([]);
  });

  it('does not prefix-match — the name has to end where the mention ends', () => {
    expect(extractMentionedSkills('/frontend-design-extra', known)).toEqual([]);
    expect(extractMentionedSkills('/code-review/sub', known)).toEqual([]);
  });

  it('still matches when punctuation follows the mention', () => {
    expect(extractMentionedSkills('/frontend-design，看看排版', known)).toEqual(
      ['frontend-design'],
    );
    expect(extractMentionedSkills('用 /code-review。', known)).toEqual([
      'code-review',
    ]);
  });

  it('matches across line breaks', () => {
    expect(
      extractMentionedSkills('第一行\n/code-review 第二行', known),
    ).toEqual(['code-review']);
  });

  it('returns nothing when no skills are known, whatever the text says', () => {
    expect(extractMentionedSkills('/frontend-design 帮我改', [])).toEqual([]);
  });

  it('treats a bare slash as ordinary text', () => {
    expect(extractMentionedSkills('a / b', known)).toEqual([]);
  });
});

describe('buildModelText', () => {
  it('returns the exact same string when nothing was mentioned', () => {
    const text = '帮我看看首页排版';

    // 零副作用：不用这个功能的用户，喂给模型的字节与本功能上线前完全一致。
    expect(buildModelText(text, [])).toBe(text);
  });

  it('appends an instruction naming the mentioned skill', () => {
    const out = buildModelText('/frontend-design 改排版', ['frontend-design']);

    expect(out).toContain('/frontend-design 改排版');
    expect(out).toContain('frontend-design');
    expect(out).toContain('load-skill');
  });

  it('names every mentioned skill in one instruction', () => {
    const out = buildModelText('两个都要', ['frontend-design', 'code-review']);

    expect(out).toContain('frontend-design、code-review');
  });

  it('keeps the user text first, instruction after', () => {
    const out = buildModelText('用户原话', ['code-review']);

    expect(out.startsWith('用户原话')).toBe(true);
  });
});
