/**
 * 自包含的极简 POSIX 虚拟路径解析。刻意不依赖 @nimbo/virtual-fs 的
 * `normalizePath`（语义几乎相同）——src 侧按工单并行边界只允许依赖
 * @nimbo/core，且 mini-bash 的路径解析只是"把相对参数变成绝对路径字符串
 * 交给注入的 NimboFS"，不承担安全边界（tech-spec §4.4："安全边界在 FS
 * 不在工具"）；因此这里对 `..` 越界选择静默 clamp 而非 virtual-fs 那样
 * 抛 PathEscapesRootError——真正的边界校验留给 fs 实现自己那一层。
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

/** 绝对路径直接规范化；相对路径先拼上 cwd 再规范化。 */
export function resolvePath(cwd: string, input: string): string {
  if (input.startsWith("/")) return normalizePath(input);
  return normalizePath(`${cwd}/${input}`);
}
