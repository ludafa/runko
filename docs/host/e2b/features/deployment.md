---
title: "E2B（宿主层）— 使用手册"
slug: deployment
view: 功能
layer: 宿主层
module: 沙盒
packages: ["@nimbo/sandbox-e2b"]
tags: ["E2B", "沙盒", "休眠", "唤醒", "重连令牌", "沙盒模板"]
related: ["host/e2b/tech/deployment.md", "host/contract/features/sandbox.md", "host/contract/features/sandbox-provider.md"]
---

# E2B（宿主层）— 使用手册

> 相关：[技术方案](../tech/deployment.md)。
> 沙盒本身的契约见[沙盒工作区 · 功能](../../contract/features/sandbox.md)，选哪家见[沙盒 provider · 功能](../../contract/features/sandbox-provider.md)。
> 另外三档宿主：[Node 长驻](../../node/features/deployment.md) · [Cloudflare](../../cloudflare/features/deployment.md) · [Vercel](../../vercel/features/deployment.md)。
> 术语：[重连令牌](../../../terms.md) · [沙盒模板](../../../terms.md) · [BYO 实例](../../../terms.md)。

## 1. 一句话

**E2B 跟另外三档不是一类东西**——它只提供[沙盒](../../../terms.md)这一样能力，可以配在任何一档宿主下面。你可以「Node 长驻 + E2B 沙盒」，也可以「Vercel + E2B 沙盒」。

它是三家沙盒里**休眠/唤醒语义最完整**的一家。

## 2. 它解决什么问题

agent 要动手改文件、跑命令。你不想让它碰你的真实机器，就给它一个隔离的 microVM。

E2B 的特点是**这个 microVM 可以睡着，醒来之后文件原样还在**：

```mermaid
flowchart LR
    A["用户发消息<br/>建盒 + git clone"] --> B["agent 干活"]
    B --> C["用户走了<br/><small>空闲超时</small>"]
    C -->|"平台自动 pause"| D["睡着<br/><small>文件与内存都存着</small>"]
    D -->|"下一条消息自动唤醒"| E["接着干<br/><small>分支、未提交的改动都在</small>"]
```

**用户几小时后回来发下一条消息，沙盒自动醒来，之前没提交的改动还在。** 这一条是它跟另外两家最实在的差别。

## 3. 你要准备什么

| 要准备的 | 说明 |
|---|---|
| `E2B_API_KEY` | 只有真的用 E2B 时才需要——没配又选了 E2B，建盒时会抛一个带指引的配置错误 |
| 一个[沙盒模板](../../../terms.md) | **必须自建**，不能用 E2B 自带的 `base`，原因见 §4 |

模板构建是**每个 E2B team 一次性**的操作，幂等：

```sh
pnpm --filter @nimbo-chat/node-server e2b:template
```

## 4. 为什么必须自建模板

E2B 的 **CPU 和内存只能在构建模板时定死**——建盒时的选项里根本没有内存参数。

而 E2B 自带的 `base` 模板是 2 vCPU / **512 MiB**，跑 `npm install` 会被 OOM 杀掉。

所以我们用**同一个 base 镜像**（盒内环境零变化）以 1024 MiB 重新构建一个叫 `nimbo-chat-base` 的模板。

**逃生门**：模板还没构建好的时候，设 `E2B_TEMPLATE=base` 可以退回自带模板（内存回到 512 MiB）。

## 5. 三个配置项，生效时机不一样

这一条踩过坑，值得单独说：

| 配置 | 谁读它 | 什么时候生效 |
|---|---|---|
| `E2B_TEMPLATE`（用哪个模板） | **建盒时读** | 改完下一个盒就生效 |
| `E2B_TEMPLATE_MEMORY_MB` | **只有构建脚本读** | **改完必须重跑 `e2b:template`**，否则纹丝不动 |
| `E2B_TEMPLATE_CPU_COUNT` | 同上 | 同上 |

后两项填了非正整数会**直接抛错终止构建**，不静默回退——因为构建是一次性操作，把 `4O96`（字母 O）静默当成 1024 会发布一个「看着像 4 GiB 实则 1 GiB」的模板，几周后才以 OOM 现形。

## 6. 成功标准

- 用户隔几小时回来发消息，**沙盒自动醒来、未提交的改动还在**，不用重新 clone。
- 一轮跑了十几分钟，**沙盒不会在中途被平台收走**。
- 沙盒真的被平台删了或过期了，**框架自己重建**，用户只看到「重新开始」而不是一个报错。

## 7. 范围与非目标

- **E2B 不是一档独立的部署形态**，是一样能力。它要配在某个宿主下面用。
- **不管沙盒里的命令做了什么。** 保活机制只保证「沙盒还活着」。
- **孤儿沙盒的清理不在框架里。** 首次建盒后落库前进程崩溃，那个盒会成孤儿（占额度）；靠 `Sandbox.list` + metadata 兜底清理是运维脚本的事。
