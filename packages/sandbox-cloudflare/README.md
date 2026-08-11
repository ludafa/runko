# @nimbo/sandbox-cloudflare

把一个 [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/)（真实 Linux 容器）通过一个自部署的 HTTP 网关包成 `NimboFS & NimboExec`，一次注入 `createSession(agent, { workspace })`——"模式 A 同源工作区"落在真实云沙盒上的实现（对照 [docs/core/core-sdk/tech.md §4.5a](../../docs/core/core-sdk/tech.md) / [docs/host/sandbox/tech.md §8](../../docs/host/sandbox/tech.md)）。

与 E2B/Vercel 两个适配器架构不同：Cloudflare Sandbox 只能从 Cloudflare Worker 内部访问（Durable Object binding），没有办法从任意 Node 进程直连——因此本包是**两个入口**：

- `.`（本文档的客户端，跑在**任意** Node ≥20 进程）：纯 `fetch` 协议客户端，不 import `@cloudflare/sandbox`（该包只能在 workerd 里加载）。
- `./worker`（网关，部署在**宿主自己的** wrangler 项目里）：把协议翻译成对真实 `@cloudflare/sandbox` 的调用。

## 安装

```sh
pnpm add @nimbo/sandbox-cloudflare
```

客户端侧零 provider SDK——本包不随 `@nimbo/sdk` 一起装，属于按需显式安装的可选集成。网关侧 `@cloudflare/sandbox` 是本包的 `peerDependency`（版本跟宿主的 wrangler 项目走），装在部署网关的那个 wrangler 项目里，不装在跑 agent 的 Node 进程里。

## 网关部署

先把网关部署到你自己的 Cloudflare 账号（需要 Workers Paid 计划，无免费层）。一个完整可跑可部署的参考项目见 [apps/cloudflare-worker-server/](../../apps/cloudflare-worker-server/README.md)——自备 CF 账号后 `pnpm --filter @nimbo-chat/cloudflare-worker-server deploy` 即可部署；本包自身只发布 `createSandboxGateway` 这层纯函数，网关的部署形态维护在该项目里。核心装配只有几行：

```ts
// 你的 wrangler 项目的 Worker 入口（见 apps/cloudflare-worker-server/src/index.ts）
import { getSandbox } from "@cloudflare/sandbox";
import { createSandboxGateway } from "@nimbo/sandbox-cloudflare/worker";

export { Sandbox } from "@cloudflare/sandbox"; // Durable Object 类必须从 Worker 入口导出

export default {
  async fetch(request: Request, env: { Sandbox: DurableObjectNamespace; NIMBO_GATEWAY_TOKEN: string }) {
    const gateway = createSandboxGateway({
      token: env.NIMBO_GATEWAY_TOKEN,
      getSandbox: (sandboxId) => getSandbox(env.Sandbox, sandboxId),
    });
    return gateway.fetch(request);
  },
};
```

## 快速上手（客户端）

```ts
import { cloudflareWorkspace } from "@nimbo/sandbox-cloudflare";
import { createSession, defineAgent } from "@nimbo/sdk";

const workspace = cloudflareWorkspace({
  url: process.env.NIMBO_CF_GATEWAY_URL!,     // 部署好的网关 URL
  token: process.env.NIMBO_CF_GATEWAY_TOKEN!, // 与 `wrangler secret put NIMBO_GATEWAY_TOKEN` 相同的值
});
const session = createSession(defineAgent({ model: "anthropic/claude-sonnet-5" }), { workspace });
const result = await session.send("在 notes.txt 里写一句问候语，然后用 bash 验证内容。");
console.log(result.finalResponse);
```

没有 `Sandbox` 风格的 SDK 对象需要创建/销毁——沙盒生命周期由宿主的 wrangler 项目（`getSandbox()` 那一行）管理，不由这个客户端管理。

完整可跑示例（含**零部署**的进程内 client → gateway → fake sandbox 完整协议往返演示）见 [examples/src/11-sandbox-cloudflare.ts](../../examples/src/11-sandbox-cloudflare.ts)。

## 结构化接口 / BYO

```ts
// 客户端（"."）
function cloudflareWorkspace(opts: { url: string; token: string; sandboxId?: string; fetch?: typeof fetch }): NimboFS & NimboExec;

// 网关（"./worker"）
function createSandboxGateway(opts: { token: string; getSandbox: (sandboxId: string) => CfSandboxLike | Promise<CfSandboxLike> }): {
  fetch(request: Request): Promise<Response>;
};
```

- 客户端没有"实例"概念（E2B/Vercel 是 BYO 一个已创建的沙盒对象；这里 BYO 的是一个已部署的**网关**——一个 URL + token）；`fetch` 可注入自定义传输（测试/演示用直连网关 handler，见 examples 11 的进程内演示）。
- `CfSandboxLike` 是以 `@cloudflare/sandbox@0.12.3` 的 `ISandbox` 为蓝本手写的结构化最小子集（`exec`/`readFile`/`writeFile`/`mkdir`/`deleteFile`/`listFiles`）——`./worker` 运行时零 `import "@cloudflare/sandbox"`，真实装配（`getSandbox(env.Sandbox, id)` 的返回值）天然结构兼容这个接口，留给宿主项目经 `createSandboxGateway({ getSandbox })` 注入。
- 全部 `POST` + JSON body，`Authorization: Bearer <token>` 鉴权，`x-nimbo-sandbox` 头选择沙盒（缺省 `"default"`），二进制经 base64，`/exec` 走 NDJSON 流式响应——完整协议见 [docs/host/sandbox/tech.md §8.3](../../docs/host/sandbox/tech.md)。

## 已知限制（docs/host/sandbox/tech.md §8.2–§8.3 / docs/core/core-sdk/plan.md P10-3 实际改动，如实照抄不发明）

- **路径锚定是隐式的、发生在网关一侧，没有 `root` 配置项**：不同于 E2B/Vercel 的客户端 `opts.root`，这里的虚拟根 `/` 锚定在**沙盒自身的默认工作目录**——网关把客户端送来的虚拟绝对路径去掉前导 `/` 就得到沙盒相对路径，两端都不需要显式配置真实目录。**副作用**：bash 命令里带前导 `/` 的绝对路径（如 `cat /notes.txt`）落在沙盒真实文件系统根，而不是虚拟工作区根——同一份文件要在文件工具和 bash 之间互通，bash 侧要用相对路径。这是"真实 FS + root 锚定"的固有语义，E2B（`/home/user`）/Vercel（`/vercel/sandbox`）同样存在，只是那两家的锚点是客户端可见的配置项，这里锚点藏在网关内部。
- **`readdir`/`stat` 对 symlink 与其他非常规条目一律归一为 `"file"`**——真实沙盒文件系统没有 `MemoryFS` 那种"reference"概念。
- **`mtime` 精度是容器真实的文件修改时间**（常见是秒级精度），不是 `MemoryFS` 那种毫秒级递增时间戳。
- **每次 NimboFS/NimboExec 调用都是一次 HTTP 往返**（经 Durable Object，几十到几百毫秒）——扫描类操作（globbing 大目录树、grep-like 搜索）优先用一条 bash 命令（`find`/`grep`），而不是逐个文件工具调用。
- **沙盒生命周期（idle 睡眠、重启、过期）由宿主的 wrangler 项目管理**，不由这个客户端/网关管理——沙盒不可达时以网关错误的形式从 `exec()`/文件方法浮出，宿主负责唤醒或重建沙盒。沙盒磁盘本身是临时的：Durable Object idle 睡眠（默认 10 分钟）后文件系统丢失（见 [apps/cloudflare-worker-server/README.md](../../apps/cloudflare-worker-server/README.md)），长期数据需要宿主自己接 R2 backup，v1 网关不代理这一层。
