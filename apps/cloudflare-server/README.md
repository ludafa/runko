# chat 应用（Cloudflare 版服务端）

同一个 chat 应用的 Cloudflare 版：**一个 Worker 装下全部**——前端（静态资源）、接口、D1 数据库、每个会话一个[会话对象](../../docs/terms.md)（Durable Object）、Cloudflare 沙盒（容器）。用起来和 [Node 版](../node-server/README.md)一样，前端也是同一份 [`apps/web`](../web)。

功能、方案与施工见 [功能手册](../../docs/host/cloudflare/features/chat-on-cloudflare.md)、[技术方案](../../docs/host/cloudflare/tech/chat-on-cloudflare.md)、[施工](../../docs/host/cloudflare/plans/chat-on-cloudflare.md)。

## 本地跑起来（不需要 Cloudflare 账号）

```sh
pnpm install
pnpm build                                    # @runko/* 都是从 dist 导出的，先编译
echo 'BETTER_AUTH_SECRET=local-dev-secret-at-least-32-characters' > apps/cloudflare-server/.dev.vars
pnpm cf:dev                                   # 跑着不退，缺省 http://localhost:8787
```

`cf:dev` 先编译共用层、打包前端，再在本地 D1 上建表，然后 `wrangler dev`。打开 <http://localhost:8787> → 注册 → 新建会话。和 Node 版一样，什么 key 都没配时用[演示模型](../../docs/terms.md)和[本地沙盒](../../docs/terms.md)（快照存在会话对象自己的 SQLite 里）。

- **本机没开 Docker**：在 `.dev.vars` 里加一行 `CLOUDFLARE_SANDBOX=off`，只用本地沙盒。开着 Docker 时 `wrangler dev` 会用它构建沙盒镜像。
- **想改前端时热更新**：另开一个终端 `SERVER_URL=http://localhost:8787 pnpm chat:web`，打开 Vite 的地址。

本地模拟器不会回收会话对象、也不限 CPU，所以「长任务不被掐断」这类平台行为只有部署到线上才看得到（[技术方案 §11.1](../../docs/host/cloudflare/tech/chat-on-cloudflare.md)）。

## 部署

### 1. 账号

- 一个 Cloudflare 账号，开通 **Workers 付费档（每月 5 美元）**：会话对象、容器沙盒、够 agent 用的 CPU 额度都在这一档。免费档每次请求只有 10 毫秒 CPU，跑不动。
- 本机登录：`pnpm --filter @runko-chat/cloudflare-server exec wrangler login`。
- 本机开着 Docker：部署时要在本机构建沙盒镜像再上传。

### 2. 一条命令

```sh
pnpm cf:deploy --dry-run   # 先预演：本地的几步真跑，远程的几步只打印
pnpm cf:deploy
```

脚本（[`scripts/deploy.mjs`](./scripts/deploy.mjs)）依次做：

1. 建 D1 数据库 `runko-chat`（已有就跳过），把它的 id 写回 `wrangler.jsonc`——**这处改动记得提交**，下次部署就不用再查。
2. 在远程 D1 上跑迁移（`migrations/` 下的 SQL，只跑没跑过的）。
3. 编译依赖、打包前端。前端与接口同源，不写死接口地址。
4. `wrangler deploy`：Worker、会话对象、沙盒镜像一起上去。没设过 `BETTER_AUTH_SECRET` 就生成一个随机值随这次部署一起上传，第一个版本上线时就带着它；已经设过就不动。

每一步都能重跑。部署完打开 `https://runko-chat.<你的子域>.workers.dev` 就能注册、聊天。

### 3. 密钥（按需）

都用 `pnpm --filter @runko-chat/cloudflare-server exec wrangler secret put <名字>` 填：

| 想要 | 填什么 |
| --- | --- |
| 真 AI | `DEEPSEEK_API_BASE_URL` + `DEEPSEEK_API_TOKEN`（不填就是演示模型） |
| GitHub 登录、选仓库、Cloudflare 沙盒 | GitHub App 那五项：`GITHUB_APP_ID` + `GITHUB_APP_SLUG` + `GITHUB_APP_PRIVATE_KEY` + `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET`，再加对外地址 `SERVER_URL`（如 `https://runko-chat.example.workers.dev`，GitHub 回调要用） |

GitHub App 怎么建见[按用户授权加载 GitHub 仓库](../../docs/ingress/features/github-repo-access.md)。**Cloudflare 沙盒只在配了 GitHub App 时出现在「新建会话」里**：它的工作区就是一个克隆下来的仓库。

其余配置与 Node 版同名（`SANDBOX_IDLE_TIMEOUT_MS`、`CHAT_APPROVAL_MODE`……），非密钥的可以写进 `wrangler.jsonc` 的 `vars`。

### 4. 用量提醒

Cloudflare 后台 → Manage Account → Notifications → 加一条 **Usage Based Billing** 提醒。5 美元里含的额度个人用基本用不完，最容易超的是沙盒（缺省规格约 6 小时/月）；**超了不停服、按量计费**，所以要留意的是钱（[功能手册 §3.1](../../docs/host/cloudflare/features/chat-on-cloudflare.md)）。

## 常用命令

```sh
pnpm cf:dev                                                     # 本地起全套（跑着不退）
pnpm cf:deploy --dry-run                                        # 部署预演
pnpm cf:deploy                                                  # 部署
pnpm --filter @runko-chat/cloudflare-server test                # 测试（真 workerd 里跑）
pnpm --filter @runko-chat/cloudflare-server generate:migrations # 改了表结构后导出下一个编号的 D1 迁移（可加 --name <名字>）
```

`test` 会先查 `migrations/` 与代码里的表结构有没有对上，对不上就让你先跑 `generate:migrations`。

## 里面有什么

```
src/
  index.ts                Worker 入口：导出 HTTP 处理器、会话对象类、沙盒类
  app.ts                  路由：登录、共用的会话接口、GitHub、能力开关
  backend.ts              会话后端的 Cloudflare 实现：会话里的事都交给会话对象（JS RPC）
  conversation-object.ts  会话对象：@runko/agent 的运行时就跑在这里，状态变化时回写列表
  db/                     D1 的 Kysely 方言、列表状态的 D1 副本
  sandbox/                Cloudflare 沙盒 provider、本地沙盒快照（存会话对象 SQLite）
  routes/ws.ts            直播流的 WebSocket 通道
scripts/                  D1 迁移导出、部署脚本
migrations/               D1 迁移 SQL（由脚本从 Kysely 迁移导出，不手写；发出去的文件不再改，只追加）
```

和 Node 版共用的部分（接口、数据访问、提示词、审批规则、GitHub App、路由）都在 [`apps/chat-shared`](../chat-shared)。轮的生命周期在 `@runko/agent` 里，把它装进 Durable Object 的那几行在 [`@runko/durable-object`](../../packages/durable-object/README.md)。
