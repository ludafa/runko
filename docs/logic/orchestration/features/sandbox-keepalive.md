---
title: "沙盒保活（keepalive）"
slug: sandbox-keepalive
view: 功能
layer: 逻辑层
module: 轮编排
packages: ["@runko/agent"]
tags: ["沙盒保活", "活动信号", "保活预算", "等人状态"]
related: ["logic/orchestration/plans/sandbox-keepalive.md", "logic/orchestration/tech/sandbox-keepalive.md", "architecture/tech/agent-kernel.md"]
---
# 沙盒保活（keepalive）

> 本文用到的术语见 [docs/terms.md](../../../terms.md)。
> [技术方案](../tech/sandbox-keepalive.md)，[施工进展](../plans/sandbox-keepalive.md)。

## 1. 要解决什么问题

**一句话：agent 还在干活，沙盒却被平台停掉了。**

云沙盒都有一个存活期限。到点就停机（Vercel）或休眠（E2B）。关键在于——

> **在沙盒里跑命令，不会让这个期限往后推。**

平台根本不看你在不在干活，它只看一个倒计时。这一点非常反直觉，几乎所有人第一次都会想当然地以为"我一直在用它，它当然不会睡"。

真机实测的数字（来自 [沙盒 provider 可选 · 技术方案](../../../host/contract/tech/sandbox-provider.md) §5.1）：

> 某个 E2B 沙盒 `startedAt 09:52:53`，一轮开始时续期一次，到期时间就钉死在 `10:00:56`。这期间在盒里跑了 2.5 分钟命令，**到期时间纹丝不动**。

所以，只要一轮 agent 跑得比这个期限长，沙盒就会在跑到一半时被抽走。这不是小概率事件——一次 `npm install` 加一轮测试就能轻松超过 5 分钟。

这个坑 runko 自己的 chat 应用踩过一次线上事故。当时"沙盒超时是绝对时间"这条事实**已经写在文档里了**，但没人推导出它对长轮次意味着什么。

## 2. 谁会用到

| 用户 | 场景 |
|---|---|
| 用 `@runko/sdk` + 云沙盒写应用的开发者 | 只要一轮可能跑超过沙盒期限，就需要它 |
| chat 应用（`@runko-chat/node-server`）维护者 | 现有的手写心跳被这套取代 |

**用内存工作区或本机执行的人不需要关心**——那些没有存活期限的概念，这个功能对他们完全不存在。

## 3. 用户看到什么

### 3.1 默认行为：接了云沙盒就自动保活

```ts
import { createSession, defineAgent } from '@runko/sdk';
import { e2bWorkspace } from '@runko/sandbox-e2b';
import { Sandbox } from 'e2b';

const sandbox = await Sandbox.create({ timeoutMs: 300_000 });
const workspace = e2bWorkspace(sandbox, {
  keepAlive: { idleTimeoutMs: 300_000 },   // ← 开启保活
});

const session = createSession(defineAgent({ model }), { workspace });
await session.send('装依赖，跑测试，把失败的用例修好');   // 跑一小时也不会被抽走
```

只要传了 `keepAlive`，剩下的全自动：这一轮跑多久，沙盒就活多久。

**没传 `keepAlive` 就完全不保活**，行为跟现在一模一样。这是有意的——保活会花钱，不该在用户没要求时悄悄发生。

### 3.2 虚拟工作区自动不参与，不用配置

```ts
const workspace = await RunkoFS.fromMemory();   // 内存工作区
const session = createSession(agent, { workspace, exec: miniBash() });
// 什么都不会发生，也不需要关掉什么
```

保活是个**可选能力**。内存工作区、目录工作区、mini-bash 根本没有这个能力，core 探测到没有就跳过。**"虚拟沙盒不激活"不需要你做任何事。**

Cloudflare 沙盒也不参与，但原因不同：它的 `sleepAfter` 是真正的空闲检测，有活动会自己续，本来就不需要外部保活。

### 3.3 卡住了会自动停，不会一直烧钱

这是设计里最重要的安全性质：

**保活靠"这一轮真的在产出东西"来驱动。** 一旦这一轮真的卡死了（模型挂住、网络断了、进程僵住），信号自然就停了，沙盒会按自己的节奏休眠。

换句话说，**它不会让一个已经死掉的任务无限续命**。

### 3.4 三个可以调的口子

| 配置 | 默认 | 作用 |
|---|---|---|
| `idleTimeoutMs` | 必填 | 每次续期补到多少。应与建盒时的 timeout 一致 |
| `maxTurnMs`（[单轮保活上限](../../../terms.md)） | 30 分钟 | 一轮最多续这么久，之后放手 |
| `approvalBudgetMs`（[审批保活预算](../../../terms.md)） | 5 分钟 | 卡在人工审批时最多还续多久，**配 0 就完全不续** |

**为什么审批要单独一个口子**：等人点按钮和 agent 在干活是两回事。人可能去吃饭了，这时候继续为沙盒付钱通常不划算。把它跟正常干活的上限分开，你可以设成"干活最多续 30 分钟，等人最多续 2 分钟"。

配 `approvalBudgetMs: 0` 的后果要知道：如果人过了很久才点批准，沙盒可能已经休眠，这次工具执行会撞上"沙盒不可用"。宿主需要处理重连。

### 3.5 能看见它在做什么

```ts
e2bWorkspace(sandbox, {
  keepAlive: {
    idleTimeoutMs: 300_000,
    onRenew(info) {
      console.log(info.ok ? '续期成功' : '续期失败', info.trigger, info.error);
    },
  },
});
```

`onRenew` 每次真的调用了厂商 API 之后触发。它有两个用处：

1. **看日志**——续了几次、什么时候续的、失败过吗。
2. **同步宿主自己的状态**——如果宿主也在记"这个沙盒还能活多久"（chat 应用的 `sandbox-manager` 就在记），必须靠这个回调更新，否则宿主的记录会和实际情况脱节。

## 4. 范围与非目标

### 做

- 一轮进行期间自动把沙盒续着，包括长命令执行期间和等人审批期间。
- 卡死时自动放手。
- 三个可调上限 + 一个观测回调。
- E2B、Vercel 两家的实现。
- chat 应用切换到这套，删掉自己手写的心跳。

### 不做

- **不创建、不销毁沙盒。** 沙盒是宿主建的、宿主杀的（[BYO 实例](../../../terms.md)原则不变）。
- **不重连、不重建。** 沙盒真的没了要怎么办，是宿主的策略——重建意味着重新拉代码、装 skill、切分支，SDK 不知道这些。见 [沙盒工作区（Sandbox Workspace） · 技术方案](../../../host/contract/tech/sandbox.md) §4.6。
- **不自动重试失败的命令。** 续期失败只记录，不做任何补救。理由见 [沙盒 provider 可选 · 技术方案](../../../host/contract/tech/sandbox-provider.md) §5.1 关于"workspace 自愈代理"的分析：命令跑到一半断线后重放会重复执行，`git push` 这类操作会出事。
- **不保证沙盒里的命令做了什么。** 这套只管"沙盒还活着"。
- **Cloudflare 不实现**（它不需要）。

## 5. 成功标准

1. 一轮跑满 30 分钟（含一条 20 分钟的单命令）不被平台中断。
2. 一轮跑到一半人为杀死模型调用，沙盒在 `idleTimeoutMs` 后正常休眠，不再被续期。
3. 用内存工作区跑完整测试套件，零行为变化、零新增网络调用。
4. chat 应用切过去后，`sandbox-manager` 里手写的心跳代码全部删除，行为不退化。
5. 高频对话（连发 10 条消息）后，Vercel 沙盒的剩余存活时间维持在恒定水位，不再累加——修掉现有的"每条消息盲加 5 分钟"计费问题。

## 6. 相关文档

- [技术方案](../tech/sandbox-keepalive.md)：技术方案。
- [施工进展](../plans/sandbox-keepalive.md)：施工进展。
- [沙盒工作区（Sandbox Workspace） · 功能](../../../host/contract/features/sandbox.md)：沙盒适配契约总纲。
- [沙盒 provider 可选 · 功能](../../../host/contract/features/sandbox-provider.md)：chat 应用的多 provider 支持，§5.1 是这个问题的第一次分析。
- [Turn Checkpoint 与沙盒保活 · 功能](./turn-checkpoint.md)：P13-2b 保活方案的原始出处，本文档取代其中的保活部分。
