/**
 * 行级 diff + 自实现 unified-diff 风格 patch 文本（docs/tech/core-sdk.md §4.4：
 * "diff(): FileDiff[]（{ path, kind, before?, after?, patch }，patch 为自实现行级
 * unified diff，LCS/Myers 简化版，不引第三方依赖）"）。
 *
 * 纯函数模块，不接触任何 FS/IO——MemoryFS.diff()/OverlayFS.diff() 只负责收集
 * before/after 文本，实际的行级比较与 patch 渲染都在这里。
 */

export type FileDiffKind = "created" | "modified" | "deleted";

export interface FileDiff {
  path: string;
  kind: FileDiffKind;
  before?: string;
  after?: string;
  patch: string;
}

interface DiffOp {
  type: "equal" | "delete" | "insert";
  line: string;
}

function splitLines(text: string): string[] {
  return text.length === 0 ? [] : text.split("\n");
}

/**
 * 经典 LCS 动态规划表，用 `Map<number, number>` 以 `i*(m+1)+j` 存值而非二维数组——
 * strict 的 noUncheckedIndexedAccess 下二维数组下标访问会得到 `number | undefined`，
 * 而 Map.get(...) ?? 0 恰好天然表达 DP 的边界（i===n 或 j===m 处值为 0），
 * 不需要额外的 undefined 判空样板代码。
 */
function buildLcsLengths(a: string[], b: string[]): Map<number, number> {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const grid = new Map<number, number>();
  const at = (i: number, j: number): number => grid.get(i * width + j) ?? 0;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const value = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
      grid.set(i * width + j, value);
    }
  }
  return grid;
}

function diffLines(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const grid = buildLcsLengths(a, b);
  const width = m + 1;
  const at = (i: number, j: number): number => grid.get(i * width + j) ?? 0;
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const lineA = a[i];
    const lineB = b[j];
    // i<n / j<m 已保证两者必然存在；显式判空是满足 noUncheckedIndexedAccess 的
    // 类型收窄手段，不是断言。
    if (lineA === undefined || lineB === undefined) break;
    if (lineA === lineB) {
      ops.push({ type: "equal", line: lineA });
      i += 1;
      j += 1;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      ops.push({ type: "delete", line: lineA });
      i += 1;
    } else {
      ops.push({ type: "insert", line: lineB });
      j += 1;
    }
  }
  while (i < n) {
    const lineA = a[i];
    if (lineA === undefined) break;
    ops.push({ type: "delete", line: lineA });
    i += 1;
  }
  while (j < m) {
    const lineB = b[j];
    if (lineB === undefined) break;
    ops.push({ type: "insert", line: lineB });
    j += 1;
  }
  return ops;
}

/**
 * 简化版 unified diff：只产出单个 hunk（不做多 hunk 分段 + 上下文折叠），
 * header 沿用 `--- a/<path>` / `+++ b/<path>` / `@@ -start,count +start,count @@`
 * 的可读约定。before/after 相同时返回空串（调用方据此判断"无变化"）。
 */
export function computeUnifiedDiff(path: string, before: string, after: string): string {
  if (before === after) return "";
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const ops = diffLines(beforeLines, afterLines);
  const body = ops.map((op) => {
    if (op.type === "equal") return ` ${op.line}`;
    if (op.type === "delete") return `-${op.line}`;
    return `+${op.line}`;
  });
  const beforeStart = beforeLines.length > 0 ? 1 : 0;
  const afterStart = afterLines.length > 0 ? 1 : 0;
  const header = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${beforeStart},${beforeLines.length} +${afterStart},${afterLines.length} @@`,
  ];
  return [...header, ...body].join("\n");
}

/**
 * 三态 FileDiff 构造：before===after（含两者都是 undefined）时返回 undefined
 * 表示"无变化"，调用方据此跳过。
 */
export function buildFileDiff(path: string, before: string | undefined, after: string | undefined): FileDiff | undefined {
  if (before === after) return undefined;
  if (before === undefined) {
    return { path, kind: "created", after, patch: computeUnifiedDiff(path, "", after ?? "") };
  }
  if (after === undefined) {
    return { path, kind: "deleted", before, patch: computeUnifiedDiff(path, before, "") };
  }
  return { path, kind: "modified", before, after, patch: computeUnifiedDiff(path, before, after) };
}
