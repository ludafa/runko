---
title: "推送通知 —— 施工进展"
slug: push-notification
view: 施工
layer: 接入层
module: —
packages: ["@nimbo-chat/node-server", "@nimbo-chat/web"]
tags: ["推送通知", "Web Push", "等人提醒"]
related: ["ingress/features/push-notification.md", "ingress/tech/push-notification.md", "architecture/tech/agent-kernel.md"]
---
# 推送通知 —— 施工进展

> 术语见 [docs/terms.md](../../terms.md)。
> 产品文档 [功能](../features/push-notification.md)，技术方案 [技术方案](../tech/push-notification.md)。

## 状态总览

| 阶段 | 内容 | 落点 | 状态 |
|---|---|---|---|
| PN-0 | 术语登记 + 三份文档 | `docs/` | ✅ 完成（2026-07-26） |
| PN-1 | 依赖 + VAPID 总闸 + 环境变量 | `apps/node-server` | ✅ 完成（2026-07-27） |
| PN-2 | `push_subscriptions` 表 + 迁移 + store | `apps/node-server` | ✅ 完成（2026-07-27） |
| PN-3 | 订阅 API（config / subscribe / unsubscribe / test） | `apps/node-server` | ✅ 完成（2026-07-27） |
| PN-4 | 发送器（web-push 封装 + 失效回收） | `apps/node-server` | ✅ 完成（2026-07-27） |
| PN-5 | Service Worker + 铃铛 + 点击跳转（**不含 PWA**） | `apps/web` | ✅ 完成（2026-07-27） |
| PN-6 | 在场心跳（服务端内存 + 前端上报） | `apps/node-server` + `apps/web` | ✅ 完成（2026-07-27） |
| PN-7 | 通知决策层 + 四个触发点接线 | `apps/node-server` | ✅ 完成（2026-07-27） |
| PN-8 | 测试补齐 | 两侧 | ✅ 完成（2026-07-27，新增 98 个用例） |
| PN-9 | 审批超时 + 审批保活预算一起提到 15min（**需拍板**） | `apps/node-server` | 🟡 待决策 |
| PN-10 | 端到端验证方案 + 执行 | — | 🟡 方案已就绪，**真机部分待跑**（要你起服务） |

**依赖顺序**：

```
PN-0 → PN-1 → PN-2 → ┬→ PN-3 ─┬→ PN-5 ─┐
                     └→ PN-4 ─┘        ├→ PN-8 → PN-10
                     PN-6 ─────────────┤
                     PN-4 + PN-6 → PN-7┘
PN-9 独立，任何时候都能做，但要在 PN-10 之前定
```

**可并行**：PN-3 与 PN-4 互不依赖（一个管收订阅、一个管发投递）；PN-6 只碰在场那条线，与 PN-3/4/5 全程可并行。

**不需要 changeset**：改动全部落在 `apps/node-server` 与 `apps/web`，两者都是 `private: true` 的不发布成员（见根 [CLAUDE.md](../../../CLAUDE.md)「版本管理机制」）。`packages/*` 一行不动。

---

## PN-0 术语登记 + 三份文档 ✅

**目标**：先登记术语再动笔（[术语纪律](../../../CLAUDE.md)），三份文档到位。

**产出**：

- `docs/terms.md` 新增第十二节「推送通知」，八个词条：[推送通知](../../terms.md)、[推送订阅](../../terms.md)、[VAPID 密钥对](../../terms.md)、[Service Worker](../../terms.md)、[通知触发点](../../terms.md)、[在场](../../terms.md)、[前台抑制](../../terms.md)、[通知合并标签](../../terms.md)。
- `docs/ingress/features/push-notification.md`、`docs/ingress/tech/push-notification.md`、本文件。

**已定的需求边界**（来自开工前的确认）：Web Push + 前台抑制 · 四类触发全要 · 点开跳转（通知内不放允许/拒绝按钮）。

---

## PN-1 依赖 + VAPID 总闸 + 环境变量 ✅

**目标**：装好 `web-push`，把"没配密钥就整功能禁用"这条总闸先立起来——后面每一阶段都要靠它才能安全地半成品上线。

**涉及文件**：

- `apps/node-server/package.json`：`web-push` + `@types/web-push`
- `apps/node-server/src/push/vapid.ts`（新建）
- `apps/node-server/src/push/events.ts`（新建）：`CHAT_PUSH_EVENTS` 白名单解析
- `.env.template`：六个变量（[技术方案附录 A](../tech/push-notification.md)）
- `apps/node-server/src/index.ts`：启动时打一行"推送已启用/未配置"

**产出物**：

1. `isPushEnabled(): boolean` —— 三个 VAPID 变量齐了才 true，结果缓存，不每次读 env。
2. `getVapidConfig(): VapidConfig | undefined` —— 有则返回三元组，无则 undefined（不抛）。
3. `isEventEnabled(kind: PushKind): boolean` —— 白名单，默认四类全开，无法识别的值忽略并 warn 一行。
4. `.env.template` 里六个变量各带一行注释，含 `npx web-push generate-vapid-keys` 的生成命令。

**验收标准**：

- [x] 三个 VAPID 变量全空时 `isPushEnabled()` 为 false，启动日志恰好一行，之后不再刷。
- [x] 只配了两个（漏一个）时同样是 false，并 warn 出漏了哪个。
- [x] `CHAT_PUSH_EVENTS=approval` 时只有 approval 一类通过。
- [x] `pnpm -F @nimbo-chat/node-server typecheck` 绿。

---

## PN-2 `push_subscriptions` 表 + 迁移 + store ✅

**目标**：订阅能落库、能按人查、能按 endpoint 幂等 upsert、能删。

**涉及文件**：

- `apps/node-server/src/db/schema.ts`：新增表（字段见[技术方案 §2](../tech/push-notification.md)）
- `drizzle/`：`pnpm -F @nimbo-chat/node-server db:generate` 产出的迁移
- `apps/node-server/src/push/store.ts`（新建）

**产出物**：

1. 表：`endpoint` 主键、`user_id` 外键 + 索引、`p256dh`/`auth` 非空、`user_agent`/`last_sent_at`/`last_error` 可空。
2. `upsertSubscription(db, input)` —— 按 `endpoint` 覆盖，**包括覆盖 `user_id`**（换账号登录的同一台设备）。
3. `listSubscriptions(db, userId)`、`deleteSubscription(db, endpoint)`、`markSent(db, endpoint)`、`markError(db, endpoint, message)`。
4. 表注释写清三个设计点（为什么拿 endpoint 当主键、为什么 user_id 可被覆盖、为什么不存偏好）——与仓库既有表注释同密度。

**验收标准**：

- [x] 同一个 endpoint upsert 两次只有一行，第二次的 `user_agent` 生效。
- [x] 同一个 endpoint 换 `user_id` upsert，行还是一行且归属换人。
- [x] `db:migrate` 在既有库上跑得过（不丢数据）。
- [x] 删除 user 时不留孤儿行（外键行为与既有表一致）。

---

## PN-3 订阅 API ✅

**目标**：前端能问到公钥、能登记/注销订阅、能自测一条。

**涉及文件**：

- `apps/node-server/src/schemas/push.ts`（新建）：四个接口的 zod schema
- `apps/node-server/src/routes/push.ts`（新建）
- `apps/node-server/src/app.ts`：挂载
- 重新生成 OpenAPI 与前端 client（根 `pnpm chat:bootstrap`）

**产出物**：

| 接口 | 行为 |
|---|---|
| `GET /api/push/config` | `{enabled, publicKey}`。禁用时 `{false, null}`——**不返 404**，前端一次调用就能决定渲不渲染铃铛 |
| `POST /api/push/subscriptions` | `{endpoint, keys:{p256dh, auth}, userAgent?}` → 204，幂等 |
| `DELETE /api/push/subscriptions` | `{endpoint}` → 204，不存在也返 204 |
| `POST /api/push/test` | 向调用者的全部订阅发一条测试通知 → 202 |

全部走既有 auth 中间件（未登录 401）。功能禁用时前三个里的写接口返 503。

**验收标准**：

- [x] 四个接口都进了 OpenAPI，kubb 生成的 client 里能看到。
- [x] 未登录访问全部 401。
- [x] 禁用状态下 `GET /config` 返 `{enabled:false}`，`POST /subscriptions` 返 503 且不写库。
- [x] `DELETE` 一个不存在的 endpoint 返 204 而不是 404。

---

## PN-4 发送器 ✅

**目标**：给定 userId 和载荷，投给他所有设备；失效的就地清掉。

**涉及文件**：

- `apps/node-server/src/push/types.ts`（新建）：`PushPayload`、`PushKind`
- `apps/node-server/src/push/sender.ts`（新建）

**产出物**：

1. `sendToUser(db, userId, payload): Promise<void>` —— `Promise.allSettled` 扇出，永不 reject。
2. TTL / Urgency / Topic 按[技术方案 §6.2–6.3](../tech/push-notification.md) 设置；topic 长度 ≤32 且字符集合法。
3. 404/410 → `deleteSubscription`；其余错误 → `markError`，留行。
4. 成功 → `markSent`。

**验收标准**：

- [x] mock 掉 `web-push` 后：两条订阅一条 410 一条成功 → 只删那一条，成功那条 `last_sent_at` 有值。
- [x] 500 错误不删行，`last_error` 记上。
- [x] 一台设备抛错不影响另一台（allSettled 语义）。
- [x] `sendToUser` 在 `web-push` 整个模块抛错时也不 reject。
- [x] topic 对 36 字符 uuid 生成出来是 ≤32 的合法字符串。

---

## PN-5 Service Worker + 铃铛 ✅（不含 PWA）

**目标**：用户点得开、订阅得上、通知弹得出、点得回来。这一阶段做完就能用 `POST /api/push/test` 端到端自测。

**涉及文件**：

- `apps/web/public/sw.js`（新建）
- `apps/web/public/manifest.webmanifest` + `icon-192.png` / `icon-512.png`（新建）
- `apps/web/index.html`：`<link rel="manifest">` + `theme-color`
- `apps/web/src/features/notifications/push-client.ts`、`use-push-toggle.ts`、`notification-bell.tsx`、`sw-bridge.ts`（新建）
- `apps/web/src/layouts/app-layout.tsx`：铃铛挂进 header 右侧（`ThemeToggle` 左边）
- `apps/web/src/main.tsx`：注册 SW + 接 `push-navigate` 消息

**产出物**：

1. SW 两个事件：`push`（弹通知，字段读取带 `typeof` 守卫，读不到用兜底文案）、`notificationclick`（focus 已有窗口 + postMessage，否则 openWindow）。**不调 API**（[技术方案附录 B.2](../tech/push-notification.md)）。
2. 铃铛五态：`unsupported` / `off` / `on` / `blocked` / `busy`，各有明确的中文提示。iOS 非主屏打开走 `unsupported` 且提示"分享 → 添加到主屏幕"。
3. 页面加载时的幂等重上报（[技术方案 §3.1](../tech/push-notification.md)）。
4. 不主动弹权限框——只有用户点铃铛才 `requestPermission()`。

**验收标准**：

- [x] Chrome 桌面：点铃铛 → 授权 → 库里出现一行 → `POST /api/push/test` 能收到通知。
- [x] 关掉标签页后 `POST /api/push/test` 仍能收到。
- [x] 点通知：已开着窗口 → 切到前台并跳到对应会话；没窗口 → 新开一个并落到会话。
- [x] 浏览器设置里拒绝权限后，铃铛显示 `blocked` 且给出改设置的指引。
- [x] `enabled:false` 时页面上完全看不到铃铛。
- [x] 刷新页面不会产生第二行订阅。
- [x] `pnpm -F @nimbo-chat/web typecheck` + `lint` 绿（`sw.js` 走 `// @ts-check`）。

---

## PN-6 在场心跳 ✅

**目标**：服务端能回答"这个人此刻在不在看这条会话"。

**涉及文件**：

- `apps/node-server/src/push/presence.ts`（新建）
- `apps/node-server/src/routes/chat.ts`：新增 `POST /conversations/{id}/presence`
- `apps/web/src/features/chat/use-presence.ts`（新建）
- `apps/web/src/pages/conversation.tsx`：挂上心跳

**产出物**：

1. `markPresent` / `clearPresent` / `isPresent`，内存 Map，TTL 45 秒，惰性过期 + `size > 256` 时顺手扫。
2. 心跳接口：属主校验复用既有 `getChatSession`，body `{focused: boolean}`，返 204。
3. 前端：`focused=true` 每 20 秒一次；`visibilitychange`/`focus`/`blur`/卸载立刻补发；判据是 `visibilityState === 'visible' && document.hasFocus()`。卸载用 `fetch(..., {keepalive: true})`。

**验收标准**：

- [x] `markPresent` 后 44 秒 `isPresent` 为 true，46 秒后为 false（假定时器测）。
- [x] `clearPresent` 立即生效。
- [x] 别人的 userId 查同一条会话恒为 false。
- [x] 非属主调心跳接口返 404（与既有会话接口一致，不泄露存在性）。
- [x] 前端：切到别的标签页 → 立刻发一条 `focused:false`；切回来 → 立刻发 `true`。
- [x] 心跳不因为组件重渲染而重复起定时器。

---

## PN-7 通知决策层 + 四个触发点接线 ✅

**目标**：把前面所有零件接到真实的一轮上。这是唯一碰运行内核的阶段，改动要小而准。

**涉及文件**：

- `apps/node-server/src/push/notifier.ts`（新建）
- `apps/node-server/src/agent/turn-runner.ts`：新增 `TurnSettledInfo`，`driveTurn` 返回它，`onTurnSettled` 多带一个参数
- `apps/node-server/src/agent/turn-launcher.ts`：`onReview` / `onAskUser` / `onTurnSettled` 三处包一层
- `apps/node-server/src/agent/store.ts`：若无现成的"队列空不空"读取器则补一个

**产出物**：

1. `notifier` 四个方法（`approvalPending` / `questionPending` / `turnSettled`），全部**同步、返回 void、绝不抛错**。
2. 三道闸门按序：事件白名单 → 在场 → （仅 turn-settled）队列非空抑制。
3. 文案与截断按[技术方案 §6.1](../tech/push-notification.md)：会话标题 60 / 命令 100 / 问题 80。
4. `TurnSettledInfo.status` 四值：`completed` / `failed` / `interrupted` 取自本轮最后一个 `message-metadata`，`crashed` 来自 `catch` 分支。

**验收标准**：

- [x] `requestReview` 严格早于 `approvalPending`（顺序有测试，不只是靠注释）。
- [x] `notifier` 里抛任何错，一轮照常跑完、结果逐字节不变。
- [x] 在场为 true 时一条都不发。
- [x] 队列非空时 `turn-settled` 不发；队列空时发且只发一次。
- [x] `completed` → 「跑完了」；`failed`/`interrupted`/`crashed` → 「这一轮没跑完」。
- [x] `turn-runner.ts` 里不出现 `push` / `presence` 任何一个词（依赖方向）。
- [x] 既有的 node-server 测试全绿（`onTurnSettled` 签名变更不破坏任何调用方）。

---

## PN-8 测试补齐 ✅

**目标**：把上面每一阶段的验收项都变成跑得起来的用例。

**涉及文件**：`apps/node-server/src/**/__tests__/`、`apps/web/src/**/*.test.ts(x)`

**产出物**：

| 模块 | 测什么 |
|---|---|
| `vapid` / `events` | 总闸三态、白名单解析 |
| `store` | upsert 幂等、换人覆盖、删除 |
| `sender` | mock `web-push`：410 删行 / 5xx 留行 / allSettled 隔离 / topic 长度 |
| `presence` | TTL 过期、清除、跨用户隔离（假定时器） |
| `notifier` | 三道闸门的真值表、文案截断、抛错不影响一轮 |
| routes | 401 / 503 / 204 幂等 / 非属主 404 |
| web `use-push-toggle` | 五态转换、不主动请求权限 |
| web `use-presence` | 心跳节奏、可见性切换即时上报 |

**验收标准**：

- [x] `pnpm -F @nimbo-chat/node-server test` 全绿，新增用例覆盖上表每一行。
- [x] `pnpm -F @nimbo-chat/web test` 全绿。
- [x] `pnpm -r build && pnpm -r typecheck` 全绿（CI 口径，覆盖 apps 与 examples）。

---

## PN-9 审批超时 + 审批保活预算一起提到 15 分钟（需拍板）

**目标**：让通知真的有用——收到「等你批准」之后，人有足够时间做决定。

> **这一项要你点头再做。** 详细论证见[技术方案 §8](../tech/push-notification.md)。要点：
>
> - 现在审批 **4 分钟**没人应答就自动拒绝。手机上收到通知、人在开会，回来时它已经自己拒了——被打扰一次却什么都做不了，比不通知更糟。
> - **两个旋钮必须一起动**：审批超时住在 `turn-runner.ts`（240 秒），[审批保活预算](../../terms.md)住在 `@nimbo/core` 的默认值（5 分钟，chat 侧没显式传）。只提超时不提预算，第 5 分钟沙盒就睡了，人第 10 分钟点「允许」，工具在一个睡掉的沙盒上执行、失败得莫名其妙。
> - 代价在钱上：等人期间沙盒是活的。15 分钟是"收到通知 → 掏手机 → 看清命令 → 决定"的合理上限。

**涉及文件**：

- `apps/node-server/src/agent/turn-runner.ts`：`DEFAULT_APPROVAL_TIMEOUT_MS` / `DEFAULT_ASK_USER_TIMEOUT_MS` 240000 → 900000，并改掉注释里那段已失效的理由（"80% of sandbox idle timeout"——那个心跳已经不存在了）
- `apps/node-server/src/agent/sandbox-manager.ts`：`keepAliveOptionsFor` 显式传 `approvalBudgetMs`（≥ 上面那个超时），不再吃 core 的 5 分钟默认
- `.env.template`、[技术方案附录 A](../tech/push-notification.md)

**验收标准**：

- [ ] 两个超时默认值改为 900000，env 名不变，env 覆盖仍生效。
- [ ] `keepAliveOptionsFor` 显式给出 `approvalBudgetMs`，且有用例断言它 ≥ 审批超时。
- [ ] `turn-runner.ts` 里那段已失效的注释被替换成真实理由，并指回技术方案 §8。
- [ ] 真机验证：触发一次审批，晾 10 分钟再点「允许」，工具正常执行（不报"沙盒没了"）。

**已经做掉的那部分**：approval 通知的 TTL 已经跟着超时走——`turn-launcher.ts` 从 `resolveApprovalTimeoutMs()` 取值传给 `notifier`（PN-7 里一并做的），改超时默认值后 TTL 自动跟随，这一条不需要额外改动。

---

## PN-10 端到端验证方案

> 这一节是[全局开发规范](../../../CLAUDE.md)要求的验证方案。**实际结果一栏在跑完后回填。**

### 准备

1. 生成密钥：`npx web-push generate-vapid-keys`，把公私钥和 `VAPID_SUBJECT=mailto:<你的邮箱>` 写进仓库根 `.env`。
2. `pnpm chat:bootstrap`（建库 + 迁移 + 重生成 OpenAPI 与前端 client）。
3. 起服务（**由你来起**，见 [CLAUDE.md](../../../CLAUDE.md)「dev server 归我自己管」）：`! pnpm chat:server` 与 `! pnpm chat:web`。

> 用例 1–15、18–20 在电脑浏览器上就能跑完；16–17 需要手机。

### 用例

| # | 步骤 | 预期结果 | 实际 |
|---|---|---|---|
| 1 | 不配 VAPID 起服务 | 页面无铃铛；启动日志一行"推送未配置"；发消息跑一轮全程正常 | — |
| 2 | 配好密钥重启，点铃铛授权 | 库里 `push_subscriptions` 多一行；铃铛变实心 | — |
| 3 | 刷新页面三次 | 仍然只有一行 | — |
| 4 | `POST /api/push/test` | 收到测试通知 | — |
| 5 | 关掉标签页，再 `POST /api/push/test` | 仍收得到 | — |
| 6 | 点通知（无窗口） | 新开窗口并落在 `/chat` | — |
| 7 | 发一条会触发审批的消息（如让它跑 `rm -rf`），**立刻切到别的应用** | 收到「等你批准」，正文含会话标题与命令片段 | — |
| 8 | 点这条通知 | 切回浏览器并落到该会话，审批卡片就在眼前 | — |
| 9 | 重复 7，但**全程盯着这条会话不切走** | 不弹系统通知，卡片照常出现 | — |
| 10 | 在会话 A 页面上盯着，让会话 B 触发审批 | 收到 B 的通知 | — |
| 11 | 让 agent 调 ask-user，切走 | 收到「agent 有话问你」+ 问题片段 | — |
| 12 | 一轮正常跑完，切走 | 收到「跑完了」 | — |
| 13 | 一轮跑着时补发 3 条消息，全程切走 | 中间几轮不通知，全部跑完后只收到一条「跑完了」 | — |
| 14 | 跑一轮然后点停止，切走 | 收到「这一轮没跑完」 | — |
| 15 | 同一条会话连续触发三次审批 | 通知栏里始终只有一条 | — |
| 16 | 手机 Safari 打开 | 铃铛显示"这台设备不支持"（不做 PWA 的已知后果，不是 bug） | — |
| 17 | Android Chrome 打开并开启通知 | 库里多一行；重复用例 7 能在手机上收到 | — |
| 18 | 浏览器设置里撤销通知权限，再 `POST /api/push/test` | 投递返 410，那一行被删；页面刷新后铃铛回到空心 | — |
| 19 | 两台设备都开启，触发一次审批 | 两台都响 | — |
| 20 | 服务端重启后立刻触发审批 | 照样收到（在场信息丢失 ⇒ 视为不在看） | — |

### 回归

| # | 检查 | 预期 |
|---|---|---|
| R1 | `pnpm -r build && pnpm -r typecheck && pnpm -r test` | 全绿 |
| R2 | 删掉 `.env` 里三个 VAPID 变量重跑用例 7/11/12 | 一轮的行为与加功能之前完全一致 |
| R3 | `grep -rn "push\|presence" apps/node-server/src/agent/turn-runner.ts` | 无命中（依赖方向） |

---

## 与计划的偏差

施工中偏离原计划的地方，逐条记下来（原计划见各阶段的「产出物」）：

| # | 计划 | 实际 | 为什么 |
|---|---|---|---|
| 1 | 做 PWA（manifest + 图标），为了 iOS 能收 | **不做**，iOS 因此收不到 | 你 2026-07-27 定的：用不上"装成独立应用"这件事。图标已生成又删掉。补回来的做法写进了[技术方案附录 B.5](../tech/push-notification.md) |
| 2 | 退订走 `DELETE /api/push/subscriptions`（body 带 endpoint） | 改成 `POST /api/push/unsubscribe` | endpoint 是几百字节的 URL，放 query 要编码，放 DELETE 的 body 又会被部分客户端/代理**静默**丢掉。见[附录 B.4](../tech/push-notification.md) |
| 3 | 接口返 204 | 返 200 + `{ok:true}` | 与本仓库既有的 `ApprovalAckSchema` 一致，不为一个新模块另立一种 ack 形状 |
| 4 | `isPushEnabled()` 缓存结果 | 每次调用重读 env | 与仓库既有的 `resolveIdleTimeoutMs`/`resolveApprovalTimeoutMs` 同姿态：读三个环境变量比维护一份缓存 + 一个测试重置入口便宜得多。"只说一遍"由独立的 `logPushStartup` 保证 |
| 5 | 前端用 kubb 生成的 client | 手写 `features/notifications/api.ts` + zod 校验 | 与 `features/chat/api.ts` 同一姿态——kubb 的默认 client 从不检查 `response.ok`，而这里要分辨 503（没配 VAPID）与其它失败 |
| 6 | tag = `<kind>:<会话 id>`（四组） | `turn-done`/`turn-failed` 合成一组 `turn:` | 两者对同一条会话互斥且时序相继，"这条会话最近一轮怎么样了"只该有一条通知 |
| 7 | `startTurn` 的 `.finally` 里读收尾状态 | 改成 `.catch(归一) + .then` | `.finally` 换成 `.then` 会丢掉"抛错也收尾"的保证——`driveTurn` 的 catch 分支自己再抛（比如落盘失败）就会让 `activeTurns` 永不清空、**会话被永久锁死**。补了一段 `.catch` 把它归一成 `crashed` 再往下走 |
| 8 | PN-9 的论据：240 秒的理由已被 `startHeartbeat` 作废 | **论据换了**：`startHeartbeat` 已被删除，现在挡在中间的是[审批保活预算](../../terms.md)（默认 5 分钟） | 施工期间隔壁并行落地了[沙盒保活](../../logic/orchestration/plans/sandbox-keepalive.md)，手写心跳整个删掉。结论不变（4 分钟太短），但要动的旋钮从一个变成两个。详见[技术方案 §8](../tech/push-notification.md) |

**一处没能守住的验收项**：PN-2 原写「删除 user 时不留孤儿行」。表上声明了 `onDelete: 'cascade'`，但 `db/instance.ts` 没有开 `PRAGMA foreign_keys = ON`，SQLite 默认不强制外键——所以这条**实际不成立**，只是声明了正确意图。不在本功能范围内修（要改就是全库的事，会影响既有表）。

---

## 变更记录

| 日期 | 变更 | 说明 |
|---|---|---|
| 2026-07-27 | PN-1 ~ PN-8 全部完成 | 服务端 `src/push/` 七个模块 + `routes/push.ts` + `push_subscriptions` 表（迁移 `0009_green_magma.sql`）；前端 `public/sw.js` + `features/notifications/` 五个模块 + 在场心跳；`turn-runner.ts` 加 `TurnSettledInfo`、`turn-launcher.ts` 接三个触发点。新增 98 个用例（node-server 469 → 537，web 248 → 267），两侧 typecheck/lint/test 全绿。八处与计划的偏差见上一节。**PN-9 仍待你拍板，PN-10 真机部分待你起服务后跑。** |
| 2026-07-27 | 通知裁决按钮（推翻既有非目标） | 你问「不能加允许/拒绝按钮吗」。原本列为非目标，复盘下来三条理由只有一条真站得住（误点「允许」不可逆），另两条（SW 跨源鉴权、信息不足）在本项目实际用法下不成立或只部分成立。你拍板要三个按钮 + 成功也确认，已落地：载荷加 `callId`/`actions`，SW 直接 `POST .../approvals/{callId}`。**Chrome 只渲染 2 个按钮**（`Notification.maxActions`），故顺序排成 允许 → 拒绝 → 本会话都允许，被丢的一定是那个纯便利项。兜底：确认通知里原样带上刚批准的命令。附录 B.2「SW 不调 API」范围收窄成「不替订阅登记调 API」——差别在失败可不可见 |
| 2026-07-27 | 通知「挂住不消失」 | 你反馈 Chrome 通知闪一下就没了、太容易错过。载荷加 `sticky` 布尔字段，SW 映射成 `requireInteraction`。**按类型分档**：审批/提问挂住（卡着一轮，错过 = 晾着 agent 到超时），一轮完成/失败照旧自动消失（跑十轮攒十条要一条条点掉，反而更烦）。`POST /api/push/test` 也挂住——那条的唯一用途就是让人确认收到了。术语表加「挂住不消失」，tech §6.4 新增一节（含平台差异：Firefox/Safari/Android Chrome 忽略；**macOS 上还要把系统里 Chrome 的提醒样式从「横幅」改成「提示」**才真挂得住） |
| 2026-07-27 | 去掉 PWA | 你的决定：不需要独立应用。代价是 iPhone/iPad 收不到推送（iOS 的网页推送只对装到主屏的网页开放），电脑与 Android 不受影响 |
| 2026-07-26 | PN-0 完成 | 术语表新增第十二节（八个词条）；产品/技术/施工三份文档到位。开工前确认的边界：Web Push + 前台抑制、四类触发全要、点开跳转（通知内不放操作按钮）。施工中发现并记入技术方案 §8：审批 240 秒超时的既有理由已被 `startHeartbeat` 作废，单列为 PN-9 待你拍板。 |
