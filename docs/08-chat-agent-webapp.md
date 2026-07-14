# Chat Agent Web 应用：产品·技术·施工（apps/web + apps/server）

> 状态：已立项开工（2026-07-12 用户 /goal 直接立项）
> 相关：[docs/07](./07-sandbox-e2e-design-example.md)（12 号示例 = 本应用的核心能力原型）· [施工计划](./03-construction-plan.md) P12
> Seed：https://github.com/ludafa/hono-mono-starter（Hono + zod-openapi + better-auth + drizzle/better-sqlite3；React + TanStack Router + shadcn + kubb）

## 1. 产品设计

**一句话**：一个 chat agent 网页应用——用户在对话里驱动 nimbo agent 在 Vercel 沙盒中修改真实仓库代码、开 PR、触发 Vercel 部署（12 号示例的产品化）。

**用户可见行为**：
1. 注册/登录（seed 自带 better-auth）后进入 chat 界面；新建会话即绑定一个 Vercel 沙盒（clone `GITHUB_REPO`、装 frontend-design skill、建会话专属分支）。
2. 每条消息驱动一轮 agent loop；**loop 的每个事件实时流式渲染**（工具调用状态流转、file_change、文本打字机——12 号时间线的 React 版）。
3. 会话与全部事件**持久化到 SQLite**：刷新/重连可回放历史，跨进程重启可恢复会话。
4. **沙盒生命周期**：会话活跃期间沙盒保持激活（每条消息滚动续期）；不活跃达到阈值后沙盒休眠（Vercel persistent 沙盒自动快照）；用户回来继续对话时自动恢复——**分支代码原样还原**（快照恢复；快照过期则重 clone + checkout 会话分支兜底）。

**范围/非目标**：单仓库（env 配置 `GITHUB_REPO`）；部署沿 07 定案走 Git 集成 preview（PR 即部署）；不做多租户配额/计费；不做移动端。

## 2. 技术设计

### 2.1 布局与工作区（结构性决策）

- seed 的 `apps/client` 更名为 **`apps/web`**，`apps/server` 保留；`apps/docs` 不引入。包名 `@nimbo-chat/web`、`@nimbo-chat/server`。
- **apps/* 并入 nimbo 根 pnpm workspace**（`packages: ["packages/*", "apps/*"]`）——server 依赖 `@nimbo/sdk`/`@nimbo/sandbox-vercel`（workspace:*），独立子 workspace 无法解析 workspace 协议（file: 安装会因包内 workspace:* 依赖失败），examples 的纯符号链接方案又与 apps 必需的 pnpm install 冲突。
- **根管线保持不变**：根 package.json 的 build/typecheck/test/coverage 脚本 filter 收窄为 `./packages/*`——CI 与 885 用例基线零扰动；apps 用自己的脚本（`pnpm -F @nimbo-chat/server dev` 等）。root vitest projects 本就只收 `packages/*`。
- seed 的 `pnpm.overrides`（vite→rolldown-vite）与原生构建放行（better-sqlite3/esbuild/msw）合入根 workspace 配置——**零二进制原则的边界澄清：它约束的是发布的 @nimbo/* 包，apps 是消费侧产品代码，不受限**。

### 2.2 服务端（apps/server，在 seed 骨架上叠加）

新增模块（`src/agent/`）：
- **`model.ts`**：DeepSeek 直连（`deepseek-v4-pro` 默认，`NIMBO_MODEL` 覆盖）——同 12 号。
- **`store.ts`**（drizzle 表）：
  - `chat_sessions`: id / user_id / title / repo / branch_name / sandbox_name / status(`active|sleeping|expired`) / last_active_at / nimbo_state_json（`session.toJSON()`，每轮结束更新）/ created_at
  - `agent_events`: session_id / seq / ts / type / payload_json（`SessionEvent` 原样 JSON；(session_id, seq) 主键）——transcript-store 的 drizzle 版
- **`sandbox-manager.ts`**（核心生命周期）：进程内 `Map<sessionId, ActiveSandbox>` +
  - `acquire(sessionRow)`：内存命中→直接用；未命中→`Sandbox.get({ name })`（Vercel persistent 自动从快照恢复，**分支代码含未提交改动原样还原**）；`snapshot_not_found`/过期→重 `Sandbox.create({ source: git })` + `git fetch origin <branch> && git checkout`（分支已 push 过）或重建分支（未 push），并重装 skill（幂等）。
  - `touch(sessionId)`：每条用户消息 `extendTimeout(IDLE_TIMEOUT_MS)`——**沙盒超时即"休眠"机制本体**：到点 Vercel 自动 stop + 快照，无需服务端定时器（进程重启也不漏）。`IDLE_TIMEOUT_MS` 默认 5 分钟（目标描述"10 分钟/5min"存在歧义，取 5min 并做成 env 可调 `SANDBOX_IDLE_TIMEOUT_MS`）。
  - 沙盒创建/恢复参数：`persistent: true`（休眠=快照的前提）、`runtime: node24`、git source 同 12 号（GITHUB_PAT）。
- **`chat-agent.ts`**：`buildSession(sessionRow, workspace)`——`Skill.fromFS(workspace, "/.agents/skills/frontend-design")` + instructions（12 号骨架，注入 owner/repo/分支/默认分支；分支名固定为会话的 `branch_name`，多轮消息在同一分支上累积）+ `createSession(agent, { workspace, resume: 反序列化 nimbo_state_json })`。
- **`routes/chat.ts`**（`@hono/zod-openapi`，登录态强制）：
  - `POST /api/chat/sessions` `{ title? }` → 建行 + 建沙盒 + 初始化（clone/skill/分支）→ session 详情
  - `GET /api/chat/sessions` → 列表；`GET /api/chat/sessions/:id` → 详情（含 status）
  - `GET /api/chat/sessions/:id/events?after=<seq>` → 历史回放（分页）
  - `POST /api/chat/sessions/:id/messages` `{ text }` → **SSE 流**：`acquire` + `touch` → `session.stream(text)` → 每个 `SessionEvent` 先落库（agent_events，seq 单调）再 `data:` 推送（`{ seq, event }` 信封）；流末尾推 `{ type: "turn.result", finalResponse, usage }` 哨兵事件并更新 `nimbo_state_json`/`last_active_at`。SSE 用 `hono/streaming` 的 `streamSSE`；断线不终止 turn（落库继续，前端凭 `after=seq` 补齐）。
- **契约细化（P12-2 施工回填，两端定案）**：
  1. **`agent_events` 落库的是"信封事件"而非仅 nimbo `SessionEvent`**——信封 union 在 `SessionEvent` 之上扩展两个成员：`{ type: "user.message", text }`（用户发言，POST messages 一进来就以下一个 seq 入库并随流推送）与 `{ type: "turn.result", finalResponse, usage }`（哨兵，**同样入库**）。理由：`GET events` 回放必须能重建完整对话（用户发言 + agent 时间线 + 每轮收尾），只存 SessionEvent 是 P12-2 发现的真实缺口；nimbo 的 `SessionEvent` 联合保持纯净，扩展只存在于 webapp 的 wire 层。
  2. JSON 字段一律 **camelCase**（seed 既有先例）；`GET /api/chat/sessions` 返回 `ChatSession[]` 裸数组；`POST /api/chat/sessions` 与 `GET /api/chat/sessions/:id` 返回单个 `ChatSession`；`GET /api/chat/sessions/:id/events?after=<seq>` 返回 `{ events: Array<{ seq, event }> }`，前端以 `after=lastSeq` 循环拉到空批为止（不约定页大小字段）。
  3. **`steer`（turn 进行中追加消息，STEER-3B）**：`POST .../messages` 若目标 session 已有进行中 turn，先尝试 `session.steer(text)` 而非新起一轮；202 body 扩展为 `{ ok: true, mode: "started" | "steered" }` 区分两种落地方式。**steered 消息不会再产生一条独立的 `user.message` echo**——nimbo core 的 loop 会在真实的注入点（下一个 step checkpoint）产出一条 `user_message` 类型的 `item.completed`，经既有的落库+推流通路正常持久化，这就是它在事件流/回放里的唯一记录（位置=真实注入点，回放语义正确；双发会在时间线上出现两条相同的用户气泡）。`steer` 失败（无进行中 turn，或极窄竞态——turn 恰好在这次请求落地前收尾）时透明回退到 acquire+build+`startTurn` 起新一轮；两者都失败（新一轮又与另一个并发请求撞车）时才保留 409。

### 2.2b 断线可续的实时流（P12-4 重构，修复刷新/HMR 后进行中 turn 不再更新）

**问题**：原设计把 agent turn 直接跑在 `POST /messages` 的 SSE 回调里，客户端断线（页面刷新/HMR/网络抖动）后：server 端 turn 虽继续落库，但客户端只有一次性 `GET events` 补齐、且刷新后组件重挂载根本不开实时流——进行中 turn 的后续事件永远到不了页面。

**修法：turn 执行与连接解耦 + 可续传 live-tail。**

- **server 端 turn registry**（`agent/turn-runner.ts`）：进程内 `Map<sessionId, ActiveTurn>`；`ActiveTurn` 持一个 `EventEmitter`。`startTurn()` 若该 session 已有进行中 turn 则拒绝（409），否则**后台异步驱动** `session.stream()`（不绑定任何 HTTP 请求生命周期）：每个事件先落库（seq 单调）再 `emit('event', envelope)`；首事件仍是 `user.message`；收尾落 `nimbo_state` + `emit('turn.result')` + `emit('done')` 并从 Map 摘除；异常落 `emit('turn.failed')`（wire union 新增成员，镜像 nimbo 的 `turn.failed`）+ done。turn 全程与订阅者存在与否无关。
- **`POST /api/chat/sessions/:id/messages`**：改为 acquire+build+`startTurn` 后返回 **202 `{ ok: true, mode: "started" }`**（不再在此驱动 SSE）；若目标 session 已有进行中 turn，则先经 `steerTurn` 走 `session.steer(text)`，成功即 202 `{ ok: true, mode: "steered" }`（STEER-3B，契约细化第 3 点）；配置/沙盒错误仍走 500，`steer` 与新起一轮都失败时才走 409。
- **`GET /api/chat/sessions/:id/stream?after=<seq>`**（新增，SSE 可续传 tail）：先订阅 emitter 到缓冲、再回放 DB 中 `seq > after` 的事件（记 `maxSentSeq`）、再 flush 缓冲里 `seq > maxSentSeq` 的实时事件、随后持续转发直至 `done` 才关闭；若无进行中 turn 则回放完即关闭。订阅先于回放是为了不漏「回放查询与订阅之间」产生的事件。
- **客户端**（`use-chat-messages.ts` 重构为「命令/订阅分离」）：`sendMessage` = 乐观插入 + `POST messages`（起 turn）+ 打开 tail；**组件挂载时总是打开 tail**（`after=lastSeq`）以续接刷新前遗留的进行中 turn；tail 断开时，若本轮尚未见 `turn.result`/`turn.failed` 就带 `after=lastSeq` 重开（指数退避、限次）。`GET events` 一次性补齐路径删除（被可续传 tail 取代）。
- **边界**：进程重启会丢失内存态 turn（沙盒仍在跑但 nimbo loop 停）——DB 事件保留至崩溃点，重启后 tail 回放发现无进行中 turn 即静默收尾；这是 v1 内存态 runner 的已知取舍。
- **持久化恢复语义**：nimbo `SessionState`（消息史）与沙盒快照（文件态）分别恢复，模式 A 下天然一致（文件真身在沙盒里）。

### 2.2c 人在环上：bash 审批链与 ask_user 提问（P12-5，2026-07-13 用户立项）

**动机**：沙盒 exec 声明 `defaultApproval: "never"`（隔离即边界），chat 应用因此从不产生审批请求；但产品面需要外发动作（git push / 开 PR / 破坏性删除）经人确认，且 agent 需要能在 turn 中途向用户提问。两者同构：**工具执行挂起 → wire 事件（落库+推流）→ web 卡片 → HTTP 裁决 → resolve Promise 继续**。nimbo core 零改动——`onApproval` 本就是可 await 的异步回调，loop 停在工具执行前等它；ask_user 则是普通自定义工具的 `execute` 挂起。

- **触发面（bash 审批）**：`buildSession` 用 `gateWorkspace` 包装沙盒 workspace（逐方法显式委托 + `defaultApproval: "always"`，不用对象展开防丢 this 绑定）→ 内置 bash 的 per-tool approval 变 `"always"`，每次调用升级到 session `onApproval`。放行/拦截策略集中在桥回调（`agent/approval-policy.ts` 纯函数）：`CHAT_APPROVAL_MODE` 三档——`dangerous`（默认：`git push`、GitHub API curl（引用 api.github.com 或 $GH_TOKEN）、`rm -r/-f`、`git reset --hard`、`git clean -f` 人审，其余自动放行；input 形状不符一律升级人审，宁严勿松）/ `all`（全量人审）/ `off`（不包装，零行为变化）。
- **审批桥（turn-runner）**：`ActiveTurn` 持 `pendingApprovals: Map<callId, {resolve, timer}>`；`requestApproval` **先注册后 emit** `{type:"approval.requested", callId, toolName, input}`（与"订阅先于回放"同款防漏纪律）；`resolveApproval` 摘除 + emit `{type:"approval.resolved", callId, behavior, message?}` + resolve；超时自动 deny（`CHAT_APPROVAL_TIMEOUT_MS` 默认 240s——沙盒 idle 300s 的 80%，走同一条 resolve 通路保证多 tab/回放一致）；turn 收尾兜底 deny 残留 pending 但**不 emit**（terminal 哨兵之后不得追加事件）。emit 闭包（seq+落库+emitter）为此从 `driveTurn` 上提到 `startTurn`，挂 `ActiveTurn.emitWire`。
- **ask_user 工具**：`BuildSessionOptions.onAskUser` 存在时注册进 `agent.tools`；`execute` 经 `requestUserAnswer`/`resolveUserAnswer` 同款桥挂起（`pendingQuestions`），wire 事件 `{type:"question.asked", callId, question, options?}` / `{type:"question.answered", callId, outcome: "answered"|"timeout", answer?}`；超时（`CHAT_ASK_USER_TIMEOUT_MS` 默认 240s）返回固定提示文案（completed，不抛错，模型自行继续）；与 approvalMode 无关恒注册（产品能力，不是安全闸）。
- **裁决路由**：`POST .../approvals/:callId` `{behavior: "allow"|"deny", message?}`、`POST .../questions/:callId` `{answer}`——属主校验同其余路由；404 覆盖「session 不存在」与「callId 无 pending」两种；allow/answer 先 `touch` 续沙盒且**失败不阻断裁决**（挂到超时比 exec 失败更糟）。
- **wire 契约**：四个新事件均为 wire-only 成员（`user.message` 先例）且**落库**——回放据「requested/asked 无对应 resolved/answered + turn 已终结」渲染"已失效"。`tool_call` item 的 id 是 loop 内部 nimboId ≠ `callId` 且映射不上 wire，故审批/提问卡片是时间线上的**独立卡片**，不锚定 tool_call 卡片。
- **web**：`use-chat-messages` 折叠四个事件为 approval/question 时间线条目（pending/resolved/expired 三态；terminal 哨兵或 tail 无活跃 turn 收尾时过期）；`approval-card`（工具 + 命令预览 + Allow/Deny）、`question-card`（问题 + options 快捷按钮 + 自由文本作答）；ask_user 的 tool_call 卡片仅 failed/denied 时渲染（避免与 question 卡片双显）。
- **边界**：进程重启丢内存态 pending（与 `activeTurns` 同款 v1 取舍，web 端"已失效"兜底）；`"once"` 审批记忆不跨轮（chat 每轮重建 session，onceMemory 不进 SessionState）——策略里不用 `"once"`；审批/提问挂起期间 steer 照常排队，无冲突。

### 2.2d transcript 减量：durable/ephemeral 分层（P13-1，2026-07-14 用户确认）

**动机**：`item.updated` 每 tick 携带**累积全文**（loop.ts 的 `existing.text += delta` 后整段 yield），server 逐 tick 原样落库 → 存储量是消息长度的平方级（实证：P11-2 一轮 9861 事件中 9682 条是 updated tick，占 98%）。updated 是过程态、completed 才是权威——回放本来就不需要打字机 tick（web 的 `buildTimeline` 按 item id upsert 折叠，started+completed 足以重建终态时间线）。

- **分层规则**：`emitWire` 内分两档——`item.updated` 走 **ephemeral**（只广播、不落库、**不占 seq**），其余全部事件照旧（seq 递增 + 落库 + 广播）。信封 `seq` 改为可选：**有 seq ⇔ 已持久化、回放可见；无 seq ⇔ 仅存在于 live 流的过程帧**。ephemeral 不消耗 seq 号 → 持久流无空洞，`after=` 续传语义与「进程崩溃后内存 seq 从 DB max 续起」的一致性都不需要任何特判。
- **tail 的回归竞态**：`GET /stream` 订阅先于回放，缓冲里可能出现「比回放已送出的 `item.completed` 更旧的 ephemeral tick」——转发它会把该 item 打回半截文本且不再有 completed 收尾（completed 已在回放里送过）。规则：**回放阶段结束前到达的 ephemeral 一律丢弃**（对该连接而言 tick 只有 live 价值，丢弃无损）；回放结束后的 ephemeral 照常转发——此后到达的 tick 必属仍在进行的 item（completed 总在其全部 tick 之后产生），不可能回归。
- **客户端**：seq 去重/`lastSeq` 推进/断线重连的 `after=` 只看有 seq 的信封；ephemeral 信封照常喂给 `buildTimeline`（live 打字机不变），不进 seq 记账。回放流里天然不含 ephemeral，重连后由 completed 事件收敛终态。
- **接受的取舍**：turn 中途进程崩溃后，回放只剩 started 存根（首个 delta）+ 已 completed 的 item——半截打字机内容不再可回放（P13-3 的中断哨兵会把这个状态显性化）。不做抽稀持久（每 N 秒落一条 updated）——收益仅限崩溃窗口的回放美观，不值多一套机制。

### 2.3 前端（apps/web，在 seed 骨架上叠加）

- 路由：`/_app/` 下 `chat`（会话列表 + 时间线）——替换 seed 的 dashboard 示例位。
- **事件时间线组件**：按 `SessionEvent` 判别联合渲染（tool_call 卡片带状态色、file_change 徽章、agent_message 打字机、reasoning 折叠、plan_update 清单）——类型直接 `import type { SessionEvent } from "@nimbo/core"`（workspace 依赖，仅类型）。
- **SSE 消费**：POST+SSE 用 `fetch` + `ReadableStream` 手解析（kubb 生成的客户端不覆盖 SSE；`text/event-stream` 逐行解析，`seq` 去重续传）。进入会话先 `GET events` 回放再挂增量流。
- 会话状态徽标：active / sleeping（下一条消息自动唤醒，UI 提示"沙盒恢复中…"）。

### 2.4 凭证与配置（仓库根 `.env`）

`DEEPSEEK_API_BASE_URL` / `DEEPSEEK_API_TOKEN` / `NIMBO_MODEL?` / `GITHUB_REPO` / `GITHUB_PAT` / `SANDBOX_IDLE_TIMEOUT_MS?=300000` / `VERCEL_TOKEN` / `VERCEL_TEAM_ID` / `VERCEL_PROJECT_ID` / `BETTER_AUTH_SECRET`。

**2026-07-12 配置整合**：全部配置（原 `examples/.env` + `apps/server/.env` + 端口/URL）统一收进**仓库根 `.env`**，唯一事实来源，`.env.template` 全量列出。apps/server 经 dev 脚本 `--env-file-if-exists=../../.env` 读取；apps/web(vite) 与 examples(shared/model.ts 的 `loadRootDotEnv`) 同读。不再有 `examples/.env` 或 `apps/server/.env`。

## 3. 施工计划（P12，拆单）

- **P12-0 脚手架（主线程）**：seed 拷入 apps/（client→web 更名、去 docs/.claude/.git）、包名改 @nimbo-chat/*、根 workspace 并入 + 根脚本 filter 收窄、overrides/allowBuilds 合入、`pnpm install` + seed 基线可跑（bootstrap：db migrate + openapi + kubb 生成）。
- **P12-1 服务端（coder）**：§2.2 全部模块 + 单测（sandbox-manager 的 acquire/touch 状态机用 fake Sandbox；store 用例；SSE 路由集成测试用 mock model 走通事件落库+推流）。
- **P12-2 前端（coder，依赖 P12-0，与 P12-1 并行）**：§2.3 chat 页 + 时间线组件 + SSE hook；对 API 契约（§2.2 路由 + SSE 信封）编码，用 msw/fixture 事件流开发。
- **P12-3 集成真机验收（主线程/orchitector）**：register→login→建会话（真沙盒）→发"列仓库文件"类只读消息（不产生 PR）验流式+落库→静置触发休眠→再发消息验恢复（分支还原）→（可选）一条设计任务消息走完 PR。回填 docs/05；沙盒回收审计。
- **P12-5 人在环上（2026-07-13 立项，拆单）**：§2.2c 全部——工单 A/A2 服务端（coder：审批桥 + ask_user + 裁决路由 + openapi）、工单 B 前端（coder：kubb 重生成 + 事件折叠 + approval/question 卡片）、工单 C 测试（tester：approval-policy 纯函数单测、turn-runner 桥用例、路由集成、web hook 三态折叠）。
- **P13 持久化系列（2026-07-14 起，逐项确认制）**：P13-1 transcript 减量（§2.2d，✅ 已交付）；P13-2 turn checkpoint 与 P13-2b 沙盒保活——产品与技术方案独立成文，见 [docs/09](./09-turn-checkpoint-and-keepalive.md)；P13-3 中断哨兵、P13-4 留存治理待讨论。

## 4. 风险与已知取舍

1. **恢复语义的兜底链**：快照恢复（快）→ 快照过期重 clone + checkout 已 push 分支 → 分支从未 push 则重建分支（未提交工作丢失，UI 如实提示）——最后一档是 Vercel 快照 TTL 的客观约束，文档明示。
2. SSE 与 auth：better-auth cookie 同源随行；跨域部署时需同域反代（dev 用 vite proxy）。
3. 长 turn 与 Node server 超时：`@hono/node-server` 无默认响应超时问题，但反代部署时需注意（文档提示）。
4. seed 的 rolldown-vite override 与 nimbo 根 workspace 合并后对 packages/* 无影响（无 vite 依赖）；风险在 pnpm 版本差（seed 10.27 vs 根钉 10.18），实测为准。
5. 单仓库单模型假设：多仓库/多模型是产品化下一步，本期不做。
