# cloudflare-worker-server

> 文档：[产品视角](../../docs/host/cloudflare/features/cloudflare-worker-server.md) · [技术方案](../../docs/host/cloudflare/tech/cloudflare-worker-server.md) · [施工进展](../../docs/host/cloudflare/plans/cloudflare-worker-server.md)
> 相关：[sandbox 技术方案](../../docs/host/contract/tech/sandbox.md)（§6 网关形态与协议、§7 workerd 实测）
> 术语：[沙盒](../../docs/terms.md) · [网关形态](../../docs/terms.md)

## 这是什么

一个跑在 Cloudflare Worker 里的 runko 服务端——**一个完整可部署的示例项目**（不发布，也不是 `apps/node-server` 的 Workers 版替代品）。

它同时扮演**两个角色**，共用同一套 `getSandbox` 接线、同一个 Durable Object binding、同一份 Dockerfile：

| 角色 | 路由 | 谁来用 |
|---|---|---|
| ① 服务端自驱 | `/sandbox-check`、`/agent`、`/debug/exec` | 这个 Worker 自己（runko 会话就跑在里面，进程内直连沙盒） |
| ② 对外网关 | `ALL /gateway/*` | **任意 Node 机器**上的 `cloudflareWorkspace({ url, token })` |

角色 ② 就是 [`examples/src/11-sandbox-cloudflare.ts`](../../examples/src/11-sandbox-cloudflare.ts) 真机段需要的那个网关。

## 为什么这两件事能合成一个 Worker

`@runko/sandbox-cloudflare` 是[网关形态](../../docs/terms.md)：runko 的前提是「agent 跑在任意电脑」，而 CF [沙盒](../../docs/terms.md)只能从 Worker 内部经 Durable Object binding 访问，所以要自部署一个 HTTP 网关把两边接起来（[sandbox 技术方案 §6](../../docs/host/contract/tech/sandbox.md)）。角色 ② 就是那个网关。

而角色 ① 的服务端自己就在 Worker 里——客户端与网关同进程，那层 HTTP 不必真过网络：

```
createSandboxGateway({ getSandbox: id => getSandbox(env.Sandbox, id) })   ← 网关（./worker 入口）
cloudflareWorkspace({ fetch: req => gateway.fetch(req) })                 ← 客户端（. 入口）
```

**一行新适配器代码都不用写**，复用两端现成的、有契约测试覆盖的实现，只把 TCP 那一跳短路掉。代价是文件操作仍走一遍 JSON+base64 编解码——刻意保留，因为这让两个角色走**完全同构**的代码路径。

## 前置条件

| 项 | 说明 |
|---|---|
| **Workers Paid 计划** | CF 沙盒**无免费层**（$5/月起） |
| **Docker 守护进程** | `wrangler dev` 本地跑容器沙盒必需；首次构建镜像 2–3 分钟 |
| **CF 登录** | `wrangler login`（部署必需） |
| DeepSeek 凭证 | 仅 `POST /agent` 需要；`/sandbox-check` 不需要 |
| 网关 token | 仅 `ALL /gateway/*` 需要（`RUNKO_GATEWAY_TOKEN`） |

## 本地跑起来

```bash
# 1) 密钥（值可从仓库根 .env 抄）
cp .dev.vars.example .dev.vars   # 然后按需填 DEEPSEEK_API_TOKEN / RUNKO_GATEWAY_TOKEN

# 2) 起本地 Worker（需 Docker 已在跑）
pnpm dev
```

然后：

```bash
# 核心探针 —— 不需要模型凭证，只证明 Worker 能驱动真沙盒
curl http://localhost:8787/sandbox-check

# 完整 agent 会话 —— 工具全落在 CF 沙盒上
curl -X POST http://localhost:8787/agent \
  -H 'content-type: application/json' \
  -d '{"prompt":"用 write-file 在 /hello.txt 写一句问候语，然后用 bash 执行 `cat hello.txt`（相对路径）验证内容一致。"}'

# 独立核验模型的自述（不采信 finalResponse）
curl 'http://localhost:8787/debug/exec?cmd=cat%20hello.txt'
```

> 建议先跑 `/sandbox-check`——它把「Worker 里到底能不能驱动真沙盒」这个最大未知数单独隔出来，且零凭证。它过了再跑 `/agent`。

## 部署 + 当网关用

```bash
wrangler login                              # 首次
wrangler secret put RUNKO_GATEWAY_TOKEN     # 输入一个强随机值
pnpm deploy                                 # 首次部署后等 2–3 分钟容器 provisioning
```

然后在**任意 Node 机器**上接入。注意 URL **必须带 `/gateway` 前缀**：

```ts
import { cloudflareWorkspace } from '@runko/sandbox-cloudflare';

const workspace = cloudflareWorkspace({
  url: 'https://runko-cloudflare-worker-server.<your-subdomain>.workers.dev/gateway',
  token: process.env.RUNKO_CF_GATEWAY_TOKEN,
});
createSession(agent, { workspace });
```

> **为什么要带前缀**：客户端把端点常量（`/fs/read`、`/exec` …）直接拼在 `url` 后面，而网关按 pathname 精确匹配这些常量。Worker 收到 `/gateway/fs/read` 后会剥掉 `/gateway` 再转交。挂前缀是为了不与本项目自己的路由（`/health`、`/agent`、`/debug/exec`）打架。

跑 11 号示例的真机段时，把这两个值填进仓库根 `.env`：

```
RUNKO_CF_GATEWAY_URL=https://runko-cloudflare-worker-server.<your-subdomain>.workers.dev/gateway
RUNKO_CF_GATEWAY_TOKEN=<与 secret 相同的值>
```

## 路由

| 路由 | 作用 | 需要模型 |
|---|---|---|
| `GET /` | 自述 | 否 |
| `GET /health` | 存活检查（不碰沙盒） | 否 |
| `GET /sandbox-check` | **探针**：exec + 文件往返 + 同源工作区校验 | 否 |
| `GET /debug/exec?cmd=` | 调试：直接在沙盒里跑一条命令（生产不该有这种入口） | 否 |
| `POST /agent` | 跑一次真 agent 会话 | 是 |
| `ALL /gateway/*` | **对外网关端点**（需 `RUNKO_GATEWAY_TOKEN`，未配置返回 503） | 否 |

## 刻意不在范围内

- D1 替换 `better-sqlite3`、better-auth 移植、chat 的 conversations/messages 路由——**这不是 `apps/node-server` 的 Workers 版**
- CF 沙盒 idle 睡眠丢文件系统 与 chat「未提交改动原样还原」的语义落差（产品决策，非工程量）

理由与完整卡点清单见[施工进展](../../docs/host/cloudflare/plans/cloudflare-worker-server.md)。

## 已知缺陷

`AbortSignal` 跨不过 Durable Object RPC 边界，而网关会把 `request.signal` 转发给 `sandbox.exec()`——真机上必然报 `AbortSignal serialization is not enabled.`。本项目用 `stripAbortSignal()` 在示例侧绕过（**两个角色都生效**），不改产品代码。包该怎么修仍待拍板，见[技术方案 §5](../../docs/host/cloudflare/tech/cloudflare-worker-server.md)。

## 版本耦合

`Dockerfile` 的镜像 tag 必须与 `package.json` 里 `@cloudflare/sandbox` 的版本一致——版本错配是这个 SDK 最常见的疑难运行时错误来源。
