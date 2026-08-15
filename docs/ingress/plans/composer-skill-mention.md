---
title: "composer 里手动指定 skill（施工进展）"
slug: composer-skill-mention
view: 施工
layer: 接入层
module: —
packages: ["@nimbo-chat/web", "@nimbo/core"]
tags: ["composer", "skill 提及", "渐进式披露"]
related: ["ingress/features/composer-skill-mention.md", "ingress/tech/composer-skill-mention.md", "architecture/tech/agent-kernel.md"]
---
# composer 里手动指定 skill（施工进展）

> 相关：产品文档见 [功能](../features/composer-skill-mention.md)，[技术方案](../tech/composer-skill-mention.md)。

## 状态总览

| 阶段 | 目标 | 状态 |
|------|------|------|
| P0 | 术语登记 + 依赖安装 | ✅ 完成 |
| P1 | 服务端：加载沙盒里全部 skill | ✅ 完成 |
| P2 | 服务端：skill 清单落库 + 随会话下发 | ✅ 完成 |
| P3 | 服务端：提及 → 模型指令 | ✅ 完成 |
| P4 | 前端：tiptap composer + `/` 提及 | ✅ 完成 |
| P5 | 端到端验证 | 🟡 自动化部分已完成，真机部分待跑 |

**依赖顺序**：P0 → P1 → {P2, P3} → P5，P4 只依赖 P2 定下的 wire 契约（`ConversationDto.availableSkills`），契约一确定就能与 P2/P3 并行。

**不需要 changeset**：改动全部落在 `apps/node-server` 与 `apps/web`，两者都是 `private: true` 的不发布成员（见根 CLAUDE.md「版本管理机制」）。`packages/*` 一行不动。

---

## P0 · 术语登记 + 依赖安装

**目标**：把新术语落进术语表（[术语纪律](../../../CLAUDE.md)：先登记再使用），把 tiptap 装进 `apps/web`。

**涉及文件**：
- `docs/terms.md` —— 新增三个词条
- `apps/web/package.json`

**产出物**：

1. 术语表新增（归入「十一、界面语言」节，`composer` 与既有的 ai-elements 词条同族）：

| 主术语 | 同义词（退役） | 定义 |
|--------|--------------|------|
| **composer（消息输入框）** | 输入框 | chat 页面底部那个写消息的区域，含输入区 + 底部工具条（插话键/发送键）。P?? 后输入区由 tiptap 承载，不再是原生 textarea。 |
| **skill 提及（skill mention）** | — | 用户在 composer 里用 `/` 唤出清单、选中后插入的一枚原子标记块，形如 `/frontend-design`。作用是告诉 agent「这件事按这个 skill 来做」；wire 上就是消息文本里的普通字符串，不是独立字段。 |
| **skill 清单（skill catalog）** | — | 一个会话当前可选的 skill 集合（`{name, description}[]`）。事实来源是沙盒 `.agents/skills/` 目录，缓存在 `conversations.available_skills_json`，最多滞后一轮。 |

2. 依赖安装（tiptap 3.29.0，版本对齐）：

```bash
pnpm --filter @nimbo-chat/web add \
  @tiptap/react @tiptap/pm @tiptap/core \
  @tiptap/extension-document @tiptap/extension-paragraph \
  @tiptap/extension-text @tiptap/extension-hard-break \
  @tiptap/extensions @tiptap/extension-mention @tiptap/suggestion
```

> `Placeholder` 在 tiptap 3 里归 `@tiptap/extensions`（不再是独立包）。装完核对一遍实际导出位置，与技术方案 §5.3 的 import 对齐。

**验收**：`pnpm --filter @nimbo-chat/web typecheck` 通过；术语表三个词条就位。

---

## P1 · 服务端：加载沙盒里全部 skill

**目标**：`buildSession` 从「硬读 `/.agents/skills/frontend-design` 一个」改成「扫描 `.agents/skills/*` 全部加载」。这是整个功能的前置条件——用户选的 skill 不在 `agent.skills` 里，模型调 `load-skill` 必然失败。

**涉及文件**：
- `apps/node-server/src/agent/skill-catalog.ts` **（新）** —— `SKILLS_DIR`、`loadSkillsFromWorkspace`、`toSkillSummaries`
- `apps/node-server/src/agent/chat-agent.ts` —— 删掉 `FRONTEND_DESIGN_SKILL_PATH` 硬编码，改调 `loadSkillsFromWorkspace`
- `apps/node-server/test/agent/chat-agent.test.ts` —— 现有假 workspace 的 skill 目录形状要跟着调
- `apps/node-server/test/agent/skill-catalog.test.ts` **（新）**

**产出物 / 关键约束**：

- **best-effort 扫描**：单个目录读失败、缺 `SKILL.md`、缺 `description` frontmatter → 跳过 + `log.warn`，不抛。理由：这是每轮起轮的必经路径，一个坏 skill 不该拖垮整轮。
- **向后兼容**（技术方案 §6.3）：目录不存在或扫不出任何 skill → 返回 `[]`，`defineAgent` 不带 `skills`，core 走[条件内置](../../terms.md)的既有语义（不注册 `load-skill`、不注入 `<available_skills>`），不报错。
- **排序稳定**：按 `name` 字典序，让 `<available_skills>` 段与前端菜单顺序一致、可预期。

**测试要点**：
- 两个合法 skill → 都加载，按名排序
- 目录不存在 → `[]`，不抛
- 一个合法 + 一个缺 `SKILL.md` → 只得合法那个，且有 warn 日志
- 缺 `description` frontmatter 的 packaged skill → 跳过（`Skill.fromFS` 对此是抛错的，验证被 catch 住）

**验收**：`pnpm --filter @nimbo-chat/node-server test` 全绿；旧有 chat-agent 测试改造后仍覆盖「skill 被正确传进 `defineAgent`」。

---

## P2 · 服务端：skill 清单落库 + 随会话下发

**目标**：前端能从已有的会话接口拿到 skill 清单，且不触发沙盒唤醒（技术方案 §2.1）。

**涉及文件**：
- `apps/node-server/src/db/schema.ts` —— `conversations` 加 `availableSkillsJson`
- `apps/node-server/drizzle/0008_*.sql` **（新，`pnpm db:generate` 生成）**
- `apps/node-server/src/agent/store.ts` —— 读写 + zod `safeParse` 反序列化边界
- `apps/node-server/src/schemas/chat.ts` —— `SkillSummarySchema` + `ConversationSchema.availableSkills`
- `apps/node-server/src/routes/chat.ts` —— 两个会话端点的响应组装带上它
- `apps/node-server/src/agent/sandbox-manager.ts` —— 初始化装完 skill 后扫一次写库
- `apps/node-server/src/agent/turn-launcher.ts` —— 每轮起轮顺手刷新
- `apps/node-server/openapi.yml` + `apps/web/src/lib/api/**` —— `pnpm chat:bootstrap` 重新生成
- 对应测试

**产出物 / 关键约束**：

- 列定义照抄 `queuedMessagesJson` 的姿态：`text('available_skills_json').notNull().default('[]')`，存量行天然得到 `'[]'`。
- **读回必须 `safeParse`**，不是类型断言（全局 TypeScript 规范 + `store.ts` 既有惯例）。parse 失败 → 当作 `[]` + warn，不抛。
- **写入是幂等覆盖**，不做增量 diff。
- 清单是**缓存不是事实来源**：这一列空了/坏了，最坏是菜单空着，`buildSession` 照常自己扫描，agent 照常能用 skill。

**验收**：
- `pnpm --filter @nimbo-chat/node-server test` 全绿
- 新建会话后查库，`available_skills_json` 含 `frontend-design`
- `GET /conversations/{id}` 响应带 `availableSkills`
- 迁移在已有库上跑得过（存量行不炸）

---

## P3 · 服务端：提及 → 模型指令

**目标**：起轮时扫出被提及的 skill，拼出给模型的提示行，且**界面/账本仍是用户原话**（技术方案 §2.2）。

**涉及文件**：
- `apps/node-server/src/agent/skill-catalog.ts` —— 追加 `extractMentionedSkills`、`buildModelText`
- `apps/node-server/src/agent/turn-runner.ts` —— `driveTurn` 的 `text` 参数拆成 `displayText` / `modelText`；`startTurn` 同步透传
- `apps/node-server/src/agent/turn-launcher.ts` —— 调用两个纯函数，把 `modelText` 传下去
- `apps/node-server/test/agent/skill-catalog.test.ts` —— 补纯函数用例
- `apps/node-server/test/agent/turn-runner.test.ts` —— 补「界面拿原话、模型拿加料版」

**产出物 / 关键约束**：

- `extractMentionedSkills` 的边界规则见技术方案 §5.1 那张表，**逐行落成用例**（尤其 `/usr/local` 不算提及、`x/frontend-design` 不算提及、不做前缀匹配）。
- 提及为空时 `buildModelText` **原样返回同一个字符串**，零副作用——保证「不用这个功能的用户拿到的字节与以前完全一致」。
- 提示行的措辞集中在 `buildModelText` 一处，方便日后按实测效果调。

**验收**：
- 关键断言：一条带提及的消息，落[账本](../../terms.md)的 `NimboUIMessage` 文本 **==** 用户原话（不含提示行），而 `session.stream()` 收到的 **含** 提示行。
- `pnpm --filter @nimbo-chat/node-server test` 全绿。

---

## P4 · 前端：tiptap composer + `/` 提及

**目标**：composer 输入区换成 tiptap，`/` 唤出 skill 清单，选中插入原子标记块；**现有键盘语义一条不变**。

**涉及文件**：
- `apps/web/src/features/chat/components/composer-editor.tsx` **（新）**
- `apps/web/src/features/chat/components/skill-suggestion-list.tsx` **（新）**
- `apps/web/src/features/chat/components/message-composer.tsx` —— 用 `ComposerEditor` 换掉 `PromptInputTextarea`，其余（插话键、停止键、发送键）不动
- 会话数据流：把 `ConversationDto.availableSkills` 传到 composer
- `apps/web/src/features/chat/__tests__/message-composer.test.tsx` **（新）**

**产出物 / 关键约束**：

- **只装六个扩展**（技术方案 §2.4），不装 starter-kit，粘贴走纯文本。
- **键盘优先级**（技术方案 §6.1）：菜单开着 → ↑↓/Enter/Esc 归菜单；菜单关着 → Enter 排队、⌥⏎ 插话、Shift+Enter 换行。
- **弹层定位用 tiptap 3 自带的 `props.mount()`**（技术方案 §6.2），不引入 tippy.js / floating-ui。
- **外部清空**（技术方案 §6.4）：只在「外部 value 空而编辑器非空」时 `clearContent()`，不做每键反向同步。
- 保持 `PromptInput` 外壳与底部工具条不变——视觉上除了多出标记块，应该看不出换过引擎。

**测试要点**（这是回归风险最高的一阶段）：
- 菜单关着：Enter 触发 `onSend(text, 'queue')`
- 菜单关着：⌥⏎ 触发 `onSend(text, 'steer')`
- 菜单开着：Enter **不**触发 `onSend`，而是插入标记块
- 选中后 `getText()` 得到 `/frontend-design ...`
- 空消息（只有空白）不发送
- 流式期间发送键是停止键、点击触发 `onStop`

**验收**：`pnpm --filter @nimbo-chat/web test` + `typecheck` + `lint` 全绿。

---

## P5 · 端到端验证

### 5.1 自动化验证（已完成）

跑完即退的命令，全部绿：

| 命令 | 结果 |
|------|------|
| `pnpm -r typecheck` | ✅ 12 个成员全过 |
| `pnpm --filter @nimbo-chat/node-server test` | ✅ 442 passed（本功能新增 39：skill-catalog 22 + store 4 + turn-runner 2 + 既有用例改造） |
| `pnpm --filter @nimbo-chat/web test` | ✅ 244 passed（本功能新增 8 个 skill 提及用例；既有 9 个 composer 键位用例**逐条保住**） |
| `pnpm build` / `pnpm test`（packages/\*） | ✅ 未受影响 |
| eslint（本功能改动的文件） | ✅ 0 error（仓库预先存在的 11 个 error 全在 `test/agent/uimessage-single-ledger.test.ts`，与本功能无关） |

自动化已经钉死的关键不变量：

- **键位没坏**：Enter 排队 / ⌥⏎ 插话 / Shift+Enter 换行 / 空白不发 / 流式期停止键 —— 换 tiptap 前的 9 个用例一字未改地全绿（除两处 `toHaveValue` → `toHaveTextContent`，因为 contenteditable 没有 `value` 属性）。
- **菜单开着时 Enter 归菜单**：`onSend` 不被调用，标记块入框（对应上面回归风险最高的那条）。
- **`/usr/local` 不被误判为提及**：前端菜单不弹 + 服务端 `extractMentionedSkills` 返回空，两侧各有用例。
- **界面拿原话、模型拿加料版**：`turn-runner` 用例断言账本里的 `NimboUIMessage` 文本 == 用户原话，而 `session.stream()` 收到的含提示行。
- **不用这功能就零影响**：`buildModelText(text, [])` 返回同一个字符串（`toBe` 断言，不是 `toEqual`）。

### 5.2 真机验证（待用户执行）

需要跑着的服务端 + 前端 + 真沙盒，**由用户自己起**（根 CLAUDE.md「dev server 归我自己管」）。先跑一次 `pnpm chat:bootstrap`（本功能加了一张迁移 `0008_burly_mariko_yashida.sql`，要 migrate）：

```
! pnpm chat:bootstrap
! pnpm chat:server
! pnpm chat:web
```

| # | 步骤 | 预期结果 | 实际 |
|---|------|---------|------|
| 1 | 新建会话，等沙盒就绪 | 会话详情响应里 `availableSkills` 含 `frontend-design` | ⬜ |
| 2 | composer 打 `/` | 弹出清单，含 `frontend-design` + 描述 | ⬜ |
| 3 | ↑↓ 移动、Enter 选中 | 插入 `/frontend-design` 标记块，菜单关闭 | ⬜ |
| 4 | 光标贴着标记块按一次 Backspace | 整枚删除，不留半截字符（**只有真浏览器能验**——jsdom 没有布局引擎，光标定位测不了） | ⬜ |
| 5 | 补正文「帮我看看首页排版」，Enter 发送 | 时间线上的用户消息显示为 `/frontend-design 帮我看看首页排版`（**无**系统提示行） | ⬜ |
| 6 | 观察这一轮 | 出现 `load-skill` 工具卡片，入参 `{name:"frontend-design"}` ——**这是「软提示到底管不管用」的唯一真实检验** | ⬜ |
| 7 | 让 agent 往 `.agents/skills/` 装第二个 skill，等这轮结束，刷新页面打 `/` | 清单出现第二个 skill | ⬜ |
| 8 | 选中第二个 skill 发消息 | `load-skill` 成功，**不**报 "No skill named ..." | ⬜ |
| 9 | 会话[休眠](../../terms.md)后重新打开，打 `/` | 清单照常弹出，**不**触发沙盒唤醒（看服务端日志无唤醒记录） | ⬜ |
| 10 | 粘贴一段带格式的富文本 | 落成纯文本，无加粗/标题 | ⬜ |
| 11 | 弹层位置 | 菜单贴着光标、不被输入框裁掉（`props.mount` 的托管定位在真浏览器里的表现） | ⬜ |

第 6 项若不如预期（模型收到提示仍不调 `load-skill`），改 `skill-catalog.ts` 的 `buildModelText` 一处即可调话术；再不行就是「软提示」这条路线本身不够，升级到硬注入的口子已经在 §2.2 的 display/model 拆分处留好了。

---

## 变更记录

| 日期 | 变更 |
|------|------|
| 2026-07-26 | 建档：产品/技术/施工三份文档就位，阶段拆分完成。三处路线选定记录在技术方案 §2（清单走库缓存、软提示拆 display/model 文本、提及走文本标记不加 wire 字段）。 |
| 2026-07-26 | P0–P4 全部完成，自动化验证全绿。与计划的偏差见下。 |

## 与计划的偏差（实际施工中的调整）

1. **`writeAvailableSkills` → `syncAvailableSkills`（P2）**。原计划是「幂等覆盖写入」，实测发现它会给每轮起轮加一次无谓 `UPDATE`——被既有用例「resumeToken 没变时不该发 DB 写」当场抓住。改成由调用方传入手上已有的当前 JSON 做字符串比对，内容没变就不写，零额外查询。
2. **skill 加载从 `buildSession` 上移到 `turn-launcher`（P1）**。原计划只说「`buildSession` 改成扫描全部」。实际做时发现同一份 skill 结果这一轮还要另做两件事（刷新清单缓存、按 skill 名解析提及），没理由扫两遍沙盒，于是 `BuildSessionOptions` 改为接收 `skills: Skill[]`，加载动作归调用方。`buildSessionMs` 打点区间起点相应前移，语义（「准备 session 花的时间，其中几乎全是读 skill」）不变。
3. **jsdom 要补三个 CSSOM polyfill（P4，计划里没预见）**。ProseMirror 需要 `Range.getClientRects` / `Range.getBoundingClientRect` / `document.elementFromPoint`，jsdom 全缺。缺了的表现极具误导性：**不是断言失败，而是打字整个抛异常、`onSend` 一次都不被调用**。已加进 `src/test/setup.ts` 并写明症状，免得下次有人对着「6 个用例集体失败」瞎猜。
4. **React 19 的两条新 lint 规则堵死了标准 "latest ref" 模式（P4）**。`react-hooks/refs` 禁止 render 期间碰 ref，`react-hooks/immutability` 禁止改 `useState` 的值——而「稳定的 tiptap 扩展 + 读到最新 props」只有 ref 一条路。最终：ref 赋值放 `useLayoutEffect`，`useMemo` 那段整体 `eslint-disable react-hooks/refs` 并写清为什么安全。
5. **两处测试断言改法（P4）**：`toHaveValue` → `toHaveTextContent`。contenteditable 没有 `value` 属性，这是换引擎的必然结果，不是回避——清空/保留这两个行为本身仍被断言。
