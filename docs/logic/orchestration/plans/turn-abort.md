---
title: "停止本轮（施工进展）"
slug: turn-abort
view: 施工
layer: 逻辑层
module: 轮编排
packages: ["@nimbo/agent"]
tags: ["中断", "停止本轮", "收尾"]
related: ["logic/orchestration/features/turn-abort.md", "logic/orchestration/tech/turn-abort.md", "architecture/tech/agent-kernel.md"]
---
# 停止本轮（施工进展）

> 相关：[功能](../features/turn-abort.md)，[技术方案](../tech/turn-abort.md)。
> 依赖/延续：[chat 聊天 webapp](../../../ingress/features/chat-webapp.md)（`turn-runner.ts` / `routes/chat.ts` / `use-chat-messages.ts` 是本期主战场）· [中途插话与排队](../features/steer-and-queue.md)（本期补上它的非目标「硬打断当前轮」，并按定案在停止时清空[待发队列](../../../terms.md)）。

## 状态

- **第一批（A0–A7，跑到中途按停止）**：代码完成、自动化全绿（2026-07-25）；真机端到端待跑。
- **第二批（B0–B6，[起轮装配](../../../terms.md)窗口里的停止）**：文档完成（2026-07-27），代码待做。见下「第二批」。

### 第一批阶段表

| 阶段 | 内容 | 状态 |
|---|---|---|
| A0 | 三份文档 + 术语表登记 + 更新 steer-and-queue 非目标 | ✅ 已完成 |
| A1 | core：`runTurn` step 边界的 abort 检查（+ changeset） | ✅ 已完成（`.changeset/abort-at-step-boundary.md`，patch） |
| A2 | server：`turn-runner.ts` 的 `AbortController` 与 `abortTurn()` | ✅ 已完成 |
| A3 | server：`POST .../abort` 端点 + schema + 契约重生成 | ✅ 已完成（openapi + [kubb 重生成](../../../terms.md)已跑） |
| A4 | web：`stopTurn` / `stopping` / `interrupted` 归 idle | ✅ 已完成（旧的假 `cancel` 已删） |
| A5 | web：停止键 + 「已停止」中性呈现 | ✅ 已完成 |
| A6 | 自动化测试（core / node-server / web） | ✅ 已完成（core 418 / node-server 370 / web 233 全绿） |
| A7 | 真机端到端 | ⬜ 待跑（见下） |

## 第二批：起轮装配窗口里的停止（2026-07-27）

**起因**：用户实测「发完消息立刻点停止，没有任何反应，那一轮照样跑起来」。根因是前端与服务端对「这一轮从何时开始存在」定义不一致——详见 [tech §3.3](../tech/turn-abort.md)。第一批（A0–A7）只覆盖了「已经跑起来的一轮」。

| 阶段 | 内容 | 状态 |
|---|---|---|
| B0 | 三份文档 + 术语表登记[起轮占位](../../../terms.md) | ✅ 已完成 |
| B1 | server：`turn-runner.ts` 的 `reserveTurn`/`releaseTurn`/`isTurnPreparing` + `ActiveTurn.phase` | ✅ 已完成 |
| B2 | server：`turn-launcher.ts` 接占位（try/finally 兜住每条退出路径 + 两处 abort 检查点） | ✅ 已完成 |
| B3 | server：`routes/chat.ts` 的 steer 分流按原因走 + ack `mode` 加 `'aborted'` + 契约重生成 | ✅ 已完成（openapi + kubb 已跑） |
| B4 | web：steer 拿回 `queued` 时撤掉「待注入」回显 | ✅ 已完成 |
| B5 | 自动化测试（node-server + web） | ✅ 已完成（见下「验证结论」） |
| B6 | 真机端到端（成功标准 8–12） | ⬜ 待跑（需要我自己起服务） |

### 第二批验证结论（2026-07-27）

```bash
pnpm --filter @nimbo-chat/node-server test        # 466 passed / 469（3 个失败与本批无关，见偏差 4）
pnpm --filter @nimbo-chat/node-server typecheck   # 干净
pnpm --filter @nimbo-chat/web test                # 249 全绿
```

新增用例 12 条，逐条对应产品文档 §4 的成功标准 8–12：

- `turn-runner.test.ts`（6 条，新 describe「reserveTurn / releaseTurn（起轮占位）」）：占位即存在（`isTurnActive`+`isTurnPreparing` 同时为真、二次占位被拒）· 未被停止的撤销不落任何行但必发 `done` · 被停止的撤销补出「用户消息 + interrupted」两帧且都是持久帧 · `startTurn` 就地升级并复用占位期的 `abortController`（安全网：漏过检查点也会在第一个 step 边界收尾）· 交棒后 `releaseTurn` 是无操作 · `steerTurn` 对装配中的轮报 `false`。
- `routes/chat.test.ts`（5 条，新 describe「起轮装配窗口」，靠 `nextAcquireGate` 撑开窗口）：装配窗口里按停止 → 202 `mode:'aborted'` + 账本只有 user 消息 + 之后仍能正常起轮（标准 8）· 收尾两帧的落盘形状（标准 8 的「刷新后一致」）· **装配失败后下一条消息仍能起轮**（标准 12，防锁死回归）· 窗口内第二条消息入队且不触发第二次装配（标准 10）· 窗口内 steer 转排队不报 409（标准 11）。
- `use-chat-messages.test.ts`（1 条）：steer 拿回 `mode:'queued'` 时撤掉「待注入」回显且不报错（标准 11 的界面侧）。
- `api.test.ts`：既有的 `postChatMessage` 用例改为断言它 resolve 出 `mode`，另加一条「请求 steer 却拿回 `queued`」。

### 第二批实际改动与计划的偏差

1. **`launchTurn` 的装配主体抽成了 `assembleAndStartTurn`**（计划只写「用 try/finally 兜」）：直接给几百行的函数体套一层 `try` 要整体重排缩进，改动面大且易错。抽一个内部函数后 `launchTurn` 只剩「占位 → 调它 → finally 撤销」十几行，缩进一行没动。
2. **`TurnReservation` 用 `WeakMap` 关联内部 `ActiveTurn`**（计划没写怎么关联）：句柄上挂一个 `ActiveTurn` 字段会把这个内部类型漏给调用方，也让「交棒后 `releaseTurn` 自动变无操作」这条幂等性没地方落。改成 module 级 `reservationRegistry: WeakMap`，交棒/撤销时删条目——幂等性就是这个 delete 的自然结果。
3. **`ActiveTurn` 的 `emit` 字段删掉了，改成 `startTurn` 的局部变量**：占位期没有 `emit` 可言（那时还没有 `session`、也没有 chunk 要发），留着字段就得写成 `TurnEmitter | undefined`，会让唯一的读者（传给 `driveTurn`）多一处非空处理。grep 确认全仓只有那一个读者，删字段最干净。`steer` 同理保留为 `| undefined`——它是 `isTurnPreparing` 之外的第二个判据。
4. **`sandbox-manager.test.ts` 有 3 条失败，与本批无关**：同期另一条线正在做[沙盒保活](../features/sandbox-keepalive.md)的重构（`touch` → `ensureLifetime`、turn 级心跳整个删掉）。本批施工中途撞上这个重构，两处受影响并已按新 API 对齐：`turn-launcher.ts` 的检查点 2 注释不再提 `startHeartbeat`（那套东西已不存在），新增的路由用例改用「账本里没有 assistant 消息 + 之后仍能起轮」作为「从没启动」的证据（原计划想断言心跳没起过）。那 3 条失败落在 keepalive 自己的用例上，归它那条线。
5. **`fake-sandbox-manager.ts` 加了 `nextAcquireGate`**（计划没写怎么撑开窗口）：让下一次 `acquire()` 挂在一个测试可控的 promise 上，与真实的冷启动沙盒同形；`acquireCalls` 仍在挂住之前就记账，测试靠它确认「装配确实进去了」再发停止请求，不依赖 sleep。
6. **`postChatMessage` 的返回值从 `void` 变成 `mode`**：既有的 `api.test.ts` 用例名写着「no body assumptions beyond ok」——现在确实有了 body 假设（要读 `mode`），所以那条用例连名字一起改了。`fake-chat-fetch.ts` 的 `POST .../messages` 响应也补上 `mode`，缺省按请求的 `intent` 推断（`steer` → `'steered'`，其余 → `'started'`），与真服务端同形。

### B1 server：turn-runner 的占位

- `ActiveTurn` 加 `phase: 'preparing' | 'running'`；`steer`/`emit` 在 `preparing` 阶段还不存在（占位时它们没有 `session` 可绑）。
- 新增 `reserveTurn(conversationId, logger?)` → `TurnReservation | undefined`：建 `emitter` + `AbortController`，`phase: 'preparing'` 登记进 `activeTurns`。已有轮（含装配中）返回 `undefined`。
- 新增 `releaseTurn(db, reservation, text, logger?)`：被停止过则先补两帧收尾（用户消息 `MessageFrame` + 独立的 `interrupted` metadata chunk，见 [tech §3.3](../tech/turn-abort.md)），随后 `emit('done')` + 删登记。
- 新增 `isTurnPreparing(conversationId)`：给路由的 steer 分流用。
- `startTurn` 接受可选 `reservation`：有则**原地升级** `phase → 'running'` 并补 `emit`/`steer`（复用同一个 `emitter` 与 `abortController`），无则照旧新建（既有测试与调用方不动）。
- `steerTurn`：`phase === 'preparing'` → 返回 `false`。

### B2 server：turn-launcher 接占位

- `launchTurn` 在 `getConversation` 之后立刻 `reserveTurn`；`undefined` → `{ ok:false, reason:'busy' }`。
- `try/finally` + `handedOff` 标志：只要没交棒给 `startTurn`，`finally` 必定 `releaseTurn`。**这是本批风险最高的一点**——漏一条退出路径就把会话永久锁死（[tech §3.3](../tech/turn-abort.md) 纪律 2）。
- 两处 abort 检查点：`acquire`+`touch` 之后（省掉后面的 skill 扫描与 `buildSession`）、`startHeartbeat` **之前**（这样不用碰心跳的收尾逻辑）。命中则 `return { ok:false, reason:'aborted' }`。
- `LaunchTurnOutcome` 加一档 `{ ok:false; reason:'aborted' }`；`startNextQueuedTurn` 对这一档**不 requeue**（用户按的就是停止，把它放回队首等于没停）。

### B3 server：路由与契约

- `POST .../messages` 的 steer 分流改为按原因走（表见 [tech §3.3](../tech/turn-abort.md)）：`isTurnPreparing` 为真 → 入队；否则回落起新一轮。
- `PostChatMessageAckSchema` 的 `mode` 加 `'aborted'`；`launchTurn` 返回 `reason:'aborted'` 时路由回 `202 { ok:true, mode:'aborted' }`（不是错误——用户要的结果达成了）。
- 只跑 `generate:openapi` + web 的 `generate:api`（无 DB 改动，同第一批偏差第 5 条）。

### B4 web：steer 回显的修正

- `api.ts`：`postChatMessage` 把 ack 的 `mode` 透出来（目前丢弃）。
- `use-chat-messages.ts`：steer 路径拿回 `mode === 'queued'` → 撤掉那条「待注入」`pendingUserEcho`（队列快照会把它显示在待发区）。
- 其余一行不改：那两帧收尾走的是既有回放 + `MessageLedger` + `interrupted` 归 idle + 中性「已停止」。

### B5 测试

- node-server `turn-runner.test.ts`：占位后 `isTurnActive` 立刻为真；`releaseTurn` 未被停止时不落任何行、被停止时落两行且形状正确；`releaseTurn` 必发 `done`；`startTurn` 原地升级复用同一个 `abortController`（占位期的 abort 对升级后的轮依然有效）；`steerTurn` 对 `preparing` 返回 false。
- node-server `routes/chat.test.ts`：**装配窗口内 abort** 的端到端（用一个卡住的 fake sandbox manager 撑开窗口）→ 202 `mode:'aborted'` + 零次模型调用 + 两行落库；装配失败后**下一条消息仍能起轮**（防锁死回归）；窗口内第二条消息入队且只装配一次；窗口内 steer 入队。
- web `use-chat-messages.test.ts`：steer 拿回 `queued` 时回显被撤掉；回放两帧后 status 落 idle 且末尾是「已停止」。

## 第一批施工拆单（A0–A7，2026-07-25）

### A1 core：step 边界的 abort 检查

- `packages/core/src/loop.ts`：`runTurn` for 循环开头 `if (abortSignal.aborted)` → `finalizeTurn({ status: statusForError(error), error: { code: 'aborted', … } })` + `return`。见 [tech §2](../tech/turn-abort.md)。
- 产出：`packages/core/test/` 下一条用例——已 abort 的 signal 传进 `stream()`，断言「零次模型调用 + 收尾 metadata 为 `interrupted`」。
- changeset：`@nimbo/core` `patch`（不动 API，只让既有 `TurnOptions.signal` 的停止时机确定化）。

### A2 server：turn-runner

- `ActiveTurn` 加 `abortController: AbortController` + `aborted: boolean`。
- `TurnDrivenSession.stream` 签名放宽到 `(input, opts?: { signal?: AbortSignal })`；`driveTurn` 透传 signal。
- 新增 `export function abortTurn(conversationId: string): boolean`——五步顺序见 [tech §3.1](../tech/turn-abort.md)（含「先置 `aborted` 再结挂起项」的理由）。
- `requestReview` / `requestUserAnswer`：`activeTurn.aborted` 为真时立即 deny / timeout，不再注册新的挂起项。
- 日志：`turn abort requested`（含 `pendingReviews`/`pendingQuestions` 数量）。

### A3 server：端点与契约

- `schemas/chat.ts`：`AbortTurnAckSchema = { ok: literal(true), queue: QueuedMessage[] }`。
- `routes/chat.ts`：`POST /api/chat/conversations/{id}/abort`，四步顺序见 [tech §3.2](../tech/turn-abort.md)（`isTurnActive` 判定在清队列**之前**、清队列在 `abortTurn` **之前**）。
- `pnpm chat:bootstrap` 重生成 openapi + [kubb 客户端](../../../terms.md)。

### A4 web：hook

- `api.ts`：`postAbortTurn(conversationId, signal?)` → 返回清空后的队列快照。
- `use-chat-messages.ts`：删 `cancel`、加 `stopTurn` + `stopping`；`statusFromTurnEnd`/`errorFromTurnEnd` 对 `interrupted` 走 idle/无错误；409 静默。

### A5 web：界面

- `message-composer.tsx`：流式态 `PromptInputSubmit` → `status="streaming"` + `type="button"` + `onClick` + `disabled={stopping}`。
- `turn-marker.tsx`：`code: 'aborted'` → 中性 Alert +「已停止」+ 固定中文文案。
- `pages/conversation.tsx`：接线 `stopTurn`/`stopping`。

### A6 测试

- node-server：`turn-runner.test.ts`（signal 透传、停止后挂起审批被 deny、停止后新审批立即 deny、幂等）；`routes/chat.test.ts`（200 + 队列清空 + 广播、无轮 409 且不动队列、404）。
- web：`use-chat-messages.test.ts`（`stopTurn` 发请求、不做乐观翻转、`interrupted` 归 idle、409 静默）；`message-composer.test.tsx`（流式态点击走 onStop 而非提交、`stopping` 禁用）。

## 验证方案

见 [产品文档 §4 成功标准](../features/turn-abort.md)的七条，逐条对应：

**自动化（跑完即退）——已执行，结果如下**

```bash
pnpm build && pnpm typecheck && pnpm test          # packages/*：core 418 项全绿（含新增的 abort step 边界用例）
pnpm --filter @nimbo-chat/node-server test         # 370 全绿（含 turn-runner 的 abortTurn 组 + 路由的 POST .../abort 组）
pnpm --filter @nimbo-chat/node-server typecheck    # 干净
pnpm --filter @nimbo-chat/web test                 # 233 全绿（含 hook 的停止组、composer 的停止键、时间线的「已停止」标记）
pnpm --filter @nimbo-chat/web typecheck            # 干净
pnpm --filter @nimbo-chat/web lint                 # 干净（node-server 的 lint 见上「偏差」第 5 条）
```

自动化覆盖到的成功标准：§4 的 1（收尾状态 interrupted + 无第二次模型调用，`routes/chat.test.ts` 真链路用例）、2（落盘形态：消息留存 + chunk 行 GC）、3（队列清空且不自动出队）、4（挂起审批被就地拒绝）、6（幂等）。真机只需覆盖 5、7 与观感。

**真机端到端**（需要我自己起服务：`! pnpm chat:server` / `! pnpm chat:web`）

1. 发一条会跑很多步的需求（如「把 README 逐段翻译成英文并逐个文件提交」），跑到第 3 步左右按停止 → 秒级停住、末尾「已停止」、服务端日志无新的模型调用。
2. 刷新页面 → 历史一致、末尾仍「已停止」。
3. 排 3 条消息再按停止 → 待发区清空、一分钟内无任何自动起轮日志。
4. 触发一条危险命令（进审批卡片）→ 按停止 → 卡片「已拒绝」+ 本轮结束，耗时远小于 240 秒。
5. 停止后发「刚才那步不对，改成……」→ 新一轮正常起、回答体现记得上一轮。
6. 连点停止 5 次 → 只有一次生效、无报错。
7. 另开标签页 → 同样是已停止、输入框空闲态。

## 实际改动与计划的偏差

1. **`onTurnSettled` 没加 `aborted` 标志**（原 A2 计划里有过这个想法，施工时否决）：停止时清空[待发队列](../../../terms.md)的动作放在路由里、**先于** `abortTurn`，于是收尾时队列必然已空、自动[出队](../../../terms.md)自然无事可做——不需要跨模块多传一个状态。理由与被否决的方案见 [tech §3.2](../tech/turn-abort.md)。
2. **`abortTurn` 多了「停止后新来的审批请求也立即拒绝」这一条**（计划里只写了「结掉已挂起的」）：`loop.ts` 的 `mergeSettleStreams` 让一步内的多个工具调用**并发**结算，所以停止的那一瞬间可能还有别的调用正要请求审批。只结已挂起的会让它们各自挂到 240 秒超时，把「停止」拖成「四分钟后停止」。`ActiveTurn.aborted` 因此同时充当这个闸门。
3. **`TurnFailedBar` 的 `aborted` 分支改成中性 Alert**（计划里写的是「改标题文案」，实际连形态一起改了）：那条 bar 原本四种 `NimboError.code` 一律 destructive，但 `aborted` 是用户自己按的，不是故障；同时不再显示 core 那句英文 `message`（给日志看的），换成固定中文文案。
4. **顺带修掉一条过时的测试注释**：`packages/core/test/loop.test.ts` 里 abort 用例带着「已发现 src 缺陷、此断言当前会失败」的注释（账本残留一条孤儿占位 assistant 消息），实际早已被后来的 `ledgerLengthBeforeStep` 修复解决——本期新加的用例顺带钉住了「恰好一条 assistant 消息承接 metadata」这条不变量。注释未删（不属本期范围），仅在此备注。
5. **契约重生成只跑了两步、没跑整个 `chat:bootstrap`**：本期没有 DB 改动，所以只跑 `generate:openapi` + web 的 `generate:api`，跳过 `db:generate`/`db:migrate`（跑它们只会凭空生成一份空迁移）。
6. **顺带补了两处计划外的覆盖**：`api.test.ts` 加了 `postAbortTurn` 的两条（请求形状 + 409 带 status），`fixtures/design-preview-data.ts` 加了一组「已停止」样例并挂进[设计工作台](../../../terms.md)——那个页面的职责就是「每一档界面状态都在同一屏」，新增一档状态不挂上去等于让它失效。
7. **`@nimbo-chat/node-server` 的 `lint` 本就不绿**：`test/agent/uimessage-single-ledger.test.ts` 有 11 个既有 `no-unused-vars` 错误（一批只当类型用的 zod schema），与本期无关、未在本期修。本期新增/改动的文件本身 lint 干净。
