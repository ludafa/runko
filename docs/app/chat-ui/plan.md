# Chat 界面语言（施工进展）

> 相关：[产品文档](./feature.md) · [技术方案](./tech.md)

## 阶段划分

| 阶段 | 目标 | 涉及文件 | 依赖 |
|---|---|---|---|
| D0 | 设计工作台 | `routes/design.tsx`、`pages/design-preview.tsx`、`fixtures/design-preview-data.ts` | — |
| D1 | Token 层：色板 / 字体 / 圆角 / 动效开关 | `main.css`、`package.json` | D0（要能看效果） |
| D2 | 轨道与指令块：时间线主结构 | `rail.tsx`(新)、`message.tsx`、`message-entry.tsx` | D1 |
| D3 | 动作行：工具调用 / 推理 / 计划 / 文件改动 | `tool-call-card.tsx`、`reasoning-block.tsx`、`plan-checklist.tsx`、`file-change-badges.tsx` | D2 |
| D4 | 打断：审批 / 提问 / 失败 | `approval-card.tsx`、`question-card.tsx`、`turn-marker.tsx` | D2 |
| D5 | 结算行与统计弹窗 | `turn-stats-dialog.tsx`、`message-entry.tsx` | D3 |
| D6 | 外壳：顶栏 / 侧栏 / 会话头 / composer / 队列 / 空态 | `app-layout.tsx`、`chat-layout.tsx`、`conversation-list.tsx`、`conversation-status-badge.tsx`、`provider-badge.tsx`、`message-composer.tsx`、`queued-messages.tsx`、`conversation.tsx`、`chat.tsx`、`conversation.tsx`(组件) | D1 |
| D7 | 收口：typecheck / lint / test / 双主题与窄屏截图 / 文档回填 | 全部 | D2–D6 |
| D8 | **推翻重做**：自研界面语言 → ai-elements（sm 档密度） | `components/ai-elements/*`(新)、`components/ui/*`、`features/chat/components/*`、`main.css`、`eslint.config.js` | D7 |

## 状态

- [x] **D0 设计工作台** — `/design` 可访问，覆盖推理 / 正文 / 计划 / 五种工具状态 / 文件改动 / 审批 / 提问（待答+已答）/ 拒绝 / 轮失败 / 队列 / composer。截了改版前基线图。
- [x] **D1 Token 层** — 冷墨色板（浅/深）、信号琥珀三件套、`--rail`、`--ok`、`--radius: 0.375rem`、JetBrains Mono + Martian Mono 接入、`font-label` 工具类、reduced-motion 全局兜底。
- [x] **D2 轨道与指令块** — 新增 `rail.tsx`（`Rail` / `RailRow` / 5 种节点）；`message-entry.tsx` 的 assistant 分支套轨道、user 分支改指令块；`message.tsx` 去气泡。
- [x] **D3 动作行** — 工具卡片改单行（hover 满幅底、展开区左发丝线）；推理改轨道行；计划改 1px 方框勾选；文件改动改 `+/~/-` 路径行。
- [x] **D4 打断** — 审批 / 待答提问改打断形态（冲出轨道、上下信号色实线、琥珀底）；已答 / 已失效退回安静行；`TurnFailedBar` 改红色左实边条。
- [x] **D5 结算行** — 一轮末尾一道横线 + `第 N 轮 · 耗时 · 工具 · tok` 数字行 + `统计` 文字钮；弹窗排版跟随新 token。
- [x] **D6 外壳** — 顶栏改 `nimbo/chat` + 仓库名；侧栏新建表单折叠、行改状态点；会话头「分支为 H1」+ 点击复制；composer 底部键位按钮；队列条贴附 composer 上沿；空态文案改写。
- [x] **D7 收口** — typecheck / lint / test 全绿；浅色 + 深色 + 窄屏（720px）三组截图；本文件与产品/技术文档回填。
- [x] **D8 推翻重做** — 用户看过 D0–D7 的成品后否掉了这套自研视觉（「有点太丑了，风格我不是很能接受」），改用 ai-elements。手工从 registry 取件（CLI 在本机崩，见[技术方案 §2](./tech.md)）、做 radix→base-ui 适配、统一收 sm 档密度、色板与圆角回退到 shadcn 默认。

## 与计划的偏差

> D0–D7 是一版**未被采纳**的自研界面语言（轨道 / 打断 / 信号色）。用户看过成品后否掉了风格，D8 整体改建在 ai-elements 上。下面第 1–3 条是那一版留下的、**至今仍有效**的结论；第 4 条起是 D8 的。

1. **两处动了数据流的交互增量**（超出「只改呈现」的边界，见[技术方案 §5](./tech.md)）：插话的「待注入」乐观回显、待发消息的「插进本轮」。两者都是改版过程中暴露的反馈缺口——前者点了没反应，后者只能删了重发。**D8 保留**。
2. **`ChatShell` 没有单独拆出来**。`chat-layout.tsx` 的取数部分只有 12 行、呈现部分只有 10 行，拆开后调用侧反而多一层。**结论：不拆**。
3. **中文界面选 display 字体要先确认它有没有汉字**。D1 用 Martian Mono 排所有结构标签，实测中文掉到回退字体、再叠加为拉丁大写调的 0.12em 字距，排出来是松垮的「间 隔 字」。D8 已不用这个字体，但这条教训留着。
4. **ai-elements 的官方 CLI 与 shadcn CLI 在本机都跑不通**（`@modelcontextprotocol/sdk` 要 `zod/v4`、解析到 v3）。改为照 CLI 的逻辑手工从 registry 取件，见[技术方案 §2](./tech.md)。
5. **上游是按 radix 写的，本项目是 base-ui**（`components.json` 的 `base-vega` 风格）。`asChild`→`render`、`data-[state=open]`→`data-[open]`/`data-[panel-open]`、HoverCard 延迟 props 都要就地适配，见[技术方案 §3](./tech.md)。
6. **`src/components/ai-elements/**` 进了 eslint 的 ignores**，与 `src/gen/**` 同级——上游几处惯例（render 期读 ref、`any`、未使用解构参数）与本仓库规则冲突，逐个改会让下次重新 `add` 变成手工合并。类型安全仍由 tsc 覆盖。
7. **顺手修了上游两处真问题**：`shimmer.tsx` 在 render 里 `motion.create(...)`（每次渲染重建组件类型→子树重挂），`reasoning.tsx` 把 div props 透传给 `Streamdown` 导致类型冲突。

## 验收结论

### 自动化

| 项 | 命令 | 结果 |
|---|---|---|
| 类型 | `pnpm -C apps/web typecheck` | 通过 |
| Lint | `pnpm -C apps/web lint` | 通过（0 warning） |
| 单测 | `pnpm -C apps/web test` | 177 passed，用例数与改版前一致 |

**测试最终只改了 2 处断言**，都是真实的文案变化：

- 待发区标题：`待发送 · 2 条` → `2 条待发`（ai-elements 的 `QueueSectionLabel` 渲染成 `{count} {label}`）。
- 空态：`还没有消息` → `这条分支还没有指令`。

D0–D7 期间一度改了 7 处（把「待审批 / 待回答 / 已回答」等状态徽标去掉了），D8 用 ai-elements 重做时**把这些徽标加了回来**——它们本来就是用户要一眼看到的状态，去掉是当时那套「状态由结构承担」设计的连带损失。断言随之回到原样。这也是一个信号：**当改版让一批断言变红时，先问是不是删掉了不该删的东西**。

另有两处为可测性调整的实现，D8 保留：

1. 审批卡的 `$` 提示符是 `::before` 伪元素而非真节点——用户会复制这条命令，真节点会连提示符一起进剪贴板。
2. 「你的回答：X」不拆 `<span>` 上色——`getNodeText` 只看直接文本子节点，拆开后测试与屏幕阅读器读到的都是碎片。

**一处 flaky 暴露了真 bug**：插话回显的 `afterMessageCount` 原取 `messages.length` 快照，测试里随物化时机在 0/1 之间抖。顺着查下去发现的是实现问题——插话要等下一个 step 边界，这期间 agent 还在产出新消息，新消息 append 到快照锚点之后，这条「待注入」就被留在时间线中间越飘越上。改成恒定锚到末尾（`Number.MAX_SAFE_INTEGER`）后稳定。

### 人眼验收（对照[产品文档](./feature.md)「成功标准」）

1. **一屏信息量** — sm 档下「一段正文 + 计划 + 两个工具调用」在 1400×1050 一屏内完整可见。达成。
2. **对比度** — 浏览器实测（canvas 光栅化后按 WCAG 公式算，非估值），shadcn 默认色板：

   | 组合 | 浅色 | 深色 | 要求 |
   |---|---|---|---|
   | `foreground` / `background` | 19.80 | 18.97 | ≥ 4.5 |
   | `muted-foreground` / `background` | 4.74 | 7.66 | ≥ 4.5 |
   | `foreground` / `secondary`（用户气泡） | 18.01 | 14.27 | ≥ 4.5 |
   | `destructive` / `background` | 4.77 | 6.85 | ≥ 4.5 |

   全部达成 AA。
3. **键盘可达** — 工具卡片/计划/队列的触发器都是 `CollapsibleTrigger`（button），审批按钮、composer 均可 Tab，焦点环沿用 `--ring`。达成。
4. **reduced-motion** — `main.css` 里一条全局兜底覆盖所有组件（含 ai-elements 自带的 slide/fade 与 shimmer）。达成。
5. **窄屏** — 720px 下侧栏上移成一段列表、时间线在下，无横向溢出。达成（D7 验的，D8 布局同构未回归）。

### 已知遗留

- **组件是 vendored 的**：ai-elements 的更新不会自动流进来，要重新 `add` 并重做适配。
- **`prompt-input.tsx` 有 1400 行**，附件/语音/模型选择器等本应用完全不用但仍进 bundle，并连带装了 `cmdk`/`command`/`dropdown-menu`/`hover-card`。没裁剪是为了下次好对齐，体积成问题再说。
- **ask-user 没有官方组件**，只能用同一批基元自己拼；上游若出了对应组件应当换过去。
- **「插进本轮」是两个请求拼的**，服务端缺原子 promote 端点。失败已按「宁可丢也不重复执行 + 尽力补回队列 + 绝不静默」处理。
- **插话回显的悬挂窗口**：若一轮在 core 走到注入点前就结束、steer 被丢弃，那条「待注入」会留到下一条真实 user 消息把它 pop 掉。刷新即自愈。
- **登录 / 注册 / Notes 三页未动**（仍是 Fraunces 衬线大标题）。
- 只验了 Chrome 桌面两档主题 + 720px 窄屏。

## 变更记录

- 2026-07-25（上午）：D0–D7，自研界面语言落地（轨道 / 打断 / 信号色）。真机验收修掉两处：轨道按消息画导致逐步断线、插话点了没有任何反馈。
- 2026-07-25（下午）：**D8 推翻重做**。用户否掉自研视觉，改建在 ai-elements 上并统一收 sm 档密度；色板与圆角回退 shadcn 默认。`rail.tsx`/`interruption.tsx` 删除，术语表相应词条标记退役。
