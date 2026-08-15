---
title: "Chat Webapp（产品视角 · 使用手册）"
slug: chat-webapp
view: 功能
layer: 接入层
module: —
packages: ["@nimbo-chat/node-server", "@nimbo-chat/web"]
tags: ["chat 应用", "SSE", "会话", "示例应用"]
related: ["ingress/plans/chat-webapp.md", "ingress/tech/chat-webapp.md", "architecture/tech/agent-kernel.md"]
---
# Chat Webapp（产品视角 · 使用手册）

> 相关：[技术方案](../tech/chat-webapp.md) · [施工进展](../plans/chat-webapp.md)
> 依赖：[core-sdk](../../logic/engine/features/core-sdk.md)（nimbo agent SDK，驱动对话的 [agent](../../terms.md)/[loop](../../terms.md)/[turn](../../terms.md)）· [sandbox](../../host/contract/features/sandbox.md)（Vercel 沙盒，代码真身所在）
> 被增强：[turn-checkpoint](../../logic/orchestration/features/turn-checkpoint.md)（每轮代码快照保活）· [single-ledger](../../logic/orchestration/features/single-ledger.md)（UIMessage 单账本，P13-5 已落地）· [compaction](../../logic/engine/features/compaction.md)（长会话上下文压缩）· [chat-ui](./chat-ui.md)（chat 页面的界面语言，2026-07-25 改版）

> **界面呈现细节看 [chat-ui](./chat-ui.md)**：本文讲这个应用**做什么**（端点、生命周期、人在回路的行为语义），chat-ui 讲它**长什么样**（[轨道](../../terms.md)、[打断](../../terms.md)、[信号色](../../terms.md)、[指令块](../../terms.md)）。下文出现的界面描述若与 chat-ui 冲突，以 chat-ui 为准。

## 一句话

一个 chat agent 网页应用：用户在对话里驱动 nimbo [agent](../../terms.md) 在 Vercel [沙盒](../../terms.md)中修改真实仓库代码、开 PR、触发 Vercel 部署。它把 [sandbox 端到端示例](../../host/contract/features/sandbox.md) 的「沙盒里跑完整设计任务」示例产品化成一个可注册、可登录、可持续多轮对话的 Web 应用（apps/web + apps/node-server）。

Seed 骨架：https://github.com/ludafa/hono-mono-starter （Hono + zod-openapi + better-auth + drizzle/better-sqlite3；React + TanStack Router + shadcn + kubb）。

## 这个功能给谁、解决什么问题

- **给谁**：需要让 AI 在一个真实 GitHub 仓库上迭代（改设计、改代码、开 PR、看预览部署）的开发者/用户。
- **解决什么**：把「一次性跑一个 agent 脚本」升级成「一个能持续对话、能刷新重连、能休眠再唤醒、代码改动跨轮累积」的产品。用户不用管沙盒生命周期、不用担心刷新丢进度、不用等一轮跑完才能追加指令。

## 用户可见行为与交互

1. **注册 / 登录**：seed 自带 better-auth。登录后进入 chat 界面。
2. **新建会话即绑定一个沙盒**：新建 [session（会话）](../../terms.md)时，服务端为它开一个 Vercel [沙盒](../../terms.md)——clone 配置好的 `GITHUB_REPO`、装好 `frontend-design` [skill](../../terms.md)、建一条会话专属分支。此后这个会话固定在这条分支上工作，多轮改动在同一分支上累积。
3. **每条消息驱动一轮 agent loop，实时流式渲染**：用户每发一条消息触发 agent 的一次完整 [turn（轮）](../../terms.md)。这一轮内部的过程（工具调用状态流转、文件改动、文本打字机、推理折叠）通过 [直播流](../../terms.md)边跑边推到页面——就是 07 示例时间线的 React 版。每个工具调用卡片上还标注它的启动时间、完成时间与耗时（**真实执行口径**：启动时间是真正开始执行的时刻，耗时不含排队与审批等待）：调用还在排队/等审批时徽标显示「等待中」并逐秒跳动已等待时长，开始执行后从零起跳执行耗时，结算后定格；被拒绝的调用因从未执行而显示「未执行」。同一步发出的一批工具调用**全部只读**（读文件/列目录/glob/grep）时并行执行，混有写操作则按顺序执行。每条 assistant 回复末尾有一枚「统计」按钮，点开「本轮统计」弹窗——概览里领头显示**本轮总耗时**，并拆分**工具总耗时 / agent 总耗时**（工具 = 本轮所有工具执行时段的并集，agent = 其余的模型思考/往返时间；纯文本轮不显示拆分），token 数字带千分位分组（如 `耗时 1m 23s · 工具 33.0s · agent 50.0s · 输入 149,326 · …`）。弹窗下半区是[遥测](../../terms.md)明细：逐次模型调用的响应/首 token 耗时、输入输出吞吐（tok/s）、token 三分（输入含缓存、输出含推理、共计）、finishReason、模型名，以及逐个工具执行的耗时与失败标记——遥测未开启时明细区显示「无遥测数据」，概览不受影响（遥测的完整产品说明见 [features/telemetry](./telemetry.md)）。
4. **[排队](../../terms.md)与[中途插话](../../terms.md)**：一轮还在跑时用户又发一条消息，有两条路——默认**排队**（存进会话的待发队列，本轮收尾后自动作为下一轮发出，可查看/删除/清空），显式（Alt+Enter 或插话按钮）**steer 插话**（注入当前这一轮，在下一个 step checkpoint 真实注入点生效）。完整说明见 [features/steer-and-queue](../../logic/orchestration/features/steer-and-queue.md)。
5. **人在回路（[human-in-the-loop](../../terms.md)）**：
   - 当 agent 要跑危险命令（`git push`、调 GitHub API、`rm -r/-f`、`git reset --hard`、`git clean -f` 等外发/破坏性动作）时，界面弹出**[审批卡片](../../terms.md)**，停下这一轮，等用户裁决再继续。三个按钮：**允许**（只放行本次）/ **会话内都允许**（放行本次，并记住这次**具体调用**——本会话内完全相同的命令后续直接放行、不再打扰；换个命令仍会再问，所以授权某条 `rm -rf` 不会连带放行别的危险命令）/ **拒绝**（可带理由）。「会话内都允许」是当次会话内的信任，重启即失效。安全的只读命令本就自动放行、不打扰。
   - 当 agent 需要用户拍板或澄清需求时，用 [ask-user](../../terms.md) 工具直接在时间线里提问（可带快捷选项），用户作答后这一轮继续；用户可以点选项，也可以自由文本回答。
   - **一直不理会怎样**：审批卡片等满 4 分钟（可配）会**自动按「拒绝」处理**——只是那一次命令不执行，agent 会接着往下做（比如换个做法或告诉你它做不下去）。**这一轮不会因此被中止。** 提问卡片同理：超时后 agent 收到一句「用户没回应」的固定提示，自己继续。
   - **卡片什么时候变「已失效」**：这一轮一旦结束（跑完、你按了停止、服务重启中断），还挂着的卡片立刻显示成**已失效**并收起按钮——那时服务端已经不再等任何裁决了，点了也没用。此前要点下去才知道失效，现在界面直接说明白。
6. **发出去就立刻有反馈**：你那条消息在按下回车的**同一帧**就出现在对话流里，紧接着 AI 侧出现一格「**正在准备…**」。这段时间服务端在取沙盒、装配这一轮（沙盒是冷的时候可能要几秒到几十秒），agent 还没开始跑——所以这里刻意不写「思考中」，那是假的。等这一轮真正出第一个动作，这格占位就被真的内容顶替。排队的消息轮到它自动发出时，也是同样的占位。
7. **持久化：刷新 / 重连可回放，进程重启可恢复**：会话与全部账本数据落 SQLite。刷新页面、HMR、网络抖动都不会丢进行中这一轮的后续输出——重连后先 [回放](../../terms.md)历史、再续接直播（断线可续，见「成功标准」）。
8. **沙盒生命周期对用户透明**：
   - 会话活跃期间沙盒保持激活（每条消息滚动续期）。
   - 不活跃达到阈值后沙盒**[休眠](../../terms.md)**（Vercel persistent 沙盒自动停机存[平台快照](../../terms.md)），用户无需操作。
   - 用户回来继续对话时自动**[唤醒](../../terms.md)**——**分支代码原样还原**（含未提交改动，从快照恢复）。会话状态徽标显示 active / sleeping，唤醒时 UI 提示「沙盒恢复中…」。

## 对外 API（产品视角）

服务端是 `@hono/zod-openapi` 定义的 REST + SSE 接口，**全部要求登录态**（同一套 `requireAuth`）。契约细节见[技术方案](../tech/chat-webapp.md)，这里只讲每个端点「给用户/前端解决什么」：

| 端点 | 作用 |
|---|---|
| `POST /api/chat/sessions` | 新建会话：开沙盒 + 建分支 + 装 skill，返回会话详情（201）。 |
| `GET /api/chat/sessions` | 列出当前用户的会话（含 status 徽标）。 |
| `GET /api/chat/sessions/{id}` | 单个会话详情（含 active/sleeping/expired 状态）。 |
| `GET /api/chat/sessions/{id}/events?after=<seq>` | 回放：从账本按 [seq](../../terms.md) 读历史帧，用于进入会话或补齐（返回 `{ frames }`）。 |
| `POST /api/chat/sessions/{id}/messages` | 发消息：无进行中的一轮则**起新一轮**（`mode: "started"`）；已有进行中的一轮时看 `intent`——默认 `queue` 则**排队**（`mode: "queued"`），`steer` 则**注入当前轮**（`mode: "steered"`）。返回 202——事件不在这个响应里，去 `GET .../stream` 收。详见 [features/steer-and-queue](../../logic/orchestration/features/steer-and-queue.md)。 |
| `DELETE /api/chat/sessions/{id}/queue/{messageId}` · `DELETE .../queue` | 删除一条 / 清空[待发队列](../../terms.md)，返回变更后的完整队列快照。 |
| `GET /api/chat/sessions/{id}/stream?after=<seq>` | 可续传直播 tail：先回放 `after` 之后的历史帧，再转发这一轮的实时帧，直到本轮结束（或无进行中轮时回放完即关）。断线带 `after=lastSeq` 重开即续。 |
| `POST /api/chat/sessions/{id}/approvals/{callId}` | 对一个待处理审批请求裁决（`allow` 允许本次 / `allow-session` 会话内都允许该具体调用 / `deny` 拒绝，可带理由）。响应只是 ack，结果经直播流的审批 chunk 送达。 |
| `POST /api/chat/sessions/{id}/questions/{callId}` | 回答一个待处理的 ask-user 提问。响应只是 ack，结果经直播流的 `tool-ask-user` 部件送达。 |

> 说明：`status` 里的 `sleeping` 是**读时派生**的——休眠发生在 Vercel 侧（空闲超时到点自动停机存快照），服务端没有定时器去翻这个字段；所以一个存着 `active` 但空闲窗口已过的会话，读出来会呈现为 `sleeping`。下一条消息的 acquire 会唤醒沙盒并把它翻回 `active`。

## 范围与非目标

- **单仓库**：仓库由 env `GITHUB_REPO` 配置，一个部署服务一个仓库。多仓库是产品化下一步，本期不做。
- **单模型**：DeepSeek 直连（`NIMBO_MODEL` 可覆盖），不做多模型选择。
- **部署走 Git 集成 preview**：沿 07 定案，PR 即部署（Vercel Git 集成），不在应用内自建部署编排。
- **非目标**：不做多租户配额/计费；不做移动端。

## 成功标准

产品级验收（P12-3 真机验收链，详见[施工进展](../plans/chat-webapp.md)）：

1. register → login → 建会话（真沙盒起来、分支建好、skill 装上）。
2. 发一条只读消息（如「列仓库文件」，不产生 PR）→ 看到**流式**渲染 + 事件**落库**。
3. 静置触发**休眠** → 再发消息验证**唤醒 + 分支代码原样还原**。
4. 可选：一条真实设计任务消息走完到**开 PR**。
5. **断线可续**：刷新页面 / HMR / 网络抖动后，进行中这一轮的后续输出仍能到达页面（回放 + 续传 tail），不丢事件、不需要等这一轮结束。

## 凭证与配置（仓库根 `.env`）

全部配置收进**仓库根 `.env`**（唯一事实来源，`.env.template` 全量列出）：

`DEEPSEEK_API_BASE_URL` / `DEEPSEEK_API_TOKEN` / `NIMBO_MODEL?` / `GITHUB_REPO` / `GITHUB_PAT` / `SANDBOX_IDLE_TIMEOUT_MS?=300000` / `VERCEL_TOKEN` / `VERCEL_TEAM_ID` / `VERCEL_PROJECT_ID` / `BETTER_AUTH_SECRET`。

人在回路相关可调项：`CHAT_APPROVAL_MODE`（`dangerous`（默认）/ `all` / `off`）、`CHAT_APPROVAL_TIMEOUT_MS?=240000`、`CHAT_ASK_USER_TIMEOUT_MS?=240000`。

## 已知取舍与限制（用户可感知的）

1. **恢复兜底链有一档会丢未提交工作**：唤醒优先走快照恢复（快、含未提交改动）；快照过期则重 clone + checkout 已 push 的会话分支；若分支从未 push 过，则重建空分支——这一档下**未提交的工作会丢失**，UI 如实提示。这是 Vercel 快照 TTL 的客观约束。（turn-checkpoint 功能会用「每轮代码快照推到隐藏 ref」来补掉这个窗口。）
2. **turn 起始的用户消息在直播里可能先由前端本地乐观渲染兜底**：nimbo 的账本要到真实注入点才落这条消息，刷新后从账本回放自愈。
3. **ask-user 的「超时」与「真实回答」在界面不再区分**：两者都物化为「已作答」终态，超时只是作为一段提示文案出现在输出里。
4. **进程重启会中断进行中的一轮**：沙盒还在，但驱动这一轮的内存态停了；已落库的内容保留到中断点，重连回放发现无进行中轮即静默收尾。这是 v1 内存态 runner 的已知取舍。**界面不会因此卡住**（2026-07-27 修）：重新打开这个会话时，服务端会明确告知「没有轮在跑」，输入框回到空闲形态、发消息照常起新一轮。此前它会一直显示成「正在跑」，于是发的消息全被排进待发队列却永远发不出去，按停止也没有反应。
5. **不再有「第 N 轮」分割线**：单账本是连续的消息/帧序列，界面不再按轮切分渲染出显式边界。
