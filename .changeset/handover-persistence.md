---
"@runko/persist-kysely": minor
"@runko/persist-mongo": minor
"@runko/persist-sqlite": minor
"@runko/persist-postgres": minor
"@runko/persist-mysql": minor
"@runko/conformance": minor
---

四档持久化（Kysely 三方言 + MongoDB）现在支持[交权](https://github.com/ludafa/runko/blob/main/docs/terms.md)要用的三样东西：

- **交接预留**：`leaseArbitration`/`mongoArbitration` 的 `Grant` 多了 `releaseTo(node, { ttlMs })`——放手的同时把这份对话预留给指定节点，预留期内只有它抢得到，过期退化成没人持有。`acquire`/`inspect` 都认这条预留。
- **待接手 + 定时回捞**：`Arbitration` 多了 `markAwaitingTakeover` / `clearAwaitingTakeover` / `listSweepCandidates`——给挑不到接手节点的对话打标记，定时回捞据此找出「没人持有、也没有有效预留，但打了待接手标记」的对话（只认标记，不看待发队列）。`inspect` 在对话只有有效预留、还没人接上时报 `reserved: true`。
- **节点登记表**：新增 `nodeRegistry`（Kysely）/ `mongoNodeRegistry`（Mongo），三个薄壳也各自导出 `sqliteNodeRegistry` / `postgresNodeRegistry` / `mysqlNodeRegistry`——登记节点地址、发布序号、状态、心跳，指定交接据此挑一个版本更新、负载更轻的存活节点接手。
- **工具收尾**：`Persistence.tails` 现在四档都实现了——交权那一刻还在跑的工具，结果写进这张记录，接手节点据此结清那次悬空调用。

Kysely 三方言新增 `agent_handover` / `agent_nodes` / `agent_tool_tails` 三张表（`migrate()` 已包含，`schema.sql` 同步更新）；MongoDB 新增 `agent_nodes` / `agent_tool_tails` 两个集合，交接预留直接放在 `agent_leases` 文档上（不用跨集合事务）。三个薄壳包（`persist-sqlite` / `persist-postgres` / `persist-mysql`）跟着把节点登记表的工厂函数转发出来。

`@runko/conformance` 新增三组用例：`handoverCases`（交接预留 / 待接手 / 定时回捞）、`nodeRegistryCases`（节点登记表）、`toolTailCases`（工具收尾），随包导出配套的 setup 类型。
