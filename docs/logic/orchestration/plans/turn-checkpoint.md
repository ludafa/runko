---
title: "Turn Checkpoint 与沙盒保活（施工进展）"
slug: turn-checkpoint
view: 施工
layer: 逻辑层
module: 轮编排
packages: ["@nimbo/agent"]
tags: ["轮检查点", "代码快照", "沙盒生命周期"]
related: ["logic/orchestration/features/turn-checkpoint.md", "logic/orchestration/tech/turn-checkpoint.md", "architecture/tech/agent-kernel.md"]
---
# Turn Checkpoint 与沙盒保活（施工进展）

> 相关：[功能](../features/turn-checkpoint.md)，[技术方案](../tech/turn-checkpoint.md)。
> 依赖/延续：[chat 聊天 webapp](../../../ingress/features/chat-webapp.md)（§2.2d transcript 减量 P13-1 已交付）· [UIMessage 单账本](../features/single-ledger.md)（P13-5，checkpoint `lastSeq` 对齐[账本](../../../terms.md) `seq`）· [tech/sandbox](../../../host/contract/tech/sandbox.md)（BYO 原则与配方章节，施工时回填保活配方）· [core-sdk 施工计划](../../engine/plans/core-sdk.md) P13。

## 状态

**方案定稿待施工**（2026-07-14 随 P13 持久化分析逐项讨论定案）。

- 阶段：**计划中，尚未施工**。技术方案（接口、写入顺序、恢复阶梯）已定案，代码未落地。
- **排期：2026-08-22 定为往后延。** 它与 [K3 挂起与恢复](../../../architecture/plans/agent-kernel.md) 有因果关系——K3 会让「会话跨小时存活」变成常态，那时沙盒被平台回收的概率大增，没有代码快照就是真丢工作；而现在会话都是分钟级的，快照价值有限。合理顺序是 K3 → 本方案，紧挨着做。
- 拆单归属：P13-2 checkpoint、P13-2b 保活（同一 coder 连续施工）。
- 前置：P13-1（transcript 减量）已交付；P13-5（[UIMessage 单账本](../features/single-ledger.md)）落地后 `lastSeq` 对齐简化为直接取账本 `seq`。

## 施工拆单

### P13-2 checkpoint（coder → tester）

1. 新包 `packages/git-checkpoint`（snapshot/restore/read + 树短路 + 异步 push；fake exec 单测归 tester）；SDK 透传。
2. chat 接线：
   - turn-runner 收尾顺序改造（快照 → 模型上下文 → turn 结果，优雅失败同权，catch 分支 crash ref）。
   - `sandbox.recreated` wire 事件 + schema + 恢复阶梯 + 模型注入。
   - openapi / [kubb 重生成](../../../terms.md)。
   - web 时间线渲染 recreated 事件（简单系统条目）。
3. [tech/sandbox](../../../host/contract/tech/sandbox.md) 配方章节回填「turn 对齐 checkpoint」（回填时与用户确认）。

### P13-2b 保活（同一 coder 紧随其后）

- `ensureLifetime` 接缝 + touch 补足修正 + turn 心跳 + 单轮上限。

## 验收

- 双端 typecheck / lint / test 全绿。
- git-checkpoint 包纳入根管线（`packages/*` filter 本就覆盖）。
- 真机验收项：
  - 长 turn（>5 分钟）不死。
  - 快照 ref 在 origin 可见且 UI 不可见。
  - 删平台快照后重建走 wip 还原。
  - 恢复级别事件如实呈现。

## 明确不做

- 沙盒 FS 的 blob 级导出（与「隔离即边界、沙盒可丢弃」哲学冲突）。
- 从事件流重建模型上下文（双账本各司其职——注：P13-5 单账本落地后模型上下文已改为从账本现场推导，此条针对的是「不为快照另建一套从事件重放模型状态的机制」）。
- hooks 机制（宿主已拥有 turn 边界，见 2026-07-14 讨论定案——hooks 只在「需要 loop 内部挂起且宿主够不到」时才引入，先例是审批链）。

## 已知取舍（施工时保留）

1. 依赖 PAT 的 push 权限（已具备）；[快照引用](../../../terms.md)对仓库管理员 `ls-remote` 可见。宿主不接受向 origin 写 ref 时 `CHAT_CHECKPOINT_MODE=off` 回到现状。
2. crash ref 与 wip ref 的清理归留存治理（P13-4，会话删除时一并删 ref）——本期只写不删。
3. 未 push 的 commit **历史**不可恢复（内容可恢复）。
4. turn 中崩溃 + 沙盒存活时工作区可能领先模型上下文（沙盒里有崩溃轮残迹）——现状即如此，instructions 已引导 `git status` 自查；P13-3（中断哨兵）负责在 UI 显性化。

## 变更记录

- **2026-07-14**：随 P13 持久化分析逐项讨论，checkpoint（P13-2）+ 保活（P13-2b）方案定稿待施工。保活平台事实（Vercel timeout 为租期倒计时、`extendTimeout` 加时非重置）经 Vercel 官方文档核实。hooks 机制在本次讨论定案暂不引入。
- **P13-5（[UIMessage 单账本](../features/single-ledger.md)）落地后**：事件表与「模型记忆」合一为账本，`nimbo_state_json` 取消，[模型上下文](../../../terms.md)从账本 UIMessage 现场推导。checkpoint 的 `lastSeq` 对齐从「跨事件表 seq / `nimbo_state_json` 轮号两本账互校」简化为直接取账本 `seq`；核心不变量随之更简（模型上下文与代码快照仍在同一收尾边界写入）。
