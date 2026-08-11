# 分段授权（施工进展）

> 相关：[产品视角](./feature.md) · [技术方案](./tech.md)
> 依赖：[chat 应用](../chat-webapp/plan.md) P12-5「人在环上」已交付的[会话级授权](../../terms.md)

> **立项 banner**：2026-07-25 用户确认开工（"行，试试看吧"）。
> 动机：复合 bash 命令的整串授权太脆，命令稍变即重新弹卡片，审批退化成噪音。

## 阶段总览

| 拆单 | 内容 | 状态 |
|---|---|---|
| G-0 文档 | 产品 / 技术 / 施工三份 + 术语表词条 | ✅ 已完成 |
| G-1 拆分器 | `split-command.ts` 纯函数 + 表驱动单测 | ✅ 已完成 |
| G-2 记账查询 | `session-grants.ts` 按段记/查 + 单测 | ✅ 已完成 |
| G-3 端到端 | routes 集成测试 + 卡片文案 | ⚠️ 服务端已完成，卡片文案待补（见变更记录） |
| G-4 文档回填 | chat-webapp 技术/产品文档同步 | ✅ 已完成 |
| G-5（可选） | 卡片展示"会记住哪几段" | 🕓 待定，见技术方案 §6.4 |

## 拆单明细

### G-0 文档（✅ 2026-07-25）

产出 `docs/app/approval-grant-split/{feature,tech,plan}.md` 三份；`docs/terms.md` §四 新增「命令段」「分段授权」两个词条，并在「会话级授权」词条里标注记账粒度已改。

关键定案（详见技术方案）：

- 授权单元 = **命令段的 argv 数组 + cwd + 重定向**，不是命令名、不是段的字符串原文（后者会让 `rm -rf "my dir"` 与 `rm -rf my dir` 撞键）。
- 拆分器**只需 fail-closed，不需完整 bash 文法**——拆不动退回整串匹配 = 今天的行为，零回退。
- **无 DB 迁移**：复用 `grant_key` 列，靠 `bash#seg ` 前缀区分两种形态，新旧行并存都参与查询。
- 前缀规则（`npm install *`）**本期不做**，理由见技术方案 §6.3。

### G-1 拆分器（依赖 G-0）

- **目标**：`apps/node-server/src/agent/split-command.ts` —— `splitCommand(command): CommandSegment[] | undefined`，纯函数、零依赖、无 I/O。
- **涉及文件**：`src/agent/split-command.ts`（新增）、`test/agent/split-command.test.ts`（新增）。
- **对应 spec**：技术方案 §3（§3.2 接受形状、§3.4 拒绝清单 14 条）。
- **验收标准**：
  1. 接受组：`§3.2` 每种语法至少一条用例，断言段数与每段 `argv`/`redirects` 精确相等。
  2. 拒绝组：`§3.4` **14 条逐条**各一个用例，断言返回 `undefined`。
  3. 引号内的 `&&` / `;` / `#` / `$` 不触发切分或拒绝（除双引号内的 `$`/`` ` ``，按 §3.2 仍拒绝）。
  4. `pnpm --filter @nimbo-chat/node-server typecheck && test` 全绿。
- **产出物**：拆分器 + 单测。**不接线**，本阶段对运行时零影响。

### G-2 记账与查询（依赖 G-1）

- **目标**：`session-grants.ts` 内部改为按段记账，**对外签名不变**。
- **涉及文件**：`src/agent/session-grants.ts`、`test/agent/session-grants.test.ts`。
- **对应 spec**：技术方案 §2.1（键形状）、§4（记账/查询伪码）。
- **验收标准**：
  1. 复合命令 `allow-session` 后，其任一子集组合命中；含新段的不命中。
  2. `rm -rf a` 的授权**不**放行 `rm -rf b`；`npm install react` **不**放行 `npm publish`。
  3. `cwd` 不同不命中；`timeout_ms` 不同**仍**命中。
  4. 拆不动的命令（取 §3.4 里两三条）退回整串匹配，行为与今天逐字一致。
  5. 手工插入的旧整串 key 行仍能放行（向后兼容，无需迁移）。
  6. 既有「按用户隔离」用例继续通过。
  7. 段查询是**一次** `IN` 查询，不是 N 次往返。
- **产出物**：改造后的 `session-grants.ts` + 扩充的单测。

### G-3 端到端（依赖 G-2）

- **目标**：确认整条链路（分类器 → 卡片 → 裁决 → 下一轮免审）真的通。
- **涉及文件**：`test/routes/chat.test.ts`、`apps/web/.../approval-card.tsx`（仅按钮 `title` 文案）。
- **验收标准**：
  1. 对一条复合命令 `behavior:'allow-session'` 后，下一轮发出**其中一段**，流里不再出现 `tool-approval-request`。
  2. 下一轮发出**含新段**的命令，仍出现 `tool-approval-request`。
  3. 卡片「会话内都允许」的 `title` 改为说明新语义（记住的是这串里的每条命令）。
  4. server + web 两侧 `typecheck` / `lint` / `test` 全绿。

### G-4 文档回填（依赖 G-3）

- `docs/app/chat-webapp/tech.md` §6「会话级授权」段：记账粒度改为按段，链到本功能技术方案。
- `docs/app/chat-webapp/feature.md`：若提及授权粒度则同步。
- 本文件阶段状态、实际改动、与计划的偏差。
- `apps/*` 是 `private: true` 成员，**不写 changeset**（CLAUDE.md 版本管理机制）。

## 变更记录

- **2026-07-25 G-1~G-4 交付**：
  - **G-1**：`src/agent/split-command.ts`（约 260 行含注释）+ `test/agent/split-command.test.ts`，**71 个用例全绿**。接受组覆盖 §3.2 每种语法（引号/词边界/`$VAR`/glob/环境变量前缀/11 种重定向形态）；拒绝组覆盖 §3.4 **14 条逐条**共 36 个用例。
  - **G-2**：`session-grants.ts` 内部改按段记账，**对外签名零改动**（`resolveReview` / `onApproval` 调用点一行没动——两处传进来的 `input` 里本来就有 `command` 和 `cwd`）。查询是**一次** `IN`，把整串键与全部分段键放在同一条 SQL 里比对。单测 7 → **21 个全绿**，新增覆盖 §G-2 全部 7 条验收标准。
  - **G-3（服务端部分）**：`test/routes/chat.test.ts` 新增三轮端到端用例——授权复合命令 → 只发其中一段（无 `tool-approval-request`，工具直接跑完）→ 发含新段的命令（审批照常弹出）。**node-server 全量 338 用例绿、`tsc --noEmit` 干净、新增文件 lint 零 error。**
  - **G-4**：`docs/app/chat-webapp/tech.md` §6 增记账粒度段并互链；`docs/terms.md` §四 新增「命令段」「分段授权」两词条、「会话级授权」词条改写。
  - **与计划的偏差（一处）**：G-3 的「卡片 `title` 文案」**未落地**。改动写入 `apps/web/.../components/approval-card.tsx` 后，该文件在本次会话期间被**工作区里进行中的 web 重构删除**（`conversation.tsx`/`message.tsx` 同批消失，`rail.tsx` 被引用但不存在），web 侧 typecheck 与 3 个测试文件因此在本功能之外已经处于红的状态。文案改动随文件一起没了，**需在审批卡片重构落地后重新加上**：「会话内都允许」按钮的 `title` 应说明记住的是这条命令里的每一条子命令、出现新命令时仍会问。服务端行为不依赖它。
- **2026-07-25 立项 + G-0 完成**：三份文档产出。设计上有两处与最初设想的偏差，记在这里——(1) 最初提的"提取命令名（cd/rm/npm）分别记住"被否决，那会让 `rm -rf node_modules` 的授权放行 `rm -rf /`，改为按整段 argv 记账；(2) 一度打算复用/参照 `packages/mini-bash/src/parse.ts`，后确认无关——chat 的 bash 打到真实沙盒，真 bash 的语法面（heredoc、子 shell、控制结构、注释、续行）在 mini-bash 文法里根本不存在，参照它会漏判，改为独立按真 bash 语法写拒绝清单。
