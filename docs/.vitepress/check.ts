/**
 * front matter 体检：字段齐全、取值合法、不会有文档静默漏出侧栏。
 *
 * 为什么需要它：侧栏是从 front matter 现推的，`layer` 写错或漏写的文档
 * **不会报错**，只是安静地不出现在任何一组里。这个脚本把那种静默失败变成硬失败。
 *
 * 跑法：pnpm docs:check
 */
import { collectDocs, type DocEntry } from './docs.ts';
import { SECTIONS, NAV, VIEWS, LAYERS, MODULES } from './structure.ts';

const REQUIRED = ['title', 'slug', 'view', 'layer', 'module', 'packages', 'tags'] as const;
const VIEW_VALUES = VIEWS.map((v) => v.fm);
const SECTION_DIRS = new Set(SECTIONS.map((s) => s.dir));
/** 不参与「层/视角」结构的：站点首页、术语表、总览，以及本包的 README（srcExclude 掉，不是站上的一页） */
const EXEMPT = new Set(['index.md', 'terms.md', 'overview.md', 'README.md']);

const problems: string[] = [];
const fail = (doc: DocEntry, msg: string) => problems.push(`${doc.rel}: ${msg}`);

const docs = collectDocs();
const structured = docs.filter((d) => !EXEMPT.has(d.rel));

for (const doc of structured) {
  const fm = doc.frontmatter;

  if (Object.keys(fm).length === 0) {
    fail(doc, '没有 front matter');
    continue;
  }

  for (const key of REQUIRED) {
    if (fm[key] === undefined || fm[key] === '') fail(doc, `缺字段 ${key}`);
  }

  // 位置必须与结构一致，否则会漏出侧栏
  if (!SECTION_DIRS.has(doc.section)) {
    fail(doc, `所在目录 ${doc.section || '(根)'} 不在 SECTIONS 里，这份文档不会出现在任何侧栏`);
  }
  if (!doc.view || !VIEWS.some((v) => v.dir === doc.view)) {
    fail(doc, `视角目录 ${doc.view ?? '(无)'} 不是 features/tech/plans，这份文档不会出现在任何侧栏`);
  }

  // 字段取值
  if (typeof fm.layer === 'string' && !LAYERS.includes(fm.layer as (typeof LAYERS)[number])) {
    fail(doc, `layer «${fm.layer}» 不是合法取值（${LAYERS.join(' | ')}）`);
  }
  if (typeof fm.module === 'string' && !MODULES.includes(fm.module as (typeof MODULES)[number])) {
    fail(doc, `module «${fm.module}» 不是合法取值（${MODULES.join(' | ')}）`);
  }
  if (typeof fm.view === 'string' && !VIEW_VALUES.includes(fm.view as (typeof VIEWS)[number]['fm'])) {
    fail(doc, `view «${fm.view}» 不是合法取值（${VIEW_VALUES.join(' | ')}）`);
  }

  // front matter 的 view 必须与它所在的视角目录一致
  const expected = VIEWS.find((v) => v.dir === doc.view)?.fm;
  if (expected && fm.view !== expected) {
    fail(doc, `view 写的是 «${fm.view}»，但它在 ${doc.view}/ 目录下，应为 «${expected}»`);
  }

  if (fm.slug !== doc.slug) {
    fail(doc, `slug «${fm.slug}» 与文件名 «${doc.slug}» 不一致`);
  }

  // related 指向的必须真实存在（相对 docs/ 根）
  const related = Array.isArray(fm.related) ? (fm.related as string[]) : [];
  for (const r of related) {
    if (!docs.some((d) => d.rel === r)) fail(doc, `related 指向不存在的文档：${r}`);
  }
}

/* ── 结构表自身的体检：区段进不了导航、或者压根没文档，都是静默失败 ───── */
const navDirs = new Set(NAV.flatMap((g) => g.dirs));
for (const s of SECTIONS) {
  if (!navDirs.has(s.dir)) {
    problems.push(`structure.ts: 区段 ${s.dir} 没被任何一个 NAV 分组收进去，导航栏上点不到它`);
  }
  if (!structured.some((d) => d.section === s.dir)) {
    problems.push(`structure.ts: 区段 ${s.dir} 一份文档都没有——要么补文档，要么先从 SECTIONS 里去掉`);
  }
}
for (const dir of navDirs) {
  if (!SECTIONS.some((s) => s.dir === dir)) {
    problems.push(`structure.ts: NAV 里的 ${dir} 不在 SECTIONS 里，没有侧栏也没有落地页`);
  }
}

const counted = structured.length;
if (problems.length) {
  console.error(`✗ front matter 体检未通过（检查了 ${counted} 份文档，${problems.length} 处问题）：\n`);
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}

console.log(`✓ front matter 体检通过：${counted} 份文档全部归位，字段合法`);
for (const s of SECTIONS) {
  const n = structured.filter((d) => d.section === s.dir).length;
  const by = VIEWS.map((v) => `${v.text} ${structured.filter((d) => d.section === s.dir && d.view === v.dir).length}`);
  console.log(`  ${s.dir.padEnd(22)} ${String(n).padStart(2)} 份　(${by.join(' · ')})`);
}
