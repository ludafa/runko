---
title: "chat 应用上 Cloudflare（chat-on-cloudflare）— 技术方案"
slug: chat-on-cloudflare
view: 技术
layer: 宿主层
module: —
packages: ["@runko/durable-object", "@runko/sandbox-cloudflare", "@runko/persist-kysely", "@runko-chat/cloudflare-server", "@runko-chat/node-server"]
tags: ["Cloudflare", "Durable Object", "D1", "Containers", "Kysely", "better-auth", "会话对象", "部署", "数据模型"]
related: ["host/cloudflare/features/chat-on-cloudflare.md", "host/cloudflare/plans/chat-on-cloudflare.md", "host/cloudflare/tech/deployment.md", "host/cloudflare/tech/cloudflare-worker-server.md", "ingress/tech/unified-demo.md", "ingress/tech/github-repo-access.md", "host/contract/tech/persistence.md"]
---
# chat 应用上 Cloudflare — 技术方案

> 术语见 [术语表](../../../terms.md)。要做什么见[功能手册](../features/chat-on-cloudflare.md)；拆单见[施工](../plans/chat-on-cloudflare.md)。
> 框架这一档的总体设计（一个会话 = 一个 Durable Object、四样能力怎么落地）见 [Cloudflare（宿主层）· 技术方案](./deployment.md)，本文不重复，只讲 chat 应用怎么落上去。

## 1. 一张图看全

一个 Worker 部署全部东西。浏览器只跟它打交道，同源。

```mermaid
flowchart TB
  browser["浏览器"] --> worker
  subgraph worker["Worker（一次 wrangler deploy）"]
    assets["静态资源：打包好的前端"]
    app["Hono 应用：登录、会话列表、建会话、GitHub、配置"]
  end
  app --> d1[("D1：用户、登录、会话列表、授权记录、列表状态副本")]
  app -->|"会话里的一切：发消息、直播、停止、审批、队列"| co
  subgraph co["会话对象（一个会话一个 Durable Object）"]
    runtime["agent 运行时：轮编排、排队、挂起、审批"]
    sql[("自带 SQLite：账本、队列、裁决、工具收尾、本地沙盒快照")]
  end
  runtime --> sql
  runtime -.->|"状态变化时回写"| d1
  runtime -->|模型 API| model["DeepSeek / Workers AI"]
  runtime -->|命令、文件| sandbox["Cloudflare 沙盒（容器，也是 Durable Object）"]
  browser -.->|"SSE / WebSocket，经 Worker 转进会话对象"| co
```

**分工的原则**：跨会话的东西（谁是谁、我有哪些会话）放 D1；一个会话内部的东西全放它自己的会话对象。会话对象之间互相看不见，所以「列出我的会话」必须走 D1（[Cloudflare 宿主层 §3](./deployment.md)）。

## 2. 数据放哪

```mermaid
erDiagram
  USER ||--o{ ACCOUNT : "登录方式（better-auth）"
  USER ||--o{ SESSION : "登录态（better-auth）"
  USER ||--o{ CONVERSATIONS : "拥有"
  CONVERSATIONS ||--|| CONVERSATION_OBJECT : "会话 id = 对象名"
  CONVERSATIONS ||--o| CONVERSATION_LIVE : "列表状态副本（会话对象回写）"
  CONVERSATION_OBJECT ||--o{ AGENT_LEDGER : "账本"
  CONVERSATION_OBJECT ||--o{ AGENT_QUEUE : "待发队列"
  CONVERSATION_OBJECT ||--o{ AGENT_DECISIONS : "裁决表"
  CONVERSATION_OBJECT ||--o{ AGENT_TOOL_TAILS : "工具收尾"
  CONVERSATION_OBJECT ||--o| AGENT_DO_OWNERSHIP : "起轮标记"
  CONVERSATION_OBJECT ||--o{ LOCAL_WORKSPACE_CHUNKS : "本地沙盒快照（按块）"
  CONVERSATIONS {
    string id PK "也是会话对象的名字"
    string user_id FK
    string title
    string provider "local / cloudflare"
    string repo "owner/name，可空"
    bigint github_installation_id
    bigint github_repo_id
    string branch_name
    string sandbox_name "Cloudflare 沙盒按这个名字寻址"
  }
  CONVERSATION_LIVE {
    string conversation_id PK "FK，会话删了它跟着删"
    string queued_json "排着的消息"
    int turn_in_progress "有没有轮在跑"
    int pending_decisions "几处在等你"
  }
  CONVERSATION_OBJECT {
    string name "= conversations.id"
  }
  AGENT_DO_OWNERSHIP {
    string conversation_id PK
    string instance_id "起这一轮的实例；对不上 = 上一辈子留下的"
  }
  LOCAL_WORKSPACE_CHUNKS {
    string sandbox_name PK
    int idx PK "第几块"
    int version
    string data "一块最多 512K 字符，压在 2 MB 的行上限下"
  }
```

| 存在哪 | 表 | 谁写 |
|---|---|---|
| **D1** | better-auth 的 `user` `account` `session` 等；`conversations`；`conversation_grants`；[列表状态副本](../../../terms.md) `conversation_live` | Worker；会话对象只写 `conversation_live`（§4.5） |
| **会话对象自带的 SQLite** | 框架的四张表（账本、裁决、队列、工具收尾）；起轮标记；本地沙盒快照 | 只有这个会话对象自己 |

框架的表**直接复用 `@runko/persist-kysely`**：给会话对象的 SQLite 写一个 Kysely 方言（§4.1），`kyselyPersistence(db, { flavor: "sqlite" })` 原样能用，一致性套件（`@runko/conformance`）原样能跑。持久化的读写里没有事务，靠的是「条件写 + 看影响行数」，会话对象的 SQLite 都支持。

D1 的表由同一份 Kysely 迁移导出成 SQL 文件（`apps/cloudflare-server/migrations/`），`wrangler d1 migrations` 来跑。D1 不支持交互式事务，D1 的 Kysely 方言遇到 `transaction()` 当场报错，而不是悄悄一条一条执行；chat 应用的数据访问里本来就没有事务。

## 3. 请求怎么走

### 3.1 会话里的请求：Worker 验身份，会话对象干活

```mermaid
sequenceDiagram
  autonumber
  participant B as 浏览器
  participant W as Worker（Hono）
  participant D as D1
  participant C as 会话对象
  participant M as 模型 API

  B->>W: POST /api/chat/conversations/:id/messages
  W->>D: better-auth 查登录态；查这个会话是不是你的
  W->>C: RPC stub.enqueue(id, 消息)
  C->>C: runtime.enqueue：起轮 / 排队 / 插话
  C-->>W: 202
  W-->>B: 202
  Note over C: 这一轮在会话对象里接着跑，跟这个请求无关
  B->>W: GET /api/chat/conversations/:id/stream
  W->>C: RPC stub.subscribe(id, after)
  C-->>W: 字节流（一行一帧）
  W-->>B: SSE：回放 + 直播（WebSocket 同理）
  loop 这一轮
    C->>M: 调模型
    M-->>C: 流式输出
    C-->>B: 帧
  end
```

- **会话对象只信 Worker**：它不对外暴露，只有同一个 Worker 拿得到它的引用，所以不再做一遍登录校验。Worker 验完登录、查完归属才调它的方法（JS RPC），方法的第一个参数是会话 id。
- **直播跨 RPC 是一条字节流**：RPC 传不了 `AsyncIterable` 和 `AbortSignal`，所以会话对象把帧编成一行一个 JSON 的字节流交出来，Worker 再解回帧、写成 SSE 或 WebSocket。浏览器走了，Worker 就 cancel 这条流，cancel 传回会话对象，那边的订阅收线（`@runko/durable-object` 的 `framesToStream` / `readFrames`）。
- **Node 版的「转发给持有者」「节点下线闸门」全都不需要**：同一个会话永远只有一个会话对象，平台负责把请求送到它所在的地方。
- **直播的中心就是会话对象**：订阅者都连在它身上，它自己往外推。不需要 Redis。

### 3.2 会话外的请求：只在 Worker 里

登录、注册、GitHub 连接与列仓库、`/api/chat/config`、会话列表直接查 D1。**建会话**：Worker 核对仓库与权限（同 Node 版），写 D1，再叫一声会话对象让它初始化（建表、准备沙盒）。

## 4. 会话对象里面

### 4.1 运行时怎么装

每个会话对象里放一个 `createAgentRuntime`，四样宿主能力：

| 能力 | 用什么 | 说明 |
|---|---|---|
| 持久化 | `kyselyPersistence(db)`，`db` 是会话对象 SQLite 上的 Kysely | 新写一个 Kysely 方言：编译用 Kysely 自带的 SQLite 编译器，执行交给 `ctx.storage.sql.exec`。影响行数查 `changes()`——游标的 `rowsWritten` 把索引的写入也算进去，不能当影响行数用。放进 `@runko/durable-object` |
| 归属仲裁 | `durableObjectArbitration` | 平台保证一个会话只有一个实例，独占在内存里判就够。但[起轮标记](../../../terms.md)要写进 SQLite：进程内版的标记跟实例同生共死，对象被重启后就扫不出上一轮没收尾（§4.4） |
| 流分发 | 进程内版 | 订阅者都在这个对象里；跨 RPC 交给 Worker 的是字节流（§3.1） |
| 沙盒 | 本地沙盒，或 Cloudflare 沙盒（§5） | |

一个运行时只管一个会话。框架本来就允许一个运行时管多个会话，这里只是恰好用一个。

装配只有一行：会话对象的构造函数里调 `createDurableObjectRuntime(ctx, options)`，它建表、做崩溃恢复、推一把排队的消息（都包在 `blockConcurrencyWhile` 里），`alarm()` 转调它的 `alarm()`。框架那个常驻的定时回捞缺省关掉：开着一个 `setInterval`，对象就永远回收不掉，回捞改在 `alarm()` 里做。

### 4.2 一轮怎么跑、怎么保证不被平台回收

一轮在会话对象里跑：收到发消息的请求就回 202，这一轮在后台接着跑。它在等模型、等沙盒的时候，手上一直有一个进行中的网络请求。

**要实测的头号问题**：会话对象手上有进行中的网络请求时，平台会不会把它回收？Cloudflare 的说法是「没有进行中的请求或 I/O 时才会被回收」，但我们要的是「一轮跑一个小时、中间没有浏览器连着」。这一条本地验不出来（本地模拟器不回收会话对象），要部署到线上实测（[施工 C1b](../plans/chat-on-cloudflare.md)）；它不挡开发，挡上线。实测不过的退路：

1. 一轮开始时设一个定时唤醒（alarm），每隔一段时间唤醒一次，检查这一轮还在不在跑；被回收了就按崩溃恢复补「已中断」，用户接着发消息就能继续。
2. 把一轮拆成一步一步，用 Workflows 串起来（每一步是一个可重试的步骤）。改动大，只在 1 也不行时考虑。

### 4.3 在等人的轮

会话对象**没人连着、也没有进行中的 I/O 时会被回收**，内存里等人答复的 promise 就没了。所以 Cloudflare 版把[挂起](../../../terms.md)的内存窗口设得很短（`@runko/durable-object` 缺省 30 秒）：一轮停下来等人，很快就挂起落盘，人回来答复时由新起的会话对象恢复。这就是挂起本来要解决的问题，这里只是窗口调短。

### 4.4 会话对象重启之后

部署新版本、平台迁移时，会话对象会被重启，正在跑的那一轮就断了。

```mermaid
sequenceDiagram
  autonumber
  participant P as 平台
  participant C as 会话对象（新实例）
  participant S as 自带 SQLite

  P->>C: 部署后第一次被叫醒（有请求，或者到了定时唤醒）
  C->>C: blockConcurrencyWhile：先恢复再处理请求
  C->>S: runtime.recover()：起轮标记还在 = 上一轮没收尾
  C->>S: 补一条「服务重启，这一轮已中断」
  C->>C: 队列里还有消息就接着跑
  C-->>P: 开始处理请求
```

- 每一轮开始时设一个定时唤醒：即使重启后没有任何请求，它到点也会把会话对象叫起来做这次恢复，用户刷新时看到的就已经是收好尾的状态。
- 每一轮开始时设的那个就是[定时唤醒](../../../terms.md)（缺省一分钟），到点时这一轮还在跑就再设一个。
- Node 版的「交权」在这里做不了：Cloudflare 重启会话对象前不发通知。做到无感续跑见[功能手册附录 B](../features/chat-on-cloudflare.md)。

### 4.5 会话列表上的状态

列表要给每个会话标「排着几条、在跑、在等你」。权威答案在各自的会话对象里，但列表一次要给全部会话，挨个叫醒太贵，所以会话对象在这三样变化时把它们回写到 D1 的[列表状态副本](../../../terms.md)，列表只读这张表。详情页只看一个会话，直接问会话对象。

```mermaid
sequenceDiagram
  autonumber
  participant B as 浏览器
  participant W as Worker
  participant C as 会话对象
  participant D as D1

  B->>W: 发消息 / 停止 / 删排队 / 审批
  W->>C: RPC
  C->>C: 运行时处理
  C-)D: 回写列表状态副本（不等它）
  Note over C: 轮开始、收尾、停下来等人时也回写
  B->>W: GET 会话列表
  W->>D: 读 conversations + conversation_live
  W-->>B: 列表
```

- **回写不挡会话里的动作**：写失败只记一行告警，下一次状态变化会再写。
- **同一时刻只跑一次**：回写期间又变了，就跑完再补一次，永远以最后一次读到的状态为准。
- **收尾那一刻要多等一下**：框架的「一轮收尾了」通知排在「看队列、放手」之前，那一刻问运行时它还说「在跑」。所以收尾触发的回写会隔几十毫秒复查，看到真停了再写；一直在跑说明下一轮已经接上，那一轮收尾时会再写一次。

## 5. 沙盒

### 5.1 本地沙盒

和 Node 版一样：内存里的文件（`MemoryFS`）加纯 TS 的 bash（`@runko/just-bash`），每轮收尾把快照存进会话对象自己的 SQLite（Node 版存在 `local_workspaces` 表）。会话对象的 SQLite 一行最多 2 MB，所以快照按块切开存（一块 512K 字符，边界不劈开 emoji 这类代理对），整份在一个同步事务里换上。会话对象内存上限 128 MB，所以快照上限定在 32 MB，超了提示用户换 Cloudflare 沙盒。

### 5.2 Cloudflare 沙盒

- **接法**：会话对象和沙盒在同一个 Worker 里，直接拿 `env.Sandbox` 绑定，走 `@runko/sandbox-cloudflare` 的进程内网关路径（同 [Cloudflare Worker Server §2](./cloudflare-worker-server.md)），不出网络。
- **规格**：缺省 `standard-1`（1/2 核、4 GB 内存、8 GB 磁盘）。`basic` 只有 1 GB，`npm install` 容易爆内存。
- **工作目录**：网关把虚拟根 `/` 锚在沙盒的 `/workspace`，所以仓库就克隆在 `/workspace` 本身。按会话的沙盒名寻址（`getSandbox(env.Sandbox, sandbox_name)`），名字总能拿到一个沙盒；容器休眠后磁盘是空的，所以「恢复」是探一下 `/workspace/.git` 在不在，不在就当没了，由沙盒管理重新克隆、装 skill、切回工作分支。
- **跨 RPC 的取消**：`AbortSignal` 跨不过 Durable Object 的 RPC，所以交给沙盒的 `exec` 不带 `signal`。中途取消不会打断沙盒里正在跑的命令，客户端那边照样及时返回。
- **冷启动**：容器启动要几秒。用户打开会话页（订阅直播）时，会话对象顺手把沙盒叫醒，大多数时候用户发第一条消息时它已经好了。
- **休眠**：闲置一段时间（与共用层的沙盒空闲超时同一个值）自动休眠，只按醒着的时间计费。休眠计时每收到一次请求就从头算，所以「补足存活时长」就是碰它一下（跑一条 `true`）。**休眠会清空磁盘**：醒来后重新克隆、切回工作分支，没推送到 GitHub 的改动（包括没提交的）都不在了（§12）。
- **拉仓库**：同 [GitHub 仓库 §4](../../../ingress/tech/github-repo-access.md)：令牌不进命令字符串。网关协议的 `exec` 不带环境变量，所以克隆这一步**绕过网关、直接调沙盒 SDK**，把令牌放进那一条命令的环境变量（命令字符串里只有字面量 `$GH_TOKEN`）。`git clone` 不肯往非空目录里克隆，所以先克隆到临时目录再拷进 `/workspace`。之后照旧走共用层的初始化：写 `.git/runko-github-token`、配凭据助手、把 origin 改回不带令牌的地址。签 GitHub App 的 JWT 改用 WebCrypto（Node 版也一起换，见 §7）。

## 6. 登录与前端

- **better-auth 接 D1**：用 Kysely 的 D1 方言，与 Node 版同一套配置（换个数据库实例）。GitHub 登录与「连接 GitHub」同 Node 版。
- **前端**：Worker 的静态资源，开「单页应用」回退，`/chat/xxx` 这种前端路由刷新不 404；`/api/*` 与 `/health` 先进 Worker。同源，所以登录不用配来源（同[集群前端那一期](../../node/tech/cluster-lab.md)的结论），打包前端时把 `SERVER_URL` 置空，前端就用相对路径打接口。
- **能力开关**：Cloudflare 沙盒只在有容器绑定**并且**配了 GitHub App 时提供——它的工作区就是一个克隆下来的仓库，没有 App 签不出仓库令牌，选了也建不成会话。本地沙盒永远能用。
- **集群控制台**：不上。Cloudflare 上没有节点。前端在 Cloudflare 版里隐藏这个入口（`/api/chat/config` 多一个能力开关）。

## 7. 代码怎么组织：抽一个两边共用的层

Node 版服务端一万行左右，大部分与平台无关（接口定义、提示词、审批规则、GitHub App、数据访问），但它们和 Node 专属的东西（转发、节点下线、Postgres 实例、常驻定时器）写在一起。直接复制一份会长歪，所以**先抽一个共用层**：

| 去哪 | 放什么 |
|---|---|
| `apps/chat-shared`（新，私有包 `@runko-chat/shared`） | 接口 schema；会话与授权的数据访问（Kysely，与方言无关）；提示词；审批规则与命令拆分；演示模型；模型选择；GitHub App（JWT 换成 WebCrypto，Node 也能跑）；网页搜索；**路由层**：Hono 路由只依赖一个「会话后端」接口 |
| `apps/node-server` | 「会话后端」的 Node 实现（运行时 + 转发 + 节点下线）；Postgres / SQLite；沙盒管理；集群控制台；推送 |
| `apps/cloudflare-server`（新，私有包 `@runko-chat/cloudflare-server`） | Worker 入口；「会话后端」的 Cloudflare 实现（把请求交给会话对象）；会话对象类；D1；wrangler 配置 |
| `packages/durable-object`（新，发布包 `@runko/durable-object`） | 会话对象 SQLite 的 Kysely 方言；把运行时装进 Durable Object 的那几行装配（任何人都能用，不只 chat 应用） |

「会话后端」接口大致是：建会话后的初始化、发消息、订阅直播、停止、队列增删、审批与答复、查状态。Node 版的路由今天就是在调这些动作，抽出来不改行为，**Node 版的全部测试与集群端到端是这一步的护栏**。

`apps/cloudflare-worker-server`（双角色示例）不动，它演示的是「沙盒网关给任意 Node 机器用」，与本期无关。

## 8. 配置与密钥

| 名字 | 放哪 | 说明 |
|---|---|---|
| D1 数据库、会话对象、沙盒的绑定 | `wrangler.jsonc` | 部署脚本建好 D1 后写进去 |
| `BETTER_AUTH_SECRET` | `wrangler secret` | 必填 |
| `DEEPSEEK_API_TOKEN` 等模型配置 | `wrangler secret` | 不填就是演示模型 |
| `GITHUB_APP_*`、`GITHUB_CLIENT_ID/SECRET` | `wrangler secret` | 选仓库、GitHub 登录、Cloudflare 沙盒要 |
| `SERVER_URL` | `wrangler secret` 或 `vars` | 对外地址，GitHub 回调要用；不配就用请求自己的来源 |
| `CLOUDFLARE_SANDBOX` | `.dev.vars` | `off` = 不提供 Cloudflare 沙盒（本机没开 Docker 时用） |
| 沙盒规格 | `wrangler.jsonc` 的容器配置 | 缺省 `standard-1` |

## 9. 部署

一条脚本做完（`pnpm cf:deploy`，`apps/cloudflare-server/scripts/deploy.mjs`）：查登录与 Docker → 建 D1（已有就跳过，id 写回 `wrangler.jsonc`）→ 远程跑 D1 迁移 → 编译依赖、打包前端 → `wrangler deploy`（Worker、会话对象、沙盒镜像一起；没设过 `BETTER_AUTH_SECRET` 就生成一个，用 `--secrets-file` 随部署一起上传，免得第一个版本没有密钥）。每一步都能重跑；`--dry-run` 只做本地那几步，远程的只打印。

D1 的迁移用 SQL 文件（`wrangler d1 migrations`），由 `scripts/generate-d1-migrations.ts` 从 Kysely 迁移（better-auth 的表、chat 应用的表，加上 Cloudflare 版自己的 `conversation_live`，三样记在同一张迁移记录表里）导出，不手写第二份 DDL。D1 按文件名记哪些跑过，所以发出去的文件不能再改：脚本先在内存 SQLite 上重放已有的文件，再跑一遍两段迁移，把真正改了库的语句写成下一个编号的文件。Kysely 的迁移记录表也建在 D1 上，重放之后迁移器才知道哪几段跑过。`test` 会先查有没有还没导出的改动。部署说明见 [apps/cloudflare-server/README.md](../../../../apps/cloudflare-server/README.md)。

## 10. 测试

| 层 | 怎么测 |
|---|---|
| Kysely 方言 + 持久化 | `@cloudflare/vitest-pool-workers` 在真的 workerd 里跑，`@runko/conformance` 的持久化用例原样过一遍（`packages/durable-object/test`） |
| 会话对象 | 同上：起轮、排队、挂起、重启后恢复。模拟重启用 `abortAllDurableObjects()`（实例当场丢掉、存储留着）再跑 alarm；`evictDurableObject()` 是体面回收，会等对象里的定时器走完，测不到中断 |
| Worker 路由 | Node 版的路由用例照旧跑 Node 后端；Cloudflare 版在 workerd 里经 Worker 的 `fetch` 走同一批用户可见的路（注册、建会话、发消息、排队、停止、审批、提问、别人的会话 404、WebSocket），D1 迁移用同一份 SQL（`apps/cloudflare-server/test`） |
| Cloudflare 沙盒 | 测试池跑不了容器，所以用 `wrangler dev` + 本机 Docker 起一个一次性的测试 Worker 直接调 provider：带环境变量的 exec、克隆、恢复探测、经网关读写文件、共用层完整的初始化（[施工 · 实测结果](../plans/chat-on-cloudflare.md)） |
| 端到端 | `wrangler dev` 本地起全套（沙盒在本机 Docker 里），agent-browser 走注册、建会话、聊天、长任务、刷新重连。注意本地不回收会话对象、不限 CPU（§11.1），长任务这一条本地过了不代表线上过 |
| 真部署 | 部署到一个测试账号，按[功能手册 §5](../features/chat-on-cloudflare.md) 的成功标准逐条走（要人来做） |

## 11. 风险与要先实测的

| # | 风险 | 后果 | 在哪验 | 怎么验 |
|---|---|---|---|---|
| 1 | 长轮期间会话对象被回收 | 一轮中途断 | **线上**（施工 C1b） | 30 分钟的任务，浏览器关掉，看能不能跑完 |
| 2 | 会话对象的 CPU 计时方式 | 撞 30 秒上限 | **线上**（C1b） | 同一个实测里看 CPU 用量；必要时在配置里调高 |
| 3 | better-auth 在 Workers + D1 上的兼容 | 登录做不了 | 本地（C1a） | 最小 Worker 跑通注册、登录、GitHub 回调 |
| 4 | D1 迁移与 Kysely 迁移器 | 建表做不了 | 本地（C1a） | 导出 SQL 文件走 `wrangler d1 migrations` |
| 5 | 从会话对象调沙盒、克隆时传环境变量 | 拉不了仓库 | 本地（C1a，要本机 Docker） | 最小会话对象里起沙盒、带环境变量跑一条命令 |
| 6 | 部署时会话对象怎么重启 | 用户看到的中断范围 | **线上**（C1b） | 部署一次，观察在跑的轮与连着的直播 |

### 11.1 本地能验什么、不能验什么

`wrangler dev` 在本机起的是 workerd（与线上同一个运行时），Worker、静态资源、会话对象（带 SQLite）、D1、沙盒容器（借本机 Docker）都能跑，`@cloudflare/vitest-pool-workers` 能在 workerd 里跑自动测试。所以**功能与逻辑都在本地开发、本地测**。

本地验不出来的是平台行为：会话对象的回收与调度、CPU 等限制（官方文档写明只在部署到 Cloudflare 网络时生效）、部署时的重启，以及冷启动、全球延迟、账单这些真实数字。上表标「线上」的三条就是这一类。

## 12. 已知限制

- **部署会中断正在跑的轮**（§4.4）。
- **本地沙盒的文件受 128 MB 内存限制**（§5.1）。快照超过 32 MB 时这一轮的改动存不进去，服务端记一条 error 日志；会话对象还在时下一轮照样用内存里那份，重启后回到上一份快照。界面上不提示。
- **Cloudflare 沙盒休眠后只剩推送过的东西**（§5.2）：容器磁盘是临时的，闲置休眠之后重新克隆。agent 改完要推分支才留得住；新建表单上的说明写了这一条。
- **一条账本消息最多 2 MB**：会话对象的 SQLite 一行最多 2 MB，账本一条消息存一行。内置工具的输出各有截断（bash 每路 64 KB），但一轮里工具调用很多时，这一轮的助手消息仍可能超过 2 MB，写账本就会失败。本地沙盒快照已按块切开存，不受这一条影响。
- **没有推送通知**：本期不做。
- **免费档跑不了**：每次请求 10 毫秒 CPU、50 个外部请求。
- **列表上的状态可能慢一拍**：列表读的是会话对象回写的副本（§4.5）。正常情况下慢几十毫秒；某次回写失败，就停在旧值，直到这个会话下一次状态变化。详情页不受影响。
- **没人看的直播最多多挂 10 秒**：跨 RPC 的 cancel 要等会话对象下一次往流里写才发现，所以闲着的订阅靠每 10 秒一个保活空行收线，期间会话对象回收不掉。
- **停止打断不了 Cloudflare 沙盒里正在跑的命令**：`AbortSignal` 跨不过 RPC（§5.2）。这一轮照样及时停下，命令自己跑完或超时。
- **D1 没有交互式事务**：D1 的方言遇到 `transaction()` 直接报错。要原子地写多条，用 `D1Database.batch()`。

---

# 附录

## 附录 A · 否决过的做法

| 做法 | 为什么不 |
|---|---|
| 全部数据放 D1，用租约版仲裁 | 放着「一个会话一个实例」这个平台保证不用，还要自己做心跳与接管；直播又得另找中心 |
| 全部数据放会话对象，不用 D1 | 列「我的会话」要把所有会话对象挨个问一遍 |
| 把 Node 版服务端复制一份改 | 两份长歪是必然的；共用层多花的工夫，第一次改路由就赚回来 |
| 一轮放进 Workflows | 每一步都要能重放，运行时得大改；只在长轮实测不过时考虑（§4.2） |
| 经网关从外部 Node 进程用 Cloudflare 沙盒 | 那是 [Cloudflare Worker Server](./cloudflare-worker-server.md) 的场景；这里会话对象就在 Worker 里，直接用绑定 |
