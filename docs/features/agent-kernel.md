# agent 内核包 `@nimbo/agent`（使用手册）

> 相关：技术方案见 [../tech/agent-kernel.md](../tech/agent-kernel.md)，施工进展见 [../plans/agent-kernel.md](../plans/agent-kernel.md)。
> 设计讨论的完整记录在 [issue #2](https://github.com/ludafa/nimbo/issues/2)。
> 依赖/延续：[core SDK](./core-sdk.md)（本包建在它的 loop 之上）· [优雅关闭与崩溃恢复](./graceful-shutdown.md)（[交权](../terms.md)是它的推广）· [排队与插话](./steer-and-queue.md)（那套机制从 chat 应用上移到本包）· [沙盒保活](./sandbox-keepalive.md)（[等人状态](../terms.md)的信号从这里发）。

> ⚠️ **包尚未实现**，下面的 API 形状是方案，会随实现调整。**分层与职责边界是定的**，签名细节不是。

这一份是**使用手册**：怎么接进来、每一档部署配什么、换档要改什么。设计推导看[技术方案](../tech/agent-kernel.md)。

## 0. 一句话

`@nimbo/core` 给的是「跑一轮」，`@nimbo/agent` 给的是「**一轮接一轮地跑下去，而且换个部署形态不用改业务代码**」。

## 1. 要解决的问题

`@nimbo/core` 只解决「一次执行」：给它历史和工具，它调模型、跑工具、喂回去，跑完返回。**它不知道时间、进程、存储。**

于是想拿它建真产品的人，要自己搭这四件事：

1. **会话怎么接下去**——一轮跑完，下一轮什么时候起？用户在 agent 忙时又发了一条怎么办？
2. **等人怎么办**——agent 弹出审批卡片，人可能几小时后才回来点。这段时间进程干等着，机器下不了线。
3. **崩了怎么办**——进程没了，界面上那一轮永远转圈。
4. **多开一个进程就全乱**——两个节点同时跑一个会话，账本互相打架、沙盒互相踩文件。

chat 应用把这四件事全写了一遍，绑死 SQLite、绑死单进程。**本包把它们收进框架，并把「取决于你怎么部署」的部分做成可替换的。**

---

## 2. 三十秒上手

### 2.1 光想试试：一条命令

```sh
npx @nimbo/cli
```

在当前目录起一个本机服务 + 自带前端，浏览器里就能让 agent 改这个项目的文件。**不用配数据库、不用申请沙盒账号。**

### 2.2 嵌进自己的服务：零配置

```ts
import { defineAgent } from "@nimbo/sdk";
import { localExec } from "@nimbo/core";
import { fromDirectory } from "@nimbo/virtual-fs";
import { createAgentRuntime } from "@nimbo/agent";

const agent = defineAgent({ model: "anthropic/claude-sonnet-5" });

const runtime = createAgentRuntime(agent, {
  // 唯一必填：这个会话在哪儿干活
  workspace: (conversationId) => {
    const fs = fromDirectory(`./workspaces/${conversationId}`);
    return { fs, exec: localExec({ materialize: true, fs }) };
  },
});

await runtime.enqueue("conv_abc", { text: "把 src 里的 var 都改成 const" });
```

**持久化、[流分发](../terms.md)、[归属仲裁机制](../terms.md)三样全走内置实现**——记录在内存、流走进程内、单进程独占。够跑通、够写测试，但进程一重启历史就没了。

要留住历史就换掉持久化，要上多进程再换掉归属仲裁——**换档就是换掉一两样，业务代码不动**。

---

## 3. [接入](../terms.md)层：你要写的四个端点

框架不碰 HTTP。你的路由跟框架之间只有四个接触点：

```ts
// ① 用户发消息 —— 忙不忙、排队还是插话，框架自己判
app.post("/conversations/:id/messages", async (c) => {
  await runtime.enqueue(c.req.param("id"), { text: await c.req.text() });
  return c.body(null, 202);
});

// ② 实时流 —— 框架给中立的 AsyncIterable，序列化成什么由你定
app.get("/conversations/:id/stream", (c) => {
  const after = Number(c.req.query("after") ?? 0);
  return streamSSE(c, async (sse) => {
    for await (const frame of runtime.subscribe(c.req.param("id"), { after })) {
      await sse.writeSSE({ id: String(frame.seq), data: JSON.stringify(frame) });
    }
  });
});

// ③ 人做出裁决 —— 会话可能已经挂起了，框架自己判断要不要开新一轮来消费它
app.post("/conversations/:id/approvals/:callId", async (c) => {
  const { outcome, scope } = await c.req.json();
  await runtime.submitDecision(c.req.param("id"), c.req.param("callId"), {
    outcome,              // 'allow' | 'deny'
    scope,                // 'once' | 'broader'
    decidedBy: c.get("userId"),
  });
  return c.body(null, 204);
});

// ④ 上报「人还在」—— 框架靠它决定要不要提前挂起
app.post("/conversations/:id/presence", async (c) => {
  await runtime.reportPresence(c.req.param("id"));
  return c.body(null, 204);
});
```

**④ 有一条硬要求**：它必须由**真实交互事件**触发——鼠标动、输入框 focus、审批卡片上的点击。**不能拿「SSE 还连着」当数据**，否则一个开着页面去度假的用户会永久占住机器。

### 3.1 多节点时还要写一个转发

单进程不需要这段。上了多节点之后，请求可能落到不是持有者的节点：

```ts
app.post("/conversations/:id/messages", async (c) => {
  const state = await runtime.getActivity(c.req.param("id"));
  if (state.state === "running" && state.holder !== MY_HOLDER) {
    return fetch(`http://${state.holder}${c.req.path}`, { method: "POST", body: c.req.raw.body });
  }
  await runtime.enqueue(c.req.param("id"), { text: await c.req.text() });
  return c.body(null, 202);
});
```

`holder` 是**不透明字符串**，框架原样透传不解释——你在配归属仲裁时填什么，这里就拿到什么（pod IP、容器地址、machine id 都行）。

> **④a Cloudflare DO 和 ④b Vercel 都不用写这段**：DO 的 `stub` 本身就是通道；Vercel 压根不可寻址，改用广播绕过（见 §4.6）。

---

## 4. 六档部署，各配什么

### 4.1 ⓪ 本机 CLI

```sh
npx @nimbo/cli                          # 在当前目录干活
npx @nimbo/cli --workspace ./my-project # 指定目录
npx @nimbo/cli --port 4000
```

**装它一个就够**，`fromDirectory` + `localExec` 已经配好，历史落在 `./.nimbo/nimbo.db`。

**没有隔离**——agent 能改本机任何文件、跑任何命令，跟 Claude Code 同一个模型。适合个人自用与受信环境，**不适合多租户服务**。

### 4.2 ① 同机多进程 cluster（自建 VPS）

Node cluster 的 worker **不共享内存**，所以这一档已经需要真正的归属仲裁了。

```ts
import Database from "better-sqlite3";
import { sqlPersistence } from "@nimbo/persist-sql";

const persistence = sqlPersistence({
  driver: new Database("./nimbo.db"),   // 传裸驱动，框架不要求你用某个 ORM
  dialect: "sqlite",
});

const runtime = createAgentRuntime(agent, {
  workspace,
  persistence,
  // 租约版归属仲裁跟持久化同包、共用一个连接
  arbitration: persistence.lease({
    holder: `${process.pid}@localhost:${PORT}`,   // 同机转发用 localhost 即可
  }),
});
```

流分发仍走内置——同机多进程可以直接转发到持有者那个进程。

> SQLite 记得开 WAL；同机没有网络分区，所以这一档的 split-brain 风险远低于跨机。

### 4.3 ② Docker / ③ k8s

跟 ① 只差两处：换 Postgres、换远端沙盒。

```ts
import { Pool } from "pg";
import { sqlPersistence } from "@nimbo/persist-sql";
import { e2bWorkspace } from "@nimbo/sandbox-e2b";

const persistence = sqlPersistence({
  driver: new Pool({ connectionString: process.env.DATABASE_URL }),
  dialect: "postgres",              // ← 只有这个字符串变了
});

const runtime = createAgentRuntime(agent, {
  workspace: e2bWorkspace({ template: "nimbo-node", apiKey: process.env.E2B_API_KEY! }),
  persistence,
  arbitration: persistence.lease({
    holder: `${process.env.POD_IP}:${PORT}`,   // k8s 填 pod IP，docker 填容器可达地址
  }),
});
```

**外加 §3.1 那段转发**。

### 4.4 已经在用 drizzle / prisma

不想在应用里出现第二套数据访问方式，就换一条腿——**只有构造持久化那一行不同，其余全一样**：

```ts
import { drizzlePersistence } from "@nimbo/persist-drizzle";
const persistence = drizzlePersistence(db, { provider: "pg" });

// 或
import { prismaPersistence } from "@nimbo/persist-prisma";
const persistence = prismaPersistence(prisma, { provider: "postgresql" });
```

nimbo 的表会长在你自己的 schema 管理之下，跟着你的迁移一起走。

### 4.5 ④a Cloudflare Durable Object

**一个会话 = 一个 DO**，所以归属仲裁、转发、存储全是平台自带的：

```ts
import { DurableObject } from "cloudflare:workers";
import { durableObjectBackend } from "@nimbo/durable-object";
import { cloudflareWorkspace } from "@nimbo/sandbox-cloudflare";

export class Conversation extends DurableObject<Env> {
  private runtime = createAgentRuntime(agent, {
    ...durableObjectBackend(this.ctx),        // 持久化 + 归属仲裁 + 流分发，一次给全
    workspace: cloudflareWorkspace(this.env.SANDBOX),
  });

  async post(input: Input) { await this.runtime.enqueue(this.ctx.id.toString(), input); }
}

export default {
  async fetch(request: Request, env: Env) {
    const id = env.CONVERSATION.idFromName(conversationIdFrom(request));
    return env.CONVERSATION.get(id).fetch(request);   // stub 就是通道，不用自己写转发
  },
};
```

> 代价在另一头：每个 DO 有**自己独立的**存储，「列出这个用户的所有会话」这种跨会话查询要另建索引。

### 4.6 ④b Vercel Functions

Vercel **不可寻址**——同一会话的两个请求可能落到不同实例，转发不了。拆开看只有一件事真需要找到持有者：**实时流**。所以用广播绕过：

```ts
import { redisStream } from "@nimbo/stream-redis";

const runtime = createAgentRuntime(agent, {
  workspace: vercelWorkspace({ ... }),
  persistence,
  arbitration: persistence.lease({ holder: `vercel:${randomUUID()}` }),
  stream: redisStream({ url: process.env.REDIS_URL! }),   // ← 这一档独有
  suspend: { memoryWindow: 0 },   // 不等：等人一律立刻挂起，避开「送到持有者手上」
});
```

**这一档反而比 k8s 少写一块**（不用写转发）。代价是两条：**必须外挂一个 Redis**、**单轮不能超过函数时长上限**（800 秒 GA / 30 分钟 beta），跑超按崩溃处理。

适合问答型、短任务的轻量 agent；长时间编码任务要换一档。**AWS Lambda 不支持**——29 秒上限连一轮都跑不完。

---

## 5. 策略：产品决策由你配

> **框架的原则是「要不要这个功能」归你，「怎么实现」归框架。**

```ts
const runtime = createAgentRuntime(agent, {
  workspace, persistence, arbitration,

  // agent 忙时来了新消息怎么办
  queue: {
    enabled: true,
    max: 10,
    onFull: "reject",           // 'reject' | 'dropOldest'
    steer: "never",             // 'never' | 'always' | (input) => boolean —— 插进当前这一轮还是排队
  },

  // 等人
  suspend: {
    memoryWindow: "5m",         // 内存里先等多久，等不到就挂起。0 = 立刻挂起
    onPresence: "extend",       // 上报「人还在」时延长这个窗口
  },

  // 工作区能恢复多久（只对支持快照过期的沙盒有意义，比如 Vercel）
  workspaceRetention: "7d",     // '24h' | '3d' | '7d' | 'forever'
});
```

**这些都不影响正确性**——配错了最多是产品行为不符合预期，不会写坏数据。真正难写对的部分（释放归属时的竞态、租期校验、seq 分配）在框架里，你碰不到也不用碰。

---

## 6. 换档要改什么

这是整套设计的收益所在——**从上到下每一步只动配置**：

| 从 → 到 | 要改的 |
|---|---|
| 零配置 → ① cluster | 加 `persistence` + `arbitration` 两行 |
| ① → ②③ | `dialect` 换字符串、`driver` 换 `Pool`、`workspace` 换远端沙盒、加 §3.1 转发 |
| 裸驱动 → drizzle/prisma | **只换构造持久化那一行** |
| ②③ → ④b Vercel | 加 `stream`、`suspend.memoryWindow: 0`，**删掉转发** |
| ②③ → ④a DO | 换成 `durableObjectBackend(...)`，**删掉转发** |

**业务代码（`enqueue` / `subscribe` / `submitDecision`）一行不动。**

---

## 7. 有几个行为要知道

### 7.1 等人时这一轮会「消失」再「回来」

agent 弹出审批卡片后：

- **人在窗口内点了**（默认 5 分钟）→ 跟以前一样，这一轮直接往下跑。
- **一直没点** → 这一轮**[挂起](../terms.md)**：进度落盘、机器放掉。人几小时后回来点「允许」，在**任何一个节点**都能接着干。

**挂起是无损的**——记录、裁决、沙盒快照都在，用户回来的代价只是多等几秒唤醒沙盒。

两个可见后果：**审批不再有「N 分钟就作废」这回事**；**滚动发布不用等人**。

### 7.2 恢复算「新的一轮」

界面上会看到两条轮记录：第 4 轮以「已挂起」收尾，第 5 轮从「结清那个调用」开始。**模型看到的历史是连续的**，轮号只是记账。

轮统计因此也是分开的（挂起那轮 3 分钟、恢复那轮 2 分钟），**不会出现「这一轮耗时 1 小时 5 分」这种误导数字**。

### 7.3 多节点下有一条新行为

会出现单进程永远不会有的情况：

> **一轮跑到一半，被告知「你已经不是这个会话的主人了」。**

框架把这一轮按中断收尾，用户看到「这一轮被中断，请重试」。原因是节点失联被误判为崩溃——**概率很低但不为零，产品文案要覆盖它**。

### 7.4 崩溃仍然按老路走

进程被强杀（OOM、`kill -9`）不走挂起——它没停在干净边界上。下次启动补一条「已中断」，跟[优雅关闭与崩溃恢复](./graceful-shutdown.md)一致。

---

## 8. 三个角色的边界

写文档和讨论时这三个词严格区分：

| 角色 | 是什么 | 干什么 |
|---|---|---|
| **[agent 构建者](../terms.md)** | 拿 nimbo 建产品的**开发者**（人） | 做产品决策；写接入代码；把宿主配起来 |
| **[宿主](../terms.md)** | 框架落地的**运行底座**（代码/环境） | 提供四样资源：沙盒、持久化、流分发、归属仲裁机制 |
| **最终用户** | 跟 agent 对话的**人** | 发消息、点审批、看结果 |

**宿主在框架下面、接入在框架上面**——两样都由构建者交付，但调用方向相反，所以不共用一个词。沙盒和存储本身不是「宿主」，它们是宿主**提供的资源**。

---

## 9. 范围与非目标

**明确不做**：

- 不提供用户 / 认证体系（构建者的事）
- 不碰 HTTP——不提供路由、不提供 SSE 序列化、不假设 `node:http` 存在
- 不提供沙盒（只消费 `NimboFS`/`NimboExec` 标准接口）
- 不把 chat 应用的数据模型标准化成契约（标题、仓库、分支不归 nimbo）
- 不要求用某个 ORM、不要求跑 nimbo 的迁移
- 不支持纯无状态函数里「一轮跑很久」的场景

**已知限制**：

- **④b Vercel**：单轮受函数时长上限约束。**AWS Lambda 不支持**。
- **⓪ 本机 CLI 没有隔离**：适合个人自用与受信环境，不适合多租户。
- **[独占](../terms.md)是按会话保证的，不是按机器**：框架保证「一个会话不会被两个执行同时写」，**不保证「两个会话不会踩同一个文件」**。⓪ 那档多个会话共用一个项目目录时，冲突自己管（跟同时开两个 Claude Code 一样）。

## 10. 成功标准

1. **零配置能跑**：不配任何外部件，`@nimbo/agent` 单独就能起会话、跑完一轮、再跑下一轮。
2. **换存储不改业务代码**：SQLite → Postgres 只换一个字符串和一个 driver。
3. **换部署形态不改业务代码**：单进程 → 多进程只加 `arbitration` 一行。
4. **等人不占机器**：审批挂起后那个节点能正常参与滚动发布并退出；人回来在别的节点恢复成功。
5. **多节点下账本不交错**：失联节点恢复后的写入被明确拒绝，而不是静默混进账本。
6. **`@nimbo/cli` 三十秒可用**：`npx` 一条命令起来，浏览器里能让 agent 改当前目录的文件。
