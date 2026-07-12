# nimbo 内置工具规格

> 状态：草案 v1（2026-07-10）
> 相关文档：[技术实现文档](./02-tech-spec.md) §4.5 · [施工计划](./03-construction-plan.md) P3/P4
>
> 设计前提：nimbo 默认**没有命令执行**。Claude Code / codex 的文件工具可以偷懒（删除、重命名交给 `rm`/`mv`），nimbo 不行——凡是"完成一次代码改造"必需的 FS 操作，都必须是一等工具。

## 0. 横切设计规则（先于任何单个工具）

1. **命名 snake_case**，与 eve 的"文件名即工具名"约定同风格；描述文案面向模型（写清楚何时用、何时不用、失败时怎么办）。
2. **一切文件操作经 `ctx.fs`**：工具对真实磁盘无感知；路径越界（`..`）由 FS 层拒绝，工具层不重复做安全检查。
3. **输出上限与截断标记**：每个工具都有输出预算（见各工具条目），超限必须显式标注 `[truncated: ...]` 并告诉模型如何缩小范围——静默截断会让模型误以为看到了全部。
4. **read-before-write 强制**：session 维护 `readState: Map<path, version>`，version 以 `stat().mtime`（或 FS 实现提供的版本号）为判据。`edit_file` 必须在本 session 读过该文件且当前 mtime 与读取时一致；`write_file` 覆盖已存在文件时同样要求。**bash 旁路修改（同源工作区模式）同样使 readState 失效**——mtime 变了就必须重读。违反返回可行动错误（"先 read_file 该文件"）。防止模型盲改/盲覆盖——这是 Claude Code 验证过的机制，nimbo 硬性沿用。
5. **错误即指导**：失败返回 `{ isError: true, content }`，content 必须包含下一步建议（如 edit 未命中唯一串时提示"old_string 需更长的上下文以唯一定位"）。
6. **file_change 派生**：写类工具成功后由 ToolRuntime 派生 `file_change` item（kind: add/update/delete），宿主实时可见；工具自身不负责发事件。

## 1. 必备内置（默认全开，`builtinTools` 可裁剪）

### 1.1 `read_file`

- **输入**：`{ path: string; offset?: number; limit?: number }`（offset/limit 以行计）
- **输出**：`cat -n` 风格带行号文本（行号是 edit 定位的锚）；默认最多 2000 行或 256KB，超限截断并提示用 offset/limit 分页。
- **行为**：读取后登记 `readState`。二进制文件返回**结构化指引而非裸错误**：mimeType、大小、annotations.description（宿主标注的"这是什么、该用什么工具"）；reference 条目同样返回指引（类型、描述、href），注入了 resolver 的 FS 则直读解析内容。图片作为 image block 返回给模型列为 v2（依赖 provider 能力探测）。

### 1.2 `write_file`

- **输入**：`{ path: string; content: string }`
- **行为**：整文件写入；父目录自动创建（不需要单独的 mkdir 工具）。目标已存在且未读过 → 拒绝（规则 0.4）。新文件 → `file_change: add`，覆盖 → `update`。

### 1.3 `edit_file`

- **输入**：`{ path: string; old_string: string; new_string: string; replace_all?: boolean }`
- **行为**：精确字符串替换；`old_string` 必须唯一命中（除非 `replace_all`）。未命中/多命中返回指导性错误。要求先读（规则 0.4）。
- **选型说明**：exact-string 替换优于 line-based patch 与 unified-diff apply——模型产出 diff 的行号/上下文错位率高，而唯一子串匹配失败时能给出明确纠错路径。这是 Claude Code 的 Edit 与 codex `apply_patch` 实战对比后的行业共识。

### 1.4 `delete_file`

- **输入**：`{ path: string; recursive?: boolean }`（目录需 `recursive: true`）
- **行为**：删除文件/目录 → `file_change: delete`（目录展开为逐文件 delete，宿主拿到的是精确清单）。
- **存在理由**：没有默认 bash，删除必须一等公民；OverlayFS 里体现为墓碑，真实磁盘无风险。

### 1.5 `move_file`

- **输入**：`{ from: string; to: string; overwrite?: boolean }`
- **行为**：重命名/移动；`to` 已存在且未 `overwrite` → 拒绝。事件为 `delete(from)` + `add(to)`（v1 不引入 rename kind，保持与 codex 的 changes kind 集合兼容）。
- **存在理由**：重构场景高频操作，没有 `mv` 可替代。

### 1.6 `list_dir`

- **输入**：`{ path?: string; depth?: number }`（默认根、depth 1）
- **输出**：目录树文本，行尾标注元信息——非文本文件带 mimeType、reference 条目带 `→ href` 记号、有 annotations.description 的条目附一句描述；最多 500 条目，超限提示用 glob 缩小。

### 1.7 `glob`

- **输入**：`{ pattern: string; path?: string }`
- **输出**：匹配路径列表，按路径排序（虚拟 FS 无有意义 mtime，不学 Claude Code 按修改时间排）；上限 1000 条。

### 1.8 `grep`

- **输入**：`{ pattern: string /* 正则 */; path?: string; glob?: string; mode?: "files" | "content"; context?: number; ignore_case?: boolean }`
- **输出**：`files` 模式（默认）返回命中文件清单；`content` 模式返回带行号命中行（±context）。各模式上限（100 文件 / 500 行）+ 截断提示。
- **实现**：纯 JS 正则逐文件扫描（虚拟 FS 内容本来就在内存/overlay，无需 ripgrep）。

### 1.9 `load_skill`

- **输入**：`{ name: string }`
- **输出**：该 skill 的 markdown 正文 + 附属文件清单（提示可用 read_file 读 `/.skills/<name>/...`）。
- 仅在 agent 配置了 skills 时注入；语义与 eve 一致（"loading a skill adds instructions, never a new execution surface"）。

### 1.10 `bash`（条件内置：注入 `NimboExec` 时出现）

- **输入**：`{ command: string; cwd?: string; timeout_ms?: number }`
- **输出**：stdout/stderr 合并文本（各自上限 64KB，截断标注）+ 退出码；执行中经 `onOutput` → `ctx.update()` 流式回报。
- **激活机制**：与 `load_skill` 同款条件内置——`createSession(agent, { exec })` 注入了 `NimboExec` 实现才出现在工具列表，不注入则默认安全（无命令执行面）。
- **环境自描述**：exec 实现可提供 `describe()`，拼进 bash 工具描述。**内容规格**——只给"模型试错成本高、实现零成本可知"的元信息，建议 ≤150 token：OS/架构、shell、**网络是否可达**、工作区路径与 VirtualFS 的映射关系（模式 A/B/C 中的哪种）、环境持久还是临时、关键工具链及版本（node/python/git 等与工作区相关的）。**明确不做命令枚举**：清单又长又易陈旧（agent 自行安装工具后即失效），模型对 `command not found` 一步即可自纠，`command -v` 探测是它们的固有能力——这也是 Claude Code/codex 的实际做法。`localExec` 的 `describe()` 自动生成（`os.platform()`/node 版本等）。
- **审批默认值**：取 exec 实现自声明的 `defaultApproval`——`localExec()` 出厂 `"always"`（本机执行必须把关），沙盒实现通常声明 `"never"`（隔离即边界）；注入点与 per-tool 覆盖均可。**实现未声明 `defaultApproval` 时兜底 `"always"`**（P6-2 施工回填：审批是安全机制，对未知第三方实现不做乐观假设——要放行请显式声明 `"never"`）。
- **与 VirtualFS 的一致性**（三模式，详见 tech-spec §4.5a）：A 同源工作区（`NimboFS + NimboExec` 同一实现，推荐真沙盒）；B `localExec({ materialize: true })` 物化/回收；C 完全解耦（宿主自己保证语义）。

### 1.11 `update_plan`

- **输入**：`{ items: { text: string; completed: boolean }[] }`（整表替换）
- **输出**：确认文本；同时产生 `plan_update` item（`SessionItem` 增加此类型，对应 codex 的 `todo_list`）。
- **存在理由**：多步任务的执行质量与宿主可观测性都显著受益（codex/Claude Code 均默认内置同类工具）；纯内存状态、零安全面，成本只有少量 token——不想要时 `builtinTools` 里去掉即可。

### 1.12 施工语义澄清（P2-2 回填，orchitector 验收确认）

- **read_file 的二进制判定（§1.1）**：乐观策略——mime 兜底值 `application/octet-stream`（无/未知扩展名，如 Makefile/Dockerfile/.gitignore）按**文本**处理直接展示；仅明确识别的二进制格式（`image/*`、`audio/*`、`video/*`、pdf/zip/gzip/tar/wasm/apk）返回结构化指引。v1 无内容嗅探，无法区分"未知格式"与"无扩展名文本"，乐观策略更贴合真实代码库（与 Claude Code Read 行为一致）。
- **read_file 的预算是硬上限（§1.1）**：2000 行/256KB 对单次调用恒生效，显式 `limit` 不能突破；`offset` ≥ 文件行数返回 `isError` 指导性错误。分页永远可达全量内容。
- **delete_file 空目录也需 `recursive: true`（§1.4）**："目录需 recursive"按字面对全部目录生效（工具层业务规则；底层 FS 的 `rm` 对空目录无此要求）。
- **move_file 遇 reference 条目整体拒绝（§1.5）**：`NimboFS` 接口没有复制 reference 元信息的原语（`writeReference` 是 MemoryFS 附加能力），静默跳过会造成引用丢失——目录内含 reference 时**不触碰任何文件**直接拒绝并指引逐个处理；单文件为 reference 同样拒绝。
- **`createFileTools(opts)` 接缝**：八件套经工厂构造，注入 `ReadStateStore`（get/set，version=mtime）与 `onFileChange(changes)` 回调——readState 与 file_change 派生的所有权在 session/ToolRuntime（P4），工具只消费接口形状；`FileChange.kind` 用 `add|update|delete`（tech-spec §4.2 事件面），与 virtual-fs `FileDiff.kind`（created/modified/deleted，宿主 diff 导出面）刻意分离。

## 2. 明确不内置（由宿主注入，接口已就绪）

> exec/bash 原列于此表，现已升级为条件内置（§1.10）：工具本体内置，执行环境经 `NimboExec` 接口注入——安全边界仍然完全由宿主决定，只是不用再自己写工具了。

| 能力 | 不内置的理由 | 注入方式 |
|---|---|---|
| **web_fetch / web_search** | 网络策略是宿主的合规/安全决策；且多家模型已有 server-side web 工具 | 宿主 `defineTool` 几行接自己的 fetcher/搜索栈 |
| **ask_user / 人工审批中断** | 嵌入式 SDK 无 UI；人机交互形态只有宿主知道 | 宿主注入工具对接自己的前端/IM；或用 approval 链实现"审批即交互" |
| **sub_agent / task 编排** | v2 范围（需要 session 派生语义） | — |

## 3. 与 `builtinTools` 选项的关系

```ts
type BuiltinToolName =
  | "read_file" | "write_file" | "edit_file" | "delete_file" | "move_file"
  | "list_dir" | "glob" | "grep" | "update_plan";   // load_skill 由 skills 配置隐式控制；bash 由 exec 注入隐式控制

defineAgent({ builtinTools: ["read_file", "glob", "grep"] })  // 只读 agent（代码问答/审查场景）
defineAgent({ builtinTools: false })                          // 全关，工具全由宿主注入
```

- 预设组合（纯类型层面的常量，非新机制）：`READ_ONLY_TOOLS`（read_file/list_dir/glob/grep）——只读审查场景一行开箱。
- 宿主 `tools` record 与内置同名时覆盖内置实现（如换掉 grep 接 ripgrep 真实目录版）。

## 4. 逐工具验收要点（并入 P3/P4 测试）

- read→edit→再 edit（第二次无需重读）；外部工具改文件后 edit 被拒。
- edit 未命中/多命中的错误文案含纠错指导。
- delete_file 目录递归产出逐文件 delete 事件；OverlayFS 上删除 base 层文件产生墓碑且 diff 正确。
- move_file 事件对 = delete+add，diff/writeBack 语义一致。
- 各工具截断路径全部有 `[truncated]` 标记测试。
- `builtinTools: false` 时模型请求文件工具 → 返回工具不存在错误而非崩溃。
- 未注入 exec 时工具列表无 bash；注入后 bash 出现且审批默认值来自实现的 `defaultApproval`；`onOutput` 流式片段以 `item.updated` 到达宿主；超时/非零退出码作为正常 tool 结果（非 isError 崩溃）回填模型。
