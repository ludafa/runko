---
title: "WebSocket 直播流（ws-stream）— 功能手册"
slug: ws-stream
view: 功能
layer: 接入层
module: —
packages: ["@runko-chat/node-server", "@runko-chat/web"]
tags: ["WebSocket", "直播流", "SSE", "断线续传", "chat 应用"]
related: ["ingress/tech/ws-stream.md", "ingress/plans/ws-stream.md", "host/node/features/cluster-lab.md", "ingress/features/chat-webapp.md"]
---
# WebSocket 直播流 — 功能手册

> 术语见 [术语表](../../terms.md)。技术方案见 [ws-stream · 技术](../tech/ws-stream.md)，施工见 [ws-stream · 施工](../plans/ws-stream.md)。

## 一句话

**[直播流](../../terms.md)多一条通道：WebSocket。** 与现有的 SSE 并存，一个开关切换，好让我们在同一套集群里对照着看哪种更合适。

## 1. 为什么要另做一条

现在服务端往前端推内容走的是 SSE（一条单向的 HTTP 长连接）。它够用，但有三处不痛快：

| SSE 的问题 | WebSocket 那边 |
|---|---|
| 只能服务端往前端推。前端想说话得另发 HTTP 请求 | 天生双向。**这一批不用它的双向**，但这是将来最主要的理由 |
| 每条流都是一个 HTTP 请求，代理与网关各有各的缓冲脾气 | 升级之后是一条裸连接，代理的行为更一致 |
| 浏览器对同一域名的并发连接数有限（HTTP/1.1 下 6 条） | 不占那个额度 |

反过来，SSE 也有 WebSocket 没有的好处：断线自动重连是浏览器内建的、能被普通 HTTP 缓存与日志看懂。**所以这一批不是替换，是并排放着做对照。**

## 2. 用起来是什么样

对用户来说**什么都没变**：同一个界面、同一份内容、同样能刷新续上。

对开发者：

```sh
# 前端用哪条通道（不配 = sse）
VITE_CHAT_TRANSPORT=ws pnpm chat:web
```

服务端两条都开着，不用配。

## 3. 保证什么

1. **内容一字不差**：两条通道送的是同一串帧，前端的处理代码完全一样。
2. **能接着看**：连上时带「我看到第几条了」，服务端先补齐落下的，再接直播——与 SSE 同一套[断线续传](../../terms.md)。
3. **连到哪个副本都行**（集群里）：这一轮跑在别的副本上也收得到，见[集群实验环境](../../host/node/features/cluster-lab.md)。
4. **连接断了会自己重连**：SSE 由浏览器负责，WebSocket 这一侧由前端自己做（退避重试），用户看不出差别。

## 4. 范围

**做：** 服务端一个 WebSocket 端点（只推内容，不收命令）；前端一个可切换的通道实现；两条通道共用一套断线续传与帧处理。

**不做（非目标）：**

- **不用 WebSocket 发消息/答审批/停止**——那些继续走 HTTP POST。等这一批的结论出来再决定要不要做双向。
- **不删 SSE**。对照期结束前两条都留着。
- **不做自定义协议**：帧的形状与 SSE 那条完全一样，只是外面的壳不同。

## 5. 成功标准

1. `VITE_CHAT_TRANSPORT=ws` 下，一轮对话的内容、审批卡片、挂起与恢复的表现与 SSE 完全一致。
2. 断开连接（杀副本、断网）后能自己重连并补齐落下的内容。
3. 在[集群实验环境](../../host/node/features/cluster-lab.md)里，经 nginx 连到任意副本都能看到正在跑的那一轮。
