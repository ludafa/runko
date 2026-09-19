---
title: "挂起与恢复（施工进展）"
slug: suspend-resume
view: 施工
layer: 逻辑层
module: 轮编排
packages: ["@runko/agent", "@runko/core"]
tags: ["挂起", "恢复", "等人状态", "审批", "ask-user", "收尾状态", "多副本"]
related: ["logic/orchestration/features/suspend-resume.md", "logic/orchestration/tech/suspend-resume.md", "architecture/plans/agent-kernel.md", "logic/orchestration/plans/agent-runtime.md"]
---
# 挂起与恢复（施工进展）

> 相关：[功能](../features/suspend-resume.md)，[技术方案](../tech/suspend-resume.md)。
> 这是[路线图](../../../architecture/plans/agent-kernel.md)里的 **K3**——框架主线中唯一还没做的核心能力。

## 状态

**S0（三份文档 + 术语）已交付**（2026-09-18）。三件开工前的问题**全部定案**（见下）。
**S1（core 侧的挂起出口）已交付**（2026-09-19）。
**S2（core 侧的恢复入口 `settleAndRun`）已交付**（2026-09-19）。**core 这一侧就此完工**。
**S3（agent 侧的挂起）已交付**（2026-09-19）。
**S4（agent 侧的恢复）已交付**（2026-09-19），S5 的前两项作为它的前置一并交付。**挂起与恢复的主链路就此打通**：窗口到点挂起、人回来在任意副本上接着干。
**S5（存量缺口三处）已交付**（2026-09-19）。第 3 项补的是 chat 前端：S3 之后，挂起的卡片会被画成「已失效」，人答不了；现在能答、答完能看到它接着跑。
**S6（配置面）、S7（验收）、S8（chat 应用接入）已交付**（2026-09-19）。S8 原按 P1 单列，用户要求并入本批。全部阶段完成，只剩 chat 应用的真浏览器实测等人来跑。

> ✅ **S3 与 S4 已一起交付**，下面这条风险已解除，留作记录：
>
> ⚠️ **S3 与 S4 之间别上线、别重启 chat 服务。** S3 让窗口到点从「当拒绝」变成「挂起」，而恢复要到 S4 才有。`apps/node-server` 吃的就是这个 agent 包：此时重启它，等人超过 240 秒的会话会挂起，之后人答不了（`submitDecision` 报 404）、新消息也只进队列不跑——**会话卡住**。chat 应用的测试是绿的，只是因为它没测这条路径。

**本批范围**：`@runko/core` + `@runko/agent`，用 `apps/persist-demo` 两进程 e2e 验收。chat 应用接入（S8）单列一批。

## 开工前的三件事（2026-09-18 全部定案）

| # | 问题 | 定案 | 影响面 |
|---|---|---|---|
| **P1** | 本批范围到哪 | **框架（core + agent）+ persist-demo 验收**。chat 应用单列一批 | **S8 不在本批**。好处是框架接口先经一轮真实检验，再去改产品代码 |
| **P2** | 与 K10（可观测性事件层）的顺序——路线图原定 K10 在前 | **先做 K3**，K10 落地时回来补挂起相关事件 | 不用停下来等 K10。理由见[技术方案 · 附录 B](../tech/suspend-resume.md)：`onTurnSettled` 的载荷已带 `status`，挂起的可观测性已有出口；K10 补的是跨副本 trace 关联，属观测缺口不是功能缺口 |
| **P3** | `ctx` 上挂起出口的形状 | **抛专用信号 `SuspendSignal`**，并配一个 ctx 标记兜底（loop 的判据看标记，不看有没有接到异常，于是 `try/catch` 吞掉也不影响正确性）。`SuspendSignal` **不继承 `Error`** | 决定 S1 的接口形状。⚠️ **推翻了本文最初的建议**（哨兵返回值）——哨兵会被工具自己的包装层吃掉，而挂起是不该经中间层加工的控制流终止。完整推演见[技术方案 §3.4](../tech/suspend-resume.md) |

## 阶段拆单

依赖是一条链：**S1 → S2 → S3 → S4 → S7**。其中 **S5 的前两项是 S4 的前置**（恢复判据的可信度全靠它们），S6 可并行插入。S8 已按 **P1** 移出本批。

| 阶段 | 目标 | 涉及 | 产出物 | 状态 |
|---|---|---|---|---|
| **S0** | 三份文档 + 术语登记 | `docs/*` | 本三件套 + `terms.md` 新词条 | ✅ 已交付 |
| **S1** | core：让一次调用能说「我要挂起」 | `@runko/core` | 第三种审批结局 + 工具挂起出口 + 四值收尾 | ✅ 已交付 |
| **S2** | core：恢复入口 `settleAndRun` | `@runko/core` | 从「结清一次悬空调用」开始的一轮 | ✅ 已交付 |
| **S3** | agent：一轮以 `suspended` 收尾 | `@runko/agent` | 内存窗口到点挂起、归属释放、裁决表不结清 | ✅ 已交付（⚠️ 必须与 S4 一起上线，见该节） |
| **S4** | agent：人回来在任意节点恢复 | `@runko/agent` · `persist-*` · `conformance` | 裁决表当收件箱 + 推一把 + 恢复轮 | ✅ 已交付 |
| **S5** | 存量缺口三处 | `@runko/agent` · `apps/web` | 裁决表不再漏出「永远待定行」；前端认得出挂起、人能接着答 | ✅ 已交付 |
| **S6** | 配置面与兼容 | `@runko/agent` | `suspend.*` + `reportPresence` + 旧参数废弃别名 | ✅ 已交付 |
| **S7** | 验收：一致性套件 + 两进程 e2e | `@runko/conformance` · `apps/persist-demo` | 四档库都能跨副本恢复 | ✅ 已交付 |
| **S8** | chat 应用接入 | `apps/node-server` · `apps/web` | 真实宿主上跑通 | ✅ 已交付（用户要求并入本批；真浏览器实测待人来跑） |

---

### S0 · 文档与术语

**目标**：三份文档落地，新概念全部进术语表。

**涉及**：`docs/logic/orchestration/{features,tech,plans}/suspend-resume.md`、`docs/terms.md`。

**术语要补的词条**：

| 词条 | 为什么要登记 |
|---|---|
| **恢复（resume）** | ⚠️ **这个词在术语表里已经被用于三件不同的事**：`SessionState` 的下轮 `resume`、沙盒的[重连令牌](../../../terms.md)（resume token）、崩溃恢复。K3 的「恢复」是第四个。必须立一个主术语并在词条里列出这三个近邻，否则文档里每次写「恢复」都要读者自己猜 |
| **内存窗口（memory window）** | 新概念：挂起前先在内存里等的那一段。与[审批保活预算](../../../terms.md)同默认值但不是同一件事（一个管框架等多久，一个管沙盒续多久） |
| **在场上报（reportPresence）** | [在场](../../../terms.md)词条已有（推送通知那一节的定义），本批给它加了第二个用途：延长内存窗口。在既有词条上补一句即可，不新立 |

**要一并修订的既有文档**：

| 文档 | 改什么 | 什么时候改 |
|---|---|---|
| [`terms.md`](../../../terms.md) 「挂起」词条 | 补一句状态标记：本批之前**未实现** | S0 |
| [架构总纲 · 功能](../../../architecture/features/agent-kernel.md) 开头 | ⚠️ 那句「**包尚未实现**，下面的 API 形状是方案」**本身已经过期**——`@runko/agent` 早已交付。它是全文唯一的「这是方案不是现状」提示，失效之后 §7.1 那段现在时的挂起描述就没有任何信号提示读者「还没做」 | S0 |
| [架构总纲 · 功能](../../../architecture/features/agent-kernel.md) §5 · §7.1 | `suspend` 配置与「等人时这一轮会消失再回来」用的是现在时，要加局部状态标记，链到本文 | S0 |
| [多副本部署 · 技术方案](../../../host/node/tech/multi-replica.md) | 「**挂起还没做。** 等人时仍然占着归属与沙盒」——本批做完要改，并补转发规则那一条（[技术方案 §9.1](../tech/suspend-resume.md)） | S7 之后 |
| [chat 聊天 webapp · 技术方案](../../../ingress/tech/chat-webapp.md) | 描述的还是迁移前的 `turn-runner/human-bridge.ts`（已删）与 240 秒超时。属存量失效，本批顺带修 | S8（或单列） |
| [架构总纲 · 施工进展](../../../architecture/plans/agent-kernel.md) | K3 状态、路线图第 2 项、K10/K3 顺序（按 **P2** 的结论） | 本批收口时 |

**验收**：`pnpm docs:check` + `pnpm docs:build` 两步跑绿（后者含全站死链检查）。

---

### S1 · core：让一次调用能说「我要挂起」

**目标**：loop 认识第三种结局，并且**什么都不写**。

**涉及**：`packages/core/src/` 的 `loop.ts`（`settleToolCall` / `finalizeTurn` / `StepOutcome`）、`types.ts`（`ApprovalDecision`、工具执行上下文）、`state.ts`（收尾元数据）。

**产出物**：

1. `ApprovalDecision` 加 `{ behavior: "suspend" }`；`settleToolCall` 收到它时：不改工具部件（保持 `approval-requested`）、不 yield response、不执行、直接结束本轮。
2. 工具执行上下文上的挂起出口 `ctx.suspend()`（**P3**：抛不继承 `Error` 的 `SuspendSignal` + 在 ctx 上打标记；loop 的判据看标记）。工具部件保持 `input-available`，不写 output。
3. 「本轮到此为止」一路传到 `runTurn`——**走返回值，不走异常**：`settleToolCall` 的返回值带上挂起标记，`StepOutcome` 汇总，`runTurn` 据此以 `suspended` 收尾。
4. `finalizeTurn` 的状态参数从三值扩成四值；收尾元数据加 `suspended: { callIds, reason }`。

**依赖**：无（本批起点）。

**验收**：✅ **全部通过**（2026-09-19）。新增 `packages/core/test/suspend.test.ts` 共 18 条；core 479 条全绿，全仓 packages + 五个 app/examples 的 typecheck、test、lint、`check:doc-links` 全绿。

- ✅ 审批返回 `suspend` → 部件仍是 `approval-requested`，流里没有 `tool-approval-response` 与任何 `tool-output-*`，收尾 `status === "suspended"`。
- ✅ 一步里两个调用，一个执行完一个挂起 → 执行完那条的结果留在账本。另测了「前一个挂起也不早退，后一个照样结算完」。
- ✅ **P3 双保险**：工具在 `ctx.suspend()` 外面套 `try { ... } catch { return "先跳过" }` → 本轮照样挂起，那个返回值连 `outputSchema` 都不过，不进账本。
- ✅ 穷尽性测试继续跑绿。
- ✅ 另补：`SuspendSignal` 不继承 `Error`；once 记忆不被污染；timing 部件无 `executionStartedAt`；并行批的 `callIds` 不随完成顺序飘；挂起前的文件变更照常落账；收尾路径不 drain steer 队列；真抛错仍按 `failed` 处理。

**变异测试**（证明用例真咬得住）——三个变异，全部被抓住：

| 变异 | 挂掉的用例数 |
|---|---|
| 去掉 `executeToolCall` 正常返回路径的挂起检查（即拆掉双保险的第二条） | 2 |
| 把审批的 `suspend` 分支改成走 deny 那套写入 | 1 |
| 拿掉 `runTurn` 的 Checkpoint S | 11 |

**实际改动与计划的偏差**：

- `reason` **没有做成三值枚举**（计划里写的是 `"timeout" \| "handover" \| "immediate"`），改成宿主给的**不透明字符串**。理由：「为什么挂起」是宿主的概念，core 不该认识「交权」这种词——与 `abortMessage` 透传中止理由的既有姿态一致。枚举留在 agent 那一层（S3）。
- 顺带把 `settleExecution` 尾部的派生数据产出抽成 `emitDerivedData`，执行完/失败/挂起三条路共用。
- `ToolCallResult` 从 interface 改成判别联合（`"suspended"` 那支没有 `output`）。⚠️ 这是类型层面的收紧，见 changeset 里的说明与「[待确认](#待确认的一件事)」。

---

### S2 · core：恢复入口 `settleAndRun`

**目标**：能从「结清一次悬空调用」开始起一轮，而不是从「追加一条用户消息」开始。

**涉及**：`packages/core/src/session.ts`（抽公共生成器体 + 两个入口的守卫）、`loop.ts`（`runTurn` 的恢复开场 + 轮统计）、`suspend.ts`（`Settlement` / `RunkoResumeError` / 悬空判定）。

**动工前补的设计**（2026-09-19，写进[技术方案 §5](../tech/suspend-resume.md)）——原计划只有一句「`settleAndRun` 起一轮」，写代码前发现三件没想清楚的事：

| 问题 | 结论 | 技术方案 |
|---|---|---|
| 悬空调用后面能不能再接普通轮？ | **不能**，实测 provider 400。于是有了一条不变量：悬空调用只能在最后一条消息里 | §5.3 |
| 结清结果怎么落进纯追加的账本？ | **消息级同 id 覆盖**：core 原地改写、调用方以新 seq 追加、读时按 id 折叠 | §5.4 |
| 悬空部件有几种状态？ | **三种**，多出来一种 `approval-responded`（审批通过后执行时又挂起），S1 时没想到 | §5.2 |

**产出物**：

1. 把 `stream()` 的生成器体抽成公共体，`stream` 与 `settleAndRun` 共用（装配、深层校验、steer 队列、活动信号、收尾元数据全部复用），差别只在开场。
2. `settleAndRun(callId, settlement, opts?)`，`settlement` 三种：`approval/allow`、`approval/deny`、`output`（原计划叫 `answer`，改名理由见技术方案 §5.1）。
3. `approval/allow` 时**用账本里原封不动的 input 执行**——不再走审批链，但重新过 `inputSchema`。
4. 两个入口的守卫与 `RunkoResumeError`（四个 code）：`stream()` 遇到悬空调用拒绝开轮；`settleAndRun` 找不到 / 已结清 / 种类不对拒绝开轮。**拒绝即抛、不算一轮**（不 `turn += 1`、不出 chunk）。
5. 结清后同一条消息里还有悬空调用 → 不调模型，直接 `suspended` 收尾。
6. `toolDurationMs` 只数本轮开始之后才开始执行的区间（技术方案 §5.6）。

**依赖**：S1（`suspended` 要能产出，才有东西可恢复）。

**不在 S2**：账本读取时按 id 折叠、agent 收尾时从被改写的那条开始切片——这两件是 `@runko/agent` 的事，挪到 S4。

**验收**：✅ **全部通过**（2026-09-19）。新增 `packages/core/test/resume.test.ts` 共 21 条，**每条都是两个 session**——第一个跑到挂起、`toJSON()`，第二个拿这份状态 `resume` 再恢复，跟生产上「挂起的进程早退了，恢复在另一台机器上」同形。core 500 条全绿；全仓 packages + 五个 app/examples 的 typecheck、test、lint 全绿。

- ✅ 挂起一轮 → `settleAndRun(callId, allow)` → 工具收到的入参与挂起时一字不差，模型看到 `user → assistant:tool-call(call_1) → tool:tool-result(call_1)`。
- ✅ `callId` 找不到 → `call_not_found`，一个 chunk 都不出、`turn` 不变。
- ✅ **对抗**：恢复轮的模型一上场就想发 `rm -rf /`——执行顺序断言证明 `execute` 先于模型，且只执行过一次、参数是 `rm -rf build`。
- ✅ `stream()` 遇到悬空调用 → `pending_calls`，模型 0 次调用，轮号与账本长度都不动。
- ✅ 三种部件状态 × 结清方式各有用例；`settlement_mismatch` 两个方向各一条；重复恢复 → `not_pending`，工具只执行过一次。
- ✅ 两个调用同时挂起：恢复第一个 → 模型 0 次调用、`callIds` 只剩 `call_2`、理由沿用上一轮的；恢复第二个 → 模型看到两对配好的 `tool-call` / `tool-result`。
- ✅ 轮统计：人「去开会」120ms 后恢复，`durationMs < 120`；恢复时执行的 30ms 计入 `toolDurationMs`；`ctx.suspend()` 挂起的调用 `toolDurationMs` 为 0。
- ✅ 另补：不再走审批链（分类器与人审通道 0 次调用）；新版 `inputSchema` 不收旧参数 → `output-error` 不执行；工具已不在工具表 → `output-error` 照常往下；执行时又挂起 → `suspended` 不调模型；`output` 不重新执行工具；`outputSchema` 不收给的值 → `output-error`；落账本契约（被改写那条 id 不变、在原位置、挂起那轮的 metadata 留在它身上）。

**变异测试**——七个变异，全部被抓住：

| 变异 | 挂掉的用例数 |
|---|---|
| 结清后不查剩余悬空、照样调模型 | 2 |
| `stream()` 不守悬空调用 | 1 |
| `allow` 不重新过 `inputSchema` | 1 |
| 轮统计去掉「只数本轮开始之后」的过滤 | 1 |
| 恢复轮的切片起点不往前多算一条 | 1 |
| 不校验 `Settlement` 种类 | 2 |
| 拿掉恢复开场（直接调模型） | 15 |

**实际改动与计划的偏差**：

- **动工前补了三处设计**（见本节开头那张表），其中「悬空调用后面不能再接普通轮」**推翻了技术方案 §9.3 原来的写法**，连带改了 S3 的第⑤步与验收。
- `Settlement` 的第三种从 `answer` 改名 `output`。
- 新导出了 `pendingCallIds`：S3 冻结队列要用它判断「这个会话现在能不能开普通轮」。
- 把人审「拒绝 / 批准」两段写入从 `settleToolCall` 里抽成 `settleHumanDenial` / `settleHumanApproval`，当场裁决与恢复轮共用。
- 顺带修了 S1 留下的一处 lint：node-server 测试 stub 用了双引号，那边的 prettier 要单引号，而它的 lint 是 `--max-warnings 0`。S1 跑 lint 时这个 stub 还没补上，所以漏了。

---

### S3 · agent：一轮以 `suspended` 收尾

**目标**：内存窗口到点，这一轮落盘退出、释放归属，裁决表那条**不结清**。

**涉及**：`packages/agent/src/runtime/` 的 `human.ts`（到点改成挂起、整轮挂起入口）、`registry.ts`（挂起闸门、`ask-user` 的第三种结局）、`ask-user.ts`（到点调 `ctx.suspend()`）、`queue.ts`（起轮守卫、第⑤步跳过）、`reasons.ts`（挂起理由）、`runtime.ts`（交权路径）。

**产出物**：

1. 两个 `setTimeout` 到点后不再 resolve 成 deny / timeout，改为 `suspendTurn(turn, "timeout")`——**整轮**挂起，不写裁决表。
2. 挂起闸门 `turn.suspending`：一旦设上，同一轮里再来的等人请求立刻挂起（裁决表照记）。
3. `ask-user` 到点调 `ctx.suspend("timeout")`，不再返回那句英文提示文案。
4. 起轮守卫：`startTurn` 抢到归属、登记之后查账本最后一条，有悬空调用就撤回，报 `awaiting_human`；`enqueue` 据此只入队（队列关着时报 `busy`、文案说清在等人）。
5. 挂起的那一轮收尾第⑤步跳过，排队的消息留着。
6. 交权时正在等人的轮挂起（`"handover"`），其余照旧中止；`ShutdownResult` 多一个 `suspended` 计数。

**依赖**：S1。

**验收**：✅ **全部通过**（2026-09-19）。新增 `packages/agent/test/suspend.test.ts` 共 9 条，**用真的 core session + mock 模型 + 内存持久化**从 `enqueue` 跑到收尾（假 session 会把 core 那一层整个跳过）。agent 131 条全绿；全仓 packages、五个 app/examples 的 typecheck，node-server 399 条、persist-demo 24 条，lint 全绿。

- ✅ 审批窗口到点：收尾 `suspended`、`suspended.callIds` 与 `reason: "timeout"` 都对；账本最后一条里那个部件是 `approval-requested`、入参原样；裁决表那一行**仍在 `listPending` 里**；`getActivity` 报不在跑；模型只被调用一次。
- ✅ `ask-user` 窗口到点：部件停在 `input-available`；那句英文提示文案不再出现在账本里；裁决表不结清。
- ✅ 窗口内答了：照旧跑完，`completed`，裁决表结清。
- ✅ 串行两个审批：第二个的「等人通知」里窗口是 **0**（立刻挂起），两个 callId 都在 `suspended.callIds` 里、两行都在裁决表里等人。
- ✅ 挂起那一轮收尾时队列里有消息：不交棒，消息留在队列里，模型只调用过一次。
- ✅ 挂起期间新来消息：只入队；**账本一个字没动**（用户消息没被追加在悬空调用后面）。
- ✅ 队列关着：拒绝，文案说清是在等人。
- ✅ 交权时正在等人：`{ aborted: 0, suspended: 1 }`，`reason: "handover"`，裁决表不结清。
- ✅ 对照：用户点停止仍然结成拒绝并写表（`interrupted`，`listPending` 为空）。
- 改了两条旧用例的断言（「到点当拒绝」「到点返回提示文案」→ 到点挂起），一条的返回形状（`ShutdownResult` 多了 `suspended`）。

**变异测试**——五个变异，全部被抓住：

| 变异 | 挂掉的用例数 |
|---|---|
| 挂起时也把裁决表结清（计划里点名要做的那个） | 3 |
| 去掉挂起闸门（后面的等人照样开新窗口） | 1 |
| 起轮时不查悬空调用 | 2 |
| 交权一律中止 | 1 |
| 窗口到点回到旧行为（当拒绝） | 5 |

「挂起时第⑤步照常交棒」这个变异**抓不住**，这是预期的：起轮守卫是第二道防线，结果照样对，差别只是订阅者会看到队列闪一下。

**实际改动与计划的偏差**：

- **分叉点不在收尾第①步。** 计划写的是「收尾第①步分叉：内存要结、库不能结」。读代码发现走到第①步时两个 Map 早空了——真正的分叉在「等人项被谁、怎么解开」。技术方案 §4.2 已按实现重写。
- **多了挂起闸门**（产出物第 2 条）。计划里没有；没有它串行两个审批要等两个窗口。
- **起轮守卫的位置**（产出物第 4 条）有两个硬约束：必须在抢到归属之后、必须在登记之后。理由写在技术方案 §4.2。
- 挂起理由在 agent 这层定成类型 `SuspendReason`（`reasons.ts`），S3 时是 `"timeout" | "handover"`；`"immediate"` 随 S6 的 `memoryWindow: 0` 加上。
- `ASK_USER_TIMEOUT_MESSAGE` 保留，现在只用于「这一轮已被停止」。去留仍按 S6 的待确认项办。

---

### S4 · agent：人回来在任意节点恢复

**目标**：人回来答了，在任意副本上开一轮恢复把那次调用接上。

**涉及**：`@runko/agent` 的 `persistence.ts`（`DecisionStore.get`）、`runtime.ts`（`submitDecision` / `submitAnswer` / `recover`）、`runtime/queue.ts`（推一把、恢复起轮、收尾第⑤步）、`runtime/turn.ts`（恢复轮的装配 / 驱动 / 落盘、账本折叠）、`runtime/interrupted-marker.ts`（悬空守卫）、`runtime/orphaned-decisions.ts`（新）、`runtime/human.ts`（登记先于结清）、`prepare.ts` · `session-factory.ts` · `registry.ts`（类型）；`persist-kysely` · `persist-mongo` · `apps/node-server`（各补一个 `get`）；`@runko/conformance`（四条新用例）。

**动工前补的设计**（2026-09-19，写进[技术方案 §5.7–§5.9](../tech/suspend-resume.md)）——原计划只有一张「内存有 / 没有 → 结清 → 抢归属 → 恢复」的三岔图，读代码发现三件没覆盖的事：

| 问题 | 结论 |
|---|---|
| 人答的时候不一定抢得到归属（另一个调用的恢复轮正在跑、另一个副本还在内存里等） | **裁决表当收件箱**：答案先写进那一行，再「推一把」；每一轮收尾也推一把。交汇点在数据库里，跨副本不漏。为此 `DecisionStore` 加一个读方法 `get` |
| 恢复轮在 agent 里处处走不一样的路 | 不追加用户消息、调 `settleAndRun`、从被改写的那条开始落盘、停止 = 拒绝、装配失败时账本一个字不写 |
| 崩溃恢复会往悬空调用后面补「已停止」 | **会把会话永久弄坏**。三处补标记的地方都加守卫 |

**产出物**：

1. `DecisionStore.get(conversationId, toolCallId)`：四处实现 + 一致性套件四条用例（含「没结清的字段不出现」，顺带盖住队友报的 Mongo 那个形状问题——实测正常写入路径不会触发）。
2. `submitDecision` / `submitAnswer`：内存里有 → 照旧；没有 → 那一行还悬着且种类对得上就写进答案、推一把、返回 `true`；否则 `false`。
3. 推一把 `advance`：有轮在跑就不管；账本末尾悬空 → 找已答的开恢复轮（`startResume`，抢到归属之后再读、读完无事可做就撤回）；否则照旧出队。收尾第⑤步、答复之后、挂起期间 `enqueue` 的兜底三处调用。
4. 恢复轮：`ActiveTurn.resume`；装配上下文带 `resume: { callId }`、`input` 是空文本 + 答复人；停止在装配期间 → 改用拒绝结清；装配失败 / 抛错 → 账本不动；落盘从被改写的那条开始，内容没变就不重写。
5. 账本按 `message.id` 折叠（`foldById`，公开导出给宿主用）。
6. `DrivenSession.settleAndRun?` 可选；缺了它的 session 遇到恢复轮以明确的错误收尾。
7. 启动扫描遇到「崩掉的是一次恢复」：不补标记，推一把让它重来。

**依赖**：S2、S3、S5 前两项。

**验收**：✅ **全部通过**（2026-09-19）。新增 `packages/agent/test/resume.test.ts` 共 18 条（真 core session）；agent 153 条全绿；一致性套件在内存、SQLite、pglite、**真 MySQL**、**真 Mongo** 上全绿；全仓 packages、五个 app/examples 的 typecheck，node-server 399 条、persist-demo 24 条，lint 全绿。

- ✅ 允许：执行的就是挂起那一刻的参数，模型看到配好对的 `tool_use` / `tool_result`；裁决表记下答复人。
- ✅ 拒绝：不执行，理由回填。`ask-user`：答案就是那次调用的输出。
- ✅ 恢复轮的装配上下文：空文本、`userId` 是答复人、带 `resume`。
- ✅ **跨副本**：A 挂起后下线，B 收到答复、恢复、跑完；命令只执行一次。
- ✅ 挂起期间排队的消息：恢复轮收尾后才开始跑，模型看到的历史里那次调用已经配好对。
- ✅ 同一张卡片同时答两次：一次 `true` 一次 `false`，命令至多执行一次。未知 callId、种类不对：`false`。
- ✅ 两个悬空调用：先答第二个 → 恢复后再挂起、不调模型；再答第一个 → 模型看到两对配好的调用。
- ✅ 账本里同一个 id 出现两次，折叠成一条；下一个普通轮的模型历史里那次调用只出现一次。
- ✅ 恢复轮装配期间点停止：不执行，结成拒绝，会话回到正常。
- ✅ 恢复轮装配失败：账本一个字不动、不热循环；用户再发一条消息时重试成功，那条消息随后也跑了。
- ✅ **恢复轮执行了命令、但改写后的那条写不进账本：命令只执行一次，不自动重试。**
- ✅ S5 前两项：孤儿行按账本区分；悬空时不补「已停止」；登记先于结清；放手之前登记已落库。

**变异测试**——九个变异，全部被抓住：

| 变异 | 结果 |
|---|---|
| 账本不按 id 折叠 | 7 条挂 |
| 恢复轮落盘漏掉被改写的那条 | 8 条挂 |
| 写进裁决表后不推一把 | 11 条挂 |
| 悬空时照样补「已停止」 | 1 条挂 |
| 孤儿清理不看账本（全结掉） | 1 条挂 |
| 结清前不等登记 | 1 条挂（第一版测试没抓住，见下） |
| 放手前不等登记 | 1 条挂（同上） |
| 恢复轮里点停止不改成拒绝 | 1 条挂 |
| 恢复没做成也立刻重试 | **测试卡死**——内存持久化下恢复轮一轮接一轮全是微任务，连测试自己的超时都轮不到。这正是那个隐患的样子 |

**实际改动与计划的偏差**：

- **多出一个接口方法 `DecisionStore.get`**，波及四处实现与一致性套件。计划里没有；没有它，抢不到归属时答复只能丢回给调用方重试，或者只存在内存里。
- **「两个人同时点」返回 `false`，不是计划里写的「返回成功」**（技术方案 §9.2 已改）：`settle` 分不清「已答过」与「没有这行」，而内存快路径本来就返回 `false`。
- **变异测试逼出了一个真问题**：原来只写了「恢复轮崩了（`crashed`）就不自动重试」。第二个变异（落盘漏掉那一条）让测试**跑不完**——恢复轮执行了命令、状态是 `completed`，但账本没变，收尾推一把又开一轮，命令被一遍遍执行。判据改成「**它要结清的那个调用还悬着，就不自动重试**」，并补了专门的用例（写账本被拒）。
- **第一版测试有两条咬不住**（结清前 / 放手前不等登记）：它们靠 `vi.waitFor` 每 50ms 轮询，看到结果时那 40ms 的慢写入早就落地了。改成在钩子里同步检查后抓住。
- `DrivenSession.settleAndRun` 做成**可选**：chat 应用测试里有自己的假 session，自定义 session 工厂是公开扩展点。
- 补了 S3 changeset 里写了却漏导出的 `SuspendReason`；`foldById` 公开导出。
- 新词「推一把（advance）」登记进术语表（不能叫「推进」——那是执行引擎的性质名）。
- chat 应用只补了 `get` 让它能编译，**接入仍在 S8**。

---

### S5 · 存量缺口三处

> ✅ **已交付**（2026-09-19）。前两项随 S4 交付，第 3 项随后交付。与原计划的偏差：
>
> - 第 1 项：孤儿行**不是**「那一轮悬着的行一律结成 timeout」——挂起之后正经在等人的行也是悬着的，两类只能靠账本分（在末尾悬空调用里的不动），见技术方案 §11.1。
> - 第 3 项：范围比立项时写的大（见下面第 3 项）。「在等人」做成从账本推出的独立字段，**没有**给 `ChatTurnStatus` 加第四档——挂起时确实没有轮在跑，`idle` 本身没错。

**目标**：让「`decidedAt` 为空」这个判据**可信**。

前两项是 **S4 的前置**，不是可选项：挂起把这个判据变成了恢复入口，每一条漏出来的「永远待定行」都是一个假入口——人点下去，框架会起一轮去执行一个早就没有上下文的调用。今天它们全都无害，只因为[裁决表](../../../terms.md)是纯审计表、没人读。

**涉及**：`packages/agent/src/runtime.ts`（`recover()`）、`runtime/queue.ts`（`settleDisplacedTurn`）、`runtime/human.ts`、`runtime/interrupted-marker.ts`（注释）；第 3 项在 `apps/web/src/features/chat/` 下（`use-chat-messages.ts`、`materialize.ts`、`timeline.ts`、`components/message-entry.tsx`、`components/timeline-view.tsx`、`components/turn-marker.tsx`）与 `apps/web/src/pages/conversation.tsx`。

**产出物**：

1. **崩溃/被接管留下的待定行结清成 `timeout`**。补在那两个调用方，**不要塞进 `appendInterruptedMarker`**——它只认账本那一面，接裁决表会把职责搅浑。
   - ⚠️ 同批**纠正 `interrupted-marker.ts` 的注释**：它写着「结清待定项的唯一途径是 `settleAllPending`，而那要求 `ActiveTurn` 还在本进程内存里」——**不对**。光结清库里那一行只需要 id（`listPending` + `settle`）。这不是做不到，是没做。
2. **`record` 不 await 的竞态**（[技术方案 §11.2](../tech/suspend-resume.md)）：把 `record` 的 promise 存在等人项上，**结清之前先 await 它**。
   - 这不是崩溃才有的问题：连接池下 INSERT 与结清的 UPDATE 可能走不同连接、到达顺序不保证，UPDATE 先到就匹配 0 行，照样漏一条。
   - 自动化测试、脚本化客户端、`memoryWindow: 0` 那一档最容易撞上。
3. **前端认得出挂起，并且人能接着答**。立项时写的是「`statusFromTurnEnd` 把 `suspended` 落进 `idle`，顶层加一档」。动手时读完前端发现缺口更大（[技术方案 §11.3](../tech/suspend-resume.md)）：挂起的卡片会被画成「已失效」，人答不了。按 [Chat Webapp · 技术方案 §6.2](../../../ingress/tech/chat-webapp.md) 拆成五件，全在 `apps/web`：
   - ① `timeline.ts` 新增 `findWaitingCallIds`：从账本推出还在等人的调用；`useChatMessages` 交出 `waitingCallIds`。
   - ② `message-entry.tsx` / `timeline-view.tsx`：在等的卡片不算失效；`TurnSuspendedBar` 分「在等」「已接着跑」两档。
   - ③ `use-chat-messages.ts`：答了在等的卡片 → 重开直播流；答过的在等调用一直算「提交中」，直到部件变了。
   - ④ `materialize.ts`：恢复那一轮开头没有 `start` 的 `tool-*` chunk，按 `toolCallId` 找到原消息，拿副本当种子接着物化。
   - ⑤ `use-chat-messages.ts`：在等人时发消息走排队、发完重开一次 tail 取队列快照；挂起那一轮收尾时不因「队列非空」保持转圈。
   - 页面顶部（`pages/conversation.tsx`）出一行「有 N 处在等你答复」。
   - **不做**：会话列表里标出「在等你」——要服务端加字段，归 S8。

**依赖**：第 1、2 项无依赖但**必须早于 S4**；第 3 项依赖 S4（要有恢复轮才谈得上「答了接着跑」）。

**验收**：
- 单测：模拟崩溃（起轮标记残留）→ `recover()` 之后裁决表那条是 `timeout`，`submitDecision` 对它返回 404、**不起轮**。
- 单测：登记之后**立刻**结清（模拟脚本化客户端）→ 落库后那条行是已结清的，不是待定的。
- **变异测试**：把「结清前先 await 登记」去掉，上面第二条必须挂。
- 前端单测：挂起那一轮的卡片可点；答过之后重开直播流、按钮保持禁用直到部件变化；恢复那一轮没有 `start` 的 chunk 能改写原消息；挂起时发消息不出乐观回显。每一条都要有变异验证。


**第 3 项的验证**（全在 `apps/web`，服务端没动）：

- 新增 `src/features/chat/__tests__/suspend-resume.test.tsx`，22 条：`findWaitingCallIds` 8 条、卡片与挂起提示 5 条、`MessageLedger` 恢复 chunk 4 条、`useChatMessages` 5 条。
- web 全量：`typecheck`、`lint`、`test`（19 个文件、300 条）全绿；新文件连跑 6 次全绿，无抖动。
- 变异测试：故意改坏 14 处，**14 处全部被抓住**。

| # | 改坏了什么 | 被哪条抓住 |
|---|---|---|
| M1 | 判据去掉「部件还在等人」 | 「恢复改写之后……不算在等」等 4 条 |
| M2 | 判据去掉「列在 `callIds` 里」 | 「没列在 callIds 里的部件不算」 |
| M3 | 不只看最后一条收尾消息 | 「只看最后一条收尾消息」 |
| M4 | 卡片失效不看 `waitingCallIds` | 审批卡片、提问卡片两条 |
| M5 | 挂起提示恒显示「在等」 | 「都答完了：只留一行」 |
| M6 | 不开种子流 | 3 条账本用例 + 答卡片的 hook 用例 |
| M7 | 种子不用副本 | 「种子用的是副本」；还顺带污染了下一条用例共用的历史数据——正好说明就地修改的危害 |
| M8 | 收尾 metadata 喂进种子流 | 「又以挂起收尾：onTurnEnd 恰好一次」 |
| M9 | 开种子流时不改 `lastAssistantId` | 同上（metadata 被并到一条凭空造出的占位消息上） |
| M10 | 答完不重开直播流 | 「答了在等的卡片」 |
| M11 | 答过的调用不算「提交中」 | 同上 |
| M12 | 等人时发消息不走排队 | 「在等人时发消息」 |
| M13 | 等人时发完不重开 tail | 同上（队列快照收不到） |
| M14 | 挂起收尾仍因队列非空保持转圈 | 「挂起那一轮收尾时队列非空」 |

**没做、交给 S8**：会话列表里标出「在等你」（要服务端加字段）；`.env.template` 里那两个超时变量服务端没读。

**同批顺手改的文档**：chat 应用的功能手册与技术方案里「等满 4 分钟自动拒绝」「ask-user 超时返回提示文案」两处说法，S3 之后已经不对，改成挂起；[术语表](../../../terms.md)里挂起、恢复的「⬜ 尚未实现」改成「🟡 框架已实现」，内存窗口补一句「配置项还没做，现在读的是旧参数」。

---

### S6 · 配置面与兼容

**目标**：`suspend.*` 落地，旧的两个超时参数平滑退役。

**涉及**：`packages/agent/src/runtime.ts`（`AgentRuntimeOptions`、`reportPresence`）、`runtime/human.ts`（窗口计时、续期）、`runtime/reasons.ts`（`"immediate"`）、新增 `runtime/duration.ts`。

**产出物**：

| 配置 | 默认 | 说明 |
|---|---|---|
| `suspend.memoryWindow` | `"5m"` | 内存里先等多久。**写毫秒数或带单位的字符串**（`"300ms"` / `"30s"` / `"5m"` / `"1h"`）。`0` = 立刻挂起、不起定时器，挂起理由记 `"immediate"` |
| `suspend.onPresence` | `"extend"` | `"extend"` \| `"ignore"` |
| `runtime.reportPresence(conversationId)` | — | 同步、不落库、只对正在等人的轮有效：把每个等人项的定时器重置成「从现在起一个完整窗口」 |

**开工时定的三件事**（2026-09-19）：

1. **类型**：`Duration = number | \`${number}ms\` | \`${number}s\` | \`${number}m\` | \`${number}h\``。数字就是毫秒；字符串用模板字面量类型，写错单位编译期就报。负数、`NaN`、`"1e3s"` 这类编译器拦不住的，**构造 runtime 时直接抛**——配置错了应该起不来，而不是悄悄按默认跑。
2. **旧参数按通道映射，不合并**：`human.approvalTimeoutMs` 只管审批、`human.askUserTimeoutMs` 只管提问，没配的那一路用 `memoryWindow`。这样配旧参数的宿主**行为完全等价**。新旧都配时新的赢，旧的记一行 warn 说被忽略了；只配旧的也记一行 warn 说它已废弃。
3. **`ASK_USER_TIMEOUT_MESSAGE` 保留，不标废弃**：它还有用——这一轮被停止时，还挂着的提问要交回模型一句话。它是公开导出，删掉就是破坏性变更，而它并不多余。

⚠️ **默认值从 240 秒变成 5 分钟**：没配任何参数的宿主，等人的时间会变长一分钟。理由见[技术方案 §8.2](../tech/suspend-resume.md)（与审批保活预算对齐）。changeset 里写明。

**依赖**：S3。

**验收**：`memoryWindow: 0` 时不起定时器、第一次等人立刻挂起；配旧参数时行为等价 + 有 warn；`reportPresence` 能把窗口往后推、`"ignore"` 时不推；非法时长构造即抛。


**✅ 已交付**（2026-09-19），按上面三条定案实现，没有别的偏差。

- 新增 `packages/agent/test/suspend-config.test.ts`，14 条：缺省窗口、带单位的字符串、`0` 立刻挂起且不起定时器（审批与 `ask-user` 各一条）、三种非法写法构造即抛、旧参数的三种组合、在场续期（审批、提问、`ignore`、没轮在等人）。
- 原有用例里的旧参数改成新参数；旧参数的行为由上面那三条专门覆盖。agent 全量 167 条通过，`lint` 干净。
- 变异测试 9 个，**全部被抓住**：窗口 0 不立刻挂、在场不续审批、在场不续提问、`ignore` 也续期、旧参数被无视、新旧都配时旧的赢、负数不拒、单位换算错、默认值还是 240 秒。
- changeset：`.changeset/suspend-agent-config.md`（minor，写明默认值从 240 秒变成 5 分钟）。

---

### S7 · 验收：一致性套件 + 两进程 e2e

**目标**：四档库都能跨副本恢复。

**涉及**：`packages/conformance/src/`（新增用例组）、`apps/persist-demo`（脚本模型、审批与内存窗口的开关、两进程 e2e）。

**产出物**：

1. 一致性套件加一组挂起恢复用例，四个持久化实现各跑一遍。
2. persist-demo 两进程 e2e：副本 A 起轮 → 等人 → 挂起 → **A 退出** → 副本 B 收到裁决 → 恢复并跑完。这是整个功能的核心验收场景。
3. 转发规则那一条要跟着改（[技术方案 §9.1](../tech/suspend-resume.md)）：没有持有者时本副本直接处理，不转发。

**依赖**：S4。

**✅ 已交付**（2026-09-19）。

**实际做的**：

- **一致性套件** `packages/conformance/src/suspend-resume.ts`，5 条，**并进 `persistenceCases`**（没有单列一组——用的是同一种 setup，单列就要每个消费方记得去接，漏接是静默的）：悬空调用原样往返；同 id 新 seq 两行都在（不能按 id 去重或覆盖）；只读末尾一条读到改写后的那行；两个副本同时结清恰好一个成功；提问答案原文读回。
- **persist-demo** 加了三样开关：`DEMO_SCRIPT=bash|ask-user`（第一步调工具、看到结果再收尾的脚本模型——按「提示词最后一条是不是工具结果」决定，而不是按调用次数，因为恢复轮会新拿一个模型实例）、`DEMO_APPROVAL=review`、`RUNKO_MEMORY_WINDOW`。
- **两进程 e2e** `apps/persist-demo/test/suspend-resume.e2e.test.ts`，每档库 4 条：审批（A 挂起后 `kill -9`，答复发给 B，B 执行的正是账本里那条命令、同 id 原位改写、再答一次 404）、`ask-user`、挂起期间排队的消息等恢复收尾后才跑、窗口内答复打到非持有者照旧转发且全程不挂起。
- **转发规则**：代码判据「`active && !local` 才转」本来就覆盖了「没有持有者就自己答」，只改了 `server.ts` / `forward.ts` 的注释、README 与多副本文档里「必须转」的说法。

**验证**：

| 项 | 结果 |
|---|---|
| 一致性套件 | 内存 72 条、Kysely 253 条（SQLite · pglite · **真 Postgres** · **真 MySQL**）、Mongo 78 条（**真 Mongo**），全绿 |
| 两进程 e2e | 四档库 × 4 条 = 16 条全绿；persist-demo 全量 69 条连跑 3 次全绿 |
| agent | 173 条全绿 |

**e2e 逼出了一个真竞态并修掉**（[技术方案 §5.7](../tech/suspend-resume.md)）：两条撤回路径是「先查裁决表、再放归属」，答案恰好在查完之后写进来、推一把又因为我们占着而抢不到，谁也没接上。修法是放手之后再查一次。补了一条确定性用例：让 B 占着归属读完「没答」后停住，A 此刻答复——**去掉修复这条用例就失败**。

**另一处测试写法的修正**：A 挂起放手后会立刻再推一把、短暂重新占住归属；`kill -9` 恰好落在这一小段里时，租约挂在死进程名下直到接管阈值，B 转发连不上回 503。这是「持有者崩溃」的既有语义，不是新缺陷——e2e 改成像真客户端那样按 `Retry-After` 重试。

**与计划的偏差**：

- **`test:lab`（docker-compose 三副本）没有加挂起场景**。验证环境的副本跑的是回声模型、编排文件是共用的，加进去要改所有场景的副本配置；而且它要起常驻容器，按仓库规矩得由人来起。挂起恢复的跨进程、跨四档库验收已由上面的两进程 e2e 覆盖。
- 起普通轮那条撤回路径的「放手后再查」是防御性的：经由 `enqueue` 进来时，它后面本来就会再推一把，所以在运行时层面单独去掉它观察不到差别；它护的是「出队时撞上刚挂起的会话」那一条窄路。

---

### S8 · chat 应用接入

立项时按 **P1** 移出本批、单列一批。**2026-09-19 用户要求「把所有能做的都做掉」，于是并入本批完成**。前端那一半其实在 S5 第 3 项里已经做了（挂起之后卡片还能答），这里是服务端那一半。

**目标**：真实宿主上跑通。

**涉及**：`apps/node-server`（`agent/runtime.ts`、`agent/persistence.ts`、`routes/chat.ts`、`schemas/chat.ts`、`db/schema.ts` 注释）、`apps/web`（`schema.ts`、`components/conversation-list.tsx`、生成的 client）、`.env.template`。

**✅ 已交付**（2026-09-19），设计见 [Chat Webapp · 技术方案 §6.3](../../../ingress/tech/chat-webapp.md)：

1. **内存窗口可配**：`CHAT_SUSPEND_MEMORY_WINDOW`（毫秒），不配用框架缺省 5 分钟。原来的两个超时变量早就没人读，从模板删掉。
2. **在场心跳刻意不接 `reportPresence`**：沙盒只为等人续命 5 分钟（审批保活预算），窗口被在场推过去以后，「允许」会跑在睡着的沙盒上；挂起再恢复则会先唤醒沙盒。立项时的交接清单里写着「接入时要一并检查这两处」，检查的结论就是这一条。
3. **会话列表标「等你」**：DTO 加 `pendingDecisions`（裁决表未结清行数，一次分组查询）。
4. 顺带：OpenAPI 与生成的前端 client 重新生成（此前改文档路径时漏了）；presence 路由的 summary 改用仓库根路径，免得生成器把相对链接抄进另一层目录就断。

**验证**：node-server 全量 403 条（新增 4 条：列表与详情的计数、答完归零、窗口变量三种写法）、web 全量 301 条（新增列表「等你」一条）、两边 lint 与 typecheck 全绿。

**没做的**：真浏览器实测。按仓库规矩不能自己起 `chat:server` / `chat:web`，验证步骤写在[验证方案](#验证方案)里，等人来跑。

---

## 待确认：版本号

几处改动对**实现者或底层调用方**是不兼容的（changeset 正文里都用 ⚠️ 标出了）：

| 改动 | 谁会受影响 |
|---|---|
| core `ToolCallResult` 改成判别联合 | 直接调 `executeToolCall`、不收窄就读 `output` 的代码 |
| core `ToolContext` 多了必需成员 `suspend` | 自己构造 `ToolContext` 的代码（典型是测试替身） |
| core `Session` 多了必需方法 `settleAndRun` | 自己实现 `Session` 接口的代码 |
| agent `DecisionStore` 多了必需方法 `get` | 自己实现持久化的宿主 |
| agent 窗口到点从「拒绝并接着跑」变成「挂起、等人答了才继续」，缺省窗口 240 秒 → 5 分钟 | 依赖「超时后自动往下走」的宿主 |

按仓库规范，不兼容是 major。但这几个包都在 **0.1.x**：changeset 标 major 会直接发成 **1.0.0**，那是「宣布稳定」的产品决定，不该顺手做掉。0.x 下惯例是 minor（0.2.0）承载不兼容改动。所以现在**都按 minor 写**，等用户拍板。

## changeset

| 文件 | 包 | 级别 | 内容 |
|---|---|---|---|
| `suspend-core-exit.md` | core | minor | 审批结局加第三种、工具挂起出口、收尾态四值（含 ⚠️ `ToolCallResult`） |
| `suspend-core-resume.md` | core | minor | `settleAndRun` 恢复入口 |
| `suspend-agent-timeout.md` | agent | minor | 窗口到点挂起、交权时挂起 |
| `suspend-agent-resume.md` | agent · persist-kysely · persist-mongo · conformance | minor | 恢复：裁决表当收件箱、推一把、恢复轮（含 ⚠️ `DecisionStore.get`） |
| `suspend-agent-config.md` | agent | minor | `suspend.memoryWindow` / `onPresence` / `reportPresence`、旧参数废弃；⚠️ 默认窗口 240 秒 → 5 分钟 |
| `suspend-conformance.md` | conformance | minor | 一致性套件 +5 条挂起恢复要求 |

`apps/*` 不发布，不写 changeset。

## Code review（xhigh，2026-09-19）

S0–S8 做完之后跑了一次 xhigh 级别的代码审查，报了 15 条。逐条对照代码核实，**全部成立**（第 9 条一半是设计取舍），都已处理：

| # | 问题 | 处理 |
|---|---|---|
| 1 | 内存窗口里接下的插话，挂起时随这一轮内存丢掉（用户被告知「插进去了」） | 挂起收尾时把没注入的插话转进待发队列 |
| 2 | 串行批里前一个挂起后，后面的照样执行——恢复后被批准的那个反而最后才跑 | 串行批挂起之后后面的一个都不执行，各得「没有执行」的结果（技术方案 §3.3） |
| 3 | 一步半路失败时，模型已发出、没轮到执行的调用留成悬空 → 会话被当成挂起、永远没人能答 | 失败收尾时把它们结成「没有执行」 |
| 4 | 裁决表登记失败照样挂起 → 没有那一行，永远没人能答 | 登记失败不挂起，退回拒绝 / 「没人回应」 |
| 5 | 收拾孤儿行抛错会连带跳过补「已停止」标记 | 收拾孤儿行改成失败只记日志 |
| 6 | 答挂起的提问不带答复人 → 恢复轮没有 `userId`，推送找不到人 | `submitAnswer` 加可选 `{ decidedBy }`，chat 服务端传进来 |
| 7 | 挂起路径不核对调用是否真的悬在账本末尾：孤儿行假成功；停止与允许打架时审计表记反。答过但没恢复成的再点无反应 | 必须悬在账本末尾才收；答过的再点返回 404 但推一把；前端 404 后重开直播流（技术方案 §5.7、§9.1） |
| 8 | core `send()` 看不出挂起；带 `outputSchema` 时拿悬空历史调模型 | `TurnResult.suspended`；带 `outputSchema` 时抛 `pending_calls` |
| 9 | 恢复轮在调模型之前收尾时，收尾 metadata 并到上一轮那条消息上：统计被覆盖，还可能出现「已停止 + suspended」 | 去掉旧的 `suspended`；统计被覆盖写进已知限制（没有别的消息可挂） |
| 10 | 被拒的 `approval-responded` 被算成悬空 → 会话卡死 | 只有批准了才算悬空（core 与前端两处） |
| 11 | 撤回时顶掉了过期持有者，却把接管信息扔了 → 孤儿行永远悬着 | 撤回前先替被顶掉的持有者收尾 |
| 12 | chat 推送在队列非空时吞掉「这一轮先挂起了」 | 挂起不受队列抑制 |
| 13 | 窗口超过 `setTimeout` 上限（约 24.8 天）时 Node 改成 1 毫秒 → 立刻挂起 | 超过上限构造即报错；chat 服务端的环境变量超限当没配 |
| 14 | changeset：不兼容改动标成 minor；两份互相矛盾（「缺省仍是 240 秒」「不要单独上线」） | 矛盾处重写；不兼容点全部用 ⚠️ 列出；版本级别见上面「待确认」 |
| 15 | 注释里写了历史（「名字是历史沿用」）与阶段号（「施工进展 S6」）；两个注释块超过 25 行 | 删掉历史与阶段号；超长的块拆开 |

**验证**：每条行为修补都补了用例，并做了变异测试——**12 个变异全部被抓住**（core 5 个、agent 7 个），前端两处再加 2 个，也都抓住。全仓 `build / typecheck / lint / test` 全绿；四档真库的一致性套件与两进程 e2e 重跑全绿。

**一次没复现的抖动**：修补之后，persist-demo 全量在四档库上连跑约 20 次，「挂起期间发来的消息」那条失败过一次（1.4 秒就失败，不是超时）。那次没抓到断言详情，此后连跑 16 次都没再出现。另一次抖动查清了：成品消息落盘在放手之前，测试读到「做完了」就立刻断言「已放手」——改成等它放手。

## 验证方案

### 一、自动化（跑完即退，2026-09-19 实跑结果）

| 层 | 命令 | 覆盖什么 | 结果 |
|---|---|---|---|
| core | `pnpm --filter @runko/core test` | 挂起出口、恢复入口、同 id 改写、轮统计、串行批顺序、失败步收尾 | **505 条全绿** |
| agent | `pnpm --filter @runko/agent test` | 窗口到点挂起、恢复轮、推一把、撤回后复查、配置面、崩溃与接管的兜底、code review 修补 | **182 条全绿** |
| 一致性套件 · 内存 | 同上（`builtin.test.ts`） | 持久化 40 条 | 72 条全绿 |
| 一致性套件 · Kysely | `RUNKO_TEST_POSTGRES_URL=… RUNKO_TEST_MYSQL_URL=… pnpm --filter @runko/persist-kysely test` | SQLite · pglite · 真 Postgres · 真 MySQL | **253 条全绿** |
| 一致性套件 · Mongo | `RUNKO_TEST_MONGO_URL=… pnpm --filter @runko/persist-mongo test` | 真 Mongo | **78 条全绿** |
| **两进程 e2e** | `RUNKO_TEST_POSTGRES_URL=… RUNKO_TEST_MYSQL_URL=… RUNKO_TEST_MONGO_URL=… pnpm --filter @runko-demo/persist-demo test` | A 挂起后 `kill -9`、B 恢复（审批 / 提问）、挂起期间排队、窗口内转发——**四档库各 4 条** | **全量 69 条，连跑 3 次全绿** |
| chat 服务端 | `pnpm --filter @runko-chat/node-server test` | 列表「等你」计数、窗口变量、挂起推送不受队列抑制 | **404 条全绿** |
| chat 前端 | `pnpm --filter @runko-chat/web test` | 挂起卡片可答、答完重开直播流、恢复 chunk 物化、挂起时发消息排队、列表「等你」、404 后重开 | **303 条全绿** |
| 文档 | `pnpm docs:check && pnpm docs:build && pnpm check:doc-links` | front matter、全站死链、源码注释里的文档链接 | 全绿 |
| 全仓（同 CI） | `pnpm -r build && pnpm -r typecheck && pnpm -r test && pnpm lint` | 全部 21 个成员 | 全绿 |

变异测试（故意改坏、看有没有用例报错）：S1 3/3、S2 7/7、S3 5/5、S4 9/9、S5 前端 14/14、S6 9/9、S7 撤回复查 1/1、code review 修补 14/14，**全部被抓住**。

测试用的数据库是本机 docker 里的三个容器（Postgres `:5433`、MySQL `:3307`、Mongo `:27018`）。

### 二、chat 应用真浏览器实测（待人来跑）

按仓库规矩，常驻的开发服务器要由人来起。步骤：

1. 在仓库根 `.env` 里加一行 `CHAT_SUSPEND_MEMORY_WINDOW=20000`（等 20 秒就挂起，免得真等 5 分钟），起 `pnpm chat:server` 与 `pnpm chat:web`。
2. 新建会话，发一句会触发危险命令的话（比如「把当前分支 git push 到远端」）。**预期**：弹出审批卡片。
3. **不点**，等 20 秒。**预期**：
   - 卡片**仍然可以点**，不是「已失效」；
   - 这一轮末尾出现「等待你的答复，这一轮已挂起」；
   - 时间线上方出现「有 1 处在等你答复」；
   - 左侧会话列表里这个会话标着「等你」。
4. 刷新页面。**预期**：第 3 步的样子原样保留。
5. 在输入框再发一句「顺便看看 README」。**预期**：这句进了待发区，**不会**一直转「正在准备…」。
6. 重启 `chat:server`（模拟节点换人），再回到页面点「允许」。**预期**：出现「正在准备…」，几秒到几十秒后（要唤醒沙盒）命令执行，卡片变成已执行；尾注变成灰字「在这里挂起过，答复之后已接着跑」；随后第 5 步那句自动发出。
7. 同一张卡片在另一个标签页再点一次。**预期**：显示「已失效」（那一行已经答过）。

实际结果：**尚未执行**。

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-09-18 | 立项，三份文档落地，术语补四处（新增[裁决表](../../../terms.md) · [恢复](../../../terms.md) · [内存窗口](../../../terms.md)，[在场](../../../terms.md)补第二个用途）。关键判断：**挂起不能复用停止那条路**——loop 在 `await onReview` 醒来后不检查 abort 信号，会先把那次调用写成「已拒绝」再退出，账本脏掉（[技术方案 §2](../tech/suspend-resume.md)） |
| 2026-09-18 | S5 从两项加到三项：另一个会话的 code review 逮到 `void decisions.record(...)` 不 await 的竞态——**进程没崩也会漏出永远待定行**，而本批把「`decidedAt` 为空」定成了恢复判据。同批纠正 `interrupted-marker.ts` 注释里一处错误归因（结清库里那一行并不需要 `ActiveTurn`） |
| 2026-09-19 | **S4 交付**（连同 S5 前两项）：人回来在任意副本上恢复。裁决表当收件箱、`DecisionStore.get`、推一把、恢复轮、账本按 id 折叠、悬空时不补「已停止」。新增 18 条端到端用例 + 4 条一致性用例（真 MySQL、真 Mongo 全绿），九个变异全部被抓住；其中一个变异让测试跑不完，逼出了「恢复没做成就重复执行」的真问题并修掉 |
| 2026-09-19 | **S5 交付**（第 3 项）：读完前端才发现立项时对缺口的描述不对——问题不是「顶层状态少一档」，而是挂起的卡片被画成「已失效」、人答不了，挂起时发消息也会一直转圈（[技术方案 §11.3](../tech/suspend-resume.md)）。按 [Chat Webapp · 技术方案 §6.2](../../../ingress/tech/chat-webapp.md) 在 web 侧补了五件事，服务端与 wire 没动。新增 22 条用例，14 个变异全部被抓住。同批订正 chat 文档与术语表里 S3 之后已经过时的说法 |
| 2026-09-19 | **S6 交付**：`suspend.memoryWindow`（毫秒数或带单位的字符串，`0` = 立刻挂起、理由 `immediate`）、`suspend.onPresence`、`reportPresence`；旧参数按通道映射保证行为等价；默认窗口 240 秒 → 5 分钟。14 条用例，9 个变异全抓住 |
| 2026-09-19 | **S7 交付**：一致性套件 +5 条（并进 `persistenceCases`）、persist-demo 两进程 e2e 四档库 16 条全绿。e2e 逼出「撤回路径先查后放、答案会漏」的真竞态并修掉，补确定性回归用例 |
| 2026-09-19 | **S8 交付**（用户要求「把所有能做的都做掉」，并入本批）：`CHAT_SUSPEND_MEMORY_WINDOW`、会话列表「等你」（`pendingDecisions`）；在场心跳**刻意不**接 `reportPresence`（沙盒保活只续 5 分钟）。OpenAPI 与生成 client 同步 |
| 2026-09-19 | **xhigh code review**：15 条全部成立并处理（详见「Code review」一节）。最要紧的三条：串行批挂起后后面的调用照样执行（顺序被打乱）、窗口里的插话随挂起丢失、一步半路失败留下悬空调用把会话卡死。补 14 个变异验证过的用例 |
| 2026-09-19 | **S3 交付**：agent 侧挂起落地。窗口到点整轮挂起、不写裁决表；新增挂起闸门（同一轮后面的等人立刻挂起）；起轮守卫查在抢到归属与登记之后；交权时等人的轮挂起。新增 9 条端到端用例（真 session），五个变异全部被抓住。**发现 S3 与 S4 必须一起上线**——chat 应用吃这个包，中间重启会让等人超时的会话卡住 |
| 2026-09-19 | **S2 交付**：core 侧恢复入口 `settleAndRun` 落地，core 这一侧完工。动工前实测 `convertToModelMessages` 发现悬空调用后面不能再接任何消息（provider 400），**推翻技术方案 §9.3**「挂起后照常起下一轮」，改为队列冻结到恢复，S3 的第⑤步跟着改；同时定下「消息级同 id 覆盖」落账本、发现第三种悬空状态 `approval-responded`。新增 21 条单测（全部是跨 session 的），七个变异全部被抓住 |
| 2026-09-19 | **S1 交付**：core 侧挂起出口落地（审批第三种结局 + `ctx.suspend()` 双保险 + 四值收尾 + `metadata.suspended`）。新增 18 条单测，三个变异全部被抓住。两处偏差：`reason` 改成不透明字符串（不做枚举，枚举留给 agent 那层）、`ToolCallResult` 改判别联合。连带给 7 个包/app 的测试 stub 补上 `ctx.suspend` |
| 2026-09-18 | 三件开工前问题全部定案。**P3 推翻了本文最初的建议**：原建议哨兵返回值、理由是「仓库已为 `Grant.nextSeq` 否过用异常表达正常结局」；实际上那里的「失去归属」是每次调用都要分支的常规结果，而挂起是调用方**不该**处理的控制流终止——哨兵会被工具自己的包装层（`return formatForModel(raw)`）吃掉。改为抛 `SuspendSignal` + ctx 标记双保险 |
