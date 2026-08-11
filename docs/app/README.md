# app 层 —— 接入层与成品应用

> 上级索引：[docs/README.zh-CN.md](../README.zh-CN.md) · 术语表：[terms.md](../terms.md)
> 分层依据：[agent 内核包 · 技术方案 §2](../agent/agent-kernel/tech.md#2-分层)

**框架不碰 HTTP**——路由、SSE 序列化、前端、审批端点都由[构建者](../terms.md)写，这一层就是那部分：nimbo 自己拿框架搭的成品与示例应用，落在 `apps/*` 与 `examples`（都是 `private: true`、不发布）。

它们同时也是[宿主](../terms.md)的具体实例——把[宿主层](../host/README.md)的沙盒、存储接起来的那段代码在这里。

每个功能一个目录，目录里最多三份文档：`feature.md`（产品/使用手册）· `tech.md`（技术方案）· `plan.md`（施工进展）。

## 与 agent 层的边界（读本层文档前先看）

chat 应用是 [`@nimbo/agent`](../agent/agent-kernel/feature.md) 的**第一个宿主**，也是那套机制的试验田——于是本层有一部分内容跟 [agent 层](../agent/README.md)讲的是同一件事。分工按两条规则：

| | 归哪 |
|---|---|
| 起轮与一轮的驱动收尾 · 账本与回放 · 断线续传 · 排队与插话 · 停止 · 优雅关闭 · 等人与挂起 | **agent 层是设计权威**；本层只记「chat 应用今天怎么落地的」，两者出入以 agent 层为准 |
| 仓库/分支/PR · 注册登录与属主 · 危险命令清单与**授权键怎么算** · 通知投递 · 遥测存储 · 界面 | **本层**（构建者侧产品决策，nimbo 明确不管） |

逐条对照（哪些目标一致、哪些是本层多出来还没进框架的）见 [agent/agent-kernel/plan 表 A / 表 B](../agent/agent-kernel/plan.md#从-chat-应用吸收2026-08-10-逐条对照)。文档里 ⚠️ 标的是「会被 agent 层取代」，🔀 标的是「待对齐」。

**本层有两份文档不是自成一体的功能**，各有一半属于别的层，别照着它们理解框架边界：

- [`approval-grant-split`](./approval-grant-split/feature.md)（分段授权）：「记住一条更宽的授权、下次直接放行」这个**机制**该归 agent 层（框架现在缺这张表）；本文主要讲的「bash 复合命令怎么拆段、键怎么算」才是本层的事。
- [`cloudflare-worker-server`](./cloudflare-worker-server/feature.md)：一个**双角色部署壳**——网关那半的能力本体在 [host/sandbox](../host/sandbox/tech.md) §6，Worker 内跑 agent 那半将来归 `@nimbo/durable-object`（宿主层）。**跟轮编排无关。**

## chat 应用（`apps/node-server` + `apps/web`）

| 功能 | 一句话 | 文档 |
|---|---|---|
| **chat-webapp** | 应用主体：端点、会话生命周期、人在回路的行为语义 | [功能](./chat-webapp/feature.md) · [技术](./chat-webapp/tech.md) · [施工](./chat-webapp/plan.md) |
| **chat-ui** | 界面语言：轨道、打断、信号色、指令块 | [功能](./chat-ui/feature.md) · [技术](./chat-ui/tech.md) · [施工](./chat-ui/plan.md) |
| **composer-skill-mention** | 在 composer 里手动 `@` 指定 skill | [功能](./composer-skill-mention/feature.md) · [技术](./composer-skill-mention/tech.md) · [施工](./composer-skill-mention/plan.md) |
| **approval-grant-split** | 分段授权：「会话内都允许」按每条命令记账，不按整串 | [功能](./approval-grant-split/feature.md) · [技术](./approval-grant-split/tech.md) · [施工](./approval-grant-split/plan.md) |
| **web-search** | 联网搜索工具：让「我不知道」变成「我去查」 | [功能](./web-search/feature.md) · [技术](./web-search/tech.md) · [施工](./web-search/plan.md) |
| **push-notification** | 推送通知：agent 停下来等你时告诉你 | [功能](./push-notification/feature.md) · [技术](./push-notification/tech.md) · [施工](./push-notification/plan.md) |
| **telemetry** | 遥测：每轮 token / 计时统计与查询端点 | [功能](./telemetry/feature.md) · [技术](./telemetry/tech.md) · [施工](./chat-observability/plan.md) |
| **chat-observability** | 工具计时 + server 日志（遥测的兄弟拆单） | [施工](./chat-observability/plan.md) |

## 其他成品

| 功能 | 一句话 | 文档 |
|---|---|---|
| **cloudflare-worker-server** | 双角色 Worker：进程内直连真实 CF 沙盒，同时对外提供 BYO 网关端点 | [功能](./cloudflare-worker-server/feature.md) · [技术](./cloudflare-worker-server/tech.md) · [施工](./cloudflare-worker-server/plan.md) |
| **examples** | 示例集（实验田）：`pnpm example <编号>` 即跑 | [功能](./examples/feature.md) · [技术](./examples/tech.md) · [施工](./examples/plan.md) |
