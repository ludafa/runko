---
title: "优雅关闭与崩溃恢复（施工进展）"
slug: graceful-shutdown
view: 施工
layer: 逻辑层
module: 轮编排
packages: ["@nimbo/agent"]
tags: ["优雅关闭", "崩溃恢复", "交权", "SIGTERM"]
related: ["logic/orchestration/features/graceful-shutdown.md", "logic/orchestration/tech/graceful-shutdown.md", "architecture/tech/agent-kernel.md"]
---
# 优雅关闭与崩溃恢复（施工进展）

> 相关：[功能](../features/graceful-shutdown.md)，[技术方案](../tech/graceful-shutdown.md)。
> 依赖/延续：[停止本轮](../features/turn-abort.md)（本功能整个建在 `abortTurn` 上）· [chat webapp §5.1](../../../ingress/tech/chat-webapp.md)（[轮状态快照](../../../terms.md)，界面层的第三道防线，已完成）。

## 状态

**代码完成、自动化全绿**（2026-07-27）；真机端到端已部分验证（见下「验证结论」），剩余项待跑。

**起因**：用户实测报告——dev 环境 `node --watch` 因文件变更重启，正在跑的那一轮直接失去驱动，界面上「思考中…」一直转，用户以为还在跑。生产环境的 pod 迁移是同一件事。

| 阶段 | 内容 | 状态 |
|---|---|---|
| C0 | 三份文档 + 术语表登记（优雅关闭、孤儿轮） | ✅ 已完成 |
| C1 | core：因 abort 收尾时透传 `signal.reason`（+ changeset，patch） | ✅ 已完成（`.changeset/abort-reason-passthrough.md`） |
| C2 | server：`turn-runner.ts` 的 `shutdownTurns` / `isShuttingDown` / `abortTurn(reason)` | ✅ 已完成 |
| C3 | server：`crash-recovery.ts` 启动扫描孤儿轮 | ✅ 已完成 |
| C4 | server：`index.ts` 信号处理 + 关闭期间拒绝新轮（503 链路） | ✅ 已完成 |
| C5 | web：`turn-marker.tsx` 两档文案 | ✅ 已完成 |
| C6 | 自动化测试（core / node-server / web） | ✅ 已完成 |
| C7 | 真机端到端（成功标准 1–8） | 🟡 部分已验（1、3、8 有实证；4–7 待跑） |

### 验证结论（2026-07-27）

**自动化（跑完即退）**

```bash
pnpm build && pnpm typecheck && pnpm test        # packages/*：core 459 全绿（含 abort reason 两条）
pnpm --filter @nimbo-chat/node-server test       # 556 全绿（含 shutdownTurns 5 条 + crash-recovery 6 条 + 503 路由 1 条）
pnpm --filter @nimbo-chat/node-server typecheck  # 干净
pnpm --filter @nimbo-chat/web test               # 271 全绿（含两档文案 1 条）
pnpm --filter @nimbo-chat/web typecheck / lint   # 干净
```

**实盘探针（跑完即退，不留常驻进程）**

1. **`node --watch` 的关闭语义**（本方案的前提）：两个探针进程实测出「发 SIGTERM + 无限期等待」，记录见 [tech 附录 A](../tech/graceful-shutdown.md)。
2. **真进程的 SIGTERM 收尾**（成功标准 8）：以 `SERVER_PORT=3999` 起真实 `src/index.ts`，4 秒后发 SIGTERM → **15 毫秒内 exit 0**，日志完整：

   ```
   INFO [server] shutdown requested {"signal":"SIGTERM","timeoutMs":15000}
   INFO [server] shutdown complete {"signal":"SIGTERM","abortedTurns":0,"allTurnsSettled":true,"pendingTurns":0}
   ```

3. **生产路径的意外实证**（成功标准 1、3）：施工期间用户自己的 dev server 一直开着，我改服务端代码触发了它的 `node --watch` 重启——事后查真实 `data.db`，三个会话的收尾如下：

   | 会话 | 收尾 `error.message` | 来自 |
   |---|---|---|
   | test3 / New chat | `The server shut down while this turn was running.` | 本功能的 `ABORT_REASON_SHUTDOWN` |
   | test2 | `The user stopped this turn before it started running.` | [起轮占位](../../../terms.md)的 `releaseTurn`（[turn-abort](../tech/turn-abort.md) §3.3） |

   也就是说优雅关闭在**真实热重载**下已经生效过，账本里留下了正确的收尾，三个会话的[待发队列](../../../terms.md)均为 0（没有消息被吞）。同一次检查还确认了 `crash-recovery` 的判重是对的：这些会话已有收尾 metadata，扫描正确地**跳过**了它们，没有重复追加。

**待跑**（需要我自己起服务）：成功标准 4（`kill -9` 后重启补收尾）、5（存量僵尸会话）、6（关闭期间发消息拿 503 的界面观感）、7（收尾卡住不拖死重启）。

## 施工拆单

### C1 core：透传宿主的中止原因

- `packages/core/src/loop.ts`：新增 `abortMessage(signal, fallback)`（实现见 [tech §2](../tech/graceful-shutdown.md)），step 边界检查与 catch 分支两处的 `NimboError.message` 都改用它。
- 关键边界：`abort()` **不带参数**时 `reason` 是运行时自造的 `AbortError`，要当作「宿主没给理由」回落到 fallback——否则界面会显示 "This operation was aborted" 这种第三方措辞。
- 产出：`packages/core/test/` 一条用例——`abort(new Error('custom reason'))` 后收尾 metadata 的 `error.message` 等于 `'custom reason'`；另一条 `abort()` 无参数时回落默认文案。
- changeset：`@nimbo/core` **patch**（不动 API、不动类型，只让 `message` 更有信息量）。**刻意不给 `NimboError.code` 加新值**，理由见 [tech §2](../tech/graceful-shutdown.md)。

### C2 server：turn-runner 的关闭入口

- 模块级关闭闸门 + `isShuttingDown()`。
- `abortTurn(conversationId, reason?, logger?)`：reason 透传给 `abortController.abort(new Error(reason))`；缺省保持现有的「用户按了停止」文案。
- `shutdownTurns({ timeoutMs, reason, logger })`：四步顺序（先置闸门 → 快照活跃轮并备好 `done` 等待 → 逐个 abort → 等齐或超时），返回 `{ aborted, settled, pending }`。**不碰 `process.exit`**。
- `reserveTurn`：闸门开着时拒绝，且拒绝原因要能与「已有轮在跑」区分（供 C4 转 503）。

### C3 server：启动扫描孤儿轮

- 新文件 `agent/crash-recovery.ts`：`recoverOrphanedTurns(db, logger)` → 返回补了几个。
- 判据：会话的 `conversation_events` 最后一行是 `kind = 'chunk'`。判重：那条 chunk 已经是 interrupted 收尾则跳过（避免每次启动重复追加）。
- 追加一条独立 `message-metadata`（`status: 'interrupted'`、`error.code: 'aborted'`、message 为 §4 常量）。**不删原有 chunk 行**（理由见 [tech §5](../tech/graceful-shutdown.md) 边界 1）。
- store 层可能需要一个「取某会话最后一个事件行」的读函数——优先复用 `listConversationEvents`，只在性能明显不合适时才加。

### C4 server：信号处理与 503 链路

- `index.ts`：`serve()` 的返回值留住（`server.close()` 要用）；注册 SIGTERM + SIGINT，顺序 **shutdownTurns → server.close() → exit(0)**（顺序理由见 [tech §3.2](../tech/graceful-shutdown.md)：反了收尾帧就发不出去）；重复信号只记日志。
- 启动时跑一次 `recoverOrphanedTurns`（在 `serve()` **之前**，这样第一个请求进来时账本已经一致）。
- `turn-launcher.ts`：`LaunchTurnOutcome` 加 `{ ok:false; reason:'shutting_down' }`；`startNextQueuedTurn` 撞上它**把消息留在队列里**（不 requeue、不丢）。
- `routes/chat.ts`：该 outcome → `503`，openapi 补这个响应码，重生成契约。
- dev 脚本旁加注释：我们监听 SIGTERM/SIGINT，改 `--watch-kill-signal` 要同步（[tech §7.5](../tech/graceful-shutdown.md)）。

### C5 web：两档文案

- `turn-marker.tsx` 的 `TurnFailedBar`：`code === 'aborted'` 时按 message 是否等于那个常量分两档——「服务重启，这一轮已中断」/「已停止」。常量在 web 侧也写一份（手写镜像纪律，注释互指）。
- 两档都保持中性 Alert（不是 destructive），沿用既有行为。
- `fixtures/design-preview-data.ts` 加一组「服务重启中断」样例并挂进[设计工作台](../../../terms.md)——那个页面的职责是「每一档界面状态都在同一屏」，新增一档不挂上去等于让它失效（同 turn-abort 第一批偏差 6 的教训）。

### C6 测试

- core：C1 的两条用例。
- node-server `turn-runner.test.ts`：`shutdownTurns` 中止全部并等到收尾（返回 `settled: true`）· 收尾卡住时撞超时返回 `settled: false` + `pending` 计数 · 闸门置真后 `reserveTurn` 被拒 · 空闲时立刻返回且不发任何帧 · `abortTurn` 的 reason 透传到 core 的 signal。
- node-server `crash-recovery.test.ts`：以 chunk 收尾的会话被补一条 interrupted · 已补过的不重复补（幂等）· 正常收尾的会话不被碰 · 空库不报错。
- node-server `routes/chat.test.ts`：关闭闸门开着时 `POST .../messages` 报 503。
- web：`turn-marker` 两档文案各一条。

### C7 真机端到端

对应产品文档 §4 的八条。需要我自己起服务（`! pnpm chat:server` / `! pnpm chat:web`），重点是 1（热重载）、4（`kill -9` 后重启）、5（存量僵尸会话被治好）、7（收尾卡住不拖死重启）。

## 实际改动与计划的偏差

1. **`reserveTurn` 的返回类型从 `TurnReservation | undefined` 改成了判别联合 `ReserveTurnResult`**（计划只说「拒绝原因要能区分」）：`undefined` 装不下两种拒绝原因。改成 `{ ok: true, reservation } | { ok: false, reason }` 后，`launchTurn` 只要把 `reason` 原样透出去即可，路由那边 `busy → 409` / `shutting_down → 503` 各走各的。代价是[起轮占位](../../../terms.md)那批既有用例要跟着改收窄写法（6 处）。
2. **`abortTurn` 的第二个参数变成了 `reason`**，原来的 `logger` 顺位后移。这是本仓库内部 API（`node-server` 是 private 包，不发版），调用点只有路由一处 + 测试一处，就地改掉。
3. **加了一个测试专用的 `__resetShutdownForTests()`**（计划里没有）：关闭闸门 `shuttingDown` 是模块级单向状态，生产里一个进程只关一次，但同一个测试文件里跑过一次 `shutdownTurns` 之后，后面所有用例的 `reserveTurn` 都会被拒、连锁失败。名字带 `__` 前缀是刻意的，让它在业务代码里显得格格不入。
4. **`crash-recovery` 的判重比计划更宽**：计划写的是「那条 chunk 已经是 interrupted 收尾则跳过」，实际改成「是**任何**终态收尾（`completed`/`failed`/`interrupted`）就跳过」。因为 `driveTurn` 的 catch 分支会留下一条 `status: 'failed'` 的收尾 metadata chunk——那一轮**已经有交代了**，再补一条「服务重启中断」是撒谎。用例里专门钉了这一档。
5. **store 加了两个函数**（计划说「优先复用 `listConversationEvents`」）：`listAllConversationIds`（全表、不按用户过滤——崩溃恢复是系统级维护动作）与 `getLastConversationEvent`（单条 `ORDER BY seq DESC LIMIT 1`）。没复用 `listConversationEvents` 是因为崩溃恢复要对**每个**会话问一次，把整份历史读进内存再丢掉太浪费（有的会话有 268 行）。
6. **顺带给[设计工作台](../../../terms.md)加了一组样例**：`previewShutdownInterruptedMessages`。除了「每一档界面状态都在同一屏」这个既有职责，它还兼任那个跨端文案契约的哨兵——`message` 必须与 `turn-marker.tsx` 的常量逐字一致，改了一边不改另一边，这组样例就会退回显示成「已停止」。

## 变更记录

- **2026-07-27 立项**：用户报 dev 热重载导致 agent 静默失去驱动、界面永远转圈；顺带指出生产环境 pod 迁移是同一问题。调研先纠正了一个前提——dev 用的是 **Node 自己的 `--watch`**（`--import tsx` 只负责加载 TS），不是 tsx 的 watch。两个探针进程实测出关键语义：发 SIGTERM、**无限期等待**子进程退出（详见 [tech 附录 A](../tech/graceful-shutdown.md)），因此「有事件可用」成立，但超时兜底必须自己写。
