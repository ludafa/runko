# 内置工具（builtin tools）· 技术方案

> 相关：产品手册见 [features/builtin-tools.md](../features/builtin-tools.md) · 依赖 [core-sdk 技术方案](./core-sdk.md)（内置工具建在 core SDK 的 `defineTool` / `Tool` / `NimboFS` / `NimboExec` 之上）· `glob`/`grep` 的[原生搜索](../terms.md)快路径契约见 [tech/sandbox](./sandbox.md) §3/§4，拆单见 [plans/native-search](../plans/native-search.md) · 术语以 [terms.md](../terms.md) 为准。
>
> 状态：草案 v1（2026-07-10 定），随 P2/P4/P6/P7 施工回填。原始规格对应 `docs/tech/core-sdk.md` §4.5、施工计划 P3/P4。本文覆盖：横切设计规则、逐工具技术取舍、关键接口/数据结构、施工期语义澄清、已知限制、验收要点。内置工具无 DB、无必须画时序图的核心流程，故不含 erDiagram / sequenceDiagram。

## 1. 设计前提

nimbo 默认**没有命令执行**：它要能在完全没有 shell 的环境里驱动一次代码改造。因此凡是「完成一次代码改造」必需的文件系统操作都必须是一等工具，而非甩给 `rm` / `mv`。这条前提决定了 `delete-file` / `move-file` 为什么要独立成工具（见 §3.4 / §3.5），也决定了 `bash` 为什么是可选注入而非默认（见 §3.11）。

代码落点：
- 文件工具八件套：`packages/virtual-fs/src/tools/`（`createFileTools(opts)` 工厂）。
- `bash` / `load-skill` / `update-plan`：`packages/core/src/tools/builtin/`。
- 装配接线：`packages/core/src/session.ts` 的 `assembleTools`；`BuiltinToolName` / `READ_ONLY_TOOLS` 在 `packages/core/src/agent.ts`。

## 2. 横切设计规则（先于任何单个工具）

这六条对**全部**内置工具生效，是逐工具行为的公共底座。

1. **命名 kebab-case（dash 格式）**，与 eve 的「文件名即工具名」约定同风格（P13-5 起统一 dash 格式；`bash`/`glob`/`grep` 无分隔符不受影响）。描述文案**面向模型**写：讲清何时用、何时不用、失败时怎么办。
2. **一切文件操作经 `ctx.fs`**：工具对真实磁盘无感知；路径越界（`..`）由 [NimboFS](../terms.md) 层拒绝，工具层不重复做安全检查（§2 规则不与「delete 目录也要 recursive」冲突——后者是业务规则而非路径安全检查，见 §5）。
3. **输出上限与截断标记**：每个工具都有输出预算（见各工具条目与 `shared.ts` 的预算常量），超限必须显式标注 `[truncated: ...]` 并告诉模型如何缩小范围。静默截断会让模型误以为看到了全部。统一前缀由 `truncationNotice(reason, hint)` 生成，方便模型与测试都能可靠识别。
4. **read-before-write 强制**：session 维护 `readState: Map<path, version>`，version 以 `stat().mtime`（或 FS 实现提供的版本号）为判据。`edit-file` 必须在本 session 读过该文件且当前 mtime 与读取时一致；`write-file` 覆盖已存在文件时同样要求。**`bash` 旁路修改（同源工作区模式）同样使 readState 失效**——mtime 变了就必须重读。违反返回可行动错误（"先 read-file 该文件"）。这是 Claude Code 验证过的机制，nimbo 硬性沿用，防止模型盲改/盲覆盖。判定逻辑集中在 `shared.ts` 的 `checkReadBeforeWrite()`；写成功后由 `registerWrite()` 把新 mtime 登记回 readState，从而「连续编辑无需重读」成立。
5. **错误即指导**：失败返回 `{ isError: true, content }`，content 必须包含下一步建议（如 edit 未命中唯一串时提示「old_string 需更长的上下文以唯一定位」）。统一包装是 `errorResult(content)`（core 侧与 virtual-fs 侧各有一份等价实现——core 不依赖 virtual-fs，见 §6）。
6. **file_change 派生**：写类工具成功后由 ToolRuntime 派生 `file_change` item（kind: `add`/`update`/`delete`），宿主实时可见；工具自身**不负责发事件**——它只经注入的 `onFileChange(changes)` 回调把一份 `FileChange[]` 数据搬出去。
7. **纯读工具声明 `Tool.readOnly`（2026-07-16）**：`read-file`/`list-dir`/`glob`/`grep` 四个工具带 `readOnly: true`——loop 对同一 step 的一批调用**全部只读时并行结算**、混入任何写操作整批退回串行（[tech/core-sdk](./core-sdk.md) §4.1）。给工具打这个标记即承诺"不写工作区、不产生派生数据"；误标写类工具会把它送进并行批、打开写冲突口子，测试有专门断言防回归（`virtual-fs/test/tools/index.test.ts`）。

## 3. 逐工具技术设计与取舍

产品视角的输入/输出/可见行为见 [产品手册](../features/builtin-tools.md) §4；这里只记实现选型与取舍。

### 3.1 `read-file`

- **预算是硬上限**：2000 行 / 256KB 对**单次调用恒生效**，显式 `limit` 不能突破（`sliceLinesWithBudget` 里 `hardCapEnd = min(requestedEnd, start + 2000)` + 字节累加双闸）。取舍：工单未明确「显式 limit 能否突破默认预算」，按「预算是工具输出的硬上限」解读——模型总能靠加大 offset 分页拿到剩余，不需要一次性突破。`offset ≥` 文件行数返回 `isError` 指导性错误。
- **二进制判定走乐观策略**：`isTextMimeType()` 里，`mime.ts` 的兜底值 `application/octet-stream`（无/未知扩展名，如 Makefile/Dockerfile/.gitignore/.env）按**文本**处理直接展示；仅明确识别的二进制格式（`image/*`、`audio/*`、`video/*`、pdf/zip/gzip/tar/wasm/apk）返回结构化指引。取舍：v1 无内容嗅探，无法区分「未知格式」与「无扩展名文本」，乐观策略更贴合真实代码库（与 Claude Code Read 行为一致）。图片作为 image block 返回列为 v2（依赖 provider 能力探测）。

### 3.2 `write-file`

整文件写入；父目录自动创建由 FS 层保证（规则 2，工具层不重复实现）。目标已存在且未读过 → `checkReadBeforeWrite` 拒绝；目标是目录 → 拒绝并建议改路径或先 delete。新文件派生 `add`，覆盖派生 `update`。

### 3.3 `edit-file`

- **选型：exact-string 替换 > line-based patch / unified-diff apply**。模型产出 diff 的行号/上下文错位率高，而唯一子串匹配失败时能给出明确纠错路径（未命中→「补更长上下文」，多命中→「加上下文或 `replace_all`」）。这是 Claude Code 的 Edit 与 codex `apply_patch` 实战对比后的行业共识。
- `old_string === new_string` 直接拒绝（无变更）。命中计数用 `indexOf` 步进（`countOccurrences`），`replace_all` 走 `split().join()`，单次走 `replaceFirst`。

### 3.4 `delete-file`

- **存在理由**：没有默认 bash，删除必须一等公民；在 OverlayFS 里体现为墓碑，真实磁盘无风险。
- 目录删除先 `glob(dir/**)` 拿到全部文件、再 `rm(recursive)`，把结果**展开成逐文件 `delete` 清单**交给 `onFileChange`——宿主拿到的是精确到每个文件的列表，而非一条目录级事件。

### 3.5 `move-file`

- **存在理由**：重构高频操作，无 `mv` 可替代。
- **不引入 rename kind**：事件为 `delete(from)` + `add(to)`，保持与 codex 的 changes kind 集合兼容。目录移动逐文件 `readFile`→`writeFile`→登记→最后 `rm(from, recursive)`。
- **遇 reference 条目整体拒绝**：`NimboFS` 接口只有 `readFile`/`writeFile`，没有「复制一个 reference 条目元信息」的通用原语（`writeReference` 是 `MemoryFS` 的附加能力，不在接口里，工具不能依赖具体实现）。若不做前置检查，目录移动会先搬普通文件、再 `rm(recursive)` 把还没搬走的 reference 一并删掉，造成静默数据丢失。因此目录内含 reference 时**不触碰任何文件**直接拒绝并指引逐个处理；单文件为 reference 同样拒绝。还额外挡了「移动目录到自身子树」。

### 3.6 `list-dir`

递归 `walk` 到 `depth`，行尾 `buildMetaSuffix` 拼元信息（reference `→ href [mime]`、非文本文件 `[mime]`、`annotations.description`）。500 条目上限用 `WalkState.count` 累计、命中即 `truncated` 早停。

### 3.7 `glob`

- **双路径自适应**（[原生搜索](../terms.md)）：`ctx.fs.searchFiles` 存在时优先一次调用，交给底座在内部（典型如远端沙盒里跑一条脚本）一次性完成整个文件名扫描；未实现该方法、或调用时抛 `SearchUnsupportedError`，静默回退下面的 JS 扫描路径——两条路径统一归一成 `FileSearchResult` 中间形态，喂给同一个格式化函数，保证两种底座输出逐字符一致。
- **JS 回退路径**：`fs.glob(pattern)` 拿候选集，本地按 ignore 过滤 + 排序 + 源头截断。**按路径排序，不按 mtime**：虚拟 FS 无有意义的 mtime，因此不学 Claude Code 的「按修改时间排」。上限 1000。`joinGlobPattern(base, pattern)` 把 scope 路径与相对 pattern 拼成单个绝对模式。只匹配文件、不匹配目录。
- **默认忽略 `.git`/`node_modules`**（`DEFAULT_SEARCH_IGNORE`，`shared.ts`）：ancestor-or-self 语义同 `DirFS` 的 `ignorePatterns`（命中路径本身或任一祖先目录即整棵子树跳过），两条路径（native 适配器 / JS 回退）应用同一份忽略集合。`path` 若显式指向某个默认忽略目录本身或其内部，对应默认项自动放行（`resolveDefaultIgnore`）——模型可以显式搜进 `.git`。

### 3.8 `grep`

- **双路径自适应**（[原生搜索](../terms.md)）：`ctx.fs.searchContent` 存在时优先一次调用，交给底座在内部一次性完成整个正则内容扫描；未实现该方法、或调用时抛 `SearchUnsupportedError`，静默回退下面的 JS 扫描路径——两条路径统一归一成 `ContentSearchResult` 中间形态，喂给同一个格式化函数，保证两种底座输出逐字符一致。
- **JS 回退路径：纯 JS 正则逐文件扫描**：虚拟 FS 内容本来就在内存/overlay 里，无需 ripgrep。用 `new RegExp(pattern, ignore_case ? "i" : "")`——**JavaScript 正则语义**（非 POSIX/PCRE），非法正则返回带提示错误；两条路径共用同一个正则引擎，语义不因走哪条路径而漂移。候选集经 `glob(scopePattern)` 得到并排序；`readTextOrSkip` 跳过目录/reference/二进制文件。`files` 模式 100 文件上限；`content` 模式 `collectFileMatches` 按 ±context 收集行，输出 `path:line:text`（命中）/ `path-line-text`（上下文），100 文件 / 500 行双闸，哪个先到先截。
- **默认忽略 `.git`/`node_modules`**：同 §3.7；`path` 显式指入可覆盖。

### 3.9 `load-skill`（条件内置）

- 只返回文本，**不触发任何副作用**——"loading a skill adds instructions, never a new execution surface"（eve 原话）。返回 skill 的 markdown + 附属文件清单（提示用 `read-file` 读 `/.skills/<name>/...`，路径由 `skillMountPath` 生成）。
- 条件：仅在 `agent.skills` 非空时装配（见 §4）。名字查不到时返回 `errorResult`，列出可用 skill 名。

### 3.10 `update-plan`（可裁剪内置）

- 整表替换：`store.setItems(items)` + `onPlanUpdate(items)` 派生 `plan_update` item（对应 codex 的 `todo_list`）。纯内存状态、零安全面。
- 存储经注入（`PlanStore` 接口 get/set + 便利内存实现 `createPlanStore()`），真正的跨轮生命周期归属留给 session（P4）。

### 3.11 `bash`（条件内置，注入 NimboExec 时出现）

- **激活机制**：`createSession(agent, { exec })`（或 `{ workspace }` 语法糖）注入了 `NimboExec` 才在工具列表出现——与 `load-skill` 同族的「条件内置」机制，控制条件各自独立（`assembleTools` 里 `exec !== undefined` 的分支）。不注入则默认安全，无命令执行面。
- **输出**：stdout/stderr 合并 + 退出码。各路 64KB 上限，`truncateToBytes` 按**字符边界**累加编码字节数截断（不在多字节 UTF-8 中间切断），超限标 `[truncated: ...]`。执行中经 `onOutput` → `ctx.update()` 流式回报。
- **失败即正常结果**：`NimboExec.exec()` 契约要求所有「正常失败」（解析错误/未知命令/超时/abort/命令级错误）以 **resolve 的 `ExecResult`**（非零 `exitCode` + stderr）返回而非 reject——因此工具对非零退出码/超时不做 try/catch，原样格式化回模型，`status` 仍是 completed。但 `NimboExec` 是宿主可自实现的接口（模式 C），第三方实现可能违约 reject——故仍兜底 catch，转成 `{ isError: true, content }` 结构化结果（说明「这是注入实现的 bug、重试同命令无用」），而不是让裸 throw 冒泡到通用 catch 产出无诊断上下文的泛化文案。
- **环境自描述**：`exec.describe?.()` 拼进工具描述（`buildDescription`）。**内容规格**——只给「模型试错成本高、实现零成本可知」的元信息，建议 ≤150 token：OS/架构、shell、**网络是否可达**、工作区路径与 VirtualFS 的映射关系（模式 A/B/C 中的哪种）、环境持久还是临时、关键工具链及版本（node/python/git 等）。**明确不做命令枚举**：清单又长又易陈旧（agent 自装工具后即失效），模型对 `command not found` 一步即可自纠，`command -v` 探测是其固有能力——这也是 Claude Code/codex 的实际做法。`localExec` 的 `describe()` 自动生成（`os.platform()`/node 版本等）。
- **审批默认值**：`approval: exec.defaultApproval ?? "review"`。`localExec()` 出厂 `review`（本机执行必须把关），沙盒实现通常声明 `allow`（隔离即边界）；注入点与 per-tool 覆盖均可。**实现未声明 `defaultApproval` 时保守兜底 `review`**（P6-2 回填：审批是安全机制，对未知第三方实现不做乐观假设——要放行请显式声明 `allow`。一个没声明的第三方 `NimboExec` 更可能是简单包装、未必经过安全考量）。审批策略枚举 P13-5 已三值化 [allow/review/deny](../terms.md)，见 [tech/single-ledger](../tech/single-ledger.md)。
- **与 VirtualFS 的一致性（三模式，详见 tech-spec §4.5a）**：
  - **A 同源工作区**：`NimboFS + NimboExec` 同一实现（推荐真沙盒）。bash 写的文件对文件工具立即可见，但 bash 改动不产生 `file_change`、编辑前需重读（mtime 变）。
  - **B `localExec({ materialize: true })`**：物化/回收。
  - **C 完全解耦**：宿主自己保证语义。

## 4. 工具装配（`assembleTools`）

`packages/core/src/session.ts` 的 `assembleTools(agent, planStore, derivedData, exec)` 决定最终工具列表。展开顺序是**内置在前、`agent.tools` 在后**，因此宿主同名工具**覆盖**内置实现（规则见 [产品手册](../features/builtin-tools.md) §3.3）：

```ts
return { ...builtins, ...(agent.tools ?? {}) };
```

各内置的出现条件：

| 工具 | 出现条件 | 判定 |
|---|---|---|
| `update-plan` | `builtinTools` 未关且未从数组剔除 | `isUpdatePlanEnabled`：`false`→关；`undefined`→开；数组→按成员判断 |
| `load-skill` | `agent.skills` 非空 | `isLoadSkillEnabled` |
| `bash` | 注入了 `NimboExec` | `exec !== undefined` |
| 文件八件套 | 见下（P7 接缝） | — |

> **文件八件套的装配是 P7 接缝**：core 当前的 `assembleTools` 只接线 `update-plan`/`load-skill`/`bash`；文件工具由 `@nimbo/virtual-fs` 的 `createFileTools(opts)` 工厂构造、在 P7 接入 session。产品契约（`builtinTools` 裁剪哪些文件工具）已定义在 `BuiltinToolName` 里，运行层接线随 P7 落地。

`NimboFS`/`NimboExec`/`workspace` 三者的求解在 `resolveExecutionSurfaces`：`workspace` 与 `fs`/`exec` **互斥**（同时给抛配置错误）；`fs = opts.fs ?? opts.workspace ?? createUnconfiguredFS()`，`exec = opts.exec ?? opts.workspace`。

## 5. 关键接口与数据结构

### 5.1 `BuiltinToolName` / `READ_ONLY_TOOLS`（`agent.ts`）

```ts
type BuiltinToolName =
  | "read-file" | "write-file" | "edit-file" | "delete-file" | "move-file"
  | "list-dir" | "glob" | "grep" | "update-plan";
// load-skill 由 skills 配置隐式控制；bash 由 exec 注入隐式控制——二者不在此联合里。

const READ_ONLY_TOOLS = ["read-file", "list-dir", "glob", "grep"] as const;

builtinTools?: BuiltinToolName[] | false;   // AgentDefinition 字段：默认全开，false 全关
```

`READ_ONLY_TOOLS` 是纯类型层面的常量、非新机制。

### 5.2 文件工具工厂接缝（`virtual-fs/src/tools/shared.ts`）

八件套经 `createFileTools(opts)` 构造，注入两个最小接口——readState 与 file_change 派生「真正应该」归属 session/ToolRuntime（tech-spec §4.2/§4.5），P2 阶段 core 运行层还不存在，故先收窄成本包自定义接口从外部注入，P7 落地时可零改动替换成真正的 session 状态：

```ts
interface ReadStateStore {                    // session 范围「路径 → 上次读取版本」；version = stat().mtime
  get(path: string): number | undefined;
  set(path: string, version: number): void;
}
interface FileChange { path: string; kind: "add" | "update" | "delete"; }
interface CreateFileToolsOptions {
  readState: ReadStateStore;
  onFileChange?: (changes: FileChange[]) => void;   // 普通回调、非事件总线；工具不发 SessionEvent
}
```

`FileChange.kind` 用 `add|update|delete`（tech-spec §4.2 `SessionItem` 的 `file_change` 事件面），与 virtual-fs `diff.ts` 的 `FileDiff.kind`（`created`/`modified`/`deleted`，`diff()`/`writeBack()` 的宿主导出面）**刻意分离**——两者语义相邻但服务不同消费者。

### 5.3 `PlanStore`（`update-plan.ts`）

```ts
interface PlanItem { text: string; completed: boolean; }
interface PlanStore { getItems(): PlanItem[]; setItems(items: PlanItem[]): void; }
function createPlanStore(): PlanStore;                    // 便利内存实现
// CreateUpdatePlanToolOptions: { store; onPlanUpdate?(items) }
```

### 5.4 `bash` 依赖的 core 类型

`CreateBashToolOptions { exec: NimboExec }`；`exec.exec(input, { onOutput })` 返回 `ExecResult`（`{ stdout, stderr, exitCode }`）；`approval: ApprovalPolicy`（三值 [allow/review/deny](../terms.md)）；`ToolErrorResult { isError: true; content: string; [k]: JsonValue }`。

## 6. 施工期语义澄清（P2-2 回填，orchitector 验收确认）

- **read-file 二进制判定（§3.1）**：乐观策略——mime 兜底值 `application/octet-stream` 按**文本**处理；仅明确识别的二进制格式返回结构化指引。v1 无内容嗅探，无法区分「未知格式」与「无扩展名文本」，乐观策略更贴合真实代码库。
- **read-file 预算是硬上限（§3.1）**：2000 行/256KB 对单次调用恒生效，显式 `limit` 不能突破；`offset ≥` 文件行数返回 `isError`。分页永远可达全量。
- **delete-file 空目录也需 `recursive: true`（§3.4）**：「目录需 recursive」按字面对**全部**目录生效（工具层业务规则；底层 FS 的 `rm` 对空目录无此要求）。与规则 2「不重复做路径安全检查」不冲突——这是业务规则，不是路径安全检查。
- **move-file 遇 reference 条目整体拒绝（§3.5）**：`NimboFS` 接口没有复制 reference 元信息的原语，静默跳过会造成引用丢失——目录内含 reference 时不触碰任何文件直接拒绝；单文件为 reference 同样拒绝。
- **`createFileTools(opts)` 接缝（§5.2）**：八件套经工厂构造，注入 `ReadStateStore` 与 `onFileChange`——readState 与 file_change 派生的所有权在 session/ToolRuntime（P4/P7），工具只消费接口形状。
- **core 侧不依赖 virtual-fs**：`bash`/`load-skill` 各自独立定义 `ToolErrorResult`/`errorResult`，不从 virtual-fs 导入（core→virtual-fs 是被禁止的反向依赖）。索引签名 `[k: string]: JsonValue` 需显式声明，否则具名 interface 落不进 `ToolReturn` 的 `JsonValue` 对象分支（tsc 报 "Index signature is missing"）。

## 7. 已知限制

- **文件工具尚未接入 core session**：`createFileTools` 已就绪，但 `assembleTools` 接线是 P7 未落地项（§4）。
- **图片仅结构化指引、不回传 image block**：v2 才做，依赖 provider 能力探测（§3.1）。
- **grep 用 JS 正则**：不支持 POSIX/PCRE 独有语法——两条路径（[原生搜索](../terms.md)适配器 / JS 回退）共用同一个 JavaScript RegExp 引擎，语义不因走哪条路径而漂移。**扫描性能**：`grep`/`glob` 优先经 `ctx.fs.searchContent`/`searchFiles` 一次调用完成整个扫描，只有实现了该接缝的底座（如远端沙盒适配器）受益；其余仍是纯 JS 逐文件扫描，超大工作区无 ripgrep 级别性能（本地/虚拟 FS 场景足够）。
- **move-file 不支持含 reference 的目录**：整体拒绝而非部分迁移（§3.5）。
- **`sub_agent` / task 编排不内置**：v2 范围（需 session 派生语义）。

## 8. 验收要点（并入 P3/P4/P7 测试）

> 施工/测试视角。内置工具没有独立的施工计划文档，这些点随对应工单并入全局施工计划 P3/P4/P7 的测试。

- read→edit→再 edit（第二次无需重读）；外部工具改文件后 edit 被拒。
- edit 未命中/多命中的错误文案含纠错指导。
- delete-file 目录递归产出逐文件 delete 事件；OverlayFS 上删除 base 层文件产生墓碑且 diff 正确。
- move-file 事件对 = delete+add，diff/writeBack 语义一致；含 reference 的目录被整体拒绝。
- 各工具截断路径全部有 `[truncated]` 标记测试。
- `builtinTools: false` 时模型请求文件工具 → 返回工具不存在错误而非崩溃。
- 未注入 exec 时工具列表无 bash；注入后 bash 出现且审批默认值来自实现的 `defaultApproval`（未声明兜底 `review`）；`onOutput` 流式片段以 `item.updated` 到达宿主；超时/非零退出码作为正常 tool 结果（非 isError 崩溃）回填模型；实现违约 reject 时兜底为结构化 isError。

## 9. 变更记录

- **2026-07-10**：草案 v1。
- **P13-5**：工具命名统一 dash 格式；审批策略三值化 [allow/review/deny](../terms.md)（见 [tech/single-ledger](../tech/single-ledger.md)）。
- **P2-2**：施工期语义澄清（§6），orchitector 验收确认。
- **P6-2**：`bash` 审批默认值兜底补齐为 `review`（§3.11）。
- **P4/P7**：readState / file_change / 文件工具装配所有权归 session/ToolRuntime——接缝已在 `createFileTools` 与 `assembleTools` 留出，运行层随施工落地。
- **2026-07-16**：`glob`/`grep`（§3.7/§3.8）补充双路径自适应设计——[原生搜索](../terms.md)接缝（`NimboFS.searchFiles?`/`searchContent?`）可用时优先一次调用，落空回退现有 JS 扫描；两条路径默认忽略 `.git`/`node_modules`。契约与逐接口映射见 [tech/sandbox](./sandbox.md) §3/§4，拆单见 [plans/native-search](../plans/native-search.md)。
