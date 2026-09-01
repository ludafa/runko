# @nimbo-demo/persist-demo

**零 ORM 的 nimbo 宿主** —— 持久化只用官方的 `@nimbo/persist-*` 包，一行 ORM 都没有。

它存在的目的只有一个：证明「装个包 + 给它一个驱动实例」真的能跑起来一个完整的
agent 服务。不是玩具脚本，是一个对外提供 HTTP 端点的真服务。

## 跑起来

```sh
pnpm --filter @nimbo-demo/persist-demo start
# → persist-demo 起来了：http://localhost:3910（sqlite）
```

**不需要 API key**。没配 `DEEPSEEK_API_KEY` 时用一个"回声模型"——不联网，回一句固定话。
这个 demo 要展示的是持久化，一上来先要人配 key 是没必要的门槛。

| 环境变量 | 缺省 | 说明 |
| --- | --- | --- |
| `PORT` | `3910` | 监听端口（避开 chat 应用的 3900） |
| `DEMO_DB` | `sqlite` | `sqlite` / `memory` / `postgres` / `mysql` / `mongo`（认不出来的值一律回落成 `sqlite`） |
| `DEMO_DB_PATH` | `demo.db` | SQLite 库文件 |
| `DATABASE_URL` | — | `DEMO_DB=postgres` 时的连接串 |

换库只动 `src/driver.ts` 一个文件，业务代码一个字不改——这就是「持久化是宿主层能力」
那句话的实际手感。

## 里面有什么

```
src/
  driver.ts   选驱动 + 建表 + 装出 Persistence  ← 换库只动这里
  store.ts    demo 自己的会话表（裸 SQL）        ← 见下
  agent.ts    内存工作区 + mini-bash
  model.ts    真模型 / 回声模型
  server.ts   Hono 路由，只做翻译
  app.ts      把上面几样串起来  ← 整个装配就这么长
```

**两套表并存，而且互不知道对方**：

| 谁的 | 表 | 谁在写 |
| --- | --- | --- |
| nimbo 的 | `nimbo_ledger` / `nimbo_decisions` / `nimbo_queue` | `@nimbo/persist-*` |
| demo 的 | `demo_conversations` | `src/store.ts`，裸 SQL |

这正是框架的准则「nimbo 不拥有用户实体」的样子——它只认一个不透明的 `conversationId`，
会话叫什么、属于谁，归宿主自己存。

> `src/store.ts` 里有约二十行手写的「查询口」，把同步的 better-sqlite3 和异步的 pg 抹平。
> **这是「本 demo 要同时支持两种方言」的成本，不是「当 nimbo 宿主」的成本**——真实应用
> 只挑一个数据库，直接 `db.prepare(…).run(…)` 就完了，不需要这一层。
>
> 而且它跟 nimbo 完全无关：这二十行伺候的是 `demo_conversations`（demo 自己的产品数据）。
> **agent 那三张表一次都没被这里碰过**，全归 `@nimbo/persist-*`。

## 端点

形状**刻意对齐 `apps/node-server`**（去掉认证/沙盒/推送/遥测这些跟持久化无关的）。
对齐一个已经写死的契约是刻意的：demo 是我们自己写的，天然有「不自觉迁就包的能力」的
风险，照着别人定好的形状写，包做不到的地方会当场暴露。

| 方法 | 路径 |
| --- | --- |
| POST / GET | `/api/chat/conversations` |
| GET | `/api/chat/conversations/:id/messages`（`?after=<seq>` 续传） |
| POST | `/api/chat/conversations/:id/messages` |
| GET | `/api/chat/conversations/:id/stream`（SSE） |
| GET / DELETE | `/api/chat/conversations/:id/queue[/:messageId]` |
| POST | `/api/chat/conversations/:id/abort` |
| GET | `/api/chat/conversations/:id/activity` |
| POST | `/api/chat/conversations/:id/approvals/:callId` |
| POST | `/api/chat/conversations/:id/questions/:callId` |

试一下：

```sh
ID=$(curl -s -XPOST localhost:3910/api/chat/conversations \
      -H 'content-type: application/json' -d '{"title":"试试"}' | jq -r .id)

curl -s -XPOST localhost:3910/api/chat/conversations/$ID/messages \
     -H 'content-type: application/json' -d '{"text":"你好"}'

curl -s localhost:3910/api/chat/conversations/$ID/messages | jq
```

## 测试

```sh
pnpm --filter @nimbo-demo/persist-demo test
```

19 条 e2e，**两种方言各跑一遍同一套**（SQLite 与 pglite），外加一条跨重启的——
换个进程、新连接、新 runtime，账本与会话都还在。

不起真端口，直接对 `app.request()` 打（Hono 原生能力）：快，且没有端口冲突。

## 不做的

- **沙盒**。工作区是内存 FS + mini-bash，进程重启就没了。这个 demo 要证的是持久化，
  少一个外部依赖就少一个 flaky 来源。
- **认证**。没有用户体系，`userId` 是可选的自由字符串。
- **推送 / 遥测 / skill**。跟持久化无关。

要看这些东西怎么做，去 `apps/node-server`——那是完整的那个。
