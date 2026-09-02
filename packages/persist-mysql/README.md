# @runko/persist-mysql

runko 的持久化实现，**MySQL（mysql2）**。

你只有一个驱动实例、没在用任何 ORM 时装这个。

```sh
pnpm add @runko/persist-mysql mysql2
```

```ts
import { createAgentRuntime } from "@runko/agent";
import { migrate, mysqlPersistence } from "@runko/persist-mysql";
import { createPool } from "mysql2";

const db = createPool(process.env.DATABASE_URL);

await migrate(db);          // 建表，幂等，跑几次都一样

const runtime = createAgentRuntime(agent, { persistence: mysqlPersistence(db) });
```

## 它是个薄壳

本包只做一件事：把你的驱动包成一个 Kysely 实例，转交
[`@runko/persist-kysely`](../persist-kysely/README.md)。三个 Store 与建表的实现都在那儿。

```
persist-sqlite ─┐
persist-postgres ┼─→ persist-kysely ─→ 你的库
persist-mysql  ─┘
```

**已经在用 Kysely 了？** 别用这个包——直接装 `@runko/persist-kysely`，把你自己的实例
给它，runko 的四张表和你的表就在同一个实例、同一套迁移之下。

**一种库一个包**，所以本包只 `peerDependencies` `mysql2`——不会把别家的驱动拖进你的
依赖树。

## 它存什么

四张表：`agent_ledger`（账本）· `agent_decisions`（人工裁决留底）· `agent_queue`（待发队列）· `agent_leases`（租约表）。
表名固定，不提供前缀开关——要隔离请用 schema/database。

**它不存你的东西。** runko 只认一个不透明的 `conversationId`，会话叫什么、属于谁，
全归你自己存。它不建外键、不碰你的用户表。

## 文档

[功能手册](../../docs/host/contract/features/persistence.md) ·
[技术方案](../../docs/host/contract/tech/persistence.md) ·
[施工进展](../../docs/host/contract/plans/persistence.md)

跑得起来的例子：`apps/persist-demo`——一个零 ORM 的 Hono 服务，三种库都能跑。
