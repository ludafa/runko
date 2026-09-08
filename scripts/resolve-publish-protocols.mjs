#!/usr/bin/env node
/**
 * 把 packages/* 里 pnpm 的两个私有依赖协议换成真实版本范围，供 `npm publish` 使用。
 *
 * 为什么需要它：发布走的是 npm（只有它支持 OIDC/provenance，pnpm 至今不支持），
 * 而 npm 不认识 pnpm 的 `workspace:` 和 `catalog:`——原样发上去，装包的人会收到
 * `EUNSUPPORTEDPROTOCOL`。`pnpm publish` 两个都会替换，但它没有 provenance；
 * **`pnpm pack` 只替换 `workspace:`、不替换 `catalog:`**（实测），所以也借不了它的力。
 *
 * 0.1.1 就是栽在这上面：当时只换了 `workspace:`，15 个包全带着 `zod: "catalog:"`
 * 发了出去，npm 一个都装不上。所以这里有条硬规矩——
 * **换完之后必须断言一个私有协议都不剩，有残留就退出 1，把发布拦在门外。**
 * 将来 pnpm 再添新协议，这条断言会让流水线先炸，而不是让用户先炸。
 *
 * 只改工作区文件，不提交。用法：node scripts/resolve-publish-protocols.mjs
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PKG_DIR = "packages";
const DEP_BLOCKS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
/** pnpm 的私有协议前缀——发布产物里一个都不该出现 */
const PRIVATE_PROTOCOLS = ["workspace:", "catalog:", "link:", "file:"];

/**
 * 解析 pnpm-workspace.yaml 里的 catalog 定义。
 *
 * 只认顶层 `catalog:`（默认目录）与 `catalogs:`（具名目录）两段，格式就是
 * `名字: 范围` 的平铺列表。不引第三方 YAML 解析器：workflow 跑在干净 checkout 上，
 * 根 node_modules 里未必捞得到一个能直接 require 的 yaml；而这两段的形状足够简单。
 * 万一哪天格式复杂到这里解析不了——下面的断言会拦住，不会静默发出坏包。
 */
function readCatalogs(file = "pnpm-workspace.yaml") {
  const src = readFileSync(file, "utf8");
  const lines = src.split("\n");
  const def = {};          // 默认 catalog
  const named = {};        // 具名 catalogs

  let mode = null;         // null | "default" | "named"
  let currentNamed = null;

  for (const raw of lines) {
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;

    // 顶层 key（行首非空白）——切换或退出 catalog 段
    if (/^\S/.test(raw)) {
      const key = raw.split(":")[0].trim();
      mode = key === "catalog" ? "default" : key === "catalogs" ? "named" : null;
      currentNamed = null;
      continue;
    }
    if (mode === null) continue;

    // catalogs: 下的二级 key（具名目录名），缩进 2
    if (mode === "named" && /^ {2}\S/.test(raw) && /:\s*$/.test(raw)) {
      currentNamed = raw.trim().replace(/:$/, "").replace(/^["']|["']$/g, "");
      named[currentNamed] ??= {};
      continue;
    }

    const m = raw.match(/^\s+(?:"([^"]+)"|'([^']+)'|([^\s:]+))\s*:\s*(.+?)\s*$/);
    if (!m) continue;
    const name = m[1] ?? m[2] ?? m[3];
    const range = m[4].replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "");
    if (mode === "default") def[name] = range;
    else if (currentNamed) named[currentNamed][name] = range;
  }
  return { def, named };
}

const { def: catalog, named: catalogs } = readCatalogs();

// 各 workspace 包的当前版本，供 workspace: 协议查表
const dirs = readdirSync(PKG_DIR);
const versionOf = {};
for (const d of dirs) {
  const p = JSON.parse(readFileSync(join(PKG_DIR, d, "package.json"), "utf8"));
  versionOf[p.name] = p.version;
}

let replaced = 0;
for (const d of dirs) {
  const file = join(PKG_DIR, d, "package.json");
  const pkg = JSON.parse(readFileSync(file, "utf8"));

  for (const blk of DEP_BLOCKS) {
    for (const [dep, range] of Object.entries(pkg[blk] ?? {})) {
      if (typeof range !== "string") continue;

      if (range.startsWith("workspace:")) {
        const prefix = range.slice("workspace:".length); // ^ | ~ | * | 具体版本
        const v = versionOf[dep];
        if (v === undefined) throw new Error(`${pkg.name}: 依赖了未知的 workspace 包 ${dep}`);
        pkg[blk][dep] = prefix === "*" || prefix === "" ? v : `${prefix}${v}`;
        replaced++;
      } else if (range.startsWith("catalog:")) {
        const which = range.slice("catalog:".length).trim();
        const table = which === "" ? catalog : (catalogs[which] ?? {});
        const v = table[dep];
        if (v === undefined) {
          throw new Error(
            `${pkg.name}: ${blk}.${dep} 用了 "${range}"，但 pnpm-workspace.yaml 的` +
              `${which === "" ? " catalog" : ` catalogs.${which}`} 里查不到它`,
          );
        }
        pkg[blk][dep] = v;
        replaced++;
      }
    }
  }
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
}

// ---- 安全网：一个私有协议都不许剩 ----
const leftovers = [];
for (const d of dirs) {
  const pkg = JSON.parse(readFileSync(join(PKG_DIR, d, "package.json"), "utf8"));
  for (const blk of DEP_BLOCKS) {
    for (const [dep, range] of Object.entries(pkg[blk] ?? {})) {
      if (typeof range === "string" && PRIVATE_PROTOCOLS.some((p) => range.startsWith(p))) {
        leftovers.push(`${pkg.name} → ${blk}.${dep}: "${range}"`);
      }
    }
  }
}

if (leftovers.length > 0) {
  console.error("发布被拦下：以下依赖仍是 pnpm 私有协议，npm 装不了——");
  for (const l of leftovers) console.error(`  ${l}`);
  process.exit(1);
}

console.log(`已把 ${replaced} 处 pnpm 私有协议换成真实版本，无残留。`);
