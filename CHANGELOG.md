# 更新日志（Changelog）

本文件按变更**逐条**记录 nimbo 值得留痕的改动，**最新的在最上方**。每条一个二级标题块，格式为：

```
## (feature/xxx|fix/xxx|chore/xxx) 变更标题 (YYYY-MM-DD HH:MM) (author)

紧跟一段变更摘要，并引用相关的 features/tech/plans 规范文档。
```

术语以 [docs/terms.md](./docs/terms.md) 为准。当前尚未发版（`0.0.0`）。行尾括号内 hash 为对应 commit（历史条目回填，便于溯源）。

## (feature/examples) examples 实验田化 (2026-07-19 15:58) (ludafa)

`examples/` 收尾为一个打开即用的 pnpm workspace 子项目——源码迁入 `src/`、新增 `pnpm example <编号>` 便捷 runner、`typecheck` 随 `pnpm -r typecheck` 进 CI 质量门；退役手工符号链接脚本 `setup-node-modules.mjs`/`typecheck.mjs`（改由 `pnpm install` 自动搭依赖）；README 重写、`tsconfig`/`workspace` 注释统一。12 号正名为 demo（去 `.e2e.test.ts` 后缀）；唯一的 e2e 测试 13 号迁至 `@nimbo-chat/server`（离线结构断言进 CI，真机段留 git 历史）。见 [docs/app/examples/feature.md](./docs/app/examples/feature.md) · [docs/app/examples/tech.md](./docs/app/examples/tech.md) · [docs/app/examples/plan.md](./docs/app/examples/plan.md)。

## (feature/telemetry) 遥测 + 本轮统计弹窗 (2026-07-18 15:23) (ludafa)

每次模型调用 / 工具执行的过程指标（耗时、吞吐、token 用量、成败）落独立 SQLite；每条 assistant 回复末尾一枚「统计」按钮，点开弹窗看概览（耗时 / 工具 / agent / token 四分）与逐次模型调用（响应 / 首 token 耗时、输入输出吞吐、token 三分含推理、finishReason、模型）和逐个工具执行明细。见 [docs/app/telemetry/feature.md](./docs/app/telemetry/feature.md) · [docs/app/telemetry/tech.md](./docs/app/telemetry/tech.md) · [docs/app/chat-observability/plan.md](./docs/app/chat-observability/plan.md)。(`1d1d8a0`)

## (fix/telemetry) 工具执行遥测事件从未落库 (2026-07-18 15:23) (ludafa)

server 的 SQLite 遥测集成漏挂 `onToolExecutionStart/End`，导致 core 补发的工具执行事件被静默丢弃（账本有工具耗时、遥测却零工具事件）；补上两个回调并加真跑工具的端到端回归护栏。见 [docs/app/telemetry/tech.md](./docs/app/telemetry/tech.md)。(`1d1d8a0`)

## (feature/session-grant) 会话级工具授权 allow-session (2026-07-18 15:23) (ludafa)

审批卡片新增「会话内都允许」——批准一次后，本会话内**该用户**完全相同的调用（工具 + 入参指纹）后续直接放行、不再弹卡片；换个命令仍照常审批。持久化到 `conversation_grants` 子表（按会话 / 用户 / 具体调用记账，会话删除即级联清）。见 [docs/agent/single-ledger/feature.md](./docs/agent/single-ledger/feature.md) · [docs/agent/single-ledger/tech.md](./docs/agent/single-ledger/tech.md)。(`44fc8f0`)

## (feature/approval-card) 审批卡片友好化 (2026-07-18 15:23) (ludafa)

标题由裸工具名改为人话（如「agent 想运行命令，先确认一下」，工具名降级为小号标签）；三按钮：允许 / 会话内都允许 / 拒绝。见 [docs/agent/single-ledger/feature.md](./docs/agent/single-ledger/feature.md)。(`bd8e848`)

## (fix/message-list) 消息列表短会话底部大片空白 (2026-07-18 15:23) (ludafa)

`use-stick-to-bottom` 滚动视口撑满、内容顶对齐导致最后一条与输入框间留白；改为锚底（最新消息贴输入框），内容溢出时不影响贴底滚动。见 [docs/app/chat-webapp/tech.md](./docs/app/chat-webapp/tech.md)。(`3a81486`)

## (feature/single-ledger) 单账本重构 + session→conversation 重命名 (2026-07-18 15:22) (ludafa)

聊天事件模型收敛为单一 UIMessage 账本，退役整套 wire 事件镜像；数据库表 / 列 `session → conversation` 专业化重命名（`chat_sessions → conversations`、`agent_events → conversation_events`，`nimbo_* → agent_session_*`）；工具 part 类型统一 kebab-case。见 [docs/agent/single-ledger/feature.md](./docs/agent/single-ledger/feature.md) · [docs/agent/single-ledger/tech.md](./docs/agent/single-ledger/tech.md) · [docs/agent/single-ledger/plan.md](./docs/agent/single-ledger/plan.md)。(`77c3270`, `68de8fe`)

## (feature/stream-split) 直播流 transient/persistent 分层 (2026-07-14 12:32) (ludafa)

流数据按 transient（只直播不落盘，如打字增量）/ persistent（落盘可回放）分档，不再持久化打字机逐帧，存储从平方级降到线性。见 [docs/agent/single-ledger/tech.md](./docs/agent/single-ledger/tech.md)。(`660f4fd`)

## (feature/approval) 人在回路审批 + ask-user 工具 (2026-07-14 10:44) (ludafa)

bash 危险命令（`git push`、`rm -r/-f`、`git reset --hard`、改 GitHub 的 curl 等）弹审批卡片、停轮等真人；`ask-user` 提问工具。见 [docs/agent/single-ledger/feature.md](./docs/agent/single-ledger/feature.md)。(`6c9b965`)

## (feature/soft-steer) 软插话 soft steer (2026-07-13 18:06) (ludafa)

向进行中的一轮 agent 注入用户消息而不打断当前轮——core 支持 + 经直播流下发。见 [docs/app/chat-webapp/feature.md](./docs/app/chat-webapp/feature.md)。(`31fdd1d`, `2b53d6b`)

## (feature/nimbo-sdk) nimbo agent SDK + chat 应用 (2026-07-12 22:13) (ludafa)

可嵌入的轻量 agent 循环（文件操作 / 命令执行 / skills），几行代码即可在自己的服务里跑起来；配套一个聊天 Web 应用作为参考实现。见 [docs/core/core-sdk/feature.md](./docs/core/core-sdk/feature.md) · [docs/app/chat-webapp/feature.md](./docs/app/chat-webapp/feature.md)。(`e061e9d`)
