---
title: "持久化（宿主层）— 施工进展"
slug: persistence
view: 施工
layer: 宿主层
module: 持久化
packages: ["@nimbo/persist-kysely", "@nimbo/persist-sqlite", "@nimbo/persist-postgres", "@nimbo/persist-mysql", "@nimbo/persist-mongo"]
tags: ["持久化", "存储适配", "SQLite", "Postgres", "MySQL", "MongoDB", "kysely", "一致性测试"]
related: ["host/contract/features/persistence.md", "host/contract/tech/persistence.md", "architecture/plans/agent-kernel.md"]
---

# 持久化（宿主层）— 施工进展

> 相关：[功能](../features/persistence.md)，[技术方案](../tech/persistence.md)。
> 上位拆单：[架构总纲 · 施工进展](../../../architecture/plans/agent-kernel.md) 的 **K5**。

## 状态

**全部交付**（2026-08-24）。五个包、四种数据库（含一个非关系型），全部对真库跑过。

> **2026-08-30 复验**：对同一组容器（`nimbo-pg` :5433 · `nimbo-mysql` :3307 · `nimbo-mongo` :27018）重跑，全绿——
> `persist-kysely` **110**（pglite + Postgres + MySQL 三方言各跑一遍一致性套件）· `persist-sqlite` **28** ·
> `persist-postgres` **1** · `persist-mysql` **1** · `persist-mongo` **33**（整套一致性套件对真 Mongo 跑通）。
>
> **注意这几个包默认是 skip 的**：不给 `NIMBO_TEST_{POSTGRES,MYSQL,MONGO}_URL` 就整档跳过（它们没有进程内替身）。
> 所以**日常 `pnpm -r test` 里 postgres / mysql / mongo 三个包等于没测**——只有 `persist-kysely` 的 pglite 那一档是白跑的。
> 真库口径下全仓是 2051 个用例，默认口径是 1962。要真跑：
>
> ```sh
> NIMBO_TEST_POSTGRES_URL=postgres://nimbo:nimbo@127.0.0.1:5433/nimbo \
> NIMBO_TEST_MYSQL_URL=mysql://root:nimbo@127.0.0.1:3307/nimbo \
> NIMBO_TEST_MONGO_URL=mongodb://127.0.0.1:27018 \
> pnpm -r test
> ```

> **本批中途按构建者反馈重做过一次**，见下「第二版：换 Kysely + 一种库一个包」。
> 第一版（手搓方言层的单包 `@nimbo/persist-sql`）已退役，不在仓库里。

- 领域接口 **已定稿并已有一个真实实现**——`apps/node-server` 自建的那份（2026-08-16 随 `@nimbo/agent` 交付）。本批做的是**第二个**实现，官方包。
- 上位拆单 K5 原本的定义是「`persist-sql`，SQLite + Postgres 两个方言跑绿」。**实际交付超出了它**：五个包、四种数据库（含一个非关系型）。K6（租约版仲裁）仍然分开发。

## 开工前推翻的两个判断

留个底，免得再走一遍。

**① 「K5 取消，chat 应用自己实现就够了」——被推翻。**

2026-08-16 交付时的理由是「让 chat 应用自己实现反而是对接口更真实的检验」。这个理由**对 chat 应用成立，但不能推广**：`@nimbo/cli`（K8）和第三方宿主想零成本接上，仍然需要一个官方包。取消 = 把这个成本推给用户。2026-08-22 构建者拍板：现在就做。

**② 「把 `apps/node-server` 改造到官方包上，是搬家不是重写」——错的，已放弃。**

这句话是本会话上一轮给出的建议，两个前提都不成立：

- `persist-sql` 按[契约 §5](../tech/persistence.md) **就是裸驱动腿**（给没有 ORM 的应用）。让它吃 drizzle 等于跟 `persist-drizzle` 合并，两条腿交叉验证的价值直接归零。
- node-server 的 schema 跟规范模型**结构上就不一样**：[待发队列](../../../terms.md)在 `conversations.queued_messages_json` 这个 **JSON 列**里（不是独立表），[起轮标记](../../../terms.md)在 `conversations.turn_holder` 这个**列**上（不是 `LEASE` 表）。而这两个选择都是有理由的、写在 `db/schema.ts` 注释里的决定。

把它改造过去要么逼它放弃那些决定，要么逼官方包支持任意 schema 形状。**两个都不划算**，而且会丢掉「宿主自己实现领域接口」这条头等路径唯一的样板。

**所以 node-server 一行不改**，它转为本批的**对照组**：两个真实实现并存，接口有没有漏假设才检验得出来。

## 第二版：换 Kysely + 一种库一个包（2026-08-23）

第一版交付后构建者提了四条，前三条把方案改了一半：

**① 「better-auth 底层那个跨方言的 SQL 库我们不需要么？」**

需要。那是 **kysely**（better-auth 1.6.23 直接依赖它 + `@better-auth/kysely-adapter`）。
第一版自己手搓了一个方言层——在加 MySQL 之前还看得过去，一加就要开始长分支
（MySQL 不支持 `RETURNING`，而 `settle`/`remove` 全靠它）。换成 Kysely 之后：

- `RETURNING` 整个不用了，改用 `numUpdatedRows` / `numDeletedRows`，三家通吃
- 占位符、标识符引号、查询构建全归它
- **真差异只剩三处**（列类型、幂等插入写法、JSON 读回来要不要自己 parse）
- 白捡类型安全的查询——写错列名当场编译不过

**② 「每个 db 拆开一个独立包吧，依赖关系怪怪的」**

照做，而且这条比听起来更对。原来的「方言不是包，方言是参数」掩盖了真实成本：三家的
差异要么进一个越长越大的 `if`，要么进包名。**进包名更诚实**，而且依赖关系一眼看得明白
——每个包只 `peerDependencies` 自己那个驱动。

**③ 「MySQL 我们还是要支持的」**

支持了。顺带**实测推翻了契约文档 §6 的一条断言**（详见下「实测纠正的两条」）。

**④ 「orbstack 已启动，自己拉 postgres 和 mysql 测试」**

拉了两个带 `nimbo-` 前缀的容器（pg `5433` / mysql `3307`），避开了构建者已有的那个
`postgresql`（跑了 8 天，没碰）。P7 因此在本批内完成，不再是遗留项。

### 分包结果

```
persist-sqlite ─┐
persist-postgres ┼─→ persist-kysely ─→ 你的库
persist-mysql  ─┘      三个 Store + migrate
```

薄壳各约 40 行，只把驱动包成 Kysely 实例转交核心。**核心自己也能直接用**——已经在用
Kysely 的宿主装它，把自己的实例给它，两套表进同一个实例、同一套迁移。

### 顺带砍掉的两样

- **`tablePrefix`**：Kysely 的类型按**字面量表名**推，前缀一动态化就得退回 `any`，
  等于把这个库最值钱的东西扔掉去换一个几乎没人用的开关。要隔离请用 schema/database。
- **队列表的二级索引**：主键 `(conversation_id, id)` 的前导列已经够查；剩下只是给一个
  有上限的集合排序。顺带绕开了「MySQL 不支持 `CREATE INDEX IF NOT EXISTS`」。

## 阶段拆单

> 下面是**第二版**的拆单。第一版（手搓方言层的单包 `persist-sql`）的拆单已随包一起退役，
> 不再保留——它的结论都并进了上面「第二版」那一节。

### P1 · 核心包 `@nimbo/persist-kysely` ✅

- **目标**：三个 Store + `migrate()`，全部走 Kysely 的查询构建器，**没有一行手写 SQL**。
- **涉及文件**：`packages/persist-kysely/src/{index,schema,flavor,migrate,stores}.ts`。
- **产出物**：`kyselyPersistence(db, { flavor })` + `migrate(db, { flavor })`；`NimboDatabase`
  三张表的 Kysely 类型（DDL 与全部查询都从它推）。
- **验收**：`peerDependencies` 只有 `kysely`，零驱动依赖；三方言差异全部收在 `flavor.ts`。

### P2 · 三个薄壳 ✅

- **目标**：`persist-sqlite` / `persist-postgres` / `persist-mysql`，各约 40 行。
- **产出物**：`sqlitePersistence(db)` / `postgresPersistence(pool)` / `mysqlPersistence(pool)`，
  每个只做一件事——把驱动包成 Kysely 实例转交核心。
- **验收**：每个包只 `peerDependencies` 自己那个驱动；装 Postgres 不会拖进 `better-sqlite3`。

### P3 · 一致性测试套件 ✅（本批的主产出）

- **目标**：一套用例喂给多个实现，逐个断言行为一致。
- **涉及文件**：[`packages/conformance/src/persistence.ts`](../../../../packages/conformance/src/persistence.ts)、
  `packages/agent/test/builtin.test.ts`（内存实现接上）、各实现包的 `test/`。
- **产出物**：`persistenceCases`，**31 条不变量**。
- **验收**：所有实现**同一套用例全绿**。任一条在任一实现上不成立，都算本批失败。

> **套件独立成包 `@nimbo/conformance`。** 它断言的是**接口的承诺**，不是某个实现的行为，
> 所以 `persist-drizzle` / `persist-prisma` / 第三方实现都能直接引来自测。
>
> 第一版曾把它做成 `@nimbo/agent` 的子路径导出（`@nimbo/agent/conformance`），代价是
> `vitest` 成了那个**运行时**包的可选 peer——测试框架不该出现在运行时包的依赖里。拆包
> 之后套件自带一套手写断言（连 `node:assert` 都不用），只导出 `{ name, run }` 这样的
> 用例数据，`describe`/`it` 由消费方接，任何测试框架都能跑。

### P4 · demo 应用：零 ORM 的真实宿主 ✅

- **目标**：证明「装个包 + 给它一个驱动实例」真能跑起来一个完整的 agent 服务——不是玩具
  脚本，是**真的 HTTP 服务**。
- **涉及文件**：新成员 `apps/persist-demo/`。
- **产出物**：Hono 服务，持久化只用 `@nimbo/persist-*`、一行 ORM 都没有；端点形状与
  `apps/node-server` 一致（起轮 / 回放 / SSE / 队列 / 审批）。`DEMO_DB` 切换四种库。
- **验收**：见 P5。

> **为什么做成 HTTP 服务而不是 CLI 脚本**：demo 是我们自己写的，天然有「不自觉迁就包的
> 能力」的风险。做成服务、并且**对齐一个已经写死的 API 契约**，包做不到的地方会当场暴露。

### P5 · 端到端测试 ✅

- **目标**：从 HTTP 请求打到库里，覆盖完整链路。
- **涉及文件**：`apps/persist-demo/test/e2e.test.ts`。
- **产出物**：建会话 → 起轮 → SSE 收帧 → 排队 → 出队 → 审批 → **重启进程** → 回放一致。
- **验收**：每种库跑同一套；重启后账本、队列、裁决三样都能原样读回。

### P6 · MySQL 支持 ✅

- **目标**：构建者要求补上（原计划「首批只 SQLite + Postgres」）。
- **产出物**：`@nimbo/persist-mysql` + `flavor.ts` 里的 `mysql` 一档。
- **踩到的两条**：MySQL **不支持 `RETURNING`**（改用 `numUpdatedRows` / `numDeletedRows`
  三家通吃）、**不支持 `CREATE INDEX IF NOT EXISTS`**（队列表的二级索引整个去掉，本来也用不上）。
- **验收**：对真 MySQL 容器跑一致性套件 + e2e，全绿。

### P7 · `@nimbo/persist-mongo` ✅

- **目标**：第一个**非关系型**实现。构建者点名要的。
- **涉及文件**：`packages/persist-mongo/src/{index,collections,migrate,stores}.ts`。
- **产出物**：`mongoPersistence(db)` + `migrate(db)`（Mongo 没有建表，只建索引，但**不可省**
  ——幂等写入靠唯一索引兜底）。demo 加第四档 `DEMO_DB=mongo`，**连它自己那张会话表也换成集合**。
- **它不是薄壳**：Kysely 是 SQL 查询构建器，Mongo 用不上，所以直接实现三个领域接口。
- **验收**：对真 MongoDB 8 跑一致性套件（27 条）+ 6 条 Mongo 特有用例 + e2e 9 条，**全绿，一次没红**。

### P8 · 真库实测 ✅

- **目标**：补上进程内替身覆盖不到的部分。
- **重点验**：连接池并发写、大 payload、JSON 往返、连接断开重连。
- **状态**：Postgres / MySQL / MongoDB **三种真库全部跑绿**。

## 需要的测试环境

| | 要不要外部服务 | 说明 |
|---|---|---|
| **SQLite** | 不要 | `better-sqlite3` 的 `:memory:` |
| **Postgres** | 不要（单测） | **pglite**（WASM 进程内）。开发期实测才要真库 |
| **MySQL** | **要** | 没有进程内替身 |
| **MongoDB** | **要** | 没有进程内替身（`mongodb-memory-server` 是下载真 mongod 来跑，不是进程内） |

不给连接串时，需要真库的那几档 `describe.skip` 并**说明原因**——不是静默跳过。

```sh
docker run -d --name nimbo-pg    -e POSTGRES_PASSWORD=nimbo -e POSTGRES_USER=nimbo -e POSTGRES_DB=nimbo -p 5433:5432 postgres:18
docker run -d --name nimbo-mysql -e MYSQL_ROOT_PASSWORD=nimbo -e MYSQL_DATABASE=nimbo -p 3307:3306 mysql:9
docker run -d --name nimbo-mongo -p 27018:27017 mongo:8

NIMBO_TEST_POSTGRES_URL=postgres://nimbo:nimbo@127.0.0.1:5433/nimbo \
NIMBO_TEST_MYSQL_URL=mysql://root:nimbo@127.0.0.1:3307/nimbo \
NIMBO_TEST_MONGO_URL=mongodb://127.0.0.1:27018 \
  pnpm -r test
```

> **CI 上目前只跑 SQLite 与 pglite**——MySQL 与 MongoDB 那两档没有进程内替身，
> 需要 service container 才能进流水线。**这是个已知的覆盖缺口。**

## 验收

- 根 `pnpm build` / `typecheck` / `test` 全绿（`packages/*` filter 覆盖新包）。
- `pnpm -r lint` 全绿（新包引根目录的 `eslint.config.base.js`，与其余 `packages/*` 一致）。
- **一致性套件在所有实现上全绿**——本批的核心验收项。
- **e2e 在每种库上全绿**。
- `apps/node-server` **一行不改**仍然全绿（对照组没被碰坏）。
- `pnpm docs:check` + `pnpm docs:build` 绿。
- changeset：新包首发一条 minor；`@nimbo/agent` 因新增 conformance 子路径导出，一条 minor。

## 明确不做

- **租约版归属仲裁**（心跳 / 租期标识 / CAS / `LEASE` 表）——K6，分开发，理由见[技术方案 §8.4](../tech/persistence.md)。
- **改造 `apps/node-server`**——理由见上「开工前推翻的两个判断」②。它是对照组。
- **`persist-drizzle` / `persist-prisma`**——K9。
- **「通用适配器」抽象层**——三条腿各写各的够用了，等真需要复用再抽。
- **SQLite / PostgreSQL / MySQL / MongoDB 之外的存储**。其余走「自己实现三个领域接口」
  这条头等路径，或者自己配一个 Kysely dialect 接 `@nimbo/persist-kysely`。

## 验收结论

### 跑绿了什么（2026-08-24，终版）

| 项 | 结果 |
|---|---|
| `pnpm -r build` / `typecheck` / `lint` | 全绿（**19 个成员**） |
| `persist-kysely` | **110** —— 一致性套件 × 4 档（SQLite / pglite / **真 Postgres** / **真 MySQL**）+ 2 条 migrate |
| **`persist-mongo`** | **33** —— 一致性套件（对**真 MongoDB 8**）+ 6 条 Mongo 特有 |
| `persist-sqlite` | 28（整套一致性 + 冒烟） |
| `persist-postgres` / `persist-mysql` | 各 1 条冒烟（对真库） |
| `persist-demo` e2e | **37** —— 9 条 × **4 种真库** + 跨重启 1 条 |
| `@nimbo/agent` | 64 → **91**（+27 一致性用例，内存实现是行为基准） |
| `apps/node-server` | ✅ **395 一个没动**——对照组没被碰坏 |
| `docs:check` / `docs:build` | 全绿（87 份，零死链） |

**一致性套件的总账**：同一套 27 条不变量，跑在**六个实现**上全绿——内存、SQLite、
pglite、真 Postgres、真 MySQL、真 MongoDB。其中最后一个是**非关系型**。

### MongoDB 那一档证明了什么

契约 §4 有三条准则，当初就是为了不把非关系型挡在门外才那么写的。这是第一次真去验：

| 准则 | 结论 |
|---|---|
| 不假设事务能跨接口 | ✅ 需要原子的只有 `dequeue`，Mongo 的 `findOneAndDelete` **原生原子** |
| 不要求 CAS | ✅ 一次都没用上 |
| 不支持跨会话查询 | ✅ 每个查询都以 `conversationId` 打头，正好是索引前缀 |

**三条全成立，接口没有漏掉关系型假设。** 而且 `dequeue` 这一处 Mongo 反而**比 SQL 那几家
更干净**：契约要求「取出即移除、一个方法内原子完成」，SQL 是读-删两步 + 竞态重试，
Mongo 是数据库直接给的。

真库连接串（本地容器，`nimbo-` 前缀，避开了构建者已有的实例）：

```sh
NIMBO_TEST_POSTGRES_URL=postgres://nimbo:nimbo@127.0.0.1:5433/nimbo \
NIMBO_TEST_MYSQL_URL=mysql://root:nimbo@127.0.0.1:3307/nimbo \
  pnpm -r test
```

不给这两个变量时，Postgres 走 pglite、MySQL 那档 `describe.skip` 并说明原因。
**MySQL 没有进程内替身，所以 CI 上目前不跑它——已知覆盖缺口。**

### 实测纠正的两条

**① 契约文档 §6 的 MySQL 断言不成立。** 原文写「`affectedRows` 默认返回『真正变了的
行』而不是『匹配到的行』，值没变时返回 0，会让 CAS 误判成失败，要靠 `CLIENT_FOUND_ROWS`
flag」。对着真 MySQL 9 实测：

| 场景 | `numUpdatedRows` | `numChangedRows` |
|---|---|---|
| `UPDATE` 匹配到、**值变了** | 1 | 1 |
| `UPDATE` 匹配到、**值没变** | **1** ← 关键 | 0 |
| `UPDATE` 没匹配到 | 0 | 0 |

在 **mysql2 + Kysely** 这条路上，`numUpdatedRows` 报的就是匹配行数。原描述对**裸 MySQL
协议**成立，对我们实际走的这条路不成立。文档已改。

**② MySQL 不支持 `CREATE INDEX IF NOT EXISTS`。** 这条是真的，撞上了。处置是把那个
索引整个去掉（本来也用不上，见上「顺带砍掉的两样」），不是为它开分支。

### e2e 抓到的两处「测试写错了」

两处都**只在真库上红**，SQLite 上永远绿——因为它是同步的、微秒级：

1. **「队列满了回 409」**：这条要求后两条消息到达时第一轮**仍在跑**。靠「假模型很快」
   是侥幸；走网络的库上往返延迟足够让第一轮先跑完，第二条就去起新轮了。加了一个
   **闸门模型**（`doStream` 里 `await` 一个可释放的 promise），把「还在跑」变成确定事实。
2. **`settle()` 等的是「没有轮在跑」**，但第一轮收尾到自动出队起第二轮之间有个**空窗**，
   那一瞬 `active` 就是 `false`，于是它提前返回。MySQL 上那个窗更宽，必踩。改成
   `waitForMessages()`——**断言最终状态，别断言中间信号**。

### 一致性套件抓到的真 bug（第一版）

**这条值得单列**——它正是这套东西存在的理由。

`persist-sql` 的 `parseJson` 原先写成「两种都认」：拿 `typeof column === "string"` 当
「还没解析」的信号，是字符串就 `JSON.parse` 一下。SQLite 侧 31 条用例全过，看不出问题。

pglite 侧炸在「question 通道与 approval 通道分得开」那条上：`ask-user` 的问题正文是个
**纯字符串** payload，存进 JSONB、驱动正确解析回字符串之后，那段代码又去 parse 了一次。

> **教训：「两种都试试」的对冲本身就是 bug。** 一个合法存进去的 JSON 字符串，读回来
> 就是个 JS string，跟「还没解析的 JSON 文本」在类型上完全一样，猜不出来。改成每种
> 方言只认自己那一种存法（SQLite 的 TEXT 永远 parse，Postgres 的 JSONB 永远不 parse）。

单条方言的测试**发现不了**这个——它要两个实现跑同一套才暴露。

### 施工中偏离计划的地方

| 计划 | 实际 | 为什么 |
|---|---|---|
| `Dialect` 有 `exec(多语句 DDL)` | **去掉了**，`migrate()` 拆成语句数组逐条 `run()` | pglite 的 `query()` 走扩展协议，一次只吃一条（`cannot insert multiple commands into a prepared statement`）。顺带好处：要求的驱动面更小，`SqliteLike` 不再需要 `exec` |
| P5 产出「一个 example」 | **一个真 HTTP 服务**（`apps/persist-demo`） | 构建者要求。而且更好——对齐一个已写死的 API 契约，包做不到的地方会当场暴露 |
| 用 `settle` 的驱动 `rowCount` 判断改没改 | 改用 `RETURNING` | `changes` / `rowCount` 在两种驱动里名字和语义都不一样，`RETURNING` 是两边同一套写法 |

### demo 里那二十行手写 SQL 是怎么回事

`apps/persist-demo/src/store.ts` 里有约二十行手写的「查询口」，把同步的 better-sqlite3
和异步的 pg 抹平。两点澄清，两点都容易被误读成「这个包没做完」：

1. **它伺候的是 `demo_conversations`**——demo 自己的产品数据（会话标题）。**agent 那三张
   表一次都没被它碰过**，全归 `@nimbo/persist-*`。这正是准则「nimbo 不拥有用户实体」
   的样子：框架只认一个不透明的 `conversationId`。
2. **它是「本 demo 要同时支持两种方言」的成本，不是「当 nimbo 宿主」的成本。** 真实应用
   只挑一个数据库，自己的表直接 `db.prepare(…).run(…)` 就完了，不需要这一层抽象。

### 导出面收窄（同日修正）

`Dialect` / `SqlParam` / `SqlRow` 原先被导出到公共 API 上。它们是本包拼 SQL 的**内部管道**
——构建者读到 `Dialect.run(sql, params)` 会合理地以为「SQL 要我自己写」，而事实相反：
包里那 15 条 SQL 全在 `migrate.ts`（4 条建表）与 `stores.ts`（11 条读写）里，用这个包的人
**一行 agent 相关的 SQL 都不用写**。

已改为不导出。想换第三种方言（MySQL 之类）的正确口子是自己实现 `Persistence` 那三个接口
（头等路径），不是来实现 `Dialect`——那是内部形状，会跟着重构变。

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-08-24 | **加 `@nimbo/persist-mongo`**（构建者点名）：第一个非关系型实现，不走 Kysely、直接实现三个领域接口。跟其余实现跑同一套一致性用例全绿——契约里那三条「为非关系型留的」准则**首次得到验证**。demo 加第四档 `DEMO_DB=mongo`，连它自己那张会话表也换成集合。实测坐实「UPDATE 匹配到但值没变时计数为 0」这个坑的真身在 Mongo（`settle` 必须看 `matchedCount`），以及 BSON 把 `undefined` 存成 `null`（写入前做 JSON 归一对齐 SQL 那几家） |
| 2026-08-23 | **第二版**：按构建者反馈重做——底层换 Kysely（同 better-auth）、一种库一个包（`persist-kysely` 核心 + sqlite/postgres/mysql 三个薄壳）、补齐 MySQL；砍掉 `tablePrefix` 与队列二级索引；对真 Postgres/MySQL 容器跑完 P7。实测推翻契约 §6 的 MySQL `affectedRows` 断言 |
| 2026-08-23 | **第一版 P1–P6 交付**（已退役）：`packages/persist-sql`（方言层 / 三张表 + `migrate()` / 三个 Store）、`@nimbo/agent/conformance` 一致性套件（27 条不变量 × 3 个实现）、`apps/persist-demo`（零 ORM 的 Hono 服务）、19 条 e2e。一致性套件在 pglite 上抓到 `parseJson` 的对冲 bug，见「验收结论」 |
| 2026-08-23 | 方案定稿。K5 从「取消」恢复为「现在就做」；推翻「改造 node-server」的思路，改为 node-server 作对照组；一致性测试套件定为本批主产出；确定 pglite 作为 Postgres 的单测替身、真 Postgres 只在 P6 手动实测 |
