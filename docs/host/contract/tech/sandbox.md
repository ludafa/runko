---
title: "沙盒工作区（Sandbox Workspace）— 技术方案"
slug: sandbox
view: 技术
layer: 宿主层
module: 沙盒
packages: ["@nimbo/sandbox-e2b", "@nimbo/sandbox-vercel", "@nimbo/sandbox-cloudflare", "@nimbo/virtual-fs"]
tags: ["沙盒", "工作区", "NimboFS", "NimboExec", "适配器"]
related: ["host/contract/features/sandbox.md", "host/contract/plans/sandbox.md", "architecture/tech/agent-kernel.md"]
---
# 沙盒工作区（Sandbox Workspace）— 技术方案

> 相关：[产品与使用手册](../features/sandbox.md) · [施工进展](../plans/sandbox.md) · 依赖 [core-sdk 技术方案](../../../logic/engine/tech/core-sdk.md)（`NimboFS` / `NimboExec` / 审批链接口原文、三模式的原始定义）· [原生搜索](../../../terms.md)拆单见 [plans/native-search](../../../logic/engine/plans/native-search.md)（本页 §3/§4/§5.1 为其契约与映射来源）
>
> 本页讲技术方案：整体设计、适配器必须遵守的契约、关键接口与数据结构、三家逐接口映射与实测取舍、Cloudflare 网关协议、已知限制。规范性用词「必须 / 不得 / 应当 / 可以」：必须与不得是硬性要求；应当允许有充分理由的偏离，但须声明；可以为完全可选。

## 1. 方案总览：模式 A 同源工作区

沙盒适配器把某家厂商的沙盒 SDK 包成一个**同时实现 `NimboFS & NimboExec`** 的对象（[工作区](../../../terms.md)），经 `createSession(agent, { workspace })` 一次注入。核心设计点：

- **文件真身只有一份，在沙盒里**。`NimboFS` 是它的 API 视图（`readFile` → 调沙盒文件 API），bash 是另一个访问入口（`exec` → 在沙盒里跑命令）。**一致性是结构性的**——没有两份数据，就没有同步逻辑、没有竞态。这是模式 A 区别于模式 B（内存 FS + 物化落盘，一致性由 nimbo 维护）和模式 C（各管各的，一致性由宿主保证）的根本。
- **适配器只包视图，不管生命周期**（[BYO 实例](../../../terms.md)）。工厂函数收一个已创建的沙盒实例（或连接配置），返回工作区对象；创建 / 销毁 / 续期归宿主。
- **不在运行时 import 厂商 SDK**。工厂函数收一个手写的最小结构接口（如 `VercelSandboxLike`），厂商 SDK 只作 devDependency 做类型对照。宿主与适配器各装各的 SDK 版本互不干扰，测试也不需要真实网络。运行时依赖收敛为 `@nimbo/core`（类型）+ `@nimbo/virtual-fs`（`NotFoundError` / glob 工具 / 路径校验）。

以 `vercelWorkspace` 为例，工厂就是把两个接口的实现 spread 到一个对象里：

```ts
export function vercelWorkspace(sandbox: VercelSandboxLike, opts: VercelWorkspaceOptions = {}): NimboFS & NimboExec {
  const root = opts.root ?? DEFAULT_ROOT;  // "/vercel/sandbox"
  return {
    ...createVercelFs(sandbox, root),      // NimboFS 七方法
    ...createVercelExec(sandbox, root),    // NimboExec
  };
}
```

## 2. 工具调用如何经适配器到达真实沙盒（模式 A）

下面这张时序图给出「[agent](../../../terms.md) 的 bash / 文件工具 → `NimboExec` / `NimboFS` 接口 → 沙盒适配器 → 真实沙盒」的完整调用链，以 Vercel 适配器为例（步骤对齐 `packages/sandbox-vercel/src/{exec,fs,path}.ts` 与 `packages/core/src/tools/builtin/bash.ts`、`packages/virtual-fs/src/tools/edit-file.ts` 的实际实现）。注意「工作区接口」与「适配器实现」是**同一个对象**——`vercelWorkspace` 把两者 spread 在一起，图中分层只为体现「接口契约 → 具体实现」的责任划分。

```mermaid
sequenceDiagram
    participant M as 模型 (loop)
    participant BT as bash 工具<br/>createBashTool
    participant FT as 文件工具<br/>edit-file / read-file
    participant WS as 工作区接口<br/>NimboExec / NimboFS
    participant AD as 适配器实现<br/>createVercelExec / Fs
    participant SB as 真实沙盒<br/>Vercel Sandbox

    Note over M,SB: 模式 A · 同源工作区（文件真身只有一份，在沙盒里）

    rect rgb(230, 240, 255)
    Note over M,SB: bash 工具路径
    M->>BT: tool_call bash { command, cwd?, timeout_ms? }
    BT->>WS: exec({ command, cwd, timeoutMs, signal }, { onOutput })
    WS->>AD: exec(req, opts)
    AD->>AD: resolveCwd(root, cwd) 虚拟→真实路径<br/>起 AbortController 计时（124/130 本地兜底）
    AD->>SB: runCommand({ cmd:"bash", args:["-lc", command], cwd, signal, stdout, stderr })
    SB-->>AD: stdout/stderr 增量 → Writable
    AD-->>BT: onOutput(chunk) → ctx.update()（item.updated 流式）
    SB-->>AD: CommandFinished { exitCode }
    AD-->>WS: ExecResult { exitCode, stdout, stderr, durationMs }
    WS-->>BT: ExecResult（非零退出码也是正常 resolve）
    BT-->>M: 格式化输出交回模型自行纠错
    end

    rect rgb(235, 255, 235)
    Note over M,SB: 文件工具路径（同一份数据的另一个访问口）
    M->>FT: tool_call edit_file { path, old, new }
    FT->>WS: fs.stat(path)（先读后改 mtime 判据）
    WS->>AD: stat(path)
    AD->>SB: fs.stat(toRealPath(root, path))
    SB-->>AD: Stats { mtimeMs, size, isDirectory() }
    AD-->>FT: FileStat { type, mtime, mimeType }
    FT->>WS: fs.readFile / fs.writeFile
    WS->>AD: readFile / (ensureParentDir + writeFile)
    AD->>SB: fs.readFile / fs.mkdir + fs.writeFile
    SB-->>AD: bytes / ok
    AD-->>FT: Uint8Array / void
    FT-->>M: file_change item（仅文件工具产生；bash 旁路写不产生）
    end
```

关键点：bash 工具经 `opts.exec.exec(...)` 进入适配器，`command` 作为**单个 argv** 塞进 `bash -lc` 的第二个参数（零字符串拼接）；文件工具经 `ctx.fs.*` 进入适配器，所有虚拟路径先过 `toRealPath(root, …)` 锚定换算。两条路径最终落在**同一个沙盒实例**上，所以 bash 写的文件 read_file 立刻可见，反之亦然。

## 3. 关键接口与数据结构

接口原文定义在 `@nimbo/core`（`packages/core/src/types.ts`，[core-sdk](../../../logic/engine/tech/core-sdk.md) §4.4/§4.5a），适配器在其上实现。

```ts
// ---- NimboFS：七个必须方法 + 两个可选原生搜索方法 ----
interface NimboFS {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  rm(path: string, opts?: { recursive?: boolean }): Promise<void>;
  mkdir(path: string): Promise<void>;
  readdir(path: string): Promise<DirEntry[]>;
  stat(path: string): Promise<FileStat>;
  glob(pattern: string): Promise<string[]>;
  searchFiles?(query: FileSearchQuery): Promise<FileSearchResult>;         // 可选：见下方「原生搜索接缝」
  searchContent?(query: ContentSearchQuery): Promise<ContentSearchResult>;
}
interface FileStat { type: "file" | "dir" | "reference"; size?: number; mtime?: number; mimeType?: string; href?: string; annotations?: {...}; }
interface DirEntry extends FileStat { name: string; }

// ---- 原生搜索查询/结果类型（原文定义见 core-sdk 技术方案 §4.4） ----
interface FileSearchQuery { pattern: string; ignore?: string[]; limit: number; }
interface FileSearchResult { paths: string[]; total: number; }
interface ContentSearchQuery {
  pattern: string; ignoreCase?: boolean; scope: string; ignore?: string[];
  mode: "files" | "content"; context?: number; maxFiles: number; maxLines: number;
}
interface ContentSearchLine { line: number; text: string; match: boolean; }
interface ContentSearchGroup { path: string; lines: ContentSearchLine[]; }
interface ContentSearchResult { groups: ContentSearchGroup[]; totalFiles: number; lineCapped: boolean; }

// ---- NimboExec：命令执行 ----
interface NimboExec {
  exec(req: ExecRequest, opts?: ExecOptions): Promise<ExecResult>;
  describe?(): string;                 // 环境自描述，拼进 bash 工具描述
  defaultApproval?: ApprovalPolicy;    // 实现自声明的审批默认值
}
interface ExecRequest { command: string; cwd?: string; timeoutMs?: number; signal: AbortSignal; }
interface ExecOptions { onOutput?: (chunk: { stream: "stdout" | "stderr"; data: string }) => void; }
interface ExecResult { exitCode: number; stdout: string; stderr: string; durationMs: number; }
```

**原生搜索接缝**（可选，[术语](../../../terms.md)）：`searchFiles`/`searchContent` 不在七个必须方法之列——实现了 = 该底座能一次调用在自己内部完成整个搜索（典型如远端沙盒在沙盒里跑一条脚本，省掉逐文件网络往返）；抛 `SearchUnsupportedError`（`@nimbo/core` 导出）或未实现该方法，[内置 `grep`/`glob`](../../../logic/engine/tech/builtin-tools.md) §3.7/§3.8 都会静默回退现有逐文件扫描，行为不受影响。三家云沙盒目前只有 Vercel 适配器实现（§5.1 `glob` 行，§9 已知限制）；`MemoryFS`/`OverlayFS`/`DirFS` 故意不实现——`OverlayFS` 罩着远端 base 时，base 的 native 搜索看不见 overlay 层的脏写，回退到走 `glob()`（会经过 overlay 合并视图）才是正确语义。拆单见 [plans/native-search](../../../logic/engine/plans/native-search.md)。

### 审批默认值：三值 `ApprovalPolicy`（历史 `never` → `allow`）

> **注意与旧沙盒规范的差异**：早期沙盒规范（原 docs/host/contract/tech/sandbox.md 调研与 nimbo-sandbox-spec，现并入本页与 [plans/sandbox](../plans/sandbox.md)）里沙盒的 `defaultApproval` 是字符串 `"never"`。审批 API 在 P13-5-2c（见 [single-ledger](../../../logic/orchestration/features/single-ledger.md)）重构为三值语义后，代码已改为 `"allow"`——本页以当前代码为准。

```ts
type ApprovalOutcome = "allow" | "review" | "deny";
type ApprovalPolicy =
  | "allow" | "review" | "review-once" | "deny"
  | ((input: JsonValue, ctx: ApprovalContext) => Promise<ApprovalOutcome> | ApprovalOutcome);
```

旧字符串到新语义的映射：`"never"` → `"allow"`（直接执行，不弹卡片）、`"always"` → `"review"`（每次弹卡片人工审批）、`"once"` → `"review-once"`（第一次问、批准后本会话记住）。沙盒实现声明 `defaultApproval: "allow"`——隔离即边界。bash 工具装配时取 `opts.exec.defaultApproval ?? "review"`（第三方 exec 未声明时保守取 `review`，见 `bash.ts` 的 `CONSERVATIVE_DEFAULT_APPROVAL`）；宿主可用会话级[审批分类器](../../../terms.md)覆盖。

## 4. 适配器必须遵守的契约

### 4.1 文件面（NimboFS 七方法）

| 方法 | 要求 |
|---|---|
| `readFile` | 返回 `Uint8Array`，二进制必须无损（含 `0x00` 字节）。 |
| `writeFile` | **必须自动创建中间目录**（底层没有这语义的，适配器先补一次 mkdir）。 |
| `rm` | 非递归删非空目录**必须**失败（抛 `DirectoryNotEmptyError`）；底层只有递归删的，先查再拒。 |
| `mkdir` | 等价 `mkdir -p`；路径上已有同名文件则报错。 |
| `readdir` | 每条至少有 `name` 和 `type`，应当按名称排序；size/mtime **可省**（省得每个条目多打一次网络请求）。 |
| `stat` | `type` 只有 `"file"` 和 `"dir"`（symlink 等一律归 `"file"`）；`mtime` **必须**换算成 epoch 毫秒。 |
| `glob` | 只匹配文件、不匹配目录，结果按路径排序；匹配逻辑用 `@nimbo/virtual-fs` 导出的工具函数（`matchesGlob`），**不得**依赖沙盒里装了 `find`。 |

**错误归一**：所有「路径不存在」，不管底层怎么表达（自家异常、`ENOENT`、`success: false`……），**必须**统一翻译成 `@nimbo/virtual-fs` 的 `NotFoundError` 抛出。nimbo 的文件工具靠 `instanceof` 识别它，所以适配器**必须**把 `@nimbo/virtual-fs` 作为运行时依赖，不能自己复制一个同名类。

### 4.2 命令面（NimboExec）

1. **只 resolve，不 reject**：命令非零退出、超时、被取消、网络断了、沙盒已停——所有失败**必须**以带非零 `exitCode` 和 stderr 说明的结果正常返回。bash 工具会把非零退出码当普通结果回给模型，模型自己纠错；reject 只留给「适配器自身彻底坏了」的场景。底层 SDK 遇非零退出就抛异常的（E2B 如此），适配器 catch 转成结果。
2. **退出码约定**：超时 **124**、取消 **130**（POSIX 惯例），其余失败用 1 或底层真实退出码。
3. **超时和取消必须本地兜底**：适配器自己起计时器 / 监听 signal，触发后**立刻**返回 124/130，不等远端——网络分区时远端 Promise 可能永远不落定。允许「本地先返回、远端命令自然跑完」的放弃等待语义，但要在文档说明。
4. **shell 语义**：`command` 是一段 shell 字符串。底层只收 argv 的，包成 `bash -lc <整段脚本>`——脚本作为单个参数传入，不做任何字符串拼接。
5. **cwd**：调用方传的是虚拟绝对路径，适配器换算成沙盒真实路径；不传时默认工作区根。
6. **onOutput**：有流式就增量回调；没有就结束时一次性回调，并在 `describe()` 里声明「输出非流式」。

### 4.3 路径与安全边界

- 适配器应当提供 `root` 选项，把虚拟路径 `/` 锚定到沙盒内某目录（E2B 默认 `/home/user`，Vercel 默认 `/vercel/sandbox`）。agent 看到的永远是 `/` 开头的干净路径。
- 文件面七方法**必须**拒绝 `..` 越出锚定根（和内存 FS 同一套路径校验，经 `normalizePath` 抛 `PathEscapesRootError`）。
- **bash 不受这个限制**：真实 shell 天然可以 `cd /` 走出工作区。这不是漏洞——沙盒场景下**安全边界是隔离本身**（整个 VM/容器都是可丢弃的），不是路径校验。这个差异**必须**写进 `describe()`。
- 由此派生的坑：bash 脚本里写 `/foo` 指向容器真实根目录，不是工作区根。bash 与文件工具共享文件时**用相对路径**——此提示也要进 `describe()`。

### 4.4 describe() 与审批

- 沙盒实现的 `defaultApproval` **必须**是 `"allow"`（隔离即边界，bash 免审批；注入时宿主可覆盖）。对照本机 `localExec` 出厂 `"review"`——没有隔离就必须有审批。
- `describe()` 的返回会拼进 bash 工具描述，是模型认识这个环境的唯一渠道，**必须**如实写清：① 环境是什么（microVM / 容器，真实 Linux，非虚拟 FS）；② 文件工具锚定在工作区、bash 能走出去（§4.3）；③ 有没有网络；④ 每次文件工具调用是一次网络往返，扫描类操作**建议一条 bash 命令解决**（内置 `grep`/`glob` 工具在适配器实现了[原生搜索](../../../terms.md)接缝——`searchFiles`/`searchContent`——时会自动走这条路径一次调用完成整个扫描，模型无需改变用法习惯，见 §3 「原生搜索接缝」）；⑤ 本实现特有的取舍（输出非流式、mtime 秒级精度之类）。

### 4.5 一致性与事件（模式 A 的三条规则）

1. **bash 改文件不产生 `file_change` 事件**——nimbo 只从自己的文件工具派生事件。宿主要完整变更清单，在沙盒里跑 `git status` / `git diff`。
2. **「先读后改」校验以 `stat().mtime` 为判据**——bash 改过的文件，agent 必须重新 read_file 后才能 edit_file。适配器只需把 mtime 换算准确。
3. **`diff()` / `writeBack()` / `snapshot()` 不是必需接口**——那是内存 FS 的附加能力，文件工具不依赖，沙盒实现可以不提供（要基线管理，用沙盒里的 git）。

### 4.6 生命周期与会话恢复

- **沙盒过期 / 已停止**：适配器**必须**返回带指导文案的错误（exec 面是非零结果，文件面是异常），告诉宿主「沙盒已停，请重建或续期」；**不得**擅自重建——重建是宿主策略（自动重建参考实现见 chat webapp 功能）。
- **会话恢复**：nimbo 的会话状态（`session.toJSON()`，消息史）和沙盒文件态**分开保存、分开恢复**。宿主记下重连键（E2B `sandboxId`、Vercel `name`），恢复时先重建 workspace，再 `createSession({ resume, workspace })`。

### 4.7 工程要求

- 不在运行时 import 厂商 SDK；工厂函数收手写最小结构接口，官方 SDK 只作 devDependency 类型对照。
- 识别厂商错误用**字段结构判断**，不用 `instanceof`——两份 SDK 副本的类不是同一个类。
- 运行时依赖收敛为 `@nimbo/core`（类型）+ `@nimbo/virtual-fs`（错误类、glob 工具、路径校验）。
- 适配器是独立可选包，**不进 `@nimbo/sdk` 的依赖**，宿主按需安装。

## 5. 三家逐接口映射与实测取舍

> 本节是**横向对照**——同一个方法在三家分别怎么实现，一眼看清差异。**某一家自己的落地细节与坑**（休眠唤醒、保活、模板、网关协议）在各自的环境文档里：[E2B](../../e2b/tech/deployment.md) · [Vercel](../../vercel/tech/deployment.md) · [Cloudflare](../../cloudflare/tech/deployment.md)。

### 5.1 NimboFS 七方法映射

| NimboFS | E2B | Vercel | Cloudflare |
|---|---|---|---|
| `readFile → Uint8Array` | `files.read(p, {format:'bytes'})` | `fs.readFile(p)` → Buffer | `readFile(p)`（base64 transport） |
| `writeFile` | `files.write(p, data)`（**Uint8Array 需转 ArrayBuffer**，见下） | `fs.writeFile(p, data)`（先 `ensureParentDir`） | `writeFile(p, content)` |
| `rm({recursive?})` | `files.remove`（恒递归，非递归删非空先查后拒） | **按 stat 分流**：文件走 `fs.rm`、目录走 `fs.rmdir`（见下）；递归走 `fs.rm(p,{recursive,force})` | `deleteFile` |
| `mkdir` | `files.makeDir(p)` | `fs.mkdir(p, {recursive:true})` | `mkdir(p, {recursive})` |
| `readdir → DirEntry[]` | `files.list(p, {depth:1})` | `fs.readdir(p, {withFileTypes:true})`（不逐条 stat，见下） | `listFiles(p)` |
| `stat → FileStat` | `files.getInfo(p)`（`modifiedTime` → epoch ms） | `fs.stat(p)`（`mtimeMs` → `Math.round`） | 列父目录取条目 `modifiedAt` |
| `glob → string[]` | `list(depth:N)` 递归 + `matchesGlob` | 一次 `node -e` 脚本往返（regex source 随 payload 预编译传入，脚本内 `readdirSync` 递归匹配，见[原生搜索](../../../terms.md)接缝）；`node` 不可用时回退旧 `fs.readdir` 递归 `walkFiles` + `matchesGlob` | `listFiles({recursive})` + `matchesGlob` |

### 5.2 NimboExec 映射

| 契约点 | E2B | Vercel | Cloudflare |
|---|---|---|---|
| `command` | shell 字符串直传 | `runCommand({cmd:"bash", args:["-lc", command]})` | 直传 |
| P6-1 resolve | **catch 结构形如 `CommandExitError`**（带 exitCode/stdout/stderr）转 resolve | 原生 resolve（`CommandFinished.exitCode`） | 原生 resolve（`ExecResult`） |
| 超时/取消 | 归一 124/130；取消是「放弃等待」（signal 不传远程，`raceAbort` 独立保证） | `AbortController` + `raceAbort` 权威（124/130）；原生 `timeoutMs` 透传作远端兜底 | 客户端计时 124 + abort fetch 传播 130 |
| onOutput | `onStdout`/`onStderr` 回调直译 | 自定义 `Writable` 桥接（同一份增量数据既写 Writable 累计全文、也回调 onOutput） | NDJSON 增量解析 |

### 5.3 各家实测勘误与关键裁量（对源调研的修正）

施工期真机对照把源调研（docs/06）的几处预设推翻，代码注释里如实记录：

- **Vercel `fs.rm` 无法承担「非递归删非空目录拒绝」语义**（推翻 docs/host/contract/tech/sandbox.md §8.2「原生对齐」）：实测 `node:fs/promises` 的 `fs.rm(path)`（`recursive` 缺省）对**任何**目录抛 `ERR_FS_EISDIR`，不区分空/非空。真正带「空则成功、非空则 `ENOTEMPTY`」语义的是 `fs.rmdir()`。因此非递归删除按目标类型分流（文件 `fs.rm`、目录 `fs.rmdir`），代价是多一次 `stat`。
- **Vercel `@vercel/sandbox@2.5.0` 已有原生 `timeoutMs`**（勘误 docs/host/contract/tech/sandbox.md §2「无 timeout 选项」）：但适配器仍以本地 `AbortController` 竞速为 124/130 契约的**唯一权威**（不信任底层 SDK 自报退出码/计时，同 mini-bash `raceAbort` 先例），原生 `timeoutMs` 只作「我们提前 resolve 后、沙盒侧仍会 SIGKILL 杀掉后台残留进程」的兜底。
- **Vercel Writable 单路收集**：SDK 内部把同一份增量数据既写进注入的 `stdout`/`stderr` Writable、又攒进 `CommandFinished` 的缓存供 `.stdout()`/`.stderr()`。二者等价，适配器选 Writable 单路累计全文——`VercelCommandResultLike` 只需 `exitCode`，结构面更小、耦合更低。
- **Vercel readdir 不逐条 stat**：`DirFS`（本地磁盘）readdir 会给每个条目额外 stat 拿 size/mtime；远程沙盒上那是 N 次网络往返。审计消费方后确认 readdir 结果的 size/mtime 无人读取（`FileStat.mtime` 唯一消费点是单独 `stat()` 调用的 readState 判据），只有 `mimeType`（按扩展名推断的纯函数，零 RTT）有用——因此 readdir 条目只填 name/type/mimeType。
- **E2B `write()` 不接受裸 `Uint8Array`**（仅 string/ArrayBuffer/Blob/Stream）：适配器做 `Uint8Array → ArrayBuffer` 拷贝转换（类型对照测试逼出的真坑）。E2B 取消同为「放弃等待」——signal 不传远程 `commands.run()`，`raceAbort` 独立保证 124/130，远程命令可能跑到自然结束。

## 6. Cloudflare 网关形态与协议

Cloudflare Sandbox 的 SDK **只能跑在 Cloudflare Workers 里**（`getSandbox(env.Sandbox, id)` 依赖 Durable Object binding，无外部 REST 通道），普通 Node 进程连不上。接法是**你自部署一个 HTTP 网关**：网关跑在能碰到沙盒的 Worker 里，把七个文件方法和 exec 映射成 HTTP 端点；nimbo 这边用纯 fetch 客户端连它。`@nimbo/sandbox-cloudflare` 因此是双入口——`.`（客户端，任意 Node）+ `./worker`（网关，宿主 wrangler 项目里用，其 `@cloudflare/sandbox` 声明为 peerDependency）。

协议要点：全部 POST + JSON body；`Authorization: Bearer <token>` 认证（与网关 `token` 比对）；沙盒选择请求头 `x-nimbo-sandbox: <id>`（缺省 `"default"`）；二进制经 base64；错误统一 `{ code, message }` 配相应 HTTP 状态（404/409/500/401/400），客户端翻译回 `NotFoundError` 等。

| 端点 | 请求 | 响应 |
|---|---|---|
| `/fs/read` | `{ path }` | `{ dataBase64 }` |
| `/fs/write` | `{ path, dataBase64 }` | `{ ok: true }` |
| `/fs/rm` | `{ path, recursive? }` | `{ ok: true }` |
| `/fs/mkdir` | `{ path }` | `{ ok: true }` |
| `/fs/readdir` | `{ path }` | `{ entries: [{ name, type }] }` |
| `/fs/stat` | `{ path }` | `{ type, size?, mtime? }` |
| `/fs/glob` | `{ pattern }` | `{ paths: [...] }`（网关侧 `listFiles({recursive})` + matcher） |
| `/exec` | `{ command, cwd?, timeoutMs? }` | **NDJSON 流**：`{ type:"output", stream, data }`×N + 终块 `{ type:"exit", exitCode, stdout, stderr, durationMs }` |

exec 流式：网关 `sandbox.exec(command, { stream: true, onOutput })` 写入 `TransformStream`；客户端增量解析 NDJSON → `onOutput`，终块 → `ExecResult`。取消：客户端 abort fetch（Workers 侧请求取消自然传播）+ 客户端 `raceAbort` 保底 130；`timeoutMs` 由客户端计时（124），网关侧同值透传给 `sandbox.exec({ timeout })` 兜底。二进制走 `readFile/writeFile` 的 `encoding:'base64'`（HTTP/WS transport 可用；`encoding:'none'` 裸流仅 RPC transport，弃用）。

以后接入其它「连不上」的沙盒，应当直接复用这份协议和现成客户端（`@nimbo/sandbox-cloudflare` 的主入口），只需重写网关那一侧。

**已知副作用**（施工裁量）：CF 客户端不引入 `root` 配置——路径锚定=虚拟绝对路径去前导斜杠、沙盒默认 cwd（`/workspace`）充当虚拟根；bash 脚本里带前导 `/` 的绝对路径落真实根而非工作区（describe() 与 e2e 已声明「共享文件用相对路径」）。这个「bash 绝对路径 vs FS 锚定路径不同源」现象在 E2B（`/home/user`）/Vercel（`/vercel/sandbox`）同样存在，是「真实 FS + root 锚定」的固有语义。

## 7. 附录：nimbo 能否跑在 Cloudflare Workers（workerd）——实测结论

> 背景：立项定案选了 Cloudflare **网关形态**（因为目标是「agent 跑在任意电脑」，排除了 nimbo-on-Workers 形态）。但施工前的可行性实测证明「nimbo 核心零改动可跑在 workerd 上」这条路也成立，结论保留作技术储备。

- **Node API 使用面审计**（compat date ≥ 2026-03-17，`nodejs_compat`）：`core` 的 `randomUUID`（`node:crypto`）✓ 原生支持；`virtual-fs` 的 `node:fs/promises` ✓ 可打包可运行，但读到的是空虚拟盘，`fromDirectory`/`writeBack` 语义上不可用，纯内存路径（`fromMemory`）不受影响；`localExec`（`node:child_process`）✓ 可打包、调用时抛错（Workers 上本就该注入沙盒 exec）；L3 `loadAgent`/`Skill.fromDirectory` 打包不报错、运行不可用（虚拟盘为空），用 `defineSkill`/`Skill.fromFS`/程序化定义替代；`mini-bash` 无任何 node: import ✓ 纯 TS；模型层 `ai` ✓ Workers 一等目标。
- **实测**：`wrangler deploy --dry-run` 全量打包一次通过（1316 KB / gzip 220 KB 含 `ai`）；`wrangler dev` 真实请求 `fromMemory` + `createSession` + `miniBash().exec` 全部正常，5ms 返回。
- **边界与含义**：Workers 的 30s/5min 限制是 **CPU 时间不是墙钟**——agent loop 的墙钟大头（等 LLM 流式返回、等沙盒执行命令）全是 I/O 等待，不计 CPU；真正吃 CPU 的只有 JSON/zod/事件翻译这类毫秒级工作，几十轮 loop 的 CPU 累计大概率几百 ms，30s 默认额度宽裕。长会话/断连续跑放 Durable Objects 或 Workflows（nimbo「无全局状态、session 可序列化」的设计原则在此兑现）。

## 8. 自己写一个适配器：检查清单

接入官方三家之外的沙盒时，逐条对照：

1. [ ] 工厂签名 `xxxWorkspace(实例或连接配置, opts?) => NimboFS & NimboExec`；只包视图，不创建不销毁沙盒。
2. [ ] 不在运行时 import 厂商 SDK；错误按字段结构识别（§4.7）。
3. [ ] 七个文件方法逐条对照 §4.1，重点：`NotFoundError` 归一、writeFile 自动建父目录、非递归 rm 拒删非空目录、glob 只报文件、mtime 换算成毫秒。
4. [ ] 路径锚定 + 文件面拒绝 `..` 越界；bash 能越出工作区的事实写进 `describe()`（§4.3）。
5. [ ] exec 只 resolve 不 reject；超时 124 / 取消 130 且本地兜底及时返回（§4.2）。
6. [ ] `defaultApproval: "allow"`；`describe()` 覆盖 §4.4 的五项内容。
7. [ ] 沙盒过期报带指导的错误，不自动重建（§4.6）。

## 9. 取舍与已知限制（技术侧）

- **不支持 symlink**：一律按普通文件报告（`stat().type` 归 `"file"`）。
- **不支持 reference 条目**：真实文件系统没地方存这些元数据。
- **每次文件工具调用一次网络往返**（50–300ms 量级）：不追求本地速度，缓解靠引导模型走 bash 批量操作（写进 `describe()`）。`grep`/`glob` 经[原生搜索](../../../terms.md)接缝把整个扫描收敛成一次调用，不受此限制——目前只有 Vercel 适配器实现（§5.1），其余仍是逐文件网络往返。
- **mtime 精度风险**：CF `modifiedAt` 是 ISO 字符串、E2B 是 `Date`，精度最低到秒——同一秒内 bash 写 + agent edit 理论上可绕过先读后改校验。v1 接受；若要加固，适配器可对经 NimboFS 写路径叠加自增 version，bash 旁路仍以 mtime 兜底。
- **会话时长上限影响 demo 形态**：E2B Hobby 单会话 1h、Vercel Hobby 45min。长对话需处理「沙盒过期重建」：v1 方案是明确报错（带指导的 `ExecResult`/FS 错误），自动重建列 v2。
