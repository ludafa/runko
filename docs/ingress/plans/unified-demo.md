---
title: "唯一 demo（unified-demo）— 施工进展"
slug: unified-demo
view: 施工
layer: 接入层
module: —
packages: ["@runko-chat/node-server", "@runko-chat/web", "@runko/persist-kysely", "@runko/persist-mongo", "@runko/conformance"]
tags: ["chat 应用", "demo", "Kysely", "本地沙盒", "演示模型", "Postgres", "多副本", "施工"]
related: ["ingress/features/unified-demo.md", "ingress/tech/unified-demo.md", "host/node/plans/multi-replica.md"]
---
# 唯一 demo — 施工进展

> 术语见 [术语表](../../terms.md)。[功能手册](../features/unified-demo.md) · [技术方案](../tech/unified-demo.md)。

## 当前状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| U0 | 三份文档 + 术语登记 | ✅ 待你过目 |
| U1 | 框架：租约启动时收拾自己名下的旧租约 | ✅ 2026-09-22 |
| U2 | 数据层换 Kysely，框架的表换 persist-kysely（仍只有 SQLite） | ✅ 2026-09-22 |
| U3 | 零配置：演示模型、本地沙盒、GitHub 可选、配置接口、web | ✅ 2026-09-22 |
| U4 | Postgres | ✅ 2026-09-22 |
| U5 | 多副本：转发、在场进库、镜像与验证环境 | ✅ 2026-09-22 |
| U6 | 把 persist-demo 的真进程测试搬过来，接进 CI | ✅ 2026-09-22 |
| U7 | 删 persist-demo，清理文档 | ✅ 2026-09-22 |
| U8 | 验证方案、端到端实测、代码审查 | ✅ 2026-09-22 |

**顺序**：U1 → U2 → U3 → U4 → U5 → U6 → U7 → U8。

- U1 必须在 U2 前面：U2 一换上租约，单进程崩溃重启就要等 60 秒。U1 先把这个坑填上，U2 才不会让行为倒退。
- U3 和 U4 互不依赖，但都要大改 node-server 的同一批文件，串行做，免得互相冲突。
- U6 要等 U5：真进程测试要用到转发和 Postgres。
- U7 要等 U6：测试搬完、在 CI 上跑绿之后才能删，否则覆盖会出现空档。

## 待确认

| # | 问题 | 我的建议 |
|---|---|---|
| 1 | ~~旧数据搬不搬~~ | ✅ 已定（2026-09-22）：不搬。库文件名不变，启动时认出旧库就报错退出，由人手动删；不自动删、不自动迁 |
| 2 | ~~U1 的版本级别~~ | ✅ 已定：persist-kysely、persist-mongo 标 patch，conformance 标 minor |

## 各阶段

### U1 · 租约启动时收拾自己名下的旧租约

- **目标**：同名进程重启后，`recover()` 立刻收拾上一辈子留下的租约。见[技术方案 §3](../tech/unified-demo.md#_3-租约-启动时收拾自己名下的旧租约-框架小改)。
- **涉及**：`packages/persist-kysely/src/arbitration.ts`、`packages/persist-mongo` 的租约实现、`packages/conformance` 的仲裁用例，以及归属仲裁的技术文档（把新判据写进契约）。
- **产出**：`listStale` / `clearStale` / `acquire` 用同一条新判据；conformance 新增 `arbitrationRestartCases`（5 条）与 `RestartConformanceSetup`；changeset `lease-restart-reclaim`。
- **实际**：判据写成一处共用的 `isStaleWhere` / `staleOr`，`isLive` 一并收口（自己上一辈子的租约不算活着，所以 `inspect` 与 `acquire` 的快路也跟着对）。套件的 setup 多了两个钩子：`restart()` 再造一个同名实例，`freezeClock()` 把上一辈子那个实例的时钟钉死（测试里它还活着、还在打心跳，不钉死就判不出残留）。
- **验收结论**：✅ persist-sqlite 69 条、persist-kysely 273 条（含 Postgres、MySQL 真库）、persist-mongo 83 条（真库）全绿。变异检验 5 处全被抓到：整条判据去掉（6 条红）、只看名字不看启动时刻（8 条红）、只看启动时刻不看名字（2 条红）、只改 `listStale` 忘了 `acquire`（2 条红）、Mongo 那份去掉判据（3 条红）。

### U2 · 数据层换 Kysely（仍只有 SQLite）

- **目标**：行为跟现在一模一样，底下换成 Kysely + persist-kysely。见[技术方案 §2](../tech/unified-demo.md#_2-数据层)。
- **涉及**：
  - `db/`：删 drizzle 的 schema 和迁移，新写 Kysely 的类型、迁移和按需建连。
  - `auth.ts`：改用 Kysely 适配器，打开 `rateLimit.storage: 'database'`。
  - 三个 store、`routes/chat.ts`、`routes/push.ts`、`push/sender.ts`、`push/notifier.ts`、`agent/runtime.ts`：同步改异步。
  - `agent/persistence.ts`：删掉，改用 persist-kysely 和租约。
  - `test/helpers/test-db.ts` 和 8 个碰库的测试文件。
  - 根 `package.json` 的 `chat:bootstrap`。
- **产出**：SQLite 启动时自动建表；认出旧版库文件就报错退出；`db:migrate` 命令。
- **实际**：
  - `db/` 换成三个文件：表类型（`schema.ts`）、建表（`migrations.ts`，Kysely 的 `Migrator`）、建连（`instance.ts`，用到时才真的开库，顺手认旧库）。建表分三段跑：better-auth 的迁移接口 → 本应用 → persist-kysely，顺序不能换（应用的表有外键指向 `user`）。
  - `agent/persistence.ts` 从 658 行缩成 40 行：`kyselyPersistence` + `leaseArbitration`。原先落在 `conversations` 上的队列列与[起轮标记](../../terms.md)列一并删掉，归属改由 `agent_leases` 管。
  - 直接查框架表的只剩两处分组计数，收在 `agent/runko-tables.ts`（理由见[技术方案 §2.5](../tech/unified-demo.md#_2-5-框架的存储改用-persist-kysely)）。
  - 30 处同步读写改异步，波及路由、推送、起轮装配；`onApproval` 与通知的三个入口跟着改成异步。
  - `kysely/migration` 是 0.29 的子路径导出，不在包根上——`import { Migrator } from 'kysely'` 会在运行时报「没有这个导出」，类型检查看不出来。
- **验收结论**：✅ node-server 402 条测试全绿（含新增的旧库守门 2 条）；全仓 `typecheck`/`build`/`test` 与 `lint`、文档三项检查全通过。实测：全新库启动自动建出 14 张表（better-auth 5 + 应用 3 + 框架 4 + 迁移记录 2）；指向旧版库文件时当场报错退出、一个字都没写。

### U3 · 零配置

- **目标**：不填任何 key，从注册到审批、提问走一遍。见[技术方案 §4](../tech/unified-demo.md#_4-零配置)。
- **涉及**：
  - 服务端：`agent/model.ts`（演示模型）、`agent/sandbox-manager.ts`（`local` provider、初始化钩子、快照）、`agent/github-repo.ts`、`agent/chat-agent.ts`（本地版提示词）、`routes/chat.ts`（配置接口、建会话）、`schemas/chat.ts`。
  - 前端：`apps/web` 的 schema、建会话弹窗、会话页、分支栏、详情弹窗、准备中视图、登录页。
  - 其他：`.env.template`、`openapi.yml` 与 `apps/web/src/gen` 重新生成、chat 应用的 README。
- **产出**：演示模型（`run:` / `ask:` / 复述）；本地沙盒加快照表；`GET /api/chat/config`；`GET /api/auth-config`。
- **实际**：演示模型把「这一步产出什么」抽成 `demoStreamFor(prompt)`，测试直接喂提示词，不必绕过 AI SDK 的类型；本地沙盒的快照带版本号，跨进程与跨副本都验了；`usesGit=false` 让建盒后的 git/skill 三步整段跳过。前端的沙盒选项改由 `/api/chat/config` 驱动，拿不到配置时退到只有本地一档。
- **验收结论**：✅ 服务端新增 3 个测试文件（演示模型 7 条、本地沙盒 6 条、零配置端到端 5 条），前端 323 条全绿。**零配置端到端实测**：一个 key 都不配，建会话落到本地沙盒、`run: cat /README.md` 真的跑了、危险命令弹审批、批准后结清——全在测试里跑通（`test/routes/zero-config.test.ts`）。

### U4 · Postgres

- **目标**：配了 `DATABASE_URL` 就跑在 Postgres 上。见[技术方案 §5](../tech/unified-demo.md#_5-postgres)。
- **涉及**：`db/` 的方言选择和 int8 解析、迁移的列类型分支、store 测试的双库参数化。
- **实际**：方言在 `db/instance.ts` 一处分叉（配了 `DATABASE_URL` 就是 Postgres）；pg 连接池就地配 int8 解析器，毫秒时间戳读回来是数字不是字符串。新增 `test/db/dialects.test.ts`：同一批读写（建表、会话往返、null 的仓库/分支、推送 upsert、会话级授权）在 SQLite 与 pglite 上各跑一遍。
- **验收结论**：✅ 两种库各 5 条全绿；对着真 Postgres 跑 `db:migrate`，15 张表（better-auth 5 + 应用 4 + 框架 4 + 迁移记录 2）建好。

### U5 · 多副本

- **目标**：Postgres 上开多个副本，请求打到哪个都行。见[技术方案 §6](../tech/unified-demo.md#_6-多副本)。
- **涉及**：
  - 路由：转发器（从 persist-demo 搬过来，加上复制 cookie）、`routes/chat.ts` 七类要转发的请求、`push/presence.ts` 进库、`/health` 与 `…/activity`。
  - 构建：`build` 与 `start`；启动时不再写 `openapi.yml`。
  - 验证环境：`docker/` 下的 Dockerfile、`compose.yml`（含一次性的 `migrate` 服务）、`nginx.conf`，以及 `lab:*` 脚本。
- **实际**：转发写成**中间件**而不是写在各处理器里——处理器的返回类型被 OpenAPI 路由定义钉死，而转发要原样交回上游那条响应（含 SSE 流），写在里面只能靠类型断言绕过。会话归属改由持有者再查一遍（它跑的是同一份代码）。发消息那条也走中间件先转；框架仍报 `held_by_other` 的窄竞态回 503 让客户端重试。日志行格式抽成 `formatLogLine` 导出，验证环境才能把测试步骤与各容器日志合并成一条时间线。
- **验收结论**：✅ 转发 8 条单测（cookie、环路、令牌、连不上、不开口、身份解析）；在场跨副本单测；编译产物起得来（`/health` 与 `/api/auth-config` 实测 200）。

### U6 · 搬测试

- **目标**：原 persist-demo 的真进程测试在 node-server 上全部跑通。见[技术方案 §7](../tech/unified-demo.md#_7-测试怎么搬)。
- **涉及**：`apps/node-server/test/e2e/`（多副本、挂起恢复、docker 验证环境）、日志合并脚本及其测试、`.github/workflows/ci.yml`。
- **实际**：搬的时候逮到两个缺口：① `RUNKO_HEARTBEAT_MS` / `RUNKO_TAKEOVER_MS` 没接到仲裁实现上——文档与验证环境都按「生效」写的，实际走的是 60 秒缺省值；② 数据库驱动在模块顶层就加载，于是跑 Postgres 的容器也要求 SQLite 的原生模块装得起来（arm64 的 alpine 上装不起来）。都已修。
- **一处测试本身的坑**：多副本那条「冻住旧持有者」的用例，原先在冻结期间反复发消息等接管——那些请求被转发给冻住的副本，**它的内核照样完成握手、把请求收进缓冲区**，一解冻就挨个处理，凭空多跑四轮。改成先等租约过期再发第一条。
- **验收结论**：✅ 真进程 8 条（多副本 4 + 挂起恢复 4）本地用共享 SQLite 文件跑绿；变异检验：注释掉转发中间件，两条用例当场变红。CI 多一步用真 Postgres 再跑一遍。

### U7 · 删 persist-demo

- **目标**：仓库里不再有它，也没有指向它的地方。见[技术方案 §8](../tech/unified-demo.md#_8-删-persist-demo-的清单)。
- **涉及**：`apps/persist-demo/`、`.gitignore`、`CLAUDE.md`、三个 persist 包的 README、11 份文档、术语表的「多副本验证环境」词条。另外修正多副本技术方案里跟代码对不上的三处（见[技术方案 附录 C](../tech/unified-demo.md#附录-c-多副本技术方案里跟代码对不上的三处)）。
- **验收结论**：✅ 目录删掉；`grep -r persist-demo` 只剩施工进展里的历史记录（页面顶部已注明它已并入并删除）与 CHANGELOG；仓库拓扑表与成员计数已更新；`docs:check`、`docs:build`、`check:doc-links` 全过。

### U8 · 收尾

- 全仓 `pnpm -r build|typecheck|test`、`pnpm lint`、文档三项检查：✅ 全通过。
- 验证方案与实测结果：见下方两节。
- **一轮独立代码审查**：结论「可以交付」，提了 5 条（2 中等 3 轻微），**全部已修**：

| # | 问题 | 会怎么出错 | 怎么修的 |
|---|---|---|---|
| 1 | Postgres 连接池没挂 `error` 监听 | 主备切换、服务端掐空闲连接、网络抖动都会让池子在**没有查询在跑**时抛错；没人接住 = 整个副本进程退出。SQLite 档与 pglite 测试都碰不到这条 | 挂上监听，记一行 warn；坏连接由池子自己丢掉 |
| 2 | 换 Kysely 时丢了 `conversation_grants` 的外键级联，注释却还写着「会话删除即随级联清」 | 今天没有删会话的路由，所以是休眠的；但以后加了就会留孤儿行 | 选择**不补外键**（按会话挂的表一律不建，与框架那四张对齐），改成如实描述，并写清将来删会话要清哪几张表 |
| 3 | 转发前不查会话归属，与技术方案 §6.2 写的不符 | 没有安全洞（持有者会再查一遍），但别人的会话会白转一次 | 中间件里补上归属检查 |
| 4 | 4 个测试里漏了 `await`（数据库调用刚改成异步） | 今天靠 better-sqlite3 同步落库侥幸通过；换异步驱动就会读到旧值 | 补齐 |
| 5 | 零配置那条审批用例只断言「裁决不再 pending」 | 写下答复就会让它出 pending，跟命令有没有执行无关——等于没测到「批准后才执行」 | 改成断言账本里出现工具结果、这一轮收了尾 |

## 验证方案

分三档：**自动跑的**（CI 与本地都跑）、**要 docker 的**（本地手动跑一次）、**要人眼看的**（浏览器）。

### 一、自动跑的（`pnpm -r test`）

| 验什么 | 在哪 |
|---|---|
| 零配置：一个 key 都不配，建会话 → `run:` 真的跑了命令 → 危险命令弹审批 → 批准后结清 | `apps/node-server/test/routes/zero-config.test.ts` |
| 演示模型：指令认得准、上一条是工具结果就收尾（恢复轮不重复执行） | `test/agent/demo-model.test.ts` |
| 本地沙盒：快照跨进程恢复、别的副本改过后自己的缓存作废、坏快照不炸 | `test/agent/local-sandbox.test.ts` |
| 两种库同一批读写（毫秒时间戳、upsert、null） | `test/db/dialects.test.ts` |
| 转发四条防线：cookie、环路、副本间令牌、失联回 503 | `test/routes/forward.test.ts` |
| 在场跨副本 | `test/push/presence.test.ts` |
| 多副本与挂起恢复（两个真进程共用一个库） | `test/e2e/` |
| 租约「同名重启立刻回收」 | 四种真库上的一致性套件 |

### 二、要 docker 的（本地手动跑一次）

```sh
pnpm --filter @runko-chat/node-server test:lab     # 自带起停：跑完就把环境删掉
```

八个故障场景（并发抢占、SSE 经非持有者、停止转发、数据库卡顿、`kill -9` 接管、重启扫描、
冻住持有者、网络分区）。日志留在 `apps/node-server/logs/lab-<时间>/`。

### 三、要人眼看的（浏览器）

服务要你来起（`pnpm chat:server` + `pnpm chat:web`）。依次确认：

1. **零配置**：不填任何 key，注册 → 新建会话（沙盒只有「本地」一项）→ 顶部有「演示模型」标记。
2. 发 `run: ls -la` → 出现工具卡片与命令输出。
3. 发 `run: rm -rf dist` → 弹审批卡片 → 点「允许」→ 命令执行。
4. 发 `ask: 用 A 还是 B？` → 弹提问卡片 → 回答 → 这一轮接着跑。
5. 把 `CHAT_SUSPEND_MEMORY_WINDOW` 设成 `20000` 重启，重复第 3 步但不点按钮：20 秒后这一轮挂起，
   卡片仍可点，点完接着跑；会话列表出现「等你」。
6. 本地沙盒的会话不显示仓库、分支与「休眠」。

### 实际结果（2026-09-22）

**一、自动跑的**：✅

| 包 | 结果 |
|---|---|
| `@runko-chat/node-server` | 448 条（不含端到端）+ 真进程端到端 8 条，全绿 |
| `@runko-chat/web` | 323 条全绿 |
| `packages/*` | 全绿；四种真库上的一致性套件：kysely 273、Mongo 83、SQLite 69 |
| 全仓 | `pnpm -r build` / `typecheck` / `lint` / `docs:check` / `docs:build` / `check:doc-links` 全通过 |

**变异检验**：注释掉转发中间件 → 多副本场景①与挂起恢复场景④当场变红；去掉租约的「同名重启」判据 → 一致性套件 6 条红。

**二、要 docker 的**：✅ `test:lab` 9 条全绿，168 秒（一个 Postgres + 三个 chat 应用副本 + nginx，跑完自动删环境）：

| 场景 | 验的是 |
|---|---|
| S0 | 在 A 注册的 cookie，B 与 C 直接认（登录态不绑单个副本） |
| S1 | 并发抢占：同时打到两个副本，一个起轮、一个转发后排队 |
| S2 | SSE 经非持有者与 nginx 订阅，第一帧在一轮跑完之前就到（没被缓冲） |
| S3 | 停止打到非持有者 → 转给持有者，这一轮以「已停止」收尾 |
| S4 | 数据库卡顿 1 秒：这一轮不受影响 |
| S5 | 持有者 `kill -9`：先 503（很快，不是挂着），过接管阈值后别的副本起轮，崩溃那一轮补上「已停止」 |
| S6 | 持有者 `kill -9` 后**立刻重启它**：启动扫描当场收拾（这就是 U1 那条判据） |
| S7 | 持有者被冻住：转发在超时附近回 503；接管后老持有者解冻，账本一行不多 |
| S8 | 网络分区：没人接管它也会自己停手；之后别的副本接管，账本没写坏 |

期间逮到两个真问题：**并发发消息会丢**（S1，已修：就地转发）、**注册被拒**（容器里是生产模式，better-auth 要求带来源头）。

**三、要人眼看的**：**还没做**——服务要你来起（`pnpm chat:server` + `pnpm chat:web`）。这一档的六步在上面。

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-09-19 | U0：三份文档初稿；术语表登记「本地沙盒」「演示模型」 |
| 2026-09-22 | U1 完成：租约陈旧判据加「同名重启」一支，两个存储包 + 一致性套件；归属仲裁技术方案补 §4.4 |
| 2026-09-22 | U2 完成：node-server 数据层换 Kysely，框架的四张表交给 `@runko/persist-kysely`；旧库守门；技术方案 §2.3/§2.5 按实现回填 |
