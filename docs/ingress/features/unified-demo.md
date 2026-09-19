---
title: "唯一 demo（unified-demo）— 功能手册"
slug: unified-demo
view: 功能
layer: 接入层
module: —
packages: ["@runko-chat/node-server", "@runko-chat/web", "@runko/persist-kysely"]
tags: ["chat 应用", "demo", "零配置", "本地沙盒", "演示模型", "Postgres", "多副本"]
related: ["ingress/tech/unified-demo.md", "ingress/plans/unified-demo.md", "ingress/features/chat-webapp.md", "host/node/features/multi-replica.md"]
---
# 唯一 demo — 功能手册

> 术语见 [术语表](../../terms.md)。技术方案见 [unified-demo · 技术](../tech/unified-demo.md)，施工见 [unified-demo · 施工](../plans/unified-demo.md)。

## 一句话

**仓库里只留一个 demo：chat 应用（`apps/node-server` + `apps/web`）。** 不配任何账号也能跑起来、把所有交互点一遍；配上 key 就是真 AI + 真云沙盒；换成 Postgres 就能开多个副本。`apps/persist-demo` 的职责并进来之后删掉。

## 1. 要解决的问题

现在有两个 demo，各缺一半：

| | chat 应用 | persist-demo |
|---|---|---|
| 有界面 | ✅ | ❌ 只有 HTTP 接口 |
| 真 AI、真云沙盒、登录、推送 | ✅ | ❌ 只有假模型、内存文件、只读命令 |
| 不配账号就能跑 | ❌ 建会话就报错（要 GitHub、要云沙盒 key） | ✅ |
| 数据库 | 只有 SQLite | SQLite / Postgres / MySQL / Mongo |
| 多副本、强杀一个另一个接手 | ❌ | ✅ |
| 框架的存储 | 自己手写（658 行），多进程下会丢消息 | 官方 `@runko/persist-*` 包 |

想看全貌的人得在两个项目之间来回切，两份代码也要各自维护。更麻烦的是，web 前端只认 chat 应用的接口格式，接不上 persist-demo，所以多副本、挂起恢复这些能力**没法在界面上看到**。

## 2. 给谁用

- **第一次接触 runko 的开发者**：clone 下来，不注册任何账号，几条命令就能在浏览器里跟 agent 对话、点审批、答提问、看挂起和恢复。
- **要部署到生产的开发者**：照着这个 demo 抄存储怎么接（官方包 + 自己的业务表共用一个数据库）、多副本怎么配、请求怎么转发。
- **框架维护者**：多副本强杀测试、挂起恢复的端到端测试都跑在这个 demo 上，一份代码守住全部集成行为。

## 3. 用户看到什么

### 3.1 零配置跑起来

```sh
pnpm install
pnpm build
pnpm chat:server   # 第一次启动自动建好 SQLite 库
pnpm chat:web
```

打开浏览器 → 注册一个账号（邮箱 + 密码，不发验证邮件）→ 新建会话 → 开始聊。

没配 key 时有两处替身，界面上都标得出来：

- **[演示模型](../../terms.md)**：会话页顶部标一个「演示模型」。它不是真 AI，只会按你的话做固定的事（见 §3.2）。
- **[本地沙盒](../../terms.md)**：新建会话的弹窗里，沙盒选项多了一个「本地」，没配云沙盒 key 时它是唯一选项。本地沙盒里预置了一个小示例项目，没有 git，也不联网。

### 3.2 跟演示模型对话

| 你发 | 它做什么 | 你能看到的交互 |
|---|---|---|
| `run: ls -la` | 调 bash 跑这条命令，再把输出说一遍 | 工具卡片、命令输出 |
| `run: rm -rf dist` | 同上，但这是危险命令 | **审批卡片**：允许 / 本会话都允许 / 拒绝 |
| `ask: 用 A 还是 B？` | 调 ask-user 向你提问 | **提问卡片** |
| 别的任何话 | 原样复述一遍，一个字一个字地流出来 | 流式输出；趁它还在说，可以试试「停止」「插话」「排队」 |

审批卡片不点，等[内存窗口](../../terms.md)过去（缺省 5 分钟，可以用 `CHAT_SUSPEND_MEMORY_WINDOW` 调短）就[挂起](../../terms.md)。之后随时回来点，这一轮会接着跑。

### 3.3 换成真 AI、真云沙盒

在 `.env` 里填上对应的 key，重启服务端：

| 想要 | 配什么 | 效果 |
|---|---|---|
| 真 AI | `DEEPSEEK_API_BASE_URL` + `DEEPSEEK_API_TOKEN` | 「演示模型」标记消失，换成真模型回答 |
| 云沙盒 | Vercel 或 E2B 的 key，外加 `GITHUB_REPO` + `GITHUB_PAT` | 新建会话时能选 Vercel / E2B，沙盒里拉你的仓库、开工作分支 |
| GitHub 登录 | `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET` | 登录页出现「用 GitHub 登录」按钮（没配时不显示） |
| 推送通知、联网搜索 | 跟现在一样 | 没配就不开 |

模型和沙盒是两件独立的事：可以真 AI 配本地沙盒，也可以演示模型配云沙盒。

### 3.4 换成 Postgres、开多个副本

```sh
DATABASE_URL=postgres://… pnpm --filter @runko-chat/node-server db:migrate   # 建表只跑一次
```

配了 `DATABASE_URL` 就用 Postgres，没配就用 SQLite。多副本再加两个配置：

| 配置 | 意思 |
|---|---|
| `RUNKO_NODE_URL` | 本副本能被别的副本访问到的地址，比如 `http://replica-a:3900` |
| `RUNKO_PEER_TOKEN` | 副本之间转发时用的暗号，各副本配成同一个值 |

用户无感：请求打到哪个副本都行。打到的副本不是这一轮的持有者时，会把请求[应用层转发](../../terms.md)给持有者。一个副本被强杀，最多 60 秒后别的副本接手；挂起中的会话，在任何副本上都能答。

想亲手看故障怎么被接住，有一套 docker 验证环境：一个 Postgres、三个副本、一个 nginx，外加一组强杀、冻住、断网的命令。用法沿用[多副本 · 功能](../../host/node/features/multi-replica.md)，只是镜像从 persist-demo 换成了 chat 应用。

## 4. 范围

**做：**

- chat 应用的存储全部换成 Kysely。框架的表用官方 `@runko/persist-kysely`，业务表和它共用一个数据库连接。
- 零配置：演示模型、本地沙盒、GitHub 相关配置改成可选、首次启动自动建表。
- Postgres 支持，外加多副本：转发、在场状态进库、docker 验证环境。
- 把 persist-demo 的多副本测试、挂起恢复测试搬过来，然后删掉 persist-demo。

**不做（非目标）：**

- **demo 不支持 MySQL 和 Mongo。** 这两种库的正确性由官方包自己的一致性测试在真库上守着（kysely 版 253 条、Mongo 版 78 条）。demo 只需要证明一条真实的部署路径。
- **不搬旧数据。** 换存储后用一个新的库文件，旧的 `data.db` 原样留在磁盘上不动（待确认，见[施工 · 待确认](../plans/unified-demo.md#待确认)）。
- **多副本下的单轮统计不合并。** 每个副本只记自己跑过的轮，统计弹窗可能看不全（见[技术方案 附录 A](../tech/unified-demo.md#附录-a-多副本下的单轮统计)）。
- **本地沙盒没有 git、没有网络。** 它用来演示交互，不是拿来真干活的。

## 5. 成功标准

1. 全新 clone，不填任何 key，按 §3.1 的命令能在浏览器里完成：注册 → 建会话 → `run: ls` → `run: rm -rf dist` 弹审批 → 允许 → `ask:` 提问并回答。
2. 配上 DeepSeek 和云沙盒的 key 之后，行为跟现在的 chat 应用一致，现有测试全部通过。
3. 用 Postgres 开三个副本：强杀持有者后另一个副本接手；挂起的审批在另一个副本上答了照样恢复。原 persist-demo 的多副本测试和挂起恢复测试在 chat 应用上全部跑通。
4. 单进程下崩溃重启，上一次没跑完的那一轮**立刻**标成「已停止」，不用等 60 秒。
5. 仓库里不再有 `apps/persist-demo`，文档和 CI 里也没有指向它的地方。
