---
title: "composer 里手动指定 skill（使用手册）"
slug: composer-skill-mention
view: 功能
layer: 接入层
module: —
packages: ["@runko-chat/web", "@runko/core"]
tags: ["composer", "skill 提及", "渐进式披露"]
related: ["ingress/plans/composer-skill-mention.md", "ingress/tech/composer-skill-mention.md", "architecture/tech/agent-kernel.md"]
---
# composer 里手动指定 skill（使用手册）

> 相关：[技术方案](../tech/composer-skill-mention.md)，[施工进展](../plans/composer-skill-mention.md)。
> 依赖/延续：[chat 聊天 webapp](./chat-webapp.md)（消息发送通路、[composer](../../terms.md)所在位置）· [chat 界面语言](./chat-ui.md)（composer 现在是 ai-elements 的 `PromptInput`，本功能换掉它的输入区）· [核心 SDK](../../logic/engine/features/core-sdk.md)（[skill](../../terms.md) 与[渐进式披露](../../terms.md)的定义在这里）。

这一份是**产品/使用视角**：解决什么问题、用户看得到什么行为、边界在哪。内部实现看 [技术方案](../tech/composer-skill-mention.md)。

## 0. 一句话

在 [composer](../../terms.md) 里打一个 `/`，弹出这个[会话](../../terms.md)当前可用的 [skill](../../terms.md) 清单，选一个就插进消息里成为一枚不可拆的标记（[skill 提及](../../terms.md)）——用来告诉 agent「这件事请按这个 skill 来做」，不用再在正文里写「记得用 frontend-design 那套规范」。

## 1. 要解决的问题

现状（本功能之前）有三个环环相扣的问题：

1. **用户根本不知道有哪些 skill 可用。** skill 的清单只出现在给模型看的 system prompt 里（`<available_skills>` 段），界面上一个字都没有。用户想用也不知道该叫什么名字。
2. **用不用完全由模型决定。** [渐进式披露](../../terms.md)的设计是「模型觉得需要才调 `load-skill` 读全文」。好处是省 token，代价是用户没有话语权——想让它按 frontend-design 的规范改界面，只能在正文里用自然语言求它，它听不听看心情。
3. **实际上只有一个 skill 能用。** 服务端每轮只加载写死的那一个（`frontend-design`）。哪怕用户自己往仓库里放了别的 skill，agent 也看不见。

## 2. 用户看得到什么

### 2.1 打 `/` 唤出清单

在 composer 里输入 `/`（行首或空格之后都行），正上方弹出一个清单：

- 每行一个 skill：**名字**（粗体）+ 一句话说明（灰色，取自 SKILL.md 的 `description`）。
- 继续打字即模糊筛选（`/front` → 只剩 `frontend-design`）。
- **↑ / ↓** 移动选中项，**Enter** 或**鼠标点击**确认，**Esc** 或删掉那个 `/` 关闭。
- 没有任何 skill 匹配时清单自动收起，`/` 就是个普通斜杠——不挡住「用户只是想打个路径」的正常输入。

### 2.2 选中后：一枚标记块

确认后，`/` 连同已经打的筛选词一起被替换成一枚**标记块**（chip）：浅色圆角背景，显示 `/frontend-design`。

它的行为是「一个整体」，不是几个字符：

- 光标走到它旁边按一次 **Backspace**，整枚一起删掉，不会剩下 `/frontend-desig` 这种半截。
- 鼠标拖选、复制粘贴时它整体跟着走。
- 一条消息里可以插多枚（比如同时指定两个 skill），也可以插在正文中间。

### 2.3 发出去之后

发送键、Enter（[排队](../../terms.md)）、⌥⏎（[中途插话](../../terms.md)）、流式期间的停止键——**全部和以前一模一样**，本功能没有改动任何一条发送路径的语义。

消息发出后，标记块在时间线上显示为普通文本 `/frontend-design`（用户消息本来就是纯文本渲染）。

agent 那边收到的是：你的原话，**外加一句明确的指令**告诉它「用户点名了这个 skill，请先 `load-skill` 加载再动手」。所以：

- **它会去读那个 skill 的全文**，而不是凭 `<available_skills>` 里那一行描述猜。
- 但这仍然是**提示，不是强制**——skill 加载进去的是「指引」，不是「开关」。模型读完之后怎么用它，仍由模型判断（这是 [skill](../../terms.md) 这个机制本身的性质，见 [渐进式披露](../../terms.md)）。如果你要的是「必须逐条照做」，请在正文里把要求写清楚，别只丢一枚标记。

### 2.4 清单从哪来

清单 = **这个会话的沙盒里 `.agents/skills/` 目录下实际装着的 skill**。

- 会话创建时服务端会往那儿装 `frontend-design`（本功能之前就有的行为），所以任何新会话至少有它一个。
- 你在这个会话里让 agent 自己往 `.agents/skills/` 装了别的 skill（或者你的仓库本来就带），**下一轮开始**就会出现在清单里——清单在每轮起轮时刷新一次。
- 沙盒[休眠](../../terms.md)时清单照常能开（读的是服务端存下来的上一次扫描结果），不会为了列个菜单去唤醒沙盒、让你干等几十秒。

### 2.5 输入框本身的变化

输入区从原来的 `<textarea>` 换成了富文本编辑器（tiptap）。除了多出标记块，**其余打字体验保持纯文本**：

- 没有加粗、斜体、标题、列表这些格式，粘贴带格式的内容一律落成纯文本。
- Shift+Enter 换行、Enter 发送、⌥⏎ 插话，与以前一致。
- 唯一的例外：**清单开着的时候**，↑↓ 和 Enter 归清单用（选 skill），不再是「移动光标 / 发送消息」。关掉清单就恢复。

## 3. 范围与非目标

**范围内：**

- `/` 触发的 skill 选择清单与标记块。
- 服务端加载沙盒里**全部** skill（不再只有写死的一个），并把清单送到前端。
- 起轮时把「用户点名了哪些 skill」翻译成给模型的明确指令。

**非目标（这次不做）：**

- **不做强制注入。** 选中的 skill 不会被直接塞进模型上下文，仍走 `load-skill`（本功能选定的路线，见技术方案 §2 的取舍）。
- **不做 skill 管理界面。** 不能在 chat 里新建、上传、编辑、删除 skill——要加 skill 就往仓库的 `.agents/skills/` 里放。
- **不做 `@` 文件引用。** `@` 这个触发键留着，本次不实现。
- **不做历史消息里的标记块高亮。** 发出去之后就是普通文本，时间线上不会渲染成 chip。
- **不做跨会话的 skill 收藏/常用排序。** 清单就按名字排。
- **不开放富文本格式。** 见 §2.5。

## 4. 成功标准

1. 新建一个会话，在 composer 打 `/`，能看到至少 `frontend-design` 一项，带描述。
2. 选中后 composer 里出现 `/frontend-design` 标记块；Backspace 一次整枚删除。
3. 发一条带标记的消息，agent 在这一轮里**确实调用了 `load-skill`** 且参数是被点名的那个 skill（在时间线的工具卡片上能直接看到）。
4. 往沙盒 `.agents/skills/` 里放第二个 skill，下一轮打开清单能看到它，选中后同样能被 `load-skill` 成功加载（不再报 "No skill named ..."）。
5. 不用 `/` 时，composer 的一切行为（Enter 排队、⌥⏎ 插话、Shift+Enter 换行、停止键、空消息不发）与本功能之前逐条一致。

## 5. 怎么看效果

跑起 chat 应用（`pnpm chat:server` + `pnpm chat:web`），新建会话，等沙盒就绪后：

1. composer 里打 `/` → 应弹出清单。
2. 选 `frontend-design`，在后面接着写「帮我看看首页的排版有什么问题」，发送。
3. 看时间线：应出现一张 `load-skill` 工具卡片，入参 `{ name: "frontend-design" }`。

详细的端到端验证步骤（含多 skill、休眠恢复、回归项）见 [施工进展](../plans/composer-skill-mention.md) 的「验证方案」一节。
