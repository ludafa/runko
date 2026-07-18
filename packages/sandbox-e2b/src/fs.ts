/**
 * NimboFS 七方法 → e2b `Filesystem` 映射（docs/tech/sandbox.md §3.1 E2B 列 / §8.2）。
 */
import type { DirEntry, FileStat, NimboFS } from "@nimbo/core";
import { DirectoryNotEmptyError, matchesGlob, NotFoundError } from "@nimbo/virtual-fs";
import { isE2bErrorNamed } from "./errors.js";
import type { PathAnchor } from "./path.js";
import type { E2bEntryInfo, E2bSandboxLike } from "./types.js";

/**
 * e2b 的"未找到"错误家族：`FileNotFoundError` 是当前版本实测抛出的具体子类，
 * `NotFoundError`（e2b 自家、已废弃）是历史/兼容路径可能出现的旧变体——两者
 * 都翻译成 `@nimbo/virtual-fs` 的 `NotFoundError`（同名不同类，跨包结构判别，
 * 不是 `instanceof`）。
 */
const NOT_FOUND_NAMES = ["FileNotFoundError", "NotFoundError"] as const;

/** `list(root, { depth })` 用于 glob 的递归深度——远超"典型工作区目录嵌套层数"的量级，避免深层子目录被漏扫。 */
const GLOB_LIST_DEPTH = 64;

/** `EntryInfo.type` 非 `"file"` 一律视为目录（docs/tech/sandbox.md §8.2："FileType 非 file 视为 dir"）；`size` 只在文件类型下有意义，仿 MemoryFS 用条件展开省略而非填 0/undefined。 */
function toFileStat(entry: E2bEntryInfo): FileStat {
  const type: FileStat["type"] = entry.type === "file" ? "file" : "dir";
  const mtime = entry.modifiedTime?.getTime();
  return {
    type,
    ...(type === "file" ? { size: entry.size } : {}),
    ...(mtime !== undefined ? { mtime } : {}),
  };
}

/** e2b 的 `write()` 不接受 `Uint8Array`（只收 `string | ArrayBuffer | Blob | ReadableStream`）——转成一份拷贝的 `ArrayBuffer`，避免子视图的 `byteOffset` 被忽略。 */
function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.slice().buffer;
}

export function createE2bFs(sandbox: E2bSandboxLike, anchor: PathAnchor): NimboFS {
  return {
    async readFile(path: string): Promise<Uint8Array> {
      const real = anchor.toReal(path);
      try {
        return await sandbox.files.read(real, { format: "bytes" });
      } catch (error) {
        if (isE2bErrorNamed(error, ...NOT_FOUND_NAMES)) throw new NotFoundError(path);
        throw error;
      }
    },

    async writeFile(path: string, data: Uint8Array | string): Promise<void> {
      // e2b 的 write() 原生在目标路径缺失时创建所需的父目录——与 MemoryFS 的
      // ensureParentDirs 语义一致，适配器不需要再补一次 mkdir。
      const payload = typeof data === "string" ? data : toArrayBuffer(data);
      await sandbox.files.write(anchor.toReal(path), payload);
    },

    async rm(path: string, opts?: { recursive?: boolean }): Promise<void> {
      const real = anchor.toReal(path);
      let info: E2bEntryInfo;
      try {
        info = await sandbox.files.getInfo(real);
      } catch (error) {
        if (isE2bErrorNamed(error, ...NOT_FOUND_NAMES)) throw new NotFoundError(path);
        throw error;
      }
      // e2b 的 remove() 恒递归（没有"非递归删非空目录就报错"的选项）——非
      // recursive 调用必须自己先查一层子项再决定要不要拒绝，对齐 MemoryFS
      // 的 DirectoryNotEmptyError 语义（docs/tech/sandbox.md §8.2）。
      if (opts?.recursive !== true && info.type !== "file") {
        const children = await sandbox.files.list(real, { depth: 1 });
        if (children.length > 0) throw new DirectoryNotEmptyError(path);
      }
      await sandbox.files.remove(real);
    },

    async mkdir(path: string): Promise<void> {
      // makeDir() 原生递归创建路径上缺失的所有父目录，语义与 MemoryFS.mkdir 一致。
      await sandbox.files.makeDir(anchor.toReal(path));
    },

    async readdir(path: string): Promise<DirEntry[]> {
      const real = anchor.toReal(path);
      let entries: E2bEntryInfo[];
      try {
        entries = await sandbox.files.list(real, { depth: 1 });
      } catch (error) {
        if (isE2bErrorNamed(error, ...NOT_FOUND_NAMES)) throw new NotFoundError(path);
        throw error;
      }
      return entries.map((entry) => ({ name: entry.name, ...toFileStat(entry) })).sort((a, b) => a.name.localeCompare(b.name));
    },

    async stat(path: string): Promise<FileStat> {
      const real = anchor.toReal(path);
      try {
        const info = await sandbox.files.getInfo(real);
        return toFileStat(info);
      } catch (error) {
        if (isE2bErrorNamed(error, ...NOT_FOUND_NAMES)) throw new NotFoundError(path);
        throw error;
      }
    },

    async glob(pattern: string): Promise<string[]> {
      // e2b 没有原生 glob：递归列出 root 下全部条目（大 depth）+ 客户端
      // matcher，不依赖沙盒内是否装了 find（docs/tech/sandbox.md §4 决策点 4）。
      let entries: E2bEntryInfo[];
      try {
        entries = await sandbox.files.list(anchor.rootReal, { depth: GLOB_LIST_DEPTH });
      } catch (error) {
        if (isE2bErrorNamed(error, ...NOT_FOUND_NAMES)) throw new NotFoundError("/");
        throw error;
      }
      const matches: string[] = [];
      for (const entry of entries) {
        if (entry.type !== "file") continue; // 只返回文件，目录不算匹配结果
        const virtual = anchor.toVirtual(entry.path);
        if (matchesGlob(pattern, virtual)) matches.push(virtual);
      }
      return matches.sort();
    },
  };
}
