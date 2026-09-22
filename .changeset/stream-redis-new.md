---
"@runko/stream-redis": minor
---

新包：**[流分发](https://github.com/ludafa/runko/blob/main/docs/terms.md)的 Redis 实现**。多副本部署时，把 agent 正在产生的内容广播给所有副本——「看直播」连到哪个副本都行，不用把连接转给正在跑这一轮的那个进程。

```ts
stream: redisFanout({ publisher, subscriber, nodeId: process.env.RUNKO_NODE_URL }),
```

- 吃你自己的 Redis 客户端实例（node-redis / ioredis 都对得上），运行时零驱动 import；订阅要一条独立连接。
- **`subscribe` 同步返回**（接口的硬约束）：本地登记簿同步挂上，Redis 的 `SUBSCRIBE` 在后台补。
- 发布先走本地回环、收到自己发的丢掉，所以 `nodeId` 每个进程要唯一。
- **Redis 挂了不影响一轮**：发布失败只记一行，内容照常进账本，客户端重连时回放补齐。
