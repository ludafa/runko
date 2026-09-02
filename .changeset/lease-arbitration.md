---
"@nimbo/persist-kysely": minor
"@nimbo/agent": minor
---

**新增租约版[归属仲裁机制](https://github.com/ludafa/nimbo/blob/main/docs/logic/arbitration/features/arbitration-impl.md)**——多进程 / 多节点共享一个数据库时，保证同一份对话同时刻只有一个执行在跑。

`@nimbo/persist-kysely` 导出 `leaseArbitration(db, { flavor, holder })`：

```ts
createAgentRuntime({
  persistence: kyselyPersistence(db, { flavor: "postgres" }),
  arbitration: leaseArbitration(db, { flavor: traitsOf("postgres"), holder: process.env.POD_NAME }),
});
```

**它保证不了独占，只能安全地失败**——这不是实现偷懒，是分布式系统绕不过去的一条：你没法知道远处那个节点是死了还是只是联系不上。所以租约版下**一轮跑到一半可能被告知「你已经不是主人了」**然后停下，这是正常路径。两个机制分工：租期标识管「不写坏」（只拒绝、不放行），心跳管「卡住的能被接管」。

默认 **心跳 5 秒 / 判死 60 秒**（12 拍）/ 交权宽限 15 秒，三个都可配；**阈值必须 ≥ 3× 心跳，配错构造时就抛**——阈值太短会把一次普通的调度延迟变成两个同时持有者，那是静默的数据损坏。

[`@nimbo/conformance`](https://www.npmjs.com/package/@nimbo/conformance) 同批新增仲裁用例，按能力分三组：内存版跑「通用」一组，能表达多节点的实现另跑「多节点」与「超时接管」两组。其中**「被误判的老持有者取号一律被拒」是整个租约版唯一真正要证明的东西**，已在 SQLite / pglite / 真 Postgres / 真 MySQL 四档上跑过。
