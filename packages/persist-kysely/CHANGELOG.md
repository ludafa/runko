# @runko/persist-kysely

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

- 0b912e9: 人回来答了挂起的审批或提问，**在任意一个副本上**开一轮恢复，把那次调用接上。这是挂起与恢复（路线图 K3）的第四步，主链路就此打通。

  **`submitDecision` / `submitAnswer` 多了一条路**：等人项还在本进程内存里（内存窗口内），照旧直接交给正在等的那一轮；不在了（已经挂起，或者在别的副本上等着），就把答案写进裁决表那一行，然后开一轮恢复。恢复轮**用账本里原封不动的参数执行**，模型看到配好对的调用与结果。

  **裁决表当收件箱**：人答的那一刻不一定能马上开恢复轮（比如同一条消息里另一个调用的恢复轮正在跑）。答案先落库，占着会话的那一轮收尾时会读到它——交汇点在数据库里，所以跨副本也不会漏，挂起之后的答复**不需要转发**给谁。

  **恢复轮**：不追加用户消息；交给 `prepareTurn` 的 `input` 是空文本、`userId` 是答复人，另带 `resume: { callId }`；恢复轮装配期间点停止，那次调用按**拒绝**结清；装配失败时账本一个字不动，等下一次有人发消息时重试；**恢复没做成（它要结清的调用还悬着）就不自动重试**，避免命令被一遍遍执行。

  **账本里同一个 `message.id` 可能出现两次**：恢复轮原地改写挂起那一轮的最后一条消息，以新 seq 追加。读的时候按 id 折叠（位置取首次出现、内容取最新），`@runko/agent` 自己读账本时已经这么做了；**宿主自己读 `readLedger` / `subscribe` 回放时也要按 id 覆盖**——新导出的 `foldById` 就是干这个的。

  **崩溃与接管**：

  - 裁决表里的**孤儿行**（在内存里等人时进程崩了，这一行再也不会有人结清）在启动扫描与接管时结成 `timeout`。正在挂起、等人回来的行不动——两类靠账本区分。
  - **账本末尾有悬空调用时，不再补「已停止」标记**。补了会把悬空调用埋进历史中间，这个会话此后每次调模型都会被拒。
  - 恢复轮执行到一半崩溃：重启后自动重试。**那条命令可能会被执行第二次**——崩溃不是干净边界，宁可至少执行一次，也不让人批准过的操作静默丢失。

  **登记先于结清**：人在回路桥登记待定裁决不再是「发出去就不管」。结清之前、以及一轮放手之前，都会先等登记落库——否则连接池下结清可能跑在登记前面，留下一条永远待定的行。

  **只接受「账本末尾还悬着」的调用**：答复落到挂起路径时，那次调用必须真的悬在账本末尾，否则返回 `false`（接入层转 404）。这挡住两种错答：崩溃留下的孤儿行（答了也没有东西可恢复），以及这一轮正被停止、拒绝还没写进去的那一瞬（审计表会与实际发生的相反）。已经答过、但恢复没做成的调用，再答一次照样是 `false`，但会**顺手再推一把**。

  **`submitAnswer` 多了可选的第四个参数 `{ decidedBy }`**：挂起之后答的，恢复那一轮以答复人的身份跑（推送、钩子靠 `userId` 找人）。

  **撤回时替被顶掉的持有者收尾**：起轮或开恢复轮时发现会话在等人而撤回，如果这次抢归属顶掉了一个过期持有者，会先替它收拾孤儿行——否则那几行一直悬着。收拾孤儿行失败只记日志，不挡住后面补「已停止」标记。

  **⚠️ 不兼容：自己实现持久化的宿主要补一个方法**：`DecisionStore` 新增**必需**的 `get(conversationId, toolCallId)`，读回一行（结没结清都返回；没有就是 `undefined`）。`@runko/persist-*` 与内置的内存实现都已补上，一致性套件有对应用例。

  `DrivenSession` 新增**可选**的 `settleAndRun`（自定义 session 工厂不必跟着改；缺了它的 session 遇到恢复轮会以明确的错误收尾）。补上了 `SuspendReason` 类型的导出。

- 2072231: 多副本下，持有者崩溃、随后被别的副本接管时，崩溃的那一轮现在会在账本里补上「已停止」。

  以前给崩溃那一轮补「已停止」的只有进程启动时的 `recover()`。多副本下常常是别的副本先接手：接手时租约行被覆盖，此后谁重启都扫不到它，那一轮在账本里永远只剩一条用户消息。

  - `@runko/agent`：`AcquireResult` 的成功分支新增可选字段 `takeover?: { holder?: string }`，表示这次抢占顶掉了一个过期的持有者。轮编排据此在新一轮开跑前，先替上一轮补一条「已停止」标记（理由：`The node running this turn stopped responding; another node took over.`），并广播给已经连着的订阅者。新增导出类型 `Takeover`。不报这个字段的自定义仲裁实现照常可用。
  - `@runko/agent`：修掉一处竞态——从抢到归属到开始驱动这一轮之间，如果归属已经丢了（比如库卡住、心跳触发自我围栏），这一轮以前会照常装配、跑模型，而每次写账本都被拒；现在会直接按中断收尾。
  - `@runko/persist-kysely`：租约版仲裁（以及透传它的 `sqliteArbitration` / `postgresArbitration` / `mysqlArbitration`）在顶掉过期持有者时报 `takeover`。
  - `@runko/conformance`：新增一组可选导出 `arbitrationTakeoverReportCases`（报 `takeover` 的实现才接）；「正常抢占不报 `takeover`」「`clearStale` 之后再抢不报」两条并入原有的组，不报这个字段的实现天然能过。

  仍有一条路径补不上标记：持有者被冻住超过自我围栏的余量、期间没有任何副本来接管，它醒来后自己停手并释放了租约。这种情况下那一轮依旧只剩用户消息。

### Patch Changes

- 6d89983: 进程崩溃后**按同一个名字重启**，上一次留下的租约立刻算陈旧——不用再干等一个接管阈值（缺省 60 秒）。

  陈旧判据多了一支：**这条租约挂在我自己的 `holder` 名下，而它最后一次心跳早于我这个进程启动的时刻**。一个刚起来的进程不可能已经在跑任何一轮，所以这种租约一定是上一辈子留下的。`listStale`、`clearStale`、`acquire` 三处用同一条判据。

  **影响**：崩溃后马上重启的宿主，那些没跑完的会话在启动扫描时就被补上「已停止」标记，重启完即可用；此前要等接管阈值过去，这段时间里会话既发不了消息、也看不出已经停了。

  **前提是每个进程的 `holder` 唯一**（k8s 里同一个 pod 重启后名字不变，正合适）。两个活着的进程配成同一个名字时，后起来的那个会把先来的那一轮抢过去——先来的手里的租期标识已经作废、写不进账本，所以坏的是那一轮，不是数据。

  `@runko/conformance` 因此多了一组用例 `arbitrationRestartCases`（5 条，配套的 setup 类型是 `RestartConformanceSetup`）。**自己实现了归属仲裁的宿主**：接上这一组会要求你也支持同名重启即刻回收；看得见「上次崩溃残留」的实现才需要跑它，内存版那类不用接。

- Updated dependencies [ee83d06]
- Updated dependencies [4a936b9]
- Updated dependencies [e00ae29]
- Updated dependencies [1489739]
- Updated dependencies [4a936b9]
- Updated dependencies [0b912e9]
- Updated dependencies [0b912e9]
- Updated dependencies [0b912e9]
- Updated dependencies [a933c31]
- Updated dependencies [a933c31]
- Updated dependencies [2072231]
  - @runko/agent@0.2.0
  - @runko/core@0.2.0

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
  - @runko/core@0.1.2

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
