# @runko/persist-mysql

## 0.1.0

### Minor Changes

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

- Updated dependencies [51d94e6]
- Updated dependencies [3029ae3]
- Updated dependencies [3029ae3]
- Updated dependencies [3029ae3]
- Updated dependencies [48b461b]
- Updated dependencies [3029ae3]
- Updated dependencies [1282005]
- Updated dependencies [85e5099]
- Updated dependencies [85e5099]
- Updated dependencies [fca6c03]
  - @runko/agent@0.1.0
  - @runko/persist-kysely@0.1.0
