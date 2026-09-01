---
"@nimbo/persist-mongo": minor
---

新包 `@nimbo/persist-mongo`——nimbo 的 **MongoDB** 持久化实现，也是第一个**非关系型**实现。

```ts
import { migrate, mongoPersistence } from "@nimbo/persist-mongo";
import { MongoClient } from "mongodb";

const client = new MongoClient(process.env.MONGO_URL);
await client.connect();
const db = client.db("myapp");

await migrate(db);          // 建索引，幂等
createAgentRuntime(agent, { persistence: mongoPersistence(db) });
```

吃一个 `Db` 而不是 `MongoClient`——选哪个 database 是你的决定，连接的生命周期也归你。

**它不是薄壳。** SQLite / PostgreSQL / MySQL 那三个包底下共用 `@nimbo/persist-kysely`；
Kysely 是 SQL 查询构建器，Mongo 用不上，所以这个包直接实现三个领域接口。

它跟其余三个包跑**同一套一致性用例**，全过——也就是说契约里那三条「为非关系型留的」
准则（不假设事务能跨接口 / 不要求 CAS / 不支持跨会话查询）**真的成立**，接口没有漏掉
关系型假设。

有一处 Mongo 反而更干净：`dequeue` 要求「取出即移除、一个方法内原子完成」，SQL 那几家
是读-删两步 + 竞态重试，Mongo 的 `findOneAndDelete({...}, {sort})` 是数据库直接给的。

**要求 MongoDB 5.0+**：工具入参是任意 JSON，键里可能有 `.` 或 `$`，5.0 之前不接受这种
字段名。

三个集合固定叫 `nimbo_ledger` / `nimbo_decisions` / `nimbo_queue`——要隔离请用另一个
database。**这一版不含租约版归属仲裁**，那是下一批。
