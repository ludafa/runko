# @nimbo/virtual-fs

nimbo 的虚拟文件系统内核（`NimboFS` 接口的三个实现 + 文件工具八件套）：agent 视角是普通文件系统，宿主视角是一个可检查、可导出 diff、可写回、可丢弃的对象——写入默认永不落真实磁盘。

> 一般用户装 [`@nimbo/sdk`](../sdk/README.md) 即可（re-export 本包全部 API，且把八件套自动拼进 session）。单独装本包适合"只要一个文件沙盒、不要 agent loop"的场景——L0 单独使用是合法用法。

## 安装

```sh
pnpm add @nimbo/virtual-fs
```

## 最小用例

```ts
import { fromMemory, fromDirectory } from "@nimbo/virtual-fs";

// 纯内存工作区
const mem = fromMemory({ "src/index.ts": "var x = 1;\n" });
await mem.writeFile("/src/util.ts", "export {};\n");
console.log(await mem.diff());          // [{ path, kind: "created", after, patch }, ...]

// 真实目录零拷贝 overlay 挂载：读穿透磁盘、写落内存层
const fs = fromDirectory("./project");
await fs.writeFile("/README.md", "# hello\n");
console.log(await fs.diff());           // 真三态：created / modified / deleted
await fs.writeBack();                   // 唯一写真实磁盘的操作，只有宿主可达
```

## API 面清单

语义细节见 [docs/02-tech-spec.md §4.4](../../docs/02-tech-spec.md)、文件工具规格见 [docs/04-builtin-tools.md §1](../../docs/04-builtin-tools.md)。

### 三个 NimboFS 实现与工厂

| 导出 | 说明 |
|---|---|
| `MemoryFS` / `fromMemory(files, opts?)` | 纯内存路径树。条目值可为 `string` / `Uint8Array` / reference 初始化对象（`{ ref, mimeType?, annotations? }`）；`opts.resolveReference` 注入后 reference 条目可直读 |
| `OverlayFS` / `fromDirectory(dir, opts?)` | base（只读，通常 `DirFS`）+ overlay（`MemoryFS`，承接全部写入与删除墓碑）；`fromDirectory` 返回真实目录的零拷贝挂载 |
| `DirFS` | 真实目录只读视图（`opts.ignore`: glob 命中路径或祖先目录即隐藏子树）；写方法一律抛 `ReadOnlyFileSystemError` |

三者都实现 `@nimbo/core` 的 `NimboFS` 七方法接口；路径为 POSIX 风格虚拟绝对路径，`..` 越界在 FS 层直接拒绝（`PathEscapesRootError`——安全边界在 FS 不在工具）。`glob()` 只匹配文件、结果按路径排序。

### 导出能力（宿主面，非 NimboFS 接口必需）

| 导出 | 说明 |
|---|---|
| `diff(): Promise<FileDiff[]>` | `{ path, kind: "created"\|"modified"\|"deleted", before?, after?, patch }`；`MemoryFS` 恒以空基线全报 created，真三态在 `OverlayFS`。与 `file_change` item 的 `add/update/delete` 是两个刻意不同的表面 |
| `writeBack(targetDir?)` | 对 diff 结果逐条应用到真实磁盘，幂等；base 非 DirFS 时必须显式传 `targetDir` |
| `snapshot()` / `restore(snapshot)` | JSON 可序列化快照（`MemoryFSSnapshot` / `OverlayFSSnapshot`）；session 的 `toJSON({ includeFs: true })` / `resume` 走它 |
| `computeUnifiedDiff` / `buildFileDiff` | 自实现行级 unified diff（无第三方依赖），纯函数 |

### 元信息与 reference 条目

| 导出 | 说明 |
|---|---|
| `inferMimeType(path)` / `DEFAULT_MIME_TYPE` | 扩展名推断，兜底 `application/octet-stream` |
| `ReferenceInit` / `ReferenceEntryInfo` / `ResolveReference` | reference 条目（URL / CI 产物等外部资源作为文件出现在 FS 里）：`stat()` 返回 `type: "reference"` + `href`；未注入 resolver 时 `readFile` 抛 `ReferenceNotResolvable`（结构化信息，`read_file` 工具据此给模型指引），注入后直读 |
| `FileStat.annotations` | 宿主写给模型看的语义说明（`list_dir` 行尾自然流出，不加查询面） |

### 错误契约

`NotFoundError`（不存在路径的统一错误——第三方 `NimboFS` 作 OverlayFS base 时需遵守）、`DirectoryNotEmptyError`、`ReferenceNotResolvable`、`ReadOnlyFileSystemError`、`PathEscapesRootError`。

### 文件工具八件套

| 导出 | 说明 |
|---|---|
| `createFileTools(opts): Record<FileToolName, Tool>` | `read_file` / `write_file` / `edit_file` / `delete_file` / `move_file` / `list_dir` / `glob` / `grep`（规格见 docs/04 §1.1–§1.8：输出预算与 `[truncated]` 标记、read-before-write 强制、错误即指导）。`opts`: `readState`（`ReadStateStore`，version = mtime）+ `onFileChange(changes)`（`FileChange.kind`: `add/update/delete`）——`@nimbo/sdk` 默认装配自动接线，直接用本包的宿主自己把这两个接缝接到 session（见 `@nimbo/core` 的 `createSessionReadState` / `createDerivedDataCollector`） |

### 路径工具

`normalizePath` / `dirname` / `basename` / `globToRegExp` / `matchesGlob`——实现 `NimboFS` 或写自定义工具时复用。
