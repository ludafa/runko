---
title: "轮编排运行时 `createAgentRuntime`（使用手册）"
slug: agent-runtime
view: 功能
layer: 逻辑层
module: 轮编排
packages: ["@runko/agent"]
tags: ["轮编排", "运行时", "宿主能力", "内置实现", "零配置"]
related: ["logic/orchestration/tech/agent-runtime.md", "logic/orchestration/plans/agent-runtime.md", "architecture/features/agent-kernel.md"]
---

# 轮编排运行时 `createAgentRuntime`（使用手册）

> 相关：[技术方案](../tech/agent-runtime.md)，[施工进展](../plans/agent-runtime.md)。
> 上位设计：[agent 内核包 · 功能](../../../architecture/features/agent-kernel.md)（分层、六档部署、三个角色）。本文是它 §2/§3/§5 那几段 API 的**落地版**——那边写的是方案，这里写的是真实现出来的签名。
> 依赖/延续：[core SDK](../../engine/features/core-sdk.md)（建在它的 `Session` 之上）· [排队与插话](./steer-and-queue.md) · [停止一轮](./turn-abort.md) · [优雅关闭与崩溃恢复](./graceful-shutdown.md) · [进行中草稿放内存](../plans/in-flight-draft.md)。

## 1. 要解决的问题

`@runko/core` 的 [`Session`](../../engine/features/core-sdk.md) 只解决「跑一轮」：给它历史和工具，它调模型、跑工具、喂回去，跑完返回。**它不知道时间、进程、存储。**

于是每个拿它建产品的人都要自己写同一批东西：

1. 一轮跑完，下一条消息什么时候起？agent 忙的时候用户又发了一条怎么办？
2. agent 弹审批卡片时，怎么把人的裁决送回那个正 `await` 的 loop？
3. 进程被强杀，界面上那一轮永远转圈，怎么补收尾？
4. 部署要重启，怎么让进行中的轮体面地停下来而不是无声消失？

`apps/node-server` 把这四件事全写了一遍，一千多行，绑死 SQLite、绑死单进程。**本包把它们收进框架**，并把「取决于你怎么部署」的部分做成可替换的。

## 2. 三十秒上手

```ts
import { defineAgent } from "@runko/sdk";
import { createAgentRuntime } from "@runko/agent";
import { MemoryFS } from "@runko/virtual-fs";
import { localExec } from "@runko/core";

const agent = defineAgent({ model: "anthropic/claude-sonnet-5" });

const runtime = createAgentRuntime({
  agent,
  // 唯一必填：这一轮在哪儿干活
  prepareTurn: () => {
    const fs = new MemoryFS();
    return { fs, exec: localExec({ materialize: true, fs }) };
  },
});

await runtime.enqueue("conv_abc", { text: "把 src 里的 var 都改成 const" });

for await (const frame of runtime.subscribe("conv_abc")) {
  console.log(frame);
}
```

**持久化、[流分发](../../../terms.md)、[归属仲裁机制](../../../terms.md)三样全走内置实现**——账本在内存、流走进程内 EventEmitter、[独占](../../../terms.md)靠进程内一个 Map。够跑通、够写测试，进程一重启历史就没了。

要留住历史就换掉 `persistence`，要上多进程再换掉 `arbitration`——**换档就是换掉一两样，业务代码不动**。

## 3. 你要写的六个接触点

框架不碰 HTTP。你的路由跟框架之间只有这几个接触点，每一个都对应 `apps/node-server` 里真实存在的一个端点：

| 你的动作 | 调什么 | 语义 |
|---|---|---|
| 用户发消息 | `runtime.enqueue(id, input, opts?)` | 忙不忙、排队还是插话、要不要起轮，**框架自己判** |
| 页面要看实时流 | `runtime.subscribe(id, { after })` | 中立的 `AsyncIterable`，序列化成 SSE / WebSocket 由你定 |
| 人点了审批 | `runtime.submitDecision(id, callId, d)` | 裁决落库 + 唤醒那个正 `await` 的 loop |
| 人回答了 `ask-user` | `runtime.submitAnswer(id, callId, text)` | 同上 |
| 用户点停止 | `runtime.abort(id)` | 中止当前轮 + 清空[待发队列](../../../terms.md) |
| 进程要退 | `runtime.shutdown({ graceMs })` | [交权](../../../terms.md)：停掉在跑的轮、等它们收尾 |

外加两个**启动/查询**用的：`runtime.recover()`（启动时扫[孤儿轮](../../../terms.md)补收尾）、`runtime.getActivity(id)`（这个会话此刻在不在跑、谁在跑）。

### 3.1 `enqueue` 一个函数管三种情况

这是本包最要紧的一处收敛。以前 chat 应用的 `POST .../messages` 里写着一段三路分流（有没有轮在跑 × intent 是排队还是插话），还带一个「插话失败要不要回落起新轮」的窄竞态。现在**全在 `enqueue` 里判一次**：

```ts
const result = await runtime.enqueue(conversationId, { text }, { intent: "queue" });
// result.mode: 'started' | 'queued' | 'steered' | 'rejected'
```

| 会话此刻 | `intent: 'queue'`（默认） | `intent: 'steer'` |
|---|---|---|
| 空闲 | 起新一轮 `started` | 起新一轮 `started`（没轮可插，intent 无意义） |
| 有轮在跑 | 进[待发队列](../../../terms.md) `queued` | 插进这一轮 `steered` |
| 轮在[起轮装配](../../../terms.md)里 | `queued` | **`queued`**——还没有 session 可插 |
| 队列已满 / 正在关闭 | `rejected`，带 `reason` | 同左 |

**释放归属的竞态框架内部解决**：一轮收尾时框架自己取队首起下一轮；查完队列「没活儿了」到真正释放之间用户又发了一条，由 `enqueue` 那一侧兜底（入队后发现没人持有归属就自己抢来开轮）。**构建者完全不需要知道有这回事。**

### 3.2 `subscribe` 给的是四种帧

```ts
for await (const frame of runtime.subscribe(id, { after: lastSeq })) { /* … */ }
```

| 帧 | 有 `seq` 吗 | 什么时候来 |
|---|---|---|
| `{ kind: 'message', seq, message }` | ✅ | [账本](../../../terms.md)里的成品消息——回放历史，以及每一轮新落盘的消息 |
| `{ kind: 'chunk', chunk }` | ❌ | 直播的 [chunk](../../../terms.md)。**一律不落盘**（见 §4.1） |
| `{ kind: 'queue', queue }` | ❌ | [待发队列](../../../terms.md)快照。每条连接必发一帧，之后变一次发一次 |
| `{ kind: 'activity', active }` | ❌ | [轮状态快照](../../../terms.md)。每条连接必发一帧，**服务端的权威答案** |

顺序是固定的：**先回放 `after` 之后的成品消息 → 补发[进行中草稿](../../../terms.md) → 队列快照 → 轮状态快照 → 进直播**。这个顺序保证任何时候连上/重连拿到的都是一致的画面。

## 4. 有几个行为要知道

### 4.1 数据库从头到尾只写成品

一轮进行中产生的 chunk **不再落库**（[进行中草稿放内存](../plans/in-flight-draft.md)），只在内存里攒一份，随这一轮一起丢掉。重连时整份重发——因为 chunk 流自带消息 id，**重放是幂等的**，前端按 id 覆盖即可。

三个连带的好处：账本只有成品消息、`seq` 的含义从「第几条落盘记录」收敛成「第几条消息」、写库量降一个量级。

### 4.2 「有没有轮在跑」是查出来的，不是猜的

以前前端只能猜（看历史最后一条是不是临时行），崩溃残留会让这个猜测长期失准且永不自愈。现在有两条权威通道：`runtime.getActivity(id)` 与每条订阅必发的那帧 `activity`。

### 4.3 崩溃恢复靠[起轮标记](../../../terms.md)

起轮时框架往归属表写一行「这一轮由谁在跑」，收尾时删掉。**启动时 `runtime.recover()` 扫描：还留着标记 = 那一轮没人管了**，补一条「已停止」。

这条判据是**直接**的——不再依赖「chunk 行会被 GC 掉」这个副作用，GC 漏跑不会再把活着的轮误判成孤儿。

### 4.4 停止与关闭走同一条路

用户点停止和进程要重启，落到框架里是同一个动作：中止那一轮的 `AbortSignal`、把挂着的人审/提问就地结掉。区别只在**理由字符串**——它经 core 透传进收尾 `message-metadata`，界面据此区分「已停止」与「服务重启，这一轮已中断」。

关闭还多两件事：置一道闸门让新轮一律被拒（否则[自动出队](../../../terms.md)会源源不断起新轮，永远等不完），以及等一个宽限期。

## 5. 策略：产品决策由你配

```ts
createAgentRuntime({
  agent, workspace, persistence, arbitration, stream,

  queue: {
    enabled: true,
    max: 10,
    onFull: "reject",          // 'reject' | 'dropOldest'
    steer: "onRequest",        // 'never' | 'always' | 'onRequest' | (input) => boolean
  },

  human: {
    approvalTimeoutMs: 240_000,   // 人多久不理算放弃
    askUserTimeoutMs: 240_000,
  },

  shutdown: { graceMs: 15_000 },
});
```

**这些都不影响正确性**——配错了最多是产品行为不符合预期，不会写坏数据。真正难写对的部分（释放归属时的竞态、seq 分配、收尾顺序）在框架里，你碰不到也不用碰。

## 6. 范围与非目标

**明确不做**（与[架构总纲 §9](../../../architecture/features/agent-kernel.md) 一致）：不提供用户/认证体系、不碰 HTTP、不提供沙盒（只消费 `RunkoFS`/`RunkoExec`）、不要求用某个 ORM。

**本批未实现**（接口已为它留好位置，见[施工进展](../plans/agent-runtime.md)）：

- **[挂起](../../../terms.md)与恢复（K3）**——等人等太久时落盘退出、人回来在任意节点接着干。它卡在一个还没定的上游问题上：core 的「恢复开轮」入口怎么加。本批的行为仍是「在内存里等到超时就拒绝」。
- **[租约](../../../terms.md)版归属仲裁（K6）**——多进程共享 DB。本批只有内存 Map 版；接口按租约版的需要定形（`nextSeq` 会报「失去独占权」、`Grant` 带失效信号），换实现不用改轮编排。

## 7. 成功标准

1. **零配置能跑**：不配任何外部件，起会话 → 跑完一轮 → 再跑下一轮。
2. **换存储不改业务代码**：`apps/node-server` 换成自己的 drizzle 持久化，`enqueue`/`subscribe`/`submitDecision` 一行不动。
3. **chat 应用行为不变、代码变少**：迁移后 `apps/node-server` 的 `turn-runner/` 与 `turn-launcher.ts` 整个删掉。
4. **端到端跑通**：浏览器里发消息、看流式输出、点审批、点停止，全部照旧。
