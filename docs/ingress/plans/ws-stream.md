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
| W1 | 服务端：`GET …/ws` 端点（`@hono/node-ws`） | ✅ |
| W2 | 前端：两条通道并存 + 设置页里的开关 | ✅ |
| W3 | 测试：两条通道跑同一批断言 | ✅ |

这一组是[集群实验环境](../../host/node/plans/cluster-lab.md)的 C3，可以与 Redis 那两步并行——它不依赖 Redis，单副本下就能验。

## 各阶段

### W1 · 服务端端点

- **目标**：`GET /api/chat/conversations/{id}/ws?after=<seq>` 升级成 WebSocket，推的帧与 SSE 完全相同。见[技术方案 §3](../tech/ws-stream.md#_3-服务端)。
- **涉及**：`src/routes/chat-ws.ts`（新，单独一个子应用）、`src/app.ts`（造 `upgradeWebSocket` 并挂载）、`src/index.ts`（`injectWebSocket`）、`package.json`（`@hono/node-ws`）。
- **与计划的偏差**：端点没有写进 `chat.ts`。`upgradeWebSocket` 必须由顶层 app 造出来（升级发生在 HTTP 服务器那一层），而顶层 app 又要挂载这些路由——分成两个文件才不打结。
- **验收**：鉴权与归属检查照旧；连接关掉时订阅要收掉；生成器结束就正常关连接。

### W2 · 前端通道

- **目标**：用户在设置页选 SSE / WebSocket，上层的重连与续传逻辑一字不改。
- **涉及**：`features/chat/ws.ts`（新）、`features/chat/transport.ts`（新，存这台设备的选择）、`pages/settings.tsx` + `routes/_app/settings.tsx`（新）、`layouts/app-layout.tsx`（顶栏加入口）、`use-chat-messages.ts`、`vite.config.ts`（代理开 `ws: true`）。
- **与计划的偏差**：原计划是一个构建期环境变量（`VITE_CHAT_TRANSPORT`）。改成**用户设置**——对照要的是「同一套部署、同一个账号，切一下就能比」，构建期的开关做不到这件事，还得重起前端。

### W3 · 测试

实际落地（共 25 条，全绿）：

| 文件 | 守什么 |
|---|---|
| `node-server/test/routes/chat-ws.test.ts` | 端点：连上回放完正常关（1000）、别人的会话连不上（4004）、一轮跑起来的内容真推过来 |
| `web/…/__tests__/ws.test.ts` | 通道：地址与 `after`、帧交给上层、1000 resolve / 1006 reject / abort 不算错、坏帧丢掉不断流 |
| `web/…/__tests__/transport.test.ts` | 选择：缺省与坏值回落 SSE、存不进去也照常用、一改就通知订阅者 |
| `web/…/__tests__/transport-switch.test.ts` | 接线：选什么连什么、中途改设置就换（旧连接断掉、新连接带着水位） |
| `web/src/pages/__tests__/settings.test.tsx` | 设置页：点了真的换，打开时显示的是上次选的那一档 |

集群里的对照见 [cluster-lab · C5](../../host/node/plans/cluster-lab.md)。

## 验证方案

### 一、自动用例（跑完即退）

| 跑什么 | 覆盖 | 预期 |
|---|---|---|
| `pnpm --filter @runko-chat/node-server test` | `test/routes/chat-ws.test.ts`：端点回放、别人的会话连不上、直播真推过来 | 全绿 |
| `pnpm --filter @runko-chat/web test` | 通道实现、选择的存取、切换接线、设置页 | 全绿 |
| `pnpm --filter @runko-chat/node-server test:cluster` | 集群里的三条（任意副本都能看、断线带 `after` 重连、Redis 挂掉不影响这一轮） | 8 条全绿，见 [cluster-lab · 验证方案](../../host/node/plans/cluster-lab.md#验证方案) |

### 二、浏览器走查（**要人来做**）

单副本就能验大部分：

```sh
pnpm chat:server    # 一个终端
pnpm chat:web       # 另一个终端
```

1. 建会话，发一条长消息 —— 内容一小段一小段出来（此时走 SSE，默认）。
2. 顶栏 `Settings` → 切成 **WebSocket** → 回会话页：**正在跑的那一轮不中断**，继续往下出字（切换会重连一次，带着「我看到第几条了」）。
3. 刷新页面 → 仍在 WebSocket 档，能接上还在跑的那一轮。
4. 切回 **SSE**，重复 1–3，表现应当一模一样。
5. 开两个标签页，一个走 SSE、一个走 WebSocket，看同一条会话 —— 内容应当一致。

多副本下的走查见 [cluster-lab · 验证方案](../../host/node/plans/cluster-lab.md#验证方案) 第三层。

## 实测结果

| 时间 | 跑了什么 | 结果 |
|---|---|---|
| 2026-09-22 | 上面第一层全部自动用例 | 全绿（WebSocket 相关 25 条 + 集群 8 条） |
| — | 浏览器走查 | **待做**（要人来点） |

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-09-22 | W0：三份文档 |
| 2026-09-22 | W1–W3 完成。开关从构建期环境变量改成设置页里的用户选择（理由见 W2） |
