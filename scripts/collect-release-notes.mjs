#!/usr/bin/env node
/**
 * 把本次发布的各包 CHANGELOG 条目汇成**一条**聚合 Release 的正文。
 *
 * 为什么要汇总：这仓库一次发版会动 15 个包、打 15 个 tag。照 changesets 官方
 * 那样一个 tag 一条 Release，Releases 页会被同一批内容几乎相同的 15 条刷屏。
 * 所以只建一条，用主包 @runko/sdk 的版本当版本号。
 *
 * 去重是重点：同一个 changeset 会被 changesets 写进它涉及的**每个**包的
 * CHANGELOG，15 个包就重复 15 遍。这里按 changeset 的短 hash 去重，只留一份。
 * `Updated dependencies` 那类条目是内部依赖联动 bump，对使用者没有信息量，丢掉。
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
 * 把一段 CHANGELOG 正文拆成顶层条目（以 `- ` 开头，含其缩进的续行）。
 * 返回 [{ key, text }]，key 用于跨包去重。
 */
function entriesOf(section) {
  const out = [];
  let cur = null;
  for (const line of section.split("\n")) {
    if (/^- /.test(line)) {
      if (cur) out.push(cur);
      cur = { lines: [line] };
    } else if (cur && (line.trim() === "" || /^\s/.test(line))) {
      cur.lines.push(line);
    } else if (cur) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);

  return out
    .map((e) => e.lines.join("\n").replace(/\s+$/, ""))
    .filter((text) => !/^- Updated dependencies/.test(text))
    .map((text) => {
      // `- <hash>: 正文` —— 用 hash 当去重键；没有 hash 的用正文首行
      const m = text.match(/^- ([0-9a-f]{7,40}):/);
      return { key: m ? m[1] : text.split("\n")[0], text };
    });
}

const released = [];
const seen = new Set();
const changes = [];

for (const dir of dirs) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    continue;
  }
  if (pkg.private) continue;
  released.push(`${pkg.name}@${pkg.version}`);

  let changelog;
  try {
    changelog = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
  } catch {
    continue;
  }
  const section = sectionOf(changelog, pkg.version);
  if (section === null) continue;

  for (const { key, text } of entriesOf(section)) {
    if (seen.has(key)) continue;
    seen.add(key);
    changes.push(text);
  }
}

if (released.length === 0) {
  console.error("没有找到本次发布的包");
  process.exit(1);
}

const lines = [];
lines.push("### 变更", "");
lines.push(changes.length > 0 ? changes.join("\n\n") : "_本次没有面向使用者的变更说明。_");
lines.push("", "### 本次发布的包", "");
lines.push(released.map((r) => `- \`${r}\``).join("\n"));
lines.push(
  "",
  "---",
  "",
  "每个包的完整变更见各自的 `packages/<包名>/CHANGELOG.md`。",
  "包由 GitHub Actions 经 npm trusted publishing 发布，带 provenance 溯源。",
);

console.log(lines.join("\n"));
