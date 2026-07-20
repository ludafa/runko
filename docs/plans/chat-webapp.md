# Chat Webapp（施工进展）

> 相关：[产品视角](../features/chat-webapp.md) · [技术方案](../tech/chat-webapp.md)
> 依赖：[core-sdk](../features/core-sdk.md) · [sandbox](../features/sandbox.md)
> 被增强：[turn-checkpoint](../features/turn-checkpoint.md) · [single-ledger](../features/single-ledger.md) · [compaction](../features/compaction.md)

> **立项 banner**：已立项开工——2026-07-12 用户 `/goal` 直接立项。
> 原型来源：[sandbox 端到端示例](../features/sandbox.md)（沙盒 E2E 示例 = 本应用的核心能力原型）。
> Seed：https://github.com/ludafa/hono-mono-starter

## 阶段总览

| 拆单 | 内容 | 状态 |
|---|---|---|
| P12-0 脚手架 | 并入根 workspace、包名、脚本 filter、bootstrap 可跑 | ✅ 已完成 |
| P12-1 服务端 | 服务端全部模块 + 单测 | ✅ 已完成 |
| P12-2 前端 | chat 页 + 时间线 + SSE hook | ✅ 已完成 |
| P12-3 集成真机验收 | register→PR 全链路 + 休眠/唤醒验证 | ✅ 通过（详见下） |
| P12-4 断线可续重构 | turn 执行/连接解耦 + 可续传 tail | ✅ 已交付 |
| P12-5 人在环上 | bash 审批链 + ask-user + 裁决路由 | ✅ 已交付 |
| P13-1 transcript 减量 | durable/ephemeral 分层 | ✅ 已交付 |
| P13-5 单一数据账本 | UIMessage 为唯一真相 | ✅ 已落地（P13-5-1..6） |
| P13-2 / P13-2b | turn checkpoint / 沙盒保活 | ⏸ 顺延（方案见 docs/09） |
| P13-3 中断哨兵 / P13-4 留存治理 | — | 🕓 待讨论 |

## 拆单明细（P12）

- **P12-0 脚手架（主线程）**：seed 拷入 apps/（client→web 更名、去 docs/.claude/.git）、包名改 `@nimbo-chat/*`、根 workspace 并入 + 根脚本 filter 收窄、overrides/allowBuilds 合入、`pnpm install` + seed 基线可跑（bootstrap：db migrate + openapi + kubb 生成）。
- **P12-1 服务端（coder）**：技术方案 §4 全部模块 + 单测（sandbox-manager 的 acquire/touch 状态机用 fake Sandbox；store 用例；SSE 路由集成测试用 mock model 走通事件落库+推流）。
- **P12-2 前端（coder，依赖 P12-0，与 P12-1 并行）**：chat 页 + 时间线组件 + SSE hook；对 API 契约编码，用 msw/fixture 事件流开发。
- **P12-3 集成真机验收（主线程/orchestrator）**：register→login→建会话（真沙盒）→发「列仓库文件」类只读消息（不产生 PR）验流式+落库→静置触发休眠→再发消息验恢复（分支还原）→（可选）一条设计任务消息走完 PR。回填 docs/05；沙盒回收审计。
- **P12-5 人在环上（2026-07-13 用户立项，拆单）**：技术方案 §6 全部——工单 A/A2 服务端（coder：审批桥 + ask-user + 裁决路由 + openapi）、工单 B 前端（coder：kubb 重生成 + 事件折叠 + approval/question 卡片）、工单 C 测试（tester：approval-policy 纯函数单测、turn-runner 桥用例、路由集成、web hook 三态折叠）。

## P13 持久化系列（2026-07-14 起，逐项确认制）

- **P13-1 transcript 减量**（durable/ephemeral 分层，✅ 已交付）。
- **P13-5 单一数据账本**被定为**最高优先级**：UIMessage 为唯一真相，验证实验方案见 [single-ledger](../features/single-ledger.md)，通过后 core 迁移正式立项——**已落地**（P13-5-1..6，见 [plans/single-ledger](../plans/single-ledger.md) 与 [tech/single-ledger](../tech/single-ledger.md)）。
- **P13-2 turn checkpoint 与 P13-2b 沙盒保活顺延**（方案见 [turn-checkpoint](../features/turn-checkpoint.md)，若单账本落地其对齐语义将简化）。
- **P13-3 中断哨兵、P13-4 留存治理**待讨论。

## 验收结论

### P12-3 真机验收（✅ 通过）

按上述链路走通：register → login → 建会话（真沙盒起、分支建、skill 装）→ 只读消息验**流式 + 落库** → 静置触发**休眠** → 再发消息验**唤醒 + 分支代码原样还原** →（可选）设计任务走完**开 PR**。回填 docs/05；沙盒回收审计。

**验收中暴露并修掉的问题**：
- `status` 的 `sleeping` 会存成 stale——改为**读时派生**（`toChatSessionDto`：存 `active` 但空闲窗口已过则呈现 `sleeping`，下条消息 `acquire`+`touch` 翻回）。休眠发生在 Vercel 侧、无服务端定时器，故不能靠存字段。
- 刷新/HMR 后进行中 turn 不再更新——催生 **P12-4 断线可续重构**（turn 执行/连接解耦 + 可续传 tail）。

## 变更记录

- **2026-07-20 `apps/server` → `apps/node-server`（✅）**：包名同步 `@nimbo-chat/server` → `@nimbo-chat/node-server`。动机是与新落地的 [`apps/cloudflare-worker-server`](../tech/cloudflare-worker-server.md) 形成对称命名——「server」这个名字在有了第二个服务端形态之后就不再自明了（一个跑 Node，一个跑 workerd）。改动是纯重命名：目录 `git mv`、包名、根 `package.json` 的 `chat:bootstrap`/`chat:server` 脚本 filter、`apps/web/kubb.config.ts` 的 `../server/openapi.yml` 路径，以及全库注释/文档里的路径引用。**已发布的 `CHANGELOG.md` 历史条目按仓库惯例保留旧名如实记录**（同 2026-07-17 表/列更名那次的处理）。验证：node-server typecheck exit 0、243 用例全绿；web 160 用例全绿。
- **2026-07-20 页面滚动模型重构：消灭双滚动条与底部大片空白（✅）**：症状是会话页出现两条滚动条、且最后一条消息之后还能滚出大片空白（此前修过一次未根治）。真机 devtools 量出**两个独立成因**：（1）外壳 `min-h-screen` + sticky header + 会话页 `h-[calc(100vh-8rem)]` 三者相加比视口高 **45px**，文档自己也成了滚动容器——「双滚动条」的其中一条；（2）消息里 TurnStatsButton 的 `sr-only`「统计」是 `position:absolute`，而库的滚动容器不是定位元素，其包含块落到外层那个 `relative overflow-y-auto` 壳上，**既不随滚动也不被裁剪**，把外层 `scrollHeight` 撑出 **1797px** 纯空白——这才是「大片空白」和贴着消息列表的第二条滚动条。修法：外壳改「一屏高 flex 列 + `main` 为唯一页面级滚动容器」，会话页改 `flex-1 min-h-0` 拿高度、删掉 `100vh-8rem` 魔数；消息列表外壳去掉冗余 `overflow-y-auto` 改 `min-h-0`，内层滚动容器加 `relative`（收编逃逸的绝对定位后代）+ `overscroll-contain`。中途踩到并修掉一个自造回归：内容包裹层若用 `flex-1`，普通页面（Notes）会被压扁而非滚动，改用 `min-h-full` 才同时满足「普通页面能滚」和「聊天页恰好一屏」。**验证**：6 档视口（1280×900/1440×780/1024×640/768×900/390×780/1280×480）下 document 与 main 的可滚动量均为 0、全页仅消息列表一个滚动容器、末条消息下方空白 2–3px（即 `p-1`）；另验短会话贴底、滚到顶首条可达、41 条会话侧栏内部滚动、真实流式过程中持续保持单滚动容器、resize 后重新贴底、Notes 页内容超屏由 main 正常滚动。web 160 用例全绿。方案见 [技术方案 §8.1](../tech/chat-webapp.md)。
- **2026-07-12 立项**：用户 `/goal` 直接立项 chat agent webapp（apps/web + apps/node-server）。
- **2026-07-12 配置整合**：全部配置（原 `examples/.env` + `apps/node-server/.env` + 端口/URL）统一收进**仓库根 `.env`**，唯一事实来源，`.env.template` 全量列出。apps/node-server 经 dev 脚本 `--env-file-if-exists=../../.env` 读取；apps/web(vite) 与 examples 同读。不再有 `examples/.env` 或 `apps/node-server/.env`。
- **P12-2 契约细化（两端定案）**：`agent_events` 落「信封事件」而非仅 `SessionEvent`（补 `user.message`/`turn.result` 使回放能重建完整对话）；JSON 一律 camelCase；`GET events` 返回 `{ events }`（非裸数组）；引入 STEER-3B（`POST messages` 先试 steer，202 body 带 `mode`）。
- **P12-4 断线可续**：turn registry（`turn-runner.ts`）+ 后台驱动 + `GET .../stream?after=<seq>` 可续传 tail；`GET events` 一次性补齐路径删除（被 tail 取代）；客户端改「命令/订阅分离」，挂载即开 tail。
- **P12-5 人在环上（2026-07-13 立项）**：bash 审批链（`gateWorkspace` + `approval-policy.ts`）+ ask-user 工具 + 裁决路由 + wire 契约。
- **P13-1（✅）**：`item.updated` 走 ephemeral（只广播不落库不占 seq），存储从平方级降到线性。
- **P13-5（✅ 已落地，2026-07-15 定案项）**：UIMessage 单账本取代整套 wire 事件模型——`agent_events` 改 `kind`(message/chunk) + `nimbo` 标量 header 取代 `nimbo_state_json`；审批改走 ai 原生 `tool-approval-request`/`tool-approval-response` chunk + `onReview` 人审通道 + `tool-ask-user` 部件；人工裁决收敛为纯两值（「改参数」口子 2026-07-15 删除）；工具名一律 kebab-case。历史 wire 模型详见[技术方案 附录 A](../tech/chat-webapp.md)。
- **2026-07-17 表/列专业化更名（✅）**：`chat_sessions` → `conversations`、`agent_events` → `conversation_events`（子表按父实体命名；解开 "session" 三重超载——better-auth 登录态 / 对话线程 / SDK agent 会话，terms.md 主术语同步迁为「conversation（会话/对话）」）；`nimbo_*` 列 → `agent_session_*`、`telemetry_events.session_id` → `agent_session_id`（**库表命名不带产品名，产品更名不迁库**）；删除 `agent_events.type` 冗余列（payload 判别镜像、无代码读取）。迁移 `drizzle/0004_rename_conversations.sql`（SQLite RENAME 原地保数据）；API 路径 `/api/chat/sessions*` → `/api/chat/conversations*`，kubb 客户端与 openapi 重生成；代码标识符全链同步（server/web，含 TanStack 路由 `$conversationId`）。历史文档段落保留旧名如实记录。
- **2026-07-18 会话级授权 `allow-session`（✅）**：审批卡片加第三个按钮「会话内都允许」——用户批准一次后，本会话内**完全相同的调用**（同工具 + 入参指纹）不再弹卡片。全部落 chat 层、core 不动（分类器是回调、够不着 core 的 `review-once` once 记忆）：新增 `session-grants.ts`（按 (会话, 工具, 入参指纹) 记内存、稳定序列化保键序无关、进程重启即失效）；`onApproval` 分类前先查 `hasSessionGrant` 命中即 `allow`；wire `behavior` 加 `allow-session`，`resolveReview` 拿 `pendingReviews` 项里的 `toolName`/`input` 记账。刻意**按具体调用**而非按工具名——授权 `rm -rf build` 不放行别的危险 bash。测试：server `session-grants` 单测 + routes 端到端（allow-session 后第二轮相同命令无 tool-approval-request）；web 卡片第三按钮。server 217 / web 160 全绿。terms.md「会话级授权」词条、tech/features chat-webapp §6/审批段同步。
- **2026-07-18 会话级授权改持久化 + 记授权用户（✅）**：把授权从「内存耗材」改为**存 DB**——新增 `conversation_grants` 子表（PK `(conversation_id, user_id, grant_key)`，FK→conversations `ON DELETE CASCADE`，迁移 `drizzle/0005`）；`session-grants.ts` 从模块级内存 Map 改为薄 DB 访问（`grant`=INSERT OR IGNORE / `has`=SELECT / `clear`=DELETE，`onApproval` 每 gate 调用查一条带 PK 的 SELECT，本地 SQLite sub-ms）。**动机**：会话/工作区（快照+分支）本就跨重启持久，授权唯独易失、重启后重新询问只是摩擦；且粒度已窄到「精确命令+单会话」，持久化不显著扩大安全面。顺带化解了上一版「内存表无界增长」（现在是随会话增长的持久数据、会话删除即级联清，与 `conversation_events` 同）。**记 `user_id`（审批人）+ 按本轮发起者查**：为将来一个 conversation 多用户时「每人管自己的授权」铺数据（多用户卡片可见性/可点性属未来渲染层，不动此表）。测试：`session-grants` 单测改用真测试库 + seed，新增「按用户隔离」用例；server 219 全绿。terms.md 词条、tech chat-webapp §6 同步。

1. **v1 内存态 runner**：进程重启丢失内存态 turn 与内存态 pending 审批/提问（沙盒仍在跑但 nimbo loop 停）——DB 事件保留至崩溃点，重连回放发现无进行中轮即静默收尾；web 端「已失效」兜底。这是 v1 明示取舍，不在本期修。
2. **恢复兜底最后一档丢未提交工作**：快照过期且分支从未 push → 重建空分支，未提交工作丢失（UI 如实提示）。turn-checkpoint（P13-2）拟补掉。
3. **崩溃残渣不清理**：崩溃中断的一轮其 `kind = 'chunk'` 行不被 GC（`finalizeTurnPersistence` 没跑），被接受为残渣。
4. **P13-1 不做抽稀持久**：turn 中途崩溃后半截打字机不可回放——收益仅限崩溃窗口回放美观，不值多一套机制（P13-3 中断哨兵会把这状态显性化）。
