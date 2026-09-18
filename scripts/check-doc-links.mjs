#!/usr/bin/env node
/**
 * 代码注释里的文档链接**死链检查**——文档站早就有的那道关，补给源码。
 *
 * 为什么需要它：同一个仓库、同一批人写的链接，两边命运完全不同——
 * `docs/` 里的链接有 `pnpm docs:build` 做全站死链检查，**零失效**；源码注释里的
 * 文档路径没有任何检查，于是 docs 重构成分层目录（`docs/<分层>/<视角>/<feature>.md`）
 * 之后，**718 处引用、33 个路径，全部指向不存在的文件**，没有任何人发现。
 *
 * 差别不在纪律，在有没有守门员。这个脚本就是那个守门员。
 *
 * 它检查两种写法：
 *
 * - **相对路径**（推荐）`../docs/terms.md` —— 从源文件所在目录解析。编辑器里能点开。
 * - **仓库根相对**`docs/tech/<feature>.md` —— 从仓库根解析。
 *
 * 报错时会**猜出正确路径**：按文件名在 `docs/` 下找，只找到一个就直接给出改法，
 * 所以修起来是机械活。
 *
 * ```sh
 * pnpm check:doc-links
 * ```
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 扫这些地方。`examples` 也扫——它是给人读的示例，链接烂了一样误导人。 */
const SCAN_ROOTS = ['apps', 'packages', 'examples', 'scripts'];

/** 不扫这些：装出来的、构建出来的、缓存。 */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.vitepress', 'coverage', '.turbo', 'build']);

const SOURCE_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;

/**
 * 认一条文档引用。两种前缀都接：`../` 开头的相对路径，或直接 `docs/` 开头的根相对。
 *
 * 前面那个否定回顾（不许是字母/数字/`.`/`-`/`/`）是为了**不重复匹配**：
 * 碰到 `../docs/terms.md` 时，若不排除 `/`，里面的 `docs/terms.md` 会再被匹配一次，
 * 同一处报两遍。
 */
const DOC_REF = /(?<![A-Za-z0-9._\-/])((?:\.\.\/)+)?docs\/[A-Za-z0-9._/-]+\.md/g;

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.github') {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        walk(full, out);
      }
    } else if (SOURCE_EXT.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** `docs/` 下所有 markdown 的索引：文件名 → 完整路径（可能多个，比如三视角同名）。 */
function indexDocs() {
  const byName = new Map();
  const stack = [join(ROOT, 'docs')];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
          stack.push(full);
        }
      } else if (entry.name.endsWith('.md')) {
        const key = entry.name;
        if (!byName.has(key)) {
          byName.set(key, []);
        }
        byName.get(key).push(relative(ROOT, full));
      }
    }
  }
  return byName;
}

/**
 * 猜正确写法。
 *
 * 同名文档可能有三份（功能 / 技术方案 / 施工进展三视角同 slug），这时按**原路径里的
 * 视角词**挑：`docs/tech/<feature>.md` 优先挑落在 `tech` 目录下的那一份。挑不出唯一解就把候选
 * 都列出来，让人自己定——猜错比不猜更坏。
 *
 * （注意别在块注释里写含星号加斜杠的路径通配，那会提前闭合注释——这个脚本自己踩过一次。）
 */
function suggest(brokenPath, docIndex) {
  const name = brokenPath.split('/').pop();
  const candidates = docIndex.get(name);
  if (candidates === undefined || candidates.length === 0) {
    return undefined;
  }
  if (candidates.length === 1) {
    return candidates;
  }
  const view = ['tech', 'features', 'plans'].find((v) => brokenPath.includes(`/${v}/`));
  if (view !== undefined) {
    const narrowed = candidates.filter((c) => c.includes(`/${view}/`));
    if (narrowed.length === 1) {
      return narrowed;
    }
  }
  return candidates;
}

const docIndex = indexDocs();
const files = SCAN_ROOTS.flatMap((r) => walk(join(ROOT, r)));

/** file → [{ line, ref, resolved, hint }] */
const broken = new Map();
let refCount = 0;

for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((text, i) => {
    for (const match of text.matchAll(DOC_REF)) {
      const ref = match[0];
      const isRelative = match[1] !== undefined;
      refCount += 1;
      const target = isRelative ? resolve(dirname(file), ref) : join(ROOT, ref);
      if (existsSync(target) && statSync(target).isFile()) {
        continue;
      }
      const hits = suggest(ref, docIndex);
      let hint;
      if (hits !== undefined && hits.length === 1) {
        hint = isRelative ? relative(dirname(file), join(ROOT, hits[0])) : hits[0];
      } else if (hits !== undefined) {
        hint = `多个候选：${hits.join(' | ')}`;
      }
      const list = broken.get(file) ?? [];
      list.push({ line: i + 1, ref, hint });
      broken.set(file, list);
    }
  });
}

if (broken.size === 0) {
  console.log(`✓ 文档链接体检通过：${String(files.length)} 个源文件、${String(refCount)} 处文档引用，全部指向真实文件`);
  process.exit(0);
}

let total = 0;
for (const [file, hits] of [...broken].sort(([a], [b]) => a.localeCompare(b))) {
  console.error(`\n${relative(ROOT, file)}`);
  for (const hit of hits) {
    total += 1;
    console.error(`  ${String(hit.line)}: ${hit.ref}`);
    if (hit.hint !== undefined) {
      console.error(`      → 应为 ${hit.hint}`);
    }
  }
}

console.error(
  `\n✗ ${String(total)} 处文档链接指向不存在的文件，分布在 ${String(broken.size)} 个文件里。` +
    `\n  文档路径形状见 CLAUDE.md「文档规范」：docs/<分层>/<视角>/<feature>.md`,
);
process.exit(1);
