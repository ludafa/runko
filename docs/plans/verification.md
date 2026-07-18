# verification — 施工与验收

> 相关：verification 在新结构里只有**施工视角**（本文件）——它不是用户可见的产品能力、也不是一份架构设计，而是「如何端到端证明 nimbo 功能正确」的验收工程，天然只落在 plans。
> 依赖 [core-sdk](../features/core-sdk.md)：本方案逐条映射 core-sdk 的四条成功标准（成功标准原文见 docs/features/core-sdk.md §6，新结构归入 features/core-sdk.md；见 §2），并作为 [core-sdk 施工](../plans/core-sdk.md) 的验收闭环。
> 历史来源：docs/plans/verification.md（旧编号，收口阶段统一清理）。

> 状态：**已执行，全部通过**（2026-07-11 P8-2 由 orchitector 亲自执行并回填，方案部分为 P8-1 产出；2026-07-12 P10-4 补充 09–11 三云沙盒适配器用例——离线部分本工单执行；真机部分中，用户在本工单执行期间往 `examples/.env` 追加了真实 E2B_API_KEY/VERCEL_*，09/10 因此意外触发并验证通过真实云沙盒 + 真实 DeepSeek 调用；11 仍待用户部署网关后回填，见 §3.1/§5）
> 相关文档（收口后新结构）：[features/core-sdk](../features/core-sdk.md)（§6 成功标准为本方案的验收基准）· [tech/core-sdk](../tech/core-sdk.md) · [plans/core-sdk](../plans/core-sdk.md) P8/P10 · [examples/README.md](../../examples/README.md)

本文档回答一个问题：**如何端到端证明 nimbo 的功能正确**。分四部分：运行/部署步骤（§1）、逐条映射产品文档 §6 成功标准的用例表（§2）、examples 运行矩阵（§3）、回归命令清单（§4）。§2/§3 的“实际结果”列在执行验证时逐格回填（通过 ✅ / 失败 ❌ + 简述），当前均已回填。

> 术语说明：本文频繁出现两组示例内部结构词——**确定性段**（示例中不依赖模型/网络、零 key 即可确定性跑通的那一段：打印 schema、直调 `exec`/`fs` 等）与**模型驱动段**（需真实模型、可能还需云凭证才运行、验证 [agent](../terms.md) 端到端行为的那一段）；以及 **gate（配置闸门）**——示例在发起任何模型调用/网络请求之前按序检查所需环境变量/凭证，任一未配置就打印指引并干净退出/返回（`exit 0`）、不产生任何副作用。这三个词 terms.md 暂未收录，已在迁移返回里 flag，待收口统一定夺。

## 1. 运行/部署步骤

### 1.1 环境要求

| 项 | 要求 | 说明 |
|---|---|---|
| Node.js | ≥ 20；**examples 与 L3 `tools/*.ts` 动态加载需 ≥ 22.18**（原生 TS type stripping） | 本仓开发环境 Node 24 |
| pnpm | 经 corepack（根 `packageManager` 钉死 `pnpm@10.18.0`） | 全部命令用 `corepack pnpm` 前缀 |
| 模型访问 | 模型驱动用例需 `NIMBO_MODEL` + `AI_GATEWAY_API_KEY`（或改 `examples/shared/model.ts` 直连 provider） | 纯机制用例（单测 + examples 确定性段）零网络零 key |

### 1.2 从干净 checkout 到可验证状态

```sh
git clone <repo> && cd nimbo
corepack pnpm install --frozen-lockfile
corepack pnpm build          # 必须先于 typecheck/test：跨包类型解析指向 dist（docs/plans/core-sdk.md P4-2 顺序结论）
corepack pnpm typecheck
corepack pnpm test
corepack pnpm coverage       # 门槛 lines ≥ 90%

# examples 一次性准备（examples/ 不是 workspace 成员，见 examples/README.md）：
node examples/setup-node-modules.mjs
node examples/typecheck.mjs
```

### 1.3 模型驱动用例的环境配置

```sh
export NIMBO_MODEL="anthropic/claude-sonnet-5"    # 任意 AI SDK Gateway model id
export AI_GATEWAY_API_KEY="..."                   # https://vercel.com/ai-gateway
```

无部署环节——nimbo 是库不是服务；“部署”即宿主 `pnpm add @nimbo/sdk ai`（发布前用 workspace 内 examples 的符号链接布局等价模拟，见 examples/README.md“为什么 examples/ 不是 workspace 包”）。

## 2. 成功标准用例表（docs/features/core-sdk.md §6 逐条映射，无遗漏）

§6 共四条成功标准，每条至少一个用例；用例 ID 前缀即标准序号。四条标准即 core-sdk 的验收基准（见开头“相关”行的 [core-sdk](../features/core-sdk.md) 链接）。

### 标准 1 ·「5 行代码跑通第一个例子；README 示例全部可复制运行」

| 用例 | 步骤 | 预期结果 | 实际结果 |
|---|---|---|---|
| 1-1 五行示例真实跑通 | 配置 §1.3 env；把根 README“5 行上手”代码块原样复制为 `/tmp/five-line.ts`（目录换成任一含 `src/index.ts` 且其中有 `var` 的样例项目），在 examples/ 的解析环境下 `node` 执行 | 正常结束；`finalResponse` 为完成描述；`diff()` 返回含该文件 `kind: "modified"` 的数组；真实目录文件未被改动 | ✅ DeepSeek 真实执行：diff 报 `modified`（两行 var→const，patch 完整）；真实目录逐字节未变；偏差仅 import 源与 model（同 1-2 的两处允许项） |
| 1-2 五行示例逐行对照（自动化） | `corepack pnpm -F @nimbo/sdk test`（`packages/sdk/test/five-line-example.test.ts`，mock 模型） | 用例绿：仅 import 源与 model 两处允许偏差，其余逐行一致；`session.fs.diff()` 无断言编译 | ✅ 含于全仓 697 用例 |
| 1-3 README 代码块全部可编译 | 提取根 README 与四包 README 的全部 ts 代码块为独立文件，放入 examples/ 同款解析环境，`tsc --noEmit` | 全部编译通过，零 error | ✅ 共提取 6 个 ts 代码块，独立 tsconfig（nodenext/strict）编译零 error |
| 1-4 examples 全部类型检查通过 | `node examples/typecheck.mjs` | exit 0 | ✅ exit 0 |

### 标准 2 ·「上传代码片段 → agent 修改 → 返回 diff 的端到端 demo 不写任何临时文件」

| 用例 | 步骤 | 预期结果 | 实际结果 |
|---|---|---|---|
| 2-1 纯内存端到端（真实模型） | 配置 env 后 `node examples/01-memory-diff.ts`；执行期间用 `fs_usage`/`lsof`（或简化为：核查脚本与依赖链均只用 `NimboFS.fromMemory`）确认无临时文件写入 | 模型驱动段完成：diff 报出对 `src/index.ts` 的 `modified`（var→const）；进程全程未在磁盘创建任何文件 | ✅ DeepSeek 真实执行完成（走简化核查路径：脚本与依赖链仅 `fromMemory`，无任何真实路径写面）；注：01 用 MemoryFS，diff 语义按 §4.4 报 `created`（空基线），var→const 的结果内容在 `after` 中可见——`modified` 语义由 1-1（OverlayFS）覆盖 |
| 2-2 overlay 不落盘（机制层，零模型） | 移开 `examples/.env` 后 `node examples/02-dir-mount.ts` 的确定性段 | overlay 写入后真实磁盘文件内容不变；`diff()` 报 pending 变更；仅 `writeBack()` 后落盘 | ✅ 确定性段（缺配置矩阵）+ 配 env 全程（writeBack 后真实磁盘内容变为 `const x = 1;`）双路径实测 |
| 2-3 file_change 实时流出 | `corepack pnpm -F @nimbo/core test`（P4-2/P6-2 集成用例：write_file → `file_change` item） | 写类工具成功后宿主经 `stream()` 收到 `file_change` item（kind: add/update/delete） | ✅ 含于全仓 697 用例；07 示例的确定性段亦实时打印了 `file_change` item |

### 标准 3 ·「现成的 Claude [skill](../terms.md) 目录不改动即可被 nimbo 加载并生效」

| 用例 | 步骤 | 预期结果 | 实际结果 |
|---|---|---|---|
| 3-1 双形态 fixture 不改动加载（自动化） | `corepack pnpm -F @nimbo/core test`（P5-1 用例：`test/fixtures/skills/` 的 packaged `pdf-fill`（SKILL.md + 附属文件）与 flat `commit-helper.md` 原样加载） | 两 fixture 零改动加载成功；packaged 缺 `description` frontmatter 时报错、flat 首行推导 description | ✅ 含于全仓 697 用例 |
| 3-2 真实官方 skill 目录 | 取一个 Anthropic 官方 skills 仓库的 skill 目录（如 anthropics/skills 任一子目录），不做任何修改，`Skill.fromDirectory(path)` 后配进 `defineAgent({ skills })` 并 `createSession` | 加载成功；`<available_skills>` 含其 name/description；（配 env 时）模型可经 `load_skill` 取到 markdown 正文，附属文件挂载于 `/.skills/<name>/` 可被 read_file 读取 | ✅ `anthropics/skills` 浅克隆的 `skills/xlsx`（53 个附属文件）零改动加载：name/description 正确、`<available_skills>` 出现在发给模型的 system prompt、`/.skills/xlsx/` 挂载可 readdir |
| 3-3 skills 端到端（examples） | 配置 env 后 `node examples/03-skills.ts` | 模型驱动段：`tool_call` items 中出现 `load_skill` 调用且 turn 正常完成（渐进式披露路径走通） | ✅ DeepSeek 真实执行：`load_skill({ name: "commit-style" })` tool_call `completed`，返回 skill markdown 正文，turn 正常收尾 |

### 标准 4 ·「换掉命令执行工具的实现（本地→自定义）不需要改任何 [loop](../terms.md) 相关代码」

| 用例 | 步骤 | 预期结果 | 实际结果 |
|---|---|---|---|
| 4-1 自定义 NimboExec 注入（examples） | `node examples/05-custom-exec.ts`（确定性段零 env；配 env 跑模型驱动段） | 手写 `NimboExec`（whitelist stub）仅经 `createSession({ exec })` 注入即生效——示例代码不含任何 loop/工具装配改动；未知命令 exit 127、`defaultApproval` 生效 | ✅ 双路径实测：确定性段 0/127 两种 ExecResult；DeepSeek 真实段 agent 经 bash 跑 `pwd`（tool_call completed） |
| 4-2 三种实现互换零 loop 改动 | 对同一 agent 定义，分别以 `exec: miniBash(fs)` / `exec: localExec()` / `exec: stubSandboxExec()` 创建 [session](../terms.md)（参照 examples 04/05 与 core 的 `exec/local.ts`） | 三者只改 `createSession` 的 `exec` 实参一处；bash 工具描述随各自 `describe()` 变化、审批默认值随 `defaultApproval` 变化；loop/session/工具代码零修改 | ✅ examples 04（miniBash）与 05（自定义 stub）对同构 agent 仅 `exec` 实参不同且均真实跑通；localExec 的 describe()/defaultApproval/双模式由 core `test/exec/local.test.ts`（含于 697 用例）覆盖——三实现互换零 loop 改动成立 |
| 4-3 条件激活与审批链（自动化） | `corepack pnpm -F @nimbo/core test`（P6-2 用例） | 未注入 exec 时工具列表无 bash；注入后出现且审批默认值来自实现声明（未声明兜底 `"always"`）；非零退出码作为正常 tool 结果回填 | ✅ 含于全仓 697 用例 |
| 4-4 全语法档 bash 换挡（examples，P9-2 新增） | `node examples/08-just-bash.ts`（确定性段零 env；配 env 跑模型驱动段） | 确定性段：`justBash(fromMemory({...}))` 直调跑通一段含 `if`/`for`/函数（`local`）/重定向（`>>`）的真实脚本，打印的 `ExecResult.exitCode` 为 0 且 `stdout` 与脚本逻辑一致；`onOutput` 全程仅触发 1 次（非流式契约，§4.5b）。模型驱动段：`createSession({ fs, exec: justBash(fs) })` 与 04（`exec: miniBash(fs)`）相比仅 `exec` 实参不同，agent 经 `bash` 工具完成一个需要 `for` 循环的任务（mini-bash 六命令语法面表达不了）；loop/session/工具装配代码零改动 | ✅（2026-07-11 orchitector 亲测）确定性段：脚本 exit 0、stdout 与逻辑一致（`flagged: 1`）、onOutput 恰 1 次、describe() 如实声明非流式/无 symlink/无网络/cwd 持久；模型段：DeepSeek 真实产出 for+if+算术扩展脚本经 bash 工具执行，统计 3 个 .txt 文件，tool_call completed——mini-bash 语法面确实表达不了该脚本，换挡仅一处实参 |
| 4-5 三云沙盒 workspace 换挡（examples，P10-4 新增） | `node examples/09-sandbox-e2b.ts` / `10-sandbox-vercel.ts` / `11-sandbox-cloudflare.ts`（确定性段零凭证；真机段需模型 + 对应云厂商凭证） | 三者与 04/08 同一族“只换 `exec`/`workspace` 实参”故事的云沙盒版本：`createSession({ workspace })` 里的 [工作区](../terms.md) `workspace` 分别替换成 `e2bWorkspace(sandbox)`/`vercelWorkspace(sandbox)`/`cloudflareWorkspace(opts)`，loop/session/工具装配代码零改动；确定性段各自用一个几十行的进程内 fake（实现对应 `*SandboxLike` 结构接口）证明“[BYO 实例](../terms.md) + 结构化接口”不需要真实网络即可跑通 `describe()`/一次 `exec()`/一次文件读写；11 号额外演示 client→网关→fake 沙盒的完整协议在同一进程内往返 | ✅ 确定性段三者均实测通过（见 §3.1）。真机段：09（E2B）/10（Vercel）在本工单执行期间用户往 `examples/.env` 追加了真实凭证，两者均**真实**创建云沙盒、真实驱动 DeepSeek 完成“写文件 + bash cat 验证”任务、`finalResponse` 内容与写入一致，`sandbox.kill()`/`sandbox.stop()` 正常收尾（见 §3.1 状态 C）；11（Cloudflare）需要先部署网关，仍待用户凭证回填 |
| 4-6 真实项目端到端：设计优化 + 完整 Git 工作流（examples/12，P11 新增） | `node examples/12-vercel-sandbox-real-project.e2e.test.ts`（确定性段零凭证；真机段需 DeepSeek + `GITHUB_REPO`/`GITHUB_PAT` + 三个 `VERCEL_*`，四项按序 gate） | 04/08/09/10/11 同一族“只换 workspace/exec 实参”故事的终局形态：`createSession({ workspace: vercelWorkspace(sandbox) })` 之上，agent 自主完成 `load_skill(frontend-design)` → 通读代码 → 一次聚焦的设计优化 → 构建验证 → `git checkout -b`/commit/push → `curl` 开 PR，全程 loop/session/工具装配代码零改动；`finalResponse` 须含改动清单+设计意图、分支名、PR `html_url` | ✅ 确定性段（URL 规范化自测 + 初始化命令清单打印 + `Skill.fromFS` 对 fake 沙盒装载）本工单实测通过（见 §3.2）。真机段：**本工单原计划应停在 `GITHUB_REPO` 缺失的指引（本工单开工时 `examples/.env` 只有 DeepSeek + Vercel Sandbox 三变量），但执行期间用户往 `examples/.env` 追加了真实 `GITHUB_REPO`/`GITHUB_PAT`**（本工单全程未触碰该文件），复测因此直接进入四项 gate 全部通过的真机路径：真实创建 Vercel Sandbox（`ludafa/Schulte-Grid`，`runtime: node24`/`persistent: false`），host 侧六步初始化全部成功（`npx skills` 主路径装出 `frontend-design`，未触发 git-clone fallback；默认分支探测为 `main`），`Skill.fromFS` 装载沙盒里的真实官方 skill，DeepSeek（`deepseek-v4-pro`）驱动 agent 读代码 → 决定并执行一处聚焦的视觉设计优化（网格单元格去阴影改描边、主色系粉→冷蓝青、计时器 `tabular-nums`）→ `next build` 通过 → `git checkout -b nimbo/design-2026-07-12T03-18-01-631Z` → commit → push → `curl` 建 PR 成功；`finalResponse` 含改动清单+设计意图/分支名/PR 链接三项俱全；`sandbox.stop()` 正常收尾（`Sandbox.list()` 复核状态为 `stopped`、`persistent:false`，无残留）。PR 已用 GitHub API 独立核实真实存在：`https://github.com/ludafa/Schulte-Grid/pull/2`，`state: open`，`head: nimbo/design-2026-07-12T03-18-01-631Z`，`base: main`——**这是一个真实的、留在用户仓库里待人工 review 的 PR，本工单未合并/关闭它**。未额外用一次干净的 `.env`（即 `GITHUB_REPO`/`GITHUB_PAT` 仍缺失）重新验证“停在该 gate”的路径——重新验证需要改动 `.env`，与硬性约束冲突；该分支就是一条简单的“读 env→为空则打印指引并 `return`”早退逻辑，与 09/10/11 已反复验证过的同构 gate 代码路径一致，且本次真机运行本身已经证明了它之前的三个 gate（DeepSeek/`GITHUB_REPO`/`GITHUB_PAT`）分支在其“已配置”一侧被正确执行到底（未在任何一个提前 return） |

## 3. examples 运行矩阵

每个示例 × 两种环境状态，共 16 格。“缺 env”一行验证干净退出路径（P8-1 验收项）。“配 env”二选一（examples/README.md“运行方式”）：DeepSeek 直连（`examples/.env` 的 `DEEPSEEK_API_BASE_URL`/`DEEPSEEK_API_TOKEN`，P8-1c）或 AI SDK Gateway（`NIMBO_MODEL`+`AI_GATEWAY_API_KEY`）——`shared/model.ts` 的 `resolveModel()` 按此顺序尝试，任一配好即视为“配 env”。

| 示例 | 缺 env（两条路径都未配置）：预期 | 实际 | 配 env：预期 | 实际 |
|---|---|---|---|---|
| 01-memory-diff | 确定性段打印 created diff；打印指引后 **exit 0** | ✅ | 模型改 var→const，diff 报 modified（MemoryFS 空基线语义下为 created，after 含 const 结果） | ✅ |
| 02-dir-mount | overlay 写不落盘 + diff 演示；指引后 exit 0 | ✅ | agent 改文件 → diff → writeBack 落盘 | ✅（writeBack 后真实磁盘为 `const x = 1;`） |
| 03-skills | 打印 skills 清单与 `<available_skills>` 块；指引后 exit 0 | ✅ | agent 调 load_skill 后作答 | ✅（load_skill tool_call completed） |
| 04-mini-bash | 直调 miniBash：cat / 管道 / `&&`/`\|\|` 输出；指引后 exit 0 | ✅ | agent write_file 后经 bash 数行数（同源可见） | ✅（`cat \| grep -c` 返回 3 行） |
| 05-custom-exec | 直调自定义 exec：0 与 127 两种 ExecResult；指引后 exit 0 | ✅ | agent 经 bash 工具跑 whitelist 命令 | ✅（pwd → /workspace，exit 0） |
| 06-structured-output | 打印 JSON Schema 与手写合法样例；指引后 exit 0 | ✅ | `structuredOutput` 为通过 zod 校验的类型化对象 | ✅（类型化对象输出；**兼容回退路径被真实命中**——DeepSeek 无原生 JSON schema，AI SDK warning 显示 schema 注入 system message，正是 §4.8 设计的 provider 回退场景） |
| 07-streaming | 对脚本化 MockLanguageModelV4 走完整 `createSession`+`stream()` 链路，实时打印带类型标注的事件时间线（含 `item.updated` 文本增量、`tool_call` in_progress→completed、`turn.completed` usage）；指引后 exit 0 | ✅（时间线含 started/completed、tool_call 流转、file_change、usage） | 同一 `stream()`+手动 `.next()` 驱动循环对真实模型跑，终端可见打字机式增量输出与真实 `tool_call` 事件 | ✅（真实 tool_call：list_dir 等；打字机增量可见） |
| 08-just-bash（P9-2 新增） | 直调 `justBash`：if/for/函数（local）/重定向脚本，`ExecResult.exitCode === 0`；`onOutput` 仅 1 次（非流式）；指引后 exit 0 | ✅ | agent 经 bash 工具写一段 `for` 循环脚本统计目录下 `.txt` 文件数（mini-bash 语法面表达不了的任务） | ✅（统计结果 3 个，tool_call completed） |

> ⚠️ **回归验证前必须临时移开 `examples/.env`**（制度化防呆，2026-07-11 定，覆盖范围仅 01–08）：`.env` 在场时任何“缺 env”模拟都会失真并**意外发起真实计费调用**——`env -u` 只能清 shell 变量、清不掉文件级配置（`process.loadEnvFile` 会从文件补上）。此陷阱已被三次独立踩中（P8-1c coder、P8-2 orchitector、P9-2 coder），验证完毕再移回。**09–11 不适用这条**——见下方“09–11 云沙盒适配器矩阵”专属流程，那三个脚本的验证要求恰恰相反：不移开 `.env`。

执行方式：

```sh
# 缺 env 全表（应全部 exit 0；仅 01–08，09–11 见下方专属流程）：
for f in examples/0[1-8]-*.ts; do env -u NIMBO_MODEL -u DEEPSEEK_API_BASE_URL -u DEEPSEEK_API_TOKEN -u AI_GATEWAY_API_KEY node "$f"; echo "$f -> $?"; done

# 配 env 全表（examples/.env 已配置 DeepSeek，或已 export NIMBO_MODEL/AI_GATEWAY_API_KEY 均可；仅 01–08）：
for f in examples/0[1-8]-*.ts; do node "$f"; echo "$f -> $?"; done
```

### 3.1 09–11 云沙盒适配器矩阵（P10-4 新增，二级 gate：模型 + 云凭证）

与 01–08 的两态矩阵（缺 env / 配 env）不同，09/10/11 每个脚本的模型驱动段有**两层独立的 gate**，顺序检查（`resolveModel()` 先于云凭证检查，任一未过都在发起任何模型调用/网络请求之前干净退出/返回，见各脚本头注释）：

| 状态 | 触发条件 | 预期 | 09-sandbox-e2b 实际 | 10-sandbox-vercel 实际 | 11-sandbox-cloudflare 实际 |
|---|---|---|---|---|---|
| A. 模型未配置 | `DEEPSEEK_API_BASE_URL`/`DEEPSEEK_API_TOKEN`/`NIMBO_MODEL`+`AI_GATEWAY_API_KEY` 均未配置 | `resolveModel()` 打印指引，`process.exit(0)`——与 01–08 共用同一份 `shared/model.ts` 代码路径，已在 §3 主表验证过，此处不重复移开 `.env` 单独重测（重测需要移开 `.env`，与本节“不移开 `.env`”的要求矛盾） | 同一份 `resolveModel()`，不重复验证 | 同上 | 同上 |
| B. 模型已配置，云凭证未配置 | 见 A 的反面 + `E2B_API_KEY`/`VERCEL_TOKEN`+`VERCEL_TEAM_ID`+`VERCEL_PROJECT_ID`/`NIMBO_CF_GATEWAY_URL`+`NIMBO_CF_GATEWAY_TOKEN` 未配置 | 确定性段照常打印（`describe()`/一次 `exec()`/一次文件读写）；随后云凭证检查未通过，打印指引（指向 `.env.template` 对应小节 / 11 额外指向 `cloudflare-gateway/README.md`）并**干净 `return`**，脚本正常跑到文件末尾，`exit 0`；全程不创建沙盒、不发起任何模型调用、不产生任何网络请求 | ✅（本工单实测：`examples/.env` 起初只有 DeepSeek，三个云厂商变量均为空——确定性段三行输出齐全，E2B_API_KEY 指引后 exit 0） | ✅（同一次实测，起始状态同上：确定性段三行输出齐全，VERCEL_* 三变量指引后 exit 0） | ✅（本工单实测：确定性段含 client→网关→fake 沙盒完整往返三行输出，NIMBO_CF_GATEWAY_* 全程未配置，指引后 exit 0） |
| C. 模型 + 云凭证均已配置（真机） | 三者环境变量齐全 | 创建/连接真实 [沙盒](../terms.md)（`Sandbox.create()` 或已部署网关），`e2bWorkspace`/`vercelWorkspace`/`cloudflareWorkspace` 接入 `createSession`，模型写文件 + bash 验证，`finalResponse` 有意义；09/10 收尾 `sandbox.kill()`/`sandbox.stop()`（11 无需，沙盒生命周期由宿主 wrangler 项目管理） | ✅**真实验证通过**——本工单执行期间，用户往 `examples/.env` 追加了真实 `E2B_API_KEY`，随后的复测自然进入状态 C：`Sandbox.create()` 建真实 microVM，DeepSeek 经 `write_file`+`bash cat` 完成“写问候语并用相对路径验证”任务，`finalResponse` 内容与写入一致，`sandbox.kill()` 正常收尾，脚本 exit 0，全程两次独立真实运行均通过 | ✅**真实验证通过**——同一时机，用户追加了真实 `VERCEL_TOKEN`/`VERCEL_TEAM_ID`/`VERCEL_PROJECT_ID`：`Sandbox.create({token,teamId,projectId,runtime:"node24"})` 建真实 Vercel Sandbox，DeepSeek 完成同一任务，`finalResponse` 确认内容一致，`sandbox.stop()` 正常收尾，exit 0 | **待用户凭证回填**（需先部署 `examples/cloudflare-gateway/`，见其 README；再填 `examples/.env.template` “Cloudflare Sandbox gateway” 节——本工单执行期间用户未提供网关部署，状态 C 未触发） |

执行方式：

```sh
node examples/09-sandbox-e2b.ts;      echo "09 -> $?"
node examples/10-sandbox-vercel.ts;   echo "10 -> $?"
node examples/11-sandbox-cloudflare.ts; echo "11 -> $?"
```

**不要为了凑状态 B 而移开/清空 `examples/.env`**（与 01–08 的防呆警告相反）：这三个脚本的第二层 gate 就是要如实反映 `.env` 里云厂商凭证的真实配置状态——本工单开工时 `.env` 只有 DeepSeek（触发状态 B，见上表），执行期间用户追加了 E2B/Vercel 凭证后自然过渡到状态 C（见上表，已真实跑通）；11 的 Cloudflare 网关凭证仍未配置，继续停在状态 B，待用户部署网关后回填。

### 3.2 12 号真实项目端到端矩阵（P11-1 新增，四级 gate：模型 + GitHub 仓库 + PAT + Vercel 凭证）

12 号比 09–11 多两级 gate，按序检查（任一未过都在发起任何模型/网络调用之前打印指引并干净返回，见文件头注释与 `realProjectSection()`）：① DeepSeek（本例不用 `resolveModel()`，见文件头“Why not shared/model.ts's resolveModel()”）→ ② `GITHUB_REPO` → ③ `GITHUB_PAT` → ④ `VERCEL_TOKEN`+`VERCEL_TEAM_ID`+`VERCEL_PROJECT_ID`。

| 状态 | 触发条件 | 预期 | 实际（本工单） |
|---|---|---|---|
| A. DeepSeek 未配置 | `DEEPSEEK_API_BASE_URL`/`DEEPSEEK_API_TOKEN` 缺任一 | 打印 DeepSeek-only 指引，脚本正常结束（无 gateway 回退，见文件头） | 未单独重测（本仓一直配有 DeepSeek，重测需改动 `.env`，与硬性约束冲突）；代码路径与 gate ②③④ 同构，逻辑经审查确认 |
| B. DeepSeek 已配置，`GITHUB_REPO`/`GITHUB_PAT`/Vercel 三变量任一缺失 | 见 A 的反面 + 后三项任一未配置 | 确定性段照常打印（URL 规范化自测 + 初始化命令清单 + `Skill.fromFS` 对 fake 沙盒装载）；随后在对应 gate 打印指引并**干净 `return`**，`exit 0`；不创建沙盒、不发起模型调用 | **这是本工单开工时的真实状态**（`examples/.env` 只有 DeepSeek + Vercel 三变量，无 `GITHUB_REPO`/`GITHUB_PAT`）——原计划应在此状态下实测“停在 `GITHUB_REPO` 缺失”，但见下方状态 C 的说明：执行期间该状态被用户追加的凭证跨越，未能在该确切留空组合下重新单独实测（改动 `.env` 以复现会违反硬性约束）；确定性段本身（三段输出）已独立实测通过，与状态 C 运行的前半段输出完全一致 |
| C. 全部四项齐全（真机） | DeepSeek + `GITHUB_REPO` + `GITHUB_PAT` + 三个 `VERCEL_*` 均配置 | 创建真实 Vercel Sandbox（git source 克隆目标仓库）→ host 侧六步初始化 → `Skill.fromFS` 装载真实 `frontend-design` skill → agent 做一次设计优化并跑完整 Git 工作流 → 开 PR → `finalResponse` 含改动清单/设计意图/分支名/PR 链接 → `sandbox.stop()` | ✅**真实验证通过，且是本工单执行期间意外达成的**（本工单开工时 `.env` 处于状态 B；执行过程中用户往 `examples/.env` 追加了真实 `GITHUB_REPO=git@github.com:ludafa/Schulte-Grid.git`/`GITHUB_PAT`——本工单全程未触碰该文件）：`Sandbox.create` 真实克隆 `ludafa/Schulte-Grid`；host 侧六步初始化全绿（`npx skills` 主路径成功装出 `frontend-design`，未触发 clone fallback；`git symbolic-ref` 探测默认分支 `main`）；`Skill.fromFS` 装载出真实官方 skill（name/description 与 anthropics/skills 一致）；DeepSeek（`deepseek-v4-pro`）驱动 agent：读代码理解项目 → 决定一处聚焦优化（色彩体系粉→冷蓝青、网格单元格去阴影改描边、计时器 `tabular-nums`）→ `next build` 通过 → `git checkout -b nimbo/design-2026-07-12T03-18-01-631Z` → commit → push → `curl` 建 PR 成功；`finalResponse` 含改动清单+设计意图、分支名、PR 链接三项俱全；`sandbox.stop()` 正常收尾，`Sandbox.list()` 复核该沙盒状态为 `stopped`/`persistent:false`，无残留计费项。PR 用 GitHub API 独立核实：`https://github.com/ludafa/Schulte-Grid/pull/2`（`state: open`），**这是用户仓库里一个真实存在、待人工 review 的 PR，本工单未合并/关闭它** |

执行方式（**与 09–11 不同：不要重复运行这个脚本**——每次运行都会在目标仓库真实创建一个新分支和新 PR，不是幂等的 demo）：

```sh
node examples/12-vercel-sandbox-real-project.e2e.test.ts; echo "12 -> $?"
```

## 4. 回归命令清单

任何改动合入前，仓库根目录按序全绿（顺序固定，理由见 §1.2 注释与 docs/plans/core-sdk.md P4-2）：

```sh
corepack pnpm build          # 1. 全包构建（tsdown，ESM+CJS+d.ts）
corepack pnpm typecheck      # 2. 全包 tsc --noEmit（tsgo）
corepack pnpm test           # 3. 全包 vitest（当前基线：72 文件 885 用例，2026-07-12 P10-4 实测——新增 @nimbo/sandbox-{e2b,vercel,cloudflare} 9 文件 121 用例：e2b 3/33、vercel 3/40、cloudflare 3/48）
corepack pnpm coverage       # 4. 根聚合覆盖率，门槛 lines ≥ 90%（当前 97.89%，2026-07-12 P10-4 实测）
node examples/typecheck.mjs  # 5. examples 类型检查（独立于 workspace，见 examples/README.md）
```

CI（`.github/workflows/`）跑 1–3 与 5（P8-2 起，examples typecheck 入 CI——docs/plans/core-sdk.md P8-1 裁定）；4 为本地门槛（阈值已在 vitest 配置强制）。

## 5. 执行记录（回填区）

> 本节即本功能的**变更记录 / 阶段状态**：逐条记录每次验收执行的日期、执行人、范围、结论，以及执行中当场发现并修复的问题、真机验证细节、已知取舍。迁移时完整保留，不删条目。

| 日期 | 执行人 | 范围 | 结论 |
|---|---|---|---|
| 2026-07-11 | orchitector（P8-2，亲自执行） | §2 全部 13 用例 + §3 全矩阵 14 格 + §4 回归清单；真实模型为 DeepSeek 直连（examples/.env，用户授权）；缺 env 矩阵以移开 .env 方式执行 | **全部通过**。基线：697 用例 / lines 97.95%。亮点：06 真实命中结构化输出兼容回退路径；3-2 用真实官方 xlsx skill（53 附属文件）零改动加载。备注：2-1 的 MemoryFS diff 按 §4.4 空基线语义报 created（modified 语义由 1-1 OverlayFS 覆盖）；无 token 落日志 |
| 2026-07-11 | orchitector（P9-2 收口，亲自执行） | 新增用例 4-4 + §3 矩阵 08 行（缺 env 移 .env 法 / 配 env DeepSeek 真机）；§4 基线随 P9-1 更新为 764 | **全部通过**。模型真实产出 for+if+算术脚本经 justBash 执行；非流式 onOutput 契约实测恰 1 次；v1.1（P9）收口 |
| 2026-07-12 | coder（P10-4，亲自执行） | 新增用例 4-5 + §3.1 新增 09–11 三云沙盒适配器矩阵（状态 A/B/C 三态）；`node examples/setup-node-modules.mjs` + `node examples/typecheck.mjs`（11 脚本全量）；全仓 `pnpm -r build`/`pnpm -r typecheck`/`pnpm -r test`/`pnpm coverage`；§4 基线更新为 72 文件 885 用例 / lines 97.89% | **全部通过，含真机部分**。09/10/11 确定性段三者输出齐全（describe()/exec()/写读一致）。开工时 `examples/.env` 只有 DeepSeek，三个云厂商凭证变量均为空——状态 B 三者均在发起任何网络请求/模型调用之前打印指引并 exit 0（首次实测）。**执行期间用户往 `examples/.env` 追加了真实 `E2B_API_KEY`/`VERCEL_TOKEN`+`VERCEL_TEAM_ID`+`VERCEL_PROJECT_ID`**（本工单未触碰该文件），复测时 09/10 自然进入状态 C：真实创建 E2B/Vercel 沙盒，DeepSeek 真实驱动“写文件+bash 验证”任务，`finalResponse` 与写入内容一致，`sandbox.kill()`/`sandbox.stop()` 正常收尾——两个适配器的真机路径均已**真实验证通过**，非仅静态阅读。11（Cloudflare）仍停在状态 B（网关未部署），待用户回填。`examples/tsconfig.json` 新增 `exclude: ["cloudflare-gateway"]`（该目录是独立 wrangler 项目，被 `**/*.ts` 意外扫入导致 `@cloudflare/sandbox` 解析失败，与本工单新增脚本无关，属必要修复） |
| 2026-07-12 | 主线程（P10 真机契约冒烟，亲自执行） | examples 之外的独立冒烟：scratchpad 脚本直连**真实** E2B microVM 与 Vercel Sandbox，对 `e2bWorkspace`/`vercelWorkspace` 逐条跑 20 项契约断言（FS 七方法含二进制 0x00 往返/mtime 抬升/glob/NotFoundError/DirectoryNotEmptyError、exec 含 P6-1 非零 resolve/onOutput 分片/stderr/timeoutMs→124 及时返回/bash 旁路写同源可见/describe/defaultApproval） | **两家均 20/20 全过**——fake 契约测试承载的全部假设经真机证实。**成本纪律（用户要求）**：创建均带 5min 超时保险 + try/finally kill()/stop()；收尾用 list API 审计——E2B 零残留；Vercel 冒烟用 `persistent:false`，并用 `Sandbox.get({resume:false})+delete()` 连同 P10-4 意外运行遗留的 `orange-still-bee-EZCq8T`（默认 persistent 的停止态快照）一并删除，最终 `Sandbox.list()` 为 0。随手改进：examples/10 的 `Sandbox.create` 增加 `persistent:false`（演示场景不留快照，杜绝每跑一次积累一个计费遗留；恢复语义的正确用法已在注释指向 docs/tech/sandbox.md §3.3） |
| 2026-07-12 | coder（P11-1，亲自执行） | 新增 `examples/12-vercel-sandbox-real-project.e2e.test.ts` + 用例 4-6 + §3.2 12 号真实项目端到端矩阵；`node examples/setup-node-modules.mjs`（幂等）+ `node examples/typecheck.mjs`（12 脚本全量）+ 全仓 `pnpm -r build`/`pnpm -r typecheck`/`pnpm -r test`/`pnpm coverage`（72 文件/885 用例/lines 97.89%，与 P10-4 基线一致，examples/12 未被 vitest/pnpm workspace 收集——已核实） | **全部通过，含真机部分（意外触发但真实完整）**。DeepSeek 模型 id 经唯一允许的只读端点 `GET {DEEPSEEK_API_BASE_URL}/models` 实测确认为 `deepseek-v4-pro`（清单仅两项：`deepseek-v4-flash`/`deepseek-v4-pro`），已设为本例默认值。确定性段（URL 规范化自测两种输入+一个失败输入、初始化命令清单打印、`Skill.fromFS` 对 fake 沙盒装载）本工单实测通过。**真机段**：本工单开工时 `examples/.env` 只有 DeepSeek+Vercel 三变量（无 `GITHUB_REPO`/`GITHUB_PAT`），预期会停在状态 B；**执行期间用户往 `examples/.env` 追加了真实 `GITHUB_REPO`/`GITHUB_PAT`**（本工单全程未触碰该文件，未伪造/临时设置任何凭证），复测因此进入四项 gate 全部通过的状态 C：真实创建 Vercel Sandbox 并克隆 `ludafa/Schulte-Grid`，host 侧六步初始化全绿，`Skill.fromFS` 装出真实官方 frontend-design skill，DeepSeek（`deepseek-v4-pro`）驱动 agent 完成一次聚焦设计优化（色彩体系冷色化、网格单元格去阴影改描边、计时器 `tabular-nums`）、`next build` 通过、完整 git 工作流、`curl` 建 PR 成功，`finalResponse` 三项俱全，`sandbox.stop()` 正常收尾（`Sandbox.list()` 复核 `stopped`/`persistent:false`，无残留）。**PR 已用 GitHub API 独立核实真实存在**：`https://github.com/ludafa/Schulte-Grid/pull/2`（open）——**留给用户人工 review，本工单未合并/关闭**。因此状态 B 未能在一次干净的（仍缺 `GITHUB_*`）复测中重新验证（复测需要改动 `.env`，与硬性约束冲突）；该 gate 是与 09/10/11 同构的简单早退分支，且本次真机运行已证明其前一个 gate（DeepSeek）与其自身之后两个 gate（`GITHUB_PAT`/`VERCEL_*`）在“已配置”一侧被正确执行，未在任何 gate 提前 return。全仓零回归。**顺手核实的真实 PR diff**：`app/globals.css`（+19-19）、`components/schulte-grid.tsx`（+19-16）与 agent 最终回复的改动清单一致；另外两处非预期但无害的连带改动——`next-env.d.ts`（+1-1，`next build` 自动重写的版本注释行）与新增的 `skills-lock.json`（+11，`npx skills` CLI 自己的清单文件，落在仓库根目录而非 `.agents/`/`.skills/` 之下，因此未被 `.git/info/exclude` 挡住、被 `git add -A` 一并提交进了 PR）——docs/tech/sandbox.md §2.3 的排除范围目前只覆盖 `.agents/`/`.skills/` 两个目录，未预见 `npx skills` 会在仓库根另留一个清单文件；本工单未去追加排除规则（不在工单授权范围内的顺手改动），如实记录为一处观察到的连带细节，供后续工单参考。 |
| 2026-07-12 | 主线程（P12-3 集成真机验收，亲自执行） | chat agent webapp 全链路（apps/server :3900 + 真实 Vercel 沙盒 + 真实 DeepSeek）：register→login→建会话→只读消息 SSE→[回放](../terms.md)→[休眠](../terms.md)→唤醒→清理 | **全部通过**。流式：只读消息 19.5s 整轮，SSE 首事件 user.message、764 事件、末 turn.result；持久化：sqlite agent_events [seq](../terms.md) 1–764 无缺口，GET events 回放与直播逐事件一致；休眠：idle 60s 测试档下最后活动约 60s 后沙盒自动 stopped + [快照](../terms.md)；唤醒：第二条消息 8s 完成，会话分支与工作区状态原样还原（git branch --show-current 实证）、seq 续至 870、跨休眠多轮续聊成立。当场修复：status 读取时推导 sleeping；dev 脚本移除根 ../../.env 引用（与 .env/ transcript 目录冲突）。清理：idle 阈值还原、测试沙盒删除、Sandbox.list()=0 |
| 2026-07-12 | 主线程（P12 浏览器端到端回归，agent-browser 亲测） | chat webapp 全功能真实浏览器回归（Chrome via agent-browser，前端 5273 + server 3900 + 真沙盒 + 真 DeepSeek）：注册→登录→建会话→发只读消息→流式时间线→刷新回放→深色切换→登出→重登会话列表持久 | **全部通过，揪出并修复 2 个 curl/fake 测不到的真 bug**。① 注册被 better-auth 403「Invalid origin」——trustedOrigins 默认 5173 与实跑端口 5273 错配，注入 CLIENT_URL 修复（配置类，端口腾挪引入）；② 会话详情永久卡「加载会话失败：signal is aborted without reason」——chat-session.tsx useEffect 把 StrictMode 双挂载的 AbortError 当真错误、晚到的 abort 覆盖成功态，catch 加 `controller.signal.aborted` 守卫吞掉（代码 bug，仅真实浏览器 StrictMode 暴露）。修复后：流式时间线渲染完整（用户气泡/reasoning/两个 bash 工具卡片/agent markdown/usage 汇总条 7142 tokens）；刷新从 SQLite 完整回放含用户发言（user.message 契约真机验证）；深色切换、登出重定向、重登会话列表持久均通过。web 37 用例+typecheck+lint 全绿；测试沙盒回收 Sandbox.list()=0 |
| 2026-07-12 | 主线程（P12-4 断线可续 + markdown 渲染真机验证，agent-browser + curl） | ① reasoning/agent_message streamdown 渲染；② composer 错位布局；③ SSE 断线可续实时流 | **全部通过**。① markdown：agent_message 与 reasoning 均经 streamdown 渲染（**bold**/代码块/表格/标题正确，节点 75→329，原始 ``` 消失，控制台零错误）；② 布局：盒模型实锤 scroller 2891px→314px、OVERLAP=false，composer 钉底；③ 断线可续：curl 协议级证明 tail 从 after=870 接入运行中 turn→回放缺口→实时流至 turn.result（首 user.message 末 turn.result）；浏览器证明刷新后客户端自动开 `stream?after=N` tail、完整 turn 内容+结果渲染（修复前刷新不开任何流）。POST /messages 返 202、turn 后台独立于连接。server 33 + web 49 用例 + 两端 tsc/lint/build 全绿；测试沙盒回收 Sandbox.list()=0 |
| 2026-07-12 | 主线程（缓存 token 统计+展示，真机验证） | chat 每轮统计并展示 cached prompt 长度（DeepSeek 缓存命中）：nimbo core Usage 加 cachedInputTokens 透传 + server/web wire schema + turn-result-bar 展示 | **全部通过**。实测 DeepSeek 经 @ai-sdk/deepseek 报 inputTokenDetails.cacheReadTokens（同前缀二次调用 0→1408 确认自动缓存）；改动：core events.ts Usage+loop.ts mergeUsage 映射 cacheReadTokens、server+web usageSchema 加字段、turn-result-bar 加「缓存命中」。真机两轮只读消息：turn1 cachedInputTokens 2944、turn2 6400（前缀累积增长），web 每轮 bar 渲染「输入 X · 缓存命中 Y · 输出 Z · 共计 W tokens」并随 turn.result 存入 agent_events。全仓 885 + server 33 + web 49 全绿；测试沙盒回收 list()=0 |
