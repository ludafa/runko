/**
 * OverlayFS：base（只读）+ overlay（MemoryFS，承接写入与删除墓碑）（docs/tech/core-sdk.md §4.4）。
 * 读穿透 base、写覆盖进 overlay、删除记墓碑（base 条目随之从 readdir/stat/glob 消失）。
 */
import * as nodeFs from "node:fs/promises";
import * as nodePath from "node:path";
import type { DirEntry, FileStat, NimboFS } from "@nimbo/core";
import { DirFS, type DirFSOptions } from "./dir.js";
import { buildFileDiff, type FileDiff } from "./diff.js";
import { DirectoryNotEmptyError, MemoryFS, NotFoundError, type MemoryFSSnapshot } from "./memory.js";
import { dirname, normalizePath } from "./path.js";

export interface OverlayFSSnapshot {
  overlay: MemoryFSSnapshot;
  tombstones: string[];
}

const textDecoder = new TextDecoder();

export class OverlayFS implements NimboFS {
  private readonly base: NimboFS;
  private readonly overlayFs: MemoryFS;
  private tombstones = new Set<string>();

  constructor(base: NimboFS, overlay: MemoryFS = new MemoryFS()) {
    this.base = base;
    this.overlayFs = overlay;
  }

  /** path 本身或其任一祖先目录被整体删除过（recursive rm 只记目录路径，不逐文件枚举）。 */
  private isTombstoned(path: string): boolean {
    let current: string | undefined = path;
    while (current !== undefined) {
      if (this.tombstones.has(current)) {return true;}
      const parent = dirname(current);
      current = parent === current ? undefined : parent;
    }
    return false;
  }

  /**
   * 假设：base 对不存在的路径统一抛 NotFoundError——我们自己的三个实现
   * （MemoryFS/OverlayFS/DirFS）都遵守这一约定。接入第三方 NimboFS 作为 base
   * 时需保证同样的约定，否则请自行包一层做错误归一化。
   */
  private async existsIn(fs: NimboFS, path: string): Promise<boolean> {
    try {
      await fs.stat(path);
      return true;
    } catch (error) {
      if (error instanceof NotFoundError) {return false;}
      throw error;
    }
  }

  async readFile(path: string): Promise<Uint8Array> {
    const p = normalizePath(path);
    if (await this.existsIn(this.overlayFs, p)) {return this.overlayFs.readFile(p);}
    if (this.isTombstoned(p)) {throw new NotFoundError(p);}
    return this.base.readFile(p);
  }

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    await this.overlayFs.writeFile(normalizePath(path), data);
  }

  async mkdir(path: string): Promise<void> {
    await this.overlayFs.mkdir(normalizePath(path));
  }

  async rm(path: string, opts?: { recursive?: boolean }): Promise<void> {
    const p = normalizePath(path);
    const st = await this.stat(p);
    if (st.type === "dir" && !opts?.recursive) {
      const children = await this.readdir(p);
      if (children.length > 0) {throw new DirectoryNotEmptyError(p);}
    }
    this.tombstones.add(p);
    if (await this.existsIn(this.overlayFs, p)) {
      await this.overlayFs.rm(p, { recursive: true });
    }
  }

  async readdir(path: string): Promise<DirEntry[]> {
    const p = normalizePath(path);
    if (this.isTombstoned(p) && !(await this.existsIn(this.overlayFs, p))) {
      throw new NotFoundError(p);
    }
    const merged = new Map<string, DirEntry>();
    let baseEntries: DirEntry[] = [];
    try {
      baseEntries = await this.base.readdir(p);
    } catch {
      baseEntries = [];
    }
    for (const entry of baseEntries) {
      const childPath = p === "/" ? `/${entry.name}` : `${p}/${entry.name}`;
      if (this.isTombstoned(childPath) && !(await this.existsIn(this.overlayFs, childPath))) {continue;}
      merged.set(entry.name, entry);
    }
    let overlayEntries: DirEntry[] = [];
    try {
      overlayEntries = await this.overlayFs.readdir(p);
    } catch {
      overlayEntries = [];
    }
    for (const entry of overlayEntries) {
      merged.set(entry.name, entry); // overlay 写覆盖同名 base 条目
    }
    return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async stat(path: string): Promise<FileStat> {
    const p = normalizePath(path);
    if (await this.existsIn(this.overlayFs, p)) {return this.overlayFs.stat(p);}
    if (this.isTombstoned(p)) {throw new NotFoundError(p);}
    return this.base.stat(p);
  }

  async glob(pattern: string): Promise<string[]> {
    const [baseMatches, overlayMatches] = await Promise.all([
      this.base.glob(pattern).catch((): string[] => []),
      this.overlayFs.glob(pattern),
    ]);
    const result = new Set<string>(overlayMatches);
    for (const p of baseMatches) {
      if (this.isTombstoned(p)) {continue;}
      result.add(p);
    }
    return [...result].sort();
  }

  /**
   * base 层里落在某个已删除路径前缀下、且没有被 overlay 单独"复活"的文件——
   * rm(dir, {recursive:true}) 只记了目录本身这一个墓碑，实际被隐藏的叶子文件
   * 在这里通过 base.glob(`${tombstone}/**`) 现场枚举出来，而不是在 rm() 时
   * 就展开记录（那样会让墓碑集合随 base 内容变化而失真）。
   */
  private async collectDeletedBaseFiles(): Promise<string[]> {
    const deleted = new Set<string>();
    for (const t of this.tombstones) {
      let st: FileStat | undefined;
      try {
        st = await this.base.stat(t);
      } catch {
        st = undefined;
      }
      if (!st) {continue;}
      if (st.type === "file") {
        if (!(await this.existsIn(this.overlayFs, t))) {deleted.add(t);}
        continue;
      }
      if (st.type === "dir") {
        const suffix = t === "/" ? "/**" : `${t}/**`;
        const nested = await this.base.glob(suffix).catch((): string[] => []);
        for (const f of nested) {
          if (!(await this.existsIn(this.overlayFs, f))) {deleted.add(f);}
        }
      }
    }
    return [...deleted];
  }

  /** 三态：overlay 里的每个文件相对 base 同路径判 created/modified；被墓碑覆盖的 base 文件判 deleted。 */
  async diff(): Promise<FileDiff[]> {
    const results: FileDiff[] = [];
    const overlayPaths = await this.overlayFs.glob("**");
    for (const path of overlayPaths) {
      const after = textDecoder.decode(await this.overlayFs.readFile(path));
      let before: string | undefined;
      if (await this.existsIn(this.base, path)) {
        const baseStat = await this.base.stat(path);
        if (baseStat.type === "file") {
          before = textDecoder.decode(await this.base.readFile(path));
        }
        // base 侧是 dir/reference：没有可比的文本基线，按 created 处理。
      }
      const fileDiff = buildFileDiff(path, before, after);
      if (fileDiff) {results.push(fileDiff);}
    }
    for (const path of await this.collectDeletedBaseFiles()) {
      const before = textDecoder.decode(await this.base.readFile(path));
      const fileDiff = buildFileDiff(path, before, undefined);
      if (fileDiff) {results.push(fileDiff);}
    }
    return results.sort((a, b) => a.path.localeCompare(b.path));
  }

  private defaultWriteBackDir(): string {
    if (this.base instanceof DirFS) {return this.base.rootDir;}
    throw new Error("writeBack(targetDir) requires an explicit targetDir when base is not a DirFS");
  }

  /** 唯一写真实磁盘的操作；对 diff() 结果逐条应用，幂等（重复调用产出相同磁盘状态）。 */
  async writeBack(targetDir?: string): Promise<void> {
    const dir = targetDir ?? this.defaultWriteBackDir();
    const changes = await this.diff();
    for (const change of changes) {
      const real = nodePath.join(dir, ...change.path.split("/").filter((s) => s.length > 0));
      if (change.kind === "deleted") {
        await nodeFs.rm(real, { force: true });
        continue;
      }
      await nodeFs.mkdir(nodePath.dirname(real), { recursive: true });
      await nodeFs.writeFile(real, change.after ?? "");
    }
  }

  snapshot(): OverlayFSSnapshot {
    return { overlay: this.overlayFs.snapshot(), tombstones: [...this.tombstones] };
  }

  restore(snapshot: OverlayFSSnapshot): void {
    this.overlayFs.restore(snapshot.overlay);
    this.tombstones = new Set(snapshot.tombstones);
  }
}

/**
 * 命名说明同 fromMemory：tech-spec 写的是 `NimboFS.fromDirectory(...)`，这里改为
 * 独立函数，理由见 memory.ts 顶部注释。
 */
export function fromDirectory(dir: string, opts?: DirFSOptions): OverlayFS {
  return new OverlayFS(new DirFS(dir, opts));
}
