# core 层 —— 执行引擎

> 上级索引：[docs/README.zh-CN.md](../README.zh-CN.md) · 术语表：[terms.md](../terms.md)
> 分层依据：[agent 内核包 · 技术方案 §2](../agent/agent-kernel/tech.md#2-分层)

**这一层保证「推进」**：给定历史和工具，调模型 → 跑工具 → 喂回去，一直跑到模型说完。它不知道时间、进程、存储——那些是 [agent 层](../agent/README.md)与[宿主层](../host/README.md)的事。

**对应的包**：`@nimbo/core`（本体）· `@nimbo/virtual-fs` · `@nimbo/mini-bash` · `@nimbo/just-bash` · `@nimbo/sdk`（门面）。

每个功能一个目录，目录里最多三份文档：`feature.md`（产品/使用手册）· `tech.md`（技术方案）· `plan.md`（施工进展）。

| 功能 | 一句话 | 文档 |
|---|---|---|
| **core-sdk** | SDK 本体：L0 接口 / L1 定义层 / L2 运行层 / L3 目录约定层、loop 与 session | [功能](./core-sdk/feature.md) · [技术](./core-sdk/tech.md) · [施工](./core-sdk/plan.md) |
| **builtin-tools** | 内置工具面：文件八件套 + `bash` + `load-skill` + `update-plan` | [功能](./builtin-tools/feature.md) · [技术](./builtin-tools/tech.md) |
| **verification** | 端到端验收工程：逐条证明 core-sdk 的四条成功标准 | [施工](./verification/plan.md) |
