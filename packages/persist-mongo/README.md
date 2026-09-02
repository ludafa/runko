# @runko/persist-mongo

runko 的持久化实现，**MongoDB**——也是第一个**非关系型**实现。

```sh
pnpm add @runko/persist-mongo mongodb
```

```ts
import { createAgentRuntime } from "@runko/agent";
import { migrate, mongoPersistence } from "@runko/persist-mongo";
import { MongoClient } from "mongodb";

const client = new MongoClient(process.env.MONGO_URL);
await client.connect();
const db = client.db("myapp");

await migrate(db);          // 建索引，幂等

const runtime = createAgentRuntime(agent, { persistence: mongoPersistence(db) });
```

**吃 `Db` 而不是 `MongoClient`**：选哪个 database 是你的决定（多租户可能一租户一个 db），
连接的生命周期也归你——本包不 connect、不 close。

## 它不是薄壳

SQLite / PostgreSQL / MySQL 那三个包底下共用 `@runko/persist-kysely`。Kysely 是 SQL
查询构建器，Mongo 用不上，所以**这个包直接实现三个领域接口**。

## 它顺带证明了什么

契约里有三条准则，当初就是为了**不把非关系型挡在门外**才那么写的。这是第一次真去验：

| 准则 | 结论 |
| --- | --- |
| 不假设事务能跨接口 | ✅ 需要原子的只有 `dequeue`，Mongo 的 `findOneAndDelete` 原生原子 |
| 不要求 CAS | ✅ 一次都没用上 |
| 不支持跨会话查询 | ✅ 每个查询都以 `conversationId` 打头，正好是索引前缀 |

三条全成立——接口**没有漏掉关系型假设**。

有一处 Mongo 反而更干净：契约要求 `dequeue`「取出即移除，一个方法内原子完成」，
SQL 那几家是「先 SELECT 排序取第一条、再 DELETE」两步，中间有窗口、得靠重试兜；
Mongo 的 `findOneAndDelete({...}, {sort})` **是数据库直接给的**。

## 它存什么

三个集合：`agent_ledger`（账本）· `agent_decisions`（人工裁决留底）· `agent_queue`（待发队列）。

集合名固定，不提供前缀开关——**要隔离请用另一个 database**，那在 Mongo 里是一等公民，
比集合名前缀干净得多。

`migrate()` 只建索引（Mongo 的集合是隐式创建的）。但它**不是可选的**：账本与裁决表的
幂等写入靠唯一索引兜底，没有它并发写会写出两行。

**它不存你的东西。** runko 只认一个不透明的 `conversationId`，会话叫什么、属于谁，
全归你自己存。

## 要求 MongoDB 5.0+

工具入参是**任意 JSON**，键里可能有 `.` 或 `$`——5.0 之前的 MongoDB 不接受这种字段名。
实测 MongoDB 8 全放行。

## 两个实测出来的坑

**① `settle` 必须看 `matchedCount`，不能看 `modifiedCount`。**
Mongo 在「匹配到但新值与旧值完全相同」时报 `matched=1, modified=0`。用 `modifiedCount`
判断会把一次成功的结清误报成「没有这条」，调用方于是转 404。

> 有意思的是：契约文档曾经把这个坑安在 MySQL 头上，实测发现**在 MySQL 上不成立**
> （Kysely 的 `numUpdatedRows` 报的就是匹配数）。它的真身在这儿。

**② BSON 把 `undefined` 存成 `null`**，而 SQL 那几家走 `JSON.stringify`（直接丢掉这个键）。
本包在写入前先过一遍 `JSON.parse(JSON.stringify(...))` 对齐它们——不然一致性套件的
「原样往返」当场就红。

没走「客户端开 `ignoreUndefined`」那条路，是因为**客户端是你建的**，我们只拿到 `Db`。

## 测试

```sh
RUNKO_TEST_MONGO_URL=mongodb://127.0.0.1:27018 pnpm --filter @runko/persist-mongo test
```

跟其余三个持久化包**跑同一套一致性用例**。不给连接串时整档跳过并说明原因——
Mongo 没有 pglite 那样的进程内替身（`mongodb-memory-server` 是下载一个真 mongod 来跑）。

## 不是只有这一条路

**你的数据模型跟这三个集合对不上？那就自己实现那三个接口**——那是[头等路径，不是降级方案](../../docs/host/contract/features/persistence.md)。
一共十来个方法。自己实现的话，装上 [`@runko/conformance`](../conformance/README.md) 自测：

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

## 文档

[功能手册](../../docs/host/contract/features/persistence.md) ·
[技术方案](../../docs/host/contract/tech/persistence.md) ·
[施工进展](../../docs/host/contract/plans/persistence.md)
