# @runko/persist-kysely

runko 持久化的**核心实现**，底下是 [Kysely](https://kysely.dev)。

四张表的读写与建表都在这儿；SQLite / PostgreSQL / MySQL 三个薄壳共用它。

## 什么时候装它

**你已经在用 Kysely。** 把你自己的实例给它，runko 的四张表和你的表就在同一个实例、
同一套迁移之下：

```ts
import { Kysely, PostgresDialect } from "kysely";
import { kyselyPersistence, migrate } from "@runko/persist-kysely";
import type { RunkoDatabase } from "@runko/persist-kysely";

// 把 runko 的四张表并进你自己的库类型
interface MyDatabase extends RunkoDatabase {
  my_users: MyUsersTable;
}

const db = new Kysely<MyDatabase>({ dialect: new PostgresDialect({ pool }) });
await migrate(db, { flavor: "postgres" });

createAgentRuntime(agent, {
  persistence: kyselyPersistence(db, { flavor: "postgres" }),
});
```

### `migrate()` 的承诺范围

**它只做首建，不做 schema 演进。** 四张表都是 `CREATE TABLE IF NOT EXISTS`——表已经
存在时它是彻底的 no-op，**不会**改列、加列或改排序规则。所以：

- 本包后续版本若动了 schema，**老库必须由你自己出一次迁移**。本包不带版本表、不记
  migration 历史，也不会替你 ALTER。
- 想并进自己的迁移体系（drizzle / prisma / flyway / 手写）？随包发的
  [`schema.sql`](./schema.sql) 就是同一份 DDL，三个方言各一段，照抄即可。
- **不能并发调**：Postgres 上多个实例同时跑 `CREATE TABLE IF NOT EXISTS` 会撞
  `pg_type` 的唯一索引报重复键（Postgres 已知行为）。幂等 ≠ 可并发——启动时串行调一次。

**只有一个驱动、没在用 Kysely？** 装薄壳，它们替你把 Kysely 装配好：

| 你用什么 | 装哪个 |
| --- | --- |
| `better-sqlite3` | [`@runko/persist-sqlite`](../persist-sqlite/README.md) |
| `pg` | [`@runko/persist-postgres`](../persist-postgres/README.md) |
| `mysql2` | [`@runko/persist-mysql`](../persist-mysql/README.md) |

## 为什么底下是 Kysely

跟 better-auth 是同一个答案——它的内置适配器也是 kysely。

这个包的第一版自己手搓了一个方言层。加 MySQL 的时候发现要开始长分支了：**MySQL 不支持
`RETURNING`**，而判断「这条 UPDATE 到底改没改」全靠它。换成 Kysely 之后：

- 改用 `numUpdatedRows` / `numDeletedRows`，三家通吃
- 占位符、标识符引号、查询构建全归它
- 白捡类型安全——写错列名当场编译不过

**三个方言真正的差异只剩五处**（全在 `flavor.ts`）：

| | SQLite | Postgres | MySQL |
|---|---|---|---|
| 幂等插入 | `ON CONFLICT DO NOTHING` | 同左 | `ON DUPLICATE KEY UPDATE`（见下） |
| JSON 列类型 | `text` | `jsonb` | `json` |
| 读回来的 JSON | **字符串**（要自己 parse） | 对象（驱动已 parse） | 对象（驱动已 parse） |
| 整数列类型 | `integer` | `bigint` | `bigint` |
| 主键字符串列 | `varchar(255)` | 同左 | `varchar(255) COLLATE utf8mb4_bin`（见下） |

**MySQL 的两处坑都不是风格差异，是会出错的语义差异：**

- **排序规则**：MySQL 8 默认的 `utf8mb4_0900_ai_ci` **大小写与重音都不敏感**，另两家区分
  大小写。不显式 `COLLATE utf8mb4_bin` 的话 `AbC` 和 `abc` 会被当成同一个 conversationId
  ——跨会话读到别人的账本，主键上还会撞键。契约明说 conversationId 是**不透明字符串**，
  不能推给宿主「别用混合大小写」；`tool_call_id` 更要紧（模型给的 call id 本来就混合大小写）。
- **`INSERT IGNORE` 不能用**：它把**所有**可恢复错误降级成 warning（超长截断、约束失败
  整行跳过），调用方却拿到「写成功了」。改用 `ON DUPLICATE KEY UPDATE <某列>=<某列>`
  ——一个无操作的更新，只吞重复键，语义与另两家的 `DO NOTHING` 对齐。

> 后两行是同一件事的两面。**别写「是字符串就 parse 一下」这种对冲**——一个合法存进去的
> JSON 字符串（比如 `ask-user` 的问题正文）读回来就是个 JS string，跟「还没解析的 JSON
> 文本」在类型上完全一样，猜不出来。第一版就栽在这，被一致性套件在 pglite 上抓出来。

## 表

`agent_ledger`（账本）· `agent_decisions`（人工裁决留底）· `agent_queue`（待发队列）。

**表名固定，不提供前缀开关。** Kysely 的类型按**字面量表名**推，前缀一动态化就得退回
`any`，等于把这个库最值钱的东西扔掉去换一个几乎没人用的开关。要隔离请用 schema/database
（Kysely 有 `db.withSchema()`）。

**它不存你的东西。** runko 只认一个不透明的 `conversationId`——会话叫什么、属于谁，全归
你自己存。它不建外键、不碰你的用户表。

## 不是只有这一条路

**你的 schema 跟这四张表对不上？那就自己实现那三个接口**——那是[头等路径，不是降级方案](../../docs/host/contract/features/persistence.md)。
一共十来个方法，架在你**已有的表**上通常比迁就本包的表更省事。

自己实现的话，装上 [`@runko/conformance`](../conformance/README.md) 自测：

```ts
import { persistenceCases } from "@runko/conformance";

describe("我自己的实现", () => {
  for (const testCase of persistenceCases) {
    it(testCase.name, async () => {
      await testCase.run({ persistence: myPersistence() });
    });
  }
});
```

套件**不依赖任何测试框架**——它只导出 `{ name, run }` 这样的用例数据，`describe`/`it`
由你来接，vitest / jest / node:test / Workers 上都能跑。

31 条不变量，接口注释里那些「写死了但容易漏」的边角它都替你验了。

## 测试

```sh
pnpm --filter @runko/persist-kysely test
```

默认跑 SQLite 与 Postgres（**pglite**，WASM 进程内，不用起服务）。要连真库：

```sh
RUNKO_TEST_POSTGRES_URL=postgres://... RUNKO_TEST_MYSQL_URL=mysql://... pnpm test
```

**MySQL 没有进程内替身**，只能对真库跑——不给连接串时那一档会跳过并说明原因。

## 文档

[功能手册](../../docs/host/contract/features/persistence.md) ·
[技术方案](../../docs/host/contract/tech/persistence.md) ·
[施工进展](../../docs/host/contract/plans/persistence.md)
