# @runko/persist-postgres

## 0.2.0

### Minor Changes

- fdc58ad: 四档持久化（Kysely 三方言 + MongoDB）现在支持[交权](https://github.com/ludafa/runko/blob/main/docs/terms.md)要用的三样东西：

  - **交接预留**：`leaseArbitration`/`mongoArbitration` 的 `Grant` 多了 `releaseTo(node, { ttlMs })`——放手的同时把这份对话预留给指定节点，预留期内只有它抢得到，过期退化成没人持有。`acquire`/`inspect` 都认这条预留。
  - **待接手 + 定时回捞**：`Arbitration` 多了 `markAwaitingTakeover` / `clearAwaitingTakeover` / `listSweepCandidates`——给挑不到接手节点的对话打标记，定时回捞据此找出「没人持有、也没有有效预留，但打了待接手标记」的对话（只认标记，不看待发队列）。`inspect` 在对话只有有效预留、还没人接上时报 `reserved: true`。
  - **节点登记表**：新增 `nodeRegistry`（Kysely）/ `mongoNodeRegistry`（Mongo），三个薄壳也各自导出 `sqliteNodeRegistry` / `postgresNodeRegistry` / `mysqlNodeRegistry`——登记节点地址、发布序号、状态、心跳，指定交接据此挑一个版本更新、负载更轻的存活节点接手。
  - **工具收尾**：`Persistence.tails` 现在四档都实现了——交权那一刻还在跑的工具，结果写进这张记录，接手节点据此结清那次悬空调用。

  Kysely 三方言新增 `agent_handover` / `agent_nodes` / `agent_tool_tails` 三张表（`migrate()` 已包含，`schema.sql` 同步更新）；MongoDB 新增 `agent_nodes` / `agent_tool_tails` 两个集合，交接预留直接放在 `agent_leases` 文档上（不用跨集合事务）。三个薄壳包（`persist-sqlite` / `persist-postgres` / `persist-mysql`）跟着把节点登记表的工厂函数转发出来。

  `@runko/conformance` 新增三组用例：`handoverCases`（交接预留 / 待接手 / 定时回捞）、`nodeRegistryCases`（节点登记表）、`toolTailCases`（工具收尾），随包导出配套的 setup 类型。

- a590331: 三个薄壳各开一个租约版归属仲裁的出口：`sqliteArbitration(db, { holder })` /
  `postgresArbitration(pool, { holder })` / `mysqlArbitration(pool, { holder })`。

  以前只有 `@runko/persist-kysely` 导出 `leaseArbitration`，装了薄壳的人要跑多副本还得再装一个包、
  再自己拼一个 Kysely 实例——而薄壳的存在理由本来就是替你把这两样装配好。现在持久化与仲裁
  用同一个驱动实例装出来，共用同一个连接池，`migrate()` 仍然只调一次。

  同批修掉一处出不去的 API：`leaseArbitration` 的 `flavor` 以前只收 `FlavorTraits`，而构造它的
  `traitsOf` 并没有导出，外部调用方其实拼不出这个参数。现在它跟 `kyselyPersistence` 一样收方言名
  （`"sqlite"` / `"postgres"` / `"mysql"`），原来传 `FlavorTraits` 的写法照旧可用。

### Patch Changes

- Updated dependencies [ee83d06]
- Updated dependencies [4a936b9]
- Updated dependencies [fdc58ad]
- Updated dependencies [6d89983]
- Updated dependencies [1489739]
- Updated dependencies [4a936b9]
- Updated dependencies [a590331]
- Updated dependencies [0b912e9]
- Updated dependencies [0b912e9]
- Updated dependencies [0b912e9]
- Updated dependencies [2072231]
  - @runko/agent@0.2.0
  - @runko/persist-kysely@0.2.0

## 0.1.2

### Patch Changes

- 63d90e5: 修复 **0.1.1 无法用 npm 安装**的问题。

  0.1.1 的发布产物里，`zod` / `kysely` / `just-bash` 等依赖的版本范围写的是 pnpm 的
  `catalog:` 协议原文。npm 不认识这个协议，安装时直接报错：

  ```
  npm error code EUNSUPPORTEDPROTOCOL
  npm error Unsupported URL Type "catalog:": catalog:
  ```

  原因是发布流程改用 `npm publish`（为了 OIDC 与 provenance）后，只把 `workspace:`
  换成了真实版本，漏了 `catalog:`。0.1.2 起两个协议都会解析，并在发布前断言不留任何
  pnpm 私有协议；发布后还会用 npm 真装一次做兜底验证。

  **0.1.1 请勿使用**，直接升到 0.1.2。0.1.0 不受影响（它是用 `pnpm publish` 发的）。

- Updated dependencies [63d90e5]
  - @runko/agent@0.1.2
  - @runko/persist-kysely@0.1.2

## 0.1.1

### Patch Changes

- c29a6eb: 补上 `repository` 字段，指向 https://github.com/ludafa/runko。

  npm 包页面此前没有任何指向源码的链接（0.1.0 首发时漏了这个字段）。现在每个包都带上仓库地址与自己在
  monorepo 里的子目录（`directory`），npm 上的「Repository」入口会直接落到该包的源码目录，而不是仓库根。

- Updated dependencies [c29a6eb]
  - @runko/agent@0.1.1
  - @runko/persist-kysely@0.1.1

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
