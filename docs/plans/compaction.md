# 上下文压缩（compaction）· 施工进展

> 状态：设计待 review（2026-07-15）· 阶段：**计划中（未开工）**
> 相关：[产品视角](../features/compaction.md) · [技术方案](../tech/compaction.md)
> 依赖：[single-ledger](../plans/single-ledger.md)（P14 依赖 **P13-5** 落地——账本必须先是「UIMessage 单账本」）
> 回填目标（P14-4）：[plans/core-sdk](../plans/core-sdk.md) 变更记录 · [plans/verification](../plans/verification.md) 用例 · [tech/chat-webapp](../tech/chat-webapp.md) 存储相关表述 · [terms.md](../terms.md) §七

## 阶段状态

| 编号 | 内容 | 负责角色 | 状态 |
|---|---|---|---|
| P14-1 | server：条目 kind + 推导过滤 + 自动触发 + 摘要 fork + 手动端点 + openapi + 离线单测 1–4 | coder | 未开工 |
| P14-2 | web：kubb 重生成 + 分隔卡片 + `/compact` 命令 | coder | 未开工 |
| P14-3 | 测试补强：验证项 5–7 + 链式/竞态用例 | tester | 未开工 |
| P14-4 | 文档回填 | 主线程 | 未开工 |

**前置条件（gate）**：P14 依赖 P13-5（single-ledger）落地。P13-5 未完成前不开工——本方案的地基是「账本里存的就是 `NimboUIMessage`、模型上下文从账本现场推导」，没有单账本则整套推导过滤无从谈起。

## 拆单

1. **P14-1 server（coder）**：`compaction` 条目 kind（`agent_events.kind` 枚举扩到三值、`NimboMessageMetadata` 增补 `compaction`）+ 推导过滤（`routes/chat.ts` 的 `loadResumeState` 改造）+ 自动触发器（`turn-runner.ts` 的 `finalizeTurnPersistence` 收尾钩子）+ 摘要生成（fork 调用 + 结构化模板 + 失败降级）+ 手动端点（`POST /api/chat/sessions/:id/compact`，`isTurnActive` → 409 语义）+ `(session_id, upToSeq)` 唯一约束 + openapi 重生成；离线验证项 1–4 的单测。
2. **P14-2 web（coder）**：[kubb 重生成](../terms.md)；分隔卡片（可展开摘要，auto / manual 文案区分）；输入框 `/compact` 命令（可带 instructions）。
3. **P14-3 测试补强（tester）**：验证项 5–7（真机段沿 examples 凭证门控约定）+ 链式 / 竞态用例。
4. **P14-4 文档回填（主线程）**：plans/core-sdk 变更记录、plans/verification 用例、tech/chat-webapp 存储相关表述修订、terms.md §七校对。

## 验收项

| # | 名称 | 做法 | 通过标准 |
|---|---|---|---|
| 1 | 推导过滤（离线） | 构造含 compaction 条目的账本，断言推导结果 | 摘要在首；排除 ≤ upToSeq；保留尾巴与后续消息齐全；顺序正确 |
| 2 | 链式压缩（离线） | 账本含两条 compaction 条目 | 只认最新；旧条目不影响推导 |
| 3 | 转换合法性（离线） | 推导结果过 `convertToModelMessages` | 无异常、无 data 部件泄漏、工具配对完整 |
| 4 | 并发防重（离线） | 两次同 upToSeq 写入 | 唯一约束生效，只落一条 |
| 5 | 压缩后续聊（真机） | 压缩 → 新 turn 问「我们做到哪了」 | 模型答出摘要内的任务状态与文件路径 |
| 6 | 缓存行为（真机） | 观察 fork 调用与压缩后首轮的 cache 指标 | fork 命中旧前缀（`cachedInputTokens > 0`）；压缩后首轮冷、次轮回暖 |
| 7 | UI 回放（e2e） | 压缩后刷新页面 | 时间线完整；分隔卡片位置正确、摘要可展开、auto / manual 文案区分 |

**验收结论**：暂无（未开工）。

## 已知取舍（施工须知）

设计层面的取舍与理由见 [技术方案 · 已知限制](../tech/compaction.md#已知限制)，施工时需照单落地的约束：

- **低频大动作**：阈值设高（默认 0.75），两次压缩之间严格 append-only；**禁止「每轮小修小补上下文」**（会持续打碎前缀缓存）。
- **失败无害优先**：摘要 fork 失败 / 超时一律不写条目、记日志、下轮重试；摘要输出必须设 `maxOutputTokens` 预算。
- **切点落在 UIMessage 边界**：结构上保证 tool_call / tool_result 不被切断，实现时无需额外配对检查。
- **触发指令不进账本**：手动 / 自动触发都只落「结果条目」，不落「谁触发」的流水。
- **core 零改动**：v1 全部落在 server；core 内建压缩钩子列观察项，等第二个消费者出现再抽象。

## 变更记录

- **2026-07-15**：从旧编号文档 `docs/tech/compaction.md` 迁入 features / tech / plans 三视角结构。原文「产品设计」入 [features](../features/compaction.md)，「技术方案」（§2.1–2.7）入 [tech](../tech/compaction.md)，验证项（§2.8）与施工计划（§3）入本文。历史 banner「设计待 review（2026-07-15）」保留于本文顶部。
- **2026-07-15**：设计待 review。本方案兑现 [tech/core-sdk](../tech/core-sdk.md) §4.8「自动 compaction 列 v2」的规划；依赖 P13-5（single-ledger）落地。
