/**
 * 虚拟路径 → 沙盒内真实路径的锚定换算。虚拟路径始终先过 `normalizePath`
 * （`@nimbo/virtual-fs`）——`..` 越出虚拟根 `/` 时抛 `PathEscapesRootError`，
 * 与 MemoryFS/DirFS 同一套边界语义（工单裁量：docs/tech/sandbox.md §3.1 "适配器不再模拟
 * VirtualFS 的越界拒绝" 说的是 bash 相对 FS 工具的语义差——bash 经真实 shell
 * 直达整个容器文件系统，天然越出 root，这一点已经在 `describe()` 里如实声明；
 * 但 FS 七方法仍是"锚定到 root 的一个安全视图"，与其余三个 NimboFS 实现保持
 * 同样的越界拒绝行为，不因为 bash 那侧守不住就连这侧的路由防呆也一起放弃）。
 */
import { normalizePath } from "@nimbo/virtual-fs";

/** 去掉 root 末尾的斜杠，便于和虚拟路径拼接；root 为 "/" 时视为空前缀。 */
function cleanRoot(root: string): string {
  if (root === "/") {return "";}
  return root.endsWith("/") ? root.slice(0, -1) : root;
}

/** 虚拟路径（agent 视角，`/` 起头）→ 沙盒内真实绝对路径。 */
export function toRealPath(root: string, virtualPath: string): string {
  const prefix = cleanRoot(root);
  const v = normalizePath(virtualPath);
  if (v === "/") {return prefix === "" ? "/" : prefix;}
  return `${prefix}${v}`;
}

/** exec 的 cwd：未显式提供时落回 root 本身（沙盒的默认工作目录）。 */
export function resolveCwd(root: string, cwd: string | undefined): string {
  return cwd !== undefined ? toRealPath(root, cwd) : toRealPath(root, "/");
}
