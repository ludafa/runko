/**
 * `find [path] [-name GLOB] [-type f|d]`：从 path（默认 "."）递归；
 * `-name` 只匹配单段 basename（不跨 `/`，`*`/`?` 语义），`-type` 过滤
 * file/dir。只用 readdir()/stat() 遍历，不依赖 fs.glob()——glob() 在
 * @runko/virtual-fs 里"只匹配文件、不匹配目录"，那是该实现的选择，
 * find 需要目录也能被 -type d 匹配，不能假设所有 RunkoFS 实现都有同样的
 * glob 语义，因此自己走 readdir 递归。
 */
import type { DirEntry, FileStat, RunkoFS } from "@runko/core";
import { resolvePath } from "../path.js";
import { statSafe } from "./shared.js";
import type { CommandFn } from "./types.js";

interface FindOptions {
  path: string;
  namePattern?: string;
  type?: "f" | "d";
}

function parseArgs(args: string[]): FindOptions | { error: string } {
  let i = 0;
  let path = ".";
  const first = args[0];
  if (first !== undefined && !first.startsWith("-")) {
    path = first;
    i = 1;
  }

  let namePattern: string | undefined;
  let type: "f" | "d" | undefined;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "-name") {
      const value = args[i + 1];
      if (value === undefined) {return { error: "find: -name requires an argument" };}
      namePattern = value;
      i += 2;
      continue;
    }
    if (arg === "-type") {
      const value = args[i + 1];
      if (value !== "f" && value !== "d") {return { error: "find: -type requires 'f' or 'd'" };}
      type = value;
      i += 2;
      continue;
    }
    return { error: `find: unknown option '${String(arg)}'` };
  }
  return { path, namePattern, type };
}

const GLOB_SPECIAL_CHARS = new Set([".", "+", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\"]);

/** find -name 是单段匹配：`*` 匹配任意字符（含 0 个，不跨 `/` 因为整个输入本来就是单段 basename），`?` 匹配单字符。 */
function nameGlobToRegExp(pattern: string): RegExp {
  let source = "^";
  for (const ch of pattern) {
    if (ch === "*") {source += ".*";}
    else if (ch === "?") {source += ".";}
    else {source += GLOB_SPECIAL_CHARS.has(ch) ? `\\${ch}` : ch;}
  }
  source += "$";
  return new RegExp(source);
}

interface FoundEntry {
  path: string;
  stat: FileStat;
}

async function walk(fs: RunkoFS, dir: string, out: FoundEntry[], signal: AbortSignal): Promise<void> {
  const entries: DirEntry[] = await fs.readdir(dir);
  for (const entry of entries) {
    if (signal.aborted) {return;}
    const childPath = dir === "/" ? `/${entry.name}` : `${dir}/${entry.name}`;
    out.push({ path: childPath, stat: entry });
    if (entry.type === "dir") {
      await walk(fs, childPath, out, signal);
    }
  }
}

export const find: CommandFn = async (args, ctx) => {
  const parsed = parseArgs(args);
  if ("error" in parsed) {
    return { stdout: "", stderr: `${parsed.error}\n`, exitCode: 2 };
  }

  const root = resolvePath(ctx.cwd, parsed.path);
  const rootStat = await statSafe(ctx.fs, root);
  if (rootStat === undefined) {
    return { stdout: "", stderr: `find: '${parsed.path}': No such file or directory\n`, exitCode: 1 };
  }

  const results: FoundEntry[] = [{ path: root, stat: rootStat }];
  if (rootStat.type === "dir") {
    try {
      await walk(ctx.fs, root, results, ctx.signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { stdout: "", stderr: `find: ${message}\n`, exitCode: 1 };
    }
  }

  const nameRe = parsed.namePattern !== undefined ? nameGlobToRegExp(parsed.namePattern) : undefined;
  const wantType = parsed.type === "f" ? "file" : parsed.type === "d" ? "dir" : undefined;
  const matched = results.filter((entry) => {
    if (wantType !== undefined && entry.stat.type !== wantType) {return false;}
    if (nameRe !== undefined) {
      const name = entry.path === "/" ? "/" : (entry.path.split("/").pop() ?? "");
      if (!nameRe.test(name)) {return false;}
    }
    return true;
  });

  const paths = matched.map((entry) => entry.path).sort();
  return { stdout: paths.length > 0 ? `${paths.join("\n")}\n` : "", stderr: "", exitCode: 0 };
};
