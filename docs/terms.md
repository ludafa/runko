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
| **steer（中途插话）** | 软 steer、soft steer | agent 正在跑一轮的过程中，用户又发了一条消息，把它插进当前这一轮（而不是等它结束再开新一轮）。真实注入点是下一个 step 边界。在 chat 应用里这是**要显式选择**的路径（默认是排队，见下）。 |
| **排队（queue）** | 待发队列 | agent 正在跑一轮时，用户发的消息**不进当前这一轮**，而是存进会话的待发队列；这一轮收尾后由服务端自动取队首、起下一轮。与 steer 相对，是 chat 应用运行中发消息的**默认**路径。队列存 `conversations.queued_messages_json`（不是[账本](#三数据存哪怎么传)——排队消息是「尚未发生的意图」，不是已发生的事件）。 |
| **出队（dequeue）** | — | 一轮收尾后服务端自动取出待发队列队首、以它起下一轮的动作。出队即从队列移除；起轮失败则该条留在队列，等下一次轮收尾再试。 |
| **起轮装配（turn launch）** | — | 从「服务端收到一条要起新一轮的消息」到「这一轮真正开始产出内容」之间那段准备工作：取沙盒 → 续期 → 从账本重建 `SessionState` → 建 agent 会话 → 交给 turn runner 驱动。落地为 `apps/node-server/src/agent/turn-launcher.ts` 的 `launchTurn`。它整段跑在 `POST .../messages` 的请求生命周期里，用户在界面上的等待有相当一部分花在这里，故单独打点（见 docs/app/telemetry/tech.md §2.4）。 |
| **轮状态快照（turn-state frame）** | — | [直播流](#三数据存哪怎么传)上的一种状态快照帧（`{ turnActive: boolean }`）：每条 `GET .../stream` 在回放之后、进入直播之前必发一帧，内容是**服务端**对「这个会话此刻有没有[轮](#一agent-运行的基本单位)在跑」的权威答案。与[待发队列](#一agent-运行的基本单位)快照帧同构——没有 `seq`、不落库、不进[账本](#三数据存哪怎么传)。它取代了前端早先那个猜测（「回放最后一帧是不是 chunk」），因为崩溃残留会让那个猜法长期失准且永不自愈。见 docs/app/chat-webapp/tech.md §5.1。 |
| **起轮占位（turn reservation）** | — | [起轮装配](#一agent-运行的基本单位)一进门就在服务端那张「进行中的轮」表里占下的位子：从装配的第一行代码起这一轮就算**存在**，于是它可以被[停止](#一agent-运行的基本单位)、同会话后来的消息也会走[排队](#一agent-运行的基本单位)而不是再起一轮。装配跑完则原地升级成真正在跑的那一轮，装配失败或装配期间被停止则撤销。落地为 `apps/node-server/src/agent/turn-runner/` 的 `reservation.ts`（`reserveTurn`/`releaseTurn`）与 `registry.ts`（`ActiveTurn.phase`）。 |
| **停止（stop / abort）** | 硬打断（interrupt）、取消（cancel）、中止 | 用户在一轮进行中主动叫停它：当前轮不再进入下一个 [step](#一agent-运行的基本单位)、待发队列一并清空，已产出的内容全部留在账本里。落地为 `AbortController` → core `TurnOptions.signal`，收尾状态是 `status: 'interrupted'` + `NimboError.code: 'aborted'`（这两个是代码标识符，行文一律说「停止」/「已停止」）。与 steer 的分别：steer 是「往这一轮里加话」，停止是「让这一轮结束」。见 docs/agent/turn-abort/feature.md。 |

## 二、两种「消息」格式（AI SDK 的概念）

| 主术语 | 同义词（退役） | 大白话定义 |
|---|---|---|
| **ModelMessage** | 模型消息 | 「发给大模型的消息」格式，就是模型服务商 API 真正收到的那份数据。 |
| **UIMessage** | — | 「给界面看的消息」格式，比 ModelMessage 多带界面用的过程信息。P13-5 之后 nimbo 的账本只存这一种。 |
| **部件（part）** | — | 一条 UIMessage 由若干部件组成：文本部件、推理部件、工具部件、data 部件等。 |
| **data 部件（data part）** | — | UIMessage 里专门放「只给界面看、不给模型看」的过程数据的部件，类型名形如 `data-file-change`。转成 ModelMessage 时被自动丢掉。 |
| **transient 部件** | 临时部件 | 一种特殊 data 部件：只在直播时推一下、**不存进账本**。打字进度就是这种。注意：它是「线上传输块」的属性，不是存进消息数组后再过滤（见 docs/agent/single-ledger/tech.md）。 |
| **元数据（metadata）** | — | 挂在一条 UIMessage 上的附加信息（这一轮的 token 用量、成功/失败状态、是不是 steer 插话）。不参与转模型消息。 |
| **官方转换器（`convertToModelMessages`）** | — | AI SDK 的转换函数：吃一串 UIMessage，吐出对应的 ModelMessage。由 Vercel 官方维护，nimbo 不自己写这个转换。 |

## 三、数据存哪、怎么传

| 主术语 | 同义词（退役） | 大白话定义 |
|---|---|---|
| **账本（ledger）** | transcript、事件流水、事件表 | 一个会话的全部落盘数据。P13-5 之后是「单账本」：只有一张按序号递增的表，既供界面回放、又供模型恢复记忆。（transcript 是 P13-5 之前「独立一份执行流水」的旧说法，已与账本合并。） |
| **模型上下文** | 模型记忆 | 发给模型、让它「记得自己前几轮做过什么」的那份推导结果。P13-5 之前来自单独的 `nimbo_state_json` 字段；之后从账本里的 UIMessage 现场推导。 |
| **SessionState（`session.toJSON()`）** | — | `session.toJSON()` 吐出的可序列化会话快照：`{ id, 轮号, messages, 创建时间 }`。用来下轮 `resume` 恢复。 |
| **chunk（流块）** | wire 事件 | `session.stream()` 一小段一小段吐出来的东西，是 AI SDK 的「UIMessage 流」协议词汇（文本增量、工具状态变化、data 部件等）。任意 AI SDK 兼容客户端能直接消费。（wire 事件是 P13-5 之前自定义事件的旧词，已废弃。） |
| **折叠（fold）** | — | 把一段 chunk 流按消息边界（`start`/`finish` chunk）积累还原成完整 UIMessage 的动作——chunk 是消息的传输形态，折叠是反向还原。界面端由 AI SDK 流处理器边收边折叠；服务端不重新折叠——core 的 loop 产出 chunk 的同时就在账本工作态里维护着成品消息，收尾直接落盘（见 docs/agent/single-ledger/tech.md §2.4）。 |
| **直播流** | live tail | 服务端通过 `GET .../stream` 实时把 chunk 推给浏览器的那条连接（SSE）。「直播」= 边跑边推，区别于「回放」= 从账本读历史。 |
| **回放（replay）** | — | 刷新页面或断线重连后，从账本按序号读出历史、在界面重建出来。 |
| **进行中草稿（in-flight draft）** | 临时记录、半成品 | 一轮进行中、成品消息还没落盘时，为「此刻刷新页面能重建当前画面」而留着的那串耐久 chunk。轮一收尾就被成品消息取代、随即丢弃。它的存放位置见 docs/agent/in-flight-draft/tech.md（现状在账本表里占 `kind='chunk'` 行，方案是改放进程内存）。 |
| **seq（序号）** | — | 账本里每条落盘记录的单调递增编号，一个会话内唯一。断线重连靠它续传（`after=<seq>`）。 |
| **transient / persistent** | ephemeral / durable、过程帧 / 耐久帧 | 流数据的持久化两档：transient = 只直播不落盘（打字增量、进度）；persistent = 落盘可回放（完工消息、工具状态、审批状态）。P13-1 定的分层。transient 部件就是这一档在 data 部件上的体现——与 AI SDK 用词对齐，一个概念一个名字。 |

## 四、审批（human-in-the-loop）

> P13-5 审批 API 重构后的定案术语（见 docs/agent/single-ledger/tech.md）。旧的 `always`/`never`/`once` 字符串已废弃。

| 主术语 | 同义词（退役） | 大白话定义 |
|---|---|---|
| **人在回路（human-in-the-loop）** | 人在环上、HITL | agent 要做敏感操作（跑危险命令、开 PR）时停下来，等真人点「允许/拒绝」再继续。（旧叫法「人在环上」字面对应的其实是 human-**on**-the-loop——人只监督、不逐步把关的另一种模式，恰好是要区分开的概念。） |
| **审批结果（三值）** | — | 对一次工具调用的处置，三选一：**允许所有 `allow`**（直接跑，不弹卡片）/ **人工审批 `review`**（弹卡片、停下 loop、等真人）/ **不允许 `deny`**（直接拒绝）。 |
| **审批策略（policy）** | — | 挂在工具上或注入会话的规则，对一次工具调用产出一个「审批结果」。可以是固定值，也可以是一段判断逻辑（回调）。 |
| **审批分类器** | `shouldAutoAllow` | 会话级注入的「审批工具调用」接口，看一次工具调用、返回三值之一。chat 应用在这里放危险命令清单：安全命令返回 `allow`、危险命令返回 `review`。 |
| **人工裁决（human decision）** | — | 分类器返回 `review` 后，弹给真人的卡片收到的最终答复：**允许** 或 **拒绝**（可带理由）。真人是终点，只有两值；「改参数」已于 2026-07-15 定案删除。 |
| **审批卡片** | — | 界面上让用户裁决的那个 UI 元素，三个按钮：**允许**（本次）/ **会话内都允许**（本次 + 记住，见下）/ **拒绝**（可带理由）。 |
| **会话级授权（session grant）** | once 记忆 | 用户在审批卡片上点「会话内都允许」后落下的一条放行记录：**本会话内、该用户**后续同样的调用直接放行、不再弹卡片。记账粒度按工具分两种——bash 走**分段授权**（按[命令段](#四审批human-in-the-loop)记，见 docs/app/approval-grant-split/feature.md），其余工具（及拆不动的 bash）仍按**完全相同的调用**（同工具 + 同入参指纹）记。**持久化**到 `conversation_grants` 子表、按 (会话, **用户**, 工具, 入参指纹) 记账——随会话存续、跨进程重启存活、会话删除即随 conversation 级联清（`clearSessionGrants` 为显式清理入口）；`user_id` = 审批人，查时按**本轮发起者**匹配，为将来一个 conversation 多用户时「每人管自己的授权」留好数据。落在 chat 层（`apps/node-server/src/agent/session-grants.ts`），wire 上是 `POST .../approvals/:callId` 的 `behavior:'allow-session'` 裁决——与 core 的 `review-once`「once 记忆」是**同一意图的两条实现路径**（core 那条按工具名、由策略驱动、纯内存；这条按具体调用、由用户在卡片上驱动、持久化到会话，chat 分类器够不着 core 的 once 记忆，故自建）。 |
| **命令段（command segment）** | 子命令 | 一条 bash 命令行按 `&&` / `\|\|` / `;` / `\|` 切开后的**一条简单命令**——含它自己的参数、重定向与工作目录。`cd /repo && rm -rf build` 是两个命令段。切分由 `apps/node-server/src/agent/split-command.ts` 做，**看不透的写法一律不切**（见 docs/app/approval-grant-split/tech.md §3.4 拒绝清单）。 |
| **分段授权（segmented grant）** | — | [会话级授权](#四审批human-in-the-loop)的记账粒度：按**命令段**记，而不是按整条调用的入参指纹。人点「会话内都允许」时，这次调用切出的每一段各记一行；后续调用**每一段都记过**才自动放行，有任何新段仍照常弹卡片。记的是段的 argv 数组 + cwd + 重定向（不是命令名，也不是段的字符串原文——`rm -rf "my dir"` 与 `rm -rf my dir` 必须是两个键）。见 docs/app/approval-grant-split/feature.md。 |
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
| **存活时长（lifetime）** | 时效、租期倒计时 | 云沙盒建盒时设的存活期限，到点自动停机或休眠。**跑命令不会延长它**——平台不看活动，只认显式续期（见保活）。Cloudflare 是例外，它的 `sleepAfter` 是真·空闲检测。与保活的实现名 `ensureLifetime` 同词根。 |
| **保活（keepalive，实现为 `ensureLifetime`）** | touch、续期 | 主动把沙盒剩余[存活时长](#五沙盒与生命周期)补到目标值。语义是**补足**不是加时：够了就什么都不做，不够才补差额。实现下沉在[沙盒适配器](#五沙盒与生命周期)里，厂商差异封在适配器内部（见 [docs/host/sandbox-keepalive/feature.md](./host/sandbox-keepalive/feature.md)）。touch 是它取代的旧叫法。 |
| **活动信号（activity signal）** | — | core 在一轮产出 chunk 时通知[工作区](#五沙盒与生命周期)「这一轮还在干活」的可选回调（`NimboActivityAware.onActivity`）。同步、不返回值、绝不抛错；工作区没实现这个方法就什么都不会发生。 |
| **续期闸门（renewal gate）** | — | [沙盒适配器](#五沙盒与生命周期)内部唯一真正调用厂商续期 API 的地方。[活动信号](#五沙盒与生命周期)、exec 期间的自打点、宿主的手动调用三个来源都汇到这里，由它按「补足」语义决定这次要不要真的打网络。 |
| **审批保活预算（approval keepalive budget）** | — | 卡在人工审批时最多还愿意为沙盒续多久。与[单轮保活上限](#五沙盒与生命周期)相互独立；配 0 表示审批期间完全不续，沙盒可能在人点下按钮之前就休眠。 |
| **单轮保活上限（turn keepalive cap）** | — | 一轮之内保活最多持续多久。到点就停止续期、让沙盒按自己的节奏休眠，防失控任务无限烧钱。 |
| **优雅关闭（graceful shutdown）** | — | 服务端进程收到 SIGTERM/SIGINT（热重载、部署、pod 迁移、Ctrl-C）后，先把进行中的[轮](#一agent-运行的基本单位)主动[停止](#一agent-运行的基本单位)并等它收尾、再退出，而不是让它无声消失。落地为 `turn-runner/shutdown.ts` 的 `shutdownTurns` + `index.ts` 的信号处理。见 docs/agent/graceful-shutdown/feature.md。 |
| **孤儿轮（orphaned turn）** | — | 一个在[账本](#三数据存哪怎么传)里从未收尾的轮：驱动它的进程已经不在了（被强杀、OOM、断电），所以那条收尾 `message-metadata` 永远不会到来。识别特征是该会话的事件行**以 `kind='chunk'` 收尾**（优雅收尾会把本轮消息落成 message 行并 GC 掉 chunk 行）。服务端启动时扫出它们并补上「已中断」标记。 |
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
| **双角色 Worker（dual-role worker）** | — | `apps/cloudflare-worker-server` 的形态：同一个 Cloudflare Worker 既在进程内自驱 nimbo 会话（`/agent`），又对外提供网关形态端点（`/gateway/*`）供任意 Node 机器的客户端连入；两者共用同一套 `getSandbox` 接线与 Durable Object binding。 |
| **沙盒 provider（sandbox provider）** | 沙盒厂商 | 一次会话选用哪家云沙盒（`vercel` / `e2b`）的选择项。决定 server 端 `sandbox-manager` 接哪个沙盒适配器、走哪套生命周期实现（建盒拉码方式、重连方式、休眠机制）。与会话 1:1 绑定，创建时选定即固定、运行中不切换。 |
| **沙盒模板（sandbox template）** | — | 建盒时指定的镜像 + 资源规格（CPU 核数、内存），沙盒按它开出来。E2B 的 CPU/内存**只能在构建模板时定死**，`Sandbox.create` 没有内存参数；其自带 `base` 模板是 2 vCPU / 512 MiB。chat 应用因此自建模板 `nimbo-chat-base`（同一 base 镜像，内存抬到 1024 MiB），见 `apps/node-server/src/agent/e2b-template.ts`。 |
| **重连令牌（resume token）** | — | server 为一次会话持久化、下次唤醒沙盒时用来指名恢复的字符串。因 provider 而异：Vercel 是创建时用户自选的确定性沙盒名（由 conversationId 派生，无需额外落库），E2B 是**建盒后**服务端分配的 `sandboxId`（必须落 `conversations.sandbox_id` 才能跨进程 `Sandbox.connect` 恢复）。 |
| **心跳（keepalive heartbeat）** | — | 一轮进行期间持续触发[保活](#五沙盒与生命周期)的整套机制。不是单个定时器，而是**两个信号源合流**：core 按 [活动信号](#五沙盒与生命周期)往下推、[沙盒适配器](#五沙盒与生命周期)在自己的 exec 调用期间自己打点，两者都汇进[续期闸门](#五沙盒与生命周期)。见 [docs/host/sandbox-keepalive/tech.md](./host/sandbox-keepalive/tech.md)。 |
| **上次存档** | — | 最近一次 turn 正常收尾时成对写下的「模型上下文 + 代码快照」，是崩溃恢复时判断两本账是否对齐的基准。 |
| **crash ref（事故留底引用）** | — | `refs/nimbo/crash/<sessionId>`，turn-runner catch 分支把崩溃残局尽力推到的 git 引用；恢复流程永不读取它，仅供人工打捞。 |

## 六、其它

| 主术语 | 同义词（退役） | 大白话定义 |
|---|---|---|
| **skill（技能）** | — | 给 agent 附加的一包能力说明 + 文件（如 frontend-design）。 |
| **skill 清单（skill catalog）** | — | 一个会话当前可选的 skill 集合（`{name, description}[]`）。事实来源是沙盒 `.agents/skills/` 目录，缓存在 `conversations.available_skills_json` 里供前端列菜单（读缓存不唤醒沙盒，故最多滞后一轮）。见 docs/app/composer-skill-mention/feature.md。 |
| **kubb 重生成** | openapi 重生成 | 服务端 API 契约改了之后，用 kubb 重新生成前端的类型/客户端代码。 |
| **BYO 实例（Bring Your Own）** | — | nimbo 不创建/不销毁沙盒，只接管宿主已创建好的实例；生命周期归宿主。 |
| **渐进式披露（progressive disclosure）** | — | skills 的加载策略：装载时只把 name/description 注入 instructions，agent 需要时才用 load-skill 工具读取 SKILL.md 全文与附属文件——「loading a skill adds instructions, never a new execution surface」。 |
| **ask-user（工具）** | — | 内置工具/产品能力：agent 在一轮进行中直接向用户提问（可带快捷选项）并阻塞等回答，回答后本轮继续；超时返回一段提示文案而非报错，模型自行决定继续。与审批无关、恒注册，是产品能力不是安全闸。 |
| **联网搜索（web search，工具名 `web-search`）** | exa 搜索 | chat 应用注册给 agent 的查网工具（不是 [core 内置工具](#九内置工具)，只活在 `apps/node-server`）：一句自然语言查询 → 若干条「标题/网址/日期/摘录」。后端是 Exa 的 `/search`，`EXA_API_KEY` 没配就不注册、模型看不见。只读、不弹审批。与[原生搜索](#五沙盒与生命周期)（搜沙盒里的文件）是两回事。见 docs/app/web-search/feature.md。 |

## 七、上下文压缩（compaction）

> 见 [agent/compaction/feature](agent/compaction/feature.md)。

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

## 八、核心 SDK 概念

> 见 [core/core-sdk/feature](core/core-sdk/feature.md)。

| 主术语 | 同义词（退役） | 大白话定义 |
|---|---|---|
| **AgentDefinition（`defineAgent`）** | — | agent 的纯声明值——model/instructions/tools/skills/maxTurnsPerRun 等，可复用、可测试、无运行状态；`defineAgent` 是恒等函数，价值在类型推导。 |
| **TurnResult** | — | 一轮 `send()`/`stream()` 的结果——finalResponse（该轮最终文本）+ usage（token 用量）；P13-5 起去掉 items（轮内过程改为读账本本身或 stream 的 chunk）。 |
| **结构化输出（outputSchema）** | — | `send(input, { outputSchema })` 在一轮正常收尾后再走一轮抽取，按 zod schema 产出 `TurnResult.structuredOutput`；provider 无原生 JSON 能力时走「JSON+zod 校验+修正重试」回退。 |
| **目录约定层（`loadAgent` / L3）** | — | 可选的 eve 布局兼容加载层：`loadAgent(dir)` 从 instructions.md + tools/*.ts + skills/ 组装 AgentDefinition；`loadAgentFromFS` 从 VirtualFS 加载（不求值 tools/*.ts）。 |

## 九、内置工具

> 见 [core/builtin-tools/feature](core/builtin-tools/feature.md)。

| 主术语 | 同义词（退役） | 大白话定义 |
|---|---|---|
| **内置工具（builtin tools / builtinTools）** | — | nimbo 出厂自带、宿主不写一行代码就能用的一组 agent 工具：文件八件套（read/write/edit/delete/move/list-dir/glob/grep）+ update-plan 为可裁剪内置（由 `builtinTools` 选项控制），bash / load-skill 为条件内置。 |
| **条件内置（conditional builtin）** | — | 一类内置工具：不由 `builtinTools` 数组控制，而是当对应能力被配上时才出现在工具列表——注入 NimboExec 时出现 bash，配置了 skills 时出现 load-skill。 |
| **read-before-write（先读后写强制）** | 先读后改校验 | 写类工具的安全约束：edit-file 与覆盖式 write-file 前必须在本 session 读过该文件、且其 `stat().mtime` 与读取时一致（bash 或此前 edit 改过就要重读），否则拒绝并给出「先 read-file」的可行动错误，防止模型盲改/盲覆盖。 |
| **文件变更项（file_change）** | — | 写类工具成功后由 ToolRuntime 派生的 SessionItem，kind 为 add/update/delete，让宿主实时看到文件系统改动；工具自身不发事件，只经 `onFileChange` 回调搬出数据。 |

## 十、验证与示例脚本

> 见 [app/examples/feature](app/examples/feature.md) · [core/verification/plan](core/verification/plan.md)。

| 主术语 | 同义词（退役） | 大白话定义 |
|---|---|---|
| **示例集（examples，实验田）** | — | 仓库里的 `examples/` 目录：一块打开即用的 pnpm workspace 成员，十二个可独立运行的示例脚本各演示 nimbo 一块核心能力；用户根目录 `pnpm install` 后 `pnpm example <编号>` 即跑。「实验田」是它面向用户的定位——低门槛把玩各能力的地方。 |
| **runner（示例分发器）** | — | `examples/run.ts`：`pnpm example <编号或名字前缀>` 背后的分发器，按前缀在 `src/` 下唯一匹配一个脚本、用当前 node 直跑（Node 原生 type stripping，无需编译）。是工具、不是示例；新增示例零维护。 |
| **确定性段** | — | 示例脚本中不依赖模型/网络、零 key 即可确定性跑通的那一段（打印 JSON Schema、直调 exec/fs、fake 沙盒往返等），用来在无凭证下验证机制正确；与「模型驱动段」相对。 |
| **模型驱动段** | — | 示例脚本中需真实模型（可能还需云凭证）才运行、用来验证 agent 端到端行为的那一段；与「确定性段」相对。 |
| **gate（配置闸门）** | — | 示例脚本在发起任何模型调用/网络请求之前，按序检查所需环境变量/凭证；任一未配置就打印指引并干净退出或 return（exit 0），全程不创建沙盒、不发起模型调用、不产生副作用。 |

## 十一、界面语言（chat 页面）

> 见 [app/chat-ui/feature](app/chat-ui/feature.md)。

| 主术语 | 同义词（退役） | 大白话定义 |
|---|---|---|
| **ai-elements** | — | Vercel 官方的 AI 界面组件库（建在 shadcn/ui 上，从 registry 取到本地、代码归你）。chat 页面的消息流、工具卡片、推理块、审批、待发队列、输入框全部建在它上面；nimbo 特有的部分（中文状态词、工具计时条、三值裁决、插进本轮）作为薄封装留在 `features/chat/components/`。 |
| **composer（消息输入框）** | 输入框 | chat 页面底部写消息的那块区域，含输入区 + 底部工具条（插话键 / 发送键 / 流式期间的停止键）。外壳是 ai-elements 的 `PromptInput`；输入区自 skill 提及功能起由 tiptap 承载，不再是原生 textarea。 |
| **skill 提及（skill mention）** | — | 用户在 [composer](#十一界面语言chat-页面) 里打 `/` 唤出[skill 清单](#六其它)、选中后插入的一枚原子标记块，形如 `/frontend-design`——告诉 agent「这件事按这个 skill 来做」。删除是整枚一起删，不会剩半截字符。wire 上它就是消息文本里的普通字符串，不是独立字段（这样[回放](#三数据存哪怎么传)时天然跟着走）。见 docs/app/composer-skill-mention/feature.md。 |
| **sm 档密度** | — | 本项目对 ai-elements 出厂间距统一收一档的调校（消息 gap-8→gap-4、工具卡片 p-4→p-2.5 等）。改在**组件本体**里而不是调用点，否则下次重新 `add` 组件就全丢了。改动清单见 [app/chat-ui/tech §4](./app/chat-ui/tech.md)。 |
| **设计工作台（design bench）** | 预览页 | dev-only 的 `/design` 路由：用固定假数据把 chat 页面每一档界面状态铺在同一屏，不连服务端、不需要登录，供改样式时对着迭代。生产构建下 404。 |
| ~~轨道（rail）~~ | — | **已退役**（2026-07-25 当天提出又当天推翻）：一条贯穿一轮的竖线 + 节点。连同「打断 / 指令块 / 信号色 / 刻字面 / 结算行」都属于一版未被采纳的自研界面语言，现已全部换成 ai-elements。读旧 commit 时对照用，新文档不得再使用。 |

## 十二、推送通知

> 见 [app/push-notification/feature](app/push-notification/feature.md)。

| 主术语 | 同义词（退役） | 大白话定义 |
|---|---|---|
| **推送通知（push notification）** | 消息推送、push | 在需要你做决定或一轮跑完时，由服务端主动送到你设备上的系统级提醒。走 Web Push 标准：chat 页面已经关掉、浏览器最小化也收得到——这正是它区别于页面内提示的地方。 |
| **推送订阅（push subscription）** | — | 浏览器替某个站点交给服务端的一张「投递地址」：一个 `endpoint` URL 加 `p256dh`/`auth` 两把密钥。服务端拿着它才能往这台设备投递。一台设备一个浏览器一条，用户点铃铛时产生，撤销权限或换浏览器即作废。 |
| **VAPID 密钥对** | — | 服务端向推送服务（Chrome 走 FCM、Firefox 走 autopush）自证身份的一对公私钥。公钥交给浏览器订阅时用，私钥签名每次投递。一个部署一对；没配就等于整个推送功能不存在（不报错、不显示铃铛）。 |
| **Service Worker（SW）** | — | 浏览器替站点常驻后台的一小段脚本，页面关了它也能被唤醒。收推送、弹通知、处理点击跳转都在它里面跑。本项目那份在 `apps/web/public/sw.js`，刻意做得很薄——不调 API、不做判断，只显示服务端拼好的文案。 |
| **通知触发点（notification trigger）** | — | 值得打扰用户的四个时刻：要审批、agent 提问（`ask-user`）、一轮完成、一轮失败或被中断。除此之外一律不发。 |
| **在场（presence）** | — | 「此刻这个用户正盯着这条会话」——页面可见 + 窗口聚焦 + 路由停在这条会话，三个条件缺一不可。只有页面自己知道，所以由前端每 20 秒心跳上报，服务端内存记 45 秒有效期。 |
| **前台抑制（foreground suppression）** | — | [在场](#十二推送通知)时不发推送。人就在这条会话前面，[审批卡片](#四审批human-in-the-loop)已经在眼前了，再弹一条系统通知纯属打扰。判错方向都不致命：判成在场最坏漏一条通知，判成不在场最坏多弹一条。 |
| **挂住不消失（sticky notification）** | — | 让一条通知停在屏幕上直到人动手处理，不几秒后自动收走（浏览器的 `requireInteraction`）。**只给"卡着一轮"的两类**——要审批、agent 提问；一轮完成/失败照旧自动消失，否则跑十轮就攒十条要一条条点掉。Firefox/Safari/Android Chrome 忽略这个字段；macOS 上还需把系统里 Chrome 的提醒样式从「横幅」改成「提示」才真挂得住。 |
| **通知裁决按钮（notification action）** | — | 审批通知上直接挂的裁决按钮（允许 / 拒绝 / 本会话都允许），点了不用打开页面，[Service Worker](#十二推送通知) 直接调审批接口。**浏览器只渲染前两个**（Chrome 的 `Notification.maxActions` = 2），多的静默丢弃，所以顺序按"少了就残废"排；Safari 完全不支持。 |
| **通知合并标签（notification tag）** | — | 每条通知带的一个字符串，形如 `approval:<会话 id>`。同一标签的新通知**替换**旧的而不是堆叠——同一条会话连着要三次审批，通知栏里始终只有一条。不同会话之间互不影响。 |

## 十三、架构分层

> 这一节的词来自 [agent 内核包](agent/agent-kernel/feature.md) 的分层设计。一条总规律：**凡是可替换的东西，语义在 agent 逻辑层、实现在宿主层。**

| 主术语 | 同义词（退役） | 大白话定义 |
|---|---|---|
| **agent 逻辑层** | — | 框架固定、**不可替换**的那一块，含三个模块：[执行引擎](#十三架构分层)、[轮编排](#十三架构分层)、[归属仲裁](#十三架构分层)。换了它就不是同一套语义了。 |
| **宿主层** | — | **可替换**的那一块，由[宿主](#十三架构分层)提供实现，含四个模块：持久化、沙盒、[流分发](#十三架构分层)、[归属仲裁机制](#十三架构分层)。四样**都有内置的平凡实现**，所以零配置就能跑；换部署形态就是换掉其中一两个。 |
| **执行引擎（execution engine）** | — | 逻辑层最底下那个模块：给定历史和工具，调模型 → 跑工具 → 喂回去，直到模型说完。就是 `@nimbo/core` 干的事。它**不知道时间、进程、存储**，也不碰[账本](#三数据存哪怎么传)——拿到的是已经读好的历史。保证的性质叫**推进**。 |
| **轮编排（turn orchestration）** | — | 逻辑层中间那个模块：一[轮](#一agent-运行的基本单位)的一生——起、[中断](#一agent-运行的基本单位)、[挂起](#十三架构分层)、恢复、收尾、状态推导，外加管沙盒生命周期、定义账本/裁决/[待发队列](#一agent-运行的基本单位)的模型。它**不持有状态**（状况从账本推），也假设「我是唯一在跑这份对话的人」。保证的性质叫**连续**。 |
| **归属仲裁（ownership arbitration）** | 分布式锁（**刻意不用**） | 逻辑层最上面那个模块：授予、回收、执法执行权，让轮编排能假装自己是单线程的。精确先例是硬件总线仲裁器。**刻意不叫「分布式锁」**——那个词暗示「拿到锁就安全了」，而多节点下它[保证不了](#十三架构分层)。保证的性质叫[独占](#十三架构分层)。 |
| **接入（ingress）** | — | 框架**上面**那一层：路由、SSE、跨节点转发、审批端点、前端。**由构建者写，不在框架里**。保证的性质叫**可达**。 |
| **独占（exclusivity）** | — | 「同一份对话，同一时刻只能有一个执行在跑」。它不是为多机额外加的，是从「共享的记录 + 共享的工作区」推出来的**必然要求**——单进程时同样成立，只是内存里一个 Map 就满足了。 |
| **归属仲裁机制** | — | 宿主层里对应[归属仲裁](#十三架构分层)的那个实现，三选一：内存 Map（单进程）／[租约](#五沙盒与生命周期)+ 心跳 + [租期标识](#十三架构分层)（多进程共享 DB）／什么都不做（Cloudflare Durable Object，平台保证单实例）。 |
| **流分发（stream fan-out）** | — | 把执行中产生的 chunk 送到订阅者手上的那个通道。单进程下就是一个进程内 EventEmitter，所以平时看不见；跨实例时要外部实现（Redis Streams）。接口必须是「发布/订阅」而非「存/取」，且「拿快照 + 挂订阅」必须是一个动作。 |
| **租期标识（lease token）** | epoch、fencing token（英文文献叫法） | 租约版[归属仲裁机制](#十三架构分层)每次抢占时换发的一个**唯一**标识（ULID，调用方生成）。写数据时带上它，存储拿它跟当前值比，对不上就一行都不改——**过期的持有者全程不需要知道自己过期了，存储替它判断**。粒度是「一次租期」不是「一个进程」。只需唯一、**不需递增**（校验是等值判断）。 |
| **挂起（suspend）** | 切碎（讨论期叫法，2026-08-09 退役） | 等人等太久时，把这一轮**落盘退出、释放机器**，人回来之后在任意节点接着干。**唯一的挂起点是「正在等人」**——那是唯一的干净边界（没有命令在跑、模型没在流式输出、沙盒也没在动）。挂起是**无损**的：记录、裁决、沙盒快照都还在，代价只是唤醒沙盒的几秒。 |
| **等人状态（awaiting-human）** | — | 一轮停在「等一个人做决定」上的状态——审批与 `ask-user` 共用。它是[活动信号](#五沙盒与生命周期)的一种 `reason`，由工具在运行时经 `ctx` 主动声明（不是 `Tool` 上的静态字段——等不等人是「这一次调用的事实」，不是「这个工具的性质」）。 |
| **交权（handover）** | — | 运维要腾机器（滚动发布、缩容、`SIGTERM`）时，[归属仲裁](#十三架构分层)要求当前持有者放手。它是轮编排那一堆动作里**唯一自上而下**的一件。正在等人就[挂起](#十三架构分层)（无损）；正在干活就跑完当前这一轮再放手，超过宽限期才降级成[中断](#一agent-运行的基本单位)。 |
| **conversation-drained** | drain session、session-drained（**禁用**，会造成 "session" 第四重超载） | 框架释放归属时发出的一个**诚实的断言**：「我认为这个会话排空了——**我放手的时候**队列是空的，你那边如果有，可以继续。」它不声称「队列一定是空的」。配套「入队方也负责推进」兜底，这套在 `enqueue` 内部实现一次，构建者不需要知道有竞态。 |
| **跨执行的状态** | — | 一样东西「会不会跨多次执行存续」。它是切模块的**第二条判据**——只决定「需不需要有人管生命周期」，**不决定它属于哪个模块**（那由「被谁用」决定）。模型无状态、沙盒有状态，但两者都是执行引擎的外部依赖。 |
| **agent 构建者** | — | 拿 nimbo 建产品的**开发者**（人）。他做产品决策（排不排队、审批挂多久、快照留几天）、写[接入](#十三架构分层)代码、把[宿主](#十三架构分层)配起来。 |
| **宿主（host）** | — | 框架最终落地的**运行底座**——一切基础运行资源的提供者：agent 跑在其中的 worker/进程、沙盒、文件、网络、模型、账本与裁决的存储、归属仲裁的实现。**沙盒和存储本身不是宿主**，它们是宿主**提供的资源**。**宿主在框架下面（被框架调），[接入](#十三架构分层)在框架上面（调框架）**——两样都由构建者交付，但方向相反，所以不共用一个词。 |
