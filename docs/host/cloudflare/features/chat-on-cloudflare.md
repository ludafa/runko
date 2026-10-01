---
title: "chat 应用上 Cloudflare（chat-on-cloudflare）— 功能手册"
slug: chat-on-cloudflare
view: 功能
layer: 宿主层
module: —
packages: ["@runko/durable-object", "@runko/sandbox-cloudflare", "@runko-chat/cloudflare-server"]
tags: ["Cloudflare", "Durable Object", "D1", "Containers", "部署", "会话对象", "chat 应用"]
related: ["host/cloudflare/tech/chat-on-cloudflare.md", "host/cloudflare/plans/chat-on-cloudflare.md", "host/cloudflare/features/deployment.md", "ingress/features/unified-demo.md", "ingress/features/github-repo-access.md"]
---
# chat 应用上 Cloudflare — 功能手册

> 术语见 [术语表](../../../terms.md)。怎么做见[技术方案](../tech/chat-on-cloudflare.md)；拆单与进度见[施工](../plans/chat-on-cloudflare.md)。
> 框架这一档的总体设计见 [Cloudflare（宿主层）](./deployment.md)。

## 一句话

把 chat 应用整个搬上 Cloudflare：**一条 `wrangler deploy` 上线**，前端、服务端、数据库、沙盒全在 Cloudflare 上；用户用起来和 Node 版一样，任务不会因为跑得久被掐断，全球就近访问。

## 1. 要解决的问题

chat 应用现在只能跑在 Node 上：要自己准备一台常开的机器、一个 Postgres，多开几台还得配 Redis、nginx。想给别人用，就得自己运维服务器。

托管平台里，Vercel 的免费档一轮最多跑 5 分钟，付费档也有半小时上限；Cloudflare 的运行方式（**一个会话对应一个常驻对象**）和 agent「一轮可能跑很久、中间要等人」的特点最贴合，而且最低付费档只要每月 5 美元。对比见附录 A。

## 2. 用户看得到什么

### 2.1 和 Node 版一样的

- 注册、登录（邮箱，或 GitHub）。
- 建会话、发消息、看 agent 一边想一边输出；排队、插话、停止。
- 工具卡片、审批、提问、挂起与恢复。
- 选沙盒：**本地沙盒**（不花钱、没有 git）或 **Cloudflare 沙盒**（真 Linux 容器，能跑 `npm install`、能拉仓库）。
- 用 Cloudflare 沙盒时，从自己授权过的 GitHub 仓库里挑一个拉进来改（[按用户授权加载 GitHub 仓库](../../../ingress/features/github-repo-access.md)）。
- 直播走 SSE 或 WebSocket，设置页里切换。

### 2.2 比 Node 版好的

- **任务不会因为跑得久被掐断**：一轮跑一个小时也行。等模型、等命令的时间不算钱。
- **哪里打开都快**：Cloudflare 全球就近接入，没有「服务器在美国、人在中国」那种慢。
- **不用管服务器**：没有机器要开、没有数据库要升级，人多了平台自己扩。

### 2.3 用户能感觉到的不同

| 什么时候 | 用户看到什么 | 为什么 |
|---|---|---|
| 新会话第一次用 Cloudflare 沙盒，或者沙盒闲置后再用 | 「正在准备…」多等几秒 | 容器要启动。打开会话时会提前把沙盒叫醒，大多数时候用户发第一条消息时它已经好了 |
| 部署新版本那一刻，正好有一轮在跑 | 这一轮显示「服务重启，这一轮已中断」，接着发消息即可继续 | Cloudflare 部署时会重启所有会话对象。部署是部署的人主动做的、频率低 |
| 沙盒里内存吃紧的操作 | 和 Node 版用云沙盒一样 | 沙盒规格缺省 4 GB 内存，`npm install` 这类操作够用 |

## 3. 部署的人要做什么

1. 有一个 Cloudflare 账号，开通 **Workers 付费档（每月 5 美元）**——Durable Object、容器沙盒、宽松的 CPU 额度都在这一档里。
2. 在仓库里跑一遍部署脚本（[技术方案 §9](../tech/chat-on-cloudflare.md)）：它建好 D1 数据库、建表、上传前端、部署 Worker 和沙盒镜像。
3. 用 `wrangler secret put` 填几个密钥：登录用的 `BETTER_AUTH_SECRET`；要真模型就填 `DEEPSEEK_API_TOKEN`（不填就用[演示模型](../../../terms.md)）；要 GitHub 登录与选仓库就填 GitHub App 那几项。
4. 在 Cloudflare 后台设一个**用量提醒**：超出 5 美元包含的额度时发邮件。

### 3.1 5 美元里含什么、超了怎么办

| 用在哪 | 每月含 | 实际够用多久 |
|---|---|---|
| 接口请求、服务端计算、会话对象、数据库 | 1000 万次请求、约 8 小时 CPU、10 GB 存储等 | 个人和小团队基本用不完 |
| **Cloudflare 沙盒** | 内存 25 GiB·小时等 | 缺省规格（4 GB 内存）约 **6 小时**沙盒运行时间；只按沙盒醒着的时间算 |

**超了不会停服**，自动按量计费：沙盒每多跑一小时约 0.06 美元。所以真正要留意的是钱，不是可用性——用量提醒就是为这个。模型的费用（DeepSeek 等）不在 Cloudflare 账单里。

## 4. 范围

**做：**

- chat 应用 Cloudflare 版：前端、服务端、数据库、会话对象、本地沙盒、Cloudflare 沙盒、GitHub 登录与选仓库、SSE 与 WebSocket。
- 框架包 `@runko/durable-object`：让任何人都能把 runko 跑在 Durable Object 上，不只是这个 chat 应用。
- 一键部署脚本与部署说明。

**不做（非目标）：**

- **集群控制台、节点下线、交权**：Cloudflare 上没有「节点」这个概念，会话对象由平台调度。
- **Redis、nginx**：会话对象自己就是直播的中心，不需要。
- **推送通知**（Web Push）：本期不做，见附录 B。
- **部署时不中断正在跑的轮**：本期做到「中断后如实告诉用户、接着发消息能继续」；做到无感续跑见附录 B。
- **免费档**：免费档每次请求只有 10 毫秒 CPU、最多 50 个外部请求，跑不动 agent。

## 5. 成功标准

1. 在一个全新的 Cloudflare 账号上，按部署说明从零部署成功，打开网址就能注册、建会话、聊天。
2. 一轮跑超过 15 分钟（演示模型拉长输出），不被掐断。
3. 选 Cloudflare 沙盒建会话，能跑 `npm install`；选一个授权过的 GitHub 仓库，agent 改完能推到工作分支。
4. 刷新页面、断网重连，内容不重不漏；两个标签页同时看同一个会话，都能看到直播。
5. 部署新版本时正在跑的那一轮，显示「服务重启，这一轮已中断」，接着发消息能继续。
6. 一个月个人使用，账单不超过 5 美元（不含模型费）。

---

# 附录

## 附录 A · 为什么是 Cloudflare

只从用户角度比（不算我们改代码的成本）：

| | Cloudflare 付费档 | Vercel Pro | Vercel 免费档 | 自己的虚拟机 |
|---|---|---|---|---|
| 长任务会不会被掐断 | 不会 | 一轮最长 13–30 分钟 | **一轮最多 5 分钟** | 不会 |
| 冷启动 | 几乎没有（沙盒除外） | 偶尔一两秒 | 偶尔一两秒 | 没有 |
| 离用户近不近 | 全球就近 | 单区域 | 单区域 | 单机房 |
| 直播 | WebSocket、SSE 都行，连接一直挂着 | 只有 SSE，定期断开重连 | 同左 | 都行 |
| 服务可用性 | 平台托管 | 平台托管 | 平台托管 | 单台机器 |
| 每月花费 | 5 美元起 | 20 美元起 | 0（非商用） | 0 起 |

## 附录 B · 以后再做

- **推送通知**：Web Push 要用 VAPID 签名，Workers 上要换成 WebCrypto 实现。
- **部署时无感续跑**：部署前给正在跑的轮打交权标记，新版本起来后接着跑（复用[交权](../../../logic/orchestration/features/handover.md)的「接着跑」）。难点是 Cloudflare 部署时不给会话对象发「要重启了」的通知。
- **沙盒规格可选**：建会话时选沙盒大小。
