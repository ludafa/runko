# 云沙盒工作区适配调研：E2B / Vercel Sandbox / Cloudflare Sandbox

> 状态：**已立项开工**（2026-07-11 用户 review 通过，定案见 §8；§1–§7 为调研原文保留）
> 相关文档：[技术实现文档](./02-tech-spec.md) §4.5a（NimboExec / 模式 A 同源工作区）· [施工计划](./03-construction-plan.md)
> 调研方法：三家 SDK 实际 d.ts（`e2b@2.32.0`、`@vercel/sandbox@2.5.0`、`@cloudflare/sandbox@0.12.3`，本地安装核对）+ 官方文档

## TL;DR

- **E2B 与 Vercel Sandbox 都能以"模式 A 同源工作区"（`NimboFS & NimboExec`，`workspace` 一次注入）接入，现有设计不需要改接口**——两家的 API 面都能覆盖 NimboFS 七方法 + NimboExec 契约，缺口（glob、E2B 非零退出码抛异常、Vercel 非 shell 语义）全部可在适配器层消化。
- **Cloudflare Sandbox 无法从普通 Node 进程调用**（SDK 只能在 Cloudflare Workers 内经 Durable Object binding 使用），且无真正免费层（需 Workers Paid $5/月）——建议 v1 不做，列观察项。
- 建议交付形态：两个独立可选包 `@nimbo/sandbox-e2b`、`@nimbo/sandbox-vercel`（同 `@nimbo/just-bash` 先例：不进 sdk 依赖），主形态是**适配宿主已创建的 sandbox 实例**（BYO instance），nimbo 不管理沙盒生命周期。

## 1. 接入点回顾（nimbo 侧现状）

tech-spec §4.5a 已为这个场景预留了完整的接口位，本次调研就是对照它逐项核验：

- **模式 A 同源工作区**：同一对象实现 `NimboFS & NimboExec`，`createSession(agent, { workspace })` 一次注入。文件数据只有一份（在沙盒里），NimboFS 是它的 API 视图，bash 是另一个访问口，一致性是结构性的。"v2 官方适配器位（Docker/e2b/Vercel Sandbox）即此形态"——spec 原文。
- **NimboFS 契约**：七方法（readFile/writeFile/rm/mkdir/readdir/stat/glob）；`FileStat.mtime` 是 readState 先读后改的判据（模式 A 规则 2）；对不存在路径统一抛 `NotFoundError`（§4.4 实现契约）；`diff()/writeBack()/snapshot()` 非必需（规则 3）。
- **NimboExec 契约**：`exec({command, cwd?, timeoutMs?, signal})` + `onOutput` 流式回调；**全部失败路径 resolve 非零 `ExecResult`，不 reject**（P6-1）；退出码惯例超时 124 / abort 130；`describe()` 环境自描述；沙盒实现 `defaultApproval: "never"`。
- **事件语义**：bash 旁路写不产生 `file_change` item（模式 A 规则 1）——远程沙盒下同样适用，无需改动。

## 2. 三家硬性差异总览

| 维度 | E2B | Vercel Sandbox | Cloudflare Sandbox |
|---|---|---|---|
| **宿主环境** | 任意 Node 进程（API key 即用） | 任意 Node 进程（OIDC token 或 access token） | **仅 Cloudflare Workers 内**（`env.Sandbox` DO binding，无外部 REST API） |
| **认证** | `E2B_API_KEY` 环境变量 | `vercel link` + OIDC（本地/Vercel 上自动）；外部环境 `VERCEL_TOKEN`+teamId+projectId | Workers binding，无独立凭证 |
| **隔离** | Firecracker microVM | Firecracker microVM | Cloudflare Containers（容器） |
| **命令语义** | shell 字符串（`commands.run("ls \| wc")` 直接可用） | **argv 形式** `runCommand(cmd, args)`，shell 脚本需 `bash -lc` 包装 | shell 字符串（默认持久 shell session） |
| **流式输出** | `onStdout`/`onStderr` 回调 ✓ | `stdout`/`stderr` 传 `Writable` ✓ | `stream: true` + `onOutput(stream, data)` ✓ |
| **命令超时/取消** | `timeoutMs`（默认 60s）；`signal` ✓ | 无 timeout 选项，`signal` ✓（超时用 AbortController 自实现） | `timeout` + `signal` ✓ |
| **非零退出码** | **throw `CommandExitError`**（实现了 CommandResult 形状） | resolve，`exitCode` 字段 | resolve，`ExecResult.exitCode` |
| **文件 API** | `files.read/write/list(depth)/remove/rename/makeDir/exists/getInfo` | `sandbox.fs.*`：**`node:fs/promises` 兼容子集**（readFile/writeFile/mkdir/readdir/stat/rm/rename/…） | `readFile/writeFile/mkdir/deleteFile/renameFile/moveFile/listFiles(recursive)` |
| **stat/mtime** | `getInfo` → `EntryInfo.modifiedTime?: Date` ✓ | `fs.stat()` → Node `Stats`（mtimeMs）✓ | **无单独 stat**；`listFiles` 的 `FileInfo.modifiedAt`（ISO 字符串）✓（需列父目录取条目） |
| **glob** | 无原生（`list(depth)` 递归 + 客户端匹配，或 exec `find`） | 无原生（readdir 无 recursive 选项文档面；exec `find`） | 无原生（`listFiles({recursive})` + 客户端匹配） |
| **生命周期** | 默认 5min 超时，`setTimeout()` 延长；Hobby 单会话上限 1h；`pause()`/`Sandbox.connect(id)` 暂停恢复（内存快照） | 默认 5min，`extendTimeout()`；Hobby 单会话 45min / Pro 5h；**persistent by default**（stop 自动快照 FS，`Sandbox.get({name})` 自动恢复）；snapshot/fork API | DO 常驻，`sleepAfter`（默认 10min）idle 睡眠；**磁盘临时**（睡眠丢文件系统，持久化靠 backup 到 R2 / mount bucket） |
| **会话重连键** | `sandboxId` | `name`（项目内唯一） | `getSandbox(ns, id)` 的 id |
| **免费额度** | $100 一次性，免信用卡 | Hobby 每月 5 CPU-hours，持续刷新 | **无免费层**（Workers Paid $5/月 + 容器用量） |

## 3. 逐接口映射（可行性核验）

### 3.1 NimboFS 七方法

| NimboFS | E2B | Vercel | Cloudflare |
|---|---|---|---|
| `readFile → Uint8Array` | `files.read(p, {format:'bytes'})` ✓ | `fs.readFile(p)` → Buffer ✓ | `readFile(p)`（binary 走 base64/stream）✓ |
| `writeFile` | `files.write(p, data)` ✓（支持批量 `WriteEntry[]`） | `fs.writeFile(p, data)` ✓ | `writeFile(p, content)` ✓ |
| `rm({recursive?})` | `files.remove(p)`（**恒递归**，非递归删非空目录需适配器先查再拒） | ~~`fs.rm(p, {recursive})` 原生对齐~~（P10-2 实测证伪：非递归 `fs.rm` 对任意目录抛 `ERR_FS_EISDIR`——适配器按 stat 分流，文件走 `rm`、目录走 `rmdir` 得到"空成功/非空 ENOTEMPTY"语义） | `deleteFile(p)`（目录递归语义待实测） |
| `mkdir` | `files.makeDir(p)` ✓ | `fs.mkdir(p, {recursive})` ✓ | `mkdir(p, {recursive})` ✓ |
| `readdir → DirEntry[]` | `files.list(p, {depth:1})`（EntryInfo 含 type）✓ | `fs.readdir(p, {withFileTypes:true})` ✓ | `listFiles(p)`（FileInfo 含 type）✓ |
| `stat → FileStat` | `files.getInfo(p)`：type/size/`modifiedTime` ✓ | `fs.stat(p)`：Node Stats 全量 ✓ | `listFiles(dirname)` 取条目的 `modifiedAt/size/type`（一次 RTT 列整目录，或 exec `stat -c`） |
| `glob → string[]` | `list(p, {depth:N})` 递归 + 客户端 matcher；或 `commands.run("find …")` | exec `find` + 客户端 matcher | `listFiles(p, {recursive:true})` + 客户端 matcher |

其余契约点：

- **NotFoundError 归一**：三家的"不存在"表达各异（E2B 抛自家 NotFoundError；Vercel `fs.*` 抛 Node 风格 `ENOENT`、顶层 `sandbox.readFile` 返回 `null`；CF 返回 `success:false` 结构）。适配器统一翻译为 `@nimbo/virtual-fs` 的 `NotFoundError`——这正是 §4.4 说的"第三方 NimboFS 作 base 时需自行包一层归一化"，现在轮到我们自己吃这个契约。
- **mimeType/annotations/reference**：远程真实 FS 无处存 annotations，`stat()` 返回基础字段即可（这些字段本就是可选的）；reference 条目不适用于沙盒工作区（不实现，读到即视为普通文件不存在）。
- **`..` 越界**：三家路径都直达真实容器 FS，`/etc/passwd` 等对 agent 可见——**这是沙盒工作区与 VirtualFS 的本质语义差**：安全边界从"FS 层拒绝越界"移到"隔离即边界"（整个 VM 都是可丢弃的）。（P10 施工语义细化：这句话针对的是 **bash**——真实 shell 天然可越出 root；FS 七方法仍经 `normalizePath` 拒绝 `..` 越出锚定 root，与 MemoryFS/DirFS 同一契约，`describe()` 如实声明"FS 锚定 root、bash 不受限"的差异。）

### 3.2 NimboExec

| NimboExec 契约 | E2B | Vercel | Cloudflare |
|---|---|---|---|
| `command`（shell 字符串） | 直传 ✓ | **包装 `runCommand('bash', ['-lc', command])`** | 直传 ✓ |
| `cwd` | `opts.cwd` ✓ | `params.cwd` ✓ | `options.cwd` ✓ |
| `timeoutMs` | `timeoutMs` ✓（默认 60s，注意与 nimbo 默认对齐） | ~~无原生~~（P10-2 勘误：`@vercel/sandbox@2.5.0` 的 `RunCommandParams` 已有原生 `timeoutMs`，沙盒侧到点 SIGKILL；适配器仍以本地 AbortController 为 124 契约的权威来源，`timeoutMs` 透传作远程兜底） | `timeout` ✓ |
| `signal` | `signal`（CommandRequestOpts）✓ | `signal` ✓ | `signal` ✓ |
| `onOutput` 流式 | `onStdout/onStderr` 回调直译 ✓ | 自定义 `Writable` 桥接 ✓ | `stream:true` + `onOutput` 直译 ✓ |
| P6-1 resolve 契约 | **catch `CommandExitError`** → resolve `{exitCode, stdout, stderr}`（错误对象本身带全三字段，无损转换） | 原生 resolve ✓（`CommandFinished.exitCode` + `await stdout()`） | 原生 resolve ✓（`ExecResult` 连 `duration` 都有，直接映 `durationMs`） |
| 超时/abort 退出码 124/130 | 适配器归一（E2B 超时抛 TimeoutError → 124） | 适配器归一（abort 分辨超时/用户取消） | 适配器归一 |
| `describe()` | "Firecracker microVM、有网络（可配）、真实 Linux、非虚拟 FS" | 同左 + "argv 语义经 bash -lc、Amazon Linux 2023、有 sudo" | —（v1 不做） |
| `defaultApproval` | `"never"`（隔离即边界） | `"never"` | `"never"` |

### 3.3 与 nimbo session 生命周期的对齐

nimbo 的 `SessionState` 序列化/恢复要求工作区可重建：

- **E2B**：`SessionState` 之外由宿主保存 `sandboxId`，恢复时 `Sandbox.connect(id)` 再包一层适配器。沙盒超时后（Hobby 最长 1h）id 失效——需要 pause（内存快照）或接受重建。
- **Vercel**：最顺——persistent by default，`Sandbox.get({ name })` 自动从文件系统快照恢复，天然对上 `resume` 语义；宿主只需保存 name。
- **Cloudflare**：DO 睡眠后磁盘丢失，持久化要显式 backup 到 R2——若做，恢复语义最重。

## 4. 值得单独决策的差异点

1. **Cloudflare 的宿主环境限制是硬墙**。`getSandbox(env.Sandbox, id)` 依赖 Workers 的 Durable Object binding，官方没有从外部 Node 进程直连容器的通道。要接入只有两条路：(a) nimbo 本身跑进 workerd；(b) 自建 Worker HTTP 网关，把 NimboFS 七方法 + exec 映射成 endpoints，Node 侧写 thin client——引入一个需要自维护、自鉴权的服务面。路 (b) 超出"写个适配器"的量级；路 (a) 的可行性**已实测确认，见 §7 附录**——nimbo 核心零改动可跑在 workerd 上，Cloudflare 路线的真实剩余成本只是一个适配器包 + 无免费层的钱的问题。
2. **E2B 的非零退出码抛异常**与 P6-1 契约正面冲突，但 `CommandExitError` 自身携带完整 `CommandResult`，适配器 catch 后无损转换——风险低，但必须有针对性测试（这类"异常当返回值"的边界最容易漏）。
3. **Vercel 的 argv 语义**：`runCommand` 不走 shell，管道/重定向/变量展开都需要 `bash -lc` 包装。包装后与 E2B/CF 行为一致，但要注意引号转义（把整段脚本作为单个 argv 传入，不做任何拼接）。
4. **glob 三家都缺**：统一方案是"沙盒内 `find` 命令 + 输出解析"或"递归列目录 + 客户端 matcher"。倾向后者（不依赖沙盒内工具存在性、语义可控），matcher 复用 `@nimbo/virtual-fs` 既有 glob 匹配逻辑（需要评估：该逻辑目前是否可独立导出——若不可，是抽公共小模块还是两包各自复制，见 §5 决策点 3）。
5. **mtime 精度风险（readState 判据）**：CF 的 `modifiedAt` 是 ISO 字符串、E2B 是 `Date`——精度最低可能到秒。同一秒内 bash 写 + agent `edit_file` 理论上可绕过先读后改校验。属既有取舍（spec 允许"或实现提供的 version"），v1 接受并在适配器文档记录；若要加固，适配器可对经 NimboFS 写路径叠加自增 version，bash 旁路仍以 mtime 兜底。
6. **每次文件工具调用 = 一次网络 RTT**（50–300ms 量级，vs VirtualFS 的微秒级）。对 agent 体验的实际影响有限（模型推理延迟仍是大头），但 `glob`/`grep` 这类扫描型操作应引导模型走 bash 工具在沙盒内执行（`describe()` 里写明），而不是文件工具逐个拉取。
7. **免费额度的会话时长上限影响 demo 形态**：E2B Hobby 单会话 1h、Vercel Hobby 45min。长对话 session 需处理"沙盒过期重建"：v1 方案是明确报错（适配器抛带指导的错误），自动重建列 v2。

## 5. 方案（待 review 后才开工）

### 5.1 交付形态

- 新增两个可选包：**`@nimbo/sandbox-e2b`**、**`@nimbo/sandbox-vercel`**。依赖 `@nimbo/core`（类型）+ 各家官方 SDK（运行时）。**不进 `@nimbo/sdk` 依赖**——同 `@nimbo/just-bash` 先例（§4.5b 包关系），各家 SDK 是重量外部依赖，按需安装。
- Cloudflare **v1 不做**，在本文档保留调研结论作观察项；触发重评的条件：官方开放外部访问通道，或 nimbo 决定支持 edge runtime。

### 5.2 API 草案（形状示意，非实现）

```ts
// @nimbo/sandbox-e2b
import { Sandbox } from "e2b";
import { e2bWorkspace } from "@nimbo/sandbox-e2b";

const sandbox = await Sandbox.create({ timeoutMs: 30 * 60_000 });   // 宿主自己建、自己管生命周期
const workspace = e2bWorkspace(sandbox, { root?: "/home/user", limits?: {...} });
createSession(agent, { workspace });                                 // NimboFS & NimboExec 一次注入

// @nimbo/sandbox-vercel 同构：
const workspace = vercelWorkspace(await Sandbox.create({ runtime: "node24" }), { root?: "/vercel/sandbox" });
```

- **BYO 实例为唯一入口**：适配器只接受已创建的 sandbox 实例，不隐式创建、不负责销毁（"nimbo 不关心沙盒长什么样"，§4.5a 原则；也避免适配器吞掉各家丰富的创建参数）。便利工厂（`createE2bWorkspace(opts)` 一步建+包）先不做，等真实使用反馈。
- `root` 选项：把 NimboFS 的虚拟绝对路径锚定到沙盒内某目录（默认各家工作目录），路径转换在适配器内完成；agent 视角仍是 `/` 起头的干净路径。

### 5.3 适配器内部要点（对应 §3/§4 的消化责任）

1. exec：Vercel 走 `bash -lc` 单参传递；E2B catch `CommandExitError`；三家超时/abort 退出码归一 124/130（复用 mini-bash 的 `raceAbort` 模式做取消保底，P9-1 先例）。
2. FS：NotFoundError 归一；E2B 非递归 rm 先 `getInfo` 判目录非空则拒；glob 用递归列目录 + 共享 matcher；stat 的 mtime 统一转 epoch ms。
3. `describe()`：如实声明"真实 Linux 容器/VM、可越出工作目录、有无网络、非虚拟 FS"，并引导扫描型操作走 bash。
4. 沙盒过期：各 SDK 的"沙盒已停止"错误翻译为带指导的 `ExecResult`/FS 错误（提示宿主重建或延长 timeout）。

### 5.4 验证方案思路（开工后细化为正式验证文档）

1. 申请两家免费账号（E2B $100 免卡；Vercel Hobby 项目 + `vercel link`）。
2. 契约测试复用：把 core/virtual-fs 现有 NimboFS、NimboExec 契约测试套在两个适配器上跑（真实沙盒，CI 里打 tag 手动触发，避免烧免费额度）。
3. 端到端：examples 里各加一个"agent 在云沙盒里改文件 + 跑命令"样例，验收模式 A 三规则（bash 旁路无 file_change、mtime readState 拦截、diff 非必需）。

## 6. 请 review 的决策点

1. **范围**：v1 只做 E2B + Vercel、Cloudflare 缓议——是否同意？
2. **两包 vs 一包**：两个独立包（各带自家 SDK 依赖）vs 单包 `@nimbo/sandboxes` 用 peerDeps + 子路径导出。本文推荐前者（依赖树干净、和 just-bash 先例一致）。
3. **共享代码去处**：两适配器的公共逻辑（路径锚定、退出码归一、glob matcher）→ 先在两包内复制（量小），第三个适配器出现时再抽 `@nimbo/sandbox-kit`；还是现在就抽？本文推荐先复制。
4. **BYO 实例**是否够用，要不要便利工厂？
5. 沙盒过期的 v1 行为（报错指导 vs 自动重建）。
6. （§7 实测后新增）Cloudflare 是否升格：nimbo-on-Workers 已验证可行，若接受 $5/月 无免费层，`@nimbo/sandbox-cloudflare`（Worker 内使用）与 E2B/Vercel 是同一量级的适配器工单——纳入 v1 还是保持缓议？

## 7. 附录：nimbo 能否跑在 Cloudflare Workers（workerd）——实测（2026-07-11）

> 背景：§4.1 初稿把"nimbo 跑进 workerd"列为需逐一审计的未知量。本节实测后**修正该预设**：核心路径零改动可跑。

### 7.1 Node API 使用面审计（源码 grep 全量）

| 使用点 | Node API | workerd 现状（compat date ≥ 2026-03-17，`nodejs_compat`） |
|---|---|---|
| `core` session/loop 的 id 生成 | `node:crypto` `randomUUID` | ✓ 原生支持（也可换 Web 标准 `crypto.randomUUID` 进一步减依赖） |
| `virtual-fs` memory/overlay/dir 的 `writeBack`/DirFS 读盘 | `node:fs/promises` + `node:path` | ✓ 可打包可运行（2025-09-01 起 node:fs 原生化为 per-Worker 内存虚拟盘）——但读到的是空虚拟盘，`fromDirectory`/`writeBack` 在 Workers 上**语义上不可用**，纯内存路径（`fromMemory`）不受影响 |
| `core` `localExec` | `node:child_process`/`os`/`fs` | ✓ 可打包（2026-03-17 起自动启用 stub 模块），**调用时抛错**——Workers 上本就该注入沙盒 exec 而非 localExec，符合预期 |
| `core` L3 `loadAgent` / `Skill.fromDirectory` | `node:fs` + 动态 `import()` | 打包不报错，运行不可用（虚拟盘为空；任意路径动态 import 不支持）——L3 本就是可选层，Workers 上用 `defineSkill`/`Skill.fromFS`/程序化定义替代 |
| `mini-bash` | **无任何 node: import** | ✓ 纯 TS |
| 模型层 `ai` | edge 官方支持 | ✓（Workers 是 AI SDK 一等目标） |

注意 `@nimbo/core` 主入口无条件 `export * from "./exec/local.js"`——之所以没炸，靠的是 workerd 的 child_process stub；compat date 更早的用户需手动加 flag。卫生改进（可选，非必需）：把 localExec 移到 `./local` 子路径导出。

### 7.2 实测结果

- `wrangler deploy --dry-run`（wrangler 4.110.0，compat date 2026-06-01 + `nodejs_compat`）：`@nimbo/sdk` 全量打包**一次通过**，1316 KB / gzip 220 KB（含 `ai`）。
- `wrangler dev`（本地 workerd）真实请求：`fromMemory` + `createSession` + `miniBash().exec("cat …")` 全部正常，5ms 返回（未测真实 LLM 调用——`ai` 官方支持 Workers，风险低）。

### 7.3 边界与含义

- **Workers 的 30s/5min 限制是 CPU 时间，不是墙钟时间**——官方原文："There is no hard limit on duration for HTTP-triggered Workers. As long as the client remains connected, the Worker can continue processing… Waiting on network requests (such as fetch()) does **not** count toward CPU time." agent loop 的墙钟大头（等 LLM 流式返回、等沙盒执行命令）全是 I/O 等待，真正吃 CPU 的只有 JSON/zod/事件翻译这类毫秒级工作——几十轮 loop 的 CPU 累计大概率在几百 ms 量级，30s 默认额度非常宽裕。真实约束是：客户端断连后只有 `ctx.waitUntil` 的 30s 尾巴（SSE 流式响应正好契合 `session.stream()` 的形态）；Free 计划 10ms CPU 不可用（反正 Containers 也要 Paid）。长会话/断连续跑放 Durable Objects 或 Workflows（nimbo"无全局状态、session 可序列化"的设计原则在这里正好兑现）。
- 含义：Cloudflare 路线 (a) 的成本从"未知审计量级"降为"一个常规适配器工单"；`@nimbo/sandbox-cloudflare` 形态 = Worker 内 `getSandbox(env.Sandbox, id)` 包成 `NimboFS & NimboExec`（其 exec/文件 API 与 NimboExec 映射三家中最顺，§3.2）。是否纳入 v1 见决策点 6。
- 顺带收获：nimbo "Node ≥ 20 only" 的宣称可以考虑放宽为 "Node ≥ 20 / edge runtimes（核心路径）"——单列决策，不在本次范围。

## 8. 立项定案与详细设计（2026-07-11 用户 review 结论，施工依据）

用户裁定：**三家全做**。目标形态：agent（nimbo）跑在任意 Node 机器上，fs/bash 落在对应提供商的云沙盒里。真机验证延后——examples 留 `.env.template`，用户申请凭证填入 `.env` 后再触发（施工期先以进程内 fake 跑契约测试）。

对 §6 决策点的裁定：① 范围 = 三家（决策点 6 随目标一并定案：Cloudflare 走**网关形态**，因为"agent 跑在任意电脑"排除了 nimbo-on-Workers 形态）；② 三个独立包；③ 公共逻辑——修正调研时"先复制"倾向：`NotFoundError` 在文件工具里走 `instanceof`（类同一性硬约束），glob 工具 `globToRegExp/matchesGlob/normalizePath` 已是 `@nimbo/virtual-fs` 公共导出——三包直接把 `@nimbo/virtual-fs` 收为运行时依赖（zod 之外无重依赖），不复制不另建 kit 包；④ BYO 实例维持（E2B/Vercel；CF client 是配置对象，无实例可 BYO）；⑤ 沙盒过期 v1 = 报错指导。

### 8.1 依赖策略：provider SDK 仅类型依赖（结构化接口）

E2B/Vercel 适配器**不在运行时 import provider SDK**：

- 适配器只 `import type`，并对我们实际触碰的方法面定义**结构化子集接口**（`E2bSandboxLike`/`VercelSandboxLike`，以官方 d.ts 为蓝本手写最小面），工厂函数收该接口而非具体类。
- 错误识别一律**结构判别**不用 `instanceof`（如 E2B `CommandExitError` 按 `exitCode/stdout/stderr` 字段形状识别）——宿主与适配器各自安装的 SDK 副本类不同一，instanceof 天然不可靠。
- 收益：`e2b`/`@vercel/sandbox` 只进 devDependencies（类型对照）；契约测试用进程内 fake 实现同一结构接口即可全覆盖，无需网络 mock；SDK 小版本演进不破适配器。
- `@nimbo/sandbox-cloudflare` 客户端连类型依赖都没有（纯 fetch 协议）；其 `./worker` 子路径把 `@cloudflare/sandbox` 声明为 peerDependency（网关代码运行时真正 import 它，版本跟宿主 wrangler 项目走）。

### 8.2 包设计

三包共同点：依赖 `@nimbo/core`（类型）+ `@nimbo/virtual-fs`（NotFoundError/glob 工具）；工厂返回 `NimboFS & NimboExec`（供 `workspace` 一次注入）；`defaultApproval: "never"`；`describe()` 如实声明"真实 Linux、可越出工作目录、扫描型操作建议走 bash"；`root` 选项做虚拟绝对路径 ↔ 沙盒真实路径的锚定换算；mtime 统一转 epoch ms；超时/中止退出码归一 124/130（沿 mini-bash `raceAbort` 保底先例）；沙盒已停止/过期错误翻译为带指导文案的结果。

**`@nimbo/sandbox-e2b`** — `e2bWorkspace(sandbox: E2bSandboxLike, opts?: { root?: string }): NimboFS & NimboExec`

- FS 映射按 §3.1 表：`files.read({format:'bytes'})/write/list(depth:1)/remove/makeDir/getInfo/exists`；stat 用 `getInfo`（`modifiedTime` → epoch ms）；glob = `files.list` 递归（大 depth）+ `matchesGlob`；非递归 rm 非空目录先查后拒（`DirectoryNotEmptyError`）。
- exec：`commands.run(command, { cwd, timeoutMs, onStdout, onStderr })` 直传；**catch 结构形如 CommandExitError 的抛出并转 resolve**（P6-1 契约）；E2B 超时错误 → 124。

**`@nimbo/sandbox-vercel`** — `vercelWorkspace(sandbox: VercelSandboxLike, opts?: { root?: string }): NimboFS & NimboExec`

- FS 映射按 §3.1 表：`sandbox.fs.*`（node:fs/promises 兼容子集）直译；`ENOENT`（`error.code` 结构判别）→ `NotFoundError`；glob = exec `find`？**否**——用 `fs.readdir` 递归走目录树 + `matchesGlob`（不依赖沙盒内工具，行为与其他两家一致）。
- exec：`runCommand({ cmd: "bash", args: ["-lc", command], cwd, signal, stdout, stderr })`——脚本整体作为单个 argv，零拼接；`stdout/stderr` 传自定义 `Writable` 桥接 `onOutput`；`timeoutMs` 用 AbortController 自实现（退出码 124，与用户 signal 的 130 区分）。

**`@nimbo/sandbox-cloudflare`** — 双入口：

- `.`（客户端，任意 Node）：`cloudflareWorkspace(opts: { url: string; token: string; sandboxId?: string; fetch?: typeof fetch }): NimboFS & NimboExec`——纯 HTTP 协议客户端，`fetch` 可注入（测试与自定义传输）。
- `./worker`（网关，宿主的 wrangler 项目里用）：`createSandboxGateway(opts: { token: string }): { fetch(req: Request, env: { Sandbox: DurableObjectNamespace }): Promise<Response> }`——内部 `getSandbox(env.Sandbox, sandboxId)` 并把协议端点翻译成 `@cloudflare/sandbox` 调用；宿主 worker 只需 re-export `Sandbox` DO 类 + 几行装配（examples 提供可直接 `wrangler deploy` 的模板）。

### 8.3 Cloudflare 网关协议（v1）

全部 `POST` + JSON body；认证 `Authorization: Bearer <token>`（与网关 `token` 常量比对）；沙盒选择 `x-nimbo-sandbox: <id>`（缺省 `"default"`）；二进制经 base64。错误响应 `{ code: "not_found" | "not_dir" | "dir_not_empty" | "sandbox_error", message }` 配相应 HTTP 状态（404/409/500），客户端翻译回 `NotFoundError` 等。

| 端点 | 请求 | 响应 |
|---|---|---|
| `/fs/read` | `{ path }` | `{ dataBase64 }` |
| `/fs/write` | `{ path, dataBase64 }` | `{ ok: true }` |
| `/fs/rm` | `{ path, recursive? }` | `{ ok: true }` |
| `/fs/mkdir` | `{ path }` | `{ ok: true }` |
| `/fs/readdir` | `{ path }` | `{ entries: [{ name, type }] }` |
| `/fs/stat` | `{ path }` | `{ type, size?, mtime? }` |
| `/fs/glob` | `{ pattern }` | `{ paths: [...] }`（网关侧 `listFiles({recursive})` + matcher，省回传） |
| `/exec` | `{ command, cwd?, timeoutMs? }` | **NDJSON 流**：`{ type:"output", stream, data }`×N + 终块 `{ type:"exit", exitCode, stdout, stderr, durationMs }` |

exec 流式：网关 `sandbox.exec(command, { stream: true, onOutput })` 写入 `TransformStream`；客户端增量解析 NDJSON → `onOutput`，终块 → `ExecResult`。取消：客户端 abort fetch（Workers 侧请求取消自然传播）+ 客户端 `raceAbort` 保底 130；`timeoutMs` 由客户端计时（124），网关侧同值透传给 `sandbox.exec({ timeout })` 兜底。

### 8.4 测试与验证分级

1. **离线契约测试（施工期，必须绿）**：每包一套进程内 fake（实现 §8.1 结构接口 / CF 用 fake fetch 直连内存网关 handler + fake `@cloudflare/sandbox` 表面），覆盖 FS 七方法契约（NotFoundError/递归 rm/glob/mtime）、exec 契约（P6-1 resolve、124/130、onOutput）、路径锚定、与 core 文件工具/bash 工具的 e2e（mock model）。CF 客户端+网关**在进程内对接测试**（协议两端一次覆盖）。
2. **真机冒烟（待用户凭证）**：`examples/.env.template` 占位；`.env` 填好后跑 examples 09/10/11 + 一键冒烟脚本；结果回填 docs/05。
