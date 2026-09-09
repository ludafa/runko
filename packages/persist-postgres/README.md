# @runko/persist-postgres

runko 的持久化实现，**PostgreSQL（pg）**。

你只有一个驱动实例、没在用任何 ORM 时装这个。

```sh
pnpm add @runko/persist-postgres pg
```

```ts
import { createAgentRuntime } from "@runko/agent";
import { migrate, postgresPersistence } from "@runko/persist-postgres";
import { Pool } from "pg";

const db = new Pool({ connectionString: process.env.DATABASE_URL });

await migrate(db);          // 建表，幂等，跑几次都一样

const runtime = createAgentRuntime({ agent, prepareTurn, persistence: postgresPersistence(db) });
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

**一种库一个包**，所以本包只 `peerDependencies` `pg`——不会把别家的驱动拖进你的
依赖树。

## 它存什么

四张表：`agent_ledger`（账本）· `agent_decisions`（人工裁决留底）· `agent_queue`（待发队列）· `agent_leases`（租约表）。
表名固定，不提供前缀开关——要隔离请用 schema/database。

**它不存你的东西。** runko 只认一个不透明的 `conversationId`，会话叫什么、属于谁，
全归你自己存。它不建外键、不碰你的用户表。

## 多副本怎么配

跑不止一个进程时，光换持久化不够——还得把[归属仲裁机制](../../docs/terms.md)换成**租约版**，
否则同一份对话会被两个进程同时推进。同一个驱动实例装两次就行：

```ts
createAgentRuntime({
  agent,
  prepareTurn,
  persistence: postgresPersistence(pool),
  arbitration: postgresArbitration(pool, { holder: process.env.RUNKO_NODE_URL }),
});
```

`holder` 是**本副本的可达地址**，框架原样存、原样传、不解释它：别的副本抢不到归属时会拿到它，
由接入代码决定把请求转给谁——**转发是你写的，不是框架做的**。

两件事值得先知道：`postgresPersistence()` 与 `postgresArbitration()` 各建一个 Kysely 实例，但共用你给的那个连接池，
不多占资源；`migrate()` 仍然只调一次，租约表已经在里面了。

单进程别装它：`@runko/agent` 内置的内存版更快，[独占](../../docs/terms.md)还是**真保证**，
而租约版只能做到**尽力 + 可检测**。完整取舍与两个真进程的验收见
[多副本部署](../../docs/host/node/tech/multi-replica.md)。

## 文档

[功能手册](../../docs/host/contract/features/persistence.md) ·
[技术方案](../../docs/host/contract/tech/persistence.md) ·
[施工进展](../../docs/host/contract/plans/persistence.md)

跑得起来的例子：`apps/persist-demo`——一个零 ORM 的 Hono 服务，三种库都能跑。
