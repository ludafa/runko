/**
 * @nimbo/virtual-fs 公共入口（tech-spec §4.4）：MemoryFS/OverlayFS/DirFS 三个
 * NimboFS 实现，mime 推断，diff/patch，reference 条目相关类型与错误。
 *
 * 工厂函数是独立导出的 fromMemory/fromDirectory，不是 `NimboFS.fromMemory` 这种
 * 值命名空间——理由见 memory.ts 顶部注释（与 @nimbo/core 的 NimboFS 类型名冲突）。
 */

export { PathEscapesRootError, normalizePath, dirname, basename, globToRegExp, matchesGlob } from "./path.js";

export { DEFAULT_MIME_TYPE, inferMimeType } from "./mime.js";

export type { FileDiff, FileDiffKind } from "./diff.js";
export { computeUnifiedDiff, buildFileDiff } from "./diff.js";

export {
  MemoryFS,
  fromMemory,
  NotFoundError,
  DirectoryNotEmptyError,
  ReferenceNotResolvable,
} from "./memory.js";
export type {
  ReferenceAnnotations,
  ReferenceInit,
  ReferenceEntryInfo,
  ReferenceNotResolvableInfo,
  ResolveReference,
  MemoryFSOptions,
  MemoryFSSnapshot,
  MemoryFSSnapshotEntry,
  MemoryFSSnapshotFileEntry,
  MemoryFSSnapshotReferenceEntry,
} from "./memory.js";

export { DirFS, ReadOnlyFileSystemError } from "./dir.js";
export type { DirFSOptions } from "./dir.js";

export { OverlayFS, fromDirectory } from "./overlay.js";
export type { OverlayFSSnapshot } from "./overlay.js";

export { createFileTools } from "./tools/index.js";
export type { CreateFileToolsOptions, FileChange, FileToolName, ReadStateStore } from "./tools/index.js";
