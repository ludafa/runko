---
"@runko/agent": minor
"@runko/persist-kysely": minor
"@runko/conformance": minor
---

多副本下，持有者崩溃、随后被别的副本接管时，崩溃的那一轮现在会在账本里补上「已停止」。

以前给崩溃那一轮补「已停止」的只有进程启动时的 `recover()`。多副本下常常是别的副本先接手：接手时租约行被覆盖，此后谁重启都扫不到它，那一轮在账本里永远只剩一条用户消息。

- `@runko/agent`：`AcquireResult` 的成功分支新增可选字段 `takeover?: { holder?: string }`，表示这次抢占顶掉了一个过期的持有者。轮编排据此在新一轮开跑前，先替上一轮补一条「已停止」标记（理由：`The node running this turn stopped responding; another node took over.`），并广播给已经连着的订阅者。新增导出类型 `Takeover`。不报这个字段的自定义仲裁实现照常可用。
- `@runko/agent`：修掉一处竞态——从抢到归属到开始驱动这一轮之间，如果归属已经丢了（比如库卡住、心跳触发自我围栏），这一轮以前会照常装配、跑模型，而每次写账本都被拒；现在会直接按中断收尾。
- `@runko/persist-kysely`：租约版仲裁（以及透传它的 `sqliteArbitration` / `postgresArbitration` / `mysqlArbitration`）在顶掉过期持有者时报 `takeover`。
- `@runko/conformance`：新增一组可选导出 `arbitrationTakeoverReportCases`（报 `takeover` 的实现才接）；「正常抢占不报 `takeover`」「`clearStale` 之后再抢不报」两条并入原有的组，不报这个字段的实现天然能过。

仍有一条路径补不上标记：持有者被冻住超过自我围栏的余量、期间没有任何副本来接管，它醒来后自己停手并释放了租约。这种情况下那一轮依旧只剩用户消息。
