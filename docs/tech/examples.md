# 示例集 examples（实验田）— 技术方案

> **相关**：产品手册见 [features/examples](../features/examples.md)；施工进展见 [plans/examples](../plans/examples.md)。
> **依赖**：workspace 成员化的解析规则与根管线约定见 [tech/chat-webapp](./chat-webapp.md)（apps 并入根 workspace 的同款理由）；原 13 号迁出的去向见 [plans/single-ledger](../plans/single-ledger.md)。

本文讲 [示例集（examples，实验田）](../terms.md) 的技术组织：workspace 成员化、`src/` 布局、[runner](../terms.md) 机制、typecheck 进 CI、依赖解析、以及 `cloudflare-gateway-ref/`（11 号真机段的 BYO 网关参考料）的边界。产品视角（解决什么、怎么用）见 [features/examples](../features/examples.md)。

## 1. workspace 成员化

`examples/package.json`（`@nimbo/examples`，`private: true`，不发布）用两种协议声明依赖：

- `@nimbo/*`（sdk / just-bash / sandbox-e2b / sandbox-vercel / sandbox-cloudflare）走 **`workspace:*`**——直接解析到仓库内各包，示例 import 的是各包 `exports` 声明的入口（连接到源码，无需先 `pnpm build`）。
- `ai` / `zod` / `e2b` / `@vercel/sandbox` 走 **`catalog:`**——与全仓统一版本（[pnpm-workspace.yaml](../../pnpm-workspace.yaml) 的 `catalog:` 块）同源；`@ai-sdk/deepseek` 是示例专属、直接钉版本。

根 `pnpm install` 自动搭好这套依赖，**取代了旧的手工符号链接脚本 `setup-node-modules.mjs`**（已删）。`examples` 进 `pnpm-workspace.yaml` 的 `packages:` 列表（不带 `/*`——`examples` 根自身就是那个成员，其 `src/` 是示例源码；子目录 `cloudflare-gateway-ref/` 没有 `package.json`，不是也不会被当成 workspace 成员，见 §6）。

## 2. `src/` 布局

```
examples/
├── run.ts                 # runner（工具，非示例）
├── package.json           # @nimbo/examples，example + typecheck 脚本
├── tsconfig.json          # include 收窄到 src/**/*.ts + run.ts
├── README.md
├── src/
│   ├── 01-memory-diff.ts … 12-vercel-sandbox-real-project.ts
│   └── shared/                # model.ts（resolveModel）+ transcript-store.ts
└── cloudflare-gateway-ref/    # 11 号真机段的 BYO 网关参考料（非项目，见 §6）
```

源码全部在 `src/` 下。`src/shared/model.ts` 的 `resolveModel()` 用三层 `..`（`shared/ → src/ → examples/ → 仓库根`）定位根 `.env`，经 Node 内置 `process.loadEnvFile` 加载（零第三方 dotenv）。各脚本 `import "./shared/model.ts"` 等相对路径都在 `src/` 内自洽。

## 3. runner 机制

`examples/run.ts` 是 `pnpm example <编号或名字前缀>` 背后的分发器，纯 Node 内置模块实现：

1. `readdirSync(src/)` 列出 `^\d.*\.ts$` 的顶层脚本名（去后缀），排除 `shared/` 等；
2. 按参数匹配，**先命中者胜**：精确名 > 前缀 > 包含子串；
3. 唯一命中 → `spawn(process.execPath, [scriptPath, ...透传参数], { stdio: 'inherit' })`，子进程退出码/信号原样传导；
4. 零命中 → 打印全部可用示例；多命中 → 列候选让用户写得更具体。

新增示例零维护：往 `src/` 丢一个 `NN-*.ts` 就自动进入可选列表。

```mermaid
sequenceDiagram
    actor U as 用户
    participant P as pnpm
    participant R as run.ts (runner)
    participant FS as src/ 目录
    participant N as node 子进程
    U->>P: pnpm example 01
    P->>R: node run.ts 01
    R->>FS: readdirSync(src/) 列示例
    FS-->>R: [01-…, 02-…, …, 12-…]
    R->>R: 匹配 "01"（精确>前缀>子串）
    alt 唯一命中
        R->>N: spawn(node, [src/01-….ts, …args])
        N-->>U: stdio inherit（输出直达终端）
        N-->>R: exit code / signal
        R-->>P: 原样传导退出码
    else 零命中 / 多命中
        R-->>U: 打印全部可用示例 / 候选清单
    end
```

## 4. typecheck 进 CI

`examples/package.json` 定义 `typecheck: tsc --noEmit`；`ci.yml` 跑 `pnpm -r typecheck`（workspace 递归），天然扫到 examples——**examples 带质量门、`src/` 保持类型绿是被 CI 强制的**。

注意根脚本 `pnpm typecheck` 是 `--filter ./packages/*`，本地只查核心包、**不含** examples（快路径）；进 CI 的是 `pnpm -r typecheck` 那条全量。`pnpm-workspace.yaml` 的注释与本节一致（此前 `tsconfig.json` 注释写「NOT wired into CI」，与 workspace 注释自相矛盾，已在本次收尾统一）。

`tsconfig.json` 的 `include` 收窄到 `["src/**/*.ts", "run.ts"]`——`node_modules/` 与 `cloudflare-gateway/` 都在这两个 glob 之外，自动不入程序，无需再写 `exclude`。`allowImportingTsExtensions: true` 让 tsc 接受 `./shared/model.ts` 这种带 `.ts` 后缀的 import（因为示例是 `node` 直跑、不重写后缀；noEmit 下合法）。

## 5. 原 13 号（e2e 测试）的去向

`examples/13-uimessage-single-ledger.e2e.test.ts` 曾是 [single-ledger](../../docs/features/single-ledger.md) 的验证实验（见 [plans/single-ledger §2](../plans/single-ledger.md)），是示例集里**唯一**一个真正的 e2e 测试而非演示。本次梳理把它移出示例集：

- **离线结构断言段**改写成 3 个常规 vitest 用例，迁至 `apps/server/test/agent/uimessage-single-ledger.test.ts`（转换器丢弃 data 部件 / assistant-tool 分组 / transient 纪律），随 server 测试进 CI。
- **真机 DeepSeek 验证段**（一次性人工实验、CI 永久 skip 无回归价值，且会给 server 引入首个真机网络测试、污染其全离线测试哲学）不迁移，完整版留在 git 历史。
- `packages/core/src/loop.ts` 对 13 旧路径的注释引用已更新指向新位置、并注明真机段见 git 历史。

single-ledger 的语义实现已落在 `@nimbo/core` 的生产代码，真机复现价值低；这条判断的取舍记录见 `.lantie_history`。

## 6. `cloudflare-gateway-ref/` 的边界：BYO 参考料，不是项目

11 号真机段要连真实 Cloudflare 沙盒，就必须有一个 Worker 在你自己的 CF 账号里跑（CF Sandbox 只能从 Worker 内部访问）。[`cloudflare-gateway-ref/`](../../examples/cloudflare-gateway-ref/README.md) 就是那个 Worker 的**参考实现**——三个文件：`index.ts`（约 15 行装配，把 `getSandbox(env.Sandbox, id)` 注入 `createSandboxGateway`）、`wrangler.jsonc`、`Dockerfile`。

它**不是一个项目**，是一份**自备环境（BYO）的参考料**：

- **无 `package.json`、无 `tsconfig.json`、无 `node_modules`**——不安装、不构建、不 typecheck、不发布。要用它，自备 CF 账号、把文件拷进你自己的 wrangler 项目（`npm i @nimbo/sandbox-cloudflare @cloudflare/sandbox` + `wrangler`），再 `wrangler deploy`。
- **不进本 workspace 的类型检查**：它 import 只能在 workerd 里加载的 `@cloudflare/sandbox`，而 `examples` 从不安装该依赖；`examples/tsconfig.json` 的 `include` 只收 `src/**`+`run.ts`，它在 `src/` 之外，天然被排除。
- **不是 workspace 成员**：`pnpm-workspace.yaml` 里 `examples` 不带 `/*`，且它没有 `package.json`，pnpm 不会把它当成员。

**为什么放在 examples 而非包里**：它是 11 号示例真机段的支撑参考，属于「示例」这一侧；包 `@nimbo/sandbox-cloudflare` 真正对外交付且**被完整测试**的是 `createSandboxGateway`（`./worker`，纯函数、零 `@cloudflare/sandbox` 运行时 import，见 [features/sandbox](../features/sandbox.md)），这份 wrapper 只是把那个纯函数接到真实 CF 账号的、**测不了**的连接料——它不属于包的测试面，也不作为一个可部署模板由包发布/维护。

## 已知限制

- 示例的 import 源在 npm 裸名 `nimbo` 发布决策定案后可能整体替换（[plans/core-sdk](../plans/core-sdk.md) P7-1 遗留）。
- 模型驱动段与云沙盒真机段依赖外部凭证与网络，非确定性；确定性段是无凭证下的可复现底座。
