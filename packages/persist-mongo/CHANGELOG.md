# @nimbo/persist-mongo

## 0.1.0

### Minor Changes

- 85e5099: 新包 `@nimbo/persist-mongo`——nimbo 的 **MongoDB** 持久化实现，也是第一个**非关系型**实现。

  ```ts
  import { migrate, mongoPersistence } from "@nimbo/persist-mongo";
  import { MongoClient } from "mongodb";

  const client = new MongoClient(process.env.MONGO_URL);
  await client.connect();
  const db = client.db("myapp");

  await migrate(db); // 建索引，幂等
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

### Patch Changes

- 85e5099: 修掉一批持久化实现的正确性问题，其中三条会**静默丢数据**：

  - **MySQL 上 ID 不再大小写不敏感。** 主键上的字符串列现在显式 `COLLATE utf8mb4_bin`。此前跟着 MySQL 8 的默认排序规则 `utf8mb4_0900_ai_ci` 走（大小写与重音都不敏感），`AbC` 和 `abc` 会被当成同一个 conversationId——跨会话读到别人的账本，主键上还会撞键、第二条 append 被静默丢掉。`tool_call_id` 尤其危险，各家模型的 call id 本来就是混合大小写。
  - **MySQL 的幂等插入不再用 `INSERT IGNORE`。** 它把所有可恢复错误一起降级成 warning（超长截断、约束失败整行跳过），调用方却拿到「写成功了」。改用 `ON DUPLICATE KEY UPDATE`，只吞重复键。
  - **并发 `enqueue` 不再重号、不再越过 `max`。** 队列的 `(conversationId, seq)` 上加了唯一约束/索引，撞号的那条换个号重来。此前是「先查最大值再插」，两个并发请求会算出同一个 seq，之后按 seq 排序平局——先到先发不再成立。
  - **`append` 撞号时会如实报 `{ ok: false, reason: 'rejected' }`。** 同一条消息重写仍是幂等；但**另一条**消息占了同一个号时，此前一律报成功，等于静默丢消息。

  **`@nimbo/persist-mongo` 的 `migrate()` 现在能就地升级同名索引。** 队列索引这次从非唯一改成了唯一，而 Mongo 会拒绝同名不同选项的 `createIndex`——不处理的话，从上一版升上来的人会直接崩在启动上（`IndexOptionsConflict`）。现在撞上冲突就删了重建；重建失败（存量数据违反唯一性）照常抛，那种情况需要人介入、不该静默。

  另外：`migrate()` 的承诺范围写进了 README 与 `schema.sql`（只做首建、不做演进、不能并发调），参考 DDL 随包发布（`schema.sql`），队列 `input` 列改为运行时校验而不是裸类型断言。

  一致性套件（`@nimbo/conformance`）新增 4 条：ID 大小写敏感（conversationId 与 toolCallId 各一条）、并发 enqueue、append 撞号报拒绝——五个实现都要满足。

- Updated dependencies [847222d]
- Updated dependencies [be08aac]
- Updated dependencies [51d94e6]
- Updated dependencies [3029ae3]
- Updated dependencies [3029ae3]
- Updated dependencies [3029ae3]
- Updated dependencies [48b461b]
- Updated dependencies [fca6c03]
- Updated dependencies [3029ae3]
- Updated dependencies [1282005]
- Updated dependencies [b342e5b]
- Updated dependencies [85e5099]
- Updated dependencies [3ffdf28]
- Updated dependencies [fca6c03]
  - @nimbo/core@0.1.0
  - @nimbo/agent@0.1.0
