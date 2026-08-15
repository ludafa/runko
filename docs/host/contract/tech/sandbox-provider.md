---
title: "沙盒 provider 可选（技术方案）"
slug: sandbox-provider
view: 技术
layer: 宿主层
module: 沙盒
packages: ["@nimbo/sandbox-e2b", "@nimbo/sandbox-vercel"]
tags: ["沙盒 provider", "可选沙盒", "重连令牌", "休眠唤醒"]
related: ["host/contract/features/sandbox-provider.md", "host/contract/plans/sandbox-provider.md", "architecture/tech/agent-kernel.md"]
---
# 沙盒 provider 可选（技术方案）

> 相关：[产品视角](../features/sandbox-provider.md) · [施工进展](../plans/sandbox-provider.md)
> 依赖：[chat-webapp 技术方案](../../../ingress/tech/chat-webapp.md)（§2.2 `sandbox-manager.ts`、§4 服务端模块）· [sandbox 技术方案](./sandbox.md)（§8 沙盒适配器契约）
> 术语：[沙盒 provider](../../../terms.md) · [重连令牌](../../../terms.md) · [沙盒适配器](../../../terms.md) · [工作区](../../../terms.md) · [NimboFS / NimboExec](../../../terms.md) · [休眠 / 唤醒](../../../terms.md)

## 1. 核心判断：差异全在 server，不在适配器包

[沙盒适配器](../../../terms.md)（`@nimbo/sandbox-vercel` / `@nimbo/sandbox-e2b`）按设计**只做 [NimboFS/NimboExec](../../../terms.md) 视图层**、刻意不管生命周期（[BYO 实例](../../../terms.md)）——创建、拉码、重连、超时、休眠全归宿主。所以「支持两家沙盒」要改的**只有一个文件**：`apps/node-server/src/agent/sandbox-manager.ts`（现状 100% 绑 Vercel）。routes/chat-agent 继续只见 `SandboxManager` 接口，零改动。

E2B 与 Vercel 的结构性差异（决定抽象缝在哪）：

| 维度 | Vercel Sandbox（现状） | E2B |
|---|---|---|
| **建盒时拉 git 代码** | ✅ `Sandbox.create({ source:{type:'git',url,username,password,depth} })` 一步 clone 到根 | ❌ 运行时无 git source（`template.gitClone()` 只是构建模板镜像时的能力）。**建盒后**跑 `git clone` |
| **[重连令牌](../../../terms.md)** | 用户自选 `name`，由 conversationId 确定性派生，**无需落库** | 服务端分配 `sandboxId`，**建盒后**才知道，**必须落 `conversations.sandbox_id`** |
| **重连/恢复** | `Sandbox.get({name})` 从平台快照恢复 | `Sandbox.connect(sandboxId)`（静态、跨进程、paused 自动 resume） |
| **休眠机制** | `persistent:true` → 空闲超时 Vercel 自动快照 | `lifecycle:{onTimeout:'pause',autoResume:true}` → 空闲超时 E2B 自动 pause（full memory snapshot 才能被流量自动 resume，默认即是） |
| **保活** | `extendTimeout(ms)` | `setTimeout(ms)`（从现在起重新计时——对「每条消息滚动续期」语义正好合适） |
| **恢复失败判定** | `APIError` status 404/410 | `connect()` 抛错（沙盒不存在/已删） |
| **工作区根** | `/vercel/sandbox`（= 仓库根） | `/home/user`（默认）→ 本方案设为 `/home/user/repo`（= clone 目标 = 仓库根） |

**关键对齐点**：两个适配器的 `exec` 都把 `cwd` 相对**配置的 root** 解析（E2B `anchor.toReal('/')`、Vercel `resolveCwd(root,'/')` 都 → root）。因此只要把 **E2B 的 workspace root 设成 clone 目标目录**，`sandbox-manager` 里那批 `cwd:'/'` 的共享 init/分支命令（装 skill、`git config`、`git remote set-url`、`git fetch/checkout`、`git symbolic-ref`）在两家都落在仓库根、**一字不用改**。

## 2. 业务数据领域设计

会话表加两列：`provider`（选了哪家）与 `sandbox_id`（E2B 的[重连令牌](../../../terms.md)，Vercel 恒 null）。其余不变。

```mermaid
erDiagram
    user ||--o{ conversations : owns
    conversations ||--o{ conversation_events : "has ledger"

    conversations {
        text id PK
        text user_id FK
        text title
        text repo "全局 GITHUB_REPO（本次不改）"
        text branch_name "会话专属分支"
        text provider "vercel | e2b（新增，NOT NULL default 'vercel'）"
        text sandbox_name "重连令牌·Vercel：确定性沙盒名"
        text sandbox_id "重连令牌·E2B：建盒后落库的 sandboxId（新增，nullable）"
        text status "active | sleeping | expired（读时派生）"
        integer last_active_at
    }
```

- `sandbox_name` 保留原语义（Vercel 的 name / 也作 E2B 的 metadata 便于排障）；E2B 的真正重连令牌是 `sandbox_id`。
- 迁移：`ALTER TABLE ... ADD COLUMN provider TEXT NOT NULL DEFAULT 'vercel'` + `ADD COLUMN sandbox_id TEXT`（存量会话回填 `vercel`/null，行为不变）。

## 3. 抽象重塑：`SandboxClient` → `SandboxProvider`

现状 `SandboxClient`（`create(params)`/`get(name)`）方向对但语义绑 Vercel。泛化为 `SandboxProvider`，把两家差异全收进去，让 `acquire` 状态机对 provider 无感：

```ts
export type SandboxProviderId = 'vercel' | 'e2b';

/** 一个已就绪、仓库已 clone 在 workspace 根的沙盒句柄。 */
export interface ProvisionedSandbox {
  workspace: NimboFS & NimboExec;          // 已锚定到仓库根（Vercel /vercel/sandbox、E2B /home/user/repo）
  /** 供下次唤醒指名恢复、需持久化的令牌：Vercel = name（=入参，无变化）；E2B = 新分配的 sandboxId。 */
  resumeToken: string;
  /** 保活：Vercel extendTimeout / E2B setTimeout —— 把「续期」这一步的差异藏进句柄。 */
  extendIdle(idleTimeoutMs: number): Promise<void>;
}

export interface CreateSandboxParams {
  name: string;          // Vercel 沙盒名；E2B 作 metadata
  cloneUrl: string;      // https://github.com/owner/repo.git
  githubPat: string;
  timeoutMs: number;
}

export interface SandboxProvider {
  readonly id: SandboxProviderId;
  /** 创建 + 把仓库 clone 到 workspace 根（Vercel 靠 git source；E2B 靠建盒后 git clone）。 */
  create(params: CreateSandboxParams): Promise<ProvisionedSandbox>;
  /** 用 resumeToken 恢复；`unavailable` → 调用方重建。 */
  resume(
    resumeToken: string,
    timeoutMs: number,
  ): Promise<{ kind: 'ok'; sandbox: ProvisionedSandbox } | { kind: 'unavailable' }>;
}
```

两个实现：

- **`createVercelProvider()`**：`create` = 现状 `Sandbox.create({ source: git, persistent, runtime, env, timeout })` + `vercelWorkspace(sb)`，`resumeToken = params.name`，`extendIdle = extendTimeout`。`resume(name)` = `Sandbox.get({name})`，404/410 → `unavailable`。**逻辑与今天逐字等价，只是换了个壳**。
- **`createE2bProvider()`**：`create` = `Sandbox.create({ apiKey, template: resolveE2bTemplate(), timeoutMs, lifecycle:{onTimeout:'pause',autoResume:true}, envs:{GH_TOKEN:pat}, metadata:{name} })`（`template` 见 §5 自建[沙盒模板](../../../terms.md)） → 用绝对路径命令 `git clone https://x-access-token:<pat>@github.com/owner/repo.git /home/user/repo` → `e2bWorkspace(sb, { root: '/home/user/repo' })`，`resumeToken = sb.sandboxId`，`extendIdle = setTimeout`。`resume(id)` = `Sandbox.connect(id)`（自动 resume）包 `e2bWorkspace(root)`；抛错 → `unavailable`。

provider 由 `SANDBOX_PROVIDER` 默认 + 会话 `provider` 列选择：`sandbox-manager` 持有 `Record<SandboxProviderId, SandboxProvider>`，按会话 provider 取实现。

### 3.1 `acquire` 的两处必要改动

`AcquireInput` / `AcquiredSandbox` 各加一字段，把 E2B 的「令牌建盒后才知道、要落库」这件事表达出来：

```ts
interface AcquireInput {
  /* …原字段… */
  provider: SandboxProviderId;      // 新增：本会话选的 provider
  resumeToken?: string;             // 新增：已落库的令牌（Vercel=sandboxName、E2B=sandbox_id；全新会话 undefined）
}
interface AcquiredSandbox {
  workspace: NimboFS & NimboExec;
  defaultBranch: string;
  resumeToken: string;              // 新增：当前令牌 —— 路由据此决定是否回写 conversations.sandbox_id
}
```

`acquire` 三态与今天同构，只是把 Vercel 直调换成 `provider.resume/create`，并在 create 后回传 `resumeToken`：

1. 内存命中 → 复用（零网络）。
2. `provider.resume(resumeToken)` ok → `detectDefaultBranch` + 缓存 + 返回。
3. `resume` unavailable（或 `resumeToken` 为空的全新会话）→ `provider.create()` → **共享** `installSkillAndConfigureGit` + `detectDefaultBranch` + `recoverSessionBranch` → 缓存 → 返回新 `resumeToken`。

路由侧（`routes/chat.ts`）：建会话与每条消息 `acquire` 后，若 `acquired.resumeToken` 与库里 `sandbox_id` 不同（仅 E2B 首建时发生），落库。Vercel 的 `resumeToken == sandboxName`、库里已有，no-op。

## 4. 核心流程时序（E2B acquire 三态 + 休眠）

```mermaid
sequenceDiagram
    autonumber
    participant Web as apps/web
    participant Route as routes/chat.ts
    participant Mgr as sandbox-manager
    participant P as SandboxProvider(e2b)
    participant E2B as E2B 云

    Note over Web,Route: 新建会话（provider=e2b）
    Web->>Route: POST /conversations { provider:'e2b' }
    Route->>Mgr: acquire({provider:'e2b', resumeToken:undefined, …})
    Mgr->>P: create(params)
    P->>E2B: Sandbox.create({lifecycle:onTimeout:'pause',autoResume, envs:GH_TOKEN})
    E2B-->>P: sandbox(sandboxId)
    P->>E2B: commands.run("git clone <pat-url> /home/user/repo")
    P-->>Mgr: {workspace(root=/home/user/repo), resumeToken=sandboxId, extendIdle}
    Mgr->>Mgr: installSkillAndConfigureGit + detectDefaultBranch + recoverSessionBranch（共享）
    Mgr-->>Route: {workspace, defaultBranch, resumeToken=sandboxId}
    Route->>Route: 落库 conversations(provider='e2b', sandbox_id=sandboxId)

    Note over E2B: 空闲超阈值 → E2B 自动 pause（onTimeout:'pause'）
    Note over Web,Route: 用户回来发消息（唤醒）
    Web->>Route: POST /conversations/{id}/messages
    Route->>Mgr: acquire({provider:'e2b', resumeToken=sandbox_id, …})
    Mgr->>P: resume(sandbox_id)
    P->>E2B: Sandbox.connect(sandbox_id) （自动 resume 快照）
    E2B-->>P: sandbox（文件态含分支代码原样还原）
    P-->>Mgr: {kind:'ok', sandbox}
    Mgr->>P: extendIdle(idleTimeoutMs)  ->  setTimeout
    Mgr-->>Route: {workspace, defaultBranch, resumeToken=sandbox_id}
```

Vercel 路径同构，把 `create/resume/extendIdle` 换成 `Sandbox.create(source:git)`/`Sandbox.get({name})`/`extendTimeout`，且第 12 步落库为 no-op（令牌即 sandboxName）。

## 5. 关键取舍与已知限制

- **休眠对齐靠 `onTimeout:'pause'+autoResume`，非热路径显式 `pause()`**：E2B 空闲超时自动 pause（等价 Vercel 自动快照），`connect` 自动 resume。`autoResume:true` 要求 **full memory snapshot**（E2B 默认），才能被「下一条消息的流量」自动唤醒——与 Vercel「下条消息 acquire 唤醒」体验一致。**已真机验证**（用户 `E2B_API_KEY`）：`pause()` ~0.6s、`Sandbox.connect(sandboxId)` 跨进程静态重连自动 resume 且**写入文件 + 建盒后 clone 的 git 仓库 HEAD 均完整保留**、`state=running`；建盒后 `git clone` 小仓库 ~4.5s。
- **`resume()` 对刚 auto-pause 的瞬时 404 做有限重试**（SP-6 真机暴露）：沙盒刚 `onTimeout:'pause'`、快照落定前的短窗口里，`connect` 会瞬时抛 `SandboxNotFoundError`（"Sandbox `<id>` not found"），但**盒其实还在、秒级后就能重连**。`resume` 因此对 `connect` 退避重试（`E2B_RESUME_ATTEMPTS=4`、退避 `500ms×attempt`，总窗 ~3s）：瞬时 404 重试即重连回原盒（**保住未 push 的 WIP**），只有**持续** not-found 才判 `unavailable`→重建（`isE2bSandboxGone` 按 `SandboxNotFoundError`/`NotFoundError` 名 + `/sandbox.*not found/i` message 兜底识别；"Invalid sandbox ID"(400) 不算 gone、照抛以暴露真 bug）。**已真机验证**（provider 层）：create→clone→45s 空闲 auto-pause→`resume` 返回 `ok`、重连原盒、marker 文件保留。
- **E2B 令牌落库时机**：`sandboxId` 建盒后才有，故 `acquire` 必须能把它回传给路由落库（`AcquiredSandbox.resumeToken`）。若首建落库前进程崩溃，该 E2B 沙盒成孤儿（靠 `onTimeout:'kill'`? 否——它是 pause，会占额度）——首建流程要保证「create 成功 → 立即落库」尽量原子（路由内 create 与 insert 同一 try）；孤儿由 `Sandbox.list` + metadata.conversationId 兜底清理（运维脚本，非本次范围）。
- **`setTimeout` 语义**：E2B `setTimeout(ms)` 是「从现在起剩余 ms」，正是「每条消息把空闲窗口滚到满」的意图；与 Vercel `extendTimeout` 的差异被 `extendIdle` 抽象吸收，`sandbox-manager` 的 `touch` 无感。
- **`E2B_API_KEY` 成为 chat 应用条件依赖**：仅当有会话选 E2B 时需要；provider 工厂惰性读 env（同 `model.ts`/`github-repo.ts` 的「不在 import 时读 env」纪律），未配又选 E2B → `create` 抛带指引的配置错误，路由转 500。
- **E2B 不用自带 `base`，改用自建[沙盒模板](../../../terms.md) `nimbo-chat-base`（1024 MiB）**：E2B 的 CPU/内存**只能在构建模板时定死**——`SandboxOpts` 只有 template/timeout/lifecycle/envs/metadata，没有任何内存参数——而自带 `base` 是 2 vCPU / **512 MiB**，跑 `npm install` 会被 OOM kill。故 `scripts/build-e2b-template.ts` 用 `Template().fromBaseImage()`（**同一个** base 镜像，盒内环境零变化）以 `memoryMB: 1024` 构建并发布 `nimbo-chat-base`，`create` 传 `template` 指名用它。规格三项（名字/内存/核数）均**从 env 读、以 `src/agent/e2b-template.ts` 的 `DEFAULT_*` 常量兜底**，构建脚本与运行时共用同一组 resolver，名字不会漂移。**但三项生效时机不同**：名字每次建盒都读；内存/核数**只有构建脚本读**（E2B 只在构建时给设资源的机会），改完必须重跑 `pnpm --filter @nimbo-chat/node-server e2b:template`（每个 E2B team 一次性，幂等）。内存/核数填了非正整数**直接抛错终止构建**，不沿用 `resolveIdleTimeoutMs` 的静默回退——构建是一次性操作，把 `4O96` 静默当成 1024 会发布一个「看着像 4 GiB 实则 1 GiB」的模板，几周后才以 OOM 现形。**已知限制**：模板未构建前建 E2B 盒会拿到 E2B 的 template-not-found 错误——逃生门是 `E2B_TEMPLATE=base` 退回自带模板（内存回到 512）。Vercel 侧无此问题（其资源在 `Sandbox.create` 上按盒指定）。
- **进程内缓存必须能失效，且长轮次要保活**（SP-7）：见下 §5.1——这是**上面「`setTimeout` 语义」那条的直接后果**，当初只写了语义、没写它对缓存和长轮次的含义，代价是一个线上 bug。
- **测试可 fake**：`SandboxProvider` 是纯结构接口，E2B/Vercel 两实现各自的契约测试用进程内 fake（沿用适配器包已有的 `FakeE2bSandbox`/fake `VercelSandboxLike`），`sandbox-manager` 的 acquire 三态测试注入 fake provider，零网络/凭证。

### 5.1 缓存失效与保活心跳（SP-7）

**根因：平台超时是绝对截止时间，跑命令不续期。** E2B 的 `POST /sandboxes/{id}/timeout` 文档原话是「沙盒将在**请求时刻**起 x 秒后过期」，多次调用互相覆盖、每次都以当前时刻重新起算。**执行命令不会把它往后推。** 真机实测吻合：某盒 `startedAt 09:52:53`，轮开始时 `touch` 一次，`endAt` 就钉在 `touch + 5min = 10:00:56`，其间跑了 2.5 分钟命令，`endAt` 纹丝不动。

这条语义有两个后果，原设计都没接住：

1. **进程内缓存会腐坏。** `sandbox-manager` 的 `active` Map 缓存活沙盒句柄，`acquire` 命中即返回。沙盒被平台 pause 后，句柄还在，后续 `touch`/`exec` 直接打到已暂停的盒 → 裸 `Sandbox … not found` 冒给用户。而 `resume()` 里那套「重试 + 判 gone + 重建」被缓存短路，**根本没机会跑**——所以连自愈都不会发生，要等进程重启。
2. **长轮次会被从底下抽走。** `touch` 只在轮开始（`turn-launcher`）和审批/提问路由调，一轮跑得比 `SANDBOX_IDLE_TIMEOUT_MS` 长，沙盒就在轮跑到一半时暂停。

**修法四层**（对应 `docs/host/contract/plans/sandbox-provider.md` SP-7）：

| 层 | 做什么 | 落点 |
|---|---|---|
| 1 保活覆盖整轮 | `startHeartbeat(conversationId)` 每 `idleTimeout/2` 续一次，返回停止函数；**轮级作用域**，`onTurnSettled` 停 | `SandboxManager` + `turn-launcher` |
| 2 缓存可失效 | `ActiveSandbox.expiresAt` = 最后一次 create/resume/保活 + `idleTimeoutMs`；`acquire` 命中先比时间，过期即驱逐走 `resume()`（主动）。任何操作抛 gone 也驱逐（被动） | `sandbox-manager` |
| 3 gone 判定上升到接口 | `SandboxProvider.isGone(error)`，让 manager 能给**任意操作**抛的错误分类，不只是 `resume()` | `SandboxProvider` 两实现 |
| 5 生命周期收口 | `release()` 同时停心跳；驱逐是唯一出口 | `sandbox-manager` |

**心跳为什么必须是轮级、不能常驻**：常驻心跳等于把「空闲自动暂停」整套机制废掉，沙盒永不休眠、持续计费。它要解决的只是「一轮跑得太长」，不是「让沙盒长生」。

**主动 + 被动两半都要**：只算时间不够（时钟会偏、平台可能提前暂停、盒可能被外部删）；只等报错也不够（那意味着每次都要先失败一次，且失败点可能在轮子中间而不是 `acquire`）。

**未做的第 4 层（workspace 自愈代理）**：即便有 1+2+3，中途暂停仍可能发生（心跳请求本身失败、网络分区）。彻底做法是把交给 session 的 workspace 包一层、捕获 gone 后重连重放。**本期刻意不做**，因为重放安全性需要单独设计：只有「命令还没开始跑」就失败（连接时 404）才能安全重试；「命令已在跑、连接中途断了」重放会**重复执行**，`git push`/`npm publish`/`>> 追加写` 都会出事。这个区分做不干净的话，这一层的危害大于收益。

**词法层限制照旧**：这套只保证「沙盒还活着」，不保证沙盒里的命令做了什么。

## 6. env / 配置

仓库根 `.env`（`.env.template` 同步）：

- `SANDBOX_PROVIDER`（新增，可选，默认 `vercel`）：新建会话不带 `provider` 时的服务端默认。
- `E2B_API_KEY`：注释从「仅 examples/09」改为「examples/09 + chat 应用选 E2B 的会话」。
- `E2B_TEMPLATE`（可选，默认 `nimbo-chat-base`）：建 E2B 盒用哪个[沙盒模板](../../../terms.md)。**建盒时读**，改了下一个盒即生效；填 `base` 即退回 E2B 自带模板（512 MiB），是模板没构建时的逃生门。
- `E2B_TEMPLATE_MEMORY_MB`（可选，默认 `1024`）/ `E2B_TEMPLATE_CPU_COUNT`（可选，默认 `2`）：模板的资源规格。**只有构建脚本读**——E2B 不给建盒时设资源的机会，所以改完必须重跑 `e2b:template`，否则沙盒规格纹丝不动。非正整数直接抛错终止构建（不静默回退，见 §5）。
- `VERCEL_*` / `GITHUB_*`：不变。
