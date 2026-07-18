# 单一数据账本（single-ledger）— 功能手册

> **相关**：技术方案见 [tech/single-ledger](../tech/single-ledger.md)；施工进展见 [plans/single-ledger](../plans/single-ledger.md)。
> **依赖**：本功能改造 [chat-webapp](./chat-webapp.md) 的持久化层（把它原来的双份落盘换成单账本）。下游的 [上下文压缩（compaction）](./compaction.md) 在本功能的账本上再加第三种条目。

本文面向使用者与集成方，讲清楚「单一数据账本」给用户和开发者解决了什么问题、怎么用、边界在哪、怎样算成功。实现细节（数据结构、写入时序、图）在 [tech/single-ledger](../tech/single-ledger.md)。

## 1. 解决什么问题

在此之前，一个 [会话（session）](../terms.md) 的落盘数据有**两本各自为政**：

- 事件表（`conversation_events`），给界面[回放（replay）](../terms.md)；
- 模型消息存档（`nimbo_state_json` 字段），给[模型上下文（模型记忆）](../terms.md)恢复。

两本内容重叠、形状不同、写入路径不同，一致性只能靠写入纪律维持——「当时喂给模型的」和「刷新后恢复出来的」是否一致，全靠人不写错。

单一数据账本把落盘收敛成**一种**数据：一个会话只有一张按 [seq（序号）](../terms.md) 递增的[账本（ledger）](../terms.md)，**既供界面回放、又供模型恢复记忆**。账本里存的是 [UIMessage](../terms.md)（「给界面看的消息」），每次调模型前用 AI SDK 的[官方转换器（`convertToModelMessages`）](../terms.md)现场推导出 [ModelMessage](../terms.md)（「发给模型的消息」）——模型视图永远是**推导**出来的，从不单独存储。

**结果**：「当时喂给模型的」与「恢复后推导出的」出自同一段官方转换代码，一致性从「靠纪律」变成「结构保证」。重叠、对齐治理、双写纪律全部消失。

## 2. 用户可见的行为

单一数据账本是一次地基重构，但它落到聊天界面上有几个能直接感知的改善：

- **刷新页面不丢挂起状态**：一轮跑到一半时（比如 agent 正等你审批一条危险命令）刷新页面或断线重连，界面能从账本**重建出那张挂起的[审批卡片](../terms.md)/提问卡片**——因为进行中消息的关键状态（审批态、工具输入输出、[data 部件](../terms.md)、步标记）作为「耐久块」落了盘。只有打字增量、推理增量、进度这些[transient（只直播不落盘）](../terms.md)的东西刷新后不重建（它们本就只在直播时有意义）。
- **断线续传**：重连时带上你已经收到的最后一个 `seq`（`after=<seq>`），服务端先把缺的历史补齐、再接上[直播流](../terms.md)，不重不漏。
- **审批卡片不再「对不上」**：提问（`ask-user`）与其回答的关联信息（`callId`）就在消息部件里，界面「审批卡片对不上工具卡片」的旧痛点自动消失。
- **一致的历史**：界面看到的完整历史与模型记得的历史同源，不会出现「界面显示做过、模型却不记得」（或反之）的错位。

### 审批交互（[人在回路，human-in-the-loop](../terms.md)）

agent 要做敏感操作（跑危险命令等）时会停下来等你点「允许 / 拒绝」。从用户角度看：

- **安全命令一次卡片都不闪**：只有被判定为「需人审」的调用才会弹卡片、停下来；安全命令直接执行。
- **挂起时立刻可见**：一旦某个调用需要人审，审批卡片会**立刻**出现在界面上（不是等 agent 忙完才补一张）——你能在 agent 真正阻塞、等你的那一刻就看到它。
- **卡片只有两个动作**：**允许** 或 **拒绝（可附一句理由）**。没有「编辑参数后再运行」的口子；想让它换个做法，用「拒绝 + 理由」或直接[插话（steer）](../terms.md)更直白。
- **一次批准，本会话记住**：对配了「批准一次即可」策略的工具，你批准后同一工具在本会话内的后续调用直接放行（[会话级授权（session grant）](../terms.md)），会话结束即失效。
- **无人应答会超时**：挂起的审批/提问在默认约 4 分钟（`CHAT_APPROVAL_TIMEOUT_MS` / `CHAT_ASK_USER_TIMEOUT_MS`）后自动按「拒绝 / 超时」处置，避免一直卡住占着沙盒。

## 3. 开发者接口

### 3.1 `@nimbo/core` SDK（产品视角）

- **账本即工作态**：[loop](../terms.md) 的工作状态就是 `NimboUIMessage[]`；[`SessionState`（`session.toJSON()`）](../terms.md) 的 `messages` 也是 `NimboUIMessage[]`。存档 = 序列化这个数组，恢复 = 读回它 → 官方转换器，没有第二条路径。
- **标准流协议**：`session.stream()` 吐出的 [chunk（流块）](../terms.md) 就是 AI SDK 的「UIMessage 流」协议词汇（`NimboChunk`）——文本增量、工具状态变化、data 部件等。**任意 AI SDK 兼容的客户端都能直接消费**，不需要 nimbo 自定义的 wire 事件。
- **三值审批策略**：审批策略是「挂在工具上或注入会话的规则」，对一次工具调用产出[审批结果（三值）](../terms.md)之一——`allow`（直接跑）/ `review`（弹卡片停下等人）/ `deny`（直接拒绝）。策略可以是固定值，也可以是一段分类逻辑（回调 `(input, ctx) => ApprovalOutcome`）。会话级注入的[审批分类器](../terms.md)就是这个回调，chat 应用把危险命令清单放这里。
- **两值人工裁决**：`review` 弹给真人的卡片，真人只答两值：`{ behavior: 'allow' }` 或 `{ behavior: 'deny'; message? }`。「改参数」（`updatedInput`）已删除。

### 3.2 对外 REST API（chat 服务端，产品视角）

七个端点（全部需登录）。事件**不从这些请求的响应体里回**，而是统一走 `GET .../stream`：

| 端点 | 作用 |
|---|---|
| `POST /api/chat/conversations` | 建会话（顺带开一个 Vercel 沙盒 + 专用 git 分支） |
| `GET /api/chat/conversations` | 列出当前用户的会话 |
| `GET /api/chat/conversations/{id}` | 取单个会话详情（含 `active`/`sleeping`/`expired` 状态） |
| `POST /api/chat/conversations/{id}/messages` | 发一条消息：若本会话有轮在跑，则[插话（steer）](../terms.md)注入（`mode: "steered"`）；否则起一个新轮（`mode: "started"`）。返回 202 ack，事件走 stream |
| `GET /api/chat/conversations/{id}/stream?after=<seq>` | 可续传的直播尾巴（SSE）：先回放 `after` 之后的历史帧，再转发本轮的实时 chunk 直到本轮结束。刷新/断线安全 |
| `GET /api/chat/conversations/{id}/events?after=<seq>` | 纯回放：按 seq 顺序返回持久化的账本帧（`{ frames }`） |
| `POST /api/chat/conversations/{id}/approvals/{callId}` | 批准/拒绝一个挂起的审批，结果经 stream 的 `tool-approval-response` chunk 送达，本响应只是 ack |
| `POST /api/chat/conversations/{id}/questions/{callId}` | 回答一个挂起的 `ask-user` 提问，结果经 stream 的 `tool-ask-user` 部件 `output-available` 状态送达，本响应只是 ack |

回放帧有两类：`{ seq, message }`（一条完工的 `NimboUIMessage`）与 `{ seq?, chunk }`（一个 `NimboChunk`）。瞬时 chunk 的帧不带 `seq`（不落盘、不回放）；其余帧都带 `seq`。

## 4. 范围与非目标

**范围（P13-5 立项落地后的形态）**：

- core：loop 工作态 = UIMessage 数组；`SessionState` 存档/恢复 = UIMessage 数组的序列化；每步调模型前经官方转换器推导 ModelMessage。
- core：自有的 `SessionEvent`/`SessionItem` 事件联合退役，宿主改为消费 UIMessage 部件流（nimbo 特有的过程数据用 data 部件表达）。
- chat 应用：`nimbo_state_json` 字段消失；账本只存 UIMessage 及其部件的落盘形态；web 时间线直接渲染部件。

**非目标**：

- **不推翻手动 loop 选型**：loop 仍是 nimbo 自己实现的循环（不外包给 AI SDK 现成的 loop）；换的只是 loop 的**工作格式**（从手拼 ModelMessage 改为 UIMessage 数组 + 官方转换器）。
- **不处理存量迁移/接口兼容**：nimbo SDK 从未对外发版，不存在存量数据迁移与老接口兼容问题（一次性全局改名、删字段皆可）。
- **不自建审批过程数据部件**：审批链最终采用 AI SDK 原生的审批状态机（`tool-approval-request`/`tool-approval-response`/`output-denied`），不新建 `data-approval` 部件（曾评估过，见 tech 的实验发现 B）。
- **不保留「改参数」审批口子**：人工裁决纯两值，删除 `updatedInput`。

## 5. 成功标准

单一数据账本是「换 SDK 地基」的决定，因此先做真机验证实验（P13-5a）再立项迁移（P13-5）。判定标准是[五个验证项](../plans/single-ledger.md)全部有可复现的真机答案，且其中三项**硬性通过**、两项允许「有限制但可接受」：

| 验证项 | 要求 |
|---|---|
| 前缀缓存 | **必须通过**：连续两轮请求体前缀逐字节一致，且真机命中缓存 |
| 多步等价 | **必须通过**：官方转换器输出的消息分组/顺序与旧 loop 手拼结构等价 |
| 拒绝语义 | **必须通过**：拒绝理由完整到达模型，模型「理解被拒、改变方案」而非盲目重试 |
| 推理往返 | 允许「有限制但可接受」并记录限制条款 |
| 中途插话（steer） | 允许「有限制但可接受」并记录限制条款 |

任何一项出现硬伤（无法表达 / 字节不稳定 / 模型行为劣化）→ 不迁移，实验记录本身即「为什么不用」的实证依据。

> 判定结论：**GO**（三项硬性全过，两项弹性一项通过、一项带限制条款通过）。逐项真机记录见 [plans/single-ledger](../plans/single-ledger.md) 的实验记录。
