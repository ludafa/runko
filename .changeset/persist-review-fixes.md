---
"@nimbo/persist-kysely": patch
"@nimbo/persist-mongo": patch
"@nimbo/agent": patch
---

修掉一批持久化实现的正确性问题，其中三条会**静默丢数据**：

- **MySQL 上 ID 不再大小写不敏感。** 主键上的字符串列现在显式 `COLLATE utf8mb4_bin`。此前跟着 MySQL 8 的默认排序规则 `utf8mb4_0900_ai_ci` 走（大小写与重音都不敏感），`AbC` 和 `abc` 会被当成同一个 conversationId——跨会话读到别人的账本，主键上还会撞键、第二条 append 被静默丢掉。`tool_call_id` 尤其危险，各家模型的 call id 本来就是混合大小写。
- **MySQL 的幂等插入不再用 `INSERT IGNORE`。** 它把所有可恢复错误一起降级成 warning（超长截断、约束失败整行跳过），调用方却拿到「写成功了」。改用 `ON DUPLICATE KEY UPDATE`，只吞重复键。
- **并发 `enqueue` 不再重号、不再越过 `max`。** 队列的 `(conversationId, seq)` 上加了唯一约束/索引，撞号的那条换个号重来。此前是「先查最大值再插」，两个并发请求会算出同一个 seq，之后按 seq 排序平局——先到先发不再成立。
- **`append` 撞号时会如实报 `{ ok: false, reason: 'rejected' }`。** 同一条消息重写仍是幂等；但**另一条**消息占了同一个号时，此前一律报成功，等于静默丢消息。

**`@nimbo/persist-mongo` 的 `migrate()` 现在能就地升级同名索引。** 队列索引这次从非唯一改成了唯一，而 Mongo 会拒绝同名不同选项的 `createIndex`——不处理的话，从上一版升上来的人会直接崩在启动上（`IndexOptionsConflict`）。现在撞上冲突就删了重建；重建失败（存量数据违反唯一性）照常抛，那种情况需要人介入、不该静默。

另外：`migrate()` 的承诺范围写进了 README 与 `schema.sql`（只做首建、不做演进、不能并发调），参考 DDL 随包发布（`schema.sql`），队列 `input` 列改为运行时校验而不是裸类型断言。

一致性套件（`@nimbo/agent/conformance`）新增 4 条：ID 大小写敏感（conversationId 与 toolCallId 各一条）、并发 enqueue、append 撞号报拒绝——五个实现都要满足。
