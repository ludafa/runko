# 端到端示例调研：沙盒内设计优化 + Git 工作流（舒尔特方格项目）

> 状态：**已立项开工**（2026-07-12 用户 review 通过，定案见 §8；§1–§7 为调研原文保留）
> 相关文档：[docs/06](./06-sandbox-workspace-research.md)（P10 沙盒适配器，本方案的地基）· [施工计划](./03-construction-plan.md)
> 目标场景（用户原述）：nimbo loop agent 连接 Vercel 沙盒，对用户的纯前端舒尔特方格游戏（即当前 `VERCEL_PROJECT_ID` 指向的项目）执行一次 frontend-design skill 驱动的设计优化，走完整 Git 工作流：拉代码 → 装 skill → 建分支 → 改代码 → commit → push → 建 PR → 触发 Vercel 部署 → 回复汇总。

## TL;DR：全链路可行，nimbo 现有能力零改动覆盖

每个环节都有已验证的落点：沙盒 = `@nimbo/sandbox-vercel`（P10 真机 20/20）；拉代码 = `Sandbox.create` 原生 `source: git`（支持私库凭证）；skill 安装 = `npx skills` CLI（vercel-labs/skills，官方 anthropics/skills 源，`-y` 无人值守）；skill 装载 = `Skill.fromFS(workspace, …)`——**从沙盒文件系统直接加载 skill 是 nimbo 独有能力**（P5 官方 skill 零改动加载已实证）；PR = 沙盒内 `curl` GitHub REST（免装 gh）；部署 = Vercel Git 集成自动 preview（零代码）。**不需要给三个包或 core 写任何新代码，只需一个新 example 脚本。** 待你决策的点在 §6。

## 1. 架构与数据流

```
宿主 Node 机器（跑 example 脚本）
   │ 1. Sandbox.create({ source: git+PAT, env: { GH_TOKEN }, runtime: node24 })
   │ 2. 初始化（host 侧 runCommand，不经模型）：
   │      npx skills add … / git 身份与 remote 预配 / .git/info/exclude
   │ 3. skill = await Skill.fromFS(vercelWorkspace(sandbox), "/.agents/skills/frontend-design")
   │ 4. agent = defineAgent({ model, skills: [skill], instructions: 任务 })
   │ 5. session = createSession(agent, { workspace })
   ▼
┌── Vercel Sandbox（/vercel/sandbox = 舒尔特方格 repo 检出）─────────┐
│ loop agent 经 file tools + bash 工具操作：                        │
│   load_skill(frontend-design) → git checkout -b → 读代码 →       │
│   设计修改（edit_file/write_file）→ 本地验证（如有构建）→        │
│   git commit → git push → curl api.github.com 建 PR              │
└──────────────────────────────────────────────────────────────────┘
   │ push 触发                                    │ PR 创建
   ▼                                              ▼
Vercel Git 集成自动构建 preview deployment    GitHub PR（附 Vercel bot 预览链接）
   │
   ▼
6. session.send() 的 finalResponse = 汇总（改了什么/为什么/PR 链接）
7. finally: sandbox.stop()（persistent: false，不留快照）
```

## 2. 逐环节可行性核验

### 2.1 沙盒初始化与拉代码

`Sandbox.create` 原生支持 git source（docs/06 调研已核对 d.ts）：

```ts
Sandbox.create({
  token, teamId, projectId,
  runtime: "node24",                       // node+npm+npx 预装，npx skills 直接可用
  timeout: 25 * 60_000,                    // Hobby 单会话上限 45min，留余量
  persistent: false,                       // 一次性任务，不留快照（P10 成本纪律）
  source: { type: "git", url: REPO_URL, username: "x-access-token", password: GH_TOKEN, depth: 1 },
  env: { GH_TOKEN },                       // 沙盒内 curl 建 PR 用
});
```

私库认证：username 任意占位（GitHub 惯例用 `x-access-token`），password 填 PAT。repo 检出到 `/vercel/sandbox`，正好是 `vercelWorkspace` 的默认锚定 root——agent 视角 `/` 即仓库根。网络默认 `allow-all`（github.com / registry.npmjs.org 可达）。

### 2.2 GitHub 身份（"以 AI bot 身份"的三档答案）

| 档位 | 形态 | 优劣 |
|---|---|---|
| **① Fine-grained PAT（推荐 v1）** | 你的账号签发，仅授权舒尔特仓库，权限 Contents RW + Pull requests RW，短有效期 | 5 分钟搞定，够 demo；commit 署名经 `git config user.name "nimbo-agent"` 标注，但 API 操作以你的身份 |
| ② Machine user | 注册一个专用 GitHub 账号 + PAT，邀请为协作者 | 真独立身份，管理多一个账号 |
| ③ GitHub App（真 bot） | 建 App → 安装到仓库 → 运行时用私钥换 1h installation token；commit/PR 署名 `your-app[bot]` | 这才是"AI bot 身份"的正解，且 **1h 自动过期的 token 是把凭证放进沙盒的最好缓解**；代价是 App 创建 + JWT 换签逻辑（约 30 行，可作 example 的进阶段） |

**v1 建议 ①**，example 代码里把"token 换取"隔离成一个函数，升级 ③ 时只换这一个函数。

### 2.3 skill 安装与装载（你的"npx skill"设想成立）

- CLI 实为 **`npx skills`**（[vercel-labs/skills](https://github.com/vercel-labs/skills)）；frontend-design 是官方 [anthropics/skills](https://github.com/anthropics/skills/tree/main/skills/frontend-design) 出品（27 万+ 安装），**结构就是单个 SKILL.md（8.3KB，带 name/description frontmatter，无附属文件）**——nimbo 的 packaged skill 加载器零改动兼容（P5 验收项）。
- 安装命令（host 侧 `runCommand` 执行，不经模型）：
  `npx -y skills add anthropics/skills --skill frontend-design -a cursor -y`
  `-a cursor` 使其落到仓库内 **`.agents/skills/frontend-design/`**（cursor/cline/zed 共用的通用目录，nimbo 没有注册进该 CLI 的 agent 表，借用此目录即可）；`-y` 无人值守。
- **装载**：`await Skill.fromFS(workspace, "/.agents/skills/frontend-design")` → `defineAgent({ skills })`。时序成立：workspace 在 `createSession` 之前就可用（沙盒已建好），skill 加载完再定义 agent 即可。
- **防误提交**（重要细节）：`.agents/`（npx 安装物）与 `.skills/`（nimbo 的 skill 附属挂载点，本 skill 无附属文件故实际不会产生，但防御性加上）写入 **`.git/info/exclude`**（不污染仓库的 .gitignore）——初始化时 host 侧一并做掉。
- **降级路径**：若 `npx skills` 在无已知 agent 的容器环境里行为异常（交互挂起等），fallback 为 `git clone --depth 1 https://github.com/anthropics/skills /tmp/skills && cp -r /tmp/skills/skills/frontend-design .agents/skills/`——纯 git，永远可用。example 里主路径用 npx（贴合你的设想），注释里给 fallback。

### 2.4 分支 / commit / push / PR

- **push 认证预配**（host 侧初始化做，agent 只管 `git push`）：`git remote set-url origin https://x-access-token:${GH_TOKEN}@github.com/<owner>/<repo>.git` + `git config user.name/user.email`（bot 署名）。
- **PR 创建**：沙盒内已有 curl，免装 gh CLI：
  `curl -s -X POST -H "Authorization: Bearer $GH_TOKEN" https://api.github.com/repos/<owner>/<repo>/pulls -d '{"title":…,"head":…,"base":"main"}'`
  写进 instructions 让 agent 执行；返回 JSON 里的 `html_url` 就是汇总里的 PR 链接。
- 这些 git 操作全走 bash 工具（`defaultApproval: "never"`，隔离即边界）；是否对 push/PR 加人工审批门见 §6 决策点 5。

### 2.5 Vercel 部署

- **主路径（零代码）**：项目若已连接 GitHub（Vercel 项目的常态），push 分支/开 PR 自动触发 preview deployment，Vercel bot 会在 PR 里评论预览 URL——什么都不用做。**需要你确认舒尔特项目确实是 Git 集成的**（§6 决策点 3）。
- **fallback（项目未连 Git 时）**：沙盒内 `npx -y vercel deploy --token $VERCEL_TOKEN --yes`（环境注入 VERCEL_ORG_ID/VERCEL_PROJECT_ID 即免 link）。代价是要把 VERCEL_TOKEN 也放进沙盒（权限比 PAT 大得多，见 §5 风险），**能走主路径就不要走这条**。

### 2.6 汇总与清理

- 汇总即 `session.send()` 的 `finalResponse`（instructions 里明确要求包含：改动清单+设计意图、分支名、PR 链接）；宿主打印 items 流水（tool_call/file_change）作过程记录。
- 清理：`finally { await sandbox.stop() }` + `persistent: false`；PAT 建议短有效期、事后手动 revoke（README 写明）。

## 3. Example 形态建议

- `examples/12-design-optimize-e2e.ts`，沿用三段纪律：**确定性段**（进程内 fake 沙盒演示初始化编排：skills 安装命令、git 预配、Skill.fromFS 装载——零凭证可跑）+ **真机段**（凭证 gated）。
- `.env.template` 追加：`NIMBO_DEMO_REPO_URL`（如 `https://github.com/<you>/schulte-grid`）、`NIMBO_DEMO_GH_TOKEN`（fine-grained PAT）、`NIMBO_DEMO_BASE_BRANCH`（默认 main）。
- instructions 骨架（要点）：先 `load_skill(frontend-design)` → 通读现有代码理解游戏 → 按 skill 的设计哲学做**一次聚焦的**视觉/交互优化（明确"不重写、不换框架"边界）→ 有构建则跑构建验证 → git 流程 → PR body 写设计说明。

## 4. 成本与时长预估

一次运行：沙盒 10–20 分钟（Hobby 45min 上限内），Active CPU 只在命令执行时计费（等模型时不算），预计消耗 Hobby 月度 5 CPU-hr 的零头；模型 token 视仓库大小，DeepSeek 直连成本可忽略。

## 5. 风险与已知取舍

1. **PAT 对模型可见**（env + remote URL，bash 可读）：fine-grained 单仓库 + 短有效期已是够用缓解；根治靠 ③ GitHub App 1h token（v2）。demo 场景（你自己的仓库、你发起的任务）风险可控，README 如实声明。
2. **模型设计能力**：DeepSeek-chat 能执行 skill 指令但设计品味有限；frontend-design skill 本身就是为"给模型注入设计纪律"设计的，可部分弥补。建议 example 支持 `NIMBO_MODEL` 换强模型（gateway 一行切换），见决策点 4。
3. **`npx skills` 在容器内的交互行为**：`-a cursor -y` 理论上全静默，但该 CLI 未在"零 agent 环境"下承诺行为——已备 git clone fallback（§2.3），施工时真机验证后择优固化。
4. **分支保护/权限**：若 main 有保护规则不影响（只开 PR 不合并）；PAT 权限不足时 push 失败会以非零 ExecResult 回给模型自述——instructions 要求失败时如实汇报而不是硬试。
5. **45min 会话上限**：任务 instructions 明确"聚焦一次优化"控制规模；必要时 `extendTimeout`。

## 6. 待 review 决策点

1. **GitHub 认证档位**：v1 用 fine-grained PAT（推荐）？还是直接上 GitHub App（多花一次性设置成本，换真 bot 署名 + 1h token）？
2. **PAT 由你线下签发**填入 `.env`（推荐，example 不碰签发流程）——OK？
3. **确认舒尔特项目已连接 GitHub 仓库**（决定部署走零代码主路径还是 CLI fallback）；顺便提供仓库地址。
4. **模型**：真机段默认 DeepSeek（现有 .env），还是你配一个强模型（如 gateway `anthropic/claude-sonnet-5`）跑设计任务？（二者代码同一行，只是默认值选择）
5. **要不要给 push/PR 加审批门**：nimbo 的审批链正好能演示——bash 工具 per-tool approval 回调对含 `git push`/`api.github.com` 的命令升级人工确认（宿主 readline 按 y/n）。加分项但增加示例复杂度；默认建议**不加**（保持"loop agent 自主完成"的原述目标），你若想展示审批能力就加。
6. 示例编号 `12-design-optimize-e2e.ts` 与新增 env 变量命名（§3）——OK？

## 7. 施工拆解建议（review 通过后）

- **P11-1**：example 12 本体 + `.env.template` 三变量 + `examples/README`/根 README 行 + docs/05 用例行（离线段即时验证；真机段待你填 PAT 后一键执行）。单 coder 工单可完成；真机验证含"沙盒必回收 + PR 产物人工检查"两道验收。

## 8. 定案（2026-07-12 用户 review 结论，施工依据）

§6 六项决策全部落定：

1. **认证**：v1 用 fine-grained PAT。所需权限（README/.env.template 如实记录）：Repository access 仅舒尔特仓库；Contents Read+Write（clone/push）+ Pull requests Read+Write（建 PR）+ Metadata Read（自动）；Account permissions 零项；建议短有效期、跑完 revoke。
2. **环境变量**：`GITHUB_PAT`（用户线下签发填入 .env）。
3. **仓库**：`GITHUB_REPO`，用户提供 **SSH 格式**（`git@github.com:owner/repo.git`）——沙盒内无 SSH 密钥，example 必须做 **SSH→HTTPS 规范化**（`git@github.com:owner/repo(.git)` → `https://github.com/owner/repo.git`，clone 与 push remote 均用 HTTPS+PAT；两种格式都接受，解析失败给指导性报错）。部署走 Git 集成主路径假设维持（PR 后人工在 Vercel 确认 preview，agent 汇总里不承诺部署 URL、只给 PR 链接）。
4. **模型**：DeepSeek 直连，**本示例默认用 deepseek v4 pro 档模型**（区别于 shared/model.ts 的 deepseek-chat 默认——设计任务用更强档位；确切 model id 施工时以 `GET {DEEPSEEK_API_BASE_URL}/models` 实测清单为准，`NIMBO_MODEL` 可覆盖）。
5. **审批门**：不加（bash 维持沙盒实现的 `defaultApproval: "never"`）。
6. **文件名**：`examples/12-vercel-sandbox-real-project.e2e.test.ts`（按用户命名；仍是 node 直跑的 example 脚本，root vitest projects 只收 `packages/*`，`.test.ts` 后缀不会被误收集——施工时验证）。

> 注：定案时 `.env` 中尚未见 `GITHUB_PAT`/`GITHUB_REPO` 键（用户表示已填，可能未保存）——真机段运行前需就位，脚本对缺失项打印指引并干净退出（既有三态纪律）。
