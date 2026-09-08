# @runko/persist-kysely

## 0.1.1

### Patch Changes

- c29a6eb: 补上 `repository` 字段，指向 https://github.com/ludafa/runko。

  npm 包页面此前没有任何指向源码的链接（0.1.0 首发时漏了这个字段）。现在每个包都带上仓库地址与自己在
  monorepo 里的子目录（`directory`），npm 上的「Repository」入口会直接落到该包的源码目录，而不是仓库根。

- Updated dependencies [c29a6eb]
  - @runko/agent@0.1.1
  - @runko/core@0.1.1

## 0.1.0

### Minor Changes

- 1282005: **新增租约版[归属仲裁机制](https://github.com/ludafa/runko/blob/main/docs/logic/arbitration/features/arbitration-impl.md)**——多进程 / 多节点共享一个数据库时，保证同一份对话同时刻只有一个执行在跑。

  `@runko/persist-kysely` 导出 `leaseArbitration(db, { flavor, holder })`：

  ```ts
  createAgentRuntime({
    persistence: kyselyPersistence(db, { flavor: "postgres" }),
    arbitration: leaseArbitration(db, {
      flavor: traitsOf("postgres"),
      holder: process.env.POD_NAME,
    }),
  });
  ```

  **它保证不了独占，只能安全地失败**——这不是实现偷懒，是分布式系统绕不过去的一条：你没法知道远处那个节点是死了还是只是联系不上。所以租约版下**一轮跑到一半可能被告知「你已经不是主人了」**然后停下，这是正常路径。两个机制分工：租期标识管「不写坏」（只拒绝、不放行），心跳管「卡住的能被接管」。

  默认 **心跳 5 秒 / 判死 60 秒**（12 拍）/ 交权宽限 15 秒，三个都可配；**阈值必须 ≥ 3× 心跳，配错构造时就抛**——阈值太短会把一次普通的调度延迟变成两个同时持有者，那是静默的数据损坏。

  [`@runko/conformance`](https://www.npmjs.com/package/@runko/conformance) 同批新增仲裁用例，按能力分三组：内存版跑「通用」一组，能表达多节点的实现另跑「多节点」与「超时接管」两组。其中**「被误判的老持有者取号一律被拒」是整个租约版唯一真正要证明的东西**，已在 SQLite / pglite / 真 Postgres / 真 MySQL 四档上跑过。

- 85e5099: 四个新包：runko 的官方持久化实现，**SQLite / PostgreSQL / MySQL 三种库各一个包**。

  装包、给它一个驱动实例、装配时传进去，就这三步：

  ```ts
  import { migrate, postgresPersistence } from "@runko/persist-postgres";
  import { Pool } from "pg";

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await migrate(pool); // 建表，幂等

  createAgentRuntime(agent, { persistence: postgresPersistence(pool) });
  ```

  换库 = 换包，业务代码一个字不动（`@runko/persist-sqlite` 吃 `better-sqlite3` 实例，
  `@runko/persist-mysql` 吃 `mysql2` 连接池）。

  **一种库一个包**，每个包只 `peerDependencies` 自己那个驱动——装 Postgres 的人不会被
  `better-sqlite3` 和 `mysql2` 污染依赖树。三个薄壳共用一个核心 `@runko/persist-kysely`：

  ```
  persist-sqlite ─┐
  persist-postgres ┼─→ persist-kysely ─→ 你的库
  persist-mysql  ─┘
  ```

  **已经在用 Kysely 就直接装核心**，把自己的实例给它——runko 的三张表和你的表进同一个
  实例、同一套迁移。把 `RunkoDatabase` 并进你的库类型即可。

  几条要知道的：

  - **`migrate()` 你自己调**，不是包在背后偷偷跑的；幂等。
  - **表名固定**（`agent_ledger` / `agent_decisions` / `agent_queue`），不提供前缀开关
    ——Kysely 的类型按字面量表名推，前缀一动态化就得退回 `any`。要隔离请用 schema。
  - **不含租约版归属仲裁**（心跳 / 租期标识 / CAS）——那是下一批，仲裁仍用
    `@runko/agent` 内置的单进程实现。

  三种库都跑过一致性套件与端到端，Postgres 与 MySQL 是**对真库**跑的。

### Patch Changes

- 85e5099: 修掉一批持久化实现的正确性问题，其中三条会**静默丢数据**：

  - **MySQL 上 ID 不再大小写不敏感。** 主键上的字符串列现在显式 `COLLATE utf8mb4_bin`。此前跟着 MySQL 8 的默认排序规则 `utf8mb4_0900_ai_ci` 走（大小写与重音都不敏感），`AbC` 和 `abc` 会被当成同一个 conversationId——跨会话读到别人的账本，主键上还会撞键、第二条 append 被静默丢掉。`tool_call_id` 尤其危险，各家模型的 call id 本来就是混合大小写。
  - **MySQL 的幂等插入不再用 `INSERT IGNORE`。** 它把所有可恢复错误一起降级成 warning（超长截断、约束失败整行跳过），调用方却拿到「写成功了」。改用 `ON DUPLICATE KEY UPDATE`，只吞重复键。
  - **并发 `enqueue` 不再重号、不再越过 `max`。** 队列的 `(conversationId, seq)` 上加了唯一约束/索引，撞号的那条换个号重来。此前是「先查最大值再插」，两个并发请求会算出同一个 seq，之后按 seq 排序平局——先到先发不再成立。
  - **`append` 撞号时会如实报 `{ ok: false, reason: 'rejected' }`。** 同一条消息重写仍是幂等；但**另一条**消息占了同一个号时，此前一律报成功，等于静默丢消息。

  **`@runko/persist-mongo` 的 `migrate()` 现在能就地升级同名索引。** 队列索引这次从非唯一改成了唯一，而 Mongo 会拒绝同名不同选项的 `createIndex`——不处理的话，从上一版升上来的人会直接崩在启动上（`IndexOptionsConflict`）。现在撞上冲突就删了重建；重建失败（存量数据违反唯一性）照常抛，那种情况需要人介入、不该静默。

  另外：`migrate()` 的承诺范围写进了 README 与 `schema.sql`（只做首建、不做演进、不能并发调），参考 DDL 随包发布（`schema.sql`），队列 `input` 列改为运行时校验而不是裸类型断言。

  一致性套件（`@runko/conformance`）新增 4 条：ID 大小写敏感（conversationId 与 toolCallId 各一条）、并发 enqueue、append 撞号报拒绝——五个实现都要满足。

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
  - @runko/core@0.1.0
  - @runko/agent@0.1.0
