---
"@runko/core": minor
---

新入口 `session.settleAndRun(callId, settlement)`：把挂起留下的那次悬空调用结清，然后接着跑。人几小时后回来点「允许」，走的就是它。

这是挂起与恢复（路线图 K3）在 core 这一侧的恢复入口；「人回来时怎么找到那个会话、在哪个副本上恢复」见同批 `@runko/agent` 的那条。

**三种结清方式**，要跟那条悬空部件的状态对得上：

| 部件停在 | 给什么 | 发生什么 |
|---|---|---|
| `approval-requested`（人审通道答了 `suspend`） | `{ kind: "approval", behavior: "allow" }` | **用账本里原封不动的入参执行**。不再走审批链（人已经批准了），但会重新过一遍 `inputSchema`——工具换了版本、不再接受旧参数时记一次 `output-error`，不硬执行 |
| 同上 | `{ kind: "approval", behavior: "deny", message? }` | 不执行，理由回填给模型 |
| `input-available`（工具调了 `ctx.suspend()`） | `{ kind: "output", output }` | 给的值就是这次调用的输出，不重新执行工具。声明了 `outputSchema` 的会校验 |
| `approval-responded`（审批通过后执行时又挂起） | `{ kind: "output", output }` | 同上，并保留审批痕迹 |

**恢复轮的第一步不调模型**：先执行（或拒绝、或填输出），模型看到结果才上场。所以恢复轮里的模型想换个参数也无从换起——执行的就是人批准的那一条。

**结清之后同一条消息里还有悬空调用**（一步里多个调用同时挂起，或者刚结清的那个执行时又挂起了）：不调模型，直接以 `suspended` 收尾，`suspended.callIds` 是剩下的那些。

**它原地改写那条消息**（id 不变）——那条恒为开轮时的最后一条。所以宿主落盘时要从它开始切：它以新 seq、同 id 追加，读账本时按 `message.id` 折叠（位置取首次、内容取最新）。

**`stream()` 多了一道守卫**：最后一条消息里有悬空调用时，`stream()` 直接抛 `RunkoResumeError`（`code: "pending_calls"`），不再把请求发给模型。实测过：悬空调用只产出 `tool-call`、没有 `tool-result`，后面再接一条 user 消息，Anthropic 与 OpenAI 兼容两家都会 400——与其让它回一个看不懂的错，不如在本地说清楚。

**`send()` 认得出挂起**：`TurnResult` 多了可选的 `suspended: { callIds, reason? }`，这一轮挂起时才有。带 `outputSchema` 时遇到挂起直接抛 `RunkoResumeError`（`pending_calls`）——挂起的一轮没有最终答复可结构化，拿悬空的历史去调模型只会 400。

**恢复轮在调模型之前就收尾**（结清之后被停止、或者又挂起）时，收尾 metadata 并在上一轮那条消息上（悬空调用只能在最后一条），上一轮留下的 `suspended` 会被去掉或覆盖，不会出现「状态是已停止、却还带着 suspended」这种自相矛盾。

**⚠️ `Session` 多了必需方法 `settleAndRun`**：自己实现 `Session` 接口的代码要补上（用 `createSession` 的不受影响）。

**用错了就抛 `RunkoResumeError`，不算一轮**（轮号不动、不出 chunk）：`pending_calls` / `call_not_found` / `not_pending`（已经有结果了，比如重复恢复）/ `settlement_mismatch`（种类对不上）。

**新导出**：`Settlement`、`RunkoResumeError`、`pendingCallIds(messages)`（宿主拿它判断「这个会话现在能不能开普通轮」）、`resolveResumeTarget`。

**轮统计不骗人**：`toolDurationMs` 现在只数本轮开始之后才开始执行的区间。普通轮不受影响；恢复轮只算恢复时执行的那一段，等人的时间哪一轮都不算。
