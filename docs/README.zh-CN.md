# nimbo（中文）

> 英文版（根目录）见 [../README.md](../README.md)。

**可嵌入 Node.js 应用的轻量 agent SDK**：几行代码在自己的服务里跑起一个具备文件操作、命令执行、skills 能力的 agent loop——不 spawn 任何外部 CLI 二进制，运行时依赖只有 `ai`（Vercel AI SDK，peer）+ `zod`。

## 为什么需要它

现有方案的空缺（详见 [docs/01 产品设计](./01-product-design.md)）：

- **CLI 封装类**（`@openai/codex-sdk`、`@anthropic-ai/claude-agent-sdk`）：本质是 spawn 平台二进制的进程包装——重、绑定单一厂商、**没有虚拟文件抽象**（agent 只能操作真实磁盘）、会话状态落在用户目录，服务端多租户场景难用。
- **纯 API client**（`@anthropic-ai/sdk`、`openai`）：只给 messages/tool-use 原语，loop、工具、文件、skills 全要自己搭。
- **eve**（API 设计优秀，nimbo 的 API 层次即参考它）：但它是带 HTTP server 与 durable workflow 的**框架**，不是可嵌入进程内的库；文件操作在真实沙盒。

**核心痛点**：想在普通 Node 服务里嵌入"能改文件、能执行任务"的 agent，要么被绑死在某家 CLI 上，要么从零手写 loop。

**nimbo 的答案** = eve 的 API 人体工学 + codex-sdk 的 item 级事件粒度 + AI SDK 的模型层（30+ provider 任选）+ 自有的 VirtualFS 内核与 loop，以可嵌入库的形态交付。关键差异化：**虚拟文件系统**——agent 的所有文件读写默认落在内存/overlay 层，全程不碰真实磁盘，天然多租户安全；结束后 `diff()` 导出、`writeBack()` 才落盘。

典型场景：SaaS 内嵌代码助手（改代码返回 diff，零临时文件）、CI/后台流水线节点（结构化输出接回流水线）、带领域能力的 agent 产品（SKILL.md 生态复用）、自定义执行环境（宿主沙盒经 `NimboExec` 接口注入，loop 零改动）。

## 5 行上手

```ts
import { defineAgent, createSession, NimboFS } from "@nimbo/sdk";
// 或直连 provider：import { anthropic } from "@ai-sdk/anthropic"; model: anthropic("claude-sonnet-5")

const agent = defineAgent({ model: "anthropic/claude-sonnet-5" });   // AI SDK Gateway 字符串或任意 LanguageModel 实例
const session = createSession(agent, { fs: NimboFS.fromDirectory("./project") });
const result = await session.send("把 src/index.ts 里的 var 全部改成 const");
console.log(result.finalResponse, await session.fs.diff());
```

`./project` 被零拷贝 overlay 挂载：读穿透磁盘、写落内存层——上面这段跑完，真实目录一个字节都没变，变更全在 `diff()` 里；要落盘调 `session.fs.writeBack()`。

```sh
pnpm add @nimbo/sdk ai
```

> TODO：npm 裸名 `nimbo` 的发布决策待定（docs/03 P7-1 遗留）——目前一律 `@nimbo/sdk`，定了之后全部 README/examples 的 import 同步替换。

## 包结构（pnpm monorepo，依赖单向，8 包）

```mermaid
graph TD
    subgraph bundled["随 @nimbo/sdk 一起装"]
        sdk["@nimbo/sdk<br/>门面 · batteries-included"]
        core["@nimbo/core"]
        vfs["@nimbo/virtual-fs"]
        mini["@nimbo/mini-bash"]
    end
    subgraph separate["单独安装（只依赖 core，不随 sdk 装入）"]
        just["@nimbo/just-bash<br/>全语法档 bash"]
        e2b["@nimbo/sandbox-e2b"]
        vercel["@nimbo/sandbox-vercel"]
        cf["@nimbo/sandbox-cloudflare"]
    end
    sdk --> vfs
    sdk --> core
    sdk --> mini
    vfs --> core
    mini --> core
    just --> core
    e2b --> core
    vercel --> core
    cf --> core
```

箭头表示「依赖」。`@nimbo/sdk` 打包 `core` + `virtual-fs` + `mini-bash`；`just-bash`
与三个沙盒适配器只依赖 `core`、需单独安装。每个包的细节见下方表格。

| 包 | 一句话 | README |
|---|---|---|
| `@nimbo/sdk` | 主包门面，5 行上手只装它 | [packages/sdk](../packages/sdk/README.md) |
| `@nimbo/core` | L0 接口 / L1 定义层 / L2 运行层 / L3 目录约定层 / 内置工具本体 | [packages/core](../packages/core/README.md) |
| `@nimbo/virtual-fs` | MemoryFS / OverlayFS / DirFS、diff / writeBack、文件工具八件套 | [packages/virtual-fs](../packages/virtual-fs/README.md) |
| `@nimbo/mini-bash` | 跑在任意 NimboFS 上的只读命令解释器（bash 工具的纯内存执行环境，零依赖极简档，随 sdk 装入） | [packages/mini-bash](../packages/mini-bash/README.md) |
| `@nimbo/just-bash` | 跑在任意 NimboFS 上的全语法档 bash（`if`/`for`/`while`/`case`/函数，vercel-labs/just-bash 适配器，**不随 sdk 装入**，需单独 `pnpm add`） | [packages/just-bash](../packages/just-bash/README.md) |
| `@nimbo/sandbox-e2b` | NimboFS & NimboExec 适配 E2B 云沙盒（真实 Firecracker microVM，BYO 实例，e2b 仅类型依赖，**不随 sdk 装入**） | [packages/sandbox-e2b](../packages/sandbox-e2b/README.md) |
| `@nimbo/sandbox-vercel` | NimboFS & NimboExec 适配 Vercel Sandbox（真实 Amazon Linux 2023 Firecracker microVM，BYO 实例，`@vercel/sandbox` 仅类型依赖，**不随 sdk 装入**） | [packages/sandbox-vercel](../packages/sandbox-vercel/README.md) |
| `@nimbo/sandbox-cloudflare` | NimboFS & NimboExec 适配 Cloudflare Sandbox（网关形态：`.` 纯 fetch 客户端跑在任意 Node，`./worker` 网关部署在宿主 wrangler 项目，**不随 sdk 装入**） | [packages/sandbox-cloudflare](../packages/sandbox-cloudflare/README.md) |

**bash 分档说明**：`bash` 工具的命令执行环境（`NimboExec`）分两档，按需二选一注入，一行代码互换、loop/session 代码零改动（[docs/02 §4.5b](./02-tech-spec.md)）——

- **`@nimbo/mini-bash`（零依赖极简档）**：六个只读命令（`cat`/`grep`/`find`/`tail`/`head`/`echo`）+ 四个控制操作符，随 `@nimbo/sdk` 一起装，无需额外安装，定位安全默认与测试/演示载体。
- **`@nimbo/just-bash`（全语法档）**：Claude 系模型高频产出的 `if`/`for`/`while`/`case`/函数等控制流脚本超出 mini-bash 语法面时换这一档。因依赖树含 sql.js / quickjs-emscripten 等 wasm 大件，**不进 `@nimbo/sdk` 依赖**，需要的宿主显式 `pnpm add @nimbo/just-bash`。

两档都是 `NimboExec` 接口的实现，也都不是唯一选项——真实本机命令执行用 `@nimbo/core` 的 `localExec`，宿主自有沙盒（Docker/e2b/远程执行器）直接实现 `NimboExec` 注入即可（示例见 [examples/05-custom-exec.ts](../examples/05-custom-exec.ts)）。

## 云沙盒适配器

三个适配器把 agent 的 fs/bash 放进真实云沙盒里，而 agent 本身跑在任意 Node 机器上——同一种「模式 A 同源工作区」形态（一个对象实现 `NimboFS & NimboExec`，经 `workspace` 注入）。调研与设计决策见 [docs/06 沙盒调研](./06-sandbox-workspace-research.md)；E2B 和 Vercel 已对真实沙盒验证，Cloudflare 走自部署网关。

## 示例应用：chat agent 网页应用

[`apps/`](../apps) 下是一个**基于** nimbo 构建的完整 chat agent 网页应用——SDK 的一个产品形态的具体演示。用户在 chat 界面里驱动 agent 在 Vercel 沙盒里修改真实仓库、开 PR、触发 Vercel 部署。亮点：会话级沙盒生命周期（活跃时保持、空闲快照休眠、下一条消息带分支代码恢复）、loop 每个事件断线可续地 SSE 流式推给前端（刷新/HMR 不断）、完整对话 SQLite 持久化、streamdown markdown 渲染、每轮 token 统计（含缓存命中）。设计见 [docs/08 chat webapp](./08-chat-agent-webapp.md)。

```sh
cp .env.template .env         # 填入必需的 key（见模板注释）
pnpm install
pnpm chat:bootstrap           # db migrate + openapi + api client 生成
pnpm chat:server              # API 服务
pnpm chat:web                 # web 开发服务器
```

## 更多

- **可运行示例**：[examples/](../examples/README.md)——内存 diff、目录挂载、skills、mini-bash、自定义 exec 注入、结构化输出、流式消费、全语法档 just-bash、E2B/Vercel/Cloudflare 三个云沙盒工作区适配、真实项目端到端设计优化 + Git 工作流，十二个脚本均可无 API key/云凭证试跑（缺 env/凭证只跑确定性段并干净退出；最后一个脚本的真机段一旦配齐凭证会真实修改目标 GitHub 仓库，运行前见其文件头/examples/README 的须知）。
- **设计文档**：[产品设计](./01-product-design.md) · [技术实现](./02-tech-spec.md) · [施工计划](./03-construction-plan.md) · [内置工具规格](./04-builtin-tools.md) · [验证方案](./05-verification.md) · [沙盒调研](./06-sandbox-workspace-research.md) · [端到端设计示例](./07-sandbox-e2e-design-example.md) · [chat webapp](./08-chat-agent-webapp.md) · [沙盒规范](./nimbo-sandbox-spec.md)
- **开发**：`corepack pnpm install && corepack pnpm build && corepack pnpm typecheck && corepack pnpm test`（顺序 build 先行——workspace 循环 devDep 下跨包类型解析指向 dist）。Node ≥ 20（examples 与 L3 `tools/*.ts` 动态加载需 ≥ 22.18 原生 TS）。根 build/typecheck/test 脚本只作用于 `./packages/*`；apps 有自己的 `chat:*` 脚本。
