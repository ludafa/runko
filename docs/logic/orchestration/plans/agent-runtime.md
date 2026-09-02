---
title: "轮编排运行时 `@runko/agent`（施工进展）"
slug: agent-runtime
view: 施工
layer: 逻辑层
module: 轮编排
packages: ["@runko/agent"]
tags: ["轮编排", "运行时", "施工拆单", "chat 迁移"]
related: ["logic/orchestration/features/agent-runtime.md", "logic/orchestration/tech/agent-runtime.md", "architecture/plans/agent-kernel.md"]
---

# 轮编排运行时 `@runko/agent`（施工进展）

> 相关：[功能](../features/agent-runtime.md)，[技术方案](../tech/agent-runtime.md)。
> 上位拆单：[agent 内核包 · 施工进展](../../../architecture/plans/agent-kernel.md) 的 K0–K9。**本文是其中 K1 + K2 + K4 + K7 这一批的落地记录**。

## 状态

**✅ 已交付**（2026-08-16）。单测 + 端到端实测结果见文末[验证](#验证方案与实测结果)。

本批覆盖 K1（[进行中草稿](../../../terms.md)放内存 + [起轮标记](../../../terms.md)）、K2（四种宿主能力接口 + 全套内置实现）、K4（队列与插话回到框架）、K7（chat 应用迁移）。

**不在本批**（理由见[技术方案 §7](../tech/agent-runtime.md)）：

| 阶段 | 为什么推迟 |
|---|---|
| **K3 挂起与恢复** | 卡在一个未定的上游问题：core 的「恢复开轮」入口怎么加（扩展 `stream` 入参 vs 并列 `settleAndRun`）。定案前动 core 的 loop 很可能返工 |
| **K5/K6 `persist-sql` + 租约版仲裁** | `apps/node-server` 已有 drizzle schema，让它自己实现领域接口反而是对接口更真实的检验；硬塞一个 `persist-sql` 会造出第二套数据访问方式 |
| **K8 `@runko/cli` · K9 其余实现包** | 依赖 K2 接口先定型 |

## 阶段拆单

| 阶段 | 目标 | 涉及文件 | 产出物 | 状态 |
|---|---|---|---|---|
| **A** | 三份文档 | `docs/logic/orchestration/{features,tech,plans}/agent-runtime.md` | 本三件套 | ✅ |
| **B1** | 包脚手架 + 四种宿主能力接口 | `packages/agent/src/{types,persistence,stream,arbitration,prepare}.ts` | 类型编译通过 | ✅ |
| **B2** | 三样内置实现 | `packages/agent/src/builtin/*.ts` | 内存账本/裁决/队列、进程内流、内存归属表 | ✅ |
| **B3** | 一轮的一生 | `packages/agent/src/runtime/turn.ts` 等 | 占位 → 装配 → 驱动 → 收尾 | ✅ |
| **B4** | 队列编排 + `conversation-drained` | `packages/agent/src/runtime/queue.ts` | `enqueue` 三路分流、自动出队、入队方兜底 | ✅ |
| **B5** | 人在回路桥 | `packages/agent/src/runtime/human.ts` | 审批 / ask-user 的 promise 路由 + 裁决落库 | ✅ |
| **B6** | 停止 · 交权 · 崩溃恢复 | `packages/agent/src/runtime/{abort,shutdown,recovery}.ts` | 三条收尾路径 | ✅ |
| **B7** | 单测 | `packages/agent/test/*.test.ts` | 零配置跑通一个会话；各条边界路径有用例 | ✅ |
| **C1** | chat 侧持久化适配 | `apps/node-server/src/agent/persistence.ts` | drizzle 实现三个 Store | ✅ |
| **C2** | chat 迁移 | `apps/node-server/src/agent/runtime.ts`、`routes/chat.ts` | 删掉 `turn-runner/` 与 `turn-launcher.ts` | ✅ |
| **C3** | chat 侧测试对齐 | `apps/node-server/test/**` | 跑绿 | ✅ |
| **D** | web 侧对齐 | `apps/web/src/features/chat/**` | 跑绿 | ✅ |
| **E** | 端到端实测 | 浏览器 | 发消息 / 流式 / 停止 / 排队 | ✅ |

## 迁移对照：chat 应用删了什么、换成什么

| 删掉 | 换成 |
|---|---|
| `agent/turn-runner/registry.ts` | 框架内部的活跃轮登记表 |
| `agent/turn-runner/reservation.ts` | `arbitration.acquire()` 的[起轮标记](../../../terms.md) |
| `agent/turn-runner/start.ts` · `drive.ts` | 框架的一轮驱动 |
| `agent/turn-runner/persistence.ts` | `LedgerStore` + 内存草稿 |
| `agent/turn-runner/human-bridge.ts` | 框架的人在回路桥 |
| `agent/turn-runner/abort.ts` · `shutdown.ts` | `runtime.abort()` / `runtime.shutdown()` |
| `agent/turn-launcher.ts` | `prepareTurn` 装配器 + runtime 装配（`agent/runtime.ts`） |
| `agent/crash-recovery.ts` | `runtime.recover()` |
| `agent/store.ts` 的队列段 | `QueueStore` 的 drizzle 实现 |

**保留在 chat 层**（产品决策，不是框架职责）：`approval-policy.ts`、`conversation-grants.ts`、`split-command.ts`、`sandbox-manager.ts`、`skill-catalog.ts`、`chat-agent.ts`、`e2b-template.ts`、`github-repo.ts`、`web-search.ts`、遥测、推送。

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-08-16 | 三份文档落地；范围定在 K1+K2+K4+K7，K3/K5/K6 显式推迟并写明理由 |
| 2026-08-16 | `packages/agent` 落地：四种宿主能力接口 + 三样内置实现 + 一轮的一生 + 队列编排 + 人在回路桥 + 停止/交权/崩溃恢复，61 个单测跑绿 |
| 2026-08-16 | `apps/node-server` 迁移完成：删 `turn-runner/`（9 文件）、`turn-launcher.ts`、`crash-recovery.ts`，换成 `agent/runtime.ts` + `agent/persistence.ts`；`routes/chat.ts` 全部端点改走 runtime；账本从此只写 `kind='message'` 行 |
| 2026-08-16 | `apps/web` 对齐：`lastFrameIsChunk` 猜测退役（历史里不再有 chunk 行，那个猜测恒为假），会话详情新增 `turnInProgress` 字段——服务端读[起轮标记](../../../terms.md)那一列直接给出答案，零额外查询 |
| 2026-08-16 | 顺带修 `@runko/core`：`createSession({ resume })` 现在接受空账本（`messages: []`）。此前被 ai 的 `validateUIMessages()` 拒掉，而这正是「让会话 id 从第一轮起就稳定」所需要的形态 |

## 验证方案与实测结果

### 1. 单测

| 跑什么 | 结果 |
|---|---|
| `pnpm --filter @runko/agent test` | **61 passed**（行覆盖 93.5%）——零配置跑通一个会话、`enqueue` 三路分流、自动出队、停止（含装配窗口内停止）、交权、崩溃恢复、失去独占权、人在回路两条通道、驱动器的两条失败路径 |
| `pnpm --filter @runko-chat/node-server test` | **395 passed** |
| `pnpm --filter @runko-chat/web test` | **278 passed** |
| `pnpm -r build` · `pnpm -r typecheck` | 全绿（14 个成员）；`docs:check` + `docs:build`（含全站死链检查）通过 |

### 2. 端到端实测（2026-08-16，真 E2B 沙盒 + 真模型）

浏览器登录 `test@test.com` → 新建 E2B 会话 → 逐条走完下面每一项，全部符合预期：

| # | 场景 | 观察到的 |
|---|---|---|
| E1 | 打开旧会话 | 历史完整回放（含迁移前留下的 `kind='chunk'` 行——读时被滤掉，不影响渲染） |
| E2 | 发一条消息 | 起轮标记写下（`turn_holder = pid:51028`）；直播流按序到达（推理块 → 工具卡片 + 计时 → 正文）；收尾后标记清空 |
| E3 | 账本形态 | 一轮跑完账本里**只有 `kind='message'` 行**，零 chunk 行——[进行中草稿](../../../terms.md)确实只在内存 |
| E4 | 第二轮 | 收尾消息的 `metadata.turn` 从 1 递增到 2——轮号从账本推导正确 |
| E5 | 轮进行中再发一条 | 进[待发队列](../../../terms.md)，界面待发区显示「1 条待发」，库里是框架的 `QueuedInput` 形状 |
| E6 | 按停止 | 这一轮以 `status:'interrupted'` + `error.code:'aborted'` + 「Turn stopped by the user.」收尾；**队列一并清空**，那条排队消息没有被发出去 |
| E7 | 轮进行中刷新页面 | 重连后进行中的工具卡片原样重现（内存草稿整份重发，靠幂等吸收）；待发队列也还在 |
| E8 | [自动出队](../../../terms.md) | 上一轮收尾后排队那条自动起了下一轮（turn 4 → turn 5），队列随即清空 |
| E9 | 审批卡片 | 危险命令弹出三按钮卡片；[裁决表](../../../terms.md)里出现一条待定行（带 toolName + 原始入参） |
| E10 | 点「会话内都允许」 | 裁决结清（`outcome: allow` / `scope: conversation` / `decided_by`）+ 落下一条[分段授权](../../../terms.md)（`bash#seg {argv:["rm","-f",…]}`）；命令随即执行、这一轮正常收尾 |

**没有实测的一条**：真的 `kill -9` 服务端进程再重启，看孤儿轮补收尾。它由 `apps/node-server` 的集成用例覆盖（模拟「标记还在但没人驱动」的状态，`runtime.recover()` 扫出并补一条 `interrupted`）——真机那次要杀掉开发者自己的 dev server，不该由脚本代劳。

### 3. 手工复跑清单（操作序列）

上面 §2 是一次性的实测记录，这一节是**可以反复跑的操作序列**——每次动了轮编排都照它走一遍。

工具是 [`apps/node-server/scripts/chat-smoke.sh`](../../../../apps/node-server/scripts/chat-smoke.sh)（`./scripts/chat-smoke.sh` 看全部子命令）。**用 curl 而不是浏览器**，因为这几组里有两组要**量时间**（按下停止到真的停有多久）、有一组要**卡在特定状态**（正等审批时），浏览器不好掐点。界面那条道单独走 §2 的 E1–E10。

**一个让手工验证变可控的小技巧**：让 agent 去跑 `sleep N`。这样"一轮要跑多久"由你说了算，不用跟模型的速度赛跑。`sleep` 不在危险清单里，会被自动放行。

> 前置：dev server 由你自己起（`pnpm chat:server`），本清单不起任何常驻进程。

**开两个终端**：窗口 A 挂 `./scripts/chat-smoke.sh watch`（过滤后的直播流，带时间戳），窗口 B 敲命令。

> `watch` 内部是**断线自动重连**的循环，不是一条长连接——`GET .../stream` 走的是 `follow: 'turn'`，**一轮结束它就会关**（web 端也是每次发消息重新开流）。重连时带上 `?after=<已见最大 seq>`，所以不会把历史重放一遍；重复的队列/轮状态帧也会被就地去重。

**想用界面跑也可以**，键位是（`message-composer.tsx`）：**Enter = 排队**、**⌥⏎ 或工具条上「插入当前轮」= 插话**。轮进行中界面还会显示「N 条待发」，每条带「插进本轮」「删除待发消息」两个入口，第 9 组用得上。只是界面掐不准点，第 5 组那 5 秒门槛还是得看 `watch` 的时间戳。

#### P · 准备

| 步 | 窗口 B 敲 | 应该看到 |
|---|---|---|
| P1 | `cd apps/node-server && ./scripts/chat-smoke.sh login` | 返回 `token` + `user` |
| P2 | `./scripts/chat-smoke.sh new "轮编排验证"` | 返回新会话，id 自动记住 |
| P3 | 窗口 A：`./scripts/chat-smoke.sh watch` | 挂住不动，后面每一步都盯它 |

#### 第 1 组 · 跑通一轮

> 测的是起轮 → 驱动 → 收尾整条链。

| 步 | 操作 | 应该看到 |
|---|---|---|
| 1.1 | `say "运行 sleep 5，然后回我 done"` | 立刻返回 `mode: "started"` |
| 1.2 | 盯窗口 A | 依次：`turnActive:true` → 若干 chunk → assistant 成品消息 → `status:"completed"` → `turnActive:false` |
| 1.3 | `show` | `turnInProgress: false` |
| 1.4 | `ledger` | `message` 行数涨了，**`chunk` 行一行没涨** |

失败说明什么：1.2 卡住 = 起轮或收尾链路断了；1.4 的 chunk 行涨了 = [进行中草稿](../../../terms.md)又落库了。

#### 第 2 组 · 排队与自动出队 ⭐

> 本次改动的核心机制。**验收标准是：三轮全跑完，你只发了三次消息，一次「继续」都没点。**

| 步 | 操作 | 应该看到 |
|---|---|---|
| 2.1 | `say "运行 sleep 90，然后回我 A 完成"` | `mode: "started"` |
| 2.2 | 马上（趁 sleep 还没完）`say "回我 B 完成"` | **`mode: "queued"`**；窗口 A 出现 `queue` 帧，1 条 |
| 2.3 | 再 `say "回我 C 完成"` | 仍 `queued`；`queue` 帧 2 条 |
| 2.4 | `show` | `turnInProgress: true`，`queuedMessages` 两条，顺序 B、C |
| 2.5 | **什么都别做**，盯窗口 A | `turnActive:false`（A 收尾）→ `queue` 剩 1 条 → `turnActive:true`（B 自己起来了）→ B 收尾 → `queue` 空 → `turnActive:true`（C）→ C 收尾 |

失败说明什么：2.2 返回 `started` = 分流判错（并发起了两轮）；2.5 停在某一轮不再往下 = [自动出队](../../../terms.md)坏了，或撞上了 [`conversation-drained`](../../../terms.md) 那个竞态而兜底没生效。

#### 第 3 组 · 插话

| 步 | 操作 | 应该看到 |
|---|---|---|
| 3.1 | `say "运行 sleep 90，然后回我 原计划"` | `mode: "started"` |
| 3.2 | 等 5 秒，`steer "改主意了，直接回我：插话成功"` | **`mode: "steered"`** |
| 3.3 | 盯窗口 A | **没有**第二次 `turnActive:true`；这一轮的回复里出现「插话成功」 |

失败说明什么：3.2 返回 `queued` 有两种可能——这一轮还卡在[起轮装配](../../../terms.md)里（正常回落，隔几秒重试一次即可），或者 `steer` 真的没接上。

#### 第 4 组 · 停止，以及「停止即清空队列」

| 步 | 操作 | 应该看到 |
|---|---|---|
| 4.1 | `say "运行 sleep 120，然后回我 不该出现"` | `mode: "started"` |
| 4.2 | `say "X"`；`say "Y"` | 两次都 `queued` |
| 4.3 | `stop` | 200，body 里 `queue: []` |
| 4.4 | 盯窗口 A | **几秒内**出现 `status:"interrupted"` → `turnActive:false`；**没有**任何一轮为 X/Y 起来 |
| 4.5 | `show` | `turnInProgress:false`、`queuedMessages: []` |

失败说明什么：要等 sleep 120 跑完才停 = 停止信号没传到 exec；X/Y 被执行了 = 「停止即清空队列」坏了。

#### 第 5 组 · 正等审批时按停止 ⭐

> 本次语义改了的地方。`rm -rf` 命中危险清单（默认 `CHAT_APPROVAL_MODE=dangerous`），会停下来等人。

| 步 | 操作 | 应该看到 |
|---|---|---|
| 5.1 | `new "审批停止"`；窗口 A `Ctrl-C` 后重开 `watch` | 切到新会话 |
| 5.2 | `say "先建一个 tmp-demo 目录，然后用 rm -rf tmp-demo 把它删掉"` | `mode: "started"` |
| 5.3 | 等窗口 A 出现 `approval-requested` | 这一轮挂住了，在等人 |
| 5.4 | `pending` | 裁决表里一行待定，带 `tool_call_id` 与原始入参 |
| 5.5 | **这时** `stop`，记下时间 | —— |
| 5.6 | 看窗口 A 的时间戳 | **从 stop 到 `turnActive:false` 应在 5 秒内** |

失败说明什么：如果要等好几分钟才停，就是这条回归了——没拦住的话审批请求会一直挂到自己的超时（默认 240 秒），把「停止」拖成「四分钟后停止」。对应实现是 `packages/agent/src/runtime/human.ts` 里 `requestReview` 开头那句 `if (turn.aborted)`。

#### 第 6 组 · 审批的三个出口

| 步 | 操作 | 应该看到 |
|---|---|---|
| 6.1 | 照 5.2 再触发一次，`pending` 拿 callId | —— |
| 6.2 | `approve <callId>` | 窗口 A 出现 approval-responded；命令真的执行；这一轮正常收尾 |
| 6.3 | 再触发一次，`deny <callId> "这次不行"` | 命令没执行；模型收到拒绝理由后改口 |
| 6.4 | 再触发一次，`approve-session <callId>`，然后**原样再发一次同一条命令** | 第二次**不再问人**（裁决表行数不变），命令直接执行 |
| 6.5 | `pending` | 空——每一条都结清了 |

> **[分段授权](../../../terms.md)是按完整 argv 记的，不是按工具记**——授权表里的 key 长这样：`bash#seg {"argv":["rm","-rf","/tmp/demo-c"],"cwd":null,"redirects":[]}`。所以「会话内都允许」之后，换个路径的同类命令**还是会问**。6.4 要验的是「同一条命令不再问」，别拿相似命令去试。

#### 第 7 组 · 断线重连，草稿重发 ⭐

> 本次改动重点：[进行中草稿](../../../terms.md)不再落库，只在内存。

| 步 | 操作 | 应该看到 |
|---|---|---|
| 7.1 | `say "写一篇 300 字左右的短文，讲讲为什么要写测试"` | 正文开始一段段往外冒 |
| 7.2 | 冒到一半，**`Ctrl-C` 掐掉窗口 A 的 watch** | —— |
| 7.3 | 立刻重新 `watch` | 重放里有 `start` / `text-start` / 工具卡片这些**结构帧**，但**没有已经流过去的 `text-delta`**；正文从重连那一刻往下接 |
| 7.4 | `ledger` | `chunk` 行数**没变**（恒为 0） |
| 7.5 | 等这一轮收尾后再看 | 完整正文**回来了**——收尾时整条成品消息落账本 |

**7.3 缺一段正文是设计如此，不是 bug**：`turn.draft` 只收 durable chunk，`isDurableChunk` 明确把 `text-delta` / `reasoning-delta` 排除在外（`packages/agent/src/runtime/turn.ts`）——增量脱离顺序重放反而会把文本写坏。

代价是**有一个窗口**：从重连那一刻到这一轮收尾，界面上这条回复会缺开头一段。窗口在收尾时自动闭合（7.5）。要消掉这个窗口，就得让草稿也留住增量，那是另一个取舍（写入量 vs 重连保真度），本批没做。

失败说明什么：结构帧也没有 = 重放真的没做；`chunk` 行数涨了 = 草稿又落库了。

#### 第 8 组 · 崩溃恢复 ⭐（需要你自己动手）

> 唯一一组要杀进程的。**dev server 归你自己管，这两步不该由脚本或 agent 代劳。**

| 步 | 操作 | 应该看到 |
|---|---|---|
| 8.1 | `say "运行 sleep 300"` | `mode: "started"` |
| 8.2 | `holder` | 一行，`turn_holder` 形如 `pid:12345`——[起轮标记](../../../terms.md)写下了 |
| 8.3 | **你自己** `kill -9` 掉 server 进程 | —— |
| 8.4 | `holder` | 那一行**还在**（进程没来得及清）——这就是[孤儿轮](../../../terms.md) |
| 8.5 | **你自己**重启 server | 启动日志里有恢复扫描 |
| 8.6 | `holder`；`show` | `holder` 空了；`turnInProgress: false` |
| 8.7 | 浏览器刷新那条会话 | **不转圈**，能直接发下一条 |

失败说明什么：界面永远转圈 = `runtime.recover()` 没扫到孤儿轮，或扫到了没清标记。

#### 第 9 组 · 队列增删

| 步 | 操作 | 应该看到 |
|---|---|---|
| 9.1 | 起一轮长的，排 3 条 | `queue` 帧 3 条 |
| 9.2 | `show` 拿中间那条的 id → `delq <id>` | `queue` 帧变 2 条，剩下两条顺序不变 |
| 9.3 | `clearq` | `queue` 帧空 |
| 9.4 | 等当前轮收尾 | **不该**有任何排队轮起来 |

#### 怎么挑

- **只想验这次换掉的语义**：P + 第 2、5、7、8 组（带 ⭐ 的）。其余四组单测里已经钉死。
- **改完轮编排的全量回归**：九组全走。
- **花费**：每组 1–3 次真实模型调用 + 一个真沙盒；全跑一遍约 20–30 分钟，其中大半时间在等 `sleep`。

跑完把结论追加到下面的[变更记录](#变更记录)，别改 §2 那张表——那是 2026-08-16 那一次的存档。

### 4. 复跑实测（2026-08-23，真 E2B 沙盒 + 真模型）

会话 `e66d2b3b`，浏览器（agent-browser）+ `chat-smoke.sh` 混合驱动。**第 8 组之外全部通过**；同一条会话跑完 44 条成品消息，账本里 **`chunk` 行恒为 0**、起轮标记每轮收尾即清空。

| 组 | 结论 | 实测到的 |
|---|---|---|
| 1 · 跑通一轮 | ✅ | 13 秒跑完；账本 3 条 message、0 条 chunk |
| 2 · 排队 + 自动出队 | ✅ | 三轮连跑，**一次「继续」都没点**；交棒间隔 **1.06s / 1.07s**（A 收尾 20:18:17.045 → B 起轮 20:18:18.109 → B 收尾 20:18:21.152 → C 起轮 20:18:22.222） |
| 3 · 插话 | ✅ | 只有**一次** `turnActive=true`，没起新轮；插进去的话是 seq=14，回复 seq=15 |
| 4 · 停止 + 停止即清队 | ✅ | 按下 20:20:51.744 → `interrupted` 20:20:51.783，**39ms**；排着的 X/Y 一条都没执行 |
| 5 · **正等审批时按停止** | ✅ | 按下 20:21:46.270 → `interrupted` 20:21:46.307，**37ms**；审批当场 deny、裁决表结清（老实现这里会挂满 240 秒） |
| 6 · 审批三个出口 | ✅ | 允许→真执行（退出码 0）+ `scope: once`；拒绝→`output-denied`、模型改口、轮仍 `completed`；会话内都允许→`scope: conversation`、同一条命令再来裁决表 5→5 不再问 |
| 7 · 断线重连 | ✅（**期待改写**） | 结构帧重放，`text-delta` 不重放；详见上面 7.3 的说明 |
| 8 · 崩溃恢复 | ⬜ 未验 | 见下 |
| 9 · 队列增删 | ✅ | 删中间一条 → `[Q1, Q3]` 顺序不变、界面同步；清空 → 空；收尾后没有排队轮起来 |

**顺带验到的两条**（不在原清单里）：

- **审批 240 秒超时自动拒绝**，且这一轮照常干净收尾（`completed` + `output-denied`），模型能读懂「超时未获批准」并改口。
- **优雅关闭**：`--watch` 的 dev server 在一轮进行中重启，那一轮被收成 `status: interrupted` + `error.code: aborted` + 「Server is shutting down; this turn was interrupted.」，**已经写出的正文完整保留在账本里**，起轮标记清空。

**第 8 组为什么还是没验**：那次意外重启走的是 SIGTERM → 优雅关闭那条路，`kill -9` **会跳过它**，两条是不同的代码路径。真崩溃仍需按 8.1–8.7 由开发者自己动手。

**本次复跑改掉的三处**（清单原来是错的）：

1. `watch` 原写「挂着不动」——`GET .../stream` 是 `follow: 'turn'`，一轮结束就关。已改成断线自动重连 + `?after=` 跳过历史 + 重复帧去重。
2. 6.4「之后同类命令不再问」——分段授权按**完整 argv** 记，换个路径照样问。已改成「原样再发同一条命令」。
3. 7.3「已经输出过的那段整份重来一遍」——`text-delta` 不在草稿里，不会重放。已按实际行为重写，并写清那个窗口。

## 已定案（2026-08-22 构建者拍板）

原来这里挂着 11 个待拍板的问题，**已全部定案**。按「有没有代码落地」分两组。

### 已落地（本批一并交付）

| # | 问题 | 定案 | 落在哪 |
|---|---|---|---|
| **Q2** | `queue.steer` 的形态（两份文档打架） | **两个都要**：`'never' \| 'always' \| 'onRequest' \| ((input) => boolean)` | `SteerPolicy`（`runtime/context.ts`）；回调拿整条 `TurnInput`，抛错回落成排队 |
| **Q3** | 收尾状态加不加第四种 `suspended` | **现在就加**，不等 K3 | core `RunkoMessageMetadata.status` + zod；`@runko/agent` `TurnStatus`；node-server `TurnEndStatus` |
| **Q4** | 「会话内都允许」怎么表达 | **`scope: 'once' \| 'conversation'`**，框架只**记**、不执行 | 见下方「Q4 为什么不叫 session」 |
| **Q7** | `events` → `messages` 改名 | **做**——「没发布过，名义对齐更重要」 | `GET .../messages`，与既有的 `POST .../messages` 配成一对；openapi + kubb client 已重生成 |
| **Q9** | `workspaceRetention` 做不做 | **不做，并从 runtime 配置里删掉**，改记进[沙盒契约 §4.6](../../../host/contract/tech/sandbox.md) | 留存期归适配器：E2B 暂停后无限期保存，统一开关会骗人 |

### 不做 / 延后（只更新了文档状态）

| # | 问题 | 定案 |
|---|---|---|
| **Q1** | core 的「恢复开轮」入口 | **选 B：并列一个 `settleAndRun(callId, decision)`**，`stream()` 签名不动。K3 的前置就此解开 |
| **Q5** | `reportPresence` 现在补还是等 K3 | **等 K3**——现在补是空壳，接口形状要等真做挂起才知道 |
| **Q6** | K5 `@runko/persist-sql` | **推翻「取消」，现在就做**，并把 node-server 改造过去（用 drizzle，是搬家不是重写）。单列一批走完整三文档流程 |
| **Q8** | `kind='chunk'` 垃圾行真删吗 | **不删**——都是测试数据。（顺带纠正：施工文档原先写的「几十万行」是错的，dev 库实测 **425 行**，全表 860 行） |
| **Q10** | turn-checkpoint 排期 | **往后延** |
| **Q11** | 总纲「还没定的」第 1、2 条 | **都关闭**；第 2 条改写成一条独立待办（见总纲施工进展） |

### Q1 · 为什么选 `settleAndRun` 而不是扩 `stream()` 的入参

两件事的**语义不一样**：`stream()` 是「拿一条新的用户输入，开一轮」，恢复是「结清一个悬着的调用，然后继续」——后者的输入根本不是一条 user 消息，硬塞进 `input` 会把 `Input` 变成联合类型、每个调用点都得收窄一次。加上 `stream()` 现在被 agent / sdk / examples / 两个 app 一起消费，为一个新功能让所有人改签名不划算。

**但它不是白捡的**：`settleAndRun` 内部要复用 `stream()` 的绝大部分（装配、深层校验、steer 队列、收尾元数据），实现上大概率得把生成器体抽出来给两个入口共用。这部分工作量两个方案一样，B 省掉的只是「所有调用点跟着改签名」。

### Q4 · 为什么是 `conversation` 而不是 `session`

原实现记的是含糊的 `'broader'`（「比这一次更宽」，不定义宽到哪），理由写的是「框架不知道有『会话』这个粒度」。**这条理由不成立**——框架当然知道，它的 API 全是 `enqueue(conversationId, …)` / `subscribe(conversationId)` / `conversation-drained`。既然知道，就该记准确的范围名。

候选里 `session` 被否掉：它作为「聊天会话」的叫法已于 2026-07-17 **正式退役**（见[术语表](../../../terms.md) `conversation` 词条），退役动机正是解开 `session` 的三重超载；同一张表里 `conversation-drained` 还把 `session-drained` 标为**禁用**「会造成第四重超载」。而且在本仓库 core 的 `Session` 恰恰**不是**跨轮实体（每轮重新装配），跟这里要表达的「多个轮归属的那个实体」语义相反，用它会真的引起误解。

**框架只记、不执行**：它不会在后续轮里查裁决表替宿主自动放行。记账粒度（按整条调用的入参指纹？按[命令段](../../../terms.md)拆？按用户分账？）是宿主的产品决策。所以：

- 框架层 `scope: 'conversation'` —— 说的是**范围**
- 宿主 wire 上 `behavior: 'allow-session'` —— 说的是**用户点了哪个按钮**（一个产品动作），**刻意不跟着改名**

两个词分属两层，各自都对。连带把 chat 层的 `session-grants.ts` 更名为 `conversation-grants.ts`（它对应的表本来就叫 `conversation_grants`，文件名反倒是不一致的那个），三个导出符号同步更名。

### 连带的两处

- **数据迁移 `0011_decision_scope_conversation.sql`**：把存量 `scope='broader'` 刷成 `'conversation'`。`scope` 列没有 CHECK 约束（drizzle 的 `enum` 只是类型级），所以不用重建表；本表是纯审计表，刷是为了让库里的值别跟 TS 类型对不上。**尚未在 dev 库上执行**（跑 `pnpm --filter @runko-chat/node-server db:migrate`）。
- **`suspended` 目前没有产出方**：core 的 `finalizeTurn` 至今只产出前三态，K3 落地才会真写出来。先进联合类型是为了让宿主/界面提前占好渲染分支；core 的穷尽性测试会保证它不被遗漏。
