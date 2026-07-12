/**
 * `createVercelFs(sandbox, root)`：NimboFS 七方法在 `sandbox.fs`（node:fs/promises
 * 兼容子集）上的直译（docs/06 §3.1 / §8.2 Vercel 列）。
 *
 * ---- 一个实测推翻工单研究原文的发现：`fs.rm()` 无法承担"非递归删非空目录
 * 拒绝"的语义 ----
 *
 * docs/06 §8.2 原文说 Vercel 的 `fs.rm(p, {recursive})` "原生对齐"——本地实测
 * `node:fs/promises`（Vercel Sandbox 的 `fs.*` 是这套 API 的兼容子集，语义应
 * 一致）证明并不成立：`fs.rm(path)`（`recursive` 缺省/false）对**任何**目录都
 * 抛 `ERR_FS_EISDIR`，不区分空/非空——用它去实现"非递归删空目录成功、删非空
 * 目录报 DirectoryNotEmptyError"（NimboFS 的 `rm(path,{recursive?})` 契约，
 * 对齐 MemoryFS 行为）完全对不上。真正带有"空则成功、非空则 ENOTEMPTY"语义
 * 的是 `fs.rmdir()`（同样实测确认）。因此非递归删除按目标类型分流：文件走
 * `fs.rm()`；目录走 `fs.rmdir()`（拿到真正的 `ENOTEMPTY` 可翻译）；`recursive:
 * true` 时统一走 `fs.rm(path, {recursive:true, force:true})`。代价是非递归删
 * 目录多一次 `stat` 判断类型，可接受（docs/06 §4 第 6 点本就预期扫描类操作
 * 走 bash，单次 rm 调用的额外 RTT 量级不在那条建议的射程内）。
 *
 * ---- readdir 不逐条目 stat 取 size/mtime ----
 *
 * `DirFS`（本地磁盘）的 readdir 会为每个文件条目额外 stat 一次拿 size/mtime；
 * 这里不跟随——那是本地磁盘的免费操作，在远程沙盒上是 N 次额外网络往返。审计
 * 了 `list_dir`/`glob` 等消费方（`virtual-fs/src/tools/*.ts`）：readdir 结果的
 * size/mtime 实际未被任何工具读取（`FileStat.mtime` 的唯一消费点是 `stat()`
 * 单独调用，走 read_file/edit_file 等的 readState 判据），只有 `mimeType` 有
 * 用（list_dir 用它标注非文本文件）——mimeType 是按扩展名推断的纯函数，零 RTT
 * 代价。因此 readdir 条目只填 name/type/mimeType，size/mtime 留空（FileStat 里
 * 两者本就是可选字段），需要精确 mtime 时调用方本就该单独 `stat()` 该路径。
 */
import type { DirEntry, FileStat, NimboFS } from "@nimbo/core";
import { inferMimeType, matchesGlob } from "@nimbo/virtual-fs";
import { isErrnoException, translateFsError } from "./errors.js";
import { toRealPath } from "./path.js";
import type { VercelSandboxLike } from "./types.js";

function toFileStat(stats: { isDirectory(): boolean; size: number; mtimeMs: number }, virtualPath: string): FileStat {
  if (stats.isDirectory()) return { type: "dir", mtime: Math.round(stats.mtimeMs) };
  return { type: "file", size: stats.size, mtime: Math.round(stats.mtimeMs), mimeType: inferMimeType(virtualPath) };
}

export function createVercelFs(sandbox: VercelSandboxLike, root: string): NimboFS {
  const real = (virtualPath: string): string => toRealPath(root, virtualPath);

  async function statOrUndefined(realPath: string): Promise<{ isDirectory(): boolean; isFile(): boolean } | undefined> {
    try {
      return await sandbox.fs.stat(realPath);
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  async function ensureParentDir(realPath: string): Promise<void> {
    const idx = realPath.lastIndexOf("/");
    const parent = idx <= 0 ? "/" : realPath.slice(0, idx);
    await sandbox.fs.mkdir(parent, { recursive: true });
  }

  async function walkFiles(virtualDir: string): Promise<string[]> {
    let entries;
    try {
      entries = await sandbox.fs.readdir(real(virtualDir), { withFileTypes: true });
    } catch {
      // 目录不可读（不存在/不是目录/权限）——glob 视为该子树无文件，与 DirFS 的 walkFiles 同一取舍。
      return [];
    }
    const results: string[] = [];
    for (const entry of entries) {
      const childPath = virtualDir === "/" ? `/${entry.name}` : `${virtualDir}/${entry.name}`;
      if (entry.isDirectory()) {
        results.push(...(await walkFiles(childPath)));
      } else if (entry.isFile()) {
        results.push(childPath);
      }
    }
    return results;
  }

  return {
    async readFile(path: string): Promise<Uint8Array> {
      try {
        return await sandbox.fs.readFile(real(path));
      } catch (error) {
        throw translateFsError("readFile", path, error);
      }
    },

    async writeFile(path: string, data: Uint8Array | string): Promise<void> {
      const realPath = real(path);
      try {
        // NimboFS.writeFile 隐含"自动创建中间目录"（MemoryFS.ensureParentDirs 的
        // 契约），而 node:fs/promises 的 writeFile 不会——显式 mkdir 一次补齐。
        await ensureParentDir(realPath);
        await sandbox.fs.writeFile(realPath, data);
      } catch (error) {
        throw translateFsError("writeFile", path, error);
      }
    },

    async rm(path: string, opts?: { recursive?: boolean }): Promise<void> {
      const realPath = real(path);
      try {
        if (opts?.recursive) {
          await sandbox.fs.rm(realPath, { recursive: true, force: true });
          return;
        }
        const stats = await statOrUndefined(realPath);
        if (stats === undefined) throw new NoSuchEntryError(realPath);
        if (stats.isDirectory()) {
          await sandbox.fs.rmdir(realPath); // 空目录成功；非空抛 ENOTEMPTY（见头注释）。
        } else {
          await sandbox.fs.rm(realPath);
        }
      } catch (error) {
        throw translateFsError("rm", path, error);
      }
    },

    async mkdir(path: string): Promise<void> {
      try {
        await sandbox.fs.mkdir(real(path), { recursive: true });
      } catch (error) {
        throw translateFsError("mkdir", path, error);
      }
    },

    async readdir(path: string): Promise<DirEntry[]> {
      let entries;
      try {
        entries = await sandbox.fs.readdir(real(path), { withFileTypes: true });
      } catch (error) {
        throw translateFsError("readdir", path, error);
      }
      const result: DirEntry[] = entries.map((entry) => {
        const childPath = path === "/" ? `/${entry.name}` : `${path}/${entry.name}`;
        return entry.isDirectory()
          ? { name: entry.name, type: "dir" as const }
          : { name: entry.name, type: "file" as const, mimeType: inferMimeType(childPath) };
      });
      result.sort((a, b) => a.name.localeCompare(b.name));
      return result;
    },

    async stat(path: string): Promise<FileStat> {
      try {
        const stats = await sandbox.fs.stat(real(path));
        return toFileStat(stats, path);
      } catch (error) {
        throw translateFsError("stat", path, error);
      }
    },

    async glob(pattern: string): Promise<string[]> {
      const files = await walkFiles("/");
      return files.filter((p) => matchesGlob(pattern, p)).sort();
    },
  };
}

/** `statOrUndefined` 判定路径不存在后，`rm` 内部合成的占位错误——立刻被 `translateFsError` 的 ENOENT 码翻译成 `NotFoundError`，不向外浮出。 */
class NoSuchEntryError extends Error {
  readonly code = "ENOENT";
  constructor(path: string) {
    super(`ENOENT: no such file or directory, rm '${path}'`);
  }
}
