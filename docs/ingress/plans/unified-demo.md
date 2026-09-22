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
| U5 | 多副本：转发、在场进库、镜像与验证环境 | ⬜ |
| U6 | 把 persist-demo 的真进程测试搬过来，接进 CI | ⬜ |
| U7 | 删 persist-demo，清理文档 | ⬜ |
| U8 | 验证方案、端到端实测、代码审查 | ⬜ |

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
- **验收**：转发的单测（非持有者转给持有者、带 cookie、成环回 503、持有者连不上回 503）；在场状态跨副本的单测。

### U6 · 搬测试

- **目标**：原 persist-demo 的真进程测试在 node-server 上全部跑通。见[技术方案 §7](../tech/unified-demo.md#_7-测试怎么搬)。
- **涉及**：`apps/node-server/test/e2e/`（多副本、挂起恢复、docker 验证环境）、日志合并脚本及其测试、`.github/workflows/ci.yml`。
- **验收**：本地用共享 SQLite 文件跑绿；CI 用 Postgres 跑绿；`test:lab` 在 docker 上跑绿（要你起 docker 验证环境）。

### U7 · 删 persist-demo

- **目标**：仓库里不再有它，也没有指向它的地方。见[技术方案 §8](../tech/unified-demo.md#_8-删-persist-demo-的清单)。
- **涉及**：`apps/persist-demo/`、`.gitignore`、`CLAUDE.md`、三个 persist 包的 README、11 份文档、术语表的「多副本验证环境」词条。另外修正多副本技术方案里跟代码对不上的三处（见[技术方案 附录 C](../tech/unified-demo.md#附录-c-多副本技术方案里跟代码对不上的三处)）。
- **验收**：`grep -r persist-demo`（不含构建产物和 CHANGELOG）为空；`pnpm install` 后锁文件里没有它；`docs:check`、`docs:build`、`check:doc-links` 通过。

### U8 · 收尾

- 全仓 `pnpm -r build|typecheck|test`、`pnpm lint`、文档三项检查。
- 写本文的「验证方案」一节：运行步骤、用例、预期与实际。
- 一轮代码审查，问题修完再交。

## 验证方案

开发全部完成后填写。

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-09-19 | U0：三份文档初稿；术语表登记「本地沙盒」「演示模型」 |
| 2026-09-22 | U1 完成：租约陈旧判据加「同名重启」一支，两个存储包 + 一致性套件；归属仲裁技术方案补 §4.4 |
| 2026-09-22 | U2 完成：node-server 数据层换 Kysely，框架的四张表交给 `@runko/persist-kysely`；旧库守门；技术方案 §2.3/§2.5 按实现回填 |
