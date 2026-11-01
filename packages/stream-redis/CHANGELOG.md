# @runko/stream-redis

## 0.2.0

### Minor Changes

- ee83d06: **多副本 + 广播式流分发时，`subscribe` 不再在「这一轮跑在别的副本上」时就地收线。**

  `StreamFanout` 多了一个可选的 `crossInstance` 标志，说明这份实现会不会把别的进程发的帧也送过来（`@runko/stream-redis` 自报 `true`，内置的进程内实现是缺省的 `false`）。框架据它决定要不要继续等：

  - 进程内那一档不变：等也等不到，就地收线，宿主该转发转发、该重连重连。
  - 广播那一档留着等：内容马上从别的副本过来，收尾时那一帧 `activity: false` 同样会到，收线时机与本地一致。

  跟远端这条路自带两道兜底，因为「收尾那一帧一定会到」并不成立：

  - **回放期间收到的收尾广播不会白丢**。帧本身照旧被清掉（紧接着的权威快照会覆盖它），但它带的信息留着——否则正好落在「远端已广播、尚未释放归属」那段窗口里时，订阅方会去等一帧永远不会再来的帧，流就挂死了。
  - **跟远端时定期复查一次归属**。持有者被 `kill -9` 且没人接管时，没有任何进程会广播收尾帧；归属一没就自己补一帧 `activity: false` 收线。

  没有这个标志时，配了 Redis 的多副本部署会静默退化——连到非持有者副本只收到两帧快照流就关了，正在跑的那一轮一个字也看不到。

- 0edd5cc: 新包：**[流分发](https://github.com/ludafa/runko/blob/main/docs/terms.md)的 Redis 实现**。多副本部署时，把 agent 正在产生的内容广播给所有副本——「看直播」连到哪个副本都行，不用把连接转给正在跑这一轮的那个进程。

  ```ts
  stream: redisFanout({ publisher, subscriber, nodeId: process.env.RUNKO_NODE_URL ?? 'local' }),
  ```

  - 吃你自己的 Redis 客户端实例（node-redis / ioredis 都对得上），运行时零驱动 import；订阅要一条独立连接。
  - **`subscribe` 同步返回**（接口的硬约束）：本地登记簿同步挂上，Redis 的 `SUBSCRIBE` 在后台补。
  - 发布先走本地回环、收到自己发的丢掉，所以 `nodeId` 每个进程要唯一。
  - **Redis 挂了不影响一轮**：发布失败只记一行，内容照常进账本，客户端重连时回放补齐。

### Patch Changes

- 6504020: 修复：**Redis 订阅失败会退避重试了**，不再让这个会话永久收不到别的副本的帧。

  以前后台那次 `SUBSCRIBE` 一旦失败（典型场景：订阅正好赶在 Redis 重启的空档里建立），代码只记一行日志就算了。而 node-redis 只在命令成功之后才把监听器登记进自己的订阅表，所以连它重连时的自动 `resubscribe` 也救不回来——这个会话从此只看得到本副本产生的内容，远端帧全丢，而且没有任何告警。

  现在：订阅失败按 200ms 起步、翻倍、封顶 5s 的节奏重试，直到订上，或直到本副本最后一个监听器退订（退订会清掉在等的定时器，不会吊住进程）。每次失败与最终放弃都会 `log.warn` 一行，带上 `conversationId`。`publish` 的行为没动，仍然是尽力而为、失败只记一行。

- Updated dependencies [ee83d06]
- Updated dependencies [4a936b9]
- Updated dependencies [e00ae29]
- Updated dependencies [1489739]
- Updated dependencies [4a936b9]
- Updated dependencies [0b912e9]
- Updated dependencies [0b912e9]
- Updated dependencies [0b912e9]
- Updated dependencies [a933c31]
- Updated dependencies [a933c31]
- Updated dependencies [2072231]
  - @runko/agent@0.2.0
  - @runko/core@0.2.0
