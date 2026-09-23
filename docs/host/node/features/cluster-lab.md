---
title: "集群实验环境（cluster-lab）— 功能手册"
slug: cluster-lab
view: 功能
layer: 宿主层
module: —
packages: ["@runko-chat/node-server", "@runko/stream-redis", "@runko/persist-kysely"]
tags: ["多副本", "集群", "Redis", "流分发", "WebSocket", "租约", "验证环境"]
related: ["host/node/tech/cluster-lab.md", "host/node/plans/cluster-lab.md", "host/node/features/multi-replica.md", "ingress/features/ws-stream.md", "host/contract/features/stream-fanout.md"]
---
# 集群实验环境 — 功能手册

> 术语见 [术语表](../../../terms.md)。技术方案见 [cluster-lab · 技术](../tech/cluster-lab.md)，施工见 [cluster-lab · 施工](../plans/cluster-lab.md)。

## 一句话

**一条命令起一个真集群**：一个 nginx 当统一入口（HTTP 与 WebSocket 都走它）、**1 到 5 个** chat 应用副本、一个 Postgres、一个 Redis。用它来回答两个问题：**[租约](../../../terms.md)在多副本下真的好用吗**，以及 **WebSocket 当直播流通道行不行**。

## 1. 要解决的问题

现有的[多副本验证环境](../../../terms.md)是三个写死的副本、只有 Postgres、直播流走 SSE。要验的两件新事它都盖不住：

| 想验的 | 现在的环境为什么不够 |
|---|---|
| 副本数变化时租约还对吗（1 个、5 个、中途加减） | 三个副本是写死的服务，改数量要改 compose |
| 直播流不靠转发、直接广播到每个副本 | 没有 Redis，流只能转发给[持有者](../../../terms.md) |
| WebSocket 通道在代理后面能不能用 | nginx 没配升级头，服务端也没有 WS 端点 |

## 2. 给谁用

- **要上多副本部署的开发者**：先在本机把故障走一遍，再决定线上怎么配。
- **框架维护者**：租约、接管、[自我围栏](../../../terms.md)这些只有在真集群里才现形的东西，靠它做回归。

## 3. 用起来是什么样

```sh
# 起 3 个副本（默认）
pnpm --filter @runko-chat/node-server cluster:up

# 起 5 个副本
CLUSTER_REPLICAS=5 pnpm --filter @runko-chat/node-server cluster:up

# 跑完删掉，连数据一起
pnpm --filter @runko-chat/node-server cluster:down
```

起来之后：

- **统一入口**是 nginx，缺省 `http://localhost:3940`。浏览器直接连它就行：`SERVER_URL=http://localhost:3940 pnpm chat:web`。
- **HTTP 与 WebSocket 都走同一个入口**，同一个端口。
- **副本自己的端口是随机分配的**——五个容器不能都绑同一个固定端口。要直连某一个（测试里常用）：
  ```sh
  CLUSTER_INDEX=2 pnpm --filter @runko-chat/node-server cluster:port   # 第 2 个副本的宿主机端口
  pnpm --filter @runko-chat/node-server cluster:ps                      # 都起着没有
  ```
- 每个副本自己是什么地址、谁在跑哪一轮，用 `GET /api/chat/conversations/:id/activity` 看。

集群里跑的是零配置那一档：[演示模型](../../../terms.md) + [本地沙盒](../../../terms.md)，不需要任何云账号。

### 3.2 用浏览器连进来

集群只跑服务端，前端还在本机跑。**两处地址要对上**，不然会卡在登录那一步：

```sh
# ① 起集群。CLUSTER_CLIENT_URL 指到前端的地址——容器里是 production 档，
#    better-auth 会较真地校验 Origin，不指过去的话注册/登录一律 403。
cd apps/node-server
CLUSTER_CLIENT_URL=http://localhost:5273 CLUSTER_REPLICAS=3 pnpm cluster:up

# ② 起前端，把它的 /api 代理指到 nginx（HTTP 与 WebSocket 都走这条）。
#    端口取自仓库根 .env 的 CLIENT_PORT，缺省 5273。
SERVER_URL=http://localhost:3940 pnpm chat:web
```

然后开 `http://localhost:5273`。注册一个账号即可——集群用的是零配置那一档，不需要任何云账号。

**不改 `CLUSTER_CLIENT_URL` 会怎样**：注册请求拿到 `403 {"code":"INVALID_ORIGIN"}`，界面上只看得到一次失败的登录，很难猜到原因。所以这一步单独列出来。

### 3.1 故障怎么造

下面的命令都在 `apps/node-server` 目录下跑（`-f docker/cluster.compose.yml` 省略写法见
`package.json` 里的 `cluster:*` 脚本）。副本的容器名是 `runko-cluster-node-<序号>`。

| 想造的故障 | 命令 |
|---|---|
| 某个副本崩了 | `docker kill -s SIGKILL runko-cluster-node-2` |
| 某个副本冻住（活着但不响应） | `docker pause runko-cluster-node-2` / `docker unpause …` |
| 某个副本连不上库与 Redis | `docker network disconnect runko-cluster_cluster runko-cluster-node-2` |
| Redis 挂了 | `docker compose -f docker/cluster.compose.yml stop redis` |
| 改副本数 | `CLUSTER_REPLICAS=4 pnpm --filter @runko-chat/node-server cluster:up` |

**只有一个网络**（`runko-cluster_cluster`）：摘掉一个副本，它与库、Redis、别的副本同时断——
这一档验的是[自我围栏](../../../terms.md)。要「只断库不断别的」那种更细的故障注入，用
[多副本验证环境](../../../terms.md)那一套（它分了两个网络）。

## 4. 这套环境回答什么

**关于租约（分布式租期）：**

1. 同一条会话在任意时刻只有一个副本在跑；别的副本收到的请求被转给它。
2. 持有者崩了，别的副本在[接管阈值](../../../terms.md)之后接手，崩掉那一轮补上「已停止」。
3. 持有者只是被冻住（没死），醒来之后**写不进账本**——租约的[租期标识](../../../terms.md)把它挡在外面。
4. 持有者连不上库时，没人来接管它也会[自我围栏](../../../terms.md)、自己停手。
5. 副本数从 1 变到 5、再杀掉几个，上面四条都还成立。

**关于 WebSocket：**

6. 浏览器连到 nginx，被分到任意一个副本，都能收到这一轮的内容——**哪怕这一轮跑在别的副本上**（靠 Redis 广播，不靠转发）。
7. 副本挂掉时连接断开，重连到别的副本能接着看（带上「我看到第几条了」）。
8. Redis 挂掉时**这一轮不受影响**：内容照常进账本，界面刷新一下就能补齐。

## 5. 范围

**做：**

- compose 起 1–5 个副本（改数量不用改配置文件）、nginx 统一入口（HTTP + WebSocket）、Postgres、Redis。
- Redis 版的[流分发](../../../terms.md)（新包 `@runko/stream-redis`）：直播内容广播给所有副本。
- 一组跑完即退的集群测试，覆盖上面 8 条。

**不做（非目标）：**

- **不取代现有的[多副本验证环境](../../../terms.md)**——那套是三个固定副本、专测故障注入的八个场景，继续留着；这套多的是「副本数可变 + Redis + WebSocket」。
- **不做跨机器**：还是一台机器上的容器。
- **不把 Redis 当存储**。它只做广播：内容的事实来源永远是[账本](../../../terms.md)，Redis 掉一帧就靠回放补。
- **WebSocket 只做直播流**（服务端 → 前端）。发消息、答审批、停止仍走 HTTP。

## 6. 成功标准

1. `CLUSTER_REPLICAS=1|3|5 cluster:up` 都能起来，nginx 入口可用。
2. §4 的 8 条各有一条自动化用例，跑完即退。
3. 浏览器连 nginx 入口，WebSocket 能看到 agent 的输出；杀掉正在跑的那个副本，界面能自己接上。
