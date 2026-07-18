# 单一数据账本（single-ledger）— 施工进展

> **相关**：产品手册见 [features/single-ledger](../features/single-ledger.md)；技术方案见 [tech/single-ledger](../tech/single-ledger.md)。
> **依赖**：本功能改造 [chat-webapp](./chat-webapp.md) 的持久化层。

## 历史 banner（原始状态记录）

> 状态（2026-07-14）：实验方案待 review。「唯一数据真相」被定为 P13 系列最高优先级，先于 checkpoint 施工。
>
> 相关（原始 docs/09·docs/tech/core-sdk.md §4.3·docs/08，迁移后指向）：[turn-checkpoint 计划](./turn-checkpoint.md)（checkpoint 与保活——本实验若通过，其「对齐」语义将基于单账本简化）· [core-sdk 的手动 loop 选型](../tech/core-sdk.md)（本实验不推翻它：loop 仍是 nimbo 自己的，换的是 loop 的**工作格式**）· [chat-webapp](./chat-webapp.md)（chat 应用）。
>
> 状态（2026-07-15）：P13-5-1..6 已全部交付，改动累积工作区（未 commit）。审批最终定案为**三值重构**（P13-5-2c），取代了初定的「用 ai@7 原生审批状态机（事后编码）」——原生事后编码对模型恢复正确、对直播交互失效。

## 1. 为什么先做实验再立项

这是换 SDK 地基的决定。五个机械问题（推理往返、拒绝语义、多步等价、前缀缓存、中途插话）只能靠真机回答，纸上定案不可靠。实验通过 → 立项 P13-5 迁移 core；发现硬伤 → 硬伤本身就是「为什么不用」的实证记录。

## 2. 验证实验 P13-5a

### 2.1 实验形态

`examples/13-uimessage-single-ledger.e2e.test.ts`——**不动 packages/\***，直接用 ai 包（`streamText` + `convertToModelMessages` + [UIMessage](../terms.md) 类型）手写一个最小 [loop](../terms.md)，复刻 nimbo loop 的全部关键语义：

- 工具声明**不带 execute**（手动 loop）：模型发起调用 → 实验代码自己执行 → 结果写回 UIMessage 的工具部件；
- 一个审批场景（脚本化 deny 一次 bash 调用）；一个 ask-user 场景（脚本化回答）；一次 [steer](../terms.md)（第二步边界注入用户插话）；
- 每轮结束把 UIMessage 数组序列化到 `.tmp/`（JSON 文件即可，实验不需要 sqlite）；
- **恢复路径**：新建 loop 实例，读回序列化的 UIMessage 数组 → 官方转换器 → 继续第二轮，验证模型带着完整记忆工作；
- 模型走 examples/shared 的 DeepSeek 配置；用自定义 fetch 包装记录**发给服务商的原始请求体**（字节级对比的取证来源）。

### 2.2 五个验证项（每项都要有可复现断言 + 真机记录）

| # | 名称 | 做法 | 通过标准 |
|---|---|---|---|
| 1 | **推理往返** | 第一轮产出 reasoning + 工具调用；存档→读回→转换→第二轮。取证：两轮原始请求体 | DeepSeek 对历史 reasoning 的要求被满足（保留或按协议正确省略），第二轮请求合法、模型行为正常 |
| 2 | **拒绝语义** | 脚本 deny 一次 bash 调用（output-error + errorText=拒绝理由） | 转换器生成的工具结果里拒绝理由完整可见；模型「理解被拒、改变方案」而非盲目重试 |
| 3 | **多步等价** | 一轮内：文本 + 两步、每步各 1-2 个工具调用。对比转换器输出与旧 nimbo loop 手拼结构 | assistant→tool→assistant… 的分组与顺序等价；step-start 切分正确；无内容丢失 |
| 4 | **前缀缓存** | 连续两轮；逐字节对比第二轮请求体前缀与第一轮的「请求+响应」；看 cachedInputTokens | 前缀逐字节一致；第二轮 cachedInputTokens > 0（真机信号） |
| 5 | **中途插话（steer）** | 第一步结束后注入用户消息，assistant 在新消息中继续 | 转换后序列合法（user 消息正确插在步边界）；模型确认收到；界面 metadata 可区分「插话」与「新轮」 |

另加两条**结构断言**（离线可跑）：转换器输出中不含任何 data 部件；transient 部件不出现在序列化存档里。

### 2.3 判定标准（验收）

上表五项全部有可复现真机答案；其中「前缀缓存」「多步等价」「拒绝语义」三项必须**通过**，「推理往返」「中途插话」两项允许「有限制但可接受」并记录限制条款。任何一项硬伤（无法表达 / 字节不稳定 / 模型行为劣化）→ 不迁移，实验记录本身即「为什么不用」的实证依据。

### 2.4 实验拆单（P13-5a）

- **P13-5a-1 实验实现（coder）**：按 §2.1/§2.2/[部件清单](../tech/single-ledger.md) 写 `examples/13-uimessage-single-ledger.e2e.test.ts` + 必要的 shared 辅助（请求体取证的 fetch 包装）。离线部分（mock 模型走结构断言）进常规测试；真机部分沿 examples 现有 e2e 门控约定（缺凭证即跳过）。验收：typecheck/lint 过、离线断言绿、真机路径可一键执行并在结束时打印五项验证的逐项结果。
- **P13-5a-2 真机执行（用户）**：跑真机路径，把五项结果回填进 §3。
- **P13-5a-3 判定（主线程）**：按 §2.3 标准给 go/no-go；go → 立项 P13-5（core 迁移，粒度：core loop/session/state → chat server → web → docs 修订）；**no-go → 硬伤记录归档，回退到 [turn-checkpoint 计划](./turn-checkpoint.md)讨论过的「同账本双条目」方案**。

## 3. 实验记录（2026-07-14 回填；coder 多次重跑 + 主线程独立复跑，结果一致）

| # | 验证项 | 结果 | 证据/备注 |
|---|---|---|---|
| 1 | 推理往返 | **通过（有限制条款）** | 第一轮产出 6 段 reasoning；第二轮请求体**省略历史 reasoning**（DeepSeek OpenAI 兼容协议不要求携带历史推理），HTTP 200 合法、模型行为正常。限制条款：跨轮推理内容不回传属服务商协议行为，非账本损失——账本里 reasoning 部件完整保存，界面回放不受影响 |
| 2 | 拒绝语义 | **通过** | 转换器为 output-error 生成 `{"type":"tool-result","output":{"type":"error-text","value":"<拒绝理由全文>"}}`，理由完整可见；模型明确「理解被拒、调整方案」（原话：先完成不依赖 bash 的步骤，第 5 步换一条不同命令），非盲目重试 |
| 3 | 多步等价 | **通过** | 转换器输出的 ModelMessage 序列 `assistant(reasoning,text,tool-call) → tool(tool-result) → …` 分组与顺序断言通过（6 步 6 次工具调用） |
| 4 | 前缀缓存 | **通过** | 第二轮请求 messages 前缀与第一轮末次请求**逐字节一致**；DeepSeek 原始 usage：第二轮 `prompt_cache_hit_tokens: 2048`（真机缓存命中信号确认）。方法论教训：system 消息必须包含在「不变前缀」内——两轮 instructions 不同会直接毁掉缓存（实验初版踩过） |
| 5 | 中途插话 | **通过** | steer 的 user 消息正确落在第一步 assistant 消息之后；模型确认收到、并在第二轮总结中践行了插话要求（首句「任务完成」） |
| 6 | 结构断言（离线） | **通过** | 转换产物无任何 data 部件；transient 进度只走直播回调、从未进 parts/序列化 JSON（无凭证环境可复现） |

**判定：GO**——三项硬性要求（前缀缓存/多步等价/拒绝语义）全部通过，两项弹性要求一项通过、一项带限制条款通过。P13-5（core 迁移）具备立项条件。

### 3.1 实验发现（P13-5 立项时必须消化，技术细节见 [tech/single-ledger](../tech/single-ledger.md) §7/§8）

- **发现 A**：transient 是线协议属性而非落盘字段，实现必须写入期分流。
- **发现 B（审批的替代机制）**：ai@7 自带原生审批状态机（`approval-requested`/`approval-responded`/`output-denied`）——与自建 `data-approval` 是两条都可行的路。**需要一次专门评估**（最终定案见 §5 三值重构）。
- **发现 C**：「多步等价」看转换器输出的 ModelMessage 层；服务商线上 JSON 形状不同属 provider 序列化职责，只有「前缀缓存」才需要看线上字节。
- **实现教训**：同一 toolCallId 的占位态与结算态不能都 push 进 assistant 消息（DeepSeek 400 `Duplicate value for 'tool_call_id'`）——账本里工具部件只记最终结算态。

## 4. P13-5 迁移施工计划（2026-07-14 GO 判定后立项）

依赖顺序串行施工，每单收尾双端管线全绿（typecheck/lint/test）；本会话不 commit，改动累积工作区：

1. **P13-5-1 工具改名（coder，纯机械）**：全部工具名 kebab-case，涉及 packages/core、sdk、apps 两端与全部测试；文档正文留到 P13-5-6。
2. **P13-5-2 core 账本迁移（coder，关键路径）**：`SessionState.messages` 改 `NimboUIMessage[]`（`validateSessionMessages` 校验恢复）；loop 工作态 = UIMessage 数组，每步 `convertToModelMessages` 推导；`session.stream()` 改吐 ai 的 `UIMessageChunk`（含 nimbo data 部件）；file_change/plan_update/error → `data-file-change`/`data-plan-update`/`data-error`；工具进度 transient 写入期分流；同一 toolCallId 只记结算态；steer = 步边界注入 metadata 标记的 user UIMessage；`SessionEvent`/`SessionItem` 退役。
3. **P13-5-2c core 审批重构**（返工，插在 P13-5-2 之后、P13-5-3 之前，见 §5）。
4. **P13-5-3 server（coder）**：`nimbo_state_json` 字段删除（drizzle 迁移）；`agent_events` 两类条目 message + chunk；回放算法 = 完工消息 + 进行中消息耐久块；turn-runner 审批/提问桥改为翻转工具部件状态；`GET events` 返回 `{ frames }`；openapi 重生成。
5. **P13-5-4 web（coder）**：[kubb 重生成](../terms.md)；timeline 改渲染 UIMessage 部件（审批卡片由 `tool-approval-request` 驱动、提问卡片由 `tool-ask-user` 部件驱动——callId 对不上的旧痛点消失）。
6. **P13-5-5 测试补强（tester）**：两端新语义覆盖（原生审批状态流转、账本恢复字节一致、chunk/message 回放、transient 不落盘）。
7. **P13-5-6 文档修订（主线程）**：docs/01/02/03/04/08/09/10 相关表述同步。

## 5. 审批 API 三值重构（P13-5-2c，2026-07-15 用户定案）

P13-5a 实验发现 B 与随后的集成分析共同推翻了 §4 第 2 单「原生编码 = 事后补记」的做法——**事后补记只对模型恢复正确，对直播交互失效**（挂起等人审期间界面看不到待审批、无法弹卡片，人在环上功能实质失效）。

**定案：审批判定三值化，且在阻塞之前显式产出。** 详细方案（三值表、`ApprovalPolicy`/`ApprovalOutcome`/`HumanDecision` 类型、两层组合、两值裁决、删 `updatedInput`）见 [tech/single-ledger](../tech/single-ledger.md) §5。

对施工计划的影响——§4 第 2 单已交付的「事后补记 deny 三态」返工为「先发后阻塞」，新增 P13-5-2c，逐点落地：

- `types.ts`：`ApprovalPolicy` 三值化 + `ApprovalOutcome`/`HumanDecision` 类型；删 `ApprovalDecision.updatedInput`。
- `approval.ts`：`evaluateApproval` 产出 `ApprovalOutcome`（不再是 allow/deny 二值 decision）；两层组合、once 记忆、无仲裁者语义保留。
- `runtime.ts` / `loop.ts`：拆「审批解析」与「工具执行」为两步，loop 在解析出 `review` 时**先 yield `tool-approval-request` chunk 再 await 人工裁决**（经 session 的人审通道 `onReview`），allow/deny 都 yield `tool-approval-response`；删 updatedInput 分支。
- P13-5-3 server：`gateWorkspace` 把 bash 危险命令清单塞进注入的分类器（返回 allow/review），审批桥变纯「登记待处理 + 阻塞 + 收 HTTP 裁决」；`approval-policy.ts` 的 `shouldAutoAllow` 改写为返回 `ApprovalOutcome` 的分类器。

## 6. 迁移完成状态（2026-07-15）

P13-5-1..6 六单串行交付完毕，改动累积工作区（本会话不 commit）。各单落地：

| 单 | 交付 | 状态 |
|---|---|---|
| P13-5-1 工具改名 | 全部工具名 snake_case → kebab-case（`read-file`/`write-file`/`edit-file`/`delete-file`/`move-file`/`list-dir`/`update-plan`/`load-skill`/`ask-user`；`bash`/`glob`/`grep` 不变），core/sdk/两端 apps 与全部测试一并更新 | ✅ |
| P13-5-2 core 账本迁移 | `SessionState.messages` 改 `NimboUIMessage[]`（`validateSessionMessages` 恢复）；loop 工作态 = UIMessage 数组，每步 `convertToModelMessages` 推导；`session.stream()` 改吐 `UIMessageChunk`（含 nimbo data 部件）；file_change/plan_update/轮内错误 → data 部件；工具进度 transient 写入期分流；同一 toolCallId 只记结算态；steer 注入 metadata；`SessionEvent`/`SessionItem`/`TurnResult.items` 退役 | ✅ |
| P13-5-2c core 审批重构 | `ApprovalPolicy` 三值化 + `ApprovalOutcome`/`HumanDecision`；删 `ApprovalDecision.updatedInput`；loop 解析出 `review` 时先 yield `tool-approval-request` 再阻塞、经 `onReview` 等裁决，allow/deny 都 yield `tool-approval-response`；两层组合、review-once、无仲裁者 deny 语义保留 | ✅ |
| P13-5-3 server | 删 `nimbo_state_json`（drizzle 迁移）；`agent_events` 两类条目 message + chunk；回放 = 完工消息 + 进行中消息耐久帧；turn-runner 审批/提问桥翻转工具部件状态；`GET events` 返回 `{ frames }`；openapi 重生成 | ✅ |
| P13-5-4 web | kubb 重生成；timeline 渲染 UIMessage 部件（审批卡片 ← `tool-approval-request`、提问卡片 ← `tool-ask-user`，callId 旧痛点消失） | ✅ |
| P13-5-5 测试补强 | 两端新语义覆盖（原生审批状态流转、账本恢复字节一致、chunk/message 回放、transient 不落盘） | web 端收口中 |
| P13-5-6 文档修订 | docs/01/02/03/04/08/09/10 相关表述同步 | ✅ |

**最终测试数**：core + 外围包 **928**、server **153**、web 待 P13-5-5 收口、`examples/13-uimessage-single-ledger.e2e.test.ts` 为验证实验（离线断言常绿、真机门控）。

### 6.1 §3.1 发现的落地

- **发现 A（transient 写入期分流）**：已按「进度只走直播回调、不 push 进 parts」实现，落盘 `UIMessage.parts` 无 transient 字段。
- **发现 B（原生审批 vs 自建 `data-approval`）**：二选一之外走了第三条——§5 三值重构，用 ai 原生审批 chunk 但把「要不要人审」的判定提到工具执行之前显式产出。`data-approval` 未建。
- **发现 C（验证层次）**：多步等价看转换器输出的 ModelMessage 层、前缀缓存看服务商线上字节——已分别在恢复字节一致与 chunk/message 回放用例中体现。
- **实现教训（同一 toolCallId 不能出现两次）**：账本工具部件只记最终结算态，进行中状态走直播，已落地。

## 7. 已知取舍

- **crash mid-turn（无收尾）**：本轮无 message 条目、chunk 条目残留——`finalizeTurnPersistence` 未运行、header 未写。属可接受残留，不再清理（技术细节见 [tech/single-ledger](../tech/single-ledger.md) §6）。
- **进程重启掉 `activeTurns`**：纯内存，服务重启中途轮被静默丢弃；已落盘的行留着，下次 `GET .../stream` 回放到崩溃点为止。v1 的既定取舍。
- **进度非严格实时交错**：`ctx.update()` 进度缓冲后重放，不与执行严格实时交错（沿用 P13-1 取舍）。
- **跨轮 reasoning 不回传**：服务商协议行为，账本完整保存、界面回放不受影响。
