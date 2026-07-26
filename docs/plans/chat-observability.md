# Chat 可观测性（工具计时 + server 日志）· 施工进展

> 相关：[tech/single-ledger](../tech/single-ledger.md) §3.2（`data-tool-timing` 部件定案）· [tech/chat-webapp](../tech/chat-webapp.md) §11（server 日志 + web 工具卡片时间展示）· [features/chat-webapp](../features/chat-webapp.md)（用户可见行为：工具卡片起止/耗时）
> 依赖：本功能是 [chat-webapp](./chat-webapp.md) 的增强——工具计时/server 日志部分不新增独立文档，改动直接并入上述既有技术方案的对应小节（同 [native-search](./native-search.md) 的文档归位方式）；**遥测部分已独立成篇**（2026-07-17）：[features/telemetry](../features/telemetry.md) · [tech/telemetry](../tech/telemetry.md)，施工进展仍记在本文件。

## 背景

chat server 目前只有界面能看到 turn/step/工具调用的过程，运维排障缺服务端结构化日志；web 端工具卡片也感受不到「这次调用花了多久」——尤其是走了人审的调用，等待时长完全不可见。两件事分头解决：① server 加 step / tool call 级别日志；② web 给每个工具调用卡片展示启动时间、完成时间、耗时。

## 设计定案摘要（主线程拍板，2026-07-16）

核心约束（决定了架构）：`apps/node-server` 的 `finalizeTurnPersistence`（`turn-runner.ts`）落盘的 message 必须与 `session.toJSON().messages` 字节一致——**server 不能私自往 message 里塞时间戳**。所以工具起止时间必须由 `@nimbo/core` 的 loop 在写账本时就地产生，作为一个**持久 data 部件**随消息存档，刷新/回放不丢。

1. **core**：`NimboDataParts` 新增持久部件 `tool-timing`（`{ toolCallId, startedAt, completedAt? }`，epoch ms），`id = toolCallId`，同 id 覆盖，物化方式照 `data-plan-update` 先例。`tool-input-available` 后立刻打 `startedAt`；每个结算 chunk（`tool-output-available`/`tool-output-error`/`tool-output-denied`，含审批 deny 分支）后立刻补 `completedAt`。**耗时含审批等待**——这是 chat 界面上用户真实感受到的等待时长；审批本身单独等了多久在 server 日志里另外可见。
2. **server**：零依赖分级 logger（`apps/node-server/src/logger.ts`，不引第三方）+ `turn-runner.ts` 打点（纯旁路 tap，绝不改变 chunk 流转/持久化行为）；`tool-output-available` 日志的耗时读 `data-tool-timing` chunk（单一来源），不另掐计时器。
3. **web**：`schema.ts`/`use-chat-messages.ts` 同步 wire 形状与 upsert；`timeline.ts` 把 `data-tool-timing` join 进对应工具调用条目（不独立成卡片）；`tool-call-card.tsx` 展示启动/完成时间与人性化耗时，运行中逐秒跳动、崩溃残留态显示「—」。

**术语纪律核查**：未引入新术语——`data-tool-timing` 沿用既有「data 部件」概念（与 `file-change`/`plan-update` 等同级，均未单独立词条），「日志分级」为通用工程词汇，不登记进 `docs/terms.md`。

## 拆单

| # | 内容 | 归属 | 状态 |
|---|---|---|---|
| 1 | core：`NimboDataParts` 新增 `tool-timing` 部件 + `loop.ts` 在 `tool-input-available` 后打 `startedAt`、四条结算路径（`output-available`/`output-error`/`output-denied` 含审批 deny/无仲裁者/未知工具）后补 `completedAt` | coder | ✅ 已实现（`packages/core/src/{state,loop}.ts`，与本工单同步施工） |
| 2 | server：`logger.ts`（分级 + `LOG_LEVEL` + 可注入 sink）+ `turn-runner.ts` 打点（turn 开始/结束、step、工具起止、审批请求/响应、finalize）+ `schemas/chat.ts` 补 `data-tool-timing` wire 校验 + openapi 视情况重生成 | coder | ✅ 已实现（`schemas/chat.ts` 用 `z.any()` 逃逸舱承载 chunk/message，无逐名枚举，故无需补条目、openapi 无本功能新增） |
| 3 | web：`schema.ts` 补 wire 形状 + `use-chat-messages.ts` 按 id upsert（复用 `plan-update` 先例）+ `timeline.ts` join 进工具调用条目 + `tool-call-card.tsx` 时间/耗时展示（运行中跳动、崩溃残留态） | coder | ✅ 已实现（`schema.ts`/`use-chat-messages.ts` 复用既有 `z.any()` 与 ai 官方 upsert-by-id，无需改；join 落在 `message-entry.tsx` 调用点） |
| 4 | 测试：core 打点覆盖全部结算路径、server 日志纯旁路不改变行为、web 三态展示（运行中/已结算/崩溃残留） | tester | ✅ 已实现（core +20、server +34、web +23 用例，均用 fake timers 钉死时间戳；server 有「注入/不注入 logger 持久化字节一致」对照断言） |
| 5 | 文档：`tech/single-ledger.md` §3.2 补 `data-tool-timing`、`tech/chat-webapp.md` 新增 §11、`features/chat-webapp.md` 补一句用户可见行为、本文件建拆单 | coder（本次） | ✅ 已完成 |

**依赖顺序**：#2/#3 依赖 #1 已落地的 `data-tool-timing` 部件形状（已满足，可直接开工）；#2 与 #3 彼此独立可并行；#4 需 #2/#3 落地后补齐对应用例。

### 拆单二：起轮装配打点（2026-07-26 追加）

**起因**：用户反馈「发完消息要盯着空白等一段时间才有 AI 消息」。通读调用链后确认：界面第一次出现 assistant 气泡的时刻是 core loop 的 `yield start`，它前面串着一整段无人测量的[起轮装配](../terms.md)（取沙盒 → 续期 → 读账本 → `Skill.fromFS` 建会话），整段跑在 `POST .../messages` 里；现有遥测全部产自「turn 已经在跑之后」，这段是盲区。方案见 [tech/telemetry §2.4](../tech/telemetry.md)。

| # | 内容 | 状态 |
|---|---|---|
| 6 | 文档：`terms.md` 收录「起轮装配」、`tech/telemetry.md` 新增 §2.4（两种事件形状 + 时序图 + 为何延后落库）、`features/telemetry.md` 补用户可见行为与事件表、本节拆单 | ✅ 已完成 |
| 7 | server：`sandbox-manager.ts` 的 `AcquiredSandbox` 增 `mode: 'cache' \| 'resume' \| 'create'`（三条返回路径各自标注），同步测试假件 | ✅ 已实现（假件另加 `nextAcquireMode` 覆盖口，供 launcher 测试断言原样透传） |
| 8 | server：`turn-runner.ts` 增 `StartTurnParams.onMilestone`（`'first-chunk'` / `'first-output'` 各触发一次，带 `sessionId`/`turn`/`sinceStartMs`）——纯生命周期通知，本模块不认识遥测 | ✅ 已实现（时刻在 chunk 抵达那一刻取、报告排在 `emitChunk` 之后；`session.toJSON()` 与回调各自 try/catch） |
| 9 | server：`turn-launcher.ts` 逐段计时 + 经 `onMilestone` 写 `turn-prepare` / `turn-first-output` 两条遥测事件 + 一行 info 日志；`TurnLauncherDeps` 增 `telemetryStore` | ✅ 已实现（`ChatRouteDeps` 本就带 `telemetryStore`，生产装配零改动即接通） |
| 10 | web：`turn-stats-dialog.tsx` 新增「本轮准备」小节（解析两种新事件，缺席则整节不渲染） | ✅ 已实现 |
| 11 | 测试：server（milestone 时机与只触发一次、落库载荷形状、`acquireMode` 三态）+ web（新节渲染与缺席回退） | ✅ 已实现（server +9：turn-runner 4 / 新建 turn-launcher.test.ts 4 / sandbox-manager 1；web +3） |

**依赖顺序**：#7 → #9（launcher 要读 `mode`）；#8 → #9（launcher 挂回调）；#10 依赖 #9 定下的载荷字段名；#11 收尾。#6 先行（本仓库硬性规范：文档先于代码）。

### 拆单二的验收要点

- **关联键必须与 core 注入 `streamText` 的 functionId 逐字节相同**，否则弹窗按 turn 查不到——`turn-launcher.test.ts` 因此跑真 `buildSession` + 真 core loop（模型/沙盒是假件），拿会话行上的 `agentSessionId` 反查，而不是用假 session 绕开这段。
- **`launchMs` 不得把「等第一个 chunk」算进去**：它在 `startTurn` 返回后即定，回调只是读这个已定的值（载荷惰性求值只为这一件事）。
- **打点纯旁路**：`onMilestone` 抛错、`session.toJSON()` 抛错、遥测写库抛错，三者都不影响这一轮的落盘与收尾（有对应用例）。
- **遥测缺席不是错误**：不注入 `telemetryStore` 时整条打点是无操作，轮照常跑（有用例）；`turn-prepare` 那一行同时也进 stdout 日志，遥测关掉照样能排障。
- 测试基线不得回归：`@nimbo-chat/node-server` 379（+9）、`@nimbo-chat/web` 236（+3），两包 typecheck 全绿。

### 拆单二的验收结论

**自测通过（2026-07-26）。** node-server：typecheck 干净，`pnpm test` 15 文件 379 用例全绿；web：typecheck 干净，`pnpm test` 16 文件 236 用例全绿、`pnpm lint` 零警告。node-server 的 `pnpm lint` 仍有既有告警/错误，全部落在本次未触碰的文件（`test/agent/uimessage-single-ledger.test.ts` 的 11 个 `no-unused-vars`、`src/telemetry.ts` 等的 prettier 告警），本次改动涉及的文件单独跑 eslint 为零告警。**尚未在真实沙盒上验过**（本地未起服务），真实分段耗时待用户跑一轮后从统计弹窗/日志读取。

## 验收要点

- core：四条结算路径（正常输出/工具报错/拒绝-含审批 deny/未知工具错误）都补上 `completedAt`，无遗漏分支；同一 `toolCallId` 的 `tool-timing` 部件只有一条（同 id 覆盖，不重复 push）。
- 耗时语义：`completedAt - startedAt` 含审批等待，不做拆分；server 日志里另有独立字段记「审批请求到响应」的等待时长，供运维判断慢在人审还是慢在执行。
- server 日志是**纯旁路**：拔掉 logger 调用（或注入 no-op sink）不改变任何 chunk 流转/持久化行为；`tool-output-available` 日志的耗时来自 `data-tool-timing` chunk，不是 turn-runner 自己另起的计时器。
- `LOG_LEVEL` 未设时默认 `info`；长字符串（text/input 预览）按约定字符数截断，不整段打印。
- web：运行中的工具调用卡片耗时每秒跳动，结算或组件卸载后清理定时器；回放且 `completedAt` 始终缺席（turn 中途崩溃残留）时耗时位置显示「—」、不永远跳动。
- 测试基线不得回归：`@nimbo/core` 389、`@nimbo-chat/node-server` 158、`@nimbo-chat/web` 125（另 `@nimbo/virtual-fs` 193、`@nimbo/sandbox-vercel` 70 与本工单无关，不得变红）。

## 验收结论

**第 1 轮独立验收：通过（2026-07-16，orchestrator 亲自复跑）。** 五包 typecheck + test 全绿：`@nimbo/core` 409（基线 389 +20）、`@nimbo-chat/node-server` 192（+34）、`@nimbo-chat/web` 148（+23）、`@nimbo/virtual-fs` 193、`@nimbo/sandbox-vercel` 70（后两者未回归）。核验要点逐条落实：

- core 打点覆盖全部 7 处结算路径（`settleExecution` 的 output-available/output-error 两支 + `settleToolCall` 的未知工具/invalid/deny/无仲裁者 deny/人审 deny 五支），`startToolTiming` 落在 `tool-input-available` 之后；`tool-input-error`（畸形调用，未进管线）不打点，符合 `startedAt` 语义。
- 「message 与 `session.toJSON().messages` 字节一致」不变量成立——`finalizeTurnPersistence` 原样 `JSON.stringify(message)` 落盘，只新增 `log` 参数与一行 DEBUG，未私自改 message；时间戳全部由 core loop 就地产出进账本。
- server 日志纯旁路——`logChunk` 先读后 `emit.emitChunk(chunk)`，只改 `driveTurn` 局部 map，不拦截/不改写 chunk；耗时读 `data-tool-timing` chunk（单一来源）；有「注入/不注入 logger 持久化 `agent_events` 形状字节一致」对照断言。
- web `data-tool-timing` 不漏出成独立卡片（switch 无 case、落 `default` 被 `isNimboToolPart` 拒绝），按 `toolCallId` join 进两处 `ToolCallCard`；三态（运行中逐秒跳动/已结算定格/崩溃残留「—」不跳动）均有 fake-timer 用例护栏。
- 类型逃逸抽查：本功能新增/改动源码无 `any`/`as`/`@ts-ignore`/非空断言（grep 命中的 `any` 全是注释散文）。

## 变更记录

| 日期 | 阶段 | 变更 | 结论 |
|---|---|---|---|
| 2026-07-16 | 设计定案（主线程） | tool 计时（core 持久 data 部件）+ server 日志（零依赖分级 logger）+ web 工具卡片时间展示 三件套定案 | — |
| 2026-07-16 | 文档回填（coder） | `tech/single-ledger.md` §3.2 补 `data-tool-timing`（五个 data 部件）；`tech/chat-webapp.md` 新增 §11 可观测性小节；`features/chat-webapp.md` 补一句用户可见行为；新建本文件建立拆单 | 待 core/server/web 拆单陆续完工后回填「验收结论」栏 |
| 2026-07-16 | 第 1 轮独立验收（orchestrator） | 五包亲自复跑全绿（core 409 / server 192 / web 148 / vfs 193 / sandbox 70）；抽读 loop 结算路径、字节一致不变量、日志纯旁路、web 卡片 join；#2/#3/#4 状态回填 ✅ | 通过 |
| 2026-07-16 | 语义修订：真实执行口径（主线程） | 用户反馈「串行结算下排队被算进耗时、且缺排队可见性」：`data-tool-timing` 增补 `executionStartedAt`（`executeToolCall` 前一刻；deny 恒缺席=从未执行），web 卡片新增「等待中」徽标 + 已等待跳动，结算后耗时改为真实执行时长（排队/审批等待不再混入），server 日志拆 `durationMs`（执行）/`queueMs`（排队）两字段并新增 executing DEBUG 行；存量记录退回全程口径 | core 410 / server 195 / web 152 全绿（+7 用例）；`tech/single-ledger.md` §3.2、`tech/chat-webapp.md` §11、`features/chat-webapp.md` 同步 |
| 2026-07-16 | 全只读批并行结算（主线程） | 用户确认「一批 tool call 全只读就走并行」：`Tool.readOnly` 纯读声明（core types/defineTool），`read-file`/`list-dir`/`glob`/`grep` 四内置工具打标；`runOneStep` settle 分支——整批全 readOnly 并行（`mergeSettleStreams` 合并出流）、混入写操作整批退回串行（兜住模型偶发的同批隐含顺序依赖坏批次） | core 412 / virtual-fs 194 全绿（含「握手死锁」并行证明与混合批严格串行断言）；`tech/core-sdk.md` §4.1、`tech/builtin-tools.md` 横切规则 7、`tech/single-ledger.md` §3.2 同步 |
| 2026-07-16 | turn 级耗时 + 轮结果条布局（主线程） | `NimboMessageMetadata` 增补 `durationMs`（`runTurn` 入口到收尾的全 turn 墙钟，`finalizeTurn` 统一写入、成功/失败/中断皆有）；web `TurnResultBar` 领头显示「耗时 Xs」，token 数字千分位分组（手写分组，刻意不用 `toLocaleString` 保测试确定性），`tabular-nums` 对齐 | core 413 / web 154 全绿；`tech/single-ledger.md` §2.1、`features/chat-webapp.md` 同步 |
| 2026-07-16 | 轮结果条拆分工具/agent 耗时（主线程） | `NimboMessageMetadata` 增补 `toolDurationMs`（本轮全部 `data-tool-timing` 执行区间的**并集**——并行批重叠只计一次、恒 ≤ `durationMs`，`finalizeTurn` 同落点写入）；web 轮结果条展示「耗时 · 工具 · agent」三段（agent = 总减工具；纯文本轮与旧记录不显示拆分） | core 413 / web 155 全绿（含并行批「并集 ≤ 墙钟」不变量断言）；`tech/single-ledger.md` §2.1、`features/chat-webapp.md` 同步 |
| 2026-07-16 | telemetry 落库（主线程） | ai@7 转正的 `Telemetry` 事件集成（纯回调、零 OTel 依赖）：core `SessionOptions.telemetry` 透传 + loop 每次 `streamText` 恒注入 `functionId="<sessionId>#<turn>"` 关联键；server 新增 `src/telemetry.ts`（独立 `telemetry.db`、载荷收敛 16KB 封顶、回调吞错永不影响 turn、vitest 守卫）经 `ChatRouteDeps.telemetry` 注入默认 chatApp；按 `(session_id, turn)` 建索引即查 | core 415 / server 205 全绿（含 buildSession 端到端落库用例）；`tech/chat-webapp.md` §11.4、`terms.md`「遥测」词条同步 |
| 2026-07-16 | 遥测明细面板（A 方案，主线程） | 统计条保持账本为源，遥测做增强：core `settleExecution` 在 `executeToolCall` 前后**替 AI SDK 补发** `onToolExecutionStart/End`（nimbo 自执行工具，SDK 无机会发；deny 等未执行路径不发），工具耗时进同库同键；server 新增 `GET .../turns/{turn}/telemetry`（`ChatRouteDeps.telemetryStore` 读侧、按 `nimboSessionId`+turn 查、缺数据空数组）并再生 openapi；web `TurnResultBar` 可展开明细面板（首开才拉取、组件内缓存、坏行静默跳过），展示逐模型调用 responseTimeMs/tok/s/usage 与逐工具执行耗时/失败标记 | core 417 / server 209 / web 159 全绿；`tech/chat-webapp.md` §11.4、`features/chat-webapp.md` 同步 |
| 2026-07-17 | 遥测独立成篇（主线程） | 新建 [features/telemetry](../features/telemetry.md)（怎么提供、提供哪些观测数据、与账本分工、范围与非目标）与 [tech/telemetry](../tech/telemetry.md)（存储 + ER 图、有效期定案：耗材/无自动清理/手动管理姿势、写读时序图、接口与取舍）；`tech/chat-webapp.md` §11.4 瘦身为指针，遥测的唯一技术主文档移交 tech/telemetry | 纯文档；三处互链齐全（feature ↔ tech ↔ 本 plan） |
| 2026-07-17 | 汇总条 → 统计按钮 + 弹窗，明细富化（主线程） | 用户反馈「明细太薄、想要一个 stats 按钮点开看全部」：web `TurnResultBar`（常驻汇总条 + 内联薄面板）重写为 `TurnStatsButton`（`components/turn-stats-dialog.tsx`）——界面只留一枚「统计」按钮，点开 `Dialog`；弹窗 = 概览（原汇总条的耗时/工具/agent + usage 四分，来自账本 metadata）+ 富字段明细（`model-call-end` 补出 modelId·finishReason·`timeToFirstOutputMs`（首 token）·输入输出吞吐·token 三分含 `cacheReadTokens`/`reasoningTokens`）+ 工具执行。采集侧零改动（ai@7 事件本就带这些字段，此前面板只挑了 3 个渲染） | web 159 全绿（`turn-stats-dialog.test.tsx` 7 用例含富字段与概览格式化，`timeline-view.test.tsx` 迁为按钮落位断言）；`features/telemetry.md`·`tech/telemetry.md` §4.2·`tech/chat-webapp.md` §11.4·`features/chat-webapp.md` 同步 |
| 2026-07-17 | 修复：工具执行事件从未落库（主线程） | 根因不在 core（`settleExecution` 的 `notifyToolExecution*` 一直在补发），而在**接收端**——server `createSqliteTelemetry` 返回的 `Telemetry` 对象漏挂 `onToolExecutionStart/End`，core `notifyIntegrations` 里 `handler?.(event)` 取到 undefined 就静默跳过，工具事件被发出却无人记录（账本 `toolDurationMs`>0、遥测零工具事件）。补上两个 `record('tool-execution-*')` 回调即修复 | server 211 全绿；新增端到端回归护栏（`telemetry.test.ts` 用 `write-file` 真跑一次工具调用，断言 `tool-execution-start/end` 落库 + toolName/toolExecutionMs 载荷）——旧端到端用例只用 `stopOnlyModel`（无工具调用）故从未覆盖到，正是漏网原因 |
| 2026-07-26 | 起轮装配打点（主线程） | 用户反馈「发完消息要盯着空白等一段时间才有 AI 消息」：新增 `turn-prepare`/`turn-first-output` 两种遥测事件，把 `POST .../messages` 里那段无人测量的[起轮装配](../terms.md)（沙盒 acquire 含 cache/resume/create 三态 + touch + 读账本 + buildSession）与「到首个 chunk / 到首个可见输出」摊开；`turn-runner.ts` 只多一个 `onMilestone` 纯通知点（不认识遥测），拼载荷/落库在 `turn-launcher.ts`；web 统计弹窗新增「本轮准备」小节 | server 379（+9）/ web 236（+3）全绿；`terms.md`、`tech/telemetry.md` §2.4、`features/telemetry.md` 同步 |
