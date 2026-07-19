# Cloudflare Sandbox 网关 —— 参考实现（自备 CF 环境）

这是 [`examples/src/11-sandbox-cloudflare.ts`](../src/11-sandbox-cloudflare.ts) **真机段**所需网关的一份**参考实现**，不是一个可原地运行/部署的项目——它没有 `package.json`、不装依赖、不进本仓的 typecheck，也不随 npm 发布。要跑 11 号的真机段，你**自备一个 Cloudflare 环境**，把这三个文件拷进你自己的 wrangler 项目再部署。

背景与协议见 [docs/tech/sandbox.md §8.2–§8.3](../../../docs/tech/sandbox.md)。

## 为什么需要它

Cloudflare Sandbox 只能从 Worker 内部访问（Durable Object binding）——`@nimbo/sandbox-cloudflare` 的客户端跑在任意 Node 机器上、连不上它。所以想让 agent 用上真实的 Cloudflare 沙盒，你得在自己的 Cloudflare 账号里立一个 Worker，把客户端的 HTTP+NDJSON 协议翻译成对沙盒的调用。这份参考就是那个 Worker 的最小装配。**需要 Workers Paid 计划（$5/月起），无免费层。**

协议翻译本身在 `@nimbo/sandbox-cloudflare/worker` 的 `createSandboxGateway()` 里（零 `@cloudflare/sandbox` import、纯 Node、有完整契约测试）；这里唯一多做的、也是唯一只能在 workerd 里做的事，就是 [`index.ts`](./index.ts) 那行 `getSandbox(env.Sandbox, id)` 的接线。

## 三个文件

| 文件 | 作用 |
|---|---|
| [`index.ts`](./index.ts) | Worker 入口：注入 `getSandbox` 装配出网关（约 15 行） |
| [`wrangler.jsonc`](./wrangler.jsonc) | Durable Object binding + 容器 + 迁移配置 |
| [`Dockerfile`](./Dockerfile) | 沙盒容器镜像（tag 必须与你装的 `@cloudflare/sandbox` 版本一致） |

## 部署步骤（在你自己的 wrangler 项目里）

```bash
# 1) 新建一个空目录，把本参考的三个文件拷进去
npm init -y
npm i @nimbo/sandbox-cloudflare @cloudflare/sandbox
npm i -D wrangler

# 2) 部署
npx wrangler login                          # 首次
npx wrangler secret put NIMBO_GATEWAY_TOKEN # 输入一个强随机密钥（客户端要用同一个值）
npx wrangler deploy                         # 首次部署后等 2–3 分钟容器 provisioning
```

本地调试用 `npx wrangler dev`（需要 Docker 在本机运行，首次构建容器镜像 2–3 分钟）。

> 本仓开发期用 `workspace:*` 直连 `@nimbo/sandbox-cloudflare` 的源码；你在自己的项目里则按上面 `npm i` 装发布后的正式版本。

## 客户端接入

部署完成后，把这两个值填进 nimbo 仓库根 `.env`（供 11 号真机段读取）：

```
NIMBO_CF_GATEWAY_URL=https://nimbo-sandbox-gateway.<your-subdomain>.workers.dev
NIMBO_CF_GATEWAY_TOKEN=<与 secret 相同的值>
```

然后在任意 Node 机器上：

```ts
import { cloudflareWorkspace } from "@nimbo/sandbox-cloudflare";

const workspace = cloudflareWorkspace({
  url: process.env.NIMBO_CF_GATEWAY_URL,
  token: process.env.NIMBO_CF_GATEWAY_TOKEN,
});
createSession(agent, { workspace });
```

完整示例见 [`examples/src/11-sandbox-cloudflare.ts`](../src/11-sandbox-cloudflare.ts)。

## 注意事项

- `Dockerfile` 的镜像 tag 必须与你安装的 `@cloudflare/sandbox` 版本一致。
- 沙盒磁盘是临时的：Durable Object idle 睡眠（默认 10 分钟）后文件系统丢失
  （docs/tech/sandbox.md §2 生命周期行）；长期数据用 R2 backup / bucket mount，v1 网关不代理这些。
