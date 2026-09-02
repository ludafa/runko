import path from 'node:path';
import { defineConfig, type DefaultTheme, type MarkdownRenderer } from 'vitepress';
import { withMermaid } from 'vitepress-plugin-mermaid';
import { collectDocs, titleOf, DOCS_ROOT, REPO_ROOT } from './docs.ts';
import { SECTIONS, NAV, VIEWS, REPO, REPO_BLOB } from './structure.ts';

const docs = collectDocs();
const sectionOf = (dir: string) => SECTIONS.find((s) => s.dir === dir);

/** 一个区段的入口链接：优先它指定的 landing，退而求其次取该段第一份 */
function landingLink(dir: string): string {
  const s = sectionOf(dir);
  const hit =
    docs.find((d) => d.section === dir && d.view === 'features' && d.slug === s?.landing) ??
    docs.find((d) => d.section === dir && d.view === 'features') ??
    docs.find((d) => d.section === dir);
  return hit ? hit.link : '/overview';
}

/* ── 顶部导航：一栏一个大层；层内分子段的（逻辑层、宿主层）做成下拉 ───── */
const nav: DefaultTheme.NavItem[] = [
  { text: '总览', link: '/overview' },
  ...NAV.flatMap((g): DefaultTheme.NavItem[] => {
    const dirs = g.dirs.filter((d) => docs.some((doc) => doc.section === d));
    if (dirs.length === 0) return [];
    const activeMatch = `^/(${g.dirs.map((d) => d.replace(/\//g, '\\/')).join('|')})/`;
    const only = dirs.length === 1 ? dirs[0] : undefined;
    if (only) return [{ text: g.text, link: landingLink(only), activeMatch }];
    return [
      {
        text: g.text,
        activeMatch,
        items: dirs.map((d) => ({ text: sectionOf(d)?.text ?? d, link: landingLink(d) })),
      },
    ];
  }),
  { text: '术语表', link: '/terms' },
];

/* ── 侧栏：一个区段一套，组内按视角（功能 / 技术方案 / 施工进展）──────
 * key 用区段的完整路径前缀（`/host/contract/` 而不是 `/host/`），VitePress 取
 * 最长匹配——于是宿主层每个环境各有自己的侧栏，观感跟只有一层时一样。 */
const sidebar: DefaultTheme.Sidebar = Object.fromEntries(
  SECTIONS.map((s) => {
    const groups = VIEWS.map((v) => ({
      text: v.text,
      collapsed: false,
      items: docs
        .filter((d) => d.section === s.dir && d.view === v.dir)
        .map((d) => ({ text: titleOf(d), link: d.link })),
    })).filter((g) => g.items.length > 0);
    return [`/${s.dir}/`, groups];
  }).filter(([, groups]) => Array.isArray(groups) && groups.length > 0),
);

/* ── 中文切词：CJK 切二元组，拉丁词整词 ──────────────────────────────
 * minisearch 默认按空白和标点切，对中文等于不切——整句变成一个 token，
 * 搜「归属仲裁」命中不了「归属仲裁机制」。切成二元组即可。
 * 不额外产出单字：searchOptions 开了 prefix，单字查询会走前缀匹配命中二元组，
 * 而多产一倍 token 会把索引撑大近一倍。 */
function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const seg of text.split(/[\s\p{P}\p{S}]+/u)) {
    if (!seg) continue;
    if (/[㐀-鿿぀-ヿ]/.test(seg)) {
      if (seg.length === 1) out.push(seg);
      for (let i = 0; i + 1 < seg.length; i++) out.push(seg.slice(i, i + 2));
    } else {
      out.push(seg);
    }
  }
  return out;
}

/* ── 出站链接改写：docs/ 之外的相对链接 → GitHub 地址 ─────────────── */
function rewriteOutboundLinks(md: MarkdownRenderer): void {
  // 用 VitePress 自己的 renderer 类型推出规则签名，不去引 markdown-it 的内部路径
  // （那条路径随 @types/markdown-it 的 .d.mts 布局变，NodeNext 下会解析不到）
  type LinkRule = NonNullable<typeof md.renderer.rules.link_open>;
  const original: LinkRule =
    md.renderer.rules.link_open ?? ((tokens, i, opts, _env, self) => self.renderToken(tokens, i, opts));

  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const href = token?.attrGet('href');
    const from: string | undefined = env?.relativePath;
    if (token && href && from && !/^(https?:|mailto:|#|\/)/.test(href)) {
      const [pathPart, hash] = splitHash(href);
      if (pathPart) {
        const abs = path.resolve(path.dirname(path.join(DOCS_ROOT, from)), pathPart);
        if (!abs.startsWith(DOCS_ROOT + path.sep)) {
          token.attrSet('href', `${REPO_BLOB}/${path.relative(REPO_ROOT, abs)}${hash}`);
          token.attrSet('target', '_blank');
          token.attrSet('rel', 'noreferrer');
        }
      }
    }
    return original(tokens, idx, options, env, self);
  };
}

function splitHash(href: string): [string, string] {
  const i = href.indexOf('#');
  return i === -1 ? [href, ''] : [href.slice(0, i), href.slice(i)];
}

export default withMermaid(
  defineConfig({
    title: 'runko',
    description: '可嵌入 Node.js 应用的轻量 agent SDK —— 设计文档',
    lang: 'zh-CN',
    cleanUrls: true,
    lastUpdated: true,
    // 独立部署用：放在域名根下不用设；部署到子路径（GitHub Pages 的
    // https://<user>.github.io/runko/）时 `DOCS_BASE=/runko/ pnpm build`，不用改配置
    base: process.env.DOCS_BASE ?? '/',
    // 本包的 README 是给「要动这个站」的人看的，不是站上的一页
    srcExclude: ['**/README.md', '**/node_modules/**'],
    // 死链检查保持打开：出站链接已在上面改写成绝对地址，站内链接必须真实存在
    ignoreDeadLinks: false,
    markdown: {
      lineNumbers: false,
      config: rewriteOutboundLinks,
    },
    themeConfig: {
      nav,
      sidebar,
      outline: { level: [2, 3], label: '本页目录' },
      search: {
        provider: 'local',
        options: {
          locales: {
            root: {
              translations: {
                button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
                modal: {
                  displayDetails: '展开详情',
                  resetButtonTitle: '清除',
                  noResultsText: '没找到',
                  footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' },
                },
              },
            },
          },
          miniSearch: {
            options: { tokenize, processTerm: (t: string) => t.toLowerCase() },
            searchOptions: {
              fuzzy: 0.2,
              prefix: true,
              boost: { title: 4, titles: 2, text: 1 },
            },
          },
        },
      },
      socialLinks: [{ icon: 'github', link: REPO }],
      editLink: { pattern: `${REPO_BLOB}/docs/:path`, text: '在 GitHub 上编辑此页' },
      docFooter: { prev: '上一篇', next: '下一篇' },
      lastUpdatedText: '最后更新',
      returnToTopLabel: '回到顶部',
      darkModeSwitchLabel: '主题',
      sidebarMenuLabel: '目录',
      footer: {
        message: '按架构分层组织：agent 逻辑层三块、宿主层按环境分档，每段再分功能 / 技术方案 / 施工进展。',
        copyright: `<a href="${REPO}">github.com/ludafa/runko</a>`,
      },
    },
  }),
);
