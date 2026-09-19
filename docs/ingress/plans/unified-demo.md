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
| U1 | 框架：租约启动时收拾自己名下的旧租约 | ⬜ |
| U2 | 数据层换 Kysely，框架的表换 persist-kysely（仍只有 SQLite） | ⬜ |
| U3 | 零配置：演示模型、本地沙盒、GitHub 可选、配置接口、web | ⬜ |
| U4 | Postgres | ⬜ |
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
| 1 | **旧数据搬不搬？** 新代码用新库文件 `chat.db`，旧的 `data.db` 原样留在磁盘上。不搬的话，你本地的历史会话和账号在新版里看不到，要重新注册 | **不搬**。demo 的数据都是测试对话；导入脚本要 150–250 行，还要转换 better-auth 的日期和字段名（见[技术方案 附录 B](../tech/unified-demo.md#附录-b-顺手但不做的事)） |
| 2 | **U1 的版本级别。** persist-kysely、persist-mongo 的恢复判据多了一支；conformance 多一条用例。已经自己实现了归属仲裁的宿主，跑新版 conformance 时可能多挂一条 | persist-kysely、persist-mongo 标 **patch**（修掉「同名重启要白等 60 秒」，接口不变）；conformance 标 **minor**，changeset 里写明新用例对自写实现的要求 |

## 各阶段

### U1 · 租约启动时收拾自己名下的旧租约

- **目标**：同名进程重启后，`recover()` 立刻收拾上一辈子留下的租约。见[技术方案 §3](../tech/unified-demo.md#_3-租约-启动时收拾自己名下的旧租约-框架小改)。
- **涉及**：`packages/persist-kysely/src/arbitration.ts`、`packages/persist-mongo` 的租约实现、`packages/conformance` 的仲裁用例，以及归属仲裁的技术文档（把新判据写进契约）。
- **产出**：`listStale` / `clearStale` / `acquire` 用同一条新判据；conformance 新用例在四种真库上跑绿；changeset（级别待确认 #2）。
- **验收**：去掉新判据，新用例会失败。

### U2 · 数据层换 Kysely（仍只有 SQLite）

- **目标**：行为跟现在一模一样，底下换成 Kysely + persist-kysely。见[技术方案 §2](../tech/unified-demo.md#_2-数据层)。
- **涉及**：
  - `db/`：删 drizzle 的 schema 和迁移，新写 Kysely 的类型、迁移和按需建连。
  - `auth.ts`：改用 Kysely 适配器，打开 `rateLimit.storage: 'database'`。
  - 三个 store、`routes/chat.ts`、`routes/push.ts`、`push/sender.ts`、`push/notifier.ts`、`agent/runtime.ts`：同步改异步。
  - `agent/persistence.ts`：删掉，改用 persist-kysely 和租约。
  - `test/helpers/test-db.ts` 和 8 个碰库的测试文件。
  - 根 `package.json` 的 `chat:bootstrap`。
- **产出**：`CHAT_DB_PATH`（缺省 `chat.db`）；SQLite 启动时自动建表；误开旧库时启动报错；`db:migrate` 命令。
- **验收**：node-server 现有测试全绿；`typecheck`、`lint` 通过；`chat:bootstrap` 能跑通。

### U3 · 零配置

- **目标**：不填任何 key，从注册到审批、提问走一遍。见[技术方案 §4](../tech/unified-demo.md#_4-零配置)。
- **涉及**：
  - 服务端：`agent/model.ts`（演示模型）、`agent/sandbox-manager.ts`（`local` provider、初始化钩子、快照）、`agent/github-repo.ts`、`agent/chat-agent.ts`（本地版提示词）、`routes/chat.ts`（配置接口、建会话）、`schemas/chat.ts`。
  - 前端：`apps/web` 的 schema、建会话弹窗、会话页、分支栏、详情弹窗、准备中视图、登录页。
  - 其他：`.env.template`、`openapi.yml` 与 `apps/web/src/gen` 重新生成、chat 应用的 README。
- **产出**：演示模型（`run:` / `ask:` / 复述）；本地沙盒加快照表；`GET /api/chat/config`；`GET /api/auth-config`。
- **验收**：演示模型、本地沙盒、快照版本比较都有单测；web 测试覆盖 `local` 这一档；不配 key 时，按[功能手册 §5](../features/unified-demo.md#_5-成功标准) 第 1 条的步骤实测一遍（服务要你来起）。

### U4 · Postgres

- **目标**：配了 `DATABASE_URL` 就跑在 Postgres 上。见[技术方案 §5](../tech/unified-demo.md#_5-postgres)。
- **涉及**：`db/` 的方言选择和 int8 解析、迁移的列类型分支、store 测试的双库参数化。
- **验收**：store 层测试在 SQLite 和 pglite 上都绿；用 CI 的 Postgres 服务（或本地 docker 的 Postgres）跑一遍 `db:migrate` 和路由测试。

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
