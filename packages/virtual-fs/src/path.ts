/**
 * 虚拟路径规范化与 glob 匹配（docs/core/core-sdk/tech.md §4.4："路径规范：POSIX 风格虚拟绝对路径；
 * `..` 越界在 FS 层直接拒绝——安全边界在 FS 不在工具"）。
 *
 * 本文件不依赖任何具体 FS 实现，纯字符串运算，供 memory.ts/overlay.ts/dir.ts 共用。
 */

/** `..` 试图越出虚拟根目录 `/` 时抛出——路径校验的安全边界在这里，不在调用方。 */
export class PathEscapesRootError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`virtual path escapes root: "${path}"`);
    this.name = "PathEscapesRootError";
    this.path = path;
  }
}

/**
 * 规范化任意输入（相对/绝对、含 `.`、含重复斜杠）为 POSIX 风格虚拟绝对路径。
 * 用栈处理路径段：空段（重复斜杠/首尾斜杠）与 `.` 直接丢弃；`..` 弹栈，
 * 栈已空时说明越出了虚拟根——直接拒绝而不是静默 clamp 到根，
 * 因为静默 clamp 会把"程序写错了路径"伪装成"恰好访问了根目录"。
 */
export function normalizePath(input: string): string {
  const segments = input.split("/");
  const stack: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (stack.length === 0) throw new PathEscapesRootError(input);
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return `/${stack.join("/")}`;
}

/** 假定 path 已由 normalizePath 规范化。 */
export function dirname(path: string): string {
  if (path === "/") return "/";
  const idx = path.lastIndexOf("/");
  if (idx <= 0) return "/";
  return path.slice(0, idx);
}

/** 假定 path 已由 normalizePath 规范化。 */
export function basename(path: string): string {
  if (path === "/") return "/";
  const idx = path.lastIndexOf("/");
  return path.slice(idx + 1);
}

const REGEXP_SPECIAL_CHARS = new Set([".", "+", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\"]);

function escapeRegExpChar(ch: string): string {
  return REGEXP_SPECIAL_CHARS.has(ch) ? `\\${ch}` : ch;
}

/**
 * 极简 glob 转 RegExp：连续两个星号表示跨目录任意深度（后面紧跟一个斜杠时，
 * 该斜杠允许匹配零段）、单个星号表示单段内任意、问号表示单字符且不跨斜杠。
 * 不支持字符类/花括号分组——v1 够用即可，真正的 glob 库是三方依赖，diff/patch
 * 之外这里也刻意不引入。用 String.charAt 而非下标访问，避免 noUncheckedIndexedAccess
 * 下 `string | undefined` 的联合类型污染。
 */
export function globToRegExp(pattern: string): RegExp {
  const body = pattern.startsWith("/") ? pattern.slice(1) : pattern;
  let source = "^/";
  let i = 0;
  while (i < body.length) {
    const ch = body.charAt(i);
    if (ch === "*" && body.charAt(i + 1) === "*") {
      if (body.charAt(i + 2) === "/") {
        source += "(?:.*/)?";
        i += 3;
      } else {
        source += ".*";
        i += 2;
      }
      continue;
    }
    if (ch === "*") {
      source += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      source += "[^/]";
      i += 1;
      continue;
    }
    source += escapeRegExpChar(ch);
    i += 1;
  }
  source += "$";
  return new RegExp(source);
}

export function matchesGlob(pattern: string, path: string): boolean {
  return globToRegExp(pattern).test(path);
}

/**
 * `patterns` 命中 `path` 自身或其任一祖先目录即视为整棵子树忽略——与 `DirFS`
 * 构造期编译的 `ignorePatterns` 同一套前缀扫描算法（`dir.ts` 的
 * `isIgnored` 私有方法），抽成独立函数供 grep/glob 工具的默认忽略
 * （`.git`/`node_modules`）复用，避免重复维护同一段前缀扫描逻辑。
 */
export function isIgnoredPath(path: string, patterns: RegExp[]): boolean {
  if (patterns.length === 0) return false;
  const segments = path.split("/").filter((s) => s.length > 0);
  let prefix = "";
  for (const segment of segments) {
    prefix += `/${segment}`;
    if (patterns.some((re) => re.test(prefix))) return true;
  }
  return false;
}
