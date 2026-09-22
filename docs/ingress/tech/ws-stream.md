---
title: "WebSocket 直播流（ws-stream）— 技术方案"
slug: ws-stream
view: 技术
layer: 接入层
module: —
packages: ["@runko-chat/node-server", "@runko-chat/web"]
tags: ["WebSocket", "直播流", "SSE", "断线续传", "Hono"]
related: ["ingress/features/ws-stream.md", "ingress/plans/ws-stream.md", "ingress/tech/chat-webapp.md", "host/node/tech/cluster-lab.md"]
---
# WebSocket 直播流 — 技术方案

> 术语见 [术语表](../../terms.md)。要做什么见[功能手册](../features/ws-stream.md)；拆单见[施工](../plans/ws-stream.md)。

## 1. 一句话

**换壳不换内容**：服务端多一个 WebSocket 端点，推的帧与 SSE 那条一模一样；前端多一个通道实现，一个环境变量切换。

## 2. 为什么能这么省

现有的 SSE 处理器只做一件事：把 `runtime.subscribe()` 吐出来的帧序列化。断线续传、[进行中草稿](../../terms.md)快照、「先挂订阅再回放」的顺序，全在框架里。

```ts
for await (const frame of runtime.subscribe(id, { after, signal })) {
  await stream.writeSSE({ event: nameOf(frame), data: JSON.stringify(frame) });
}
```

WebSocket 那条就是把最后一行换成 `ws.send(JSON.stringify(frame))`。**所以两条通道不可能长歪**——它们吃的是同一个生成器。

## 3. 服务端

### 3.1 端点

```
GET /api/chat/conversations/{id}/ws?after=<seq>   （升级成 WebSocket）
```

- **鉴权照旧**：升级请求本身就是一个带 cookie 的 GET，现有的 `requireAuth` 中间件原样生效；会话归属也照查，不是你的就 404（不升级）。
- **只推不收**：客户端发来的消息一律忽略（这一批不做双向，见功能手册的非目标）。
- **连接关掉时** abort 掉 `subscribe`，别让生成器挂着。

### 3.2 用 `@hono/node-ws`

Hono 自己不带 Node 的 WebSocket 实现，官方适配器是 `@hono/node-ws`（底层 `ws`）。它要在**建 HTTP 服务器之后**把升级处理注进去：

```ts
const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
const server = serve({ fetch: app.fetch, port });
injectWebSocket(server);
```

于是路由注册与服务器启动之间多了一条依赖：`upgradeWebSocket` 要在建路由时就有。做法是把它作为一个**可选依赖**传给 `createChatApp`——不传就不注册 WebSocket 端点（测试里大多数用例用不上它，也不该为它拉起一个真服务器）。

### 3.3 帧的形状

与 SSE 完全相同（`ChatReplayFrame`），**没有额外的信封**：

- SSE 那边有 `event:` 行，是协议要求的；WebSocket 没这回事，直接发 JSON 正文。
- 前端本来就**靠结构分辨**四种帧（带 `chunk` / `message` / `queue` / `turnActive` 中的哪一个），不靠事件名。所以两条通道的解析代码是同一份。

### 3.4 关闭时机

生成器结束就关连接（`close(1000)`）——与 SSE 「一轮结束就关流」同一个语义。前端据此决定要不要重连（见 §4.2）。

## 4. 前端

### 4.1 一个开关

```ts
// VITE_CHAT_TRANSPORT=ws | sse（不配 = sse）
export const chatTransport = import.meta.env.VITE_CHAT_TRANSPORT === 'ws' ? 'ws' : 'sse';
```

调用点只有一个（`use-chat-messages.ts` 里那条「连直播尾巴」），两个实现签名相同：

```ts
type TailStreamer = (
  conversationId: string,
  after: number,
  handlers: ChatFrameStreamHandlers,
  signal?: AbortSignal,
) => Promise<void>;
```

### 4.2 WebSocket 版要自己做的三件事

SSE 由浏览器内建负责的几样，WebSocket 得自己来：

| 事 | 怎么做 |
|---|---|
| **地址** | 把页面地址的 `http(s)` 换成 `ws(s)`，路径用 `/api/chat/conversations/:id/ws?after=`。开发时前端与服务端不同端口，Vite 的代理要打开 `ws: true` |
| **结束与失败的区分** | 正常关闭（code 1000）当作「流结束了」resolve；其余关闭与错误 reject——上层那套重连逻辑原样复用，不用改 |
| **主动取消** | 传进来的 `signal` 一 abort 就 `close()`，并且**不再 reject**（与 SSE 那条一致：主动取消不是错误） |

重连的退避、以及「连上时带上看到的最后一个 seq」都在上层，两条通道共用。

## 5. 与集群的关系

在[集群实验环境](../../host/node/tech/cluster-lab.md)里，WebSocket 连到哪个副本都能收到内容——靠 Redis 广播，不靠转发。nginx 那边要配升级头（见那份方案 §4）。

单副本部署下没有 Redis，WebSocket 走的还是进程内那份流分发，行为与 SSE 一致。

## 6. 已知限制

- **中途连上会缺一小段**：这一轮已经说出去的话在持有者内存里。连到持有者本人没事（框架会把草稿快照补给你），连到别的副本就要等这一轮收尾时那条完整消息。这是集群那份方案 §6 的同一条，不是 WebSocket 特有的。
- **只推不收**：这一批不做双向，客户端发来的帧被忽略。
- **没有心跳**：一条安静的连接靠 nginx 的 `proxy_read_timeout`（配成 1 小时）撑着。真要长时间空连接，下一批再加 ping/pong。
