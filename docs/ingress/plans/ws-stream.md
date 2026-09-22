---
title: "WebSocket 直播流（ws-stream）— 施工进展"
slug: ws-stream
view: 施工
layer: 接入层
module: —
packages: ["@runko-chat/node-server", "@runko-chat/web"]
tags: ["WebSocket", "直播流", "施工"]
related: ["ingress/features/ws-stream.md", "ingress/tech/ws-stream.md", "host/node/plans/cluster-lab.md"]
---
# WebSocket 直播流 — 施工进展

> 术语见 [术语表](../../terms.md)。[功能手册](../features/ws-stream.md) · [技术方案](../tech/ws-stream.md)。

## 当前状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| W0 | 三份文档 | ✅ |
| W1 | 服务端：`GET …/ws` 端点（`@hono/node-ws`） | ⬜ |
| W2 | 前端：可切换的通道实现（`VITE_CHAT_TRANSPORT`） | ⬜ |
| W3 | 测试：两条通道跑同一批断言 | ⬜ |

这一组是[集群实验环境](../../host/node/plans/cluster-lab.md)的 C3，可以与 Redis 那两步并行——它不依赖 Redis，单副本下就能验。

## 各阶段

### W1 · 服务端端点

- **目标**：`GET /api/chat/conversations/{id}/ws?after=<seq>` 升级成 WebSocket，推的帧与 SSE 完全相同。见[技术方案 §3](../tech/ws-stream.md#_3-服务端)。
- **涉及**：`src/routes/chat.ts`（端点 + 可选的 `upgradeWebSocket` 依赖）、`src/index.ts`（`injectWebSocket`）、`package.json`（`@hono/node-ws`）。
- **验收**：鉴权与归属检查照旧；连接关掉时订阅要收掉；生成器结束就正常关连接。

### W2 · 前端通道

- **目标**：一个环境变量切换 SSE / WebSocket，上层的重连与续传逻辑一字不改。
- **涉及**：`features/chat/ws.ts`（新）、`features/chat/api.ts`、`use-chat-messages.ts`、`vite.config.ts`（代理开 `ws: true`）。

### W3 · 测试

- 服务端：WebSocket 端点的集成测试（回放 + 直播 + 关闭）。
- 前端：通道实现的单测（正常关闭 resolve、异常关闭 reject、abort 不算错）。
- 集群里的对照见 [cluster-lab · C5](../../host/node/plans/cluster-lab.md)。

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-09-22 | W0：三份文档 |
