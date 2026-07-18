# nimbo examples

十二个可独立运行的示例脚本，每个演示 nimbo 的一块核心能力。每个脚本都分两段：

1. **确定性段**——不需要模型、不需要任何环境变量，直接演练 VirtualFS / NimboExec / skills 的机制本身，输出形状恒定；
2. **模型驱动段**——真实 agent loop，需要配置 `NIMBO_MODEL`。未配置时脚本打印配置指引后**干净退出**（exit 0），不会崩溃。

| 脚本 | 演示点 | 对应产品场景（docs/features/core-sdk.md §3） |
|---|---|---|
| [`01-memory-diff.ts`](./01-memory-diff.ts) | 纯内存工作区：agent 改代码，宿主拿 `diff()`，全程不碰磁盘 | SaaS 内嵌代码助手 |
| [`02-dir-mount.ts`](./02-dir-mount.ts) | 真实目录 overlay 挂载：读穿透、写落内存，`writeBack()` 才落盘 | 安全地把真实项目交给 agent |
| [`03-skills.ts`](./03-skills.ts) | SKILL.md 加载（flat + packaged）、渐进式披露、`load_skill` 工具 | 带领域能力的 agent 产品 |
| [`04-mini-bash.ts`](./04-mini-bash.ts) | 同源工作区：文件工具与 `bash` 共享同一个 NimboFS（mini-bash 纯 TS 解释器） | 零依赖的命令执行面 |
| [`05-custom-exec.ts`](./05-custom-exec.ts) | 从零实现 `NimboExec` 注入自定义执行环境，loop 代码零改动 | 宿主自有沙盒/远程执行器 |
| [`06-structured-output.ts`](./06-structured-output.ts) | `send<T>(input, { outputSchema })` 结构化输出（zod 校验 + 重试） | 自动化流水线节点 |
| [`07-streaming.ts`](./07-streaming.ts) | `session.stream()` 实时消费：`item.updated` 文本增量、`tool_call` 状态流转、`turn.completed` usage，手动 `.next()` 驱动拿到生成器的 `TurnResult` 返回值 | 需要打字机式 UI 或工具调用实时反馈的宿主 |
| [`08-just-bash.ts`](./08-just-bash.ts) | 同源工作区的全语法档 bash（`@nimbo/just-bash`，独立安装）：真实 if/for/函数/重定向脚本，非流式 `onOutput` 契约 | Claude 系模型高频产出的控制流脚本（mini-bash 六命令撑不住的场景） |
| [`09-sandbox-e2b.ts`](./09-sandbox-e2b.ts) | NimboFS & NimboExec 适配 E2B 云沙盒（`@nimbo/sandbox-e2b`，独立安装）：确定性段用几十行的进程内 fake 演示结构化接口，真机段驱动一个真实 E2B Firecracker microVM | 宿主想把 agent 的文件/命令面放进真实云沙盒而非虚拟内存 |
| [`10-sandbox-vercel.ts`](./10-sandbox-vercel.ts) | NimboFS & NimboExec 适配 Vercel Sandbox（`@nimbo/sandbox-vercel`，独立安装）：同 09 的确定性段/真机段结构，真机段驱动一个真实 Vercel Sandbox | 同上，选 Vercel 作为云沙盒提供商 |
| [`11-sandbox-cloudflare.ts`](./11-sandbox-cloudflare.ts) | NimboFS & NimboExec 适配 Cloudflare Sandbox（`@nimbo/sandbox-cloudflare`，独立安装，网关形态）：确定性段是本示例集的亮点——client → 网关 → fake 沙盒的完整协议往返全部在一个进程内跑通，零部署零网络；真机段驱动一个已部署的真实网关 | 同上，选 Cloudflare 作为云沙盒提供商（需要额外部署一个网关，见下方 `cloudflare-gateway/` 说明） |
| [`12-vercel-sandbox-real-project.e2e.test.ts`](./12-vercel-sandbox-real-project.e2e.test.ts) | 真实项目端到端：nimbo agent 在真实 Vercel Sandbox 里 clone 你自己的 GitHub 仓库、从沙盒文件系统装载官方 `frontend-design` skill（`Skill.fromFS`）、做一次聚焦的设计优化，并自主走完整 Git 工作流（建分支→commit→push→开 PR）；`.e2e.test.ts` 后缀只是文件名，仍是 `node` 直跑的脚本，不是 vitest 用例（见文件头注释） | 让 agent 在你真实项目上做一次有 Git 工作流闭环的自主改动 |

09/10/11 每个脚本的"模型驱动段"额外多一层 gate：先 `resolveModel()`（模型未配置 → 指引 + `exit 0`），再检查对应云厂商的凭证环境变量（缺失 → 打印指引后**干净 `return`**，不创建沙盒、不发起任何模型调用）——两者都配置好才会真正创建沙盒并跑一次真实 agent 任务。

**⚠️ 12 号运行前须知**：与 01–11 不同，12 号的真机段一旦四项凭证（DeepSeek + `GITHUB_REPO` + `GITHUB_PAT` + 三个 `VERCEL_*`）都配置好，**会真实修改你在 `GITHUB_REPO` 指向的仓库**——真实创建分支、真实 commit、真实 push、真实在该仓库开一个 Pull Request（用 `GITHUB_PAT` 的身份）。这不是沙盒内的模拟：PR 是你 GitHub 账号下的真实数据，需要你手工 review/close/merge。确定性段（第 1–3 部分：URL 规范化自测、初始化命令清单打印、`Skill.fromFS` 对 fake 沙盒的装载）零凭证零网络，随时可跑；只有当你有意让 agent 在真实仓库上开一次真实 PR 时才在根 `.env` 里补上 `GITHUB_REPO`/`GITHUB_PAT`。

## 运行方式

```sh
# 仓库根目录，一次性准备（全程使用 corepack pnpm）：
corepack pnpm install
corepack pnpm build                      # 各包 dist 是示例 import 的解析目标
node examples/setup-node-modules.mjs     # 在 examples/ 下建工作区符号链接（幂等，可重跑）

# 运行任意示例（Node ≥ 22.18，原生 TS type stripping；本仓开发环境为 Node 24）：
node examples/01-memory-diff.ts
```

`08-just-bash.ts` 额外依赖 `@nimbo/just-bash`——该包不随 `@nimbo/sdk` 一起装（见根 README 包结构表与 `packages/just-bash/README.md`），但 `setup-node-modules.mjs` 已经把它和它的运行时依赖 `just-bash` 一并链进 `examples/node_modules`，不需要额外步骤。

`09-sandbox-e2b.ts`/`10-sandbox-vercel.ts`/`11-sandbox-cloudflare.ts` 同样额外依赖各自的适配器包（`@nimbo/sandbox-e2b`/`@nimbo/sandbox-vercel`/`@nimbo/sandbox-cloudflare`，均不随 `@nimbo/sdk` 一起装）+ 09/10 各自需要的 provider SDK（`e2b`/`@vercel/sandbox`；11 的客户端零 provider SDK）——`setup-node-modules.mjs` 已经把它们全部链进 `examples/node_modules`，不需要额外步骤。三者的确定性段零凭证可跑；真机段需要的环境变量见仓库根的 [`.env.template`](../.env.template)（在仓库根 `cp .env.template .env` 后按其中的 E2B / Vercel Sandbox / GitHub 各节填写）——11 的真机段额外需要先部署一个网关，见 [`cloudflare-gateway/`](./cloudflare-gateway/README.md)。

`12-vercel-sandbox-real-project.e2e.test.ts` 复用 10 号已经链好的 `@nimbo/sandbox-vercel`/`@vercel/sandbox`，外加 `shared/model.ts` 已经链好的 `@ai-sdk/deepseek`（本例直连 DeepSeek 构造模型，不经 `resolveModel()`，见文件头注释）——同样不需要额外的 `setup-node-modules.mjs` 步骤。真机段需要的四项环境变量（DeepSeek 二选一 + `GITHUB_REPO`/`GITHUB_PAT` + 三个 `VERCEL_*`）见 仓库根 `.env.template` 的 GitHub 一节；**运行前务必先读上面那条 ⚠️ 须知**。

不配置任何环境变量时，每个示例只跑确定性段并干净退出——适合先感受 API 形状。要跑模型驱动段，二选一（`shared/model.ts` 的 `resolveModel()` 按此顺序尝试，都未配置才打印指引干净退出）：

**方式一・DeepSeek 直连**——在根 `.env`（已被根 `.gitignore` 的 `.env` 规则覆盖，不会被提交）里写：

```sh
DEEPSEEK_API_BASE_URL=https://your-deepseek-endpoint/v1
DEEPSEEK_API_TOKEN=...
```

通过 Node 内置 `process.loadEnvFile` 加载（零第三方 dotenv 依赖），已在 shell 里 `export` 过的同名变量优先、不会被文件内容覆盖。模型默认 `"deepseek-chat"`，可选 `export NIMBO_MODEL="deepseek-reasoner"` 覆盖模型名（此路径下 `NIMBO_MODEL` 是裸模型 id，不是网关字符串）。

**方式二・AI SDK Gateway**：

```sh
export NIMBO_MODEL="anthropic/claude-sonnet-5"   # 任意 AI SDK Gateway model id
export AI_GATEWAY_API_KEY="..."                  # https://vercel.com/ai-gateway
node examples/01-memory-diff.ts
```

`NIMBO_MODEL` 是 AI SDK Gateway 的 `"provider/model"` 字符串——`AgentDefinition.model` 的 `LanguageModel` 联合类型原生接受字符串，零 provider 依赖。两种方式都不想用的话，编辑 [`shared/model.ts`](./shared/model.ts) 直接构造 provider 实例（如 `@ai-sdk/anthropic` 的 `anthropic("claude-sonnet-5")`），任何 AI SDK `LanguageModel` 都可以。

## 类型检查

```sh
node examples/typecheck.mjs    # 等价于 tsc -p examples/tsconfig.json（--noEmit）
```

刻意做成独立脚本而非挂进根 `pnpm typecheck`：根脚本是 `pnpm -r run typecheck`（workspace 递归），examples/ 不是 workspace 成员（见下），挂进去需要改根 package.json。

`cloudflare-gateway/` 不在这个类型检查范围内（`examples/tsconfig.json` 的 `exclude`）——它是一个独立的、有自己 `package.json`/`tsconfig.json`/`node_modules` 的 wrangler 项目（依赖只在 workerd 里能加载的 `@cloudflare/sandbox`），按其自身 README 的步骤 `npm install && npm run typecheck` 单独检查。

## 为什么 examples/ 不是 workspace 包

examples/ 演示的是**发布后的消费姿态**——`import { ... } from "@nimbo/sdk"` 裸名导入、解析到各包 `exports` 声明的 dist 产物，与真实用户 `pnpm add @nimbo/sdk` 后的体验同构。做成 workspace 成员反而引入差异（workspace 协议、可能的 src 直连），并把示例的依赖搅进 lockfile。`setup-node-modules.mjs` 手工搭出与 pnpm 等价的符号链接布局（只建 `examples/node_modules`，已被根 `.gitignore` 覆盖，不进版本库、不碰 lockfile）。

> import 源说明：除 `08-just-bash.ts`（`@nimbo/just-bash` 不进 sdk 依赖，见该文件头注释）与 `09`/`10`/`11`/`12`（`@nimbo/sandbox-*` 适配器包同样不进 sdk 依赖，见各自文件头注释；12 号额外直接 import `@ai-sdk/deepseek` 构造模型，不经 `shared/model.ts` 的 `resolveModel()`）外，其余示例统一从 `@nimbo/sdk` 导入。TODO：npm 裸名 `nimbo` 的发布决策待定（docs/plans/core-sdk.md P7-1 遗留），定了之后这里与各 README 的 import 语句同步替换。
