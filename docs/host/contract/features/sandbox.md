---
title: "沙盒工作区（Sandbox Workspace）— 产品与使用手册"
slug: sandbox
view: 功能
layer: 宿主层
module: 沙盒
packages: ["@runko/sandbox-e2b", "@runko/sandbox-vercel", "@runko/sandbox-cloudflare", "@runko/virtual-fs"]
tags: ["沙盒", "工作区", "RunkoFS", "RunkoExec", "适配器"]
related: ["host/contract/plans/sandbox.md", "host/contract/tech/sandbox.md", "architecture/tech/agent-kernel.md"]
---
# 沙盒工作区（Sandbox Workspace）— 产品与使用手册

> 相关：[技术方案](../tech/sandbox.md) · [施工进展](../plans/sandbox.md) · 依赖 [core-sdk 功能](../../../logic/engine/features/core-sdk.md)（本功能是 core 的 `RunkoFS`/`RunkoExec` 接口的一组官方适配器实现）
>
> 本页是给用户 / 宿主应用开发者看的使用手册：这个功能解决什么问题、怎么用、有哪些对外可见行为、范围与非目标、成功标准。技术契约与内部实现见[技术方案](../tech/sandbox.md)。

## 这个功能解决什么问题

让 [agent](../../../terms.md) 在一个**隔离的云端虚拟机 / 容器**里读写文件、执行命令，而不是在你的本机上。典型场景：agent 去改一个真实 Git 仓库、跑构建、开 PR——你既想让它有真实 Linux 环境的全部能力（真实 shell、真实工具链、可 `sudo`），又不想让它碰你的本机，也不想自己写一堆胶水代码把某家[沙盒](../../../terms.md)厂商的 SDK 接到 agent 上。

对 runko 而言，**[沙盒](../../../terms.md)就是一个同时实现了 `RunkoFS`（文件接口）和 `RunkoExec`（命令执行接口）的对象**——我们把它叫[工作区](../../../terms.md)——通过 `createSession(agent, { workspace })` 一次性注入。注入之后：

- agent 的文件工具（read_file / write_file / edit_file …）读写的是沙盒里的文件；
- agent 的 bash 工具在沙盒里执行命令；
- 两者操作的是**同一份文件**——文件真身只有一份，在沙盒里。

runko 本身**不创建、不销毁、不管理沙盒**（[BYO 实例](../../../terms.md)原则）：沙盒由你（宿主应用）自己创建，API key、计费、超时、回收都归你；适配器只负责把厂商 SDK 翻译成上面两个接口。

runko 官方提供三个开箱即用的适配器包：`@runko/sandbox-e2b`、`@runko/sandbox-vercel`、`@runko/sandbox-cloudflare`。任何满足能力要求的沙盒，也都可以照契约自己写适配器接入（见[技术方案](../tech/sandbox.md) §检查清单）。

## 快速上手

最小接入（以 E2B 为例，其余两家同构）：

```ts
import { createSession } from "@runko/sdk";
import { e2bWorkspace } from "@runko/sandbox-e2b";
import { Sandbox } from "e2b";

const sandbox = await Sandbox.create();                 // 你自己建、自己管
const session = createSession(agent, { workspace: e2bWorkspace(sandbox) });
await session.send("把 README 里的安装步骤补全");
// ... 用完
await sandbox.kill();                                   // 你自己收
```

三家的工厂函数与接入形态：

| | `@runko/sandbox-e2b` | `@runko/sandbox-vercel` | `@runko/sandbox-cloudflare` |
|---|---|---|---|
| 工厂 | `e2bWorkspace(sandbox, opts?)` | `vercelWorkspace(sandbox, opts?)` | `cloudflareWorkspace({ url, token, sandboxId? })` |
| 接入形态 | SDK 直连，传入已创建实例 | SDK 直连，传入已创建实例 | HTTP 客户端 + 你自部署的 Worker 网关 |
| 隔离 | Firecracker microVM | Firecracker microVM | Cloudflare Containers |
| 默认工作区根 | `/home/user`（`opts.root` 可配） | `/vercel/sandbox`（`opts.root` 可配） | 沙盒默认工作目录（不可配） |
| 命令语义 | shell 字符串直传 | 适配器包 `bash -lc` | shell 字符串直传 |
| 流式输出 | ✓ | ✓ | ✓ |
| 会话重连键 | `sandboxId` | `name`（持久快照，恢复体验最好） | 网关请求头里的 sandboxId |
| 真机验证 | ✓ 已通过 | ✓ 已通过 | 待部署网关后验证 |

`opts.root` 把 agent 视角的虚拟绝对路径 `/` 锚定到沙盒内某个真实目录（默认各家工作目录）；agent 看到的永远是 `/` 开头的干净路径，真实路径换算在适配器内完成。

## 三种执行模式：你在选哪一种

runko 的文件系统与命令执行是两个独立注入的接口，于是有一个绕不开的问题：**bash 能看到 agent 刚用文件工具改过的文件吗？** 按答案分三种模式，沙盒是其中的**模式 A**：

| | 模式 A 同源工作区（沙盒） | 模式 B 物化执行 | 模式 C 完全解耦 |
|---|---|---|---|
| 文件真身在哪 | 沙盒里（一份） | 虚拟 FS 里，执行时临时落盘 | 两边各自一份 |
| bash 可见文件工具的修改 | ✓ 天然可见 | ✓（runko 物化保证） | ✗ |
| 一致性谁负责 | 无需任何人（结构性一致） | runko | 宿主 |
| 隔离 | 沙盒 VM / 容器 | 无（真机进程） | 取决于宿主实现 |
| bash 默认审批 | 免审批（`"allow"`） | 逐条审批（`"review"`） | 由实现声明 |
| 典型用法 | 云沙盒改真实仓库 | 本机开发 | 只读分析等特殊场景 |
| 注入方式 | `{ workspace }` | `{ fs, exec: localExec({ materialize: true, fs }) }` | `{ fs, exec: 自定义 }` |

- **模式 A（沙盒）**：一个对象同时实现两个接口，文件真身只有一份、在沙盒里；`RunkoFS` 只是它的 API 视图，bash 是另一个访问入口。文件工具写了一个文件，bash 立刻 `cat` 得到；bash 写了，read_file 立刻读得到。**一致性是结构性的**——根本没有两份数据，所以不存在同步逻辑，也不存在竞态。本手册讲的「沙盒」专指这种。
- **模式 B（物化执行，本机便利实现）**：文件真身在内存虚拟 FS 里，执行命令前临时物化到真实磁盘、结束后按修改时间收回。命令跑在你的真机上，所以默认逐条审批。它是便利实现，**不是安全边界**。
- **模式 C（完全解耦，逃生门）**：注入一个和文件面毫无关系的 exec（只读分析器、远程任务队列等），语义由宿主自己保证。

> `workspace` 与 `fs` / `exec` 互斥：同时传会在创建 session 时直接报错。沙盒永远走 `workspace`；`fs` + `exec` 分开传是模式 B/C 的形态。

## 你需要知道的沙盒行为（对外可见语义）

接入沙盒后，有几条与本机不同的可见行为，写应用前要清楚：

1. **bash 免审批**。沙盒实现声明 `defaultApproval: "allow"`——因为**隔离本身就是安全边界**（整个 VM/容器可丢弃），bash 无需逐条人工确认。对照本机 `localExec` 出厂是 `"review"`。你仍可在注入时用会话级[审批策略](../../../terms.md)覆盖它（比如给含 `git push` 的命令加[人在回路](../../../terms.md)审批门）。
2. **bash 能走出工作区，文件工具不能**。真实 shell 天然可以 `cd /` 走到容器真实根目录；文件工具的七个方法则始终锚定在工作区根、拒绝 `..` 越界。这不是漏洞——沙盒场景下边界是隔离，不是路径校验。**由此派生一个坑**：bash 脚本里写 `/foo` 指向容器真实根，不是工作区根；bash 和文件工具要共享文件时**用相对路径**。这些差异都会写进 bash 工具的环境描述（`describe()`），模型能看到。
3. **bash 改的文件不产生 `file_change` 事件**。runko 只从自己的文件工具派生变更事件（Claude Code、codex 同此行为）。所以事件流水**不是**完整的文件变更审计——要完整清单，在沙盒里跑 `git status` / `git diff`。
4. **「先读后改」校验**。bash 改过的文件，agent 必须重新 read_file 之后才能 edit_file（以文件修改时间 mtime 为判据）。这是防止 agent 基于过期内容盲改。
5. **每次文件工具调用 = 一次网络往返**（几十到几百毫秒，vs 本机虚拟 FS 的微秒级）。对 agent 体验影响有限（模型推理仍是延迟大头），但**扫描类操作**（大范围 glob、全仓 grep）应引导模型用一条 bash 命令解决，别用文件工具逐个拉——这条建议也写在 `describe()` 里。

## 什么样的沙盒能接入

用官方三家之外的沙盒时，对照这份能力要求：

**硬性要求（四条，缺一不可）**：

1. **有文件 API**，能凑出七个方法：读文件（二进制）、写文件、删除、建目录、列目录（含条目类型）、取修改时间、glob。原生没有 glob 不要紧——三家官方沙盒都没有，适配器用「递归列目录 + 客户端做通配匹配」合成。
2. **能执行 shell 命令**，且能指定工作目录。只接受 argv 形式（不走 shell）也行，适配器包一层 `bash -lc` 即可。
3. **宿主进程能连得上**：要么 SDK 能在普通 Node 进程里直接用（E2B、Vercel），要么自己部一个网关打通（Cloudflare 就是这样）。
4. **真实 Linux 语义**：POSIX 路径，容器里有常规工具链。

**推荐但非必需**（缺了要在文档里说明取舍）：命令输出的流式回调（没有就命令结束一次性回报）；原生命令超时与取消（没有就适配器本地计时兜底）；文件修改时间的毫秒级精度（秒级也能用，但「先读后改」存在同一秒内绕过的理论窗口）；持久化快照（有它才能做「会话休眠、回来接着聊」）。

## 会话生命周期与恢复

沙盒的创建、销毁、续期、暂停恢复、费用、凭证**全归你（宿主）**；适配器只在沙盒过期时返回带指导文案的错误，**不擅自重建**。

- **会话恢复**：runko 的会话状态（[SessionState](../../../terms.md)，即消息史）和沙盒的文件态**分开保存、分开恢复**。你记下沙盒的重连键（E2B 的 `sandboxId`、Vercel 的 `name`），恢复时先重建 workspace 对象，再 `createSession({ resume, workspace })`。模式 A 下两者天然对得上——文件真身一直在沙盒里。恢复沙盒会话**不要用** `toJSON({ includeFs: true })`（依赖沙盒不提供的 `snapshot()`），用默认 `toJSON()` 保存消息史即可。
- **休眠 / 唤醒（产品化参考）**：给沙盒设[存活时长](../../../terms.md)后，长时间没人用会自动停机并存[平台快照](../../../terms.md)（[休眠](../../../terms.md)）；下条消息来时按名字恢复快照（[唤醒](../../../terms.md)）；每条消息给沙盒[保活](../../../terms.md)（补足剩余存活时间，注意跑命令**不会**自动延长存活时长）；快照过期则重新 clone + checkout 会话分支兜底。这套「休眠-唤醒」的完整产品化实现属于 chat webapp 功能（见其[代码快照](../../../terms.md) / [快照引用](../../../terms.md)机制），沙盒适配器本身只提供「过期即报错、由宿主决定重建」的原语。

## 端到端用法示例：真实项目设计优化 + 完整 Git 工作流

这是官方给的一个「照着就能跑」的完整示例（`examples/12-vercel-sandbox-real-project.e2e.test.ts`），演示 agent 连接 Vercel 沙盒、对一个真实前端项目做一次设计优化并走完整 Git 工作流。**它不需要给三个包或 core 写任何新代码，只是一个 example 脚本。**

链路：宿主机器建沙盒并 git clone 目标仓库 → host 侧初始化（装 [skill](../../../terms.md)、配 git 身份/remote）→ `Skill.fromFS(workspace, …)` 从沙盒文件系统直接装载 skill → agent 自主完成 `load_skill(frontend-design)` → 读代码 → 一次聚焦的设计优化 → 构建验证 → `git checkout -b` / commit / push → `curl` 调 GitHub REST 开 PR → 汇总（改动清单 + 设计意图 + 分支名 + PR 链接）。

各环节的落点与你需要准备的东西：

| 环节 | 做法 | 你要准备 |
|---|---|---|
| 拉代码 | `Sandbox.create` 原生 `source: { type: "git", … }`，私库用 PAT 作 password（username 占位 `x-access-token`）；检出到 `/vercel/sandbox`（= 默认工作区根） | 目标仓库地址 |
| GitHub 身份 | v1 用 **fine-grained PAT**：仅授权目标仓库，权限 Contents RW + Pull requests RW + Metadata Read；建议短有效期、跑完 revoke。真 bot 署名（`app[bot]` + 1h 自动过期 token）需 GitHub App，列 v2 | 线下签发 PAT 填进 `.env` |
| 装 skill | host 侧 `npx -y skills add anthropics/skills --skill frontend-design -a cursor -y`，落到仓库内 `.agents/skills/frontend-design/`；主路径异常时 fallback 到 `git clone` 官方 skills 仓库 | 无（沙盒内联网即可） |
| 装载 skill | `await Skill.fromFS(workspace, "/.agents/skills/frontend-design")` → `defineAgent({ skills })`——**从沙盒文件系统直接加载 skill 是 runko 的能力，宿主机器不需要有这个 skill** | 无 |
| 防误提交 | `.agents/` / `.skills/` 写进沙盒的 `.git/info/exclude`（不污染仓库 `.gitignore`） | 无 |
| push / PR | host 侧预配 `git remote set-url origin https://x-access-token:${PAT}@github.com/<owner>/<repo>.git` + `git config user.name/email`；PR 走沙盒内 `curl` 调 `api.github.com/repos/.../pulls`（免装 gh） | 无 |
| 部署 | 主路径：项目已连 GitHub 时，push / 开 PR 自动触发 Vercel preview，bot 在 PR 里评论预览 URL（零代码）。fallback：沙盒内 `npx vercel deploy`（要多放一个 `VERCEL_TOKEN`，权限大，能走主路径就别走） | 确认项目已连 Git |
| 汇总 + 清理 | 汇总即 `session.send()` 的 `finalResponse`；清理 `finally { await sandbox.stop() }` + `persistent: false`（一次性任务不留快照） | 无 |

所需环境变量（`examples/.env.template` 占位，`.env` 填好后一键跑；缺项时脚本打印指引并干净退出）：`GITHUB_REPO`（接受 SSH 或 HTTPS，example 内部统一规范化成 HTTPS+PAT）、`GITHUB_PAT`、以及 DeepSeek + 三个 `VERCEL_*` 凭证。设计任务默认用更强档模型 `deepseek-v4-pro`（`RUNKO_MODEL` 可覆盖）。

> 这条链路已真机跑通并产出真实 PR（`ludafa/Schulte-Grid#2`，见[施工进展](../plans/sandbox.md)）。

## 范围与非目标

**范围（v1）**：E2B / Vercel / Cloudflare 三家官方适配器；BYO 实例（不管沙盒生命周期）；模式 A 同源工作区。

**非目标 / 已知限制**：

- **不支持 symlink**：沙盒里的 symlink 一律按普通文件报告。
- **不支持 reference 条目**（虚拟 FS 的「指向外部资源的文件」概念）——真实文件系统没地方存这些元数据。
- **bash 改的文件永远不产生 `file_change` 事件**（模式 A 规则，是设计不是缺陷）。
- **不追求把远程文件操作做到本地速度**——每次文件工具调用就是一次网络往返，缓解方式是引导模型用 bash 做批量操作。
- **沙盒的自动重建、自动续期属于宿主层能力**，核心与适配器刻意不做（自动重建的参考实现在 chat webapp 功能里）。
- **mtime 秒级精度下**，「先读后改」校验存在同一秒内被绕过的理论窗口，v1 接受这个取舍。
- **Cloudflare 需要 Workers 付费计划**、且 SDK 只能跑在 Workers 里（走网关形态）；无真正免费层。

## 成功标准

- 三个官方适配器都能以「模式 A 同源工作区」一次注入接入，`createSession` / loop / 工具装配代码**零改动**——只换 `workspace` 实参。
- 每家适配器忠实遵守 `RunkoFS` 七方法 + `RunkoExec` 契约（二进制无损、NotFoundError 归一、非零退出码 resolve 不 reject、超时 124 / 取消 130 本地兜底）。
- 真机验证：E2B / Vercel 两家各跑 20 项契约断言全过；两家在真实沙盒 + 真实模型下完成「写文件 + bash 验证」；真实项目端到端跑通并产出真实、可人工 review 的 PR。（详见[施工进展](../plans/sandbox.md)。）
