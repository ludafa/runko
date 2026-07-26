# 中途插话与排队（施工进展）

> 相关：产品/使用视角见 [../features/steer-and-queue.md](../features/steer-and-queue.md)，技术方案见 [../tech/steer-and-queue.md](../tech/steer-and-queue.md)。
> 依赖/延续：[chat 聊天 webapp](../features/chat-webapp.md)（`routes/chat.ts` / `turn-runner.ts` / `use-chat-messages.ts` 是本期主战场）· [UIMessage 单账本](../features/single-ledger.md)（[账本](../terms.md)不变，队列刻意在账本之外）。

## 状态

**已交付**（2026-07-25）：代码完成，自动化验证全绿，真机端到端（真沙盒 + 真模型）通过。[steer](../terms.md) 侧未改 `@nimbo/core`（它本就具备 `Session.steer()`）。

| 阶段 | 内容 | 状态 |
|---|---|---|
| Q0 | 三份文档 + 术语表登记 | ✅ 已完成 |
| Q1 | DB 加列 + store 队列读写 | ✅ 已完成（`drizzle/0007_boring_robin_chapel.sql`，已 migrate） |
| Q2 | `turn-launcher.ts` 抽取（路由行为不变的纯重构） | ✅ 已完成 |
| Q3 | 队列 API（intent 分流 / 删除 / 清空 / DTO 带队列） | ✅ 已完成（含 `chat:bootstrap` 重生成契约） |
| Q4 | 自动出队 + `QueueFrame` 广播 | ✅ 已完成 |
| Q5 | 前端：待发区 + 显式插话入口 + 收尾续跑 | ✅ 已完成 |
| Q6 | 自动化测试 | ✅ 已完成（node-server 251 / web 177 全绿） |
| Q7 | 真机端到端 | ✅ API 全链路通过（结果见「验证方案」）；UI 侧由 web 单测覆盖 |

### 实际改动与计划的偏差

1. **修掉一个既有的直播流唤醒竞态**（计划外，但不修就会被本功能触发）：`GET .../stream` 的直播循环用「一次性 promise + `scheduleWake` 替换」等待新帧，一个在本轮 `flushBuffered()`（内部有 `await writeFrame`）**进行中**到达的帧，唤醒的是已经没人等的旧 promise，下一轮 `await` 的却是新 promise——那次唤醒就丢了。本功能在回放后多写了一帧队列快照，把这个窗口撑大到必然命中（既有测试直接超时暴露）。循环改成「`buffered` 非空就先冲，空了才等」，丢唤醒不再有后果。
2. **`isMessageFrame` 的参数放宽到 `ChatReplayFrame`**（原 `LedgerFrame`）：同一判别在「已分流的账本帧」与「原始 wire 帧」两处都要用；新增 `frameSeq()` 统一「取一个帧的 seq」（`QueueFrame` 恒无 seq），前端 hook 与测试都改用它，不再各写各的收窄。
3. **`queuedMessages` 的初值从 `initialFrames` 里的队列帧兜底**：原计划在挂载 effect 里应用它，被 `react-hooks/set-state-in-effect` 拦下——改为在 `useState` 初值里算，effect 只跳过队列帧。
4. **既有的「409 已有进行中的一轮」用例改写**而非删除：默认 intent 改成排队后，409 只剩「`intent: 'steer'` 但该轮不可 steer，回落起轮又被守卫挡下」这条窄路径，用例照此重写，保住了这条路径的覆盖。
5. **不需要 changeset**：改动全部落在 `apps/node-server` 与 `apps/web`（`private: true`，不发布），`packages/*` 一行未动。

## 施工拆单

### Q1 队列存储（无行为变化）

- `db/schema.ts`：`conversations` 加 `queuedMessagesJson: text('queued_messages_json').notNull().default('[]')`。
- `pnpm --filter @nimbo-chat/node-server db:generate` 生成 `drizzle/0007_*.sql`，`db:migrate` 应用。
- `agent/store.ts`：`listQueuedMessages` / `enqueueMessage`（含上限）/ `removeQueuedMessage` / `clearQueuedMessages` / `dequeueMessage`（取队首并移除）/ `requeueFront`（起轮失败回写）。读回一律 zod `parse`，**不用类型断言**。
- 产出：`store.test.ts` 覆盖增删清空与上限。

### Q2 `agent/turn-launcher.ts` 抽取

- 从 `routes/chat.ts` 的 `POST .../messages` 搬出：`resolveModel`/`acquire`/E2B 重连令牌回写/`onApproval`/`onReview`/`onAskUser`/`loadResumeState`/`buildSession`/`startTurn`。
- 签名：`launchTurn(deps: TurnLauncherDeps, input: { conversationId, userId, text })`，`deps` 复用 `ChatRouteDeps` 的子集（db / sandboxManager / resolveModel / telemetry）。
- **纯重构**：本阶段路由的对外行为、返回码、错误文案一律不变，现有 `routes/chat.test.ts` 必须原样跑绿。

### Q3 队列 API

- `schemas/chat.ts`：`QueuedMessageSchema`、`PostChatMessageInputSchema` 加 `intent`、`StartTurnAckSchema` 的 `mode` 加 `'queued'`、`ConversationSchema` 加 `queuedMessages`、`QueueSnapshotSchema`。
- `routes/chat.ts`：`POST .../messages` 按 [tech §4.1](../tech/steer-and-queue.md) 分流；新增两个 `DELETE .../queue*` 端点。
- 重新生成契约：`pnpm chat:bootstrap`（openapi + [kubb 重生成](../terms.md)）。

### Q4 自动出队

- `turn-runner.ts`：`StartTurnParams` 加 `onTurnSettled?`，在 `activeTurns.delete()` 之后调用（顺序是硬要求）。
- `turn-launcher.ts`：注入 `onTurnSettled` → `dequeueMessage` → 递归 `launchTurn`；失败 `requeueFront` + error 日志。
- `QueueFrame` 广播：`turn-runner.ts` 暴露 `broadcastQueue(conversationId, queue)`；`GET .../stream` 在回放后、直播前发一帧快照。

### Q5 前端

- `features/chat/schema.ts` + `api.ts`：`QueueFrame` 解析、`postChatMessage` 带 `intent`、`deleteQueuedMessage`/`clearQueue`。
- `use-chat-messages.ts`：`queuedMessages` 状态、`sendMessage(text, intent)`、收尾后队列非空则保持 streaming + 重连。
- `components/queued-messages.tsx`（新）+ `message-composer.tsx`（Alt+Enter / 插话按钮 / placeholder）+ `pages/conversation.tsx` 接线。

### Q6 测试与验证

见下方「验证方案」。

## 验收标准

- `apps/node-server`：`pnpm typecheck && pnpm lint && pnpm test` 全绿。
- `apps/web`：同上。
- 无新增 `any`/`unknown`/类型断言（队列 JSON 读回走 zod）。
- 产品文档 §4 的六条成功标准逐条有对应用例或真机验证记录。

## 验证方案

> 施工全部完成后回填「实际结果」。

### 自动化（**实际结果：全部通过**，2026-07-25）

跑法：`apps/node-server` 与 `apps/web` 各自 `pnpm typecheck && pnpm lint && pnpm test`；全仓 `pnpm -r typecheck && pnpm -r test`（CI 口径）同样绿。

- `apps/node-server`：**251 passed**（新增 9 条队列用例，改写 4 条受行为变更影响的既有用例）。
- `apps/web`：**177 passed**（新增 17 条：composer 6 / 待发区 4 / hook 7）。
- 全仓：12 个项目、**1464 passed**，无跳过。

| 用例 | 层 | 断言 |
|---|---|---|
| 有活跃轮 + 默认 intent → 入队 | node-server 路由 | 202 `mode:'queued'`；行内 JSON 多一条；当前轮 `steer` 未被调用 |
| 有活跃轮 + `intent:'steer'` → steer | node-server 路由 | 202 `mode:'steered'`；`steer` 被调用一次 |
| 无活跃轮 + 任意 intent → 起轮 | node-server 路由 | 202 `mode:'started'` |
| 队列满 11 条 | node-server 路由 | 409，队列仍为 10 条 |
| 轮收尾自动出队 | node-server turn-runner + launcher | 队首被移除；`startTurn` 以队首文本被调用一次；队列剩余顺序不变 |
| 出队起轮失败 | node-server launcher | 消息回到队列头部；不抛出到 `finally` 之外 |
| 删除/清空 | node-server 路由 | 200 返回变更后快照；不存在的 id → 404 |
| 队列读回容错 | node-server store | 列内容损坏时 zod 失败 → 视为空队列并记日志，不 500 |
| `QueueFrame` 三支联合解析 | web schema | `{queue}` 帧被正确判别，不误入 chunk/message 分支 |
| composer 快捷键 | web 组件 | 流式中 Enter → `intent:'queue'`；Alt+Enter → `'steer'`；idle 时 Enter → `'queue'`（服务端判为 started） |
| 待发区交互 | web 组件 | 渲染 N 条、点 × 调删除、点清空调清空 |
| 收尾续跑 | web hook | 轮结束且队列非空 → status 保持 `streaming` 且重开 tail |

### 端到端（真机）

> **前置**：`.env` 需备齐 `NIMBO_MODEL` + 模型凭据、`GITHUB_REPO`/`GITHUB_PAT`、沙盒 provider 凭据（Vercel 或 E2B）。
> **跑法**：`pnpm chat:bootstrap`（首次或改过 schema 后必跑——本期新增 `0007` migration）→ 两个终端分别 `pnpm chat:server`、`pnpm chat:web` → 浏览器登录后按下面 6 条走。
> **注意**：每建一个会话都会真的开一个云沙盒并在 `GITHUB_REPO` 上建一条 `nimbo/chat-<id>` 分支，验证完记得清理。

1. 起一轮长任务（让 agent 跑一个多步任务），进行中连发 3 条排队消息 → 待发区显示 3 条，当前轮输出不受影响。
2. 该轮收尾 → 第 1 条自动作为新一轮发出，时间线顺序正确；随后第 2、3 条依次发出。
3. 排队状态下刷新页面 → 待发区仍是剩余条数。
4. 另开标签页打开同一会话 → 看到同一队列；在 A 删一条，B 在该轮进行中同步减少。
5. 一轮进行中 Alt+Enter 发一条 → 该条在下一个 step 边界注入当前轮（时间线上出现在本轮内）。
6. 队列满 10 条后再发 → 明确错误提示，不静默丢。

#### 实际结果（2026-07-25，真沙盒 Vercel + DeepSeek + 真仓库分支）

在本地 `data.db` 上另起一个 `SERVER_PORT=3901` 的实例跑通（`--env-file` 不覆盖已有环境变量，故不必改 `.env`）。**API 层全链路通过**：

| 验证点 | 结果 |
|---|---|
| 起轮 | `{"ok":true,"mode":"started"}` |
| 轮进行中默认 intent 连发两条 | 两次都 `mode:"queued"`；会话详情 `queuedMessages` 为这两条、顺序与发送一致 |
| `DELETE .../queue/{id}` 删中间那条 | 200，响应快照只剩第 1 条；顺序未重排 |
| 轮收尾自动出队 | ~20s 后 `queued=0`，账本里出现第 2 条用户消息 → 它确实成了**新一轮**的输入 |
| 被删的第 3 条 | 始终没有发出（终局用户消息只有 2 条）✅ |
| SSE 队列帧 | 连上即收到 `event: queue`（空快照，时机 1）；随后入队再收到一帧含该条（时机 2）——共 2 帧 |
| `intent:"steer"` | `mode:"steered"`，且该条**不进队列**（队列仍只有排队那条）；直播流上出现 1 个 `messageMetadata.steered === true` 的起始 chunk → 确实注入了当前这一轮 |

**未在真机上跑的**：浏览器 UI 侧（待发区渲染/删除/清空、Enter 与 Alt+Enter 的键位分流、跨标签同步）——这些由 web 的 17 条组件/hook 单测覆盖（含「收尾时队列非空则保持 streaming 并重连」这条最容易出闪烁的路径）。

验证残留：一个 e2e 会话（`repo` 上一条 `nimbo/chat-a8ca485e-…` 分支 + 一个 Vercel 沙盒，沙盒会按 `SANDBOX_IDLE_TIMEOUT_MS` 自行回收），以及一个 `queue-e2e-*@example.com` 测试账号——按需清理。

## 变更记录

- 2026-07-25：产品/技术/施工三份文档定稿；术语表登记「排队（queue）」「出队（dequeue）」并修订 steer 词条（补「chat 里需显式选择」）。存储定案为 `conversations` 加 JSON 列（否决新增子表与写入[账本](../terms.md)两案，理由见 [tech §2](../tech/steer-and-queue.md)）。

## 明确不做

编辑排队消息、拖拽排序、每条独立 provider/模型参数、硬打断当前轮、多用户队列权限区分——理由见[产品文档 §3](../features/steer-and-queue.md)。
