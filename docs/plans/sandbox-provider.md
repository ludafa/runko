# 沙盒 provider 可选（施工进展）

> 相关：[产品视角](../features/sandbox-provider.md) · [技术方案](../tech/sandbox-provider.md)
> 依赖：[chat-webapp](../features/chat-webapp.md)（`sandbox-manager.ts`、`routes/chat.ts`、DB schema）· [sandbox](../features/sandbox.md)（两个适配器包）

> **立项 banner**：2026-07-19 用户提出「在 web 集成 E2B 沙盒，让用户自选 e2b/vercel」→ 调研 + 三决策定案 → 立项。
> **调研结论与决策**见本页「变更记录」；核心差异对照见[技术方案 §1](../tech/sandbox-provider.md)。

## 阶段总览

| 拆单 | 内容 | 状态 |
|---|---|---|
| SP-0 调研与验证 | E2B vs Vercel 差异调研 + `E2B_API_KEY` 真机验证 pause/resume/clone + 三份文档 | ✅ 已完成 |
| SP-1 provider 抽象 | `SandboxClient`→`SandboxProvider`，Vercel 实现平移（行为逐字等价） | ✅ 已完成 |
| SP-2 E2B provider | `createE2bProvider()`：建盒 + 建盒后 clone + connect 重连 + setTimeout + lifecycle pause | ✅ 已完成 |
| SP-3 DB + 路由接线 | 加 `provider`/`sandbox_id` 列 + 迁移；`acquire` 加 provider/resumeToken；路由落库令牌；DTO/openapi 加 provider | ✅ 已完成 |
| SP-4 前端 | 新建会话选 provider + 会话卡片 provider 徽标 + kubb 重生成 | ✅ 已完成 |
| SP-5 测试 | provider 两实现契约测试（fake）+ acquire 三态注入 fake provider + 路由集成 | ✅ 已完成 |
| SP-6 真机验收 | 选 E2B 走完 建会话→消息→休眠→唤醒→（可选）PR；Vercel 回归 | 🔶 休眠已暴露 bug→修复→真机验证；完整浏览器 E2E（设计→PR、Vercel 回归）待重跑 |
| SP-7 缓存失效 + 保活心跳 | 修「沙盒 paused 后进程仍用陈旧句柄 → 裸 404 且永不自愈」 | ✅ 已完成（层 4 自愈代理另立） |

## 拆单明细

- **SP-0 调研与验证（主线程，✅）**：调研 E2B/Vercel 差异（技术方案 §1 表）；用用户 `E2B_API_KEY` 跑最小真机脚本（临时、已删）确认 `pause()`/`Sandbox.connect(sandboxId)` 静态重连保态 + 建盒后 `git clone` 可行；产出 features/tech/plan 三文档 + 术语登记（沙盒 provider / 重连令牌）。
- **SP-1 provider 抽象（主线程内联，✅）**：`sandbox-manager.ts` 内 `SandboxClient`→`SandboxProvider`（技术方案 §3 接口）；`createVercelSandboxClient()`→`createVercelProvider()`，`ProvisionedSandbox`/`resumeToken`/`extendIdle` 包住现状逻辑，**Vercel 行为逐字等价**。`acquire`/`AcquireInput`/`AcquiredSandbox` 按 §3.1 加 `provider`/`resumeToken`；manager 改吃 provider registry（`{ vercel: createVercelProvider() }`）。**实际改动**：`sandbox-manager.ts`（重写）、`routes/chat.ts`（import + 实例化 + 两处 `acquire` 传 `provider:'vercel'`+`resumeToken`）、`turn-runner.ts`（注释）、`test/agent/sandbox-manager.test.ts`（fake 改 `SandboxProvider`）、`test/helpers/fake-sandbox-manager.ts` + `test/routes/chat.test.ts`（`AcquiredSandbox` 加 `resumeToken`）。**验收结论见下**。
- **SP-2 E2B provider（主线程内联，✅）**：`createE2bProvider()`——`E2bSandbox.create({apiKey, timeoutMs, lifecycle:{onTimeout:'pause',autoResume:true}, envs:{GH_TOKEN}, metadata:{name}})` + `git clone --depth 1 <token-auth url> /home/user/repo` + `e2bWorkspace(sb,{root:'/home/user/repo'})`；`resume`=`E2bSandbox.connect(id,{apiKey})`（`SandboxNotFoundError`/`NotFoundError` → `unavailable`，其余 rethrow）；`extendIdle`=`sb.setTimeout`。clone 用 `$GH_TOKEN` 字面量靠沙盒 env 展开（不把 PAT 拼进命令串，同 `remoteAuth` 纪律）。惰性 `requireEnv('E2B_API_KEY')`。**实际改动**：`apps/node-server/package.json`（加 `@nimbo/sandbox-e2b`+`e2b` 依赖）、`sandbox-manager.ts`（加 import + `createE2bProvider`/`e2bProvisioned`/`isE2bSandboxGone`/`withTokenAuth`）、`routes/chat.ts`（registry 注册 `e2b`，惰性、SP-1 路由仍恒传 `provider:'vercel'`）、新增 `test/agent/e2b-provider.test.ts`（`vi.mock('e2b')` 契约测试 6 例）。**验收结论见下**。
- **SP-3 DB + 路由接线（主线程内联，✅）**：schema 加 `provider`（NOT NULL default 'vercel'）/`sandbox_id`（nullable）+ 迁移 `0006_fresh_stellaris.sql`（存量回填 `vercel`/null）；`store.ts` `createConversation` 收可选 `provider`/`sandboxId`（默认对齐列默认，路由始终显式传）、`ConversationPatch` 加 `sandboxId`；`sandbox-manager` 加 `resolveDefaultProvider()`（读 `SANDBOX_PROVIDER`）；`routes/chat.ts`：POST /conversations 读 `input.provider ?? 默认`、捕获 `acquired`、E2B 落 `sandbox_id=resumeToken`（Vercel 落 null），POST /messages 按 `row.provider` 定 resumeToken（E2B=`sandbox_id`、Vercel=`sandbox_name`）、E2B 重建后回写新 `sandbox_id`；`toConversationDto` 加 `provider`；`ConversationSchema`/`CreateConversationInputSchema` 加 `provider`；openapi 重生成（`.env.template` 加 `SANDBOX_PROVIDER`、改 E2B_API_KEY 注释）。**验收结论见下**。
- **SP-4 前端（主线程内联，✅）**：`features/chat/schema.ts` 手写 `conversationSchema` 加 `provider` + 导出 `conversationProviderSchema`/`ConversationProvider`（chat 客户端用手写 zod 校验，非 kubb 生成）；`api.ts` `createConversation` 入参加 `provider`；`chat-layout.tsx` `handleCreate(title, provider)`；`conversation-list.tsx` 新建表单加 provider 分段切换（默认 vercel、显式发送，见 lantie 决策）+ 卡片加 provider 徽标；新增 `provider-badge.tsx`（品牌色圆点 + 名称）；`conversation.tsx` 详情头部加徽标；kubb 重生成（`src/gen/` 的 Conversation/CreateConversationInput 同步 `provider`）。**验收结论见下**。
- **SP-5 测试（tester agent，✅）**：大部分随 SP-1/2/3 内联完成，本阶段由 tester 补深水缺口并审计。**新增 10 例**：① `test/routes/chat.test.ts` E2B 重建回写 3 例（过期重建→acquire 返回新 token→`sandbox_id` 回写为新值；Vercel 恒不回写 `sandbox_id`；resumeToken 未变时 `db.update` spy 断言零写）；② `test/agent/store.test.ts` 3 例（`createConversation` 默认 vercel/null、显式 e2b 存值、`updateConversation` 仅 sandboxId 补丁不误动其他列）；③ `test/agent/sandbox-manager.test.ts` `resolveDefaultProvider` 4 例（未设/=e2b/大小写空白/非法回落）。扩展 `test/helpers/fake-sandbox-manager.ts` 加 `nextResumeToken`（让某次 acquire 返回不同令牌，模拟重建）。tester 审计未发现产品缺陷。**验收结论见下**。
- **SP-6 真机验收（主线程 + tester，🔶 部分）**：`E2B_API_KEY` 已在 `.env`。tester 起完整栈跑浏览器 E2E；**休眠→唤醒步骤暴露真 bug**（详见下「SP-6 发现与修复」），主线程接手诊断+修复+真机验证。完整浏览器 E2E（设计→PR、Vercel 只读回归）因 tester 中途卡在长轮次未跑完确认，待重跑。

- **SP-7 缓存失效 + 保活心跳（主线程内联，✅ 2026-07-25）**：起因是用户线上撞到 `{"error":"Sandbox ie678jts670cem6zsgay7 not found"}`。**诊断**：查 E2B 实况发现该盒 `state=paused`（**没被删**）、`lifecycle{onTimeout:'pause',autoResume:true}`；真因是 `sandbox-manager` 的 `active` Map 缓存句柄却**从不失效**、`release()` 全仓无调用点——盒被平台 pause 后进程仍拿旧句柄打，`resume()` 那套重试/重建被缓存短路，永不自愈。旁证两条：走 `resume` 的话 `isE2bSandboxGone` 会匹配并静默重建、用户根本看不到这个错；且当时唯一 running 的盒属于**另一个**会话，说明该会话确实没发生重建。**根因层面**是 E2B 超时为绝对截止时间、跑命令不续期（文档 + 实测双证，见技术方案 §5.1）。**实际改动**：`SandboxProvider` 加 `isGone(error)`（两实现各自复用已有的 `isRecoverableGetFailure`/`isE2bSandboxGone`）；`ActiveSandbox` 加 `provider`/`expiresAt`，`acquire` 命中先比截止时间、过期即驱逐走 resume，resume 成功后显式 `extendIdle` 一次让 `expiresAt` 可信（并处理「resume 回来的盒在保活时就没了 → 退回 create」）；`touch` 抽成 `extendDeadline`，成功推 `expiresAt`、抛 gone 则驱逐后原样 rethrow；新增 `startHeartbeat(conversationId)`（`idleTimeout/2` 周期、`unref`、停止函数幂等），`turn-launcher` 在 `startTurn` 前开、`onTurnSettled` 停、起轮被 busy 守卫挡掉时就地停；`release` 走统一 `evict`（连带停心跳）。**未做**：层 4 workspace 自愈代理，理由（重放安全性）见技术方案 §5.1。**测试**：`sandbox-manager.test.ts` 新增 9 例（TTL 过期重连 / 保活推后截止时间 / gone 驱逐 / 非 gone 不驱逐 / 心跳周期与停止 / 心跳吞错 / 停止幂等 / release 停心跳 / resume 后显式保活 + 保活即没退回 create），`chat.test.ts` 新增 1 例（一轮开心跳、轮结束停），假件补 `startHeartbeat` 记账。**server 全量 358 绿、`tsc --noEmit` 干净、改动文件 lint 零 error。** **待办**：真机复验一轮——让一个会话空闲超过 `SANDBOX_IDLE_TIMEOUT_MS` 再发消息，确认自动重连且不再报 not found。

## 验收结论

### SP-1（✅ 通过）

- `pnpm --filter @nimbo-chat/node-server typecheck` 通过。
- 全量 `vitest run`：**11 文件 / 224 测试全绿**（含改写后的 `sandbox-manager.test.ts` 三态：resume ok / 无 token 直建 / resume unavailable 重建 + 分支恢复 + 内存命中 + 并发单飞 + 未注册 provider 报错）。
- 改动文件 eslint 0 error（prettier 已 `--fix`）。
- **无行为回归**：Vercel 路径逐字等价——路由对 Vercel 恒传 `resumeToken = sandboxName`，保留原「首次 acquire 走 `get()`→404→create」序列；brand-new（无 token）才跳过 resume 直建（仅 E2B 首建触发）。
- 未生成 changeset：`@nimbo-chat/*` 为 private 应用包、且本阶段为纯内部重构无用户可见行为变化（用户可见能力落在 SP-3/SP-4）。

### SP-2（✅ 通过）

- `pnpm install` 拉入 `e2b@2.32.0`（catalog）+ `@nimbo/sandbox-e2b`（workspace）到 server。
- server typecheck 通过；全量 `vitest run`：**12 文件 / 230 测试全绿**（+6 新增 E2B provider 契约测试：create+clone+lifecycle+token、clone 失败抛错、resume ok、`SandboxNotFoundError`→unavailable、其他错 rethrow、缺 key 报错且不触网）。
- 改动文件 eslint 0 error（prettier 已 `--fix`）。
- **不影响 Vercel 路径**：E2B provider 已注册进 registry 但路由 SP-1 仍恒传 `provider:'vercel'`；`createE2bProvider()` 惰性（构造不读 env），无 `E2B_API_KEY` 也不报错。
- 真机端到端留到 SP-6（本阶段用 mock 覆盖逻辑，真盒 create/connect 已在 SP-0 单独验证过可行）。

### SP-3（✅ 通过）

- 迁移 `0006_fresh_stellaris.sql`：`ALTER TABLE conversations ADD provider text DEFAULT 'vercel' NOT NULL` + `ADD sandbox_id text`（存量安全回填）；test-db 走真实迁移，无需改夹具。
- server typecheck 通过；全量 `vitest run`：**12 文件 / 232 测试全绿**（+2 新路由用例：不传 provider→DTO/acquire/row 均 `vercel` 且 `sandbox_id` 为 null；`provider:'e2b'`→acquire `resumeToken` 为 undefined、DTO/row `provider='e2b'`、`sandbox_id` 落库）。
- openapi 重生成：`Conversation.provider`（必填）、`CreateConversationInput.provider`（可选）已入契约——供 SP-4 web kubb 消费。
- 改动文件 eslint 0 error（prettier `--fix`；含 store.ts 两处既有单行→多行的顺带归一）。
- **兼容/回归**：不带 `provider` 的请求落默认、行为不变；Vercel 路径 `sandbox_id` 恒 null、按 name 恢复不变；`provider` 列在 store `createConversation` 可选、既有测试夹具零改动。
- 未生成 changeset：仅改 `@nimbo-chat/node-server`（private 应用），未触任何 public `@nimbo/*` 包。

### SP-4（✅ 通过）

- web typecheck（`tsc -b`）通过；`vitest run`：**10 文件 / 160 测试全绿**（无回归）；生产 `vite build` 成功。
- kubb 重生成：`gen/` 的 `Conversation`/`CreateConversationInput`（types + zod + schemas）已带 `provider`（chat 客户端本身用手写 schema，gen 同步是契约纪律）。
- 用户可见：新建会话侧栏加 Vercel/E2B 分段切换（默认 vercel）；会话列表卡片 + 详情头部各加 provider 徽标（品牌色圆点 + 名称）。
- 改动文件 eslint 0 error（prettier/import-sort `--fix`）。
- 交互真机截图验证并入 SP-6（需完整后端 + 登录态起栈）。
- **provider 默认策略**（前端总是显式发送、默认 vercel、不沿用服务端 `SANDBOX_PROVIDER`）记于 lantie；权衡见该条。

### SP-5（✅ 通过）

- 主线程独立复核：`pnpm --filter @nimbo-chat/node-server typecheck` 通过；`vitest run`：**12 文件 / 242 测试全绿**（SP-3 基线 232 + 新增 10）；改动测试文件 eslint 0 error。
- 抽读 E2B 重建用例确认「测到点」：断言的是**实际落库值**（`row.sandboxId === 'sbx_rebuilt'`、Vercel `toBeNull()`、no-op 用 `vi.spyOn(db,'update')` 断言零写），非仅「没抛错」。
- tester 审计 `routes/chat.ts` 回写条件 / `store.ts` 默认值 / `resolveDefaultProvider` 大小写·trim·回落，均与技术方案 §3.1/§6 一致，**无产品缺陷**。

### SP-6 发现与修复（🔶 休眠已闭环；完整浏览器 E2E 待重跑）

**发现（真机 bug）**：E2B 会话休眠后，第二条消息报 `连接中断：{"error":"Sandbox <id> not found"}`，原始错误裸抛到界面。

**诊断**（3 个真机探针，均已删）：
- auto-pause（`onTimeout:'pause'`）+ 40s / +180s 延迟 `connect` 均**成功**、`state=running`、marker 保留 → 平台机制没问题、retention 够。
- 直接 `connect` 报错里那个 `sandboxId` **竟然成功**（盒还在、可重连）→ 那个 404 是**瞬时**的，不是盒被回收。
- e2b 源码：`Sandbox <id> not found` = `SandboxNotFoundError`（name 匹配）。
- **根因**：`createE2bProvider().resume()` 原本单次 `connect`——撞上「刚 auto-pause、快照落定前」的瞬时 404 窗口，就把一个其实活着的盒判失败、裸抛错误。**是 resume 缺重试韧性，非平台限制。**（见 lantie correction）

**修复**（`apps/node-server/src/agent/sandbox-manager.ts`）：`resume()` 对 `connect` 做有限退避重试（`E2B_RESUME_ATTEMPTS=4`、退避 `500ms×attempt`，总窗 ~3s）——瞬时 404 重试即重连回原盒（保住未 push 的 WIP），只有**持续** not-found 才 `unavailable`→重建；`isE2bSandboxGone` 加 message 兜底（`/sandbox.*not found/i`），"Invalid sandbox ID"(400) 不算 gone。

**验证**：
- 单测：`e2b-provider.test.ts` 用 fake timers 加 3 例——瞬时 404 重试后 `ok`（重连原盒、不重建）、持续 not-found 耗尽重试后 `unavailable`、持续非-gone 错误照抛。全量 `vitest run` **243 全绿**、typecheck/lint 干净。
- **真机（provider 层）**：直接调修好的 `createE2bProvider()` 走 create→clone→45s 空闲 auto-pause→`resume`，返回 `ok`、重连原盒、marker 文件保留、exec exit 0 = **PASS**。

**待办**：完整浏览器 E2E（选 E2B 跑设计→真开 PR、Vercel 只读回归）在 tester 卡在长轮次时未跑完确认——需重跑一遍验收（会开真 PR、花额度）。收尾：dev 进程已停、`.env` `SANDBOX_IDLE_TIMEOUT_MS` 已还原 300000、探针已删。

## 变更记录

- **2026-07-19 立项 + 三范围决策（用户拍板）**：
  1. **provider 选择粒度 = 每会话创建时选**（落 `conversations.provider`；与沙盒 1:1 绑定，运行中不切换）。排除「全局 env 唯一」（失去用户自选诉求）与「用户级默认设置页」（本次不值当加用户设置存储）。
  2. **E2B 休眠 = 完整对齐 Vercel**（`onTimeout:'pause'+autoResume` + `connect` 自动 resume）。前置「先真机验证账户支持 pause」已在 SP-0 通过（pause 支持、connect 保态）。排除「简化 v1 不休眠」（与既有休眠/唤醒+代码快照体验落差大，且账户已验证支持）。
  3. **目标仓库仍走全局 env**（`GITHUB_REPO`/`GITHUB_PAT`）；本次只做 provider 可选，不做「仓库用户可选」（避免 DB/UI/鉴权范围扩大）。
- **2026-07-19 SP-0 调研（✅）**：确认差异全落 `sandbox-manager.ts`（适配器包只做视图、不管生命周期）；`SandboxProvider` 抽象缝定型（技术方案 §3）；E2B workspace root 设为 clone 目标 `/home/user/repo` 使共享 init/分支命令零改动（两适配器 exec 均按 root 解析 `cwd:'/'`）。真机验证：pause ~0.6s、connect 静态重连保态、建盒后 clone 小仓库 ~4.5s。
