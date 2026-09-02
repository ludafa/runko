---
title: "进行中草稿放内存 — 施工进展"
slug: in-flight-draft
view: 施工
layer: 逻辑层
module: 轮编排
packages: ["@runko/agent"]
tags: ["进行中草稿", "内存态", "账本写入时机", "崩溃恢复"]
related: ["logic/orchestration/tech/in-flight-draft.md", "architecture/tech/agent-kernel.md"]
---

# 进行中草稿放内存 — 施工进展

> 相关：[技术方案](../tech/in-flight-draft.md)。
> 上游：本功能是 [agent 内核包](../../../architecture/plans/agent-kernel.md) **K1 阶段**的前半——K1 = 进行中草稿放内存 **+** [起轮标记](../../../terms.md)，两者必须同批上线。
> 依赖/延续：[单一账本](../tech/single-ledger.md) §2.4／§6（改完要回头修订）。

## 状态

**✅ 已交付**（2026-08-16），随 [`@runko/agent`](./agent-runtime.md) 一并上线——草稿放进框架的
`ActiveTurn.draft`（内存数组），[账本](../../../terms.md)从此只写成品消息，[孤儿轮](../../../terms.md)
判据换成[起轮标记](../../../terms.md)（`conversations.turn_holder` 列）。

## 阶段拆单

对应技术方案 §9 那张表，这里是可执行版本。

| # | 干什么 | 动谁 | 状态 |
|---|---|---|---|
| 1 | 草稿改写内存；去掉删除逻辑与「本轮起始编号」 | 框架 | ✅ `runtime/registry.ts` 的 `ActiveTurn.draft` |
| **1b** | **起轮标记**：起轮写、收尾删；启动扫描改用它判[孤儿轮](../../../terms.md) | 框架 + 服务端 | ✅ `Arbitration` 接口 + `conversations.turn_holder` |
| 2 | 删掉删除函数；跑一次历史垃圾清理 | 服务端 | ✅ **就此定案不清理**（2026-08-22）。删除函数已删；历史遗留的 `kind='chunk'` 行**永久读时滤掉**。**顺带纠正一个数**：原先写的「几十万行」错了三个数量级——dev 库实测 425 条 chunk / 435 条 message、全表 860 行、库 2.2 MB，都是测试数据。真正的理由是：读时过滤是**永久兼容层**（任何没升级的旧库连上来都可能带遗留行），删不掉；既然它必须留着，再跑一次清理脚本的收益就只剩「库小 1 MB」 |
| 3 | SSE 补发草稿快照（注意方案 5.4 两个坑）；会话详情加「有没有在跑」 | 框架 + 服务端 | ✅ `runtime.subscribe` 的同步临界区 + DTO 的 `turnInProgress` |
| 4 | 接口改名 `events` → `messages`，返回体收窄 | 服务端 + 前端 | ✅ **已做**（2026-08-22 构建者拍板：「没发布过，名义对齐更重要」）。`GET .../messages` 与既有的 `POST .../messages` 配成一对；schema 更名为 `ConversationMessagesList`，`after` 游标 schema 因两个回放端点共用而改叫 `ConversationReplayQuerySchema`；openapi + kubb client 已重生成 |
| 5 | SSE 给成品消息帧补 `id` | 服务端 | ⬜ 没做（`MessageFrame.message.id` 本来就带着） |
| 6 | 网络数据形状去掉编号字段 | 服务端 + 前端 | 🟡 chunk 帧已不再带 `seq`；`MessageFrame.seq` **保留**（断线续传游标靠它） |
| 7 | 前端改用新字段；拼装消息的模块**不动** | 前端 | ✅ `lastFrameIsChunk` 猜测退役，改用 `conversation.turnInProgress` |
| 8 | 测试 | 框架 + 服务端 + 前端 | ✅ 61 + 395 + 278 个用例跑绿 |
| 9 | 术语表「孤儿轮」改识别特征 | 文档 | ✅ 已改 |

**顺序**：1 + 1b → 2/3/4/5/6 → 7 → 8 → 9。

> **1 和 1b 必须同批，中间不能有空窗。** 草稿一进内存，旧的孤儿轮判据（「事件行以 `kind='chunk'` 收尾」）就失效了；不补起轮标记的话，崩溃遗留的会话会**静默地**永远停在「正在干活」。推导见[技术方案 5.9](../tech/in-flight-draft.md)。

## 验收

| # | 用例 | 预期 |
|---|---|---|
| V1 | 干活中刷新页面 | 画面完整重建，跟不刷新时一致 |
| V2 | 干活中断网再连 | 从断点续上，不丢中间内容、不重复 |
| V3 | 一轮跑完后查库 | 库里**只有成品消息**，没有 `kind='chunk'` 行 |
| V4 | 干活中强杀进程，重启 | 那一轮被扫出来补「已停止」；会话不卡在「正在干活」 |
| V5 | 同一会话开两个标签页 | 两边内容一致 |
| V6 | 连续跑多轮 | 消息编号只被成品消息消耗，不出现草稿占号 |

**V4 是本次新增的护栏**——它正是 1b 存在的理由，1 单独上线时这条必然挂。

## 待登记的术语

- **起轮标记**——已登记，见 [docs/terms.md](../../../terms.md)。
- **孤儿轮**——词条的「识别特征」已改成起轮标记这条直接判据。

## 变更记录

| 时间 | 变更 |
|---|---|
| 2026-08-16 | 随 `@runko/agent` 一并交付。三项与原计划有偏差并已在上表标注：历史垃圾行改为读时过滤（第 2 项）、`events → messages` 改名没做（第 4 项）、`MessageFrame.seq` 保留（第 6 项——断线续传游标依赖它，去掉等于把续传也拆了） |
| 2026-08-15 | 建档。按 [issue #2](https://github.com/ludafa/runko/issues/2) 的分层重划文档时补齐——此前技术方案里链的施工进展文件一直不存在。同时按 issue #2 补上 1b（起轮标记）这项，原清单缺它。 |
