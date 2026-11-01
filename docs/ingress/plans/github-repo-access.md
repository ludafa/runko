---
title: "按用户授权加载 GitHub 仓库（github-repo-access）— 施工进展"
slug: github-repo-access
view: 施工
layer: 接入层
module: —
packages: ["@runko-chat/node-server", "@runko-chat/web"]
tags: ["chat 应用", "GitHub App", "安装令牌", "施工"]
related: ["ingress/features/github-repo-access.md", "ingress/tech/github-repo-access.md"]
---
# 按用户授权加载 GitHub 仓库 — 施工进展

> 要做什么见[功能手册](../features/github-repo-access.md)；怎么做见[技术方案](../tech/github-repo-access.md)。术语见 [术语表](../../terms.md)。

## 当前状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| G0 | 三份文档、术语表（GitHub App 安装、安装令牌） | ✅ |
| G1 | 服务端：`github-app.ts`（配置、JWT、换令牌、列仓库、核对、缓存）+ `/api/github/*` 路由 | ✅ |
| G2 | 服务端：迁移加两列；建会话核对仓库、签令牌；起轮装配读会话自己的仓库 | ✅ |
| G3 | 沙盒管理：令牌文件 + 凭据助手；克隆不设沙盒级环境变量；每次 acquire 覆写令牌；提示词只推工作分支 | ✅ |
| G4 | 删掉 `GITHUB_REPO` / `GITHUB_PAT`：代码、`.env.template`、集群 compose、文档 | ✅（chat 应用侧；`examples/12` 仍用独立一套，见下） |
| G5 | 前端：新建会话弹窗的仓库一栏（四种状态）、连接 GitHub、刷新 | ✅ |
| G6 | 测试：假 GitHub、假云沙盒、集成用例、前端用例 | ✅ |
| G7 | 清理旧注释、代码审查、全量检查、端到端 | ✅ |

**顺序**：G1 → G2 → G3 串行（后一步用前一步的接口）；G5 只依赖技术方案 §5 的接口形状，可以和 G1–G3 并行；G4、G6 跟着各自的代码走；G7 最后。

## 各阶段

### G1 · GitHub App 客户端与路由 ✅

- **文件**：`apps/node-server/src/agent/github-app.ts`（新）、`src/routes/github.ts`（新）、`src/app.ts`（挂路由）、`src/schemas/github.ts`（新）。
- **产出**：技术方案 §5 的两个接口；`createGithubApp({ env, fetch, getUserToken, now })` 全部可注入（测试用假 GitHub、假用户令牌源，零网络零凭证）；JWT 用 `node:crypto` RS256 现签，已用一对测试 RSA 密钥手动验过签名。
- **偏差（已在 G7 审查后收回）**：起初建会话时「核对」与「签令牌」各调一次，同一次建会话里核对了两遍；审查后改成 `getRepoToken` 一步完成、连同仓库信息返回。

### G2 · 建会话与起轮装配 ✅

- **文件**：`src/db/migrations.ts`（`004_github_repo`）、`src/db/schema.ts`（`ConversationsTable` 加两列 + 新增 `AccountTable`）、`src/agent/store.ts`、`src/routes/chat.ts`、`src/agent/runtime.ts`、`src/schemas/chat.ts`（`RepoSelectorSchema`）。
- **产出**：`POST /api/chat/conversations` 接受并核对 `repo`（400/403/404/409 四种拒绝，见技术方案 §5）；老会话起轮抛「这个会话建于按用户授权之前，请新建会话」（技术方案 §7）；权限被收回时起轮抛「没有权限访问这个仓库了」。

### G3 · 沙盒里的令牌 ✅

- **文件**：`src/agent/sandbox-manager.ts`、`src/agent/chat-agent.ts`。
- **产出**：技术方案 §4 那张表的四步——令牌文件 `.git/runko-github-token`（经 `RunkoFS.writeFile`）、`git config credential.helper` 现读现 cat、克隆完把远端地址改回不带令牌、每次 `acquire()`（缓存命中/恢复/新建）都覆写一遍。E2B 的令牌只进那一条 `git clone` 命令自己的 `envs`，两家都不再设沙盒级 `GH_TOKEN`。提示词改成只推工作分支、不开 PR、不提 `$GH_TOKEN`。

### G4 · 删全局配置 ✅

- **文件**：`src/agent/github-repo.ts`（已删，`splitFullName` 挪进 `github-app.ts`）、`.env.template`、`apps/node-server/docker/cluster.compose.yml`、`apps/node-server/README.md`。
- **偏差**：`.env.template` 是仓库根共享文件，`examples/12-vercel-sandbox-real-project.ts` 仍读 `GITHUB_REPO`/`GITHUB_PAT`（固定仓库 + 长期 PAT 那一套，与 chat 应用无关）——按工单要求不动 `examples/`，所以这两个变量**保留**，只是改了注释说明「仅供 examples/12 用，chat 应用已不读」，并在旁边新增了 GitHub App 那五项。`docs/host/contract/*`、`docs/logic/orchestration/*` 里提到 `GITHUB_REPO`/`GITHUB_PAT` 的既有文档同理未动（那些讲的是沙盒契约/示例，不是这个功能）。

### G5 · 前端 ✅

- **文件**：`apps/web/src/features/chat/components/github-repo-picker.tsx`（新，仓库一栏本体）、`conversation-list.tsx`（新建会话弹窗）、`features/chat/api.ts`、`features/chat/schema.ts`、`layouts/chat-layout.tsx`（建会话透传 `repo`）。
- **产出**：功能手册 §2.1 的四种状态；选云沙盒没选仓库时不能提交；本地沙盒不带 `repo`。
- **偏差**：仓库列表到手、还没选时**自动选中第一个**（功能手册没要求）。只装了一两个仓库的用户省一次点击；选错了也只是在那个仓库开一条工作分支，不碰默认分支。

### G6 · 测试 ✅

- **服务端**：`test/agent/github-app.test.ts`（配置、JWT 真验签、分页、换令牌请求体、缓存命中 / 快过期重签 / 权限收回、缓存按用户区分、用户不在安装里、授权被撤销）；`test/routes/github.test.ts`；`test/routes/chat.test.ts`（建会话 400/403/404/409 与成功路径、老会话与权限收回的起轮失败）；`test/agent/sandbox-manager.test.ts`（令牌文件三条路、凭据助手、令牌不进命令、缓存命中时沙盒已没了）。假 GitHub 是真的 `node:http` 服务（`test/helpers/fake-github-http.ts`），用测试生成的 RSA 公钥验 App JWT。
- **集成端到端**：`test/e2e/github-repo-access.integration.test.ts`，随 `pnpm test` 跑——假 GitHub + 真 `createGithubApp` + 真沙盒管理（假云沙盒）+ 真 chat 应用，走完连接状态 → 列仓库 → 建会话 → 起一轮（缓存命中）→ 快过期重签 → 权限收回后失败。
- **前端**：`github-repo-picker.test.tsx`（全部状态、409 回到连接、刷新后选中项失效、收起时显示仓库名）、`conversation-list.test.tsx`、`chat-layout-create.test.tsx`、`api.test.ts`、`schema.test.ts`。
- 关键断言都做过变异检查（改坏代码 → 用例变红 → 改回）。

### G7 · 收尾 ✅

- **清理旧注释**：删掉引用已删除文件（`github-repo.ts`、`resolveRepo()`）与写历史的注释；审批规则把「读令牌文件的 curl」也算进要人审的范围（沙盒里不再有 `$GH_TOKEN`，只拦它会漏）。
- **代码审查**（高强度，10 条，全部修完）：

| 问题 | 处置 |
|---|---|
| 🔴 令牌缓存只按「安装 + 仓库」，一个人被移出仓库后还能拿到别人缓存的令牌 | 缓存键加上用户 |
| 🟠 缓存令牌剩 10 分钟以上就复用，一轮跑得久或等人审批时推送会撞上过期 | 剩余不到 50 分钟就重签 |
| 🟠 GitHub 撤销授权后状态仍报「已连接」、列仓库 409，界面没法重新连接 | 用户令牌被拒（401）归为没连接，前端收到 409 回到「连接 GitHub」 |
| 🟠 `SANDBOX_PROVIDER` 点名了配不起的档（模板缺省 vercel）时照样给它 | 点名的档配不起就回落到配得起的第一档 |
| 🟠 缓存命中时写令牌文件失败直接抛，不认「沙盒已经没了」 | 认出 gone 就踢缓存、照恢复 / 新建走 |
| 🟠 默认用户令牌来源把所有错误都当没连接 | 只有 better-auth 的 `APIError` 算没连接，别的原样抛 |
| 🟡 建会话核对两遍 | `getRepoToken` 一步完成并返回仓库信息 |
| 🟡 列仓库逐个安装串行 | 并发 |
| 🟡 刷新后已选仓库不在新列表里仍可提交 | 换成新列表第一个，空了就清掉 |
| 📄 两段注释重叠、初始化脚本注释过时、迁移里两个一样的类型函数 | 合并、改正 |

- 审查之外自己发现的两处：凭据助手按相对路径读令牌文件，agent 在子目录里 `git push` 会读不到（改用 `--absolute-git-dir`，并实测过）；下拉框收起时显示内部的 `installationId:repoId` 而不是仓库名（base-ui 的 Select 要在根上给 `items`）；以及用户已不在某个安装里时 GitHub 回 404，原先会报成 500（改成没权限）。

## 验证方案

| 跑什么 | 覆盖 | 预期 |
|---|---|---|
| `pnpm --filter @runko-chat/node-server test` | 上面 G6 的服务端用例 + 集成端到端 | 全绿 |
| `pnpm --filter @runko-chat/web test` | 前端用例 | 全绿 |
| `pnpm -r build` / `typecheck`、`pnpm lint`、`docs:check` | 全仓 | 全绿 |
| `test:cluster` / `test:cluster-handover` / `test:cluster-console` / `test:lab` | 集群不受影响（它们用本地沙盒，但沙盒管理、默认档、集群 compose 都改了） | 全绿 |
| 真 GitHub App + 真云沙盒走一遍（**要人来做**） | 按功能手册 §3 注册 App、填 `.env`，起前端连服务端：连接 GitHub → 装 App 勾两个仓库 → 下拉框正好这两个 → 建会话、让 agent 改一个文件并推送 → GitHub 上出现 `runko/…` 分支 → 在 GitHub 上移除这个仓库 → 下一轮提示没有权限 | 功能手册 §5 的五条成功标准 |

**实际结果**（2026-09-27）：node-server 607 通过（26 跳过，是要真凭据 / Docker 的门禁用例）；web 441 通过；全仓 build / typecheck / lint / docs:check / 文档链接检查全绿；集群四套见变更记录。真 GitHub App 这一层没有跑：本地没有注册好的 App 与云沙盒凭据。

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-09-27 | G0：三份文档、术语表两条。决策：GitHub App（否决 OAuth App + `repo` 权限）；令牌只推工作分支，不开 PR；本期只支持云沙盒；删掉全局 `GITHUB_REPO` / `GITHUB_PAT` |
| 2026-09-27 | G1–G4：服务端全部实现并通过 `typecheck`/`lint`/`test`/`build`（node-server）与 `typecheck`（web，OpenAPI 客户端已重新生成）。偏差见各阶段小节 |
| 2026-09-27 | G5–G7 完成：前端仓库一栏；服务端、前端、集成端到端测试；清理旧注释；高强度代码审查 10 条全部修完（见 G7）。集群端到端四套在最终代码上全绿：cluster 9/9、cluster-handover 3/3、cluster-console 5/5、lab 9/9 |
