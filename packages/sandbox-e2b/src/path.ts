/**
 * 虚拟绝对路径 ↔ 沙盒内真实路径的锚定换算（`E2bWorkspaceOptions.root`）。
 * `..` 越界的拒绝完全交给 `normalizePath` 的既有语义（抛 `PathEscapesRootError`）
 * ——沙盒工作区不重复实现这层校验，只负责把规范化后的虚拟路径接到 `root` 之下。
 */
import { normalizePath } from "@nimbo/virtual-fs";

export interface PathAnchor {
  /** 沙盒内 `root` 对应的真实绝对路径（`glob()`/默认 `cwd` 的起点）。 */
  readonly rootReal: string;
  toReal(virtualPath: string): string;
  toVirtual(realPath: string): string;
}

export function createPathAnchor(root: string): PathAnchor {
  const rootReal = root === "/" ? "/" : root.replace(/\/+$/, "");
  // root 为 "/" 时前缀为空串——toReal/toVirtual 都退化成"虚拟路径即真实路径"。
  const childPrefix = rootReal === "/" ? "" : rootReal;

  return {
    rootReal,
    toReal(virtualPath: string): string {
      const normalized = normalizePath(virtualPath);
      return normalized === "/" ? rootReal : `${childPrefix}${normalized}`;
    },
    toVirtual(realPath: string): string {
      if (realPath === rootReal) return "/";
      if (childPrefix.length > 0 && realPath.startsWith(`${childPrefix}/`)) return realPath.slice(childPrefix.length);
      return realPath;
    },
  };
}
