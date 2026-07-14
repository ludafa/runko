# nimbo 沙盒规范（Sandbox Specification）

> 状态：v1.5（2026-07-14）
> 相关文档：[技术实现文档](./02-tech-spec.md) §4.4/§4.5a（NimboFS / NimboExec 接口原文）· [云沙盒调研与定案](./06-sandbox-workspace-research.md) · [chat agent webapp](./08-chat-agent-webapp.md)（沙盒休眠/唤醒的产品化参考）
>
> 文中「必须 / 不得 / 应当 / 可以」为规范性用词：必须与不得是硬性要求；应当允许有充分理由的偏离，但须在文档里声明；可以为完全可选。

## 0. 一句话总览

对 nimbo 而言，**沙盒就是一个同时实现了 `NimboFS`（文件接口）和 `NimboExec`（命令执行接口）的对象**，通过 `createSession(agent, { workspace })` 一次性注入。注入之后：

- agent 的文件工具（read_file / write_file / edit_file …）读写的是沙盒里的文件；
- agent 的 bash 工具在沙盒里执行命令；
- 两者操作的是**同一份文件**——文件真身只有一份，在沙盒里。

nimbo 本身**不创建、不销毁、不管理沙盒**：沙盒由宿主应用自己创建（API key、计费、超时、回收都归宿主），适配器只负责把沙盒的 SDK 翻译成上面两个接口。

官方提供三个适配器包：`@nimbo/sandbox-e2b`、`@nimbo/sandbox-vercel`、`@nimbo/sandbox-cloudflare`（见 §5）。任何满足 §3 能力要求的沙盒，都可以照 §4 的契约自己写适配器接入。

## 1. 三种执行模式：A / B / C

nimbo 的文件系统（NimboFS）和命令执行（NimboExec）是两个独立注入的接口，于是有一个绕不开的问题：**bash 能看到 agent 刚用文件工具改过的文件吗？** 按这个问题的答案，分成三种模式：

### 模式 A · 同源工作区（沙盒就是这种）

**一个对象同时实现两个接口，文件真身只有一份。**

```ts
const workspace = vercelWorkspace(sandbox);          // NimboFS & NimboExec 合一
createSession(agent, { workspace });
```

文件数据存在沙盒里；NimboFS 只是它的 API 视图（readFile → 调沙盒的文件 API），bash 是另一个访问入口。文件工具写了一个文件，bash 立刻能 `cat` 到；bash 写了一个文件，read_file 立刻能读到。**一致性是结构性的**——因为根本没有两份数据，所以不存在同步逻辑，也不存在竞态。

本规范约束的「沙盒」专指这种模式。

### 模式 B · 物化执行（本机便利实现）

**文件真身在 nimbo 的虚拟文件系统（内存）里，执行命令时临时「物化」到真实磁盘。**

```ts
createSession(agent, { fs, exec: localExec({ materialize: true, fs }) });
```

每次 bash 执行前，nimbo 把虚拟文件系统整体写到一个随机临时目录；命令在临时目录里跑真实进程；结束后按文件修改时间把变更收回虚拟层。一致性由 **nimbo 负责维护**（物化 + 回收这套动作）。

适用场景：本机开发、想让 agent 跑真实命令但文件仍留在虚拟层。**它是便利实现，不是安全边界**——命令跑在你的真机上，所以 `localExec` 默认要求逐条审批（`defaultApproval: "always"`）。

### 模式 C · 完全解耦（逃生门）

**文件和命令执行各管各的，互相看不见。**

```ts
createSession(agent, { fs, exec: myReadonlyAnalyzer });   // exec 与 fs 无关
```

宿主注入一个和 NimboFS 毫无关系的 exec（比如一个只读的分析环境、一个远程任务队列）。文件工具改的文件，bash 看不到；bash 产生的文件，文件工具也看不到。**语义由宿主自己保证**——明知不一致而用之，适合命令面和文件面本来就无关的场景。

### 三种模式对比

| | 模式 A 同源工作区 | 模式 B 物化执行 | 模式 C 完全解耦 |
|---|---|---|---|
| 文件真身在哪 | 沙盒里（一份） | 虚拟 FS 里，执行时临时落盘 | 两边各自一份 |
| bash 可见文件工具的修改 | ✓ 天然可见 | ✓（nimbo 物化保证） | ✗ |
| 一致性谁负责 | 无需任何人（结构性一致） | nimbo | 宿主 |
| 隔离 | 沙盒 VM/容器 | 无（真机进程） | 取决于宿主实现 |
| bash 默认审批 | 免审批（`"never"`） | 逐条审批（`"always"`） | 由实现声明 |
| 典型用法 | 云沙盒改真实仓库 | 本机开发 | 只读分析等特殊场景 |

## 2. 接入方式、数据流与责任划分

```ts
import { createSession } from "@nimbo/sdk";
import { e2bWorkspace } from "@nimbo/sandbox-e2b";
import { Sandbox } from "e2b";

const sandbox = await Sandbox.create();                 // 宿主自己建、自己管
const session = createSession(agent, { workspace: e2bWorkspace(sandbox) });
// ... 用完
await sandbox.kill();                                   // 宿主自己收
```

### agent 配置与沙盒的交界

模型、instructions、tools、skills 的配置都挂在 `defineAgent` 上，与沙盒注入正交，属于 SDK 的通用用法——写法见项目 README（[README.md](../README.md) / [中文版](./README.zh-CN.md)），本规范不展开。只有三点与沙盒有关：

- **模型调用不经过沙盒**：推理发生在宿主进程，模型 API key 留在宿主、不要注入沙盒环境变量——需要进沙盒的只有任务本身的凭证（如 git 推送的 PAT），两者别混在一起。
- **工具和 skill 天然落在工作区上**：内置文件工具与自定义工具 `execute(input, ctx)` 里的 `ctx.fs` 就是沙盒文件面，零额外接线；`Skill.fromFS(workspace, path)` 可以直接从沙盒文件系统装载 skill——skill 先在沙盒里装（如 `npx skills add`），宿主机器不需要有它（docs/07 的端到端示例验证过这条链路）。
- **带附属文件的 skill 会写进沙盒**：首轮开始前经文件接口写入工作区 `/.skills/<name>/`，模式 A 下即写进沙盒真实文件系统、会出现在 `git status` 里——把 `.skills/` 加进沙盒的 `.git/info/exclude`，或用单文件 skill。

### `createSession` 关键类型

以下是与沙盒相关的类型定义要点（完整定义见 `packages/core/src/session.ts`）：

```ts
function createSession(agent: AgentDefinition, opts?: SessionOptions): Session;

interface SessionOptions {
  fs?: NimboFS;                      // 文件面，单独注入
  exec?: NimboExec;                  // 命令面，注入即激活内置 bash 工具
  workspace?: NimboFS & NimboExec;   // 沙盒入口：同源工作区一次注入 fs + exec
  onApproval?: ApprovalPolicy;       // session 级审批兜底裁决者
  instructions?: { append: string }; // 在 agent 定义的 instructions 之上追加
  resume?: SessionState;             // 从 session.toJSON() 的快照恢复
}

interface Session {
  readonly id: string;
  readonly fs: NimboFS;              // 即注入的 workspace 的文件面视图
  send(input: Input, opts?: TurnOptions): Promise<TurnResult>;
  send<T>(input: Input, opts: TurnOptions & { outputSchema: z.ZodType<T> }):
    Promise<TurnResult & { structuredOutput: T }>;
  stream(input: Input, opts?: TurnOptions): AsyncGenerator<SessionEvent, TurnResult>;
  steer(input: Input): boolean;      // turn 进行中插入一条 user 消息
  toJSON(opts?: { includeFs?: boolean }): SessionState;
}

type Input = string | InputBlock[];               // 文本或 text/image 块
interface TurnOptions { signal?: AbortSignal; }
interface TurnResult { items: SessionItem[]; finalResponse: string; usage: Usage; }
```

沙盒场景下的使用要点：

- **`workspace` 与 `fs` / `exec` 互斥**：同时传会在创建 session 时直接报错。沙盒（模式 A）永远走 `workspace`；`fs` + `exec` 分开传是模式 B/C 的形态。
- **bash 工具是条件激活的**：注入了命令面（`workspace` 或 `exec`）才会出现 bash 工具，不注入就没有命令执行能力。
- **bash 的审批默认值来自实现**：沙盒实现声明 `defaultApproval: "never"`（免审批），本机 `localExec` 是 `"always"`；需要升级审批的工具最终由 `onApproval` 裁决。
- **恢复沙盒会话不要用 `fsSnapshot`**：`toJSON({ includeFs: true })` 依赖 fs 实现提供 `snapshot()`，沙盒工作区不提供（§4.5 规则 3）——沙盒场景用默认的 `toJSON()` 保存消息史，文件态由沙盒自己的快照/重连机制恢复，再以 `createSession({ resume, workspace })` 续起（§4.6）。

### 数据输入与输出：事件流、transcript 与 steer

loop agent 跑起来之后，宿主和 session 之间的数据交换有三个通道：

**输入**有两个入口：`send` / `stream` 发起新的一轮（收 `Input`：文本，或 text/image 块数组）；`steer` 在一轮进行中插入输入（语义见下）。

**输出是 item 级的事件流**。`stream()` 逐事件产出，`send()` 是它的缓冲版（只拿最终的 items / finalResponse / usage）：

```ts
type SessionEvent =
  | { type: "session.started"; sessionId: string }
  | { type: "turn.started"; turn: number }
  | { type: "item.started" | "item.updated" | "item.completed"; item: SessionItem }
  | { type: "turn.completed"; usage: Usage }
  | { type: "turn.failed"; error: NimboError };   // code: max_turns | context_overflow | provider_error | aborted

type SessionItem =
  | { id; type: "agent_message"; text }           // 模型的回复文本
  | { id; type: "reasoning"; text }               // 推理过程
  | { id; type: "user_message"; text }            // steer 注入的用户消息（见下）
  | { id; type: "tool_call"; toolName; input; output?;
      status: "in_progress" | "completed" | "failed" | "denied" }
  | { id; type: "file_change"; changes: { path; kind: "add" | "update" | "delete" }[] }
  | { id; type: "plan_update"; items: { text; completed }[] }
  | { id; type: "error"; message };
```

**transcript 分两层，恢复只认其中一层**：

1. **消息史（权威层）**：`session.toJSON()` 返回的 `SessionState`——`{ id, turn, messages, createdAt, fsSnapshot? }`，其中 `messages` 是可 JSON 序列化的模型消息数组。这是 `resume` 恢复的唯一依据；事件和 items **不在**里面。
2. **事件流水（展示/审计层）**：上面的事件流由宿主自己决定要不要落库。参考做法（docs/08 已验证）：每个事件按 `(会话, 序号)` 递增落库，断线/刷新后从任意序号回放，与直播逐事件一致。

沙盒场景的注意点：`file_change` 只由 nimbo 的文件工具产生，**bash 改文件不会出现在事件流里**（§4.5 规则 1）——事件流水不是完整的文件变更审计，完整清单要在沙盒里问 git。

**steer：进行中一轮的 pending 输入**。`steer(input)` 的完整语义：

- 有进行中的 turn 时：输入排队，在下一个 step checkpoint（两次模型调用之间）注入为一条 user 消息，返回 `true`——**不打断**正在进行的模型流式输出或工具执行，所以从调用到注入有一段 pending 窗口；
- 注入那一刻会产出一条 `user_message` item——这就是 steer 消息在 transcript 里的落点（时间线位置即真实注入位置；相比之下，发起一轮的输入本身不产生 item）；
- 没有进行中的 turn 时：返回 `false`，什么都不排队——调用方此时应改用 `send` / `stream` 发起新的一轮；
- 队列是 turn 作用域：turn 正常收尾时会先把已排队的输入消化掉（宁可多跑一步让模型看到），turn 结束后清空残留；
- 已知缺口：模型调用或工具执行**抛错**导致的 `turn.failed`（`provider_error` / `aborted`）期间，排队中尚未注入的 steer 会被丢弃——对丢失敏感的宿主应在收到 `turn.failed` 后自行重发。

服务端的参考编排（docs/08）：收到用户消息先试 `steer`（成功即「已插入进行中一轮」），失败再回退为 `send`/`stream` 新起一轮——两条路径对客户端只是响应里的一个 mode 字段之差。

### 责任划分

| 事情 | 谁负责 |
|---|---|
| 沙盒的创建、销毁、续期、暂停恢复、费用、凭证 | 宿主 |
| 把沙盒 SDK 忠实翻译成 NimboFS/NimboExec，错误归一，路径换算 | 适配器 |
| 文件工具、bash 工具、先读后改校验、事件、审批链 | nimbo core |
| 沙盒过期之后要不要重建 | 宿主（适配器只报错并给指导，见 §4.6） |

## 3. 什么样的沙盒能接入

**硬性要求（四条，缺一不可）**：

1. **有文件 API**，能凑出七个方法：读文件（二进制）、写文件、删除、建目录、列目录（含条目类型）、取修改时间、glob。原生没有 glob 不要紧——三家官方沙盒都没有，适配器用「递归列目录 + 客户端做通配匹配」合成。
2. **能执行 shell 命令**，且能指定工作目录。只接受 argv 形式（不走 shell）也行，适配器包一层 `bash -lc` 即可。
3. **宿主进程能连得上**：要么 SDK 能在普通 Node 进程里直接用（E2B、Vercel），要么自己部一个网关打通（Cloudflare 就是这样，见 §6）。
4. **真实 Linux 语义**：POSIX 路径，容器里有常规工具链。

**推荐但非必需**（缺了要在文档里说明取舍）：

- 命令输出的流式回调——没有的话，允许命令结束时一次性回报；
- 原生的命令超时与取消——没有的话，适配器在本地计时兜底（§4.2）；
- 文件修改时间的毫秒级精度——秒级也能用，但「先读后改」校验存在同一秒内绕过的理论窗口；
- 持久化快照——有它才能做「会话休眠、回来接着聊」的体验（docs/08 的做法）。

## 4. 适配器必须遵守的契约

### 4.1 文件面（NimboFS 七方法）

接口定义见 tech-spec §4.4，适配器在其上要保证：

| 方法 | 要求 |
|---|---|
| `readFile` | 返回 `Uint8Array`，二进制必须无损（含 `0x00` 字节）。 |
| `writeFile` | **必须自动创建中间目录**（底层没有这语义的，适配器先补一次 mkdir）。 |
| `rm` | 非递归删非空目录**必须**失败（抛 `DirectoryNotEmptyError`）；底层只有递归删的，先查再拒。 |
| `mkdir` | 等价 `mkdir -p`；路径上已有同名文件则报错。 |
| `readdir` | 每条至少有 `name` 和 `type`，应当按名称排序；size/mtime 可省（省得每个条目多打一次网络请求）。 |
| `stat` | `type` 只有 `"file"` 和 `"dir"`（symlink 等一律归为 `"file"`）；`mtime` **必须**换算成 epoch 毫秒。 |
| `glob` | 只匹配文件、不匹配目录，结果按路径排序；匹配逻辑用 `@nimbo/virtual-fs` 导出的工具函数，**不得**依赖沙盒里装了 `find`。 |

**错误归一**：所有「路径不存在」，不管底层怎么表达（自家异常、`ENOENT`、`success: false`……），**必须**统一翻译成 `@nimbo/virtual-fs` 的 `NotFoundError` 抛出。nimbo 的文件工具靠 `instanceof` 识别这个错误，所以适配器必须把 `@nimbo/virtual-fs` 作为运行时依赖，不能自己复制一个同名类。

### 4.2 命令面（NimboExec）

1. **只 resolve，不 reject**：命令非零退出、超时、被取消、网络断了、沙盒已停——所有失败**必须**以带非零 `exitCode` 和 stderr 说明的结果正常返回。bash 工具会把非零退出码当普通结果回给模型，模型自己纠错；reject 只留给「适配器自身彻底坏了」的场景。底层 SDK 遇到非零退出就抛异常的（E2B 如此），适配器 catch 住转成结果。
2. **退出码约定**：超时 **124**、取消 **130**（POSIX 惯例），其余失败用 1 或底层真实退出码。
3. **超时和取消必须本地兜底**：适配器自己起计时器/监听 signal，触发后**立刻**返回 124/130，不等远端——网络分区时远端的 Promise 可能永远不落定。允许「本地先返回、远端命令自然跑完」的放弃等待语义，但要在文档说明。
4. **shell 语义**：`command` 是一段 shell 字符串。底层只收 argv 的，包成 `bash -lc <整段脚本>`——脚本作为单个参数传入，不做任何字符串拼接。
5. **cwd**：调用方传的是虚拟绝对路径，适配器换算成沙盒真实路径；不传时默认工作区根。
6. **onOutput**：有流式就增量回调；没有就结束时一次性回调，并在 `describe()` 里声明「输出非流式」。

### 4.3 路径与安全边界

- 适配器应当提供 `root` 选项，把虚拟路径 `/` 锚定到沙盒内某个目录（E2B 默认 `/home/user`，Vercel 默认 `/vercel/sandbox`）。agent 看到的永远是 `/` 开头的干净路径。
- 文件面七方法**必须**拒绝 `..` 越出锚定根（和内存 FS 同一套路径校验）。
- **bash 不受这个限制**：真实 shell 天然可以 `cd /` 走出工作区。这不是漏洞——沙盒场景下，**安全边界是隔离本身**（整个 VM/容器都是可丢弃的），不是路径校验。这个差异必须写进 `describe()`。
- 一个由此派生的坑：bash 脚本里写 `/foo` 指向的是容器真实根目录，不是工作区根。bash 和文件工具要共享文件时，**用相对路径**——此提示也要进 `describe()`。

### 4.4 describe() 与审批

- 沙盒实现的 `defaultApproval` **必须**是 `"never"`（隔离即边界，bash 免审批；注入时宿主可覆盖）。对照：本机 `localExec` 出厂就是 `"always"`——没有隔离就必须有审批。
- `describe()` 的返回会拼进 bash 工具的描述，是模型认识这个环境的唯一渠道，**必须**如实写清：
  1. 环境是什么（microVM / 容器，真实 Linux，非虚拟 FS）；
  2. 文件工具锚定在工作区、bash 能走出去（§4.3）；
  3. 有没有网络；
  4. 每次文件工具调用是一次网络往返（几十到几百毫秒），扫描类操作（大范围 glob、全仓 grep）**建议一条 bash 命令解决**，别用文件工具一个个拉；
  5. 本实现特有的取舍（输出非流式、mtime 秒级精度之类）。

### 4.5 一致性与事件（模式 A 的三条规则）

1. **bash 改文件不产生 `file_change` 事件**——nimbo 只从自己的文件工具派生事件（Claude Code、codex 同此行为）。宿主要完整变更清单，在沙盒里跑 `git status` / `git diff`。
2. **「先读后改」校验以 `stat().mtime` 为判据**——bash 改过的文件，agent 必须重新 read_file 之后才能 edit_file。适配器只需把 mtime 换算准确。
3. **`diff()` / `writeBack()` / `snapshot()` 不是必需接口**——那是内存 FS 的附加能力，文件工具不依赖它们，沙盒实现可以不提供（要基线管理，用沙盒里的 git）。

### 4.6 生命周期与会话恢复

- **沙盒过期/已停止**：适配器**必须**返回带指导文案的错误（exec 面是非零结果，文件面是异常），告诉宿主「沙盒已停，请重建或续期」；**不得**擅自重建——重建是宿主的策略（自动重建的参考实现见 docs/08 的 sandbox-manager）。
- **会话恢复**：nimbo 的会话状态（`session.toJSON()`，消息史）和沙盒的文件态**分开保存、分开恢复**。宿主记下沙盒的重连键（E2B 的 `sandboxId`、Vercel 的 `name`），恢复时先重建 workspace 对象，再 `createSession({ resume, workspace })`。模式 A 下两者天然对得上——文件真身一直在沙盒里。
- 休眠-唤醒的参考做法（docs/08 已验证）：每条消息给沙盒续期即「保活」；到期沙盒自动停止并快照即「休眠」；下条消息来时按名字恢复快照即「唤醒」；快照过期则重新 clone + checkout 会话分支兜底。

### 4.7 工程要求

- **不在运行时 import 沙盒厂商的 SDK**：工厂函数收一个手写的最小结构接口（只声明实际用到的方法），官方 SDK 只作为 devDependency 做类型对照。这样宿主和适配器各装各的 SDK 版本互不干扰，测试也不需要真实网络。
- **识别厂商错误用字段结构判断，不用 `instanceof`**——两份 SDK 副本的类不是同一个类。
- 运行时依赖收敛为 `@nimbo/core`（类型）+ `@nimbo/virtual-fs`（错误类、glob 工具、路径校验）。
- 适配器是独立可选包，**不进 `@nimbo/sdk` 的依赖**，宿主按需安装。

## 5. 官方支持矩阵

| | `@nimbo/sandbox-e2b` | `@nimbo/sandbox-vercel` | `@nimbo/sandbox-cloudflare` |
|---|---|---|---|
| 工厂 | `e2bWorkspace(sandbox, opts?)` | `vercelWorkspace(sandbox, opts?)` | `cloudflareWorkspace({ url, token, sandboxId? })` |
| 接入形态 | SDK 直连，传入已创建实例 | SDK 直连，传入已创建实例 | HTTP 客户端 + 自部署 Worker 网关 |
| 隔离 | Firecracker microVM | Firecracker microVM | Cloudflare Containers |
| 默认 root | `/home/user`（可配） | `/vercel/sandbox`（可配） | 沙盒默认工作目录（不可配） |
| 命令语义 | shell 字符串直传 | 适配器包 `bash -lc` | shell 字符串直传 |
| 流式输出 | ✓ | ✓ | ✓ |
| 会话重连键 | `sandboxId` | `name`（持久快照，恢复体验最好） | 网关请求头里的 sandboxId |
| 真机验证 | ✓ | ✓ | 待部署网关后验证 |

各家已知取舍（详见各包 README）：

- **e2b**：SDK 遇到非零退出码会抛异常，适配器转成正常结果；取消是「本地放弃等待」，远端命令可能跑完。
- **vercel**：命令是 argv 语义，适配器统一包 `bash -lc`；超时以适配器本地计时为准，原生超时作远端兜底。
- **cloudflare**：SDK 只能跑在 Cloudflare Workers 里，所以走网关形态（§6）；需要 Workers 付费计划。

## 6. 网关形态（沙盒不可直连时）

有的沙盒 SDK 没法在普通 Node 进程里用（Cloudflare 就是）。这时的接法是**自部署一个 HTTP 网关**：网关跑在能碰到沙盒的环境里，把七个文件方法和 exec 映射成 HTTP 端点；nimbo 这边用一个纯 fetch 的客户端连它。

协议要点（全文见 docs/06 §8.3）：

- 全部 POST + JSON，Bearer token 认证，请求头选择沙盒 id，二进制走 base64；
- 错误统一为 `{ code, message }`，客户端翻译回 `NotFoundError` 等标准错误；
- exec 走 NDJSON 流：若干条输出增量 + 一条带退出码的终块；取消靠中断 HTTP 请求传播。

以后接入其它「连不上」的沙盒，应当直接复用这份协议和现成的客户端（`@nimbo/sandbox-cloudflare` 的主入口），只需要重写网关那一侧。

## 7. 自己写一个适配器：检查清单

1. [ ] 工厂签名 `xxxWorkspace(实例或连接配置, opts?) => NimboFS & NimboExec`；只包视图，不创建不销毁沙盒。
2. [ ] 不在运行时 import 厂商 SDK；错误按字段结构识别（§4.7）。
3. [ ] 七个文件方法逐条对照 §4.1，重点：`NotFoundError` 归一、writeFile 自动建父目录、非递归 rm 拒删非空目录、glob 只报文件、mtime 换算成毫秒。
4. [ ] 路径锚定 + 文件面拒绝 `..` 越界；bash 能越出工作区的事实写进 `describe()`（§4.3）。
5. [ ] exec 只 resolve 不 reject；超时 124 / 取消 130 且本地兜底及时返回（§4.2）。
6. [ ] `defaultApproval: "never"`；`describe()` 覆盖 §4.4 的五项内容。
7. [ ] 沙盒过期报带指导的错误，不自动重建（§4.6）。

## 8. 已知限制与非目标

- 不支持 symlink；沙盒里的 symlink 一律按普通文件报告。
- 不支持 reference 条目（虚拟 FS 的「指向外部资源的文件」概念）——真实文件系统没地方存这些元数据。
- bash 改的文件永远不产生 `file_change` 事件（模式 A 规则 1，是设计不是缺陷）。
- 不追求把远程文件操作做到本地速度——每次文件工具调用就是一次网络往返，缓解方式是引导模型用 bash 做批量操作。
- 沙盒的自动重建、自动续期属于宿主层能力，核心和适配器刻意不做（参考实现见 docs/08）。
- mtime 秒级精度下，「先读后改」校验存在同一秒内被绕过的理论窗口，v1 接受这个取舍。

## 9. 文档索引

| 文档 | 内容 |
|---|---|
| [02-tech-spec.md](./02-tech-spec.md) §4.4/§4.5a | NimboFS / NimboExec 接口原文、三模式的原始定义 |
| [04-builtin-tools.md](./04-builtin-tools.md) | bash 与文件工具的规格 |
| [06-sandbox-workspace-research.md](./06-sandbox-workspace-research.md) | 三家沙盒调研、逐接口映射、立项定案、网关协议全文 |
| [08-chat-agent-webapp.md](./08-chat-agent-webapp.md) | 沙盒生命周期产品化（休眠/唤醒/恢复）参考实现 |
| 各包 README（`packages/sandbox-*/README.md`） | 每家的用法与已知差异 |
