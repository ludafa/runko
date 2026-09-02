---
title: "Chat 界面语言（技术方案）"
slug: chat-ui
view: 技术
layer: 接入层
module: —
packages: ["@runko-chat/web"]
tags: ["界面语言", "ai-elements", "shadcn", "密度"]
related: ["ingress/features/chat-ui.md", "ingress/plans/chat-ui.md", "architecture/tech/agent-kernel.md"]
---
# Chat 界面语言（技术方案）

> 相关：[产品文档](../features/chat-ui.md) · [施工进展](../plans/chat-ui.md) · [chat 应用技术方案](./chat-webapp.md)
> 术语见 [docs/terms.md](../../terms.md)。本文只讲**呈现层**：数据流、SSE、[账本](../../terms.md)物化基本不动（唯二例外见 §5）。

## 1. 改动边界

只动 `apps/web`：

```
src/components/ai-elements/*      ← 从 registry 取来的第三方组件（新增）
src/components/ui/*               ← 补齐 ai-elements 依赖的 shadcn 基元（新增几个）
src/features/chat/components/*    ← 改成 ai-elements 的薄封装
src/layouts/*、src/pages/*        ← 外壳与装配
```

**不动**：`api.ts`、`sse.ts`、`materialize.ts`、`timeline.ts`、`schema.ts`、`src/gen/**`、`apps/node-server/**`。组件的 props 契约、`data-testid`、可访问名尽量保持不变。

## 2. 取件：CLI 坏了，照它的逻辑手工取

官方两条路子在本机都跑不通：

```
npx ai-elements@latest add …
npx shadcn@latest add https://registry.ai-sdk.dev/….json
```

都在 `@modelcontextprotocol/sdk` 处崩：它 `import "zod/v4"`，而 dlx 环境里解析到的是 zod v3（`ERR_PACKAGE_PATH_NOT_EXPORTED`）。本地装的 `shadcn@4.6.0` 同样崩。

registry 本身是好的（`https://registry.ai-sdk.dev/<name>.json` 与 `https://ui.shadcn.com/r/styles/base-vega/<name>.json` 都 200），所以照 CLI 的逻辑手工取件：拉 registry item → 递归取 `registryDependencies` → 把 `@/registry/default/...`（ai-elements）与 `@/registry/base-vega/...`（shadcn）重写成本项目的别名 → 落盘。脚本留在 scratchpad，不进仓库——这是一次性动作，下次 CLI 修好了就该用 CLI。

取来的组件：`conversation` `message` `tool` `reasoning` `confirmation` `prompt-input` `queue` `task`（连带 `code-block` `shimmer`）；补齐的 shadcn 基元：`tooltip` `button-group` `input-group` `command` `dropdown-menu` `hover-card` `textarea`。新增 npm 依赖：`@radix-ui/react-use-controllable-state` `motion` `nanoid` `shiki` `cmdk`。

## 3. 落地要改的四类东西

ai-elements 的官方产物是**按 radix 版 shadcn 写的**，而本项目的 `components.json` 是 `base-vega` 风格（**base-ui**，见现有 `ui/collapsible.tsx` 用 `@base-ui/react`）。落到本项目要就地适配：

| 类别 | 上游写法 | 本项目写法 |
|---|---|---|
| 组合 | `<Trigger asChild><X/></Trigger>` | `<Trigger render={<X/>} />` |
| 折叠态选择器 | `data-[state=open]` / `group-data-[state=open]` | `data-[open]` / `group-data-[panel-open]` |
| HoverCard 延迟 | `openDelay` / `closeDelay` | base-ui 的 `PreviewCard` 没有同名 props——本应用不用附件预览，直接透传 |
| 版本抑制 | `// @ts-expect-error state only available in AI SDK v6` | 本仓库的 `ai` 已是 v6，这些抑制变成「未使用的抑制」，删掉 |

另外两处不是移植问题、是上游本身的毛病，顺手修了：

- `shimmer.tsx` 在 render 里直接 `motion.create(...)`——每次渲染造一个新组件类型，React 会把子树卸载重挂。改成 `useMemo` 按 `Component` 缓存。
- `reasoning.tsx` 把 `CollapsibleContent` 的全部 div props 透传给 `Streamdown`，`dir` 的字面量联合更窄，类型对不上。只传 `children`。

### lint 边界

`src/components/ai-elements/**` 进 eslint 的 `ignores`，与 `src/gen/**` 同级——它用了几处本仓库规则不允许的上游惯例（render 期读 ref、`any`、未使用的解构参数），逐个改会让下次重新 `add` 变成一场手工合并。**类型安全仍由 tsc 覆盖**，不受影响。

## 4. 密度调校（sm 档）

改在**组件本体**里，每个被改的文件顶部有一段同样的注释说明为什么、改了哪些值，升级组件时对着它重做：

| 文件 | 改动 |
|---|---|
| `conversation.tsx` | `gap-8 p-4` → `gap-4 p-3`；scroll 按钮 `bottom-4` → `bottom-3` |
| `message.tsx` | 消息内 `gap-2` → `gap-1.5`；用户气泡 `px-4 py-3` → `px-3 py-2`；**assistant 侧加 `w-full`** |
| `tool.tsx` | 卡片 `mb-4` → `mb-2`；头 `p-3` → `px-2.5 py-2`；参数/结果区 `p-4` → `px-2.5 pb-2.5` |
| `reasoning.tsx` | 内容 `mt-4` → `mt-2` |
| `task.tsx` | 内容 `mt-4 space-y-2 pl-4` → `mt-2 space-y-1 pl-3` |
| `queue.tsx` | 分区头 `px-3 py-2 text-sm` → `px-2.5 py-1.5 text-xs` |
| `prompt-input.tsx` | textarea `min-h-16` → `min-h-10` |

`w-full` 那条不只是密度：assistant 侧装的是工具卡片/审批/计划这类**块级**内容，`w-fit` 会让每张卡片宽度各不相同，读起来像一堆没对齐的碎片。

`task.tsx` 另加了一个 `icon?: ReactNode` prop——默认图标是放大镜（官方按「搜索任务」设计），但这里还用它装「计划」「文件改动」，放大镜语义不对。

## 5. 两处确实动了数据流的交互增量

**(a) 插话的乐观回显。** 原先 steer 走的是「不做乐观 echo」：消息要等 core 在真实注入点产出 chunk 才出现。而真实注入点是**下一个 step 边界**——当前工具跑得久就可能几十秒，在那之前界面上什么都不发生，用户会以为按钮没生效。现在 `sendMessage` 的 steer 分支复用既有的 `pendingUserEchoes` 机制推一条 `steered: true` 的回显，画成压暗的「插话 · 待注入」；真实 user 消息落账本时由 `MessageLedger` 的 `onUserMessage` FIFO pop 顶替。POST 失败即刻撤回。

锚点用 `Number.MAX_SAFE_INTEGER` 而不是 `messages.length` 快照（`buildRenderEntries` 会把越界锚点夹到末尾）：插话等待期间 agent 还在产出新消息，快照锚点会让这条「待注入」被留在时间线中间越飘越上。

> 已知边界：若这一轮在 core 走到注入点之前就结束、steer 被丢弃，这条回显会一直留到下一条真实 user 消息把它 pop 掉。刷新即自愈。

**(b) 待发消息「插进本轮」。** 服务端**没有**原子端点（队列端点只会删，`POST .../messages` 只会新增），所以连发两个请求，顺序刻意选成**先出队、再 steer**：

- 反过来（先 steer 再出队）一旦出队那步失败，这条消息会在本轮结束后**再执行一次**——重复执行一条可能带副作用的指令，比丢失难收拾得多。
- 这个顺序的坏情况是「出了队却没插进去」，且可恢复：`promoteQueuedMessage` 尽力把它按原样排回队列；连补回都失败时把原文放进错误提示里让用户复制重发。任何一档都不静默吞掉。

一个原子端点（`POST .../queue/{id}/promote`）能把这两个失败窗口一并消掉，留作后续。

**(c) 满宽外壳 + 可收侧栏（shadcn `Sidebar`）。**

`ChatLayout` 从 `grid md:grid-cols-[220px_minmax(0,1fr)]` 换成 `SidebarProvider` / `Sidebar` / `SidebarInset`，`AppLayout` 的 `mx-auto max-w-6xl px-6 py-10` 一并拆掉。三处要点：

- **宽度约束下放给页面，不是一刀切删掉。** 同一个壳既装聊天页（工作台，要满宽）又装 Notes（读文档，满宽长行难读），所以 `AppLayout` 只留 `px`，`DashboardPage` 自己包回 `mx-auto max-w-6xl`。
- **Sidebar 要「就地化」才能装进 main。** 组件默认假设自己是整页布局：wrapper `min-h-svh`、侧栏本体 `fixed inset-y-0 h-svh`。直接用会让侧栏顶到视口顶端、被 header 盖掉标题和「新会话」（实测如此）。改法是 wrapper 加 `relative` 提供定位上下文 + `!min-h-full` 吃 main 给的确定高度，侧栏本体 `absolute h-full` 覆盖 `fixed h-svh`。**不能让 provider 自己撑一屏**——那会顶出第二条滚动条，正是 `app-layout.tsx` 注释里记的「双滚动条」旧账。
- **收起模式选 `offcanvas` 而非 `icon`。** `icon` 档把侧栏压成 3rem 图标条，但它是为 `SidebarMenu` + 图标设计的；我们的会话列表是纯文字（标题 + 分支名），压到 48px 后标题只剩一个字竖排。会话也没有天然图标可用——状态点辨识度太低。`offcanvas` 整条滑出，收起后会话区真正占满，也更贴合「让出这 220px 读长 diff」的动机。

**把手放进全局 header，不留在内容区。** 先试过把 `SidebarTrigger` 与会话区并排（同一 flex row），三行是压成了一行，但把手夹在侧栏与会话区的缝隙里两边都不属——`BranchHeader` 的 `border-b` 从它右边才开始，读起来像块飞来的浮标。现在 portal 进 `AppLayout` 的 header 左端（紧邻 logo）：header 本就是全局控件区，把手在那儿有归属，且**展开/收起时位置恒定**（留在内容区的话会跟着侧栏边缘位移，肌肉记忆失效）。

实现是 header 留一个槽位 + context 下发 DOM 节点，页面用 `createPortal` 往里放：

- **为什么 portal 而不是把 `SidebarProvider` 提到 `AppLayout`**：侧栏在语义上属于聊天页，Notes 那类页面不该被塞一个空 provider（还会白占 `⌘B`）。React 的 portal 保留 React 树，所以 portal 出去的 `SidebarTrigger` 照样拿得到 `ChatLayout` 里的 sidebar context。
- **槽位 DOM 用 `ref` 回调 + context 下发，不用 `getElementById` + effect**：回调在 DOM 挂载时同步触发，没有「首帧空一下」，也不触发 `react-hooks/set-state-in-effect`（effect 里 `setState` 会被 lint 拦）。
- **槽位与 logo 要包成同一组**：header 是 `justify-between`，槽位单列会变成第四段、把 logo 挤到中间。

收起状态由组件自己写 cookie（`sidebar_state`）持久化，`⌘B`/`Ctrl+B` 是内置快捷键，两者都不用我们接。`/design` 工作台同步换成同一套外壳——它的用途是「对着它迭代」，布局不同步就照不出真实页面。

测试环境要补 `matchMedia`（`src/test/setup.ts`）：jsdom 不实现它（属 CSSOM View），而 `useIsMobile` 用它订阅断点，缺了整个 `ChatLayout` 一挂载就抛。stub 恒答不匹配 = 桌面档，正是用例断言的那档（移动端侧栏走 `Sheet`，另一条分支，本套件不覆盖）。

**(d) 建会话：弹窗表单 + 乐观切换 + 失败可见。**

新建入口从侧栏内嵌 `<form>` 换成 `Dialog`（base-ui，用法同 `turn-stats-dialog.tsx`：`DialogTrigger` 的 `render` prop 包 `Button`）。动机是宽度——侧栏固定 220px，内嵌表单里输入框只能压到 `h-7 text-xs`、provider 挤成一条 segmented control、还放不下任何说明文字。弹窗不受这个约束，控件回到默认尺寸，provider 改成两张带说明的卡片。**提交即 `setOpen(false)`**：等待反馈在会话区的 `ProvisioningView`，弹窗继续占着屏幕中央只会挡住它。建会话期间 trigger 置灰，避免第二次点击顶掉正在进行的 `pending`。
 `ChatLayout` 的 `creating: boolean` 换成一份完整的 `PendingCreate`（title / provider / startedAt）：点击当帧就 `setPending`，会话区改渲染 `ProvisioningView` 顶掉 `children`，不等 `POST /api/chat/conversations` 的 201。`startedAt` 是必需的——等待反馈要显示已耗时，而这个时刻只有点击那一刻知道。

失败路径此前**根本不存在**：`handleCreate` 只有 `try/finally`，`createConversation` 抛错时 `finally` 把 `creating` 置回 false、错误被吞，界面回到点击前的样子。现在 `catch` 落成 `failed: { input, message }`，渲染 `ProvisioningError`；`input` 原样留着，「重试」用同一份输入重发（只换 `startedAt`）。

- **URL 不提前跳。** 会话 id 由服务端生成，不等 201 拿不到；要让 URL 立刻变就得引入 `/chat/new` 假路由或改后端让前端生成 id。假路由有真实副作用：刷新后前端状态没了、后端还在建盒 → 孤儿沙盒，且浏览器后退会落到一个无意义的 URL。所以选「**内容区就地进入准备态、URL 就绪时才变**」——观感上等同跳转，没有这些副作用。
- **阶段是估的，不是推的。** 服务端是一个同步请求，没有阶段事件可推。阶段时间点取自 E2B 真机实测（建盒 1.4s / clone 2.1s / 装 skill 3.3s / 配置 + 建分支 2.2s），最后一阶段**不自动完成**——停在那儿直到请求返回，超过 20 秒明说「比平时久」。刻意不画百分比进度条：假精度比没有进度更伤信任。真进度要等服务端把建盒拆成异步 + SSE 阶段事件（会话行先落库为 `provisioning` 态），那是另一个功能，不在本次范围。
- **计时靠 `key` 重挂，不在 effect 里同步 setState。** `ProvisioningView` 的 `useElapsedMs` 用 lazy initializer 取初值、effect 只起 interval；重试时 `startedAt` 变化由调用方 `key={pending.startedAt}` 触发重挂拿到新初值。在 effect 里补一次 `setElapsedMs` 会多一轮级联渲染（`react-hooks/set-state-in-effect` 会报），且重试瞬间闪一下上一次的秒数。

**(e) 会话详情弹窗的「统计」tab：数据源选账本 metadata，不选遥测。** 会话级用量有两条可能的来源——遥测端点（逐次模型调用的明细，可按 turn 聚合）与账本 metadata（每条 assistant 消息的 `usage / durationMs / toolDurationMs`）。选后者：

- **遥测是可关闭、可清空的耗材**（docs/ingress/tech/telemetry.md），聚合它意味着「关了遥测，会话统计就空了」——而「这个会话花了多少」属于产品数据，不该随可选的观测设施一起消失。
- **账本随直播流免费到达且永久保存**，弹窗打开时现算即可，零请求。单轮那枚「统计」的概览也正是这么来的，两处同源、数字必然对得上。

汇总里两处容易写错的：**失败轮的耗时与 token 照样计入**（token 是真花掉的，不能因为这轮没成就当没发生），只把「失败几轮」单独标出来；**`undefined` 与 `0` 要分开**——旧记录不带 `durationMs`，那一行应整行不显示，而不是显示 `0ms`（`addOptional` 的语义：全程没值就保持 `undefined`）。

`src/hooks/use-mobile.ts` 进 eslint `ignores`（与 `ai-elements/**` 同理）：`shadcn add sidebar` 带进来、本仓库一行没改，而它在 effect 里 `setState` 订阅 `matchMedia` 恰是这个 hook 的全部职责。`src/components/ui/**` 不整体忽略——那里的文件带着本仓库的密度调校，仍需受检。

本功能不涉及 DB，无实体关系图。

### 打断/审批的呈现流程

```mermaid
sequenceDiagram
  participant Loop as core loop
  participant SSE as 直播流
  participant Hook as useChatMessages
  participant Entry as MessageEntry
  participant UI as Confirmation / Tool

  Loop->>SSE: tool-approval-request（耐久 chunk）
  SSE->>Hook: 折叠出 state=approval-requested 的工具部件
  Hook->>Entry: messages 更新
  Entry->>UI: 该 part 渲染为 Confirmation（带三值按钮）
  UI-->>Hook: 用户点「允许」→ submitApproval(callId, behavior)
  Hook->>Entry: submittingCallIds 含该 callId → 按钮转 spinner
  Loop->>SSE: tool-approval-response → 部件转 approval-responded
  SSE->>Hook: messages 更新
  Hook->>Entry: 同一 part 不再是 approval-requested
  Entry->>UI: 改派 ToolCallCard（安静的折叠卡片）
```

数据流上没有新增分支——**审批只是同一个 part 在某个 state 下的另一种画法**。

## 6. 设计工作台（`/design`）

- `routes/design.tsx`：`beforeLoad` 里 `if (!import.meta.env.DEV) throw notFound()`——生产构建下 404。
- `fixtures/design-preview-data.ts`：手写的 `RunkoUIMessage[]`，时间戳锚在**固定常量** `T0`（不能用 `Date.now()`，否则两次截图的耗时不一样）。其中特意留了一条只有单个部件的 assistant 消息——真实会话里一轮 = 很多条消息（一步一条），fixture 若不还原这个粒度，就验不出跨消息的排版问题。
- `pages/design-preview.tsx`：直接装配展示组件，**不经** `ConversationPage`（那条路径要登录态与真沙盒）。

## 7. 取舍与已知限制

1. **组件是 vendored 的**：ai-elements 的更新不会自动流进来，要重新 `add` 并重做 §3/§4 的适配。代价换来的是「不再自己抄一遍再改」。
2. **`prompt-input.tsx` 有 1400 行**，其中附件、语音输入、模型选择器等本应用完全不用，但仍进 bundle。为此还连带装了 `cmdk`/`command`/`dropdown-menu`/`hover-card`。没有裁剪，是因为裁剪会让下次重新 `add` 更难对齐——先留着，体积成了问题再说。
3. **ask-user 没有对应的官方组件**，只能自己拼；若上游将来出了「向用户提问」的组件，这块应当换过去。
4. **`/design` 的组件仍进生产 bundle**，只做了路由守卫。
