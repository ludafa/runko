# CLAUDE.md

## 仓库拓扑

pnpm workspace 三组成员（见 [pnpm-workspace.yaml](./pnpm-workspace.yaml)）：`packages/*` 是对外发布的 `@nimbo/*` 包，`apps/*` 与 `examples` 是 `private: true` 的消费侧、不发布。各包的对外定位与 README 索引见 [docs/overview.md](./docs/overview.md)，这里只给改代码时要的**落点**与**依赖方向**。

### packages/\*（发布，changesets 管版本）

| 包                          | 落点                                                                         | runtime workspace 依赖      |
| --------------------------- | ---------------------------------------------------------------------------- | --------------------------- |
| `@nimbo/core`               | L0 接口 / L1 定义层 / L2 运行层 / AI SDK step runner / skills / 内置工具本体 | 无（peer `ai`）             |
| `@nimbo/agent`              | 轮编排运行时：一轮接一轮地跑（起/停/收尾、待发队列、人在回路、崩溃恢复）+ 四种宿主能力的接口与内置实现 | core, virtual-fs            |
| `@nimbo/virtual-fs`         | MemoryFS·OverlayFS·DirFS、mime 推断、diff/writeBack、文件工具八件套          | core                        |
| `@nimbo/mini-bash`          | NimboExec 实现：纯 TS 只读解释器（零依赖极简档，随 sdk 装入）                | core                        |
| `@nimbo/just-bash`          | NimboExec 实现：全语法档 bash（just-bash 适配器，不随 sdk 装入）             | core                        |
| `@nimbo/sandbox-e2b`        | NimboFS & NimboExec 适配 E2B（BYO 实例，provider SDK 仅类型依赖）            | core, virtual-fs            |
| `@nimbo/sandbox-vercel`     | 同上，适配 Vercel Sandbox                                                    | core, virtual-fs            |
| `@nimbo/sandbox-cloudflare` | 同上，适配 Cloudflare Sandbox（`.` fetch 客户端 + `./worker` 网关双入口）    | core, virtual-fs            |
| `@nimbo/persist-kysely`     | 持久化实现（核心）：吃一个 Kysely 实例；三方言差异收敛到五处（全在 `flavor.ts`） | agent, core（peer kysely）  |
| `@nimbo/persist-sqlite`     | 薄壳：吃 better-sqlite3 实例 → Kysely → 核心                                 | agent, persist-kysely       |
| `@nimbo/persist-postgres`   | 薄壳：吃 `pg.Pool`                                                           | agent, persist-kysely       |
| `@nimbo/persist-mysql`      | 薄壳：吃 mysql2 连接池                                                       | agent, persist-kysely       |
| `@nimbo/persist-mongo`      | **非** 薄壳：MongoDB 直接实现三个领域接口（Kysely 是 SQL，用不上）            | agent, core（peer mongodb） |
| `@nimbo/conformance`        | 契约一致性套件：持久化 / 归属仲裁的用例数据（`{ name, run }`），**不依赖任何测试框架** | agent（peer）、core（dev） |
| `@nimbo/sdk`                | 主包门面：re-export core + virtual-fs + mini-bash，不放实现                  | core, virtual-fs, mini-bash |

**依赖方向单向**：`core` 是根，其余全部指向它。`agent` 建在 `core` 之上、**不依赖 `sdk`**——`sdk` 是门面包（re-export core + virtual-fs + mini-bash），让逻辑层反过来依赖门面会把依赖图从一棵树变成有回边；代价是 `agent` 自己写了一份与 sdk 同款的文件工具默认装配（`runtime/session-factory.ts`，改 sdk 的默认装配时要同步）。`core` 反向持有 `mini-bash`/`virtual-fs` 的是 **devDependencies**（自测用）——这条循环 devDep 正是「跨包类型解析指向 dist、必须先 `build` 再 `typecheck`」的原因，别改成 dependencies。

### apps/\* 、examples 与 docs（private，不发布）

| 成员                                   | 是什么                                                                               | workspace 依赖                                |
| -------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------- |
| `@nimbo-chat/node-server`              | chat 应用服务端：Hono + zod-openapi + drizzle/better-sqlite3 + better-auth，SSE 流式 | agent, core, sdk, sandbox-e2b, sandbox-vercel |
| `@nimbo-chat/web`                      | chat 应用前端：Vite + React + TanStack Router + shadcn(base-ui) + Tailwind           | core                                          |
| `@nimbo-chat/cloudflare-worker-server` | 双角色 Worker：进程内直连真实 CF Sandbox，同时对外提供 BYO 网关端点                  | sdk, sandbox-cloudflare                       |
| `@nimbo-demo/persist-demo`             | 零 ORM 的宿主 demo：持久化只用官方 `@nimbo/persist-*` 包，Hono + 内存工作区 + mini-bash | agent, core, persist-sqlite/postgres/mysql/mongo, virtual-fs, mini-bash |
| `@nimbo/examples`                      | 示例集（实验田），`pnpm example <编号>` 即跑；只有 typecheck，无 build/test          | sdk, just-bash, sandbox-e2b/vercel/cloudflare |
| `@nimbo/docs`                          | VitePress 设计文档站，**可独立部署**；有 build/typecheck，另有 `check`（front matter 体检） | **无**——它只把 markdown 编译成站点            |

`apps/*` 并入根 workspace，是因为它们要用 `workspace:*` 协议解析 `@nimbo/*`（独立子 workspace 解析不到）；`examples` 与 `docs` 不带 `/*`——它们的根目录自身就是那个成员。

**`docs` 独立成员意味着两件事**：① 依赖自管（vitepress/mermaid 装在 `docs/package.json`，不占根）；② **产物可单独部署**——`docs/.vitepress/dist` 是纯静态文件，跟 `packages/*` 的发布流程完全解耦。部署到子路径用 `DOCS_BASE=/nimbo/ pnpm docs:build`，不用改配置。

### 命令边界（容易踩）

- 根 `pnpm build` / `typecheck` / `test` 只 filter `./packages/*`，**不覆盖 apps、examples 与 docs**；动了 apps 要进对应目录跑它自己的 `typecheck`/`lint`/`test`。
- CI（`.github/workflows/ci.yml`）跑的是 `pnpm -r build|typecheck|test`，覆盖**全部** 21 个成员——本地只跑根脚本会漏掉 apps/examples/docs 的问题。
- **文档站的死链检查藏在 `pnpm -r build` 里**（`docs` 的 build 就是 `vitepress build`，构建时会校验全站链接）；`typecheck` 查的是 `.vitepress/` 下的配置。但 **front matter 体检（`docs:check`）不在 `-r` 的三个脚本里**，CI 单列了一步。
- chat 应用另有根级 `chat:bootstrap`（建库 + 生成 OpenAPI 与前端 client）、`chat:server`、`chat:web`；文档站有 `docs:dev` / `docs:build` / `docs:preview` / `docs:check`（都是 `--filter @nimbo/docs` 的快捷方式）。
- **lint 跟其余三个根脚本不一样：`pnpm lint` / `pnpm lint:fix` 走的是 `pnpm -r`，覆盖全部 20 个有 lint 脚本的成员**（`packages/*` 十五个 + `examples` + 四个 app；只有 `docs` 没配——它的源码里没有可 lint 的 JS/TS，`.vitepress/cache` 全是构建缓存）。规则分两套：`packages/*`、`examples` 与 `cloudflare-worker-server` 引根目录的 `eslint.config.base.js`（共享基线，目前只有「花括号强制」一条）；`web` 与 `node-server` 各有自己的完整配置（prettier + import 排序 + react-hooks），不引基线。
- **给 app 的配置加规则时，位置很关键**：两个 app 的配置最后一项是 `eslint-config-prettier`，它会把 `curly` 这类「特殊规则」直接关掉。新规则若被它覆盖，必须写在它**后面**的配置块里（`curly: ['error', 'all']` 就是这么加的——`all` 档只加括号、不动折行，与 prettier 不冲突）。
- **根 `package.json` 的 `typescript` 是 `^6.0.3`，跟 catalog 的 `^7.0.2` 不一致，这是故意的**：`typescript-eslint` 至今（8.67）的 peer 范围是 `>=4.8.4 <6.1.0`，装在 TS 7 上一 import 就崩（`Cannot read properties of undefined (reading 'Cjs')`）。根上这份 TS 6 只给 lint 工具链用；`packages/*` 各自的 `typescript: catalog:` 仍是 7.0.2，编译不受影响（两个 app 早就为同一原因把自己钉在 `^6.0.3`）。**typescript-eslint 支持 TS 7 后可以撤掉这个钉子。**

### dev server 归我自己管（硬性规范）

- **不要主动起常驻进程**——`chat:server`、`chat:web`、任何 `dev` / `--watch` 脚本，一律别起，后台运行也不行。**只有我明确说「你起一个」时才起。**
- **为什么**：这类进程跑完不退、会被你的会话持有；攒几轮下来就是一堆占着端口的孤儿 watcher，我这边还不一定看得见。要验证改动，用**跑完即退**的命令：`typecheck` / `test` / `build`，或对着我已经起好的服务 `curl`。
- **确实需要一个跑着的服务才能验证**时：别自己起，告诉我要起什么、监听哪个端口、你接下来要拿它验什么，让我起。可以提示我用 `! pnpm chat:server`（`!` 前缀在会话里执行，输出直接进上下文）。
- **别擅自杀我的 dev server**。要清理先问，并说清哪个 PID / 端口、为什么该清。

## 术语纪律

- 所有对话与文档中使用的项目术语，必须在 [docs/terms.md](./docs/terms.md) 中有明确定义。使用未登记的新术语前，先在术语表加词条（主术语 + 一句话定义），再在正文使用。
- 一个概念只有一个**主术语**。文档、代码、对话一律使用主术语；术语表「同义词（退役）」列里的叫法不得再使用，只作读旧文档时的对照。发现同一概念长出第二个名字，就地合并进术语表：择优定主术语，其余进同义词列。
- 主术语括号里的英文/代码标识符属于主术语本身（行文用中文、代码用括号里的名字），不算同义词。
- 新文档不再自建术语块，开头引用 docs/terms.md 即可；存量文档的术语块在下次修订时迁入术语表。

## 文档规范

**路径形状是 `docs/<分层>/<视角>/<feature>.md`**——先按架构分层切目录，每个目录里边再分功能·技术方案·施工计划三个视角。

**第一层 · 架构分层**——按 [agent 内核包](./docs/architecture/tech/agent-kernel.md) 定义的分层归位。框架本身只有**两块**：agent 逻辑层（固定，不可替换）与宿主层（可替换）。两块之外还有总纲、接入层与周边：

| 目录 | 装什么 | 对应包 |
| --- | --- | --- |
| `docs/architecture/` | 架构总纲（分层、部署形态、包怎么拆） | `@nimbo/agent` |
| **`docs/logic/`** | **agent 逻辑层，三个子层自上而下** | |
| &nbsp;&nbsp;`logic/arbitration/` | 归属仲裁——语义 + **随宿主变化的多种实现** | `@nimbo/agent` · `persist-*` · `durable-object` |
| &nbsp;&nbsp;`logic/orchestration/` | 轮编排 | `@nimbo/agent` |
| &nbsp;&nbsp;`logic/engine/` | 执行引擎 | `@nimbo/core` |
| **`docs/host/`** | **宿主层，按宿主环境分档** | |
| &nbsp;&nbsp;`host/contract/` | **跨环境的接口契约**（沙盒 · 持久化 · 流分发），只写一遍 | `@nimbo/agent` · `virtual-fs` |
| &nbsp;&nbsp;`host/node/` | Node 长驻：单进程 / cluster / Docker / k8s | `persist-*` |
| &nbsp;&nbsp;`host/cloudflare/` | Worker + Durable Object | `durable-object` · `sandbox-cloudflare` |
| &nbsp;&nbsp;`host/vercel/` | Functions + Sandbox | `sandbox-vercel` · `stream-redis` |
| &nbsp;&nbsp;`host/e2b/` | E2B 沙盒（只提供沙盒这一样能力，可配在任何一档下） | `sandbox-e2b` |
| `docs/ingress/` | 接入层——构建者写的应用代码（`apps/` 下的 chat 应用） | 不发布 |
| `docs/misc/` | 周边（示例集、验证与验收、文档站） | `@nimbo/examples` |

只有[术语表](./docs/terms.md)、`overview.md`、`index.md` 和 README 留在 `docs/` 根——它们是词典/索引，不是功能文档。

**归位靠两问**：① 这份讲的是**框架固定的语义**，还是**某个宿主环境怎么落地**？前者进 `logic/`，后者进 `host/<环境>/`。② 如果是宿主层，它**跨所有环境**吗？跨的进 `host/contract/`，只对一家成立的进那一家的目录。

判不准就看它主要在改哪个包。**归属仲裁是唯一的例外**：它的语义在逻辑层、实现随宿主变，两样并排放在 `logic/arbitration/`——因为「换一种实现」这件事本身就是它的主题。

**第二层 · 视角**——同一个功能的三份文档在同一个目录下并排，不再一个文件混写产品·技术·施工：

- **产品文档** `<分层>/features/<feature>.md`：产品视角——以用户使用手册作为目标，聚焦到要解决什么问题、用户可见行为/交互、范围与非目标、成功标准。
- **技术方案文档** `<分层>/tech/<feature>.md`：技术视角——方案、关键接口/数据结构、取舍与已知限制。
  - **涉及 DB 时**必须有**业务数据领域设计图**（实体与关系，用 mermaid `erDiagram`）。
  - **核心流程**必须有**时序图**（用 mermaid `sequenceDiagram`）。
- **施工进展** `<分层>/plans/<feature>.md`：拆单、验收结论、阶段状态、变更记录。

三份的文件名（slug）必须一致，这样 `docs/<分层>/*/x.md` 一把捞全。跨目录同名是允许的、也是有意的——四档宿主的落地文档都叫 `deployment.md`，`docs/host/*/tech/deployment.md` 正好捞出「所有环境怎么落地」。

**每份文档必须有 front matter**，字段固定这几个（`layer`/`module` 的取值以术语表为准）：

```yaml
---
title: "单一数据账本（single-ledger）— 功能手册"
slug: single-ledger              # 与文件名一致；三个视角共用同一个 slug
view: 功能                        # 功能 | 技术 | 施工
layer: 逻辑层                     # 总纲 | 逻辑层 | 宿主层 | 接入层 | 周边
module: 轮编排                    # 执行引擎 | 轮编排 | 归属仲裁 | 沙盒 | 持久化 | 流分发 | —
packages: ["@nimbo/agent"]        # 这份文档对应哪些包
tags: ["账本", "UIMessage", "seq", "断线续传", "数据模型"]
related: ["logic/orchestration/tech/single-ledger.md", "architecture/tech/agent-kernel.md"]  # 相对 docs/ 根
---
```

`module` 填的是**逻辑模块**，不是宿主环境——宿主环境的落地文档往往横跨好几个模块（Node 那档同时讲持久化、仲裁机制、流分发），一律填 `—`，靠 tags 区分。**没有「归属仲裁机制」这个取值**：它是归属仲裁模块在宿主层的实现，文档跟语义并排放在 `logic/arbitration/`，统一填「归属仲裁」。

它是**给检索用的**——想按层/按包/按 tag 捞文档直接 grep 字段，别再靠目录扫：

```sh
grep -rl 'module: 轮编排' docs/          # 轮编排相关的全部文档
grep -rl '@nimbo/agent' docs/            # 某个包相关的全部文档
ls docs/host/*/tech/deployment.md        # 全部宿主环境的落地方案
```

**挪动文档时**：docs 内部有上千条相对链接，手改必漏。正确做法是「把链接解析成绝对路径 → 套用移动表 → 从新位置重算相对路径」，改完跑 `pnpm docs:build`（它做全站死链检查）。**别在标题里嵌文档路径**——路径一改锚点就跟着变，站内链接会静默失效。

### 文档站（VitePress）

`docs/` 同时是一个 VitePress 站点（见[文档站](./docs/misc/features/docs-site.md)）。**导航与侧栏全部从 front matter 现推**，所以新增文档不用改配置——放对目录、写好 front matter 就会自己出现。

```sh
pnpm docs:check      # front matter 体检：字段齐全、取值合法、不会漏出侧栏
pnpm docs:build      # 构建 + 全站死链检查（跑完即退）
pnpm docs:dev        # 常驻进程 —— 按上面「dev server 归我自己管」，别主动起
```

改完文档**用 `docs:check` + `docs:build` 验证**，两步都跑完即退，CI 里也是这两步。几条容易踩的：

- **正文里裸写 `<T>`、`<Foo>` 会让构建失败**——markdown 会被当 Vue 模板编译，尖括号被当成标签。写进反引号里即可。
- **`view` 字段是「功能 / 技术 / 施工」**（短形式），侧栏上显示的「技术方案 / 施工进展」是另一回事，别互相冒充。
- **指向 `docs/` 之外的相对链接不用改**（`../../packages/core/README.md` 这种）——构建时会自动改写成 GitHub 地址，源文件保持相对路径以便在编辑器里跳转。

nimbo 是技术产品，**技术面本身就是产品功能**——架构总纲、内置工具、沙盒适配契约这类「底座」对开发者而言都是功能，一律按上面的分层 + 三视角归位，不另设参考目录。唯一例外：术语表 `docs/terms.md` 与总览 `README` 留在 `docs/` 根（它们是词典/索引，不是功能文档）。

请用简单易懂、清晰明了的语言来编写所有文档，避免晦涩、避免过度术语化。可以的时候尽量多画图，业务领域实体关系图、时序图是很重要的。

**主线优先，枝节进附录**——正文只留「不读完就理解不了这个方案」的内容，其余一律挪到文末**附录**，正文用一句话带过并链过去。

判断标准很简单：**把它整段删掉，主线还成立吗？** 成立就该进附录。典型的枝节有四类：

- **顺手做的小改动**（改个名、补个字段），跟主线同批施工但不影响理解；
- **以后再说的备选方案**（本次不做、留待评估的）；
- **暂不实施的讨论**（比如「将来多机部署怎么办」）；
- **外部对照材料**（别人怎么做、为什么不照搬）。

附录里的内容照样要写全写清楚——挪走是为了让主线读起来是一条直线，不是为了少写。施工拆单里若包含附录项，链回对应附录。

**引用纪律**：

- 文档间要有**关系引用**——一个功能的 feature/tech/plan 三份互链；依赖或延续其他功能时链到对应文档。
- 用到术语必须引用 [docs/terms.md](./docs/terms.md)；术语先收录进术语表（主术语 + 一句话定义）再在正文使用（承接上面「术语纪律」）。

## 编排效率（主线程派活时）

- **小改动自己内联做**，别派 subagent——几行的 bug/改动，派一个 agent 光加载上下文+自测就是几十分钟，自己改反而几分钟。派 agent 留给「多文件、需通读、有明确验收标准」的成块工单。
- **独立的活并行扇出**：改不同文件/包、彼此无依赖的工单，同一条消息里多个 Agent 并发后台跑，别串行排队。耦合的（core→server→web 这种）才串。
- **机械活拆小 + 选便宜档**：批量改名/字面量替换这类无需推理的任务，用小工单 + Agent 的 `model`/`effort` 调低档，别配全套重流程。
- **大规模独立扇出**（一次性迁很多文件/审很多点）才考虑 workflow，且需用户显式 opt-in（说「用 workflow」），不设默认。

## 版本管理机制

本仓库用 changesets 管理多包的独立版本与 changelog。**版本号由 changeset 文件决定,不由 commit message 决定。**

每次有面向用户的改动,都要生成一个 changeset 文件放在 `.changeset/` 下。
纯内部改动(如仅改测试、CI、注释)不需要 changeset。

**范围只限 `packages/*`**——`apps/*` 与 `examples` 是 `private: true` 的不发布成员(见上「仓库拓扑」),没有版本号也不进 CHANGELOG,改它们不写 changeset。

## changeset 文件格式

文件名随意(如 `.changeset/some-name.md`),内容:

```
---
"@scope/包名A": <major|minor|patch>
"@scope/包名B": <major|minor|patch>
---

变更说明(会进 CHANGELOG,写给用户看,说清"现在能做什么/修了什么")
```

bump 级别判断:

- major:破坏性变更(API 删除/签名改变/行为不兼容)
- minor:新增功能,向后兼容
- patch:bug 修复、内部优化,不改 API

## 判断改动影响哪些包

生成 changeset 前,必须先 `git diff --staged` 看改动落在哪些包的目录下,逐个判断:

- 改动直接落在某包的 src → 该包需要 bump
- 只改了某包的测试/文档 → 通常不需要 changeset
- 拿不准某个改动算 major 还是 minor → 问我,不要猜。破坏性判断尤其要谨慎,宁可问。

## Commit 规范(仍使用 Conventional Commits)

commit message 用 Conventional Commits 格式(`feat:`/`fix:`/`docs:` 等),但它只影响历史可读性,不决定版本号。

- 一次 commit 只做一件事
- 不要加 "Generated by Claude" 或 co-author 尾注
- changeset 文件和对应的代码改动放在同一个 commit 里
