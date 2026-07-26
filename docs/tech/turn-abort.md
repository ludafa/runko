# 停止本轮（技术方案）

> 相关：产品/使用视角见 [../features/turn-abort.md](../features/turn-abort.md)，施工进展见 [../plans/turn-abort.md](../plans/turn-abort.md)。
> 依赖/延续：[chat webapp 技术方案](./chat-webapp.md) §2.2b（轮的进程内驱动与直播流）· [中途插话与排队](./steer-and-queue.md) §3（`turn-launcher` / `onTurnSettled` 这条自动[出队](../terms.md)链条）· [UIMessage 单账本](./single-ledger.md) §5 单-3（落盘时序、[transient/persistent](../terms.md) 两档）· [核心 SDK](./core-sdk.md) §4.2（`TurnOptions.signal`）。
> 术语一律以 [../terms.md](../terms.md) 为准（**停止**、[轮](../terms.md)、[step](../terms.md)、[账本](../terms.md)、[待发队列](../terms.md)、[审批卡片](../terms.md)）。

## 1. 方案总览

一句话：**复用 `@nimbo/core` 已有的 `TurnOptions.signal`**，chat 服务端为每一轮持有一个 `AbortController`，`POST .../abort` 触发它；core 的 loop 在 step 边界看到 abort 就走**优雅收尾**（`status: 'interrupted'` + `NimboError.code: 'aborted'`），于是账本、GC、直播流全部按既有路径跑完。

三个关键结论（也是本方案能这么小的原因）：

1. **不需要新的账本条目类型、不需要 DB 迁移。** 被停止的一轮走的是 core 既有的「优雅中途降级」路径（`loop.ts` 的 `finalizeTurn` 产出一条带 `status: 'interrupted'` 的 `message-metadata` chunk 后正常 `return TurnResult`），因此 `turn-runner.ts` 的 `finalizeTurnPersistence` 照常执行：这一轮的消息落 `kind = 'message'` 行、`kind = 'chunk'` 行 GC、会话 header 更新。刷新页面的回放与正常收尾的一轮**走同一段代码**。
2. **「停止」的可见性不需要新的 wire 帧。** 界面靠那条 `message-metadata`（`status: 'interrupted'`、`error.code: 'aborted'`）认出「已停止」，与它认「已失败」是同一个机制。
3. **`@nimbo/core` 只需要一处小改**：在 `runTurn` 的 step 循环开头显式检查 `abortSignal.aborted`。不加这一处也能停（AI SDK 的 `streamText` 遇到已 abort 的 signal 会 reject，落进 loop 既有的 catch → `code: 'aborted'`），但那要多打**一次**模型调用才停得下来，而且把停止时机的确定性外包给了第三方库的行为细节。见 §6.1。

### 1.1 改动落点

| 层 | 文件 | 改什么 |
|---|---|---|
| core | `packages/core/src/loop.ts` | `runTurn` step 循环开头检查 `abortSignal.aborted` → `finalizeTurn(status: 'interrupted')` + return |
| server | `agent/turn-runner.ts` | 每轮一个 `AbortController`；`stream(text, { signal })`；新增 `abortTurn()`；挂起的[人审通道](../terms.md)/ask-user 在停止时就地结掉 |
| server | `routes/chat.ts` | 新增 `POST /api/chat/conversations/{id}/abort` |
| server | `schemas/chat.ts` | 新增 `AbortTurnAckSchema` |
| web | `features/chat/api.ts` + `schema.ts` | `postAbortTurn()` + 响应解析 |
| web | `features/chat/use-chat-messages.ts` | `cancel`（假停止）→ `stopTurn`（真停止）+ `stopping` 态；`interrupted` 不再算 error |
| web | `components/message-composer.tsx` | 流式态的发送键变停止键 |
| web | `components/turn-marker.tsx` | `code: 'aborted'` 渲染成中性的「已停止」，不是 destructive |

**没有 DB 改动**：停止时清空[待发队列](../terms.md)用的是既有的 `conversations.queued_messages_json` 与既有的 `clearQueuedMessages()`，业务数据领域没有新实体、没有新关系。

## 2. core：step 边界的显式 abort 检查

`packages/core/src/loop.ts` 的 `runTurn`，for 循环开头（在 drain steer 队列与上下文估算**之前**）：

```ts
if (abortSignal.aborted) {
  const error: NimboError = { code: "aborted", message: "Turn aborted before this step began (host abort signal)." };
  yield finalizeTurn({ ..., status: statusForError(error), error });
  return { finalResponse, usage };
}
```

- `statusForError` 已经把 `code === 'aborted'` 映射成 `'interrupted'`（既有代码，`loop.ts`），所以状态语义无需新增。
- 检查点选在**循环开头**而不是每个 chunk 之后：一步之内的中止交给 AI SDK 的 `abortSignal`（模型流会被掐断、`streamText` 的 promise reject → 落进既有 catch → 同样是 `code: 'aborted'`），这里只保证「**绝不开始新的一步**」。两条路径产出的收尾形状一致。
- 工具执行中的中止同理：`ToolContext.abortSignal` 已经透传给工具（`runtime.ts`），bash 的 `exec()` 会以「失败即 ExecResult」的方式收尾（`docs/features/builtin-tools.md`），那一步正常结束，随后被本检查拦在下一步之前。

## 3. server：每轮一个 AbortController

### 3.1 `turn-runner.ts`

```ts
interface ActiveTurn {
  // …既有字段
  /** 这一轮的中止闸门——`startTurn` 建，`abortTurn` 触发，`session.stream(text, { signal })` 消费。 */
  abortController: AbortController;
  /** 已请求停止。幂等用，也是 `requestReview`/`requestUserAnswer` 的「别再挂新的」闸门。 */
  aborted: boolean;
}

export function abortTurn(conversationId: string): boolean;
```

`abortTurn` 的顺序是**硬要求**（每一步都有理由）：

1. 没有进行中的一轮 → 返回 `false`（路由转 409）。
2. `activeTurn.aborted === true` → 直接返回 `true`（幂等，连点无副作用）。
3. 置 `aborted = true`。**先置位再做后面的事**：它同时是 `requestReview`/`requestUserAnswer` 的闸门——停止后 core 若还为同一步里的其它并行工具调用请求审批（`loop.ts` 的 `mergeSettleStreams` 让一步内的多个工具调用并发结算），那些请求要立即被拒/超时，而不是挂到自己的 4 分钟超时。
4. 结掉**已经挂起**的审批与提问：`pendingReviews` 全部按 `deny`（理由文案说明是被停止）、`pendingQuestions` 全部按 `{ outcome: 'timeout' }`。不做这一步的话，一轮停在审批卡片上时 core 正 `await onReview`，abort 信号对它毫无作用——要等 `CHAT_APPROVAL_TIMEOUT_MS`（默认 240 秒）才动。**这是本功能唯一一处「abort 信号本身不够」的地方。**
5. `abortController.abort(new Error('Turn stopped by the user.'))`。

`TurnDrivenSession.stream` 的签名随之放宽为 `stream(input: string, opts?: { signal?: AbortSignal }): AsyncGenerator<NimboChunk, TurnResult>`——`@nimbo/core` 的 `Session.stream` 本就是这个形状（`TurnOptions`），测试用的 fake 忽略第二个参数也仍然满足接口（向后兼容，既有 fake 不改也能编译）。

### 3.2 `routes/chat.ts`：`POST .../abort`

```
POST /api/chat/conversations/{id}/abort
200 → { ok: true, queue: [] }     // AbortTurnAckSchema
404 → 会话不存在 / 不属于调用者
409 → 没有进行中的一轮（含「刚好自己结束了」的窄竞态）
```

handler 的顺序同样是硬要求：

1. `getConversation` → 404。
2. `isTurnActive(id)` 为假 → 409（**不做任何副作用**：没有轮在跑时清队列会让「误点停止」变成「丢消息」）。
3. `clearQueuedMessages(db, id)` + `broadcastQueue(id, [])`。
4. `abortTurn(id)`；`false` → 409。

**为什么清队列必须在 abort 之前**：`turn-runner.ts` 的 `onTurnSettled` 会在这一轮彻底结束后自动[出队](../terms.md)起下一轮（[steer-and-queue §3](./steer-and-queue.md)）。反过来（先 abort 再清）存在真实竞态——abort 解开挂起的审批后这一轮可能很快收尾，队首那条就被自动发出去了，而用户刚刚按的是「停止」。先清后 abort 则从结构上不可能：出队时队列已空。

**为什么广播要在这一轮还活着的时候发**：`broadcastQueue` 只对进行中那一轮的订阅者有效（emitter 关了就是无操作）。轮结束后前端也不会重连（`turnInProgressRef` 已翻假），所以这一帧必须趁 emitter 还开着发出去，否则界面待发区要等到下次刷新才清空。

**沙盒不额外 `touch`**：停止之后不再有活动，让它按既有的空闲超时自然休眠；心跳由既有的 `onTurnSettled → stopHeartbeat()` 停掉，无需改动。

## 4. web：真停止 + 中性呈现

### 4.1 hook（`use-chat-messages.ts`）

- 既有的 `cancel`（只 abort 本地 SSE 连接、把 status 拍成 idle，服务端那一轮照跑）**被删掉**，换成 `stopTurn()`：`POST .../abort`，**不做乐观状态翻转**——与审批「不做乐观翻转」同一姿态，界面状态只认 wire 上真实到达的那条 `message-metadata`。
- 新增 `stopping: boolean`：按下即置真（按钮进禁用态），在轮真正收尾（`onTurnEnd`）或请求失败时复位。
- **tail 不断开**：停止后仍要靠它接住 `interrupted` 那条 metadata 与后续帧。
- `409` 静默处理（这一轮已经结束了，不是错误）；其它失败进 `error`。
- `statusFromTurnEnd`：`interrupted` 归 **`'idle'`**（不是 `'error'`）；`errorFromTurnEnd` 对 `interrupted` 返回 `undefined`——「已停止」的呈现落在时间线那条标记上，不占用顶部那条红色的直播中断提示。
- 「队列非空 → 收尾后保持 streaming 等下一轮」这条既有逻辑**不用改**：停止路径下队列已被服务端清空并广播，`queuedMessagesRef` 是空的，自然落回 idle。（若用户在按下停止之后又发了一条消息——它会进队列，服务端也会照常自动出队起轮——这条逻辑仍然正确。）

### 4.2 停止键（`message-composer.tsx`）

流式态下右下角那颗按钮换语义（用户定案）：

- `status="streaming"` → ai-elements 的 `PromptInputSubmit` 自带方块图标。
- `type="button"` + `onClick={onStop}`——必须显式改掉默认的 `type="submit"`，否则点击会被 `PromptInput` 的 form 提交吃掉（那条路是「排队」）。
- `disabled={stopping}`，而**不是** `disabled={empty}`：流式期间即使输入框里有字也要能停。
- 空闲态完全不变（发送键、`disabled={empty}`、`type="submit"`）。
- 排队与插话两条路一个字都不改：Enter 仍走 form 提交 = 排队，Alt+Enter / 闪电按钮仍走 steer。

### 4.3 「已停止」的样子（`turn-marker.tsx`）

`TurnFailedBar` 目前把四种 `NimboError.code` 一律渲染成 destructive Alert（`aborted` 的标题已经是「已中止」）。改为 `aborted` 走**中性 Alert + 标题「已停止」**，正文用固定的中文文案，不把 core 那句英文 message 抛给用户（那是给日志看的）。其余三种 code 不变。

## 5. 时序图

### 5.1 主路径：跑到中途按停止

```mermaid
sequenceDiagram
    autonumber
    participant U as 用户（浏览器）
    participant R as routes/chat.ts
    participant TR as turn-runner.ts
    participant L as core loop（runTurn）
    participant S as 沙盒/模型

    Note over TR,L: 一轮正在跑（driveTurn 消费 session.stream）
    U->>R: POST .../abort
    R->>R: isTurnActive? 是
    R->>TR: clearQueuedMessages + broadcastQueue([])
    TR-->>U: SSE queue 帧（待发区清空）
    R->>TR: abortTurn()
    TR->>TR: aborted = true；结掉挂起的审批/提问
    TR->>L: abortController.abort()
    R-->>U: 200 { ok:true, queue:[] }
    L->>S: 当前 step 被掐断（模型流 reject / 工具收到 signal）
    L->>L: step 边界检查 aborted → finalizeTurn(interrupted)
    L-->>TR: message-metadata { status:'interrupted', error.code:'aborted' } → return TurnResult
    TR->>TR: finalizeTurnPersistence（消息落库 + chunk 行 GC + header）
    TR-->>U: SSE chunk 帧（interrupted metadata）
    TR->>TR: onTurnSettled → stopHeartbeat；队列已空，不出队
    U->>U: status → idle，时间线末尾「已停止」
```

### 5.2 停在审批卡片上按停止

```mermaid
sequenceDiagram
    autonumber
    participant U as 用户（浏览器）
    participant R as routes/chat.ts
    participant TR as turn-runner.ts
    participant L as core loop（settleToolCall）

    Note over L: loop 正 await onReview（人审通道），abort 信号对它无效
    U->>R: POST .../abort
    R->>TR: abortTurn()
    TR->>TR: pendingReviews 全部 resolve({ behavior:'deny' })
    TR->>L: 裁决送达（拒绝）
    TR->>L: abortController.abort()
    L-->>TR: tool-approval-response(approved:false) + tool-output-denied
    L->>L: 本步收尾 → step 边界检查 aborted → finalizeTurn(interrupted)
    L-->>TR: message-metadata { status:'interrupted' }
    Note over U: 卡片落成「已拒绝」，末尾「已停止」——无需等 4 分钟审批超时
```

## 6. 取舍与已知限制

### 6.1 为什么要改 core，而不是只靠 AI SDK 的 abort 行为

不改 core 也能停：abort 后当前 step 的 `streamText` 会 reject（或工具收到 signal 后本步正常收尾），loop 既有的 catch 会把它归成 `code: 'aborted'`。但「工具执行中被停止」这条路径下，本步是**正常收尾**的，loop 会照常进入下一步、再打一次模型调用，靠那次调用因 already-aborted 而抛错才停下来——多花一次钱，且停止时机取决于第三方库对已 abort signal 的处理细节。step 边界显式检查把这件事变成 nimbo 自己的确定性行为。这处改动不动任何 API，属 `patch`。

### 6.2 停止不是原子的

`POST .../abort` 返回 200 只代表「停止已请求」，不代表「已经停住」。真正停住的时刻由 §2.3 那张表决定（最坏情况是一条 bash 命令响应中断信号的时间）。界面因此用 `stopping` 态表达「正在停」，而不是立刻宣布已停。

### 6.3 已产出的内容一律保留

被停止的那一轮的半成品（已输出的文字、已完成的工具调用、已改的文件）全部留在账本与工作区里，也因此会进下一轮的[模型上下文](../terms.md)。这是刻意的：用户按停止是「别再往下做」，不是「假装没发生」。回滚是 git 的事，不在本功能内。

### 6.4 进程重启仍然会「静默丢轮」

`activeTurns` 是纯内存的（`turn-runner.ts` 文件头既有取舍）：服务端重启会让进行中的一轮无人驱动，那一轮既不会收到停止也不会自然收尾。本功能不改变这条既有限制，只是别再让它看起来像 bug——重启后页面回放会停在崩溃点，没有「已停止」标记（因为 `finalizeTurnPersistence` 从未跑）。

### 6.5 停止不清理沙盒

沙盒继续按既有空闲超时休眠（`SANDBOX_IDLE_TIMEOUT_MS`）。停止不销毁沙盒，因为下一条消息大概率马上就来，重建的代价远大于让它空转到超时。
