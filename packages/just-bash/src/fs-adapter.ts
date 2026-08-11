/**
 * `NimboFS` → just-bash `IFileSystem` 适配器（docs/core/core-sdk/tech.md §4.5b 降级表）。
 *
 * 逐行对应降级表：
 *   - readFile/readFileBuffer/writeFile/mkdir/readdir/rm/stat/exists：NimboFS
 *     七方法直译（string 经 TextDecoder/TextEncoder；`exists` 由 `stat` 派生
 *     ——NimboFS 本身没有 exists 原语，"直译"在这里就是"用 stat 的成败判断"）。
 *   - appendFile/cp/mv：组合原语（read+concat+write；read+write[+rm]）。cp/mv
 *     的目标路径解析（"cp file 到已存在目录" 之类的 basename 拼接）已经在
 *     just-bash 自己的 `cp`/`mv` 命令层完成——实测确认（见工单调研）传给
 *     `IFileSystem.cp/mv` 的两个路径已经是最终的绝对源/目的路径，适配器不需要
 *     再猜测"dest 是不是一个目录"。目录场景（`cp -r`/`mv` 目录）用
 *     `fs.glob("<src>/**")` 枚举子树里的全部文件逐个 read+write（+ 对 mv 再
 *     `rm(src, {recursive:true})`）——空子目录不参与（`NimboFS.glob` 只报
 *     文件，§4.4 已有的限制，这里顺着继承，不额外发明目录物化）。
 *   - resolvePath/realpath：纯路径规范化（`path.ts` 的 `resolvePath`/
 *     `normalizePath`）；没有 symlink，realpath 就是 normalize。
 *   - getAllPaths：`fs.glob("**")` + 从文件路径合成目录集合。**但**
 *     `IFileSystem.getAllPaths()` 的签名是**同步**的（`(): string[]`），而
 *     `NimboFS.glob()` 是异步的——这是一个真实的接口不匹配（sync/async
 *     mismatch），不是实现疏忽。解法：适配器维护一个内部同步缓存
 *     `allPathsCache`，`getAllPaths()` 只读它；`refreshAllPaths()`（不在
 *     `IFileSystem` 里，是适配器额外暴露的方法）异步刷新这个缓存，由
 *     `exec.ts` 在每次顶层 `exec()` 调用开始时 await 一次（工单裁量，见
 *     `exec.ts` 头注释）。代价：脚本执行**期间**新写入的文件在同一次
 *     `exec()` 调用内的 `**` 展开里看不到（要下一次 `exec()` 调用才刷新）
 *     ——如实记录为已知限制，而不是假装同步语义能被绕过。
 *   - chmod/utimes：no-op 成功（脚本常见惯用法，硬失败徒增纠错轮次）。
 *   - symlink/link/readlink：抛不支持；lstat = stat，isSymbolicLink 恒 false。
 *   - reference 条目：`stat()` 视为 file（`FileStat.type !== "dir"` 即
 *     `isFile: true`）；`readFile()` 对未注入 resolver 的 reference 条目会让
 *     `NimboFS` 实现自己抛出的 `ReferenceNotResolvable` 原样冒泡——just-bash
 *     的内置命令（cat 等）会把这个 Error 的 `.message` 转成形如
 *     `cat: <path>: <message>` 的命令级错误文本，天然满足"自然浮出为命令
 *     错误文本"，适配器不需要特殊处理。
 *
 * 可选成员的裁量（工单："是否实现裁量并报告"）：两个都实现了。
 *   - `readFileBytes`：just-bash 包顶层**没有**导出 `bytesFromUint8Array`
 *     （只有 `encoding.ts` 内部用；`dist/index.d.ts` 的重导出列表里没有它，
 *     实测确认）。改用同样导出的 `unsafeBytesFromLatin1(latin1String)`：把
 *     `Uint8Array` 转成"每字符一字节"的 latin1 字符串再打标签成
 *     `ByteString`——语义等价，只是绕过了一个未导出的内部辅助函数。
 *   - `readdirWithFileTypes`：`NimboFS.readdir()` 的 `DirEntry` 本来就带
 *     `type` 字段，直接映射成 `DirentEntry` 是免费的（避免解释器退化到
 *     `readdir` + 逐条 `stat` 的慢路径）。
 */
import type { DirEntry, FileStat, NimboFS } from "@nimbo/core";
import type { CpOptions, FsStat, IFileSystem, RmOptions } from "just-bash";
import { unsafeBytesFromLatin1 } from "just-bash";
import { dirnameOf, normalizePath, resolvePath as resolveVirtualPath } from "./path.js";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

const FILE_MODE = 0o644;
const DIR_MODE = 0o755;

/** reference 条目 stat 视为 file（降级表原文）。 */
function toFsStat(stat: FileStat): FsStat {
  const isDirectory = stat.type === "dir";
  return {
    isFile: !isDirectory,
    isDirectory,
    isSymbolicLink: false,
    mode: isDirectory ? DIR_MODE : FILE_MODE,
    size: stat.size ?? 0,
    mtime: new Date(stat.mtime ?? 0),
  };
}

async function statImpl(fs: NimboFS, path: string): Promise<FsStat> {
  const stat = await fs.stat(normalizePath(path));
  return toFsStat(stat);
}

async function existsImpl(fs: NimboFS, path: string): Promise<boolean> {
  try {
    await fs.stat(normalizePath(path));
    return true;
  } catch {
    return false;
  }
}

/** `${dir}/**` 形式的 glob 模式，匹配 dir 子树下的全部文件（不含 dir 自身）。 */
function subtreeGlobPattern(dir: string): string {
  return dir === "/" ? "/**" : `${dir}/**`;
}

/** 把子树内某个文件的绝对路径，重定位到新的根 `destRoot` 下。 */
function relocate(srcRoot: string, destRoot: string, filePath: string): string {
  const prefix = srcRoot === "/" ? "/" : `${srcRoot}/`;
  const rel = filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath.slice(srcRoot.length);
  return destRoot === "/" ? `/${rel}` : `${destRoot}/${rel}`;
}

/** cp -r / mv 目录场景的共用体：把 src 子树下每个文件 read 出来再 write 到重定位后的 dest 路径。空子目录不参与（NimboFS.glob 只报文件）。 */
async function copySubtree(fs: NimboFS, src: string, dest: string): Promise<void> {
  const files = await fs.glob(subtreeGlobPattern(src));
  for (const filePath of files) {
    const data = await fs.readFile(filePath);
    await fs.writeFile(relocate(src, dest, filePath), data);
  }
}

async function cpImpl(fs: NimboFS, src: string, dest: string, options: CpOptions | undefined): Promise<void> {
  const srcPath = normalizePath(src);
  const destPath = normalizePath(dest);
  const stat = await fs.stat(srcPath);
  if (stat.type === "dir") {
    if (options?.recursive !== true) {
      throw new Error(`cp: -r not specified; omitting directory '${src}'`);
    }
    await copySubtree(fs, srcPath, destPath);
    return;
  }
  const data = await fs.readFile(srcPath);
  await fs.writeFile(destPath, data);
}

async function mvImpl(fs: NimboFS, src: string, dest: string): Promise<void> {
  const srcPath = normalizePath(src);
  const destPath = normalizePath(dest);
  const stat = await fs.stat(srcPath);
  if (stat.type === "dir") {
    await copySubtree(fs, srcPath, destPath);
    await fs.rm(srcPath, { recursive: true });
    return;
  }
  const data = await fs.readFile(srcPath);
  await fs.writeFile(destPath, data);
  await fs.rm(srcPath);
}

async function rmImpl(fs: NimboFS, path: string, options: RmOptions | undefined): Promise<void> {
  try {
    await fs.rm(normalizePath(path), { recursive: options?.recursive });
  } catch (error) {
    if (options?.force === true) return; // force：不存在也不算错误（IFileSystem.rm 的文档契约）
    throw error;
  }
}

async function appendFileImpl(fs: NimboFS, path: string, addition: Uint8Array): Promise<void> {
  const normalized = normalizePath(path);
  let existing: Uint8Array;
  try {
    existing = await fs.readFile(normalized);
  } catch {
    existing = new Uint8Array(0); // 不存在则视为从空文件开始（IFileSystem.appendFile 的文档契约："creating it if it doesn't exist"）
  }
  const combined = new Uint8Array(existing.length + addition.length);
  combined.set(existing, 0);
  combined.set(addition, existing.length);
  await fs.writeFile(normalized, combined);
}

/** `getAllPaths()` 的额外刷新入口，不属于 `IFileSystem`——见文件头注释"sync/async mismatch"一节。 */
export interface JustBashFsAdapter extends IFileSystem {
  refreshAllPaths(): Promise<void>;
}

export function createFsAdapter(fs: NimboFS): JustBashFsAdapter {
  let allPathsCache: string[] = [];

  async function refreshAllPaths(): Promise<void> {
    const files = await fs.glob("**");
    const dirs = new Set<string>(["/"]);
    for (const file of files) {
      let dir = dirnameOf(file);
      while (!dirs.has(dir)) {
        dirs.add(dir);
        const parent = dirnameOf(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
    allPathsCache = [...files, ...dirs];
  }

  const adapter: JustBashFsAdapter = {
    async readFile(path) {
      const bytes = await fs.readFile(normalizePath(path));
      return textDecoder.decode(bytes);
    },

    async readFileBytes(path) {
      const bytes = await fs.readFile(normalizePath(path));
      return unsafeBytesFromLatin1(Buffer.from(bytes).toString("latin1"));
    },

    async readFileBuffer(path) {
      return fs.readFile(normalizePath(path));
    },

    async writeFile(path, content) {
      await fs.writeFile(normalizePath(path), content);
    },

    async appendFile(path, content) {
      const addition = typeof content === "string" ? textEncoder.encode(content) : content;
      await appendFileImpl(fs, path, addition);
    },

    async exists(path) {
      return existsImpl(fs, path);
    },

    async stat(path) {
      return statImpl(fs, path);
    },

    async mkdir(path) {
      await fs.mkdir(normalizePath(path));
    },

    async readdir(path) {
      const entries: DirEntry[] = await fs.readdir(normalizePath(path));
      return entries.map((entry) => entry.name);
    },

    async readdirWithFileTypes(path) {
      const entries: DirEntry[] = await fs.readdir(normalizePath(path));
      return entries.map((entry) => ({
        name: entry.name,
        isFile: entry.type === "file" || entry.type === "reference",
        isDirectory: entry.type === "dir",
        isSymbolicLink: false,
      }));
    },

    async rm(path, options) {
      await rmImpl(fs, path, options);
    },

    async cp(src, dest, options) {
      await cpImpl(fs, src, dest, options);
    },

    async mv(src, dest) {
      await mvImpl(fs, src, dest);
    },

    resolvePath(base, path) {
      return resolveVirtualPath(base, path);
    },

    getAllPaths() {
      return allPathsCache;
    },

    async chmod() {
      // no-op 成功（降级表：脚本常见惯用法，硬失败徒增纠错轮次）。
    },

    async symlink(target, linkPath) {
      throw new Error(`just-bash adapter: symlink is not supported (no symlink concept in NimboFS v1): '${linkPath}' -> '${target}'`);
    },

    async link(existingPath, newPath) {
      throw new Error(`just-bash adapter: hard link is not supported (no symlink concept in NimboFS v1): '${newPath}' -> '${existingPath}'`);
    },

    async readlink(path) {
      throw new Error(`just-bash adapter: readlink is not supported (no symlink concept in NimboFS v1): '${path}'`);
    },

    async lstat(path) {
      return statImpl(fs, path); // 无 symlink：lstat = stat（降级表）。
    },

    async realpath(path) {
      return normalizePath(path); // 无 symlink：realpath = normalize（降级表）。
    },

    async utimes() {
      // no-op 成功（降级表，同 chmod）。
    },

    refreshAllPaths,
  };

  return adapter;
}
