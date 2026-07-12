/**
 * 自包含的极简 POSIX 虚拟路径解析——与 `@nimbo/mini-bash` 的 `src/path.ts`
 * 同一份逻辑独立实现（不跨包依赖：src 侧只允许依赖 `@nimbo/core` + `just-bash`，
 * 见 P6-4 mini-bash 先例头注释）。`..` 越界静默 clamp 到根而非抛错——这一层
 * 不是安全边界（tech-spec §4.4："安全边界在 FS 不在工具"），真正的边界校验
 * 留给注入的 `NimboFS` 实现自己那一层。
 */

/** 把任意输入（含 `.`、`..`、重复斜杠）规范化为以 `/` 开头的虚拟绝对路径。 */
export function normalizePath(input: string): string {
  const segments = input.split("/");
  const stack: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (stack.length > 0) stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return `/${stack.join("/")}`;
}

/** 绝对路径直接规范化；相对路径先拼上 base 再规范化——与 `IFileSystem.resolvePath(base, path)` 签名同形。 */
export function resolvePath(base: string, input: string): string {
  if (input.startsWith("/")) return normalizePath(input);
  return normalizePath(`${base}/${input}`);
}

/** 假定 path 已规范化。用于 `getAllPaths()` 从文件路径合成祖先目录集合（§4.5b）。 */
export function dirnameOf(path: string): string {
  if (path === "/") return "/";
  const idx = path.lastIndexOf("/");
  if (idx <= 0) return "/";
  return path.slice(0, idx);
}
