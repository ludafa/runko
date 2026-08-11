# 示例集 examples（实验田）— 功能手册

> **相关**：技术方案见 [app/examples/tech](./tech.md)；施工进展见 [app/examples/plan](./plan.md)。
> **依赖**：示例演示 [core-sdk](../../core/core-sdk/feature.md) 的各项能力（VirtualFS / NimboExec / skills / 结构化输出 / streaming）与 [sandbox](../../host/sandbox/feature.md) 三家云沙盒适配器；模型驱动段的验证语义与 [core/verification/plan](../../core/verification/plan.md) 一脉相承。

本文面向使用者：讲清楚 [示例集（examples，实验田）](../../terms.md) 给开发者解决了什么问题、怎么上手运行、边界在哪、怎样算成功。实现细节（workspace 成员化、runner 机制、依赖解析）见 [app/examples/tech](./tech.md)。

## 1. 解决什么问题

想快速判断「nimbo 能不能干我要的事」的开发者，需要一块**打开即用**的地方：不用读源码、不用搭脚手架，一条命令就能看到某个能力真的跑起来。

`examples/` 就是这块地——一个 pnpm workspace 成员，十二个可独立运行的脚本，每个聚焦 nimbo 的一块核心能力（纯内存工作区 / 目录挂载 / skills / 自定义执行器 / 结构化输出 / streaming / 全语法档 bash / 三家云沙盒 / 真实项目端到端）。它面向用户的定位是**实验田**：低门槛、可改、跑坏了也不影响主项目。

此前 `examples/` 靠一个手工符号链接脚本（`setup-node-modules.mjs`）伪装「发布后消费姿态」，上手要 `pnpm build` + 跑脚本建链接，且脚手架与真实 workspace 布局貌合神离、易坏。现在它就是**真正的 workspace 成员**：根目录 `pnpm install` 一次，依赖自动就位，`pnpm example <编号>` 直接跑。

## 2. 用户可见的行为

### 上手三步

```sh
pnpm install                                    # 仓库根，搭好整个 workspace（含 examples）
pnpm --filter @nimbo/examples example 01        # 跑 01 号（或 cd examples && pnpm example 01）
```

- **按编号或名字前缀选**：`pnpm example 01`、`pnpm example dir-mount` 都行；[runner（示例分发器）](../../terms.md) 按前缀在 `src/` 下唯一匹配。命中多个会列候选，命中零个打印全部可用示例。
- **等价原生命令**：`node examples/src/01-memory-diff.ts`（Node ≥ 24 原生 type stripping，无需编译）。
- **参数透传**：`pnpm example 01 --foo` 会把 `--foo` 原样传给脚本。

### 两段式：零配置也能看到东西

每个脚本分两段（术语见 [确定性段](../../terms.md) / [模型驱动段](../../terms.md)）：

1. **[确定性段](../../terms.md)**——不需要模型、不需要任何环境变量，直接演练机制本身，输出形状恒定。零配置首跑就能看到 API 形状。
2. **[模型驱动段](../../terms.md)**——真实 agent loop，需要配置模型。未配置时脚本走 [gate（配置闸门）](../../terms.md) 打印配置指引后**干净退出**（exit 0），不崩溃、不产生副作用。

要跑模型驱动段，在仓库根 `.env` 配 DeepSeek 直连，或 `export` AI SDK Gateway 变量（两种方式见 [examples/README](../../../examples/README.md#模型配置)）。云沙盒示例（09/10/11）在模型之上还有一层凭证 gate。

### 12 号是 demo，不是测试

[`12-vercel-sandbox-real-project.ts`](../../../examples/src/12-vercel-sandbox-real-project.ts) 是一个**演示**：agent 在真实 Vercel Sandbox 里 clone 你的仓库、装载 `frontend-design` [skill](../../terms.md)、做一次设计优化、走完整 Git 工作流开 PR。它此前叫 `12-...e2e.test.ts`，但 `.e2e.test` 只是文件名、从不是 vitest 用例；已正名为 `.ts`。**⚠️ 它的真机段会真实修改你 `GITHUB_REPO` 指向的仓库、真实开 PR**——运行前须知见 [README](../../../examples/README.md#示例清单)。

## 3. 范围与非目标

- **是什么**：一块给人**手动把玩**的实验田；一份「nimbo 各能力长什么样」的可运行参照。
- **不是什么**：
  - **不是自动化测试套件**。示例脚本不进 vitest、不做断言式回归——它们的价值是「跑起来看效果」。（真正的回归测试在各包 `test/` 下。原 13 号是唯一一个 e2e 测试，已迁至 `@nimbo-chat/node-server`，见 [app/examples/tech §5](./tech.md)。）
  - **不再追求「发布后消费姿态」的严格复刻**。旧 `setup-node-modules.mjs` 想用手工符号链接模拟 `pnpm add @nimbo/sdk` 的最终布局；现放弃这个目标，换成真实 workspace 成员化——import 语句本身仍是裸名 `@nimbo/sdk`（消费姿态在 import 层面保留），但依赖搭建交给 pnpm。
  - **不在 examples 内维护 Cloudflare 网关**。11 号真机段要连真实 CF 沙盒确实得先立一个 Worker（CF 沙盒只能从 Worker 内访问）；这部分能力现已整体搬到独立 workspace 成员 [`apps/cloudflare-worker-server`](../../../apps/cloudflare-worker-server/README.md)——一个**完整可 `wrangler deploy` 的示例项目**（同时扮演「进程内驱动真实 CF 沙盒」与「对外 BYO 网关端点 `ALL /gateway/*`，供任意 Node 机器的 `cloudflareWorkspace({ url, token })` 连入」两个角色），不再是 examples 下一份不完整的参考料。「拎走即部署的网关模板」这个非目标因此不再成立，但用它仍需**自备 CF 账号 + Workers Paid 计划**（CF 沙盒无免费层）——它是一个完整示例项目，不是由我们代管的托管服务。边界说明见 [app/examples/tech §6](./tech.md)。

## 4. 成功标准

- 全新 clone 的仓库，根 `pnpm install` 后 `pnpm example 01`（及抽查的 02/04）**确定性段零配置跑通**、无模型时干净退出（exit 0）。
- 在根 `.env` 配好 DeepSeek 后，模型驱动段能真实跑一轮 agent。
- `examples` 的 `typecheck` 随根管线 `pnpm -r typecheck` 进 CI 质量门，`src/` 保持类型绿。
- README 与本 feature/tech/plan 三份文档互链、无过时指引（不再出现已删的 `setup-node-modules.mjs`/`typecheck.mjs`）。
