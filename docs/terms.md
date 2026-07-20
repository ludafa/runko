# 术语表（nimbo / chat 应用）

> 目的：这个项目讨论里反复出现的词，在这里给一句话的大白话定义。写文档、讨论、代码注释引用术语时，以本表为准；本表没有的词不要临时造。发现有人（包括 AI）用了没定义的词，就往这里加。
>
> **列的含义**：
> - **主术语**：唯一推荐写法。括号里是对应的英文名/代码标识符——它属于主术语的一部分（行文用中文、代码用括号里的名字），不算另一个词。
> - **同义词（退役）**：历史上出现过的其他叫法，**今后文档、代码、对话一律不再使用**，只在这里留档以便读旧文档时对得上号。

## 一、Agent 运行的基本单位

| 主术语 | 同义词（退役） | 大白话定义 |
|---|---|---|
| **agent** | — | 能自己调用工具、多步完成任务的 AI。这里特指 nimbo 驱动的那个。 |
| **loop** | loop agent | agent 的「思考→调工具→看结果→再思考」这个反复循环。nimbo 自己实现这个循环（不外包给 AI SDK 的现成 loop）。跑这个循环的 AI 直接叫 agent。 |
| **turn（轮）** | 回合 | 用户发一条消息，触发 agent 的一次完整循环，直到它不再调工具、给出答复。一条消息 = 一轮。 |
| **step（步）** | — | 一轮内部，agent 每调一次模型算一步。一轮可能有很多步（每调一次工具通常就多一步）。 |
| **conversation（会话/对话）** | session（指聊天会话时，2026-07-17 退役） | 一段持续的多轮对话，跨轮累积记忆。对应 chat 应用里的一个聊天窗口；存储为 `conversations` 表、事件账本 `conversation_events`。改名动机：解开 "session" 三重超载——该词此后专指 better-auth 登录态（`session` 表）与 SDK 的 agent 会话（`SessionState`/`agent_session_*` 列）。 |
| **steer（中途插话）** | 软 steer、soft steer | agent 正在跑一轮的过程中，用户又发了一条消息，把它插进当前这一轮（而不是等它结束再开新一轮）。 |

## 二、两种「消息」格式（AI SDK 的概念）

| 主术语 | 同义词（退役） | 大白话定义 |
|---|---|---|
| **ModelMessage** | 模型消息 | 「发给大模型的消息」格式，就是模型服务商 API 真正收到的那份数据。 |
| **UIMessage** | — | 「给界面看的消息」格式，比 ModelMessage 多带界面用的过程信息。P13-5 之后 nimbo 的账本只存这一种。 |
| **部件（part）** | — | 一条 UIMessage 由若干部件组成：文本部件、推理部件、工具部件、data 部件等。 |
| **data 部件（data part）** | — | UIMessage 里专门放「只给界面看、不给模型看」的过程数据的部件，类型名形如 `data-file-change`。转成 ModelMessage 时被自动丢掉。 |
| **transient 部件** | 临时部件 | 一种特殊 data 部件：只在直播时推一下、**不存进账本**。打字进度就是这种。注意：它是「线上传输块」的属性，不是存进消息数组后再过滤（见 docs/tech/single-ledger.md）。 |
| **元数据（metadata）** | — | 挂在一条 UIMessage 上的附加信息（这一轮的 token 用量、成功/失败状态、是不是 steer 插话）。不参与转模型消息。 |
| **官方转换器（`convertToModelMessages`）** | — | AI SDK 的转换函数：吃一串 UIMessage，吐出对应的 ModelMessage。由 Vercel 官方维护，nimbo 不自己写这个转换。 |

## 三、数据存哪、怎么传

| 主术语 | 同义词（退役） | 大白话定义 |
|---|---|---|
| **账本（ledger）** | transcript、事件流水、事件表 | 一个会话的全部落盘数据。P13-5 之后是「单账本」：只有一张按序号递增的表，既供界面回放、又供模型恢复记忆。（transcript 是 P13-5 之前「独立一份执行流水」的旧说法，已与账本合并。） |
| **模型上下文** | 模型记忆 | 发给模型、让它「记得自己前几轮做过什么」的那份推导结果。P13-5 之前来自单独的 `nimbo_state_json` 字段；之后从账本里的 UIMessage 现场推导。 |
| **SessionState（`session.toJSON()`）** | — | `session.toJSON()` 吐出的可序列化会话快照：`{ id, 轮号, messages, 创建时间 }`。用来下轮 `resume` 恢复。 |
| **chunk（流块）** | wire 事件 | `session.stream()` 一小段一小段吐出来的东西，是 AI SDK 的「UIMessage 流」协议词汇（文本增量、工具状态变化、data 部件等）。任意 AI SDK 兼容客户端能直接消费。（wire 事件是 P13-5 之前自定义事件的旧词，已废弃。） |
| **折叠（fold）** | — | 把一段 chunk 流按消息边界（`start`/`finish` chunk）积累还原成完整 UIMessage 的动作——chunk 是消息的传输形态，折叠是反向还原。界面端由 AI SDK 流处理器边收边折叠；服务端不重新折叠——core 的 loop 产出 chunk 的同时就在账本工作态里维护着成品消息，收尾直接落盘（见 docs/tech/single-ledger.md §2.4）。 |
| **直播流** | live tail | 服务端通过 `GET .../stream` 实时把 chunk 推给浏览器的那条连接（SSE）。「直播」= 边跑边推，区别于「回放」= 从账本读历史。 |
| **回放（replay）** | — | 刷新页面或断线重连后，从账本按序号读出历史、在界面重建出来。 |
| **seq（序号）** | — | 账本里每条落盘记录的单调递增编号，一个会话内唯一。断线重连靠它续传（`after=<seq>`）。 |
| **transient / persistent** | ephemeral / durable、过程帧 / 耐久帧 | 流数据的持久化两档：transient = 只直播不落盘（打字增量、进度）；persistent = 落盘可回放（完工消息、工具状态、审批状态）。P13-1 定的分层。transient 部件就是这一档在 data 部件上的体现——与 AI SDK 用词对齐，一个概念一个名字。 |

## 四、审批（human-in-the-loop）

> P13-5 审批 API 重构后的定案术语（见 docs/tech/single-ledger.md）。旧的 `always`/`never`/`once` 字符串已废弃。

| 主术语 | 同义词（退役） | 大白话定义 |
|---|---|---|
| **人在回路（human-in-the-loop）** | 人在环上、HITL | agent 要做敏感操作（跑危险命令、开 PR）时停下来，等真人点「允许/拒绝」再继续。（旧叫法「人在环上」字面对应的其实是 human-**on**-the-loop——人只监督、不逐步把关的另一种模式，恰好是要区分开的概念。） |
| **审批结果（三值）** | — | 对一次工具调用的处置，三选一：**允许所有 `allow`**（直接跑，不弹卡片）/ **人工审批 `review`**（弹卡片、停下 loop、等真人）/ **不允许 `deny`**（直接拒绝）。 |
| **审批策略（policy）** | — | 挂在工具上或注入会话的规则，对一次工具调用产出一个「审批结果」。可以是固定值，也可以是一段判断逻辑（回调）。 |
| **审批分类器** | `shouldAutoAllow` | 会话级注入的「审批工具调用」接口，看一次工具调用、返回三值之一。chat 应用在这里放危险命令清单：安全命令返回 `allow`、危险命令返回 `review`。 |
| **人工裁决（human decision）** | — | 分类器返回 `review` 后，弹给真人的卡片收到的最终答复：**允许** 或 **拒绝**（可带理由）。真人是终点，只有两值；「改参数」已于 2026-07-15 定案删除。 |
| **审批卡片** | — | 界面上让用户裁决的那个 UI 元素，三个按钮：**允许**（本次）/ **会话内都允许**（本次 + 记住，见下）/ **拒绝**（可带理由）。 |
| **会话级授权（session grant）** | once 记忆 | 用户在审批卡片上点「会话内都允许」后落下的一条放行记录：**本会话内、该用户、完全相同的调用**（同工具 + 同入参指纹）后续直接放行、不再弹卡片；换个命令（指纹不同）仍照常审批。**持久化**到 `conversation_grants` 子表、按 (会话, **用户**, 工具, 入参指纹) 记账——随会话存续、跨进程重启存活、会话删除即随 conversation 级联清（`clearSessionGrants` 为显式清理入口）；`user_id` = 审批人，查时按**本轮发起者**匹配，为将来一个 conversation 多用户时「每人管自己的授权」留好数据。落在 chat 层（`apps/node-server/src/agent/session-grants.ts`），wire 上是 `POST .../approvals/:callId` 的 `behavior:'allow-session'` 裁决——与 core 的 `review-once`「once 记忆」是**同一意图的两条实现路径**（core 那条按工具名、由策略驱动、纯内存；这条按具体调用、由用户在卡片上驱动、持久化到会话，chat 分类器够不着 core 的 once 记忆，故自建）。 |
| **审批链（approval chain）** | — | 两级求值：per-tool approval 策略先行 → 升级请求交给 session 级审批分类器 `onApproval` → 结果为 review 时经人审通道 `onReview` 等真人；无仲裁者即 deny。 |
| **人审通道（`ApprovalReviewer` / `onReview`）** | — | 会话级注入的一条通道：审批分类器把某次工具调用判为 review 后，把审批请求送到真人面前、再把裁决 resolve 回正挂起的 loop。与「审批分类器」（决定要不要人）、「人工裁决」（人给的答复）三者分工不同。 |
| **审批请求 chunk（`tool-approval-request`）** | — | loop 解析出 review、真正阻塞等人「之前」先产出的一个耐久 chunk；界面据它弹审批卡片，是「审批可见性走直播」的结构保证（对应 ai@7 原生审批状态机的 approval-requested 态）。 |
| **审批响应 chunk（`tool-approval-response`）** | — | 人工裁决落定后 loop 产出的耐久 chunk（允许/拒绝都发），承载裁决结果（approved 区分、deny 带 reason），随 `session.stream()` 送达界面（对应 ai@7 的 approval-responded 态）。 |

## 五、沙盒与生命周期

| 主术语 | 同义词（退役） | 大白话定义 |
|---|---|---|
| **沙盒（sandbox）** | — | 跑 agent 命令的隔离虚拟机/容器（这里用 Vercel Sandbox）。里面有真实 Linux 文件系统和 shell。 |
| **工作区（workspace）** | — | 沙盒对 nimbo 暴露的统一对象，同时实现文件读写（NimboFS）和命令执行（NimboExec）。 |
| **NimboFS / NimboExec** | — | nimbo 定义的两个接口：文件系统操作 / 命令执行。谁实现了它们，谁就能当 agent 的工作区。 |
| **原生搜索（native search）** | — | 沙盒适配器在沙盒内一次命令执行完成的搜索快路径，由 NimboFS 可选方法 `searchFiles`/`searchContent` 承载；未实现或不可用时内置 `grep`/`glob` 回退 JS 逐文件扫描。 |
| **遥测（telemetry）** | — | ai@7 的 `Telemetry` 事件集成接口产出的模型调用生命周期数据（每步/每次 model call 的耗时、吞吐、usage 等），经 `SessionTelemetry` 注入、按 `"<sessionId>#<turn>"` 关联键落 SQLite（`telemetry.db`），按 turn 可查；与账本数据（`data-tool-timing`、消息 metadata）互补不重复。 |
| **平台快照（snapshot）** | — | Vercel 沙盒停机时自动存的磁盘镜像，下次按名字恢复。是「休眠/唤醒」的底层机制。 |
| **休眠 / 唤醒** | — | 沙盒长时间没人用 → 平台自动停机存快照（休眠）；下条消息来 → 按名字恢复（唤醒）。 |
| **存活时长（lifetime）** | 时效、租期倒计时 | Vercel 沙盒创建时设的存活期限，到点自动停机。**跑命令不会延长它**，只有显式续期才行（见保活）。与保活的实现名 `ensureLifetime` 同词根。 |
| **保活（keepalive，实现为 `ensureLifetime`）** | touch | 主动延长沙盒剩余存活时间。P13-2b 定为「补足到还剩 X 分钟」的语义（`ensureLifetime`）；touch 是它取代的旧续期动作。 |
| **代码快照（checkpoint）** | — | P13-2 计划：每轮结束把工作区完整状态推到用户仓库的快照引用，防平台快照过期丢未 push 的工作。 |
| **快照引用（checkpoint ref）** | WIP ref、隐藏 ref | 存放代码快照的自定义 git 引用（如 `refs/nimbo/wip/<会话id>`），不在正常分支命名空间下：GitHub 界面看不到、不触发 CI。与代码快照同族——快照存进快照引用。 |
| **VirtualFS（虚拟文件系统）** | — | nimbo 的 NimboFS 抽象的具体实现族——MemoryFS（纯内存）/ OverlayFS（真实目录零拷贝 overlay）/ 自定义实现；agent 视角是普通文件系统，宿主视角是可检查、可导出（diff/writeBack）、可丢弃的对象。 |
| **OverlayFS（overlay 挂载）** | — | 读穿透 + 写覆盖的 VirtualFS：base 只读层（通常是真实目录）+ overlay 内存层承接所有写入与删除墓碑；`fromDirectory` 挂载大项目零拷贝、写永不落真实磁盘。 |
| **reference 条目** | — | VirtualFS 里内容不在本地的「扩展文件」：路径 + mimeType + annotations + href（指向 URL/CI 产物等外部资源），把 MCP resources 语义折叠进文件系统；注入 `resolveReference` 后可被 read-file 直读。 |
| **物化（materialize）** | — | `localExec({ materialize: true })` 的模式 B：执行命令前把 VirtualFS 内容写到随机临时目录、执行后按 mtime 把变更收回 overlay——nimbo 负责一致性的便利实现，非安全边界。 |
| **模式 A（同源工作区）** | 同源工作区 | 一个对象同时实现 NimboFS 与 NimboExec、文件真身只有一份（在沙盒里）的执行模式；文件工具与 bash 的一致性是结构性的、无需同步逻辑。沙盒专指这种模式（云沙盒三家适配器即此形态）。 |
| **模式 B（物化执行）** | — | 文件真身在内存虚拟 FS 里、执行命令前临时物化到真实磁盘、结束后按 mtime 收回的本机便利模式；一致性由 nimbo 维护，命令跑在真机上故默认逐条审批。 |
| **模式 C（完全解耦）** | — | 文件面与命令面互相看不见、各管各的逃生门模式；一致性由宿主自己保证，适合命令面与文件面本就无关的场景。 |
| **沙盒适配器（sandbox adapter）** | — | 把某家厂商的沙盒 SDK 忠实翻译成 NimboFS/NimboExec 两个接口的独立可选包（如 `@nimbo/sandbox-vercel`）；只包视图、不管生命周期，运行时不 import 厂商 SDK。 |
| **网关形态（gateway form）** | — | 沙盒 SDK 无法在普通 Node 进程直连时（如 Cloudflare）的接入方式：自部署一个 HTTP 网关把七个文件方法与 exec 映射成端点，nimbo 侧用纯 fetch 客户端连它。 |
| **沙盒 provider（sandbox provider）** | 沙盒厂商 | 一次会话选用哪家云沙盒（`vercel` / `e2b`）的选择项。决定 server 端 `sandbox-manager` 接哪个沙盒适配器、走哪套生命周期实现（建盒拉码方式、重连方式、休眠机制）。与会话 1:1 绑定，创建时选定即固定、运行中不切换。 |
| **重连令牌（resume token）** | — | server 为一次会话持久化、下次唤醒沙盒时用来指名恢复的字符串。因 provider 而异：Vercel 是创建时用户自选的确定性[沙盒名](../terms.md)（由 conversationId 派生，无需额外落库），E2B 是**建盒后**服务端分配的 `sandboxId`（必须落 `conversations.sandbox_id` 才能跨进程 `Sandbox.connect` 恢复）。 |
| **心跳（keepalive heartbeat）** | — | turn 期间每 idleTimeout/2（默认 150 秒）触发一次 `ensureLifetime(idleTimeout)` 的定时器，turn 注册时启动、收尾（含异常）时停止，用「补足」语义把沙盒剩余存活时间维持在恒定水位。 |
| **上次存档** | — | 最近一次 turn 正常收尾时成对写下的「模型上下文 + 代码快照」，是崩溃恢复时判断两本账是否对齐的基准。 |
| **crash ref（事故留底引用）** | — | `refs/nimbo/crash/<sessionId>`，turn-runner catch 分支把崩溃残局尽力推到的 git 引用；恢复流程永不读取它，仅供人工打捞。 |

## 六、其它

| 主术语 | 同义词（退役） | 大白话定义 |
|---|---|---|
| **skill（技能）** | — | 给 agent 附加的一包能力说明 + 文件（如 frontend-design）。 |
| **kubb 重生成** | openapi 重生成 | 服务端 API 契约改了之后，用 kubb 重新生成前端的类型/客户端代码。 |
| **BYO 实例（Bring Your Own）** | — | nimbo 不创建/不销毁沙盒，只接管宿主已创建好的实例；生命周期归宿主。 |
| **渐进式披露（progressive disclosure）** | — | skills 的加载策略：装载时只把 name/description 注入 instructions，agent 需要时才用 load-skill 工具读取 SKILL.md 全文与附属文件——「loading a skill adds instructions, never a new execution surface」。 |
| **ask-user（工具）** | — | 内置工具/产品能力：agent 在一轮进行中直接向用户提问（可带快捷选项）并阻塞等回答，回答后本轮继续；超时返回一段提示文案而非报错，模型自行决定继续。与审批无关、恒注册，是产品能力不是安全闸。 |

## 七、上下文压缩（compaction，见 docs/features/compaction.md）

| 主术语 | 同义词（退役） | 大白话定义 |
|---|---|---|
| **compaction（上下文压缩）** | — | 会话太长时，把较早那段对话换成一条摘要再喂给模型，控制上下文体量。只影响模型上下文那份推导结果，界面显示的完整历史不受影响。 |
| **compaction 条目** | — | 账本里与 message/chunk 并列的第三种条目：payload 是一条装着摘要的 UIMessage，元数据里记切点等簿记。追加写入，不改不删任何旧记录。 |
| **摘要（summary）** | — | 压缩产出的结构化总结：任务目标、已完成、关键决策、涉及文件路径、未决事项。由一次独立的模型调用（fork）生成。 |
| **切点（upToSeq）** | cut point | compaction 条目声明「序号 ≤ 这个值的 message 条目已被摘要替代」。推导模型上下文时据此过滤。 |
| **链式压缩** | — | 第二次压缩以「上一条摘要 + 之后的消息」为输入，产出切点更靠后的新条目。推导只认最新一条，旧条目降级为纯展示历史。 |
| **框定（framing）** | 框定导语 | 摘要正文开头的固定导语（「以下是系统生成的早期对话摘要，非用户发言」）。摘要以 user 角色进线协议，靠这句导语防止模型把它当成真实用户发言。 |
| **触发（auto / manual）** | — | 压缩的发起方式：自动（token 用量过阈值）或手动（用户 `/compact`，可带指令）。触发指令本身不进账本，账本里只出现结果条目。 |
| **保留尾巴（kept tail）** | — | 压缩时不进摘要、按原文保留在模型上下文里的最近若干条消息。切点就选在它们之前。 |
| **外化（offload）** | 卸载 | 减上下文的另一招（与压缩正交）：大内容落文件，上下文只留路径引用，模型需要时用工具读回来。 |
| **前缀缓存（prefix cache / KV 缓存）** | — | 模型服务商对「相同前缀的 KV 计算结果」的复用缓存，命中可省算力与成本。压缩会改写上下文前缀、使整段 KV 缓存失效一次——故压缩定为低频大动作，两次压缩之间严格 append-only；摘要 fork 复用旧前缀吃满缓存，压缩后首轮冷写、随对话推进回暖。 |

## 八、核心 SDK 概念（见 docs/features/core-sdk.md）

| 主术语 | 同义词（退役） | 大白话定义 |
|---|---|---|
| **AgentDefinition（`defineAgent`）** | — | agent 的纯声明值——model/instructions/tools/skills/maxTurnsPerRun 等，可复用、可测试、无运行状态；`defineAgent` 是恒等函数，价值在类型推导。 |
| **TurnResult** | — | 一轮 `send()`/`stream()` 的结果——finalResponse（该轮最终文本）+ usage（token 用量）；P13-5 起去掉 items（轮内过程改为读账本本身或 stream 的 chunk）。 |
| **结构化输出（outputSchema）** | — | `send(input, { outputSchema })` 在一轮正常收尾后再走一轮抽取，按 zod schema 产出 `TurnResult.structuredOutput`；provider 无原生 JSON 能力时走「JSON+zod 校验+修正重试」回退。 |
| **目录约定层（`loadAgent` / L3）** | — | 可选的 eve 布局兼容加载层：`loadAgent(dir)` 从 instructions.md + tools/*.ts + skills/ 组装 AgentDefinition；`loadAgentFromFS` 从 VirtualFS 加载（不求值 tools/*.ts）。 |

## 九、内置工具（见 docs/features/builtin-tools.md）

| 主术语 | 同义词（退役） | 大白话定义 |
|---|---|---|
| **内置工具（builtin tools / builtinTools）** | — | nimbo 出厂自带、宿主不写一行代码就能用的一组 agent 工具：文件八件套（read/write/edit/delete/move/list-dir/glob/grep）+ update-plan 为可裁剪内置（由 `builtinTools` 选项控制），bash / load-skill 为条件内置。 |
| **条件内置（conditional builtin）** | — | 一类内置工具：不由 `builtinTools` 数组控制，而是当对应能力被配上时才出现在工具列表——注入 NimboExec 时出现 bash，配置了 skills 时出现 load-skill。 |
| **read-before-write（先读后写强制）** | 先读后改校验 | 写类工具的安全约束：edit-file 与覆盖式 write-file 前必须在本 session 读过该文件、且其 `stat().mtime` 与读取时一致（bash 或此前 edit 改过就要重读），否则拒绝并给出「先 read-file」的可行动错误，防止模型盲改/盲覆盖。 |
| **文件变更项（file_change）** | — | 写类工具成功后由 ToolRuntime 派生的 SessionItem，kind 为 add/update/delete，让宿主实时看到文件系统改动；工具自身不发事件，只经 `onFileChange` 回调搬出数据。 |

## 十、验证与示例脚本（见 docs/features/examples.md、docs/plans/verification.md）

| 主术语 | 同义词（退役） | 大白话定义 |
|---|---|---|
| **示例集（examples，实验田）** | — | 仓库里的 `examples/` 目录：一块打开即用的 pnpm workspace 成员，十二个可独立运行的示例脚本各演示 nimbo 一块核心能力；用户根目录 `pnpm install` 后 `pnpm example <编号>` 即跑。「实验田」是它面向用户的定位——低门槛把玩各能力的地方。 |
| **runner（示例分发器）** | — | `examples/run.ts`：`pnpm example <编号或名字前缀>` 背后的分发器，按前缀在 `src/` 下唯一匹配一个脚本、用当前 node 直跑（Node 原生 type stripping，无需编译）。是工具、不是示例；新增示例零维护。 |
| **确定性段** | — | 示例脚本中不依赖模型/网络、零 key 即可确定性跑通的那一段（打印 JSON Schema、直调 exec/fs、fake 沙盒往返等），用来在无凭证下验证机制正确；与「模型驱动段」相对。 |
| **模型驱动段** | — | 示例脚本中需真实模型（可能还需云凭证）才运行、用来验证 agent 端到端行为的那一段；与「确定性段」相对。 |
| **gate（配置闸门）** | — | 示例脚本在发起任何模型调用/网络请求之前，按序检查所需环境变量/凭证；任一未配置就打印指引并干净退出或 return（exit 0），全程不创建沙盒、不发起模型调用、不产生副作用。 |
