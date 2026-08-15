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
> **状态：接口未定稿。** 本文写的是已经拍板的形态与约束；具体方法签名随 `@nimbo/agent` 一起定，未定处标了 `TODO`。

## 0. 一句话

**框架定义「数据长什么样」，你决定「它存在哪」**——换一个数据库，就是换一个持久化实现，agent 的行为一个字都不用改。

## 1. 解决什么问题

拿 nimbo 建产品的人，应用里本来就有自己的数据库、自己的 ORM、自己的领域模型。如果 nimbo 硬绑一种存储，他要么被迫多养一个数据库，要么放弃自己那套 schema 管理。

所以持久化被划到[宿主层](../../../terms.md)：**可替换，而且四样宿主能力里它是最常被换的一个。**

它要存的是四样东西——[账本](../../../terms.md)、人工裁决、[待发队列](../../../terms.md)、[租约](../../../terms.md)表。四样都由[轮编排](../../../terms.md)定义模型、由持久化负责落地。语义与字段见 [架构总纲 · 技术方案 §3](../../../architecture/tech/agent-kernel.md)（**数据模型的单一事实来源在那里**，本文不复述）。

## 2. 三条腿，按你已有的东西挑

| 你的情况 | 装哪个 | 你要给它什么 |
|---|---|---|
| 应用里没有 ORM，直接用驱动 | `@nimbo/persist-sql` | 一个 `pg.Pool` 或 `better-sqlite3` 实例 |
| 应用里已经在用 drizzle | `@nimbo/persist-drizzle` | 你已有的 drizzle 实例 |
| 应用里已经在用 Prisma | `@nimbo/persist-prisma` | 你已有的 Prisma client |
| 跑在 Cloudflare Durable Object 上 | `@nimbo/durable-object` | 什么都不用给（用 `ctx.storage.sql`） |
| 只是本地跑跑、不要求重启后还在 | **什么都不用装** | 内置内存实现，零配置 |

**方言不是包。** `persist-sql` 一个包同时支持 SQLite 与 Postgres，方言是参数——不是两个包。首批官方支持这两种。

> 为什么要出「裸驱动」和「ORM」两条腿，而不是两个 SQL 方言：见[技术方案 §2](../tech/persistence.md)。简单说，**这两条腿的形状差异比两个方言大得多，能真检验出接口有没有漏假设。**

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

**TODO（未定）**：

- 领域接口的具体方法名与签名（`LedgerStore` / `DecisionStore` / `QueueStore` / `LeaseStore` 这组名字本身也未定稿）。
- 「通用适配器」那一层要不要跟 better-auth 一样声明式描述 model，还是每条腿各写各的。
- 官方参考 DDL 放在哪、以什么形式发。

## 5. 成功标准

1. 同一套端到端测试，把持久化从内存换成 SQLite 再换成 Postgres，**行为完全一致**。
2. 一个已经在用 drizzle 的应用，接上 `@nimbo/persist-drizzle` 之后，nimbo 的表和它自己的表**在同一套 schema 管理之下**。
3. 不装任何持久化包时，`@nimbo/agent` 能直接跑起来。
