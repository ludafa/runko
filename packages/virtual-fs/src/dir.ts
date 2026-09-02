/**
 * DirFS：真实目录的只读视图（docs/tech/core-sdk.md §4.4：OverlayFS 的 base 通常是它）。
 * 唯一合法的 node:fs 使用边界——真实磁盘只在这里被读取，写方法一律拒绝。
 */
import * as nodeFs from "node:fs/promises";
import * as nodePath from "node:path";
import type { DirEntry, FileStat, RunkoFS } from "@runko/core";
import { inferMimeType } from "./mime.js";
import { globToRegExp, normalizePath } from "./path.js";
import { NotFoundError } from "./memory.js";

export class ReadOnlyFileSystemError extends Error {
  readonly operation: string;
  constructor(operation: string) {
    super(`DirFS is a read-only view of a real directory; "${operation}" is not supported`);
    this.name = "ReadOnlyFileSystemError";
    this.operation = operation;
  }
}

export interface DirFSOptions {
  /** glob 模式数组，匹配虚拟路径本身或其任一祖先目录即视为忽略（子树整体隐藏）。 */
  ignore?: string[];
}

/**
 * catch 子句的绑定类型是 `unknown`（strict 模式），这是从中安全窄化出
 * NodeJS.ErrnoException 的标准写法，不是到处逃逸的 `unknown`——只用于这一处
 * 判断 error.code，判断完立即收窄结束。
 */
function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export class DirFS implements RunkoFS {
  readonly rootDir: string;
  private readonly ignorePatterns: RegExp[];

  constructor(rootDir: string, opts?: DirFSOptions) {
    this.rootDir = rootDir;
    this.ignorePatterns = (opts?.ignore ?? []).map((pattern) => globToRegExp(pattern));
  }

  private toRealPath(virtualPath: string): string {
    const segments = virtualPath.split("/").filter((s) => s.length > 0);
    return nodePath.join(this.rootDir, ...segments);
  }

  /** 命中忽略规则的路径本身，或其任一祖先目录命中，都视为不存在——子树整体隐藏。 */
  private isIgnored(virtualPath: string): boolean {
    if (this.ignorePatterns.length === 0) {return false;}
    const segments = virtualPath.split("/").filter((s) => s.length > 0);
    let prefix = "";
    for (const segment of segments) {
      prefix += `/${segment}`;
      if (this.ignorePatterns.some((re) => re.test(prefix))) {return true;}
    }
    return false;
  }

  async readFile(path: string): Promise<Uint8Array> {
    const p = normalizePath(path);
    if (this.isIgnored(p)) {throw new NotFoundError(p);}
    try {
      return await nodeFs.readFile(this.toRealPath(p));
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") {throw new NotFoundError(p);}
      throw error;
    }
  }

  async writeFile(_path: string, _data: Uint8Array | string): Promise<void> {
    throw new ReadOnlyFileSystemError("writeFile");
  }

  async rm(_path: string, _opts?: { recursive?: boolean }): Promise<void> {
    throw new ReadOnlyFileSystemError("rm");
  }

  async mkdir(_path: string): Promise<void> {
    throw new ReadOnlyFileSystemError("mkdir");
  }

  async readdir(path: string): Promise<DirEntry[]> {
    const p = normalizePath(path);
    if (this.isIgnored(p)) {throw new NotFoundError(p);}
    let dirents;
    try {
      dirents = await nodeFs.readdir(this.toRealPath(p), { withFileTypes: true });
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") {throw new NotFoundError(p);}
      throw error;
    }
    const entries: DirEntry[] = [];
    for (const dirent of dirents) {
      const childPath = p === "/" ? `/${dirent.name}` : `${p}/${dirent.name}`;
      if (this.isIgnored(childPath)) {continue;}
      if (dirent.isDirectory()) {
        entries.push({ name: dirent.name, type: "dir" });
      } else if (dirent.isFile()) {
        const info = await nodeFs.stat(this.toRealPath(childPath));
        entries.push({ name: dirent.name, type: "file", size: info.size, mtime: info.mtimeMs, mimeType: inferMimeType(childPath) });
      }
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return entries;
  }

  async stat(path: string): Promise<FileStat> {
    const p = normalizePath(path);
    if (this.isIgnored(p)) {throw new NotFoundError(p);}
    let info;
    try {
      info = await nodeFs.stat(this.toRealPath(p));
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") {throw new NotFoundError(p);}
      throw error;
    }
    if (info.isDirectory()) {return { type: "dir", mtime: info.mtimeMs };}
    return { type: "file", size: info.size, mtime: info.mtimeMs, mimeType: inferMimeType(p) };
  }

  async glob(pattern: string): Promise<string[]> {
    const files = await this.walkFiles("/");
    const re = globToRegExp(pattern);
    return files.filter((p) => re.test(p)).sort();
  }

  private async walkFiles(virtualDir: string): Promise<string[]> {
    if (this.isIgnored(virtualDir)) {return [];}
    let dirents;
    try {
      dirents = await nodeFs.readdir(this.toRealPath(virtualDir), { withFileTypes: true });
    } catch {
      return [];
    }
    const results: string[] = [];
    for (const dirent of dirents) {
      const childPath = virtualDir === "/" ? `/${dirent.name}` : `${virtualDir}/${dirent.name}`;
      if (this.isIgnored(childPath)) {continue;}
      if (dirent.isDirectory()) {
        results.push(...(await this.walkFiles(childPath)));
      } else if (dirent.isFile()) {
        results.push(childPath);
      }
    }
    return results;
  }
}
