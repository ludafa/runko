# chat 应用（服务端）

runko 的**唯一 demo**：一个能用的 AI 编程助手聊天应用。前端在 [`apps/web`](../web)。

功能、方案与施工见 [docs/ingress/features/unified-demo.md](../../docs/ingress/features/unified-demo.md)、
[技术方案](../../docs/ingress/tech/unified-demo.md)、[施工](../../docs/ingress/plans/unified-demo.md)。

## 跑起来（不需要任何账号）

```sh
pnpm install
pnpm build          # @runko/* 都是从 dist 导出的，先编译
pnpm chat:server    # 第一次启动会自动建好数据库
pnpm chat:web       # 另开一个终端
```

打开前端地址（缺省 <http://localhost:5273>）→ 注册一个账号（邮箱 + 密码，不发验证邮件）→ 新建会话。

什么 key 都没配时有两处替身，界面上都标得出来：

- **演示模型**：不联网。发 `run: ls -la` 它就跑命令，发 `ask: 你的问题` 它就弹提问卡片，别的话它复述一遍。
- **本地沙盒**：文件在服务端进程的内存里，预置了一个小示例项目。没有 git，也不联网。

想看审批卡片，发 `run: rm -rf dist`。

## 配上 key 之后

在仓库根的 `.env` 里填（`cp .env.template .env`）：

| 想要 | 配什么 |
| --- | --- |
| 真 AI | `DEEPSEEK_API_BASE_URL` + `DEEPSEEK_API_TOKEN` |
| 云沙盒（跑你自己的仓库） | Vercel 或 E2B 的 key，外加 `GITHUB_REPO` + `GITHUB_PAT` |
| GitHub 登录 | `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET` |
| 推送通知 | `VAPID_*` |
| 联网搜索 | `EXA_API_KEY` |

模型与沙盒是两件独立的事：真 AI 配本地沙盒、演示模型配云沙盒，都行。

## 换数据库

缺省是 SQLite（`DATABASE_PATH`，缺省 `data.db`），启动时自动建表。

配了 `DATABASE_URL` 就用 Postgres，此时**建表要显式跑一次**（多副本同时启动会撞在一起）：

```sh
DATABASE_URL=postgres://… pnpm --filter @runko-chat/node-server db:migrate
```

## 常用命令

```sh
pnpm chat:server                                   # 起服务端（跑着不退）
pnpm chat:web                                      # 起前端（跑着不退）
pnpm --filter @runko-chat/node-server db:migrate   # 建表 / 补新表，跑完即退
pnpm --filter @runko-chat/node-server test         # 测试
pnpm chat:bootstrap                                # 建表 + 重新生成 OpenAPI 与前端 client
```

## 里面有什么

```
src/
  db/          表类型、建表、建连（三拨表共用一个 Kysely 实例）
  agent/       起轮装配、沙盒（Vercel / E2B / 本地）、模型、审批策略、skill
  routes/      HTTP 与 SSE
  push/        推送通知
```

轮的生命周期（排队、插话、停止、挂起与恢复、崩溃恢复、多副本归属）都在 `@runko/agent` 里，
这个应用一行都不写——它只负责「这一轮用哪个模型、哪个沙盒、什么提示词」。
