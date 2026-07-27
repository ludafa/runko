# 沙盒保活 —— 施工进展

> 术语见 [docs/terms.md](../terms.md)。
> 产品文档 [docs/features/sandbox-keepalive.md](../features/sandbox-keepalive.md)，技术方案 [docs/tech/sandbox-keepalive.md](../tech/sandbox-keepalive.md)。

## 状态总览

| 阶段 | 内容 | 落点 | 状态 |
|---|---|---|---|
| KA-0 | 术语表 + 三份文档 | `docs/` | ✅ 完成（2026-07-26） |
| KA-1 | core：活动信号接缝 | `@nimbo/core` | ✅ 完成（2026-07-27） |
| KA-2 | 闸门 + E2B 实现 | `@nimbo/core`、`@nimbo/sandbox-e2b` | ✅ 完成（2026-07-27） |
| KA-3 | Vercel 实现（含修加时 bug） | `@nimbo/sandbox-vercel` | ✅ 完成（2026-07-27） |
| KA-4 | sdk：类型 re-export | `@nimbo/sdk` | ✅ 完成（零改动，见下） |
| KA-5 | chat 应用迁移 | `apps/node-server` | ✅ 完成（2026-07-27） |
| KA-6 | 端到端验证 | — | ⏳ 待用户执行（需真实凭据） |

**当前状态**：KA-1～KA-5 全部落地，全仓 `build` / `typecheck` / `test` 绿（packages 1101 项 + node-server 469 项）。KA-6 需要 E2B / Vercel 真实凭据，本仓 checkout 跑不了。

**依赖顺序**：KA-1 → KA-2 / KA-3（可并行）→ KA-4 → KA-5 → KA-6。

---

## KA-0 术语表 + 三份文档 ✅

**产出**：

- `docs/terms.md`：修订「[存活时长](../terms.md)」「[保活](../terms.md)」「[心跳](../terms.md)」三条；新增「[活动信号](../terms.md)」「[续期闸门](../terms.md)」「[审批保活预算](../terms.md)」「[单轮保活上限](../terms.md)」四条。
- `docs/features/sandbox-keepalive.md`、`docs/tech/sandbox-keepalive.md`、本文件。

- `docs/tech/turn-checkpoint.md` §5 顶部加了「本节已被取代」说明（写清推翻了什么、保留了什么）。

---

## KA-1 core：活动信号接缝 ✅

**目标**：core 能在一轮产出 chunk 时通知工作区，且自己不持有任何定时器。

**涉及文件**：

- `packages/core/src/types.ts`：新增 `ActivitySignal`、`NimboActivityAware`。
- `packages/core/src/session.ts`：`stream()` 的 chunk 循环里插入 `notifyActivity(chunk)`（改动点见技术方案 §5.2）；结构探测 `"onActivity" in workspace`。
- `packages/core/src/index.ts`：导出新类型。

**产出物**：

1. `onActivity` 可选、同步、返回 void，工作区没实现就完全跳过。
2. leading-edge 节流，默认 5 秒，**零定时器**（纯时间戳比较）。
3. `tool-approval-request` 绕过节流，发 `reason: 'awaiting-approval'`。
4. 上一次发的是 `awaiting-approval` 时，下一个 chunk 无条件发 `progress`。

**验收标准**：

- [x] 密集 chunk 场景下 5 秒内只发一次信号。
- [x] `tool-approval-request` 立刻发出，不被节流吃掉。
- [x] 审批结束后的第一个 chunk 立刻发 `progress`。
- [x] 不实现 `onActivity` 的工作区（MemoryFS + miniBash）跑完整会话，零额外调用、现有测试全绿。
- [x] `session.send()` 与 `session.stream()` 两条路径都有信号。
- [x] core 里没有新增任何 `setInterval` / `setTimeout`。

---

## KA-2 闸门 + E2B 实现 ✅

**目标**：`@nimbo/sandbox-e2b` 具备完整保活能力。

**涉及文件**：

- `packages/sandbox-e2b/src/types.ts`：`E2bSandboxLike` 加**可选**字段 `setTimeout?(timeoutMs: number): Promise<void>`。
- **`packages/core/src/keepalive.ts`（新增）**：闸门本体 `createKeepAlive` + `KeepAliveDriver`/`KeepAliveOptions`/`RenewInfo`。落点与原计划不同，见下「实际改动」。
- `packages/sandbox-e2b/src/keepalive.ts`（新增）：E2B 的 driver（`remainingMs` 恒 undefined、`renew` 走 `setTimeout`）。
- `packages/sandbox-e2b/src/workspace.ts`：`keepAlive` 选项；开了才挂 `onActivity`/`keepAlive` 两个方法。
- `packages/sandbox-e2b/src/exec.ts`：`exec()` 期间 `beginExec()`，`finally` 停。
- `packages/sandbox-e2b/README.md`：保活用法 + 已知限制（双写漂移、E2B 硬上限）。
- 测试：`packages/core/test/keepalive.test.ts`（26 项，闸门通用行为）、`packages/sandbox-e2b/test/keepalive.test.ts`（11 项，E2B 专属）。

**实际改动与计划的偏差**：

1. **闸门落在 `@nimbo/core` 而不是各适配器包。** E2B 与 Vercel 的闸门逻辑逐行相同，两份拷贝必然漂移，而补足语义要可预测就要求两家严格一致。`session.ts` 不 import 也不调用它，core 侧「零保活策略」的承诺不受影响；厂商差异经 `KeepAliveDriver` 注入。
2. **`FakeE2bSandbox` 没有加 `setTimeout`**——刻意保持原样，正好当成「不支持保活的沙盒」的活样本，用来验证最小结构面没被打破、以及传了 `keepAlive` 时会提前抛错。带 `setTimeout` 的假沙盒在 `test/keepalive.test.ts` 内部自建（沿用本仓「测试文件自给自足」的惯例）。

**⚠️ 不得**把 `setTimeout` 加进 `E2bSandboxLike` 的**必填**面——会打死 `examples/09` 的假沙盒和 `test/helpers.ts` 的 `FakeE2bSandbox`，违反 [BYO 实例](../terms.md)与最小结构面纪律。

**验收标准**：

- [x] 剩余 ≥ `targetMs * 0.75` 时不打网络（判定线取 3/4 而非 1/2，理由见下「踩到的坑」）。
- [x] 首次调用（`expectedExpiryAt` 未知）必定真的续。
- [x] 一条 20 分钟的慢命令期间按 T/2 续期，命令返回后 interval 被清。
- [x] 两条慢命令并发时各自清各自的 interval，真实网络调用被水位挡掉。
- [x] 审批状态机：`awaiting-approval` 起 interval，`progress` 停；`approvalBudgetMs: 0` 时一次都不续。
- [x] `maxTurnMs` 到点停止续期。
- [x] 续期失败只走 `onRenew({ok:false})`，**不抛错、不产生未处理拒绝**。
- [x] 不传 `keepAlive` 时零网络调用、行为与现状完全一致。
- [x] 不实现 `setTimeout` 的 fake 沙盒仍能正常跑完所有既有契约测试。

---

## KA-3 Vercel 实现（含修加时 bug）✅

**目标**：`@nimbo/sandbox-vercel` 同等能力，并修掉"每条消息盲加 5 分钟"。

**涉及文件**：

- `packages/sandbox-vercel/src/types.ts`：`VercelSandboxLike` 加可选 `expiresAt?: Date` 与 `extendTimeout?(duration): Promise<void>`；`VercelWorkspaceOptions` 加 `keepAlive`。
- `packages/sandbox-vercel/src/keepalive.ts`（新增）：driver + 导出 `extensionFor(target, remaining)` 差额计算（单独导出是为了能直接单测这个纯函数）。
- `packages/sandbox-vercel/src/index.ts` / `exec.ts`：同 KA-2 结构。
- `packages/sandbox-vercel/README.md`：写明加时 vs 重置的差异。
- 测试：`packages/sandbox-vercel/test/keepalive.test.ts`（14 项）。

**关键差异**：Vercel 是**加时**语义，必须先读剩余再 `extendTimeout(targetMs - 剩余)`。**不能**照抄 E2B 的直接赋值。

**⚠️ 与计划的偏差**：查剩余用的是 **`sandbox.expiresAt`**（`get expiresAt(): Date | undefined`），**不是计划里写的 `sandbox.timeout`**。核 `@vercel/sandbox@2.5.0` 的 d.ts 发现后者的官方注释是 "The **default** timeout of this sandbox"——建盒时配的时长，不是剩余量。原始出处 [turn-checkpoint](../tech/turn-checkpoint.md) §5 那一处不准，技术方案 §1 已加订正。

**验收标准**：

- [x] fake 沙盒的 `expiresAt` 给不同剩余值，`extendTimeout` 收到的差额正确。
- [x] 连续调用 10 次 `ensureLifetime(300s)`，剩余稳定在 300 秒**不累加**（这是 bug 的回归测试）。
- [x] 其余同 KA-2 验收项。

---

## KA-4 sdk：类型 re-export ✅

**实际改动：零。** `packages/sdk/src/index.ts` 已有 `export * from "@nimbo/core"`，新增的类型与 `createKeepAlive` 自动透出，不需要加任何具名 re-export（新符号与 virtual-fs / mini-bash 的导出无重名，不触发 ambiguous export）。已用一个临时 `import type { ... } from '@nimbo/sdk'` 探针编译验证后删除。

适配器包本身仍**不进** `@nimbo/sdk` 依赖（既有纪律不变）。

**验收标准**：

- [x] `import type { NimboActivityAware } from '@nimbo/sdk'` 可用。
- [x] `@nimbo/sdk` 的依赖列表没有新增适配器包。

---

## KA-5 chat 应用迁移 ✅

**目标**：删掉手写心跳，接上适配器的保活，行为不退化。

**涉及文件**：

- `apps/node-server/src/agent/sandbox-manager.ts`：删 `startHeartbeat` / `heartbeats` / `heartbeatIntervalMs`；`extendIdle` → `ensureLifetime`；`touch` → `ensureLifetime`；建盒时传 `keepAlive` 配置；`markAlive` 改由 `onRenew` 驱动。
- `apps/node-server/src/agent/turn-launcher.ts`：删三处心跳起停（起、`onTurnSettled` 停、busy 分支就地停）。
- `apps/node-server/src/routes/chat.ts`：`touch` 的四处调用改名。
- `apps/node-server/src/agent/turn-runner.ts`：`DEFAULT_APPROVAL_TIMEOUT_MS` 的注释去掉「赶在沙盒死前」的耦合说明（**数值不动**）。
- 对应测试文件同步。

**⚠️ 两个必须**：

1. 转发到 `workspace.keepAlive` 时**显式判空抛错**，不能用 `?.()` 静默 no-op（理由见技术方案 §6.2）。
2. `markAlive` 必须由 `onRenew` 驱动，否则缓存 TTL 与实际脱节，每轮白走一次 `resume()`（理由见技术方案 §6.1）。

**验收标准**：

- [x] `sandbox-manager.ts` 里 grep 不到 `setInterval`。
- [x] 长轮次（>5 分钟）结束后紧接一条新消息，`AcquireMode` 是 `cache` 而不是 `resume`（`onRenew` 同步 `expiresAt` 的回归测试）。
- [x] 既有的 `test/agent/sandbox-manager.test.ts` 全部改造后通过。
- [x] 审批 / 提问路由的续期路径行为不变。

---

## KA-6 端到端验证

**需要真实凭证，必须由用户执行**（本仓库 checkout 无 E2B / Vercel 凭证）。

| 用例 | 步骤 | 预期 |
|---|---|---|
| 长轮次不被抽走 | 起 chat 应用，发一条会跑 >10 分钟的任务（如大仓库 `npm install` + 全量测试） | 轮正常跑完，不出现"沙盒已停止"错误 |
| 单条长命令 | 让 agent 跑一条单独耗时 >8 分钟的命令 | 期间 `onRenew` 日志按 ~150 秒出现，`trigger: 'exec'` |
| 卡死自动放手 | 轮跑到一半杀掉模型侧连接 | 续期停止，沙盒在 5 分钟后休眠 |
| Vercel 不累加 | 连发 10 条短消息，每条之间查 `sandbox.expiresAt` | 剩余稳定在 ~300 秒，不递增 |
| 审批预算 | `approvalBudgetMs: 0`，触发一次审批后等 6 分钟再点 | 沙盒已休眠，宿主走 resume 恢复 |
| 内存工作区无影响 | `pnpm example 01` / `04` | 输出与改动前一致 |

**结论回填**：跑完把实际结果写回本节，与 [docs/plans/verification.md](./verification.md) 的既有格式对齐。

---

## 变更记录

### 2026-07-26 — 方案定稿，KA-0 完成

**背景**：从"e2b sandbox 怎么保活、nimbo sdk 和适配器包怎么配合"的问题出发，发现保活能力完全在 `apps/node-server` 里、SDK 侧零支持，讨论后决定下沉。

**推翻的既有决定**：

- **P13-2b 的"保活不进 nimbo SDK / 适配器"被推翻**（原文见 [turn-checkpoint](../tech/turn-checkpoint.md) §5）。理由见技术方案 §2.1：知识归属、补足语义只有适配器做得干净、"归宿主"指的是所有权而非执行。**保留** P13-2b 的补足语义与单轮上限设计。

**讨论中被否决的方案**：

| 方案 | 否决理由 |
|---|---|
| 纯 chunk 节流信号驱动 | exec 期间 core 零 chunk 产出（`loop.ts` 缓冲重放），长命令场景完全无信号——而长轮次主要正由单条慢命令造成 |
| 纯轮作用域信号 + 适配器跨调用 interval | 不 fail-safe：轮卡死时作用域仍开着会一直烧钱；工作区被多 session 共用时还需引用计数 |
| core 周期性发 tick | 只是把定时器从宿主搬进 core；且 core 不知道沙盒超时值，被迫决定一个它没有信息决定的参数 |
| 改造 core 让工具进度实时交错产出 chunk | 要动核心流水线（同步回调内无法 yield，需异步队列桥接），会改变 chunk 到达顺序、可能影响 web 端；适配器自持 interval 已解决同一问题 |
| 保活默认关、要求显式 opt-in | 两个烧钱场景已被分别治住（卡死靠 chunk fail-safe、人走开靠审批预算），剩下的只是"轮真在跑、沙盒真该活着" |
| `sdk` 出 `startKeepAlive()` 工具函数由宿主起停 | "宿主拉"模型，宿主仍需自己知道要在轮两头起停，边角必然有人漏 |

**发现的既有 bug**（并入 KA-3）：`sandbox-manager.ts:157` 把 Vercel 的 `extendTimeout`（加时）和 E2B 的 `setTimeout`（重置）当同义词，导致每条用户消息盲加 5 分钟。P13-2b 已记录此问题，本工单一并修掉。

**未决**（不阻塞施工）：

- `maxTurnMs` 默认 30 分钟是否合适——沿用 P13-2b 的取值，真机验证后再调。
- E2B 是否也应像 Vercel 那样提供"查剩余"的途径，以免本地记账在 resume 场景下不准（现状：重置语义使记账不准只导致多续一次，无害）。

---

### 2026-07-27 — KA-1～KA-5 施工完成

全仓 `build` / `typecheck` / `test` 绿：packages 侧 1101 项（core 457 含新增 39 项、sandbox-e2b 44 含新增 11、sandbox-vercel 84 含新增 14），node-server 侧 469 项。

**施工中踩到的三个坑**（都已固化成回归测试）：

1. **闸门判定线与打点周期不能同值。** 一开始阈值和周期都取「目标的一半」，结果定时器每次恰好在剩余 = 目标一半的那一刻触发，`>=` 判定成立 → 永远跳过 → 除首次外一次都不续期。阈值抬到 3/4 后两者拉开。回归测试：`packages/core/test/keepalive.test.ts` 的「判定线必须高于打点周期占比」。

2. **`sandbox.timeout` 不是剩余量。** 见 KA-3 的偏差说明。

3. **测试 helper 的默认参数陷阱。** `keepAliveFake(initialRemainingMs = IDLE)` 写了默认值，导致「这个沙盒报不出到期时刻」用例里显式传 `undefined` 反而拿到 `IDLE`，测出满水位、一次都不续，掩盖了真正要验的分支。改成必填参数。

**core 的实现记录**：

- 活动信号挂在 `session.ts` 已有的 chunk 循环上（`yield` **之前**调），零新增机制。
- 结构探测同时看 `fs` 与 `exec` 两个面并去重——[模式 A（同源工作区）](../terms.md)是同一个对象，不去重会通知两次。
- 审批边沿的两条「绕过节流」规则都落地：进入等人（`tool-approval-request`）、离开等人（其后任意 chunk）。后者依赖「审批 resolve 后必定有后续 chunk」这条契约，已核 `loop.ts` 允许/拒绝两条路径都会 yield `tool-approval-response`。

**未做**：KA-6 端到端验证（需真实凭据）。
