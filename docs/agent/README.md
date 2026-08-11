# agent 层 —— agent 逻辑层（轮编排 + 归属仲裁）

> 上级索引：[docs/README.zh-CN.md](../README.zh-CN.md) · 术语表：[terms.md](../terms.md)
> 分层依据：[agent 内核包 · 技术方案 §2](./agent-kernel/tech.md#2-分层)

**这一层保证两件事**：

- **连续**——一轮接一轮连成一段连贯的对话（起、中断、挂起、恢复、收尾；账本 / 裁决 / 待发队列的模型也在这里定义）。
- **独占**——同一时刻只有一个执行在跑（授予、回收、执法）。

**对应的包**：`@nimbo/agent`（**尚未实现**）。这些能力目前散在 `apps/node-server` 里，[agent-kernel](./agent-kernel/feature.md) 就是把它们上移进框架的总纲——所以本层多数文档写的是「chat 应用现在怎么做」，读时按「将来归 `@nimbo/agent`」理解。

每个功能一个目录，目录里最多三份文档：`feature.md`（产品/使用手册）· `tech.md`（技术方案）· `plan.md`（施工进展）。

| 功能 | 一句话 | 文档 |
|---|---|---|
| **agent-kernel** | 架构总纲：分层、四种可替换的宿主能力、六档部署形态、包怎么拆 | [功能](./agent-kernel/feature.md) · [技术](./agent-kernel/tech.md) · [施工](./agent-kernel/plan.md) |
| **single-ledger** | UIMessage 单账本：一份记录既喂模型也喂界面 | [功能](./single-ledger/feature.md) · [技术](./single-ledger/tech.md) · [施工](./single-ledger/plan.md) |
| **in-flight-draft** | 进行中草稿放内存，别写数据库 | [技术](./in-flight-draft/tech.md) |
| **steer-and-queue** | 中途插话与排队：agent 忙时来了新消息怎么办 | [功能](./steer-and-queue/feature.md) · [技术](./steer-and-queue/tech.md) · [施工](./steer-and-queue/plan.md) |
| **turn-abort** | 停止本轮：硬打断当前这一轮 | [功能](./turn-abort/feature.md) · [技术](./turn-abort/tech.md) · [施工](./turn-abort/plan.md) |
| **graceful-shutdown** | 优雅关闭与崩溃恢复：进程要走时把在跑的一轮如实收尾 | [功能](./graceful-shutdown/feature.md) · [技术](./graceful-shutdown/tech.md) · [施工](./graceful-shutdown/plan.md) |
| **turn-checkpoint** | 每轮代码快照：模型上下文与沙盒里的代码对齐 | [功能](./turn-checkpoint/feature.md) · [技术](./turn-checkpoint/tech.md) · [施工](./turn-checkpoint/plan.md) |
| **compaction** | 上下文压缩：长会话到达上限前自动收拢历史 | [功能](./compaction/feature.md) · [技术](./compaction/tech.md) · [施工](./compaction/plan.md) |
