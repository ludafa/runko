---
title: "多副本部署（Node 长驻）— 使用手册"
slug: multi-replica
view: 功能
layer: 宿主层
module: —
packages: ["@runko/agent", "@runko/persist-kysely", "@runko/persist-sqlite", "@runko/persist-postgres", "@runko/persist-mysql", "@runko/persist-mongo"]
tags: ["多副本", "租约", "应用层转发", "docker-compose", "验证环境", "故障演练"]
related: ["host/node/tech/multi-replica.md", "host/node/plans/multi-replica.md", "host/node/features/deployment.md", "logic/arbitration/features/arbitration-impl.md"]
---

# 多副本部署（Node 长驻）— 使用手册

> 相关：[技术方案](../tech/multi-replica.md) · [施工计划](../plans/multi-replica.md) · [Node 长驻 · 使用手册](./deployment.md)（四个台阶的全貌，本文只讲最后一级「③ 多副本」）。
> 术语：[归属仲裁机制](../../../terms.md) · [租约](../../../terms.md) · [租约心跳](../../../terms.md) · [接管阈值](../../../terms.md) · [自我围栏](../../../terms.md) · [应用层转发](../../../terms.md) · [孤儿轮](../../../terms.md) · [多副本验证环境](../../../terms.md)。

## 1. 一句话

**同一个服务起好几份（副本），共用一个数据库；不管请求打到哪一份，用户看到的都是同一场对话。**

你要做的只有两件事：把[归属仲裁机制](../../../terms.md)换成租约版，在接入代码里把请求转给「这份对话的持有者」。业务代码一行不动。

## 2. 它解决什么问题

一份对话同一时刻只能有一个执行在跑（这叫[独占](../../../terms.md)）。单进程时，内存里一个 Map 就能保证。

起了第二个副本之后，这条就不成立了：

- 两个副本各有一份内存 Map，互相看不见，于是**两边都可能起轮、都往同一本账本写**。
- 用户的请求被负载均衡随机分到某个副本上，而**正在跑的那一轮只活在其中一个副本的内存里**。停止、审批、看直播，打错副本就等于没打。

多副本部署把这两件事都补上：

| 问题 | 靠什么解决 |
|---|---|
| 两个副本同时推进一份对话 | [租约](../../../terms.md)：库里一行记录说「归谁」，抢到的才能跑 |
| 被误判出局的老持有者还在写 | [租期标识](../../../terms.md)：每次写账本都带着，对不上就写不进去 |
| 持有者崩溃，对话永远卡住 | [租约心跳](../../../terms.md) + [接管阈值](../../../terms.md)：太久没续约就允许别人抢 |
| 持有者和库断开，它不知道自己已出局 | [自我围栏](../../../terms.md)：续约一直失败就自己先停手 |
| 请求打到了不是持有者的副本 | [应用层转发](../../../terms.md)：框架告诉你持有者地址，你转过去 |

## 3. 适合谁

- 在 k8s、ECS、Docker Swarm 或几台虚机上跑**两份以上**同一个服务的人。
- 同一台机器上开 Node cluster 多 worker 的人（worker 之间不共享内存，也算多副本）。

**不适合**：Serverless 函数（实例由平台调度，你找不到持有者），去看 [Vercel](../../vercel/features/deployment.md) 那一档。

## 4. 怎么开

拿 `@runko-demo/persist-demo` 举例，**一个环境变量**就开：

| 环境变量 | 缺省 | 作用 |
|---|---|---|
| `RUNKO_NODE_URL` | — | 本副本**能被其他副本访问到**的地址，比如 `http://10.1.2.3:3910`。给了才开多副本 |
| `RUNKO_PEER_TOKEN` | 空 | 副本之间互相转发时用的内部令牌。不配就不校验，只适合本机联调 |
| `RUNKO_HEARTBEAT_MS` | `5000` | [租约心跳](../../../terms.md)间隔 |
| `RUNKO_TAKEOVER_MS` | `60000` | [接管阈值](../../../terms.md)。必须 ≥ 3 倍心跳，否则启动就报错 |
| `RUNKO_FORWARD_TIMEOUT_MS` | `10000` | 转发给持有者时，最多等多久对方开始回话。等不到就回 503 让客户端重试 |
| `RUNKO_LOG_LEVEL` | `info` | 日志详细程度：`debug` / `info` / `warn` / `error` / `silent`。起轮收尾、转发、每个请求都会记，见 §6.4 |

在你自己的服务里，对应的是装配处的两行：

```ts
import { postgresArbitration, postgresPersistence } from "@runko/persist-postgres";

createAgentRuntime({
  // ...
  persistence: postgresPersistence(pool),
  arbitration: postgresArbitration(pool, { holder: process.env.RUNKO_NODE_URL }),
});
```

**四档库都有租约版**，换一个包、换一个驱动实例，形状完全一样：

| 库 | 装的包 | 那两行写成 |
|---|---|---|
| SQLite（同机多进程） | `@runko/persist-sqlite` | `sqlitePersistence(db)` · `sqliteArbitration(db, { holder })` |
| PostgreSQL | `@runko/persist-postgres` | `postgresPersistence(pool)` · `postgresArbitration(pool, { holder })` |
| MySQL | `@runko/persist-mysql` | `mysqlPersistence(pool)` · `mysqlArbitration(pool, { holder })` |
| MongoDB | `@runko/persist-mongo` | `mongoPersistence(db)` · `mongoArbitration(db, { holder })` |

转发怎么写看 `apps/persist-demo/src/forward.ts`。哪些端点要转、哪些不用，见[技术方案 §5.3](../tech/multi-replica.md)。

## 5. 出故障时，用户会看到什么

| 发生了什么 | 用户看到的 | 多久 |
|---|---|---|
| 请求打到了非持有者 | 什么都感觉不到（被转发了） | 多一跳网络 |
| 持有者进程崩溃 | 那一轮一直转圈；**过了接管阈值后**再发消息能正常起轮，崩溃那一轮显示「已停止」 | 最多一个接管阈值（缺省 60 秒） |
| 持有者被冻住或卡死（没死，只是不响应） | 发往其他副本的请求**在转发超时后收到 503**，稍后重试即可；接管后恢复正常 | 转发超时（缺省 10 秒）+ 接管阈值 |
| 持有者只是很慢（比如库卡了超过转发超时） | 同样收到 503。**这时请求可能其实已经被处理了**，重试发消息可能多出一条 | 转发超时 |
| 持有者和数据库断开 | 那一轮被中断；接管后能继续 | 约「接管阈值 − 一拍心跳」时自己停手 |
| 数据库短暂卡了一两秒 | 什么都感觉不到，这一轮照常跑完 | — |
| 被误判出局的老持有者活过来 | 什么都感觉不到。它想写的东西**一律写不进账本** | — |

「稍后再试」一律是 **503 + `Retry-After` 响应头**，body 里的 `reason` 说明原因（`holder_unreachable` / `held_by_other` / `shutting_down`）。
**不用 421**：按 Fetch 标准，浏览器和 Node 的 `fetch` 收到 421 会**自动把请求再发一遍**，等待翻倍，发消息的请求还会被悄悄重发。

> **想让用户早点知道，别把接管阈值调小。** 调小会让一次普通的卡顿被当成死亡。应该在界面上提示「这一轮所在的节点失联了，正在等待接管」。

## 6. 在本机验证：多副本验证环境

不想上 k8s 也能在本机把上面那张表**逐行演一遍**。仓库里带了一套 docker-compose，叫[多副本验证环境](../../../terms.md)：

```
              你（curl / 测试）
    ┌───────────┬───────────┬───────────┐
    │ :3930     │ :3931     │ :3932     │ :3933
  ┌─▼──┐   ┌────▼────┐ ┌────▼────┐ ┌────▼────┐
  │ lb │──▶│replica-a│ │replica-b│ │replica-c│  ← 副本之间互相转发
  └────┘   └────┬────┘ └────┬────┘ └────┬────┘
                └───────────┼───────────┘
                       ┌────▼─────┐
                       │ postgres │ :55433
                       └──────────┘
```

- **三个副本**：各自一个固定地址 `http://replica-a:3910` 这样的，原样当作持有者地址。
- **直连端口 3931 / 3932 / 3933**：想指定打哪个副本时用它，做验证用这个。
- **nginx 负载均衡 3930**：想体验「请求随机落到某个副本」时用它。
- **时间轴压扁了**：心跳 1 秒、接管阈值 5 秒、每一轮故意跑 10 秒、转发超时 2 秒，免得每个场景等一分钟。

### 6.1 起、停

```sh
pnpm --filter @runko-demo/persist-demo lab:up     # 构建镜像并起好，等到全部健康才返回
pnpm --filter @runko-demo/persist-demo lab:down   # 全部删掉，连库里的数据一起
```

第一次要构建镜像，几分钟。之后改了代码重跑 `lab:up` 就会重新构建。

### 6.2 故意制造故障

| 想模拟 | 命令 |
|---|---|
| 进程崩溃（`kill -9`） | `docker compose -f apps/persist-demo/docker/compose.yml kill -s SIGKILL replica-a` |
| 进程冻住（像长时间 GC 或虚机被挂起） | `… pause replica-a`，恢复用 `… unpause replica-a` |
| 副本和数据库断网 | `docker network disconnect runko-lab_db runko-lab-replica-a-1`，恢复用 `connect` |
| 数据库卡顿 | `… pause postgres`，恢复用 `… unpause postgres` |
| 把崩溃的副本拉起来 | `… start replica-a` |

### 6.3 一键跑完全部场景

```sh
pnpm --filter @runko-demo/persist-demo test:lab
```

它会自己起一套**独立的**环境（换了项目名和端口，不会碰你手动起的那套），跑完全部八个场景，再自己删干净。
本机一次大约 2 分 40 秒（第一次还要加上构建镜像的时间，约 1 分钟）。场景清单见[技术方案 §11](../tech/multi-replica.md)。

没设 `RUNKO_TEST_LAB=1` 时这个测试文件整个跳过，所以平时的 `pnpm test` 和 CI 都不会去碰 Docker。

### 6.4 看日志：每一步在哪个副本、按什么顺序、花了多久

每跑一次 `test:lab`，日志都会存到 `apps/persist-demo/logs/lab-<时间>/`（不进 git），`logs/lab-latest` 指向最近一次。
测试一开始就会把这个目录打印出来，跑的过程中也能 `tail -f`。

| 文件 | 里面是什么 |
|---|---|
| `timeline.log` | **先看这个。** 测试的每一步 + 三个副本的日志，按时间排好。一次请求从哪个副本进来、转给了谁、谁起了轮、谁补了「已停止」，一条条读下来就是执行顺序 |
| `test.log` | 只有测试这边：每个场景做了哪一步、拿到了什么结果 |
| `replica-a.log` · `replica-b.log` · `replica-c.log` | 单个副本的完整日志（被 `kill -9` 又拉起来的副本，前后两段都在） |
| `postgres.log` · `lb.log` | 数据库与 nginx 自己的日志，排查它们本身的问题时看 |

`timeline.log` 里一行长这样（时间是 UTC）：

```
2026-09-13T10:48:15.283Z  test        STEP   S7            C 起轮了，冻住 replica-c  conversationId=23fb4f09-…
2026-09-13T10:48:15.405Z  replica-a   INFO   forward       forwarding to holder  method=GET path=/api/chat/conversations/23fb4f09-…/stream holder=http://replica-c:3910
2026-09-13T10:48:17.418Z  replica-a   WARN   forward       holder unreachable, answering 503  holder=http://replica-c:3910 cause="no response headers within 2000ms" elapsedMs=2013
2026-09-13T10:48:17.420Z  replica-a   INFO   http          GET /api/chat/conversations/23fb4f09-…/stream → 503  ms=2021
2026-09-13T10:48:21.443Z  replica-a   WARN   agent:queue   took over from a stale holder, settled its turn as interrupted  previousHolder=http://replica-c:3910 seq=2
```

> 租约本身的抢占、被占、**自我围栏**这几件事暂时还不在日志里：框架层的可观测性会改成「框架发事件、宿主订阅」
> （方案已对齐，见[可观测性 · 使用手册](../../../architecture/features/observability.md)），届时由 demo 的订阅者打出来。

每一行依次是：时间、谁（`test` 或哪个副本）、级别、模块、发生了什么、相关字段。带 `Ms` 的字段就是耗时。

**手动起的那套环境**也能看、也能存：

```sh
docker compose -f apps/persist-demo/docker/compose.yml logs -f        # 实时看三个副本
pnpm --filter @runko-demo/persist-demo lab:logs                       # 存一份到 logs/lab-<时间>/
```

日志详细程度用 `RUNKO_LOG_LEVEL` 控制（`debug` / `info` / `warn` / `error` / `silent`），两处缺省都是 `info`。
调成 `debug` 会多出普通的读请求（回放账本、看队列）——测试与客户端会反复读，很吵。

## 7. 成功标准

- 两个副本同时收到同一份对话的消息，**只有一个真正起轮**，另一个转过去；账本里这条消息只有一份。
- 打到任何一个副本的停止、订阅直播，都作用在持有者那一轮上。
- 持有者崩溃后，**过了接管阈值**别的副本能起轮，**崩溃那一轮在账本里有「已停止」标记**。
- 持有者冻住期间，打到其他副本的请求**在转发超时内有回应**，不会一直挂着。
- 持有者和数据库断网时，它**自己停手**；别的副本接管后，账本没有重号、没有多写。
- 被误判出局的老持有者活过来之后，**一条也写不进账本**。
- 以上每一条都能在[多副本验证环境](../../../terms.md)里一键复现。

## 8. 范围与非目标

- **不替你写转发。** 框架只给持有者地址。示范在 `apps/persist-demo`，照着改。
- **不依赖负载均衡的会话粘滞（sticky session）。** 粘滞的单位不对，见[应用层转发](../../../terms.md)。
- **崩溃不恢复进度。** 崩溃那一轮只会被标成「已停止」，不会从中间接着跑。
- **有一种情况连「已停止」也补不上**：持有者被冻住了很久、这段时间没人往这份对话发消息，它醒来后自己停手。
  那一轮只会剩下用户消息。见[技术方案 §9.6](../tech/multi-replica.md)。
- **验证环境只起了 Postgres。** 四档库（SQLite / Postgres / MySQL / MongoDB）都有租约版实现、都能跑多副本，但 `apps/persist-demo` 的 compose 只编排了 Postgres 那一档；换库要自己加一组服务。
- **验证环境测不了时钟不同步。** 所有容器共用宿主机的时钟。
- **验证环境测不了审批与提问的转发。** demo 用的回声模型不调工具，触发不了待裁决项；这两条由[技术方案 §5.3](../tech/multi-replica.md) 的转发矩阵和代码审查保证。
