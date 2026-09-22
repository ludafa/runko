# @runko/stream-redis

**[流分发](https://github.com/ludafa/runko/blob/main/docs/terms.md)的 Redis 实现**——多副本部署时，把 agent 正在产生的内容广播给所有副本。

于是「看直播」这件事**连到哪个副本都行**：不用把连接转给正在跑这一轮的那个进程。

```ts
import { createAgentRuntime } from '@runko/agent';
import { redisFanout } from '@runko/stream-redis';
import { createClient } from 'redis';

const publisher = createClient({ url: process.env.REDIS_URL });
await publisher.connect();
// 订阅要一条独立连接：Redis 的连接进入订阅模式后不能再发普通命令。
const subscriber = publisher.duplicate();
await subscriber.connect();

createAgentRuntime({
  agent,
  prepareTurn,
  persistence,
  arbitration,
  stream: redisFanout({
    publisher,
    subscriber,
    nodeId: process.env.RUNKO_NODE_URL ?? 'local',
  }),
});
```

## 三件要知道的事

- **`subscribe` 是同步的**（接口的硬约束）：调用方要写出「挂订阅 → 取进行中草稿快照」中间不留缝的那段代码。这里的做法是本地登记簿同步挂上、Redis 的 `SUBSCRIBE` 在后台补；这中间到达的远端帧会漏，客户端重连时从账本回放补齐。
- **发布先走本地回环**：本进程的订阅者同步拿到，再广播给别人；收到自己发的会丢掉，不会收两遍。所以 `nodeId` 每个进程要唯一。
- **Redis 挂了不影响这一轮**：发布失败只记一行日志。直播内容是尽力而为的，事实来源永远是账本。

## 它不做什么

- **不是存储**：没有保留窗口、没有游标、不能重放历史。历史读账本（`@runko/persist-*`）。
- **不管连接生命周期**：客户端由你创建、连接、关闭——与 `@runko/persist-*` 吃驱动实例同一个姿态。

跑得起来的例子：`apps/node-server`（chat 应用）的集群实验环境，见
[集群实验环境 · 技术方案](https://github.com/ludafa/runko/blob/main/docs/host/node/tech/cluster-lab.md)。
