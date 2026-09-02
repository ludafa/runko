---
title: "Vercel（宿主层）— 使用手册"
slug: deployment
view: 功能
layer: 宿主层
module: —
packages: ["@runko/sandbox-vercel", "@runko/stream-redis", "@runko/persist-sql"]
tags: ["Vercel", "Functions", "Fluid", "Redis Streams", "部署形态", "平台快照"]
related: ["host/vercel/tech/deployment.md", "host/contract/features/stream-fanout.md", "architecture/features/agent-kernel.md"]
---

# Vercel（宿主层）— 使用手册

> 相关：[技术方案](../tech/deployment.md)。
> 另外三档宿主：[Node 长驻](../../node/features/deployment.md) · [Cloudflare](../../cloudflare/features/deployment.md) · [E2B](../../e2b/features/deployment.md)。
> 术语：[流分发](../../../terms.md) · [平台快照](../../../terms.md) · [挂起](../../../terms.md)。

## 1. 一句话

**这是四档里最费事的一档**——四样能力全要外挂，而且是唯一一档**必须自己养一个 Redis** 的。

原因只有一个：**你没办法找到持有者**。实例由平台调度，请求打到哪个实例不由你定，也没有办法把请求转给指定实例。

## 2. 四样能力全要换

| 能力 | 这一档怎么办 | 为什么不能用内置 |
|---|---|---|
| [归属仲裁机制](../../../terms.md) | 租约版 | 多实例并发，内存 Map 不管用 |
| [持久化](../../../terms.md) | 外部数据库 | 函数实例没有持久磁盘 |
| [流分发](../../../terms.md) | **`@runko/stream-redis`** | **找不到持有者，转发这条路走不通** |
| [沙盒](../../../terms.md) | `@runko/sandbox-vercel` | 函数里跑不了 agent 要的那些命令 |

## 3. 只有一件事真的需要「找到持有者」

这一档看着吓人，但拆开看，四类事件里只有一类绕不过去：

| 事件 | 需要转发吗 | 怎么办 |
|---|---|---|
| 新消息进来（会话正忙） | ❌ | **直接入队**，持有者收尾时自然会看到 |
| 用户点审批 | ⚠️ | 这一档**不做内存等待窗口**，等人一律立刻[挂起](../../../terms.md) → 裁决落库 → 恢复时读 |
| 用户点停止 | ⚠️ | 停止标记落库，跑的那一方每步检查一次 |
| **实时流（SSE）** | ✅ | **绕不过去**——外挂 Redis Streams 广播 |

**所以 Redis 是为实时流一件事装的**，不是为了整套架构。

## 4. 硬约束：单轮跑不完就没辙

Vercel Functions 的单次执行有时长上限（800 秒 GA / 30 分钟 beta）。

runko 的[挂起点只有一个](../../../architecture/features/agent-kernel.md)——**正在等人**。命令跑到一半没有干净边界（不知道它跑完没有），所以**一轮本身超过函数时长上限这件事绕不过去**。

这不是能靠加组件解决的问题，是这一档的固有边界。要跑长任务，去 [Node 长驻](../../node/features/deployment.md)或 [Cloudflare](../../cloudflare/features/deployment.md)。

## 5. 沙盒：休眠靠平台快照

Vercel Sandbox 停机时会自动存一份磁盘镜像（[平台快照](../../../terms.md)），下次按名字恢复。所以**重连令牌就是沙盒名字**——不用像 [E2B](../../e2b/features/deployment.md) 那样把 id 落库。

## 6. 成功标准

- 部署到 Vercel，**多个函数实例并发**处理同一个用户的多个会话，不互相踩。
- 用户在 A 实例发消息、在 B 实例看流，**能看到同一份实时输出**。
- 用户点审批时会话已经挂起了几小时，**点下去能接着往下跑**，而且跑的是账本里原封不动的那条命令。

## 7. 范围与非目标

- **不解决单轮超时。** 见 §4，这是平台边界。
- **Redis 的运维成本是这一档的固有代价**，不是设计缺陷。
- **不做内存等待窗口。** 另外几档等人时会先在内存里等一会儿（默认 5 分钟）再挂起，这一档直接挂起——实例随时可能被回收，内存里等没有意义。
