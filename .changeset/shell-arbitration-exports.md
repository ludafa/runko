---
"@runko/persist-sqlite": minor
"@runko/persist-postgres": minor
"@runko/persist-mysql": minor
"@runko/persist-kysely": minor
---

三个薄壳各开一个租约版归属仲裁的出口：`sqliteArbitration(db, { holder })` /
`postgresArbitration(pool, { holder })` / `mysqlArbitration(pool, { holder })`。

以前只有 `@runko/persist-kysely` 导出 `leaseArbitration`，装了薄壳的人要跑多副本还得再装一个包、
再自己拼一个 Kysely 实例——而薄壳的存在理由本来就是替你把这两样装配好。现在持久化与仲裁
用同一个驱动实例装出来，共用同一个连接池，`migrate()` 仍然只调一次。

同批修掉一处出不去的 API：`leaseArbitration` 的 `flavor` 以前只收 `FlavorTraits`，而构造它的
`traitsOf` 并没有导出，外部调用方其实拼不出这个参数。现在它跟 `kyselyPersistence` 一样收方言名
（`"sqlite"` / `"postgres"` / `"mysql"`），原来传 `FlavorTraits` 的写法照旧可用。
