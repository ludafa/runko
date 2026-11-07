---
"@runko/durable-object": minor
---

新包 `@runko/durable-object`：让 `@runko/agent` 的运行时跑在 Cloudflare Durable Object 里，一个会话一个对象，账本、待发队列、裁决表都存在对象自带的 SQLite 上。

- `createDurableObjectRuntime(ctx, options)`：在 DO 构造函数里调一行就装好。建表、崩溃恢复、推一把排队的消息都在 `ready` 里，已用 `blockConcurrencyWhile` 包住；DO 的 `alarm()` 转调 `agent.alarm()`。
- 对象被平台重启或回收后，没收尾的那一轮会补上「已中断」，身后排着的消息接着跑。没人发请求时靠 alarm 把对象叫醒。
- `durableObjectKysely(ctx.storage.sql)`：`ctx.storage.sql` 上的 Kysely 方言，影响行数准确（不用把索引写入也算进去的 `rowsWritten`）。
- `durableObjectArbitration(db)`：起轮标记写进 SQLite 的归属仲裁，重启后的新实例扫得到上一辈子的残留。
- `framesToStream` / `readFrames`：跨 RPC 传直播帧（NDJSON 字节流），消费方 cancel 会传回对象那一侧。
