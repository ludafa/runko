# Turn Checkpoint 与沙盒保活（P13-2 / P13-2b）

> 状态：方案定稿待施工（2026-07-14，随 P13 持久化分析逐项讨论定案）
> 相关：[docs/08](./08-chat-agent-webapp.md) §2.2d（transcript 减量，P13-1 已交付）· [nimbo-sandbox-spec](./nimbo-sandbox-spec.md)（BYO 原则与配方章节，施工时回填保活配方）· [施工计划](./03-construction-plan.md) P13
>
> **术语（先读这里，正文不再自造记号）**：
> - **turn / 轮**：用户一条消息驱动的一次完整 agent loop。
> - **模型记忆**：`chat_sessions.nimbo_state_json`（`session.toJSON()`），模型「记得自己做过什么」的唯一恢复来源，只在 turn 收尾写入。
> - **代码快照（checkpoint）**：turn 收尾时工作区的完整状态，以 git 提交对象形式推到用户仓库的隐藏 ref。
> - **上次存档**：最近一次正常收尾时写下的「模型记忆 + 代码快照」这一对。
> - **平台快照**：Vercel 沙盒停机时自动保存的磁盘快照（与本方案的代码快照是两回事：平台快照是加速缓存，代码快照是持久层）。
> - **保活（keepalive）**：主动延长沙盒剩余存活时间，防止它在干活期间被平台回收。

## 0. TL;DR

两个正交机制，一次施工：

1. **checkpoint（P13-2）**：每轮结束把代码库完整状态推到 `refs/nimbo/wip/<sessionId>`（隐藏 ref，UI 不可见、不触发 CI），与模型记忆**同边界写入**——两本账要么都有这轮、要么都没有，崩溃时天然一致。平台快照过期从「丢未 push 工作」降级为「恢复慢一点」。
2. **保活（P13-2b）**：Vercel 的沙盒时效是**租期倒计时**（干活不算数、`extendTimeout` 是加时不是重置）——turn 进行中由心跳按「补足」语义续命，长任务不再中途死亡；顺带修掉现有 `touch` 每条消息盲加 5 分钟的累积 bug。

## 1. 产品设计

### 1.1 checkpoint：用户得到什么

- **承诺**：会话里 agent 做过的工作（含未 commit、未 push 的改动和新文件）不会因为平台快照过期而丢失。
- **无感**：平时用户和模型都察觉不到它——不动会话分支的提交历史（instructions 的「不主动 commit」承诺不破坏）、GitHub UI 看不到、不触发 CI/preview 部署。
- **诚实**：沙盒重建时，时间线上出现一条系统事件（`sandbox.recreated`）说明恢复到了什么程度（完整还原 / 仅分支 / 全新），同时把同样的信息告诉模型，双方都不被误导。
- **未来可扩展**：快照按轮链式保留（每轮一个提交、父子相连），「回滚到第 3 轮的工作区」这类产品功能有了现成原语（本期不做 UI）。

**非目标**：`.gitignore` 覆盖的产物（node_modules、构建缓存）不备份（可重建）；本期不做快照浏览/回滚 UI；agent 在沙盒里做过但未 push 的 **commit 历史**不承诺恢复（其文件内容在快照树里，会以未提交改动的形态回来——内容不丢，提交记录丢）。

### 1.2 保活：用户得到什么

- **长任务不断**：一轮跑 10 分钟、20 分钟的设计任务，沙盒不会在干活干到一半被平台回收（现状：超过 5 分钟必死）。
- **不多花钱**：修掉现有 touch 的累积 bug——高频对话后沙盒不再多活几十分钟白烧钱；心跳是「补足到 5 分钟」不是「加 5 分钟」，水位恒定。
- **休眠体验不变**：turn 结束心跳即停，用户离开 5 分钟后照常休眠存平台快照。

**非目标**：不改休眠/唤醒语义；不给失控任务无限续命（有单轮上限）。

## 2. 技术方案

### 2.1 核心不变量（一切失败语义的锚）

**代码快照跟着模型记忆走，不跟「turn 成功」走**：两者在同一个收尾边界、以同一个条件写入。写入顺序定死为——

```
快照 → 模型记忆 → turn.result 事件
```

顺序理由：若恰好在两步之间崩溃，宁可「代码比记忆新」（模型下轮 git status 就能发现多出来的东西），不可「记忆比代码新」（模型坚信存在的改动实际没有，纯误导）。

### 2.2 能力包 `@nimbo/git-checkpoint`（平台无关）

新包，与 mini-bash 同粒度，sdk 透传。只依赖 `NimboExec`（git plumbing 命令编排），对 session/turn 无知——元数据是调用方给的不透明键值。适配任意有 git 的沙盒，可用 fake exec 单测。符合 spec「要基线管理，用沙盒里的 git」（§4.5 规则 3）与「生命周期归宿主」（BYO 原则）。

```ts
snapshotWorkspace(exec, { ref, parent?, metadata })
  → { changed: boolean, commit?, tree? }
restoreWorkspace(exec, { ref })
  → { restored: boolean, commit?, metadata? }
readCheckpoint(exec, { ref }) → { commit, metadata } | undefined
```

实现要点：

- **快照**：`git add -A → write-tree → reset -q → commit-tree → push`——不动分支/index/工作区，模型无感；树对象与上一轮相同时短路返回（`changed: false`，不推）。**这是唯一可靠的「有没有改动」判定**——bash 写入（sed、npm install 改 lockfile）不产生 file_change 事件，靠事件做门槛会漏。
- **延迟**：本地 commit 同步完成（毫秒级，保证对齐判定），push 异步尽力而为——push 失败即「快照欠账」，由全树语义自愈（见 2.4 第 4 条）。
- **ref 布局**：`refs/nimbo/wip/<sessionId>`（正常存档，链式：每轮以上一轮快照为 parent）+ `refs/nimbo/crash/<sessionId>`（事故现场留底，见 2.4 第 2 条）。`refs/nimbo/*` 不在 `refs/heads/*` 下：GitHub UI 不可见、不触发 CI；仓库管理员 `git ls-remote` 可见（如实记录，不算隐藏后门）。
- **metadata** 写进 commit message：`session` / `turn` / `lastSeq`（该轮 turn.result 的 seq）——三本账（transcript、模型记忆、代码快照）可互相校验对齐。
- **restore**：`git fetch <ref>` → `read-tree -u --reset` 到快照树 → `git reset -q` 回到分支基线——工作区精确等于快照（含删除的文件），改动以未提交形态呈现，与休眠前的真实状态同构。

### 2.3 chat 应用接线

- **turn-runner 收尾**（成功与优雅失败**同权**，见 2.4 第 1 条）：按 2.1 的顺序执行；快照 metadata 取当轮 turn 号与 lastSeq。
- **catch 分支**（生成器意外抛错）：模型记忆本来就故意不写，正常存档 ref 也不动；尽力把残局推到 crash ref（失败即放弃）。
- **sandbox-manager 恢复阶梯**（重建路径扩展）：平台快照恢复（最快，现状）→ 重 clone + checkout 分支 + **wip 还原**（新增）→ 仅分支（wip ref 不存在/fetch 失败）→ 全新分支。每次走到重建，发 `sandbox.recreated` wire 事件：`{ recovery: 'wip' | 'branch' | 'fresh', checkpointTurn?, stateTurn }`，并在下一轮给模型注入一条说明（工作区被重置到什么状态），把 docs/08 §4.1 的「UI 如实提示」从文档承诺变成机制。
- **收尾竞态窗口**：快照的同步部分发生在 turn 注册表摘除之前，期间新消息会撞 409（窗口为毫秒级本地 git 操作；push 已异步化不占窗口）——接受，不上锁。

### 2.4 失败语义（六种失败形态 × checkpoint 的行为）

| # | 失败形态 | 模型记忆写入？ | 快照动作 | 恢复后一致性 |
|---|---|---|---|---|
| 1 | **优雅失败**（max_turns / context_overflow / provider_error / aborted：loop 内降级，仍有 TurnResult） | 写 | **照常快照**——这轮改的文件模型记得，跳过快照会让记忆领先于代码 | 完全对齐 |
| 2 | **生成器意外抛错**（turn-runner catch 分支） | 故意不写 | 正常 ref 不动；残局推 crash ref 留底（恢复永远不用它，纯打捞） | 两本账都停在上次存档，对齐 |
| 3 | **进程崩溃**（turn 进行中） | 没机会写 | 什么也做不了——但两本账都停在上次存档，**不变量自动成立** | 结构性对齐 |
| 4 | **快照自身失败**（push 被拒/网络/沙盒恰好死在收尾） | 已写 | 尽力而为放弃。快照是**全树**不是增量：下一轮一次成功自动补齐全部欠账 | 记忆暂时领先；restore 时对比 `checkpointTurn` 与 `stateTurn`，有差距就在事件与模型注入里如实报告 |
| 5 | **turn 未启动**（沙盒/模型配置 500） | 不写 | 无关 | 无变化 |
| 6 | **沙盒 turn 中途死亡** | 演化为 1/2/4 之一 | 同上 | 同上；发生频率由保活（§2.5）根治 |

### 2.5 保活（P13-2b）

**平台事实**（2026-07-14 经 Vercel 官方文档核实）：Vercel 沙盒的 timeout 是**租期倒计时**——平台不看活动，跑命令不续命，到点即停（命令跑到一半也停，停机瞬间存平台快照）；`extendTimeout(ms)` 是**往剩余租期上加时**，不是重置；`sandbox.timeout` 属性报告剩余毫秒数，官方推荐「先查剩余、不够再补」。

| 平台 | 时效模型 | 「补足到还剩 X」的翻译 |
|---|---|---|
| Vercel | 租期倒计时，`extendTimeout` 加时 | 读 `timeout` 剩余量，不够加差值 |
| E2B | 倒计时，`setTimeout(ms)` 重置为从现在起 X | 直接 `setTimeout(X)`，天然幂等 |
| Cloudflare | `sleepAfter` 真·空闲检测，活动自动续 | 基本无操作 |

设计：

- **接缝按意图定义**：chat 应用的 `ManagedSandbox` 接口把 `extendTimeout(durationMs)` 演进为 `ensureLifetime(targetMs)`（补足到至少 X，够了就什么都不做）——平台差异全部封在 `SandboxClient` 实现里，不进 nimbo SDK/适配器（spec BYO 原则：「超时延长」点名归宿主）。
- **touch 修正**：用户消息/审批/回答时的 `touch` 改调 `ensureLifetime(idleTimeout)`——修掉现有「每条消息盲加 5 分钟」的累积 bug（高频对话后沙盒多活几十分钟白计费，还可能撞套餐总时长上限）。
- **心跳**：turn 注册时启动、收尾（含异常）时停止的定时器，每 `idleTimeout / 2`（默认 150 秒）调一次 `ensureLifetime(idleTimeout)`。补足语义保证水位恒定。心跳失败只记日志（网络抖动常见；沙盒真死了工具报错会自己浮出来）。进程崩溃时定时器随进程死，沙盒 5 分钟后照常休眠——行为与现状一致。
- **单轮上限**：`SANDBOX_TURN_KEEPALIVE_MAX_MS`（默认 30 分钟）——超限停止续命，让倒计时自然终结失控任务，防无限烧钱。
- **解耦副产品**：审批 240 秒超时不再背负「赶在沙盒死前了结」的保命职责（心跳接管），回归纯产品决策（人多久不理算放弃），数值不动。

### 2.6 配置面（新增 env，`.env.template` 同步——注意该文件受权限保护需人工编辑）

```
CHAT_CHECKPOINT_MODE=wip            # wip（默认，启用 turn 快照）| off（完全关闭，回到纯平台快照）
SANDBOX_TURN_KEEPALIVE_MAX_MS=1800000  # 单轮保活上限，默认 30 分钟
```

心跳间隔不单开旋钮（恒为 `SANDBOX_IDLE_TIMEOUT_MS / 2`），减少配置面。

### 2.7 已知取舍与边界

1. **依赖 PAT 的 push 权限**（已具备）；隐藏 ref 对仓库管理员 `ls-remote` 可见。若宿主不接受向 origin 写 ref，`CHAT_CHECKPOINT_MODE=off` 回到现状。
2. **crash ref 与 wip ref 的清理**归留存治理（P13-4，会话删除时应一并删 ref）——本期只写不删。
3. 未 push 的 commit **历史**不可恢复（内容可恢复，见 §1.1 非目标）。
4. turn 中崩溃 + 沙盒存活的场景下，工作区可能领先于模型记忆（沙盒里有崩溃轮的残迹）——现状即如此，instructions 已引导模型用 git status 自查；P13-3（中断哨兵）负责把这个状态在 UI 上显性化。

## 3. 施工拆单

- **P13-2 checkpoint**（coder → tester）：
  1. 新包 `packages/git-checkpoint`（snapshot/restore/read + 树短路 + 异步 push；fake exec 单测归 tester）；sdk 透传。
  2. chat 接线：turn-runner 收尾顺序改造（快照 → 记忆 → turn.result，优雅失败同权，catch 分支 crash ref）；`sandbox.recreated` wire 事件 + schema + 恢复阶梯 + 模型注入；openapi/kubb 重生成；web 时间线渲染 recreated 事件（简单系统条目）。
  3. `nimbo-sandbox-spec` 配方章节回填「turn 对齐 checkpoint」（该文档当前未提交，回填时与用户确认）。
- **P13-2b 保活**（同一 coder 紧随其后）：`ensureLifetime` 接缝 + touch 补足修正 + turn 心跳 + 单轮上限。
- **验收**：双端 typecheck/lint/test 全绿；git-checkpoint 包纳入根管线（packages/* filter 本就覆盖）；真机验收项——长 turn（>5 分钟）不死、快照 ref 在 origin 可见且 UI 不可见、删平台快照后重建走 wip 还原、恢复级别事件如实呈现。
- **明确不做**：沙盒 FS 的 blob 级导出（与「隔离即边界、沙盒可丢弃」哲学冲突）；从事件流重建模型记忆（双账本各司其职）；hooks 机制（宿主已拥有 turn 边界，见 2026-07-14 讨论定案——hooks 只在「需要 loop 内部挂起且宿主够不到」时才引入，先例是审批链）。
