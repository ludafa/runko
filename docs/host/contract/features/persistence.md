---
title: "持久化（宿主层）— 使用手册"
slug: persistence
view: 功能
layer: 宿主层
module: 持久化
packages: ["@nimbo/persist-sql", "@nimbo/persist-drizzle", "@nimbo/persist-prisma"]
tags: ["持久化", "存储适配", "SQLite", "Postgres", "drizzle", "prisma"]
related: ["host/contract/tech/persistence.md", "architecture/tech/agent-kernel.md"]
---

# 持久化（宿主层）— 使用手册

> 相关：[技术方案](../tech/persistence.md)，架构总纲 [功能](../../../architecture/features/agent-kernel.md) · [技术方案](../../../architecture/tech/agent-kernel.md) §3。
> 宿主层的另两样能力：[沙盒](./sandbox.md) · [流分发](./stream-fanout.md)。第四样[归属仲裁机制](../../../logic/arbitration/features/arbitration-impl.md)的实现文档跟它的语义并排放在逻辑层。
> 术语：[宿主层](../../../terms.md) · [账本](../../../terms.md) · [待发队列](../../../terms.md)。
>
> **状态：领域接口已定稿**（2026-08-16 随 `@nimbo/agent` 交付，见 `packages/agent/src/persistence.ts`）。
> 官方实现包首发 `@nimbo/persist-sql`，施工见[施工进展](../plans/persistence.md)。

## 0. 一句话

**框架定义「数据长什么样」，你决定「它存在哪」**——换一个数据库，就是换一个持久化实现，agent 的行为一个字都不用改。

## 1. 解决什么问题

拿 nimbo 建产品的人，应用里本来就有自己的数据库、自己的 ORM、自己的领域模型。如果 nimbo 硬绑一种存储，他要么被迫多养一个数据库，要么放弃自己那套 schema 管理。

所以持久化被划到[宿主层](../../../terms.md)：**可替换，而且四样宿主能力里它是最常被换的一个。**

它要存的是四样东西——[账本](../../../terms.md)、人工裁决、[待发队列](../../../terms.md)、[租约](../../../terms.md)表。四样都由[轮编排](../../../terms.md)定义模型、由持久化负责落地。语义与字段见 [架构总纲 · 技术方案 §3](../../../architecture/tech/agent-kernel.md)（**数据模型的单一事实来源在那里**，本文不复述）。

## 2. 三条腿，按你已有的东西挑

| 你的情况 | 装哪个 | 你要给它什么 | 有了吗 |
|---|---|---|---|
| 只是本地跑跑、不要求重启后还在 | **什么都不用装** | 内置内存实现，零配置 | ✅ 随 `@nimbo/agent` |
| 用 SQLite，只有一个驱动 | `@nimbo/persist-sqlite` | 一个 `better-sqlite3` 实例 | ✅ |
| 用 PostgreSQL，只有一个驱动 | `@nimbo/persist-postgres` | 一个 `pg.Pool` | ✅ |
| 用 MySQL，只有一个驱动 | `@nimbo/persist-mysql` | 一个 `mysql2` 连接池 | ✅ |
| 用 **MongoDB** | `@nimbo/persist-mongo` | 一个 MongoDB `Db` | ✅ |
| 已经在用 **Kysely** | `@nimbo/persist-kysely` | 你已有的 Kysely 实例 | ✅ |
| 已经在用 drizzle | `@nimbo/persist-drizzle` | 你已有的 drizzle 实例 | ⬜ 未开工 |
| 已经在用 Prisma | `@nimbo/persist-prisma` | 你已有的 Prisma client | ⬜ 未开工 |
| 跑在 Cloudflare Durable Object 上 | `@nimbo/durable-object` | 什么都不用给（用 `ctx.storage.sql`） | ⬜ 未开工 |
| **你的 schema 跟哪个都对不上** | **什么都不用装，自己实现三个接口** | —— | ✅ 头等路径，见下 |

### 一种库一个包

**每种数据库是独立的包，各自只 peer-dep 自己那个驱动。** 装 `@nimbo/persist-postgres`
不会把 `better-sqlite3` 或 `mysql2` 拖进你的依赖树。

四个包的关系很简单——**三个薄壳共用一个核心**：

```
persist-sqlite ─┐
persist-postgres ┼─→ persist-kysely ─→ 你的库
persist-mysql  ─┘      （三个 Store + 建表）
```

薄壳只做一件事：把你的驱动包成一个 Kysely 实例，转交核心。所以**已经在用 Kysely 的人
直接装核心**——nimbo 的三张表和你自己的表就在同一个实例、同一套迁移之下。

> **为什么底下是 Kysely**：这跟 better-auth 是同一个答案（它的内置适配器也是 kysely）。
> 自己手搓一个方言层，在「MySQL 不支持 `RETURNING`」这类差异上很快就要开始长分支；
> 用现成的之后，三个方言真正的差异只剩三处（列类型、幂等插入写法、JSON 读回来要不要
> 自己 parse）。

### MongoDB 那一档不在这棵树上

`@nimbo/persist-mongo` **不是薄壳**——Kysely 是 SQL 查询构建器，Mongo 用不上，所以它
直接实现三个领域接口。

它同时是对本文 §4「不做的」那三条准则的**第一次真检验**。那三条（不要求事务能跨接口 /
不要求 CAS / 不管跨会话查询）当初就是为了不把非关系型挡在门外才那么写的：

| 准则 | 在 Mongo 上成不成立 |
|---|---|
| 不要求事务能跨接口 | ✅ 需要原子的只有出队，Mongo 的 `findOneAndDelete` 原生原子 |
| 不要求 CAS | ✅ 一次都没用上 |
| 不管跨会话查询 | ✅ 每个查询都以会话 id 打头，正好是索引前缀 |

**三条全成立，接口没有漏掉关系型假设。** 而且有一处 Mongo 反而更干净：出队要求
「取出即移除、一个方法内原子完成」，SQL 那几家是读-删两步 + 竞态重试，Mongo 是
数据库直接给的。

### 第六行不是降级方案

最后那一行**是头等路径，不是兜底**。框架的设计就是「逻辑层定义模型、宿主负责存」——三个接口一共十来个方法，架在你**已有的表**上通常比迁就官方包的表更省事。

本仓库的 chat 应用（`apps/node-server`）走的正是这条：它的[待发队列](../../../terms.md)存在 `conversations` 的一个 JSON 列里、[起轮标记](../../../terms.md)存在同表的一个列上，跟下面「参考 schema」的四张表**结构上就不一样**——而这是有理由的（队列与会话天然 1:1、有序、量小、永远整体读写，不值得为它单开一张表）。

**两个真实实现并存是刻意的**：官方包和自建实现互相当对照，接口有没有漏假设才检验得出来。

> **2026-08-23 推翻了原来的「方言不是包」。** 原方案是一个 `@nimbo/persist-sql` 同时支持
> 两种方言、方言作参数。改成一种库一个包，两个理由：① 依赖关系一眼能看明白——每个包
> 只 peer-dep 自己那个驱动，装 Postgres 的人不会被 `better-sqlite3` 和 `mysql2` 污染；
> ② 加 MySQL 时才发现「方言是参数」这个说法掩盖了真实成本——三家的差异要么进一个越长
> 越大的 `if`，要么进包名。进包名更诚实。

## 3. 你会看到的行为

- **零配置能跑。** 不配持久化时用内置内存实现——进程退出数据就没了，适合本地试、写测试。
- **换实现不改业务代码。** 换持久化只动装配那一处；起轮、审批、挂起恢复的行为完全一样。
- **迁移是你自己跑的。** 官方实现自带迁移脚本，但**迁移不是接口的一部分**——nimbo 不假设你的存储「有迁移这回事」。
- **nimbo 不碰你的用户表。** 它只认一个不透明的 `ownerId` 字符串，不建外键、不管这个 id 从哪来。你的用户体系是你的。

## 4. 范围与非目标

**不做的**：

- **不提供 ORM，也不替你管连接池**——你给实例，nimbo 用。
- **不要求事务能跨接口**。需要原子的地方收进一个方法里。要求「传一个跨接口的事务对象」等于宣布只支持关系型数据库，那就把 Durable Object、Mongo 这类挡在门外了。
- **不要求 CAS**（比对后再写）。CAS 是[租约版归属仲裁机制](../../../logic/arbitration/features/arbitration-impl.md)的要求，**不是持久化的要求**——用 Durable Object 的人根本不碰它。
- **不管跨会话的查询**（「列出这个用户的所有会话」）。那是你的应用该建的索引，不是 agent 运行需要的东西。

**这一版还不做的**：

- **租约版[归属仲裁](../../../terms.md)**（心跳 + [租期标识](../../../terms.md) + CAS）。`persist-sql` 这一版只出**持久化**，仲裁仍用内置的单进程实现。两者同包但**分两次发**——混做的话之后每个诡异现象都要先分辨是谁的锅。
- **SQLite / PostgreSQL / MySQL 之外的方言**。这三种官方支持；其余走「自己实现接口」那条路，或者自己配一个 Kysely dialect 再用 `@nimbo/persist-kysely`。
- **「通用适配器」那一层**（照 better-auth 那样声明式描述 model）。三条腿各写各的够用了；等真出到第三条腿、发现三份代码在抄同一段逻辑时再抽。

## 5. 怎么用

装包，给它一个驱动实例，装配时传进去——**就这三步**，三种库都一样。

```ts
import { createAgentRuntime } from "@nimbo/agent";
import { migrate, sqlitePersistence } from "@nimbo/persist-sqlite";
import Database from "better-sqlite3";

const db = new Database("app.db");
await migrate(db);                      // 建表，幂等，跑几次都一样

const runtime = createAgentRuntime(agent, { persistence: sqlitePersistence(db) });
```

换库 = 换包 + 换驱动，**业务代码一个字不动**：

```ts
// PostgreSQL
import { migrate, postgresPersistence } from "@nimbo/persist-postgres";
import { Pool } from "pg";
const db = new Pool({ connectionString: process.env.DATABASE_URL });

// MySQL
import { migrate, mysqlPersistence } from "@nimbo/persist-mysql";
import { createPool } from "mysql2";
const db = createPool(process.env.DATABASE_URL);
```

### 已经在用 Kysely 的话

别装薄壳，直接装核心，把你自己的实例给它——nimbo 的三张表和你的表就在同一个实例、
同一套迁移之下：

```ts
import { kyselyPersistence, migrate } from "@nimbo/persist-kysely";
import type { NimboDatabase } from "@nimbo/persist-kysely";

// 把 nimbo 的三张表并进你自己的库类型
interface MyDatabase extends NimboDatabase {
  my_users: MyUsersTable;
}

const db = new Kysely<MyDatabase>({ dialect: new PostgresDialect({ pool }) });
await migrate(db, { flavor: "postgres" });

createAgentRuntime(agent, { persistence: kyselyPersistence(db, { flavor: "postgres" }) });
```

### 表名

固定叫 `nimbo_ledger` / `nimbo_decisions` / `nimbo_queue`，**不提供前缀开关**。
Kysely 的类型是按字面量表名推的，前缀一动态化就得退回 `any`，等于把类型安全的查询
扔掉去换一个几乎没人用的开关。真要隔离，Postgres/MySQL 有 **schema / database**
这个更对的工具。

### 迁移

`migrate()` 是**你自己调**的，不是包在背后偷偷跑的——什么时候建表归你（启动时？部署
脚本里？）。它幂等，重复调用无副作用。

不想用它、想让 nimbo 的表进你自己的迁移体系也行：表结构就是 `NimboDatabase` 那三个
interface，照着写进你的迁移即可。**迁移不是接口的一部分**这条准则就是为这个留的口子。

## 6. 成功标准

1. **一致性测试套件**：同一套用例分别跑内存实现、SQLite、Postgres（pglite 与真库）、MySQL（真库）、**MongoDB（真库）**，全部行为一致。这是主验收项——它同时验证了「换实现不改行为」这个承诺，以及**接口对非关系型也成立**。
2. **零 ORM 的应用能只靠这几个包跑起来**：`apps/persist-demo` 从空库开始，建表 → 跑几轮 → 重启进程 → 历史还在、队列还在，三种库各跑一遍。
3. 不装任何持久化包时，`@nimbo/agent` 仍能直接跑起来（内置内存实现不受影响）。
4. `apps/node-server` **一行不改**仍然全绿——它是「宿主自己实现接口」那条路的对照组。
