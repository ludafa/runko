---
title: "集群实验环境（cluster-lab）— 施工进展"
slug: cluster-lab
view: 施工
layer: 宿主层
module: —
packages: ["@runko-chat/node-server", "@runko/stream-redis"]
tags: ["多副本", "集群", "Redis", "流分发", "施工"]
related: ["host/node/features/cluster-lab.md", "host/node/tech/cluster-lab.md", "ingress/plans/ws-stream.md"]
---
# 集群实验环境 — 施工进展

> 术语见 [术语表](../../../terms.md)。[功能手册](../features/cluster-lab.md) · [技术方案](../tech/cluster-lab.md)。

## 当前状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| C0 | 三份文档（本篇 + WebSocket 那一组） | ✅ |
| C1 | 新包 `@runko/stream-redis`：Redis 版[流分发](../../../terms.md) | ✅ |
| C2 | node-server 接上：`REDIS_URL` 一配就广播；直播流不再转发 | ✅ |
| C3 | WebSocket 直播流（见 [ws-stream · 施工](../../../ingress/plans/ws-stream.md)） | ✅ |
| C4 | 集群 compose：nginx 统一入口 + 1–5 副本 + Postgres + Redis | ✅ |
| C5 | 集群端到端测试：租约 5 条 + WebSocket 3 条 | ✅ |
| C6 | 验证方案、实测、代码审查 | ⬜ |

**顺序**：C1 → C2 → C3 → C4 → C5 → C6。C3 可以与 C1/C2 并行（它不依赖 Redis，单副本下也能验）。

## 各阶段

### C1 · `@runko/stream-redis`

- **目标**：实现框架的 `StreamFanout`，一个会话一个频道，发布带发布者名字、收到自己发的丢掉。见[技术方案 §2](../tech/cluster-lab.md#_2-redis-版流分发-新包-runkostream-redis)。
- **涉及**：新包（`src/index.ts` + README + 构建配置）、catalog 加 `redis` 依赖、changeset。
- **验收**：单测覆盖——本地回环是同步的（挂订阅与取快照之间零空隙）、跨实例收得到、自己发的不收两遍、Redis 挂了 publish 不抛、脏消息丢掉不断订阅。
- **结论**：7 条用例全绿（`packages/stream-redis/test/fanout.test.ts`）。

### C2 · node-server 接上

- **目标**：配了 `REDIS_URL` 就用 Redis 广播；此时直播流不再转发给持有者。
- **涉及**：`src/agent/stream.ts`（新，装配 fanout）、`src/routes/chat.ts`（转发路径按有没有 Redis 分档）、`src/index.ts`（关停时收掉连接）、`README.md`（多副本三个变量）。
- **验收**：有无 Redis 两档各一条单测；转发清单的单测跟着更新。
- **结论**：`test/routes/forward-paths.test.ts` 4 条全绿——没配 Redis 直播流要转、配了就不转、配了也只免这一条（发消息/停止/改队列照转）、哪个副本都能答的请求一概不转。
- **与计划的偏差**：Redis 客户端**懒连接**。装配是模块级的单例，而 `generate:openapi` 与单测都会 import 这个模块——装配时就去连一个外部服务，这两样在没有 Redis 的机器上会直接卡住。改成连接在后台建，发布与订阅各自 await 那个 promise。

### C4 · 集群 compose

- **目标**：`CLUSTER_REPLICAS=1|3|5` 都能起；nginx 同一个端口吃 HTTP 与 WebSocket。
- **涉及**：`docker/cluster.compose.yml`、`docker/cluster.nginx.conf`、`cluster:up` / `cluster:down` / `cluster:port` / `cluster:ps` 脚本、副本自报主机名的启动方式。
- **验收**：三种副本数各起一次，nginx 入口能建会话、能看直播。
- **结论**：1 / 3 / 5 三种副本数各起了一次，都通过——经 nginx 注册、建会话、发消息，然后**每个副本各连一条 WebSocket 都收到了同一轮的直播 chunk**，经 nginx 连也一样。起一次约 50 秒（含构建）。
- **实测揪出一个框架缺陷**：第一次跑只有持有者那台能看到直播，另外两台各收到 3 帧就正常关闭了。原因是框架的 `subscribe` 见「这一轮不在本副本」就收线——没有广播时这是对的，有广播之后就错了。补了 `StreamFanout.crossInstance` 标志（`@runko/agent` + `@runko/stream-redis`，changeset 与契约文档同步更新），重跑三种副本数全绿。

### C5 · 集群端到端

- **目标**：[功能手册 §4](../features/cluster-lab.md#_4-这套环境回答什么) 的 8 条各一条用例，跑完即退。
- **涉及**：`test/e2e/cluster.e2e.test.ts`（`RUNKO_TEST_CLUSTER=1` 门禁，不进 CI）、`package.json` 的 `test:cluster`。
- **结论**：8 条全绿，连跑两遍（256s / 248s）。断言落在账本、租约表与连接收到的帧上。
- **两处与计划的偏差**（都在测试注释里写明了理由）：
  - **冻住持有者那条（§4.3）冻结期间发的不是消息，是清队列。** 冻住的进程内核照样收包，解冻后会补处理——那时租约已经换人，老持有者会把它再转给新持有者。若那条是发消息或停止，等于在新持有者的轮上补一刀，账本形状就不确定了。清队列（本来就是空的）重放一次无副作用，照样验到「转发在超时附近回 503」。
  - **自我围栏那条（§4.4）的观察点在「接回网络之后」，不是实时。** 集群只有一个网络，摘掉副本等于同时断开库、Redis 与同伴，它的宿主机端口也随之失效。改成三段证据合证：阈值过后租约仍记在它名下（确实没人接管）→ 让别人接手拿到接管标记 → 接回网络后它手里已经没这一轮了，而此刻距发消息才 14.7 秒、模型要跑 36 秒。
- **顺带记下两条环境事实**：容器的 `hostname` 是容器短 id（不是容器名），租约里的 holder 就是它；副本的宿主机端口在容器重建、`docker start`、甚至只是重连一次网络之后都会变，每次故障注入后都要重新问一遍。

### C6 · 收尾

- 全仓检查、验证方案与实测、一轮独立代码审查。

## 验证方案

分三层：**跑完即退的自动用例**（回归靠它）、**手动起一套集群**（人眼看行为）、**浏览器走查**（真前端）。

### 一、自动用例（跑完即退）

| 跑什么 | 覆盖 | 预期 |
|---|---|---|
| `pnpm --filter @runko-chat/node-server test:cluster` | [功能手册 §4](../features/cluster-lab.md#_4-这套环境回答什么) 那 8 条，各一条用例 | 8 条全绿；自带起停，跑完 `docker ps -a` 里不留 `runko-cluster-e2e` 的残留 |
| `pnpm --filter @runko/stream-redis test` | Redis 版[流分发](../../../terms.md)：同步回环、跨实例、自己发的不收两遍、Redis 挂了不抛、脏消息不断订阅 | 7 条全绿 |
| `pnpm --filter @runko/agent test` | 含新加的两条：广播那档「一轮在别处时留着等」、进程内那档「就地收线」 | 全绿 |
| `pnpm --filter @runko-chat/node-server test` | 含 `test/routes/forward-paths.test.ts`（转发分档）与 `test/routes/chat-ws.test.ts`（WebSocket 端点） | 全绿，且 `cluster` 与 `lab` 两个文件被跳过（门禁生效） |
| `pnpm --filter @runko-chat/web test` | 含通道实现、选择的存取、切换接线、设置页 | 全绿 |

**门禁**：`test:cluster` 要 `RUNKO_TEST_CLUSTER=1` 才跑，不进 `pnpm test` 与 CI——它要 Docker、要构建镜像。

### 二、手动起一套集群

```sh
cd apps/node-server
CLUSTER_REPLICAS=3 pnpm cluster:up      # 约 50 秒（含构建）
curl http://localhost:3940/health       # {"ok":true}
CLUSTER_INDEX=2 pnpm cluster:port       # 第 2 个副本的宿主机端口
pnpm cluster:down                       # 连数据一起删掉
```

逐条对照[功能手册 §3.1](../features/cluster-lab.md#_3-1-故障怎么造)的故障注入命令，看行为对不对。

### 三、浏览器走查（**要人来做**）

```sh
cd apps/node-server && CLUSTER_REPLICAS=3 pnpm cluster:up
SERVER_URL=http://localhost:3940 pnpm chat:web
```

1. 注册登录 → 建会话 → 发一条长消息，能看到内容一小段一小段出来。
2. 顶栏 `Settings` → 把连接方式切成 **WebSocket** → 回会话页，正在跑的那一轮**不断**，继续往下出字。
3. 杀掉正在跑这一轮的副本（`docker kill -s SIGKILL runko-cluster-node-<序号>`）→ 界面断开后自己重连，接着看，内容不重不漏。
4. 切回 **SSE**，重复 1–3，表现应当一模一样。

## 实测结果

| 时间 | 跑了什么 | 结果 |
|---|---|---|
| 2026-09-22 | 手动起 1 / 3 / 5 三种副本数 | 都通过：经 nginx 注册、建会话、发消息，**每个副本各连一条 WebSocket 都收到同一轮的直播**；起一次约 50 秒 |
| 2026-09-22 | 第一次三副本实测 | **揪出框架缺陷**：只有持有者那台看得到直播。补 `StreamFanout.crossInstance` 后重跑全绿（见上面 C4 的记录） |
| 2026-09-22 | `test:cluster` 连跑两遍 | 8/8 全绿，256s / 248s；跑完容器、网络、卷零残留 |
| 2026-09-22 | 全仓 `build` / `typecheck` / `lint` / `test` + `docs:check` / `docs:build` / `check:doc-links` | 全绿 |
| — | 浏览器走查 | **待做**（要人来点，见上面第三层） |

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-09-22 | C0：功能、技术、施工三份文档 |
| 2026-09-22 | C1（stream-redis 新包）、C2（node-server 接上）、C3（WebSocket 通道）完成 |
