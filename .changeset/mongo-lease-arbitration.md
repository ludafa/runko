---
"@runko/persist-mongo": minor
---

MongoDB 现在也能跑多副本了：新增 `mongoArbitration(db, { holder })`，租约版归属仲裁的 Mongo 实现。

同一个 `Db` 装两次即可（`mongoPersistence` 管存，`mongoArbitration` 管「同一时刻只有一个副本在推进这份对话」），`migrate()` 仍然只调一次——它把租约集合要的索引一起建了。新增集合 `agent_leases`，一个会话一条文档、`_id` 就是会话 id。

跟 SQL 那三个包的租约版跑同一套仲裁一致性用例（通用 / 多节点 / 超时接管 / 报 takeover 四组）。实现是重写的、不走 Kysely：条件写只要一次往返，因为 `findOneAndUpdate` 直接返回更新后的文档。

单进程不受影响：不传 `arbitration` 照旧走框架内置的内存版。
