# 更新日志（Changelog）

本文件记录 nimbo 值得留痕的变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循 [语义化版本](https://semver.org/lang/zh-CN/)。当前尚未发版（`0.0.0`），所有条目归于 **未发布**。

术语以 [docs/terms.md](./docs/terms.md) 为准。括号内为对应 commit 短哈希。

### 新增（Added）

- **nimbo agent SDK + chat 应用**：可嵌入的轻量 agent 循环（文件操作 / 命令执行 / skills），几行代码即可在自己的服务里跑起来；配套一个聊天 Web 应用作为参考实现。(`e061e9d`)
- **软插话（soft steer）**：向进行中的一轮 agent 注入用户消息而不打断当前轮——core 支持 + 经直播流下发。(`31fdd1d`, `2b53d6b`)
- **人在回路审批**：bash 危险命令（`git push`、`rm -r/-f`、`git reset --hard`、改 GitHub 的 curl 等）弹审批卡片、停轮等真人；`ask-user` 提问工具。(`6c9b965`)
- **遥测（telemetry）+ 本轮统计弹窗**：每次模型调用 / 工具执行的过程指标（耗时、吞吐、token 用量、成败）落独立 SQLite；每条 assistant 回复末尾一枚「统计」按钮，点开弹窗看概览（耗时 / 工具 / agent / token 四分）与逐次模型调用（响应 / 首 token 耗时、输入输出吞吐、token 三分含推理、finishReason、模型）和逐个工具执行明细。(`1d1d8a0`)
- **会话级工具授权 `allow-session`**：审批卡片新增「会话内都允许」——批准一次后，本会话内**该用户**完全相同的调用（工具 + 入参指纹）后续直接放行、不再弹卡片；换个命令仍照常审批。持久化到 `conversation_grants` 子表（按会话 / 用户 / 具体调用记账，会话删除即级联清）。(`44fc8f0`)
- **审批卡片友好化**：标题由裸工具名改为人话（如「agent 想运行命令，先确认一下」，工具名降级为小号标签）；三按钮：允许 / 会话内都允许 / 拒绝。(`e368d88`)

### 变更（Changed）

- **单账本（single-ledger）重构**：聊天事件模型收敛为单一 UIMessage 账本，退役整套 wire 事件镜像；数据库表 / 列 `session → conversation` 专业化重命名（`chat_sessions → conversations`、`agent_events → conversation_events`，`nimbo_* → agent_session_*`）；工具 part 类型统一 kebab-case。(`77c3270`, `68de8fe`)
- **直播流分层**：流数据按 transient（只直播不落盘，如打字增量）/ persistent（落盘可回放）分档，不再持久化打字机逐帧，存储从平方级降到线性。(`660f4fd`)

### 修复（Fixed）

- **工具执行遥测事件从未落库**：server 的 SQLite 遥测集成漏挂 `onToolExecutionStart/End`，导致 core 补发的工具执行事件被静默丢弃（账本有工具耗时、遥测却零工具事件）；补上两个回调并加真跑工具的端到端回归护栏。(`1d1d8a0`)
- **消息列表短会话底部大片空白**：`use-stick-to-bottom` 滚动视口撑满、内容顶对齐导致最后一条与输入框间留白；改为锚底（最新消息贴输入框），内容溢出时不影响贴底滚动。(`3a81486`)
