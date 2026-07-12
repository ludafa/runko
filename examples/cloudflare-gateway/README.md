# nimbo sandbox gateway（Cloudflare Worker 模板）

把 Cloudflare Sandbox 暴露给任意 Node 机器上的 `@nimbo/sandbox-cloudflare` 客户端。
背景与协议见 [docs/06 §8.2–§8.3](../../docs/06-sandbox-workspace-research.md)。

Cloudflare Sandbox 只能从 Workers 内部访问（Durable Object binding），因此接入
nimbo 需要先把本目录部署成你自己的网关。**需要 Workers Paid 计划（$5/月起），无免费层。**

## 部署步骤

```bash
cd examples/cloudflare-gateway
npm install
npx wrangler login                          # 首次
npx wrangler secret put NIMBO_GATEWAY_TOKEN # 输入一个强随机密钥（客户端要用同一个值）
npx wrangler deploy                         # 首次部署后等 2–3 分钟容器 provisioning
```

本地调试用 `npm run dev`（需要 Docker 在本机运行，首次构建容器镜像 2–3 分钟）。

## 客户端接入

部署完成后，把这两个值填进根 `.env`：

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

见 `examples/11-sandbox-cloudflare.ts` 的完整示例。

## 注意事项

- `Dockerfile` 的镜像 tag 必须与 `package.json` 里 `@cloudflare/sandbox` 的版本一致。
- 沙盒磁盘是临时的：Durable Object idle 睡眠（默认 10 分钟）后文件系统丢失
  （docs/06 §2 生命周期行）；长期数据用 R2 backup / bucket mount，v1 网关不代理这些。
- 本模板通过 `file:../../packages/sandbox-cloudflare` 引用工作区包；发布到 npm 后
  改成正式版本号即可独立使用。
