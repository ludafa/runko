# 单一数据账本：UIMessage 为唯一真相（P13-5，验证实验 P13-5a）

> 状态：实验方案待 review（2026-07-14，「唯一数据真相」被定为 P13 系列最高优先级，先于 checkpoint 施工）
> 相关：[docs/09](./09-turn-checkpoint-and-keepalive.md)（checkpoint 与保活——本实验若通过，其「对齐」语义将基于单账本简化）· [docs/02](./02-tech-spec.md) §4.3（手动 loop 选型——本实验不推翻它：loop 仍是 nimbo 自己的，换的是 loop 的**工作格式**）· [docs/08](./08-chat-agent-webapp.md)
>
> **术语（先读，正文不再解释）**：
> - **UIMessage**：AI SDK 定义的「给界面看的消息」类型。一条消息由若干**部件（part）**组成：文本部件、推理部件、工具部件、data 部件等。
> - **ModelMessage**：AI SDK 定义的「发给大模型的消息」类型，即模型服务商 API 实际接收的格式。
> - **官方转换器**：AI SDK 的 `convertToModelMessages()`——输入 UIMessage 数组，输出 ModelMessage 数组。由 Vercel 官方随 ai 包维护。
> - **data 部件（data part）**：UIMessage 里专门放「仅供界面使用的过程数据」的插槽（类型名形如 `data-xxx`，载荷自定义）。官方转换器转 ModelMessage 时**自动丢弃全部 data 部件**。同 id 的 data 部件后写覆盖先写（官方支持的更新语义）。
> - **临时部件（transient data part）**：标记为 transient 的 data 部件只走实时推送、**不进消息存档**——与 P13-1「过程帧只直播不落盘」是同一个概念的官方版。
> - **SDK 未发版**：nimbo 没有对外发布过任何版本，本方案不存在存量数据迁移与接口兼容问题。

## 0. TL;DR

**要验证的命题**：nimbo 的 loop 改用「UIMessage 数组」作为工作格式与唯一存档，每次调模型前用官方转换器现场推导 ModelMessage——从此全系统只有一种落盘数据，模型视图永远是推导的、从不单独存储。「当时喂给模型的」与「恢复后推导出的」出自同一段官方转换代码，一致性是结构保证。

**为什么先做实验再立项**：这是换 SDK 地基的决定。五个机械问题（推理往返、拒绝语义、多步等价、前缀缓存、中途插话）只能靠真机回答，纸上定案不可靠。实验通过 → 立项 P13-5 迁移 core；发现硬伤 → 硬伤本身就是「为什么不用」的实证记录。

## 1. 产品设计

### 1.1 要解决什么

今天有两本各自为政的落盘数据：事件表（`agent_events`，给界面回放）和模型消息存档（`nimbo_state_json`，给模型恢复记忆）。内容重叠但形状不同、写入路径不同，一致性靠写入纪律维持（P13 系列此前的对齐治理都是在管理这个结构的代价）。目标：**只存一种数据**，重叠、对齐治理、双写纪律全部消失。

### 1.2 成功后的形态（P13-5 正式立项的范围，本实验不实施）

- core：loop 的工作状态 = UIMessage 数组；`Session` 的存档/恢复 = UIMessage 数组的序列化；每步调模型前经官方转换器推导。
- SessionEvent/SessionItem 自有事件联合退役，宿主消费 UIMessage 部件流（nimbo 特有过程数据经 data 部件表达，见 §2.2 清单）。
- chat 应用：`nimbo_state_json` 字段消失；事件表只存 UIMessage 及其部件的落盘形态；web 时间线直接渲染部件。
- docs/01/02/09 相关架构表述修订。

### 1.3 判定标准

§2.4 的五个问题全部有可复现的真机答案；其中「前缀缓存」「多步等价」「拒绝语义」三项必须是**通过**，「推理往返」「中途插话」两项允许「有限制但可接受」并记录限制条款。任何一项硬伤（无法表达 / 字节不稳定 / 模型行为劣化）→ 不迁移，实验记录归档为决策依据。

## 2. 技术方案

### 2.1 实验形态

`examples/13-uimessage-single-ledger.e2e.test.ts`——**不动 packages/\***，直接用 ai 包（`streamText` + `convertToModelMessages` + UIMessage 类型）手写一个最小 loop，复刻 nimbo loop 的全部关键语义：

- 工具声明**不带 execute**（手动 loop，docs/02 §4.3 同款）：模型发起调用 → 实验代码自己执行 → 结果写回 UIMessage 的工具部件；
- 一个审批场景（脚本化 deny 一次 bash 调用）；一个 ask_user 场景（脚本化回答）；一次 steer（第二步边界注入用户插话）；
- 每轮结束把 UIMessage 数组序列化到 `.tmp/`（JSON 文件即可，实验不需要 sqlite）；
- **恢复路径**：新建 loop 实例，读回序列化的 UIMessage 数组 → 官方转换器 → 继续第二轮，验证模型带着完整记忆工作；
- 模型走 examples/shared 的 DeepSeek 配置（`loadRootDotEnv`）；用自定义 fetch 包装记录**发给服务商的原始请求体**（字节级对比的取证来源）。

### 2.2 部件清单：nimbo loop agent 的全部表达（应 review 要求逐项列出）

#### 2.2a 标准部件直接覆盖（不需要 data 部件）

| 今天的概念 | UIMessage 形态 | 说明 |
|---|---|---|
| agent_message（正文） | `text` 部件 | 流式增量走实时通道，落盘只存终稿（P13-1 结论平移） |
| reasoning（推理） | `reasoning` 部件 | 往返保真是 §2.4 验证项之一 |
| tool_call（全部工具：bash、文件八件套、update_plan、load_skill、ask_user、宿主自定义） | `tool-<名字>` 部件 | 状态机：input-streaming（入参流入）→ input-available（待执行/待审批）→ output-available（成功）/ output-error（失败） |
| tool_call 的 denied 状态 | `output-error` + 伴随 `data-approval` 终态 | 界面靠 data-approval 区分「被人拒绝」和「执行失败」；模型侧看到的措辞是 §2.4 验证项 |
| ask_user 的提问/回答 | 标准 `tool-ask_user` 部件 | **不需要** `data-question`：callId 就在部件里（今天 web 端「审批卡片对不上工具卡片」的痛点自动消失），pending=input-available、已答=output-available、超时=output-available（超时提示文案作为输出） |
| 步边界 | `step-start` 部件 | 官方内建，转换器据此切分 assistant/tool 消息 |
| 用户发言（含 steer 中途插话） | role=user 的 UIMessage | steer 用消息 metadata 标 `steered: true`（界面样式区分），转换器照常处理 |
| turn 收尾（turn.result：usage/finishReason） | assistant 消息的 **metadata** | metadata 不参与模型转换，天然只给界面 |
| turn 失败 / 中断哨兵（P13-3） | assistant 消息 metadata：`status: 'completed' \| 'failed' \| 'interrupted'` + error 文案 | |
| session.started / seq 时钟 | 不需要部件 | 会话行、落盘条目的序号是存储层的事，与消息格式无关 |

#### 2.2b 需要自定义 data 部件的（loop 的过程数据，转换器自动过滤，模型永远看不见）

| data 部件 | 载荷（示意） | 落盘？ | 同 id 更新 | 对应今天的什么 |
|---|---|---|---|---|
| `data-approval` | `{ id: callId, toolCallId, toolName, status: 'pending'\|'allowed'\|'denied'\|'timeout', message?, input }` | 是 | **是**：pending 先写，人裁决/超时后同 id 覆盖为终态 | `approval.requested` / `approval.resolved` 两个事件合并为一个部件的两个状态 |
| `data-file-change` | `{ changes: [{ path, kind: 'add'\|'update'\|'delete' }] }` | 是 | 否（每次工具执行各一条） | `file_change` 派生事件 |
| `data-plan-update` | `{ items: [{ text, completed }] }` | 是 | 可选（同 id 覆盖 = 计划面板始终最新） | `plan_update` |
| `data-error` | `{ message }` | 是 | 否 | SessionItem 的 error 变体（轮内非致命错误） |
| `data-sandbox` | `{ event: 'recreated', recovery: 'wip'\|'branch'\|'fresh', checkpointTurn?, stateTurn? }` | 是 | 否 | docs/09 计划中的 `sandbox.recreated` |
| `data-tool-progress` | `{ toolCallId, text（累积） }` | **否（transient）** | 是 | `ctx.update()` 的执行中进度——今天 P13-1 的「过程帧」，官方 transient 语义精确对应 |

清点完毕：**六个 data 部件（一个 transient），其余全部由标准部件与消息 metadata 覆盖**。今天 wire 层的 `user.message` 回显、`turn.result`/`turn.failed` 哨兵、`question.asked/answered` 四对事件全部不再需要独立存在。

### 2.3 存储与传输草图（实验只验证消息格式；此节供 P13-5 立项参考）

- 落盘 = 「UIMessage 及其部件」的按序条目（沿用序号时钟与追加式写入）；实时推送 = 官方 UI 消息流协议（文本增量、部件更新、transient 部件）；断线重连 = 从序号续传落盘条目 + 接上直播。P13-1 的「过程帧不落盘」结论原样平移（文本增量与 transient 部件只直播）。
- 恢复模型记忆 = 读 UIMessage 数组 → 官方转换器。没有第二条路径。

### 2.4 五个验证项（每项都要有可复现断言 + 真机记录）

| # | 名称 | 做法 | 通过标准 |
|---|---|---|---|
| 1 | **推理往返** | 第一轮让模型产出 reasoning + 工具调用；存档→读回→转换→第二轮。取证：两轮的原始请求体 | DeepSeek 对多轮对话中历史 reasoning 的要求被满足（保留或按其协议正确省略），第二轮请求合法、模型行为正常 |
| 2 | **拒绝语义** | 脚本 deny 一次 bash 调用（output-error + errorText=拒绝理由）| 转换器生成的工具结果消息里，拒绝理由完整可见；模型的后续反应是「理解被拒、改变方案」而非「当作工具故障盲目重试」 |
| 3 | **多步等价** | 一轮内：文本 + 两步、每步各 1-2 个工具调用。对比转换器输出与今天 nimbo loop 手拼的消息结构 | assistant（含 tool-call 部件）→ tool（结果）→ assistant … 的分组与顺序等价；step-start 切分正确；无内容丢失 |
| 4 | **前缀缓存** | 连续两轮；逐字节对比第二轮请求体的前缀与第一轮的「请求+响应」；看 DeepSeek 返回的 cachedInputTokens | 前缀逐字节一致；第二轮 cachedInputTokens > 0（真机信号） |
| 5 | **中途插话（steer）** | 第一步结束后注入用户消息，assistant 在新消息中继续 | 转换后消息序列合法（user 消息正确插在步边界），模型确认收到插话；界面侧 metadata 可区分「插话」与「新轮」 |

另加两条**结构断言**（离线可跑，不需要真机）：转换器输出中不含任何 data 部件；transient 部件不出现在序列化存档里。

## 3. 施工计划

- **P13-5a-1 实验实现（coder）**：按 §2.1/§2.2/§2.4 写 `examples/13-uimessage-single-ledger.e2e.test.ts` + 必要的 shared 辅助（请求体取证的 fetch 包装）。离线部分（mock 模型走结构断言）进常规测试；真机部分沿 examples 现有 e2e 门控约定（缺凭证即跳过）。验收：typecheck/lint 过、离线断言绿、真机路径可一键执行并在结束时打印五项验证的逐项结果。
- **P13-5a-2 真机执行（用户）**：跑真机路径，把五项结果回填进本文档 §4（表格已留好）。
- **P13-5a-3 判定（主线程）**：按 §1.3 标准给 go/no-go；go → 立项 P13-5（core 迁移另行拆单，粒度：core loop/session/state 改造 → chat server → web → docs 修订）；no-go → 硬伤记录归档，回退到 docs/09 讨论过的「同账本双条目」方案。

## 4. 实验记录（P13-5a-2 回填）

| # | 验证项 | 结果 | 证据/备注 |
|---|---|---|---|
| 1 | 推理往返 | 待填 | |
| 2 | 拒绝语义 | 待填 | |
| 3 | 多步等价 | 待填 | |
| 4 | 前缀缓存 | 待填 | |
| 5 | 中途插话 | 待填 | |
| 6 | 结构断言（离线） | 待填 | |

**判定**：待填（go / no-go + 限制条款）
