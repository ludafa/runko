# @runko-demo/persist-demo

**零 ORM 的 runko 宿主** —— 持久化只用官方的 `@runko/persist-*` 包，一行 ORM 都没有。

它存在的目的只有一个：证明「装个包 + 给它一个驱动实例」真的能跑起来一个完整的
agent 服务。不是玩具脚本，是一个对外提供 HTTP 端点的真服务。

## 跑起来

```sh
pnpm --filter @runko-demo/persist-demo start
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
| runko 的 | `agent_ledger` / `agent_decisions` / `agent_queue` | `@runko/persist-*` |
| demo 的 | `demo_conversations` | `src/store.ts`，裸 SQL |

这正是框架的准则「runko 不拥有用户实体」的样子——它只认一个不透明的 `conversationId`，
会话叫什么、属于谁，归宿主自己存。

> `src/store.ts` 里有约二十行手写的「查询口」，把同步的 better-sqlite3 和异步的 pg 抹平。
> **这是「本 demo 要同时支持两种方言」的成本，不是「当 runko 宿主」的成本**——真实应用
> 只挑一个数据库，直接 `db.prepare(…).run(…)` 就完了，不需要这一层。
>
> 而且它跟 runko 完全无关：这二十行伺候的是 `demo_conversations`（demo 自己的产品数据）。
> **agent 那三张表一次都没被这里碰过**，全归 `@runko/persist-*`。

## 跑两个副本

多副本只靠一个环境变量开：`RUNKO_NODE_URL` 是本副本的**可达地址**，原样进 `holder`。
给了它就换成租约版[归属仲裁机制](../../docs/terms.md)并打开转发；不给就是单副本跑法，
行为与以前一字不差。

```sh
# 两个进程，共用一个 SQLite 文件（就是部署形态里的「① 同机 cluster」）
PORT=3921 DEMO_DB_PATH=/tmp/runko-demo.db RUNKO_NODE_URL=http://127.0.0.1:3921 \
  pnpm --filter @runko-demo/persist-demo start &
PORT=3922 DEMO_DB_PATH=/tmp/runko-demo.db RUNKO_NODE_URL=http://127.0.0.1:3922 \
  pnpm --filter @runko-demo/persist-demo start &
```

跨机就把 `DEMO_DB=postgres` + `DATABASE_URL` 换上，`RUNKO_NODE_URL` 填 pod 的可达地址。

| 变量 | 说明 |
| --- | --- |
| `RUNKO_NODE_URL` | 本副本可达地址；**给了才开多副本** |
| `RUNKO_PEER_TOKEN` | 副本之间的内部令牌；不配就不校验（本机联调用） |
| `RUNKO_HEARTBEAT_MS` / `RUNKO_TAKEOVER_MS` | 租约的两个时间参数，缺省 5000 / 60000 |
| `DEMO_MODEL_DELAY_MS` | 回声模型答话前先睡多久，用来手工制造「一轮还在跑」 |

**转发哪些端点**，判据只有一条：这件事的状态在数据库里，还是在持有者的**进程内存**里。

| 端点 | 转不转 | 为什么 |
| --- | --- | --- |
| `POST …/messages` | 转 | 起轮要在持有者那儿发生（拿 `held_by_other` 带回的 `holder`） |
| `POST …/abort` | **必须转** | 停止作用在持有者的 `AbortController` 上 |
| `POST …/approvals/:callId` · `…/questions/:callId` | **必须转** | 待裁决项挂在持有者内存里那一轮上 |
| `GET …/stream` | 转 | 进行中草稿在持有者内存里 |
| `DELETE …/queue[/:id]` | 转 | 改完库要广播一帧新快照，而订阅者都在持有者那一侧 |
| `GET …/messages` · `GET …/queue` | 不转 | 读，状态在库里，谁都能答 |

转发带 `x-runko-forwarded: 1`，**带着它进来的请求一律不再转**——没有这条，两个副本在归属
刚好易主的那一瞬间会打成死循环。

验收跑的是 `test/multi-replica.e2e.test.ts`：两个真进程、一个 SQLite 文件、四个场景，
其中「被误判的老持有者活过来之后写不进账本」是核心那条。设计见
[多副本部署](../../docs/host/node/tech/multi-replica.md)。

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
pnpm --filter @runko-demo/persist-demo test
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
