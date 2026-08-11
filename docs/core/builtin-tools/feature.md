# 内置工具（builtin tools）· 产品手册

> 相关：技术方案见 [core/builtin-tools/tech.md](./tech.md) · 依赖 [core-sdk 产品手册](../core-sdk/feature.md)（本功能是 core SDK 的一部分）· 术语以 [terms.md](../../terms.md) 为准。
>
> 状态：草案 v1（2026-07-10 定，随施工回填）。本文是**使用手册**——面向接 nimbo 的宿主开发者和被工具驱动的 [agent](../../terms.md)，讲清「这些工具解决什么问题、有哪些、怎么开怎么关、看得见的行为」。内部实现与取舍在技术方案里。

## 1. 解决什么问题

**设计前提：nimbo 默认没有命令执行。** Claude Code / codex 这类编码 agent 的文件工具可以「偷懒」——删除交给 `rm`、重命名交给 `mv`，反正底下有个 shell。nimbo 不行：nimbo 可以在**完全没有 shell** 的环境里跑（嵌入式 SDK、只读审查场景、不给 agent 命令执行面的安全部署）。

因此，凡是「完成一次代码改造」必需的文件系统操作，nimbo 都把它做成**一等内置工具**：读、写、精确编辑、删除、移动、列目录、glob、grep 一个都不少。宿主什么都不用注入，agent 开箱就能读写一个工作区；要命令执行时，再单独把 [NimboExec](../../terms.md) 注进来解锁 `bash`。

**内置工具**指的就是这一组 nimbo 出厂自带、不用宿主写一行代码就能用的 agent 工具。它们默认全开，宿主可以按需裁剪、覆盖或整组关闭。

## 2. 工具一览

| 工具 | 干什么 | 何时出现 |
|---|---|---|
| `read-file` | 读文件文本（带行号） | 默认开，`builtinTools` 可裁剪 |
| `write-file` | 整文件写入/覆盖 | 默认开 |
| `edit-file` | 精确字符串替换 | 默认开 |
| `delete-file` | 删文件/目录 | 默认开 |
| `move-file` | 重命名/移动 | 默认开 |
| `list-dir` | 列目录树 | 默认开 |
| `glob` | 按通配符找文件 | 默认开 |
| `grep` | 正则搜文件内容 | 默认开 |
| `update-plan` | 维护多步任务清单 | 默认开 |
| `load-skill` | 加载一个 [skill](../../terms.md) 的说明 | **条件**：agent 配了 `skills` 才出现 |
| `bash` | 执行 shell 命令 | **条件**：session 注入了 NimboExec 才出现 |

前九个（文件八件套 + `update-plan`）是**可裁剪内置**，由 `builtinTools` 选项统一控制。后两个是**条件内置**：不看 `builtinTools`，只看对应能力有没有被配上——配了 skills 就有 `load-skill`，注入了执行环境就有 `bash`。这样「不给命令执行面」是天然默认（不注入 NimboExec，工具列表里根本没有 `bash`），而不是要你记得去关。

## 3. 怎么用

### 3.1 默认：全开

```ts
defineAgent({ model })                 // 不写 builtinTools = 九个工具全开
```

给 session 一个工作区（[NimboFS](../../terms.md)），文件工具就在这个工作区上读写；再给一个 NimboExec，`bash` 出现：

```ts
createSession(agent, { workspace })    // workspace 同时是 NimboFS + NimboExec：文件工具 + bash 全有
createSession(agent, { fs })           // 只给文件系统：文件工具有，bash 没有
```

### 3.2 裁剪：只留想要的

`builtinTools` 传一个白名单数组，只有列出的才开：

```ts
defineAgent({ builtinTools: ["read-file", "glob", "grep"] })  // 只读 agent（代码问答/审查场景）
defineAgent({ builtinTools: false })                          // 全关，工具全由宿主 tools 注入
```

预设常量 `READ_ONLY_TOOLS`（= `read-file` / `list-dir` / `glob` / `grep`）给只读审查场景一行开箱，它只是个类型层面的常量、不是新机制：

```ts
import { READ_ONLY_TOOLS } from "@nimbo/core";
defineAgent({ builtinTools: [...READ_ONLY_TOOLS] })
```

注意 `builtinTools` 只管那九个可裁剪内置；`load-skill` 和 `bash` 是否出现由 skills / NimboExec 是否配置决定，跟这个数组无关。

### 3.3 覆盖：换掉某个内置实现

宿主在 `tools` 里放一个**同名**工具，就覆盖掉内置实现——比如把内置的纯 JS `grep` 换成接真实目录的 ripgrep 版：

```ts
defineAgent({ tools: { grep: myRipgrepTool } })   // 同名即覆盖，其余内置照旧
```

## 4. 逐工具行为（照着用）

以下是每个工具对外可见的输入、输出和交互约定。所有工具共享三条对使用者可见的通用行为：

- **输出有预算、超限显式截断**：每个工具都有输出上限，超了会在结尾标一行 `[truncated: ...]` 并告诉你怎么缩小范围（换 offset、缩 glob、加过滤）。不会静默截断让你误以为看全了。
- **错误即指导**：失败返回的不是裸报错，而是带「下一步该怎么办」的可行动消息（比如 `edit-file` 没唯一命中时会提示「old_string 加更长的上下文」）。
- **先读后写**：见 4.2。

### 4.1 `read-file` — 读文件

- **输入**：`{ path, offset?, limit? }`（offset/limit 以**行**计）。
- **输出**：`cat -n` 风格带行号的文本（行号是 `edit-file` 定位的锚）。默认整文件，单次上限 **2000 行 / 256KB**，超限截断并提示用 offset/limit 分页——分页永远能读到全量内容。
- **二进制/外部引用不当文本返回**：图片、音视频、pdf、压缩包等被识别为二进制时，返回一小段结构化说明（mimeType、大小、宿主标注的 description），而不是一堆乱码或裸错误。指向外部资源的 reference 条目同理，返回类型/描述/href；若 FS 注入了解析器则直读其内容。
- 读过之后，这个文件在本 session 里被登记为「已知」——这是后面能覆盖写/编辑它的前提（见 4.2）。

### 4.2 `write-file` — 整文件写

- **输入**：`{ path, content }`。
- **行为**：整文件写入；父目录自动创建（不需要单独的 mkdir）。新建产出「新增」变更，覆盖产出「更新」变更。
- **先读后写（read-before-write）**：要覆盖一个**已存在**的文件，必须在本 session 里先 `read-file` 过它、且它自读取以来没被改动过（按 mtime 判断）。这是防「盲覆盖」的硬约束——想改小地方优先用 `edit-file`，更省、也不用把整份内容重述一遍。

### 4.3 `edit-file` — 精确编辑

- **输入**：`{ path, old_string, new_string, replace_all? }`。
- **行为**：把 `old_string` 精确替换成 `new_string`。`old_string` 必须**唯一命中**（除非传 `replace_all: true`）。没命中或命中多处，返回带纠错指导的错误（提示补更长上下文或用 `replace_all`）。
- 同样要求「先读后写」；但**连续编辑同一文件无需重读**——`edit-file` 自己会在成功后把文件保持为「已知」。若期间被外部改过（比如 `bash` 命令写了它），mtime 变了，就必须重读。

### 4.4 `delete-file` — 删除

- **输入**：`{ path, recursive? }`。
- **行为**：删文件或目录。删目录（哪怕是空目录）必须传 `recursive: true`。目录删除会展开成逐文件的「删除」变更清单，宿主拿到的是精确到每个文件的列表。
- **为什么要一等公民**：没有默认 `bash`，删除就必须是一等工具，否则 agent 根本删不掉东西。

### 4.5 `move-file` — 移动/重命名

- **输入**：`{ from, to, overwrite? }`。
- **行为**：重命名或移动。`to` 已存在且没传 `overwrite: true` → 拒绝。一次移动产出一对变更：`delete(from)` + `add(to)`（v1 没有单独的 rename 变更类型）。
- **为什么要一等公民**：重构场景高频操作，没有 `mv` 可替代。

### 4.6 `list-dir` — 列目录

- **输入**：`{ path?, depth? }`（默认根目录、depth 1，即只列直接子项）。
- **输出**：缩进的目录树文本。行尾会标注元信息——非文本文件带 `[mimeType]`、reference 条目带 `→ href`、有宿主描述的条目附一句说明。上限 **500 条目**，超限提示用更深的路径或改用 `glob`。

### 4.7 `glob` — 按通配符找文件

- **输入**：`{ pattern, path? }`（如 `**/*.ts`、`src/**/*.test.ts`）。
- **输出**：匹配的**文件**路径列表（不含目录），按路径排序。上限 **1000 条**，超限提示缩小 pattern/path。

### 4.8 `grep` — 搜内容

- **输入**：`{ pattern /* JavaScript 正则 */, path?, glob?, mode?, context?, ignore_case? }`。
- **输出**：`files` 模式（默认）返回命中文件清单；`content` 模式返回带行号的命中行（`path:line:text` 是命中行，`path-line-text` 是 ±context 的上下文行）。上限 **100 文件 / 500 行**，哪个先到先截。二进制文件自动跳过。
- 注意用的是 **JavaScript 正则**（不是 POSIX/PCRE），非法正则会返回带提示的错误。

### 4.9 `update-plan` — 任务清单

- **输入**：`{ items: { text, completed }[] }`（**整表替换**——每次都传全量，包括没变的项）。
- **输出**：确认文本，并向宿主派生一条计划更新，让宿主实时看到 agent 的待办进度。
- **为什么内置**：多步任务的执行质量和宿主可观测性都显著受益（codex / Claude Code 都默认内置同类工具）。纯内存状态、零安全面，成本只有少量 token——不想要时从 `builtinTools` 里去掉即可。标记 completed 只是记录「做完了」，不校验底下的活是否真做对。

### 4.10 `load-skill` — 加载技能（条件内置）

- **输入**：`{ name }`。
- **输出**：该 skill 的 markdown 正文 + 附属文件清单（提示可用 `read-file` 读 `/.skills/<name>/...`）。
- **只增加说明，不增加能力面**：加载一个 skill 等于往上下文里塞一段指令，绝不会凭空多出一个执行入口（语义与 eve 一致）。仅在 agent 配了 `skills` 时出现。

### 4.11 `bash` — 命令执行（条件内置）

- **输入**：`{ command, cwd?, timeout_ms? }`。
- **输出**：stdout / stderr 合并文本（各自上限 64KB，超限标 `[truncated: ...]`）+ 退出码。执行过程中流式回报输出，宿主能边跑边看。
- **非零退出码 / 超时不是工具失败**：它们作为**正常结果**回给 agent，让它读 stderr 自己决定下一步（改命令、重试、换路子），而不是把 loop 打崩。
- **激活**：只有 session 注入了 NimboExec 实现才出现。不注入 = 默认安全，工具列表里没有命令执行面。
- **环境自描述**：执行环境实现可以自报一段元信息（OS/架构、shell、网络是否可达、工作区路径映射、关键工具链版本等），拼进工具描述里，让 agent 少走试错弯路。
- **审批**：`bash` 是否需要人工把关，取决于执行环境自声明的默认审批档位——本机执行（`localExec()`）出厂要求 [人工审批 `review`](../../terms.md)（本机跑命令必须把关），隔离沙盒实现通常声明 `allow`（隔离即边界，直接放行）。没声明的第三方实现，nimbo 保守地按 `review` 兜底。审批档位可在注入点或按工具覆盖。审批交互本身由宿主接（见 §5 的 ask-user / [人在回路](../../terms.md)）。
- **与文件系统的一致性**：当 `bash` 和文件工具共享同一个工作区时，`bash` 写的文件对 `read-file` 立即可见；但 `bash` 造成的改动**不产生文件变更事件**，且要编辑一个被 `bash` 改过的文件必须先重读它（mtime 变了）。三种工作区/执行环境的搭配模式详见技术方案。

## 5. 范围与非目标（哪些不内置）

以下能力**刻意不做成内置**，改由宿主按需注入——nimbo 已经把接口备好，宿主几行代码接上自己的实现即可：

| 能力 | 为什么不内置 | 怎么补上 |
|---|---|---|
| `web_fetch` / `web_search` | 网络策略是宿主的合规/安全决策；且多家模型已有 server-side web 工具 | 宿主用 `defineTool` 接自己的 fetcher / 搜索栈 |
| `ask-user` / 人工审批中断 | 嵌入式 SDK 没有 UI；人机交互形态只有宿主知道 | 宿主注入工具对接自己的前端 / IM；或用审批链实现「审批即交互」 |
| `sub_agent` / task 编排 | 属于 v2 范围（需要 session 派生语义） | 暂不提供 |

> 历史提示：`exec` / `bash` 原本也列在「不内置」里，现已**升级为条件内置**——工具本体内置，执行环境经 NimboExec 接口注入。安全边界仍然完全由宿主决定，只是宿主不用再自己写这个工具了。

## 6. 成功标准

这个功能算「做到位」的判据：

- **零注入可用**：宿主只给一个工作区、不写任何工具，agent 就能完整地读、写、改、删、移、搜一个代码库，跑完一次真实的代码改造。
- **默认安全**：不注入 NimboExec 时，agent 拿不到任何命令执行面（工具列表里没有 `bash`）；`bash` 出现时，本机执行默认走人工审批。
- **一行裁剪**：`builtinTools: ["read-file", "glob", "grep"]` 立刻得到一个只读 agent；`false` 全关。
- **可覆盖**：宿主放同名工具即可替换任意内置实现，其余不受影响。
- **错误可自纠 / 输出不骗人**：每个失败都带下一步指导，每次截断都有 `[truncated]` 标记，agent 靠这两条就能自己走出大部分死角。

逐工具的验收测试点（read→edit→再 edit 免重读、edit 未命中的纠错文案、目录删除的逐文件事件、截断路径全覆盖等）见技术方案的「验收要点」。

## 7. 变更记录

- **2026-07-10**：草案 v1 定稿。
- **P13-5**：工具命名统一 dash（kebab-case）格式；审批策略三值化为 [allow / review / deny](../../terms.md)。
- **P6-2**：`bash` 审批默认值补齐——执行环境未声明 `defaultApproval` 时保守兜底 `review`。
- **P2-2**：施工期语义澄清若干（二进制判定、预算硬上限、空目录也需 recursive、move 遇 reference 整体拒绝等），细节见技术方案。
