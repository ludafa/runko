/**
 * 扫 docs/ 下的全部 markdown，读出 front matter —— 侧栏生成与字段校验共用这一份。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DOCS_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
export const REPO_ROOT = path.resolve(DOCS_ROOT, '..');

export interface DocEntry {
  /** 相对 docs/ 的路径，如 logic/orchestration/tech/single-ledger.md */
  rel: string;
  /**
   * 视角目录之前的**整段**路径，如 `logic/orchestration`、`host/contract`、`misc`。
   * 深一层（`logic/*`、`host/*`）和只有一层（`misc`）共用这一个字段——
   * 它就是侧栏的路由前缀，也是 SECTIONS 表里的 `dir`。
   */
  section: string;
  /** 视角目录，如 tech；不在 <层>/<视角>/ 结构里的为 undefined */
  view?: string;
  /** 文件名去掉 .md */
  slug: string;
  /** 站内链接，如 /logic/orchestration/tech/single-ledger */
  link: string;
  frontmatter: Record<string, unknown>;
}

/** 极简 front matter 解析：只认 `key: value`，值按 YAML 标量/行内数组取。 */
function parseFrontmatter(src: string): Record<string, unknown> {
  if (!src.startsWith('---\n')) return {};
  const end = src.indexOf('\n---', 4);
  if (end === -1) return {};
  const out: Record<string, unknown> = {};
  for (const line of src.slice(4, end).split('\n')) {
    const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    const key = m?.[1];
    if (!key) continue;
    const value = (m?.[2] ?? '').trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1).trim();
      out[key] = inner ? inner.split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')) : [];
    } else {
      out[key] = value.replace(/^["']|["']$/g, '');
    }
  }
  return out;
}

export function collectDocs(): DocEntry[] {
  const entries: DocEntry[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(DOCS_ROOT, dir), { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(rel);
        continue;
      }
      if (!e.name.endsWith('.md')) continue;
      // 倒数第二段是视角，它之前的**全部**段是 section——这样 `misc/tech/x.md` 与
      // `logic/engine/tech/x.md` 走同一条规则，层级深浅不用分情况。
      const parts = rel.split('/');
      entries.push({
        rel,
        section: parts.length > 2 ? parts.slice(0, -2).join('/') : '',
        view: parts.length > 2 ? parts[parts.length - 2] : undefined,
        slug: e.name.replace(/\.md$/, ''),
        link: `/${rel.replace(/\.md$/, '')}`,
        frontmatter: parseFrontmatter(fs.readFileSync(path.join(DOCS_ROOT, rel), 'utf8')),
      });
    }
  };
  walk('');
  return entries.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** 侧栏与导航上显示的标题：优先 front matter 的 title，其次首个 H1，最后 slug。 */
export function titleOf(doc: DocEntry): string {
  const fm = doc.frontmatter.title;
  if (typeof fm === 'string' && fm) return stripMd(fm);
  const src = fs.readFileSync(path.join(DOCS_ROOT, doc.rel), 'utf8');
  const h1 = src.match(/^#\s+(.+)$/m)?.[1];
  return h1 ? stripMd(h1) : doc.slug;
}

/** 去掉标题里的行内 markdown 修饰，并砍掉「— 技术方案」这类视角后缀（侧栏分组已经说了） */
function stripMd(s: string): string {
  return s
    .replace(/`/g, '')
    .replace(/\*\*/g, '')
    .replace(/\s*[—-]\s*(功能手册|使用手册|技术方案|施工进展|产品视角.*|施工与验收)$/, '')
    .replace(/（(产品视角|技术方案|施工进展|使用手册)[^）]*）$/, '')
    .trim();
}
