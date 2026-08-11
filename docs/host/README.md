# host 层 —— 宿主层（可替换的资源）

> 上级索引：[docs/README.zh-CN.md](../README.zh-CN.md) · 术语表：[terms.md](../terms.md)
> 分层依据：[agent 内核包 · 技术方案 §2](../agent/agent-kernel/tech.md#2-分层)

**这一层是「取决于你怎么部署」的那部分**：[agent 层](../agent/README.md)定义语义，宿主层给实现。四样资源——

| 资源 | 干什么 | 现状 |
|---|---|---|
| **沙盒** | agent 动手的地方（`NimboFS` / `NimboExec`） | 已有三家适配器，文档见下表 |
| **持久化** | 账本 / 裁决 / 待发队列 / 租约存哪 | 计划中：`@nimbo/persist-sql` · `persist-drizzle` · `persist-prisma`（见 [agent-kernel §8](../agent/agent-kernel/tech.md#8-包与部署)） |
| **流分发** | 跨实例把[直播流](../terms.md)送到订阅者手上 | 计划中：`@nimbo/stream-redis` |
| **归属仲裁机制** | 多进程 / 多节点时谁持有这个会话 | 计划中：随持久化同包（租约版）· `@nimbo/durable-object` |

**不满足条件时用内置的平凡实现，一个外部件都不用装**——所以下面暂时只有沙盒一支有文档，其余三样随 `@nimbo/agent` 施工时补。

每个功能一个目录，目录里最多三份文档：`feature.md`（产品/使用手册）· `tech.md`（技术方案）· `plan.md`（施工进展）。

| 功能 | 一句话 | 文档 |
|---|---|---|
| **sandbox** | 云沙盒工作区：三家适配器与适配契约（E2B / Vercel / Cloudflare） | [功能](./sandbox/feature.md) · [技术](./sandbox/tech.md) · [施工](./sandbox/plan.md) |
| **sandbox-provider** | 沙盒 provider 可选：同一个应用里让用户自选 e2b / vercel | [功能](./sandbox-provider/feature.md) · [技术](./sandbox-provider/tech.md) · [施工](./sandbox-provider/plan.md) |
| **sandbox-keepalive** | 沙盒保活：一轮跑多久沙盒就活多久 | [功能](./sandbox-keepalive/feature.md) · [技术](./sandbox-keepalive/tech.md) · [施工](./sandbox-keepalive/plan.md) |
| **native-search** | `glob` / `grep` 走沙盒原生命令的快路径 | [施工](./native-search/plan.md) |
