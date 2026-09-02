# runko examples（实验田）

一块**打开即用**的实验田：十二个可独立运行的示例脚本，每个演示 runko 的一块核心能力。`examples/` 是本仓的 pnpm workspace 成员——根目录 `pnpm install` 一次，依赖（`@runko/*` 走 `workspace:*`、`ai`/`zod`/`e2b`/`@vercel/sandbox` 走 catalog）自动搭好，然后一条 `pnpm example <编号>` 就能跑。

每个脚本都分两段：

1. **确定性段**——不需要模型、不需要任何环境变量，直接演练 VirtualFS / RunkoExec / skills 的机制本身，输出形状恒定；
2. **模型驱动段**——真实 agent loop，需要配置模型（见下方「模型配置」）。未配置时脚本打印配置指引后**干净退出**（exit 0），不会崩溃。

源码都在 [`src/`](./src) 下（`src/shared/` 是共享的模型解析与转写工具）；`run.ts` 是 `pnpm example` 的分发器（工具，非示例）。

## 示例清单

| 脚本 | 演示点 | 对应产品场景（[core-sdk · 功能](../docs/logic/engine/features/core-sdk.md) §3） |
|---|---|---|
| [`01-memory-diff.ts`](./src/01-memory-diff.ts) | 纯内存工作区：agent 改代码，宿主拿 `diff()`，全程不碰磁盘 | SaaS 内嵌代码助手 |
| [`02-dir-mount.ts`](./src/02-dir-mount.ts) | 真实目录 overlay 挂载：读穿透、写落内存，`writeBack()` 才落盘 | 安全地把真实项目交给 agent |
| [`03-skills.ts`](./src/03-skills.ts) | SKILL.md 加载（flat + packaged）、渐进式披露、`load_skill` 工具 | 带领域能力的 agent 产品 |
| [`04-mini-bash.ts`](./src/04-mini-bash.ts) | 同源工作区：文件工具与 `bash` 共享同一个 RunkoFS（mini-bash 纯 TS 解释器） | 零依赖的命令执行面 |
| [`05-custom-exec.ts`](./src/05-custom-exec.ts) | 从零实现 `RunkoExec` 注入自定义执行环境，loop 代码零改动 | 宿主自有沙盒/远程执行器 |
| [`06-structured-output.ts`](./src/06-structured-output.ts) | `send<T>(input, { outputSchema })` 结构化输出（zod 校验 + 重试） | 自动化流水线节点 |
| [`07-streaming.ts`](./src/07-streaming.ts) | `session.stream()` 实时消费：`item.updated` 文本增量、`tool_call` 状态流转、`turn.completed` usage，手动 `.next()` 驱动拿到生成器的 `TurnResult` 返回值 | 需要打字机式 UI 或工具调用实时反馈的宿主 |
| [`08-just-bash.ts`](./src/08-just-bash.ts) | 同源工作区的全语法档 bash（`@runko/just-bash`，独立安装）：真实 if/for/函数/重定向脚本，非流式 `onOutput` 契约 | Claude 系模型高频产出的控制流脚本（mini-bash 六命令撑不住的场景） |
| [`09-sandbox-e2b.ts`](./src/09-sandbox-e2b.ts) | RunkoFS & RunkoExec 适配 E2B 云沙盒（`@runko/sandbox-e2b`）：确定性段用几十行的进程内 fake 演示结构化接口，真机段驱动一个真实 E2B Firecracker microVM | 宿主想把 agent 的文件/命令面放进真实云沙盒而非虚拟内存 |
| [`10-sandbox-vercel.ts`](./src/10-sandbox-vercel.ts) | RunkoFS & RunkoExec 适配 Vercel Sandbox（`@runko/sandbox-vercel`）：同 09 的确定性段/真机段结构，真机段驱动一个真实 Vercel Sandbox | 同上，选 Vercel 作为云沙盒提供商 |
| [`11-sandbox-cloudflare.ts`](./src/11-sandbox-cloudflare.ts) | RunkoFS & RunkoExec 适配 Cloudflare Sandbox（`@runko/sandbox-cloudflare`，网关形态）：确定性段是本示例集的亮点——client → 网关 → fake 沙盒的完整协议往返全部在一个进程内跑通，零部署零网络；真机段驱动一个已部署的真实网关 | 同上，选 Cloudflare 作为云沙盒提供商（真机段需自备 CF 环境，直接部署现成的 [`apps/cloudflare-worker-server`](../apps/cloudflare-worker-server/README.md) 项目作为网关） |
| [`12-vercel-sandbox-real-project.ts`](./src/12-vercel-sandbox-real-project.ts) 🧪 **demo** | 真实项目端到端：runko agent 在真实 Vercel Sandbox 里 clone 你自己的 GitHub 仓库、从沙盒文件系统装载官方 `frontend-design` skill（`Skill.fromFS`）、做一次聚焦的设计优化，并自主走完整 Git 工作流（建分支→commit→push→开 PR） | 让 agent 在你真实项目上做一次有 Git 工作流闭环的自主改动 |

> 12 号是一个**演示（demo）**而非测试——它此前叫 `12-...e2e.test.ts`，但 `.e2e.test` 只是文件名、不是 vitest 用例，仍是 `node` 直跑的脚本；已正名为 `.ts`。

09/10/11 每个脚本的「模型驱动段」额外多一层 gate：先 `resolveModel()`（模型未配置 → 指引 + `exit 0`），再检查对应云厂商的凭证环境变量（缺失 → 打印指引后**干净 `return`**，不创建沙盒、不发起任何模型调用）——两者都配置好才会真正创建沙盒并跑一次真实 agent 任务。

**⚠️ 12 号运行前须知**：与 01–11 不同，12 号的真机段一旦四项凭证（DeepSeek + `GITHUB_REPO` + `GITHUB_PAT` + 三个 `VERCEL_*`）都配置好，**会真实修改你在 `GITHUB_REPO` 指向的仓库**——真实创建分支、真实 commit、真实 push、真实在该仓库开一个 Pull Request（用 `GITHUB_PAT` 的身份）。这不是沙盒内的模拟：PR 是你 GitHub 账号下的真实数据，需要你手工 review/close/merge。确定性段（第 1–3 部分：URL 规范化自测、初始化命令清单打印、`Skill.fromFS` 对 fake 沙盒的装载）零凭证零网络，随时可跑；只有当你有意让 agent 在真实仓库上开一次真实 PR 时才在根 `.env` 里补上 `GITHUB_REPO`/`GITHUB_PAT`。

## 运行方式

一次性准备（仓库根目录）：

```sh
pnpm install     # 搭好整个 workspace 的依赖，examples 一并就位（无需 build，示例直连各包 src）
```

然后按编号或名字前缀跑任意示例：

```sh
# 在仓库根目录：
pnpm --filter @runko/examples example 01          # 按编号
pnpm --filter @runko/examples example dir-mount   # 按名字片段

# 或进入 examples/ 后更短：
cd examples
pnpm example 01
pnpm example 07
```

匹配规则：精确名 > 前缀 > 包含子串；命中多个会列出候选让你写得更具体，命中零个则打印全部可用示例。示例编号之后的参数原样透传给脚本（`pnpm example 01 --foo` → `node src/01-*.ts --foo`）。

等价的原生命令（Node ≥ 24，原生 TS type stripping，无需编译）：

```sh
node examples/src/01-memory-diff.ts
```

不配置任何环境变量时，每个示例只跑确定性段并干净退出——适合先感受 API 形状。

## 模型配置

要跑模型驱动段，二选一（[`src/shared/model.ts`](./src/shared/model.ts) 的 `resolveModel()` 按此顺序尝试，都未配置才打印指引干净退出）：

**方式一・DeepSeek 直连**——在仓库根 `.env`（已被根 `.gitignore` 覆盖，不会被提交）里写：

```sh
DEEPSEEK_API_BASE_URL=https://your-deepseek-endpoint/v1
DEEPSEEK_API_TOKEN=...
```

通过 Node 内置 `process.loadEnvFile` 加载（零第三方 dotenv 依赖），已在 shell 里 `export` 过的同名变量优先、不会被文件内容覆盖。模型默认 `"deepseek-chat"`，可选 `export RUNKO_MODEL="deepseek-reasoner"` 覆盖模型名（此路径下 `RUNKO_MODEL` 是裸模型 id，不是网关字符串）。

**方式二・AI SDK Gateway**：

```sh
export RUNKO_MODEL="anthropic/claude-sonnet-5"   # 任意 AI SDK Gateway model id
export AI_GATEWAY_API_KEY="..."                  # https://vercel.com/ai-gateway
pnpm example 01
```

`RUNKO_MODEL` 是 AI SDK Gateway 的 `"provider/model"` 字符串——`AgentDefinition.model` 的 `LanguageModel` 联合类型原生接受字符串，零 provider 依赖。两种方式都不想用的话，编辑 [`src/shared/model.ts`](./src/shared/model.ts) 直接构造 provider 实例（如 `@ai-sdk/anthropic` 的 `anthropic("claude-sonnet-5")`），任何 AI SDK `LanguageModel` 都可以。

各云沙盒示例（09/10/11）真机段需要的凭证见仓库根 [`.env.template`](../.env.template)（`cp .env.template .env` 后按 E2B / Vercel Sandbox / GitHub 各节填写）；11 的真机段还需自备 CF 环境，直接部署现成的 [`apps/cloudflare-worker-server`](../apps/cloudflare-worker-server/README.md) 项目作为网关。

## 类型检查

examples 是 workspace 成员、带质量门——`typecheck` 随根管线 `pnpm -r typecheck` 进 CI：

```sh
pnpm --filter @runko/examples typecheck   # 单独查 examples
pnpm -r typecheck                          # 全 workspace（CI 跑的就是这条）
```

## import 源说明

除 `08-just-bash.ts`（`@runko/just-bash` 不进 sdk 依赖，见该文件头注释）与 `09`/`10`/`11`/`12`（`@runko/sandbox-*` 适配器包同样不进 sdk 依赖，见各自文件头注释；12 号额外直接 import `@ai-sdk/deepseek` 构造模型，不经 `src/shared/model.ts` 的 `resolveModel()`）外，其余示例统一从 `@runko/sdk` 导入。示例演示的是**发布后的消费姿态**：裸名 `import { ... } from "@runko/sdk"`，与真实用户 `pnpm add @runko/sdk` 后的体验同构——workspace 成员化只负责把依赖搭好，import 语句本身不含 workspace 痕迹。

> TODO：npm 裸名 `runko` 的发布决策待定（[core-sdk · 施工进展](../docs/logic/engine/plans/core-sdk.md) P7-1 遗留），定了之后这里与各 README 的 import 语句同步替换。

## 相关文档

- 产品视角：[示例集 examples（实验田） · 功能](../docs/misc/features/examples.md)
- 技术视角：[示例集 examples（实验田） · 技术方案](../docs/misc/tech/examples.md)
- 施工进展：[示例集 examples（实验田） · 施工进展](../docs/misc/plans/examples.md)
- 术语：[docs/terms.md](../docs/terms.md)
</parameter>
</invoke>
