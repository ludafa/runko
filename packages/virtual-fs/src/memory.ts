/**
 * MemoryFS：纯内存路径树，实现 core 的 RunkoFS 全部七方法（docs/tech/core-sdk.md §4.4）。
 * 另提供不进 RunkoFS 接口的"附加能力"：writeReference（供 fromMemory 构造 reference
 * 条目）、diff()/writeBack()/snapshot()/restore()（§4.4 第 5 点）。
 */
import * as nodeFs from "node:fs/promises";
import * as nodePath from "node:path";
import type { DirEntry, FileStat, RunkoFS } from "@runko/core";
import { buildFileDiff, type FileDiff } from "./diff.js";
import { inferMimeType } from "./mime.js";
import { basename, dirname, globToRegExp, normalizePath } from "./path.js";

export class NotFoundError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`no such file or directory: "${path}"`);
    this.name = "NotFoundError";
    this.path = path;
  }
}

export class DirectoryNotEmptyError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`directory not empty (pass { recursive: true } to delete): "${path}"`);
    this.name = "DirectoryNotEmptyError";
    this.path = path;
  }
}

export interface ReferenceAnnotations {
  description?: string;
  tags?: string[];
}

/** fromMemory() 里构造 reference 条目的输入形状。 */
export interface ReferenceInit {
  ref: string;
  mimeType?: string;
  annotations?: ReferenceAnnotations;
}

/** 注入 resolveReference 时，传给它的只读上下文。 */
export interface ReferenceEntryInfo {
  path: string;
  href: string;
  mimeType?: string;
  annotations?: ReferenceAnnotations;
}

export type ResolveReference = (entry: ReferenceEntryInfo) => Promise<Uint8Array>;

/** readFile() 对未注入 resolver 的 reference 条目抛出——携带指引字段而非裸错误。 */
export interface ReferenceNotResolvableInfo {
  path: string;
  href: string;
  mimeType?: string;
  description?: string;
}

export class ReferenceNotResolvable extends Error {
  readonly path: string;
  readonly href: string;
  readonly mimeType?: string;
  readonly description?: string;
  constructor(info: ReferenceNotResolvableInfo) {
    super(
      `reference entry at "${info.path}" cannot be read directly: no resolveReference() was injected. ` +
        `href=${info.href}` +
        (info.mimeType ? `, mimeType=${info.mimeType}` : "") +
        (info.description ? `. ${info.description}` : "") +
        " Inject { resolveReference } when constructing the FS to read this entry's content, or use stat()'s href instead.",
    );
    this.name = "ReferenceNotResolvable";
    this.path = info.path;
    this.href = info.href;
    this.mimeType = info.mimeType;
    this.description = info.description;
  }
}

interface FileEntry {
  kind: "file";
  data: Uint8Array;
  mtime: number;
  mimeType?: string;
}

interface ReferenceEntry {
  kind: "reference";
  ref: string;
  mimeType?: string;
  annotations?: ReferenceAnnotations;
  mtime: number;
}

type Entry = FileEntry | ReferenceEntry;

export interface MemoryFSSnapshotFileEntry {
  kind: "file";
  dataBase64: string;
  mtime: number;
  mimeType?: string;
}

export interface MemoryFSSnapshotReferenceEntry {
  kind: "reference";
  ref: string;
  mtime: number;
  mimeType?: string;
  annotations?: ReferenceAnnotations;
}

export type MemoryFSSnapshotEntry = MemoryFSSnapshotFileEntry | MemoryFSSnapshotReferenceEntry;

/** snapshot()/restore() 的可序列化载体：纯字符串/数字/普通对象，JSON.stringify 安全。 */
export interface MemoryFSSnapshot {
  files: Record<string, MemoryFSSnapshotEntry>;
  dirs: string[];
}

export interface MemoryFSOptions {
  resolveReference?: ResolveReference;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class MemoryFS implements RunkoFS {
  private files = new Map<string, Entry>();
  private dirs = new Set<string>(["/"]);
  private clock = 0;
  private readonly resolveReferenceFn: ResolveReference | undefined;

  constructor(opts?: MemoryFSOptions) {
    this.resolveReferenceFn = opts?.resolveReference;
  }

  /**
   * 单调递增，不依赖 Date.now() 的分辨率——同一毫秒内的连续写入也必须严格递增，
   * 否则 readState 的 "mtime 变了就必须重读" 判据会漏判。
   */
  private nextMtime(): number {
    const now = Date.now();
    this.clock = now > this.clock ? now : this.clock + 1;
    return this.clock;
  }

  private ensureDir(path: string): void {
    if (this.dirs.has(path)) {return;}
    const parent = dirname(path);
    if (parent !== path) {this.ensureDir(parent);}
    this.dirs.add(path);
  }

  private ensureParentDirs(path: string): void {
    this.ensureDir(dirname(path));
  }

  async readFile(path: string): Promise<Uint8Array> {
    const p = normalizePath(path);
    const entry = this.files.get(p);
    if (!entry) {
      if (this.dirs.has(p)) {throw new Error(`cannot read: "${p}" is a directory`);}
      throw new NotFoundError(p);
    }
    if (entry.kind === "reference") {
      if (this.resolveReferenceFn) {
        return this.resolveReferenceFn({ path: p, href: entry.ref, mimeType: entry.mimeType, annotations: entry.annotations });
      }
      throw new ReferenceNotResolvable({
        path: p,
        href: entry.ref,
        mimeType: entry.mimeType,
        description: entry.annotations?.description,
      });
    }
    return entry.data;
  }

  /**
   * 没有内部 await（纯同步 Map 操作），所以尽管签名是 async / 返回 Promise<void>，
   * JS 语义保证函数体在返回前已同步跑完——fromMemory() 据此可以不 await 直接调用，
   * 仍能保证在它自己返回前所有条目都已写入完毕。
   */
  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    const p = normalizePath(path);
    if (this.dirs.has(p)) {throw new Error(`cannot write: "${p}" is a directory`);}
    this.ensureParentDirs(p);
    const bytes = typeof data === "string" ? textEncoder.encode(data) : data;
    const existing = this.files.get(p);
    this.files.set(p, {
      kind: "file",
      data: bytes,
      mtime: this.nextMtime(),
      mimeType: existing?.kind === "file" ? existing.mimeType : undefined,
    });
  }

  /** 不在 RunkoFS 接口内——fromMemory() 用它构造 reference 条目。同步，理由同 writeFile。 */
  writeReference(path: string, init: ReferenceInit): void {
    const p = normalizePath(path);
    if (this.dirs.has(p)) {throw new Error(`cannot write: "${p}" is a directory`);}
    this.ensureParentDirs(p);
    this.files.set(p, {
      kind: "reference",
      ref: init.ref,
      mimeType: init.mimeType,
      annotations: init.annotations,
      mtime: this.nextMtime(),
    });
  }

  async rm(path: string, opts?: { recursive?: boolean }): Promise<void> {
    const p = normalizePath(path);
    if (p === "/") {throw new Error("cannot remove the root directory");}
    const isDir = this.dirs.has(p);
    const isFile = this.files.has(p);
    if (!isDir && !isFile) {throw new NotFoundError(p);}
    if (isDir) {
      const prefix = `${p}/`;
      const childDirs = [...this.dirs].filter((d) => d.startsWith(prefix));
      const childFiles = [...this.files.keys()].filter((f) => f.startsWith(prefix));
      if (!opts?.recursive && (childDirs.length > 0 || childFiles.length > 0)) {
        throw new DirectoryNotEmptyError(p);
      }
      for (const d of childDirs) {this.dirs.delete(d);}
      for (const f of childFiles) {this.files.delete(f);}
      this.dirs.delete(p);
    } else {
      this.files.delete(p);
    }
  }

  async mkdir(path: string): Promise<void> {
    const p = normalizePath(path);
    if (this.files.has(p)) {throw new Error(`cannot mkdir: a file already exists at "${p}"`);}
    this.ensureDir(p);
  }

  async readdir(path: string): Promise<DirEntry[]> {
    const p = normalizePath(path);
    if (!this.dirs.has(p)) {
      if (this.files.has(p)) {throw new Error(`cannot readdir: "${p}" is not a directory`);}
      throw new NotFoundError(p);
    }
    const entries: DirEntry[] = [];
    for (const d of this.dirs) {
      if (d !== "/" && dirname(d) === p) {
        entries.push({ name: basename(d), type: "dir" });
      }
    }
    for (const [filePath, entry] of this.files) {
      if (dirname(filePath) === p) {
        entries.push(this.toDirEntry(basename(filePath), filePath, entry));
      }
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return entries;
  }

  async stat(path: string): Promise<FileStat> {
    const p = normalizePath(path);
    if (this.dirs.has(p)) {return { type: "dir" };}
    const entry = this.files.get(p);
    if (!entry) {throw new NotFoundError(p);}
    return this.toFileStat(p, entry);
  }

  async glob(pattern: string): Promise<string[]> {
    const re = globToRegExp(pattern);
    const matches: string[] = [];
    for (const filePath of this.files.keys()) {
      if (re.test(filePath)) {matches.push(filePath);}
    }
    return matches.sort();
  }

  private toFileStat(path: string, entry: Entry): FileStat {
    if (entry.kind === "reference") {
      return {
        type: "reference",
        href: entry.ref,
        mimeType: entry.mimeType ?? inferMimeType(path),
        annotations: entry.annotations,
        mtime: entry.mtime,
      };
    }
    return {
      type: "file",
      size: entry.data.byteLength,
      mimeType: entry.mimeType ?? inferMimeType(path),
      mtime: entry.mtime,
    };
  }

  private toDirEntry(name: string, path: string, entry: Entry): DirEntry {
    return { name, ...this.toFileStat(path, entry) };
  }

  /**
   * MemoryFS 没有持久的 base 层可比较，因此 diff() 恒以"空文件系统"为基线，把当前
   * 每个文件条目报告为 created；真正有意义的三态（modified/deleted）比较需要一个
   * 独立的 base，见 OverlayFS.diff()。reference 条目没有本地文本内容，不参与 diff。
   */
  diff(): FileDiff[] {
    const results: FileDiff[] = [];
    for (const [path, entry] of this.files) {
      if (entry.kind === "reference") {continue;}
      const after = textDecoder.decode(entry.data);
      const fileDiff = buildFileDiff(path, undefined, after);
      if (fileDiff) {results.push(fileDiff);}
    }
    return results.sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * 唯一写真实磁盘的操作。targetDir 必填——MemoryFS 没有"默认应该写到哪个真实目录"
   * 的概念（这一点由 OverlayFS 通过其 DirFS base 提供默认值）。幂等：重复调用对
   * 同一 targetDir 产出相同的磁盘状态（mkdir+writeFile 天然覆盖写）。
   */
  async writeBack(targetDir: string): Promise<void> {
    for (const [path, entry] of this.files) {
      if (entry.kind !== "file") {continue;} // reference 条目没有本地内容可写
      const real = nodePath.join(targetDir, ...path.split("/").filter((s) => s.length > 0));
      await nodeFs.mkdir(nodePath.dirname(real), { recursive: true });
      await nodeFs.writeFile(real, entry.data);
    }
  }

  /**
   * 未设置的可选字段（file 的 `mimeType`；reference 的 `mimeType`/`annotations`）
   * 用条件展开省略键，而非写显式 `undefined` 值（先例见 `tools/read-file.ts`
   * 的 `...(x !== undefined ? { x } : {})`）——`undefined` 值精确落在
   * `jsonValueSchema` 的拒绝范围内（P7-2 施工时在 `session.ts` 的
   * `toCleanJsonValue` 防御层发现的跨包 bug，根因在此修复；`toCleanJsonValue`
   * 作为信任边界防御层保留，不因这里的根因修复而移除）。
   */
  snapshot(): MemoryFSSnapshot {
    const files: Record<string, MemoryFSSnapshotEntry> = {};
    for (const [path, entry] of this.files) {
      files[path] =
        entry.kind === "file"
          ? {
              kind: "file",
              dataBase64: Buffer.from(entry.data).toString("base64"),
              mtime: entry.mtime,
              ...(entry.mimeType !== undefined ? { mimeType: entry.mimeType } : {}),
            }
          : {
              kind: "reference",
              ref: entry.ref,
              mtime: entry.mtime,
              ...(entry.mimeType !== undefined ? { mimeType: entry.mimeType } : {}),
              ...(entry.annotations !== undefined ? { annotations: entry.annotations } : {}),
            };
    }
    return { files, dirs: [...this.dirs] };
  }

  restore(snapshot: MemoryFSSnapshot): void {
    const files = new Map<string, Entry>();
    for (const [path, entry] of Object.entries(snapshot.files)) {
      files.set(
        path,
        entry.kind === "file"
          ? {
              kind: "file",
              data: new Uint8Array(Buffer.from(entry.dataBase64, "base64")),
              mtime: entry.mtime,
              mimeType: entry.mimeType,
            }
          : {
              kind: "reference",
              ref: entry.ref,
              mtime: entry.mtime,
              mimeType: entry.mimeType,
              annotations: entry.annotations,
            },
      );
    }
    this.files = files;
    this.dirs = new Set(snapshot.dirs);
  }
}

/**
 * `files` 的每个值：string/Uint8Array 走 writeFile，ReferenceInit（`{ ref, ... }`）
 * 走 writeReference——三者是可判别联合，typeof/instanceof 足以让编译器自然收窄到
 * else 分支就是 ReferenceInit，不需要额外的类型守卫函数或断言。
 *
 * 命名说明（工单裁量）：docs/tech/core-sdk.md §4.4 写的是 `RunkoFS.fromMemory(...)`，但
 * `RunkoFS` 在 @runko/core 是一个 interface（类型），在 @runko/virtual-fs 里
 * 再声明一个同名的值做静态方法命名空间会与该类型名冲突，且跨包做 interface+
 * namespace 合并并不成立。这里改为导出独立函数 fromMemory；`RunkoFS.fromMemory`
 * 这种门面呈现方式留给 P7（@runko/sdk）在 re-export 时按需包一层。
 */
export function fromMemory(
  files: Record<string, string | Uint8Array | ReferenceInit> = {},
  opts?: MemoryFSOptions,
): MemoryFS {
  const fs = new MemoryFS(opts);
  for (const [rawPath, value] of Object.entries(files)) {
    const path = normalizePath(rawPath);
    if (typeof value === "string" || value instanceof Uint8Array) {
      void fs.writeFile(path, value);
    } else {
      fs.writeReference(path, value);
    }
  }
  return fs;
}
