# CLAUDE.md

## 仓库拓扑

pnpm workspace 三组成员（见 [pnpm-workspace.yaml](./pnpm-workspace.yaml)）：`packages/*` 是对外发布的 `@nimbo/*` 包，`apps/*` 与 `examples` 是 `private: true` 的消费侧、不发布。各包的对外定位与 README 索引见 [docs/README.zh-CN.md](./docs/README.zh-CN.md)，这里只给改代码时要的**落点**与**依赖方向**。

### packages/\*（发布，changesets 管版本）

| 包                          | 落点                                                                         | runtime workspace 依赖      |
| --------------------------- | ---------------------------------------------------------------------------- | --------------------------- |
| `@nimbo/core`               | L0 接口 / L1 定义层 / L2 运行层 / AI SDK step runner / skills / 内置工具本体 | 无（peer `ai`）             |
| `@nimbo/virtual-fs`         | MemoryFS·OverlayFS·DirFS、mime 推断、diff/writeBack、文件工具八件套          | core                        |
| `@nimbo/mini-bash`          | NimboExec 实现：纯 TS 只读解释器（零依赖极简档，随 sdk 装入）                | core                        |
| `@nimbo/just-bash`          | NimboExec 实现：全语法档 bash（just-bash 适配器，不随 sdk 装入）             | core                        |
| `@nimbo/sandbox-e2b`        | NimboFS & NimboExec 适配 E2B（BYO 实例，provider SDK 仅类型依赖）            | core, virtual-fs            |
| `@nimbo/sandbox-vercel`     | 同上，适配 Vercel Sandbox                                                    | core, virtual-fs            |
| `@nimbo/sandbox-cloudflare` | 同上，适配 Cloudflare Sandbox（`.` fetch 客户端 + `./worker` 网关双入口）    | core, virtual-fs            |
| `@nimbo/sdk`                | 主包门面：re-export core + virtual-fs + mini-bash，不放实现                  | core, virtual-fs, mini-bash |

**依赖方向单向**：`core` 是根，其余全部指向它。`core` 反向持有 `mini-bash`/`virtual-fs` 的是 **devDependencies**（自测用）——这条循环 devDep 正是「跨包类型解析指向 dist、必须先 `build` 再 `typecheck`」的原因，别改成 dependencies。

### apps/\* 与 examples（private，不发布）

| 成员                                   | 是什么                                                                               | workspace 依赖                                |
| -------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------- |
| `@nimbo-chat/node-server`              | chat 应用服务端：Hono + zod-openapi + drizzle/better-sqlite3 + better-auth，SSE 流式 | core, sdk, sandbox-e2b, sandbox-vercel        |
| `@nimbo-chat/web`                      | chat 应用前端：Vite + React + TanStack Router + shadcn(base-ui) + Tailwind           | core                                          |
| `@nimbo-chat/cloudflare-worker-server` | 双角色 Worker：进程内直连真实 CF Sandbox，同时对外提供 BYO 网关端点                  | sdk, sandbox-cloudflare                       |
| `@nimbo/examples`                      | 示例集（实验田），`pnpm example <编号>` 即跑；只有 typecheck，无 build/test          | sdk, just-bash, sandbox-e2b/vercel/cloudflare |

`apps/*` 并入根 workspace，是因为它们要用 `workspace:*` 协议解析 `@nimbo/*`（独立子 workspace 解析不到）；`examples` 不带 `/*`——workspace 根自身就是那个成员。

### 命令边界（容易踩）

- 根 `pnpm build` / `typecheck` / `test` 只 filter `./packages/*`，**不覆盖 apps 与 examples**；动了 apps 要进对应目录跑它自己的 `typecheck`/`lint`/`test`。
- CI（`.github/workflows/ci.yml`）跑的是 `pnpm -r build|typecheck|test`，覆盖**全部**成员——本地只跑根脚本会漏掉 apps/examples 的问题。
- chat 应用另有根级 `chat:bootstrap`（建库 + 生成 OpenAPI 与前端 client）、`chat:server`、`chat:web`。

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

**目录与职责分离**——一个独立功能的文档按视角拆到三处，不再一个文件混写产品·技术·施工：

- **产品文档** `docs/features/<feature>.md`：产品视角——以用户使用手册作为目标，聚焦到要解决什么问题、用户可见行为/交互、范围与非目标、成功标准。
- **技术方案文档** `docs/tech/<feature>.md`：技术视角——方案、关键接口/数据结构、取舍与已知限制。
  - **涉及 DB 时**必须有**业务数据领域设计图**（实体与关系，用 mermaid `erDiagram`）。
  - **核心流程**必须有**时序图**（用 mermaid `sequenceDiagram`）。
- **施工进展** `docs/plans/<feature>.md`：拆单、验收结论、阶段状态、变更记录。

nimbo 是技术产品，**技术面本身就是产品功能**——架构总纲、内置工具、沙盒适配契约这类「底座」对开发者而言都是功能，一律按上面三目录归位，不另设参考目录。唯一例外：术语表 `docs/terms.md` 与总览 `README` 留在 `docs/` 根（它们是词典/索引，不是功能文档）。

请用简单易懂、清晰明了的语言来编写所有文档，避免晦涩、避免过度术语化。可以的时候尽量多画图，业务领域实体关系图、时序图是很重要的。

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
