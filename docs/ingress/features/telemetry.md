---
title: "遥测（Telemetry）— 产品视角 · 使用手册"
slug: telemetry
view: 功能
layer: 接入层
module: —
packages: ["@nimbo/core", "@nimbo-chat/node-server"]
tags: ["遥测", "观测", "token 统计", "耗时"]
related: ["ingress/tech/telemetry.md", "architecture/tech/agent-kernel.md"]
---
# 遥测（Telemetry）— 产品视角 · 使用手册

> 相关：[技术方案](../tech/telemetry.md) · [施工进展](../plans/chat-observability.md)（遥测属「chat 可观测性」拆单）
> 依赖：[chat-webapp](./chat-webapp.md)（统计弹窗与查询端点长在 chat 应用上）· [core-sdk](../../logic/engine/features/core-sdk.md)（`SessionTelemetry` 注入口在 SDK 层）
> 术语：[遥测（telemetry）](../../terms.md)，本文一律使用术语表主术语。

## 一句话

回答「这一轮到底慢在哪、贵在哪」：nimbo 把每次模型调用、每次工具执行的过程指标（耗时、吞吐、token 用量、成败）按轮落到本地 SQLite，随取随查——账本里的聚合值告诉你结果，遥测告诉你过程。

## 解决什么问题

chat 的账本数据（[single-ledger](../../logic/orchestration/features/single-ledger.md)）已经提供轮级聚合：统计弹窗概览里的总耗时、工具/agent 拆分、token 总量，以及每张工具卡片的起止时间。但它们回答不了这些问题：

- 这一轮跑了 4 步，**哪一步的模型往返最慢**？是首 token 等太久，还是输出吞吐低？
- 同样的 prompt 昨天 3 秒今天 12 秒，**是模型服务变慢了还是工具变慢了**？
- 一次失败的工具执行**实际跑了多久才失败**？
- 发完消息盯着空白等了 8 秒才看见第一个字，**这 8 秒花在哪**？是沙盒又重建了一次，还是模型首 token 慢？

这些是过程级观测数据——粒度细、体量大、价值随时间衰减，不适合塞进永久账本，于是单独走遥测通道。

## 我们怎么提供

**默认开启、零配置。** chat server 启动即采集，数据落在 `apps/node-server/telemetry.db`（与聊天数据库 `data.db` 相互独立）。两个环境变量：`TELEMETRY_DISABLED=1` 整体关闭；`TELEMETRY_DB_PATH` 改存放位置。

三个消费入口，按使用频率排序：

1. **统计按钮 → 本轮统计弹窗（最常用）**：每条 assistant 回复末尾有一枚「统计」按钮（界面上不再有常驻汇总条），点开弹出「本轮统计」弹窗，一轮的全部指标都在里面，分两层：
   - **概览**（账本聚合，永远在）：耗时、工具/agent 拆分、usage 四分（输入/缓存命中/输出/共计）。
   - **明细**（遥测按需拉取）：**本轮准备**——发出消息后到看见第一个字之间那段等待的分解（起轮装配总时长、沙盒是缓存命中/恢复/重建、续期、建会话、读账本，以及到首个 chunk、到首个可见输出各花了多久）；逐次模型调用的响应耗时、**首 token 耗时**、输入/输出吞吐（tok/s）、**token 三分（输入含缓存、输出含推理、共计）**、finishReason、模型名；逐个工具执行的耗时与失败标记。
   首次打开才拉取明细，遥测关闭时明细区显示「无遥测数据」，概览不受影响。
2. **HTTP API**：`GET /api/chat/conversations/{id}/turns/{turn}/telemetry`（需登录，只能查自己的会话）——面板同款数据源，供脚本/二次开发用。
3. **直接查库**：`sqlite3 telemetry.db "SELECT * FROM telemetry_events WHERE agent_session_id = ? AND turn = ?"`——运维排障的兜底入口，表结构见[技术方案](../tech/telemetry.md)。

## 提供哪些观测数据

每轮（[turn](../../terms.md)）产出一串生命周期事件，按发生顺序落库：

| 事件 | 何时发生 | 关键字段 |
|---|---|---|
| `start` / `end` | 一次模型操作（`streamText`）的边界 | 操作级 usage 汇总 |
| `step-start` / `step-end` | 每个 step（一次 LLM 调用 + 其工具结算）的边界 | 步号、finishReason |
| `model-call-start` / `model-call-end` | 每次模型调用的边界 | **`performance.responseTimeMs`（响应耗时）、首 token 前后的输入/输出吞吐（tok/s）、usage、finishReason、responseId** |
| `tool-execution-start` / `tool-execution-end` | 每次工具真实执行的边界（由 nimbo loop 补发，见技术方案） | **工具名、`toolExecutionMs`（执行耗时）、成功/失败判别** |
| `abort` / `error` | 流式中止 / 不可恢复错误 | 错误摘要 |
| `turn-prepare` | 这一轮第一个 chunk 抵达时（补记[起轮装配](../../terms.md)这段） | **起轮装配总时长、沙盒获取耗时与走的哪条路（缓存命中/恢复/重建）、续期、读账本、建会话，以及起轮到首个 chunk 的耗时** |
| `turn-first-output` | 这一轮第一个可见输出（文字/推理/工具调用）抵达时 | **起轮到首个可见输出的耗时**（减去上一行的首 chunk 耗时即模型首 token 等待） |

两条口径约定，与账本侧一致：

- **从未执行的调用没有工具事件**（被审批拒绝、未知工具、畸形参数）——和工具卡片显示「未执行」同语义。
- **只有「起新一轮」才有起轮装配事件**：[插话](../../terms.md)与[排队](../../terms.md)进的是已经跑着的那一轮，不做装配，自然也没有这两条；装配途中就失败的轮（沙盒挂了）产不出任何 chunk，也不会有——那种失败看错误提示与服务端日志。
- **prompt / 模型输出正文默认不落盘**：事件里的大块正文被替换为体量摘要（`[omitted: N chars]`），单条事件载荷封顶 16KB。遥测回答「多快/多贵」，不做对话内容的第二份存档。

## 与账本数据的分工

| | 账本（`data.db`，产品数据） | 遥测（`telemetry.db`，过程数据） |
|---|---|---|
| 承载 | 工具卡片计时、统计弹窗概览值（总耗时/工具/agent/usage） | 统计弹窗明细、逐调用指标 |
| 寿命 | 与会话同寿命，回放永远可用 | 耗材：可清空、可关闭，无持久承诺 |
| 依赖方向 | 不依赖遥测——**遥测整体关闭，产品功能零损失** | 单向消费账本的关联键 |

## 范围与非目标

- **不做**跨会话聚合报表、趋势分析、告警——数据就是 SQLite，需要时自己写 SQL（这正是选 SQLite 的原因）。
- **不做**长期保留承诺与自动清理策略（当前不会自动删，但随时可以手动清，见[技术方案](../tech/telemetry.md)有效期一节）。
- **不做**对话正文的采集（见上）。

## 成功标准

- 任何一轮结束后，点开统计弹窗能在一秒内看到「模型往返 vs 工具执行」各自的耗时明细，足以定位「慢在哪」。
- `TELEMETRY_DISABLED=1` 之后，chat 的全部产品功能（含统计弹窗概览值、工具卡片计时）行为不变。
- 删除 `telemetry.db` 文件等价于清空遥测，服务下次启动自动重建，无迁移、无报错。
