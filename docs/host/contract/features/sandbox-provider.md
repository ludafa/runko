---
title: "沙盒 provider 可选（产品视角 · 使用手册）"
slug: sandbox-provider
view: 功能
layer: 宿主层
module: 沙盒
packages: ["@runko/sandbox-e2b", "@runko/sandbox-vercel"]
tags: ["沙盒 provider", "可选沙盒", "重连令牌", "休眠唤醒"]
related: ["host/contract/plans/sandbox-provider.md", "host/contract/tech/sandbox-provider.md", "architecture/tech/agent-kernel.md"]
---
# 沙盒 provider 可选（产品视角 · 使用手册）

> 相关：[技术方案](../tech/sandbox-provider.md) · [施工进展](../plans/sandbox-provider.md)
> 依赖 / 增强：[chat-webapp](../../../ingress/features/chat-webapp.md)（把它固定用 Vercel 沙盒的假设放开成可选）· [sandbox](./sandbox.md)（`@runko/sandbox-vercel` / `@runko/sandbox-e2b` 两个[沙盒适配器](../../../terms.md)）
> 术语：[沙盒 provider](../../../terms.md) · [沙盒](../../../terms.md) · [重连令牌](../../../terms.md) · [休眠 / 唤醒](../../../terms.md) · [conversation（会话）](../../../terms.md)

## 一句话

让用户在 chat 应用里**新建会话时自己选**这次对话跑在哪家云[沙盒](../../../terms.md)上——[Vercel Sandbox](../../../terms.md) 或 [E2B](https://e2b.dev)——server 端据此接对应的[沙盒适配器](../../../terms.md)与生命周期实现，两家在用户眼里体验一致（都能[休眠/唤醒](../../../terms.md)、都能改代码开 PR）。

## 这个功能给谁、解决什么问题

- **给谁**：chat 应用的使用者；以及想对比/切换云沙盒供应商的开发者。
- **解决什么**：现状 chat 应用的沙盒**写死 Vercel**（`chat-webapp` §2.2 `sandbox-manager.ts` 全模块只碰 `@vercel/sandbox`）。E2B 适配器包（`@runko/sandbox-e2b`）早已就绪但从未接进应用。本功能把「用哪家沙盒」从写死变成**每会话可选**，让用户按额度、地域、偏好自行决定，且不牺牲既有的休眠/唤醒、代码跨轮累积体验。

## 用户可见行为与交互

1. **新建会话时多一个「沙盒」选择**：新建 [conversation（会话）](../../../terms.md)的入口，除标题外多一个 provider 选择（Vercel / E2B，默认取全局配置项）。选定后本会话固定用这家沙盒，[与会话 1:1 绑定](../../../terms.md)、运行中不切换。
2. **建会话流程对两家一致**：无论选哪家，服务端都为会话开一个沙盒、clone 好全局配置的 `GITHUB_REPO`、装好 `frontend-design` [skill](../../../terms.md)、建一条会话专属分支。此后多轮改动在同一分支累积。
   - 差别只在**幕后**：Vercel 建盒时一步 clone；E2B 建盒后补一条 `git clone`（用户无感，仅首建时多几秒）。
3. **休眠/唤醒对两家都成立**：会话空闲达阈值后沙盒[休眠](../../../terms.md)（省额度），用户回来发消息自动[唤醒](../../../terms.md)、**分支代码原样还原（含未提交改动）**。E2B 侧靠沙盒的 `pause`/自动 resume 达成，与 Vercel 平台快照等价（已真机验证账户支持，见[技术方案](../tech/sandbox-provider.md) §5）。
4. **会话列表/详情显示 provider 徽标**：每个会话卡片标出它用的是 Vercel 还是 E2B，让用户一眼看清这次对话跑在哪。

## 对外 API（产品视角）

在既有 [chat-webapp API](../../../ingress/features/chat-webapp.md) 上的**增量**（非破坏）：

| 端点 | 变化 |
|---|---|
| `POST /api/chat/conversations` | 请求体新增可选 `provider: "vercel" \| "e2b"`；缺省时用服务端默认（`SANDBOX_PROVIDER`，未配则 `vercel`）。返回的会话详情带上 `provider`。 |
| `GET /api/chat/conversations` / `GET /api/chat/conversations/{id}` | 会话 DTO 新增 `provider` 字段，供前端渲染徽标。 |

> 兼容性：不带 `provider` 的旧客户端请求行为不变（落到默认 provider）；存量会话读出来 `provider` 为其建会话时落库的值（迁移默认回填 `vercel`）。

## 范围与非目标

- **只做 provider 可选**：目标仓库仍走全局 `GITHUB_REPO`/`GITHUB_PAT`（本次不做「仓库也用户可选」，见[施工进展](../plans/sandbox-provider.md)变更记录里的范围决策）。
- **非目标：运行中切换 provider**。会话与沙盒 1:1 绑定，provider 选定即固定；想换就新建会话。
- **非目标：Cloudflare（[网关形态](../../../terms.md)）接入**。`@runko/sandbox-cloudflare` 是网关形态、接入路径不同，不在本次范围。
- **非目标：为 provider 做用户级默认设置页**。默认取服务端 env，新建会话时可临时覆盖即可。

## 成功标准

1. **E2B 全链路**：选 E2B 建会话 → E2B 真盒起来（clone 成功、skill 装上、分支建好）→ 发只读消息验流式+落库 → 静置触发休眠 → 再发消息验唤醒 + 分支代码原样还原 →（可选）一条设计任务走完开 PR。
2. **Vercel 回归**：选 Vercel（或不传 provider）的路径与本功能上线前**逐字一致**，无行为回退。
3. **前端**：新建会话能选 provider；会话列表/详情正确显示 provider 徽标。

## 已知取舍与限制（用户可感知的）

1. **E2B 需要 `E2B_API_KEY`**：选 E2B 的会话要求服务端配了 `E2B_API_KEY`（原先只有 examples/09 用它，现在 chat 应用选 E2B 时也用）。未配又选 E2B → 建会话报配置错误（500，文案指明缺哪个 env）。
2. **E2B 首建比 Vercel 略慢**：多一步建盒后 `git clone`（小仓库实测约数秒）；唤醒（resume）两家都在亚秒级。
3. **休眠丢未提交工作的兜底档同样存在**：两家的唤醒都优先走快照/resume（含未提交改动）；快照过期/沙盒被回收则重 clone + checkout 已 push 分支，这一档下未提交工作会丢失——与 [chat-webapp 已知取舍](../../../ingress/features/chat-webapp.md)同源，[turn-checkpoint](../../../logic/orchestration/features/turn-checkpoint.md) 拟补掉这个窗口。
