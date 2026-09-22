---
title: "集群实验环境（cluster-lab）— 施工进展"
slug: cluster-lab
view: 施工
layer: 宿主层
module: —
packages: ["@runko-chat/node-server", "@runko/stream-redis"]
tags: ["多副本", "集群", "Redis", "流分发", "施工"]
related: ["host/node/features/cluster-lab.md", "host/node/tech/cluster-lab.md", "ingress/plans/ws-stream.md"]
---
# 集群实验环境 — 施工进展

> 术语见 [术语表](../../../terms.md)。[功能手册](../features/cluster-lab.md) · [技术方案](../tech/cluster-lab.md)。

## 当前状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| C0 | 三份文档（本篇 + WebSocket 那一组） | ✅ |
| C1 | 新包 `@runko/stream-redis`：Redis 版[流分发](../../../terms.md) | ⬜ |
| C2 | node-server 接上：`REDIS_URL` 一配就广播；直播流不再转发 | ⬜ |
| C3 | WebSocket 直播流（见 [ws-stream · 施工](../../../ingress/plans/ws-stream.md)） | ⬜ |
| C4 | 集群 compose：nginx 统一入口 + 1–5 副本 + Postgres + Redis | ⬜ |
| C5 | 集群端到端测试：租约 5 条 + WebSocket 3 条 | ⬜ |
| C6 | 验证方案、实测、代码审查 | ⬜ |

**顺序**：C1 → C2 → C3 → C4 → C5 → C6。C3 可以与 C1/C2 并行（它不依赖 Redis，单副本下也能验）。

## 各阶段

### C1 · `@runko/stream-redis`

- **目标**：实现框架的 `StreamFanout`，一个会话一个频道，发布带发布者名字、收到自己发的丢掉。见[技术方案 §2](../tech/cluster-lab.md#_2-redis-版流分发-新包-runkostream-redis)。
- **涉及**：新包（`src/index.ts` + README + 构建配置）、catalog 加 `redis` 依赖、changeset。
- **验收**：单测覆盖——本地回环是同步的（挂订阅与取快照之间零空隙）、跨实例收得到、自己发的不收两遍、Redis 挂了 publish 不抛、脏消息丢掉不断订阅。

### C2 · node-server 接上

- **目标**：配了 `REDIS_URL` 就用 Redis 广播；此时直播流不再转发给持有者。
- **涉及**：`src/agent/runtime.ts`（装配 `stream`）、`src/routes/chat.ts`（转发路径按有没有 Redis 分档）、`.env.template`。
- **验收**：有无 Redis 两档各一条单测；转发清单的单测跟着更新。

### C4 · 集群 compose

- **目标**：`CLUSTER_REPLICAS=1|3|5` 都能起；nginx 同一个端口吃 HTTP 与 WebSocket。
- **涉及**：`docker/cluster.compose.yml`、`docker/cluster.nginx.conf`、`cluster:up` / `cluster:down` 脚本、副本自报主机名的启动方式。
- **验收**：三种副本数各起一次，nginx 入口能建会话、能看直播。

### C5 · 集群端到端

- **目标**：[功能手册 §4](../features/cluster-lab.md#_4-这套环境回答什么) 的 8 条各一条用例，跑完即退。
- **涉及**：`test/e2e/cluster.e2e.test.ts`（`RUNKO_TEST_CLUSTER=1` 门禁，不进 CI）。

### C6 · 收尾

- 全仓检查、验证方案与实测、一轮独立代码审查。

## 验证方案

开发完成后填写。

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-09-22 | C0：功能、技术、施工三份文档 |
