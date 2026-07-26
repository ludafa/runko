# 停止本轮（施工进展）

> 相关：产品/使用视角见 [../features/turn-abort.md](../features/turn-abort.md)，技术方案见 [../tech/turn-abort.md](../tech/turn-abort.md)。
> 依赖/延续：[chat 聊天 webapp](../features/chat-webapp.md)（`turn-runner.ts` / `routes/chat.ts` / `use-chat-messages.ts` 是本期主战场）· [中途插话与排队](../features/steer-and-queue.md)（本期补上它的非目标「硬打断当前轮」，并按定案在停止时清空[待发队列](../terms.md)）。

## 状态

**代码完成、自动化全绿**（2026-07-25）；真机端到端待跑（需要我自己起服务，见下「验证方案」）。

| 阶段 | 内容 | 状态 |
|---|---|---|
| A0 | 三份文档 + 术语表登记 + 更新 steer-and-queue 非目标 | ✅ 已完成 |
| A1 | core：`runTurn` step 边界的 abort 检查（+ changeset） | ✅ 已完成（`.changeset/abort-at-step-boundary.md`，patch） |
| A2 | server：`turn-runner.ts` 的 `AbortController` 与 `abortTurn()` | ✅ 已完成 |
| A3 | server：`POST .../abort` 端点 + schema + 契约重生成 | ✅ 已完成（openapi + [kubb 重生成](../terms.md)已跑） |
| A4 | web：`stopTurn` / `stopping` / `interrupted` 归 idle | ✅ 已完成（旧的假 `cancel` 已删） |
| A5 | web：停止键 + 「已停止」中性呈现 | ✅ 已完成 |
| A6 | 自动化测试（core / node-server / web） | ✅ 已完成（core 418 / node-server 370 / web 233 全绿） |
| A7 | 真机端到端 | ⬜ 待跑（见下） |

## 施工拆单

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
- `pnpm chat:bootstrap` 重生成 openapi + [kubb 客户端](../terms.md)。

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

1. **`onTurnSettled` 没加 `aborted` 标志**（原 A2 计划里有过这个想法，施工时否决）：停止时清空[待发队列](../terms.md)的动作放在路由里、**先于** `abortTurn`，于是收尾时队列必然已空、自动[出队](../terms.md)自然无事可做——不需要跨模块多传一个状态。理由与被否决的方案见 [tech §3.2](../tech/turn-abort.md)。
2. **`abortTurn` 多了「停止后新来的审批请求也立即拒绝」这一条**（计划里只写了「结掉已挂起的」）：`loop.ts` 的 `mergeSettleStreams` 让一步内的多个工具调用**并发**结算，所以停止的那一瞬间可能还有别的调用正要请求审批。只结已挂起的会让它们各自挂到 240 秒超时，把「停止」拖成「四分钟后停止」。`ActiveTurn.aborted` 因此同时充当这个闸门。
3. **`TurnFailedBar` 的 `aborted` 分支改成中性 Alert**（计划里写的是「改标题文案」，实际连形态一起改了）：那条 bar 原本四种 `NimboError.code` 一律 destructive，但 `aborted` 是用户自己按的，不是故障；同时不再显示 core 那句英文 `message`（给日志看的），换成固定中文文案。
4. **顺带修掉一条过时的测试注释**：`packages/core/test/loop.test.ts` 里 abort 用例带着「已发现 src 缺陷、此断言当前会失败」的注释（账本残留一条孤儿占位 assistant 消息），实际早已被后来的 `ledgerLengthBeforeStep` 修复解决——本期新加的用例顺带钉住了「恰好一条 assistant 消息承接 metadata」这条不变量。注释未删（不属本期范围），仅在此备注。
5. **契约重生成只跑了两步、没跑整个 `chat:bootstrap`**：本期没有 DB 改动，所以只跑 `generate:openapi` + web 的 `generate:api`，跳过 `db:generate`/`db:migrate`（跑它们只会凭空生成一份空迁移）。
6. **顺带补了两处计划外的覆盖**：`api.test.ts` 加了 `postAbortTurn` 的两条（请求形状 + 409 带 status），`fixtures/design-preview-data.ts` 加了一组「已停止」样例并挂进[设计工作台](../terms.md)——那个页面的职责就是「每一档界面状态都在同一屏」，新增一档状态不挂上去等于让它失效。
7. **`@nimbo-chat/node-server` 的 `lint` 本就不绿**：`test/agent/uimessage-single-ledger.test.ts` 有 11 个既有 `no-unused-vars` 错误（一批只当类型用的 zod schema），与本期无关、未在本期修。本期新增/改动的文件本身 lint 干净。
