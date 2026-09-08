#!/usr/bin/env node
/**
 * 把本次发布的各包 CHANGELOG 条目汇成**一条**聚合 Release 的正文。
 *
 * 为什么要汇总：这仓库一次发版会动 15 个包、打 15 个 tag。照 changesets 官方
 * 那样一个 tag 一条 Release，Releases 页会被同一批内容几乎相同的 15 条刷屏。
 * 所以只建一条，用主包 @runko/sdk 的版本当版本号。
 *
 * 正文要**自带全部内容**，不能写「详见各包 CHANGELOG」——那等于让读者挨个点开
 * 15 个文件。所以这里做三件事：
 *
 *   1. 变更正文原样展开，一条不漏；
 *   2. 按 changeset 短 hash 去重——同一条 changeset 会被 changesets 写进它涉及的
 *      **每个**包的 CHANGELOG，15 个包就重复 15 遍；
 *   3. 去重会丢掉「这条影响谁」，所以边去重边累计影响的包，输出时标回去。
 *
 * 同时保留 changesets 的 Major / Minor / Patch 分级——它决定使用者升级时要不要
 * 提心吊胆，是正文里最该突出的信息。`Updated dependencies` 那类条目是内部依赖
 * 联动 bump，对使用者没有信息量，丢掉。
 *
 * 用法：node scripts/collect-release-notes.mjs <本次 bump 的包目录清单文件>
 *       清单文件每行一个目录，如 `packages/core`。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const listFile = process.argv[2];
if (!listFile) {
  console.error("用法: node scripts/collect-release-notes.mjs <bumped-dirs-file>");
  process.exit(1);
}

const dirs = readFileSync(listFile, "utf8")
  .split("\n")
  .map((s) => s.trim())
  .filter(Boolean);

/** 从 CHANGELOG 里切出 `## <version>` 到下一个 `## ` 之间的内容 */
function sectionOf(changelog, version) {
  const lines = changelog.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${version}`);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n");
}

/**
 * 把版本段落拆成 [{ level, key, text }]。
 * level 取自 `### Major/Minor/Patch Changes` 小标题；key 用于跨包去重。
 */
function entriesOf(section) {
  const out = [];
  let level = "patch";
  let cur = null;

  const flush = () => {
    if (cur) out.push({ level: cur.level, lines: cur.lines });
    cur = null;
  };

  for (const line of section.split("\n")) {
    const h = line.match(/^###\s+(Major|Minor|Patch)\s+Changes/i);
    if (h) {
      flush();
      level = h[1].toLowerCase();
      continue;
    }
    if (/^- /.test(line)) {
      flush();
      cur = { level, lines: [line] };
    } else if (cur && (line.trim() === "" || /^\s/.test(line))) {
      cur.lines.push(line);
    } else {
      flush();
    }
  }
  flush();

  return out
    .map((e) => ({ level: e.level, text: e.lines.join("\n").replace(/\s+$/, "") }))
    .filter(({ text }) => !/^- Updated dependencies/.test(text))
    .map(({ level, text }) => {
      // `- <hash>: 正文` —— hash 当去重键。它顶在每条开头像编号、读着碍事，
      // 但 GitHub 会把它渲染成 commit 链接，有追溯价值，所以挪到脚注去。
      const m = text.match(/^- ([0-9a-f]{7,40}):\s*/);
      const hash = m ? m[1] : null;
      const clean = m ? text.replace(/^- [0-9a-f]{7,40}:\s*/, "- ") : text;
      // **去重键用正文，不能用 hash**：一个 commit 里可以有多个 changeset 文件，
      // 它们共享同一个 hash。拿 hash 当键会把内容完全不同的几条压成一条——实测
      // 0.1.0 那批里 3029ae3 一个 hash 底下挂着 4 条不同的变更，会丢掉 3 条。
      // 同一条 changeset 写进各包 CHANGELOG 时正文逐字相同，用它做键才准。
      return { level, key: clean, text: clean, hash };
    });
}

const released = [];
/** key → { level, text, packages: string[] } */
const changes = new Map();

for (const dir of dirs) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    continue;
  }
  if (pkg.private) continue;
  released.push({ name: pkg.name, version: pkg.version });

  let changelog;
  try {
    changelog = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
  } catch {
    continue;
  }
  const section = sectionOf(changelog, pkg.version);
  if (section === null) continue;

  for (const { level, key, text, hash } of entriesOf(section)) {
    const hit = changes.get(key);
    if (hit) hit.packages.push(pkg.name);
    else changes.set(key, { level, text, hash, packages: [pkg.name] });
  }
}

if (released.length === 0) {
  console.error("没有找到本次发布的包");
  process.exit(1);
}

const total = released.length;
const versions = [...new Set(released.map((r) => r.version))];
const out = [];

// 抬头：一句话说清这次发了什么
out.push(
  versions.length === 1
    ? `**${total} 个包，全部 ${versions[0]}。**`
    : `**${total} 个包**（版本不一，见文末清单）。`,
  "",
);

const LEVEL_TITLE = {
  major: "破坏性变更（Major）",
  minor: "新功能（Minor）",
  patch: "修复与改进（Patch）",
};

for (const level of ["major", "minor", "patch"]) {
  const items = [...changes.values()].filter((c) => c.level === level);
  if (items.length === 0) continue;

  out.push(`## ${LEVEL_TITLE[level]}`, "");
  for (const { text, packages, hash } of items) {
    out.push(text, "");
    // 去重丢掉的「影响谁」在这里补回来；hash 一并放脚注，GitHub 会渲染成 commit 链接
    const scope =
      packages.length === total
        ? `影响全部 ${total} 个包`
        : `影响：${packages.map((n) => `\`${n}\``).join("、")}`;
    out.push(`> ${scope}${hash ? ` · ${hash}` : ""}`, "");
  }
}

if (changes.size === 0) {
  out.push("_本次没有面向使用者的变更说明（仅内部依赖联动）。_", "");
}

// 包清单折叠起来：它是查证用的，不该挡在变更正文前面
out.push("<details>", "<summary>本次发布的包清单</summary>", "");
out.push(released.map((r) => `- \`${r.name}@${r.version}\``).join("\n"));
out.push("", "</details>", "");
out.push(
  "---",
  "",
  "包由 GitHub Actions 经 npm trusted publishing 发布，带 provenance 溯源。",
);

console.log(out.join("\n"));
