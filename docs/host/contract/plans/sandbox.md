---
title: "沙盒工作区（Sandbox Workspace）— 施工进展"
slug: sandbox
view: 施工
layer: 宿主层
module: 沙盒
packages: ["@nimbo/sandbox-e2b", "@nimbo/sandbox-vercel", "@nimbo/sandbox-cloudflare", "@nimbo/virtual-fs"]
tags: ["沙盒", "工作区", "NimboFS", "NimboExec", "适配器"]
related: ["host/contract/features/sandbox.md", "host/contract/tech/sandbox.md", "architecture/tech/agent-kernel.md"]
---
# 沙盒工作区（Sandbox Workspace）— 施工进展

> 相关：[产品与使用手册](../features/sandbox.md) · [技术方案](../tech/sandbox.md) · 依赖 [core-sdk 施工进展](../../../logic/engine/plans/core-sdk.md)（P0–P9，本功能的地基）
>
> 本页收拢[沙盒](../../../terms.md)功能的施工拆单、验收结论、阶段状态与变更记录，并保留源调研文档里的历史 banner、立项定案、实验记录与已知取舍。原始调研（三家调研 / 逐接口映射 / 网关协议）与真实项目端到端示例调研、沙盒规范原文（v1.5，2026-07-14）均已并入本功能三视角：契约与逐接口映射见 [tech/sandbox](../tech/sandbox.md)，端到端示例见 [features/sandbox](../features/sandbox.md)，立项定案 / 实验记录 / 已知取舍保留在本页。

## 历史 banner（来源文档状态）

- **docs/host/contract/tech/sandbox.md 云沙盒工作区适配调研**：状态 **已立项开工**（2026-07-11 用户 review 通过，定案见其 §8；§1–§7 为调研原文保留）。调研方法：三家 SDK 实际 d.ts（`e2b@2.32.0`、`@vercel/sandbox@2.5.0`、`@cloudflare/sandbox@0.12.3`，本地安装核对）+ 官方文档。
- **docs/host/contract/tech/sandbox.md 端到端示例调研（舒尔特方格项目）**：状态 **已立项开工**（2026-07-12 用户 review 通过，定案见其 §8；§1–§7 为调研原文保留）。目标场景：nimbo loop agent 连接 Vercel 沙盒，对用户的纯前端舒尔特方格游戏执行一次 frontend-design skill 驱动的设计优化，走完整 Git 工作流。
- **沙盒规范（原 nimbo-sandbox-spec，现并入 [tech/sandbox](../tech/sandbox.md)）**：状态 **v1.5**（2026-07-14）。规范化用词「必须 / 不得 / 应当 / 可以」。

## 阶段状态总览

| 阶段 | 内容 | 状态 |
|---|---|---|
| **P10** | 云沙盒工作区三接入包 `@nimbo/sandbox-{e2b,vercel,cloudflare}`（v1.2，用户立项 2026-07-11） | ✅ 完成（2026-07-12 收口；E2B/Vercel 真机已验证，Cloudflare 真机待用户部署网关后回填） |
| **P11** | 真实项目端到端示例：沙盒内设计优化 + Git 工作流（用户立项 2026-07-12） | ✅ 完成（2026-07-12 收口，真机段实跑通过并产出真实 PR） |

## P10 · 三接入包

**拆单**（P10-1/2/3 相互独立可并行；脚手架与 catalog 由主线程先行统一落地）：

- **P10-1 `@nimbo/sandbox-e2b`**：`e2bWorkspace(sandbox, opts?)` + fake 契约测试（FS 七方法 / exec / CommandExitError 结构转换 / 路径锚定 / glob）。
- **P10-2 `@nimbo/sandbox-vercel`**：`vercelWorkspace(sandbox, opts?)` + fake 契约测试（bash -lc 单参、Writable 桥接、ENOENT 归一、AbortController 超时 124）。
- **P10-3 `@nimbo/sandbox-cloudflare`**：`.` 客户端 + `./worker` 网关 + 协议两端进程内对接测试（fake fetch + fake `@cloudflare/sandbox` 表面）。
- **P10-4 集成收尾**：examples 09/10/11 + `examples/cloudflare-gateway/` wrangler 模板 + `.env.template` + README 五处 + docs/misc/plans/verification.md 验证方案追加 + 变更记录。

**依赖**：P0–P9（已全部完成）。

### 验收结论

- **P10-1（E2B，2026-07-11 验收通过）**：`packages/sandbox-e2b/src/{types,path,errors,fs,exec,workspace,index}.ts` + 3 测试文件 33 用例 + `test/type-conformance.ts`（typecheck-only：真实 e2b `Sandbox` 免转换满足 `E2bSandboxLike`）。验收：typecheck/test/build 三连全绿、硬规范 grep 零命中。**四项裁量（接受）**：① 真实 e2b `write()` 不接受裸 `Uint8Array`（仅 string/ArrayBuffer/Blob/Stream）——适配器做 Uint8Array→ArrayBuffer 拷贝转换（类型对照测试逼出的真坑）；② 取消语义「放弃等待」——不把 signal 传给远程 `commands.run()`，`raceAbort` 独立保证 124/130 及时返回，远程命令可能跑到自然结束；③ `E2bEntryInfo.type` 声明裸 `string`（单向宽化）；④ readdir 按 name 排序（对齐 MemoryFS）。
- **P10-2（Vercel，2026-07-11 验收通过）**：`packages/sandbox-vercel/src/{types,path,errors,fs,exec,index}.ts` + 3 测试文件 40 用例（fs 25/exec 13/e2e 2）+ `test/type-conformance.test-d.ts`（真实 `Sandbox` 赋 `VercelSandboxLike` 编译零调整）。**两处实测勘误已回填 docs/06**：非递归 `fs.rm` 对任意目录抛 `ERR_FS_EISDIR`（「原生对齐」证伪，按 stat 分流 rm/rmdir）；`@vercel/sandbox@2.5.0` 已有原生 `timeoutMs`（本地 AbortController 仍为 124 权威，远程透传兜底）。**四项裁量（接受）**：① Writable 单路收集（与 `stdout()` 同源，接口面更小）；② 越界语义解读——「不再模拟越界拒绝」仅指 bash，FS 七方法仍 normalizePath 拒 `..`；③ readdir 不逐条 stat（省 N 次 RTT）；④ describe() 不含需额外 RTT 的工具链探测。
- **P10-3（Cloudflare，2026-07-12 验收通过）**：`packages/sandbox-cloudflare/src/{protocol,worker,index}.ts` + 3 测试文件 48 用例 + `test/type-compat.ts`（真实 `ISandbox` 赋 `CfSandboxLike` 编译通过）。协议两端进程内对接测试覆盖二进制 0x00 往返、NDJSON 跨 chunk 边界、abort 传播、124、401/400/404/409/500 全错误面；worker.ts lines 100%。**关键确认**：二进制走 `readFile/writeFile` 的 `encoding:'base64'`（HTTP/WS transport 可用；`encoding:'none'` 裸流仅 RPC transport，弃用）。**五项裁量（接受）**：① 路径锚定=虚拟绝对路径去前导斜杠、沙盒默认 cwd（`/workspace`）充当虚拟根，不引入 root 配置（**已知副作用**：bash 脚本带前导 `/` 的绝对路径落真实根而非工作区，describe() 与 e2e 已声明「共享文件用相对路径」）；② 错误码补 `unauthorized/bad_request`；③ readdir wire 只传 name/type；④ symlink/other 归一 `"file"`；⑤ rm 空目录判定意外失败时降级继续尝试删除。
- **P10-4（集成收尾，2026-07-12 验收通过，P10 ✅ 收口）**：examples 09/10/11（各含零凭证 deterministic 段 + 凭证 gated 真机段）+ 三包 README + 根 README 包表三行/示例计数八→十一 + examples/README 三行 + docs/misc/plans/verification.md §2 用例 4-5/§3.1 三态矩阵/§4 基线。裁量（接受）：`examples/tsconfig.json` exclude `cloudflare-gateway`（独立 wrangler 项目被父 glob 误扫，必要修复）。

**P10-3 后全仓回归**（2026-07-12）：八包 build 16 产物 / typecheck 8 包 / **885 用例全绿**（core 331 / mini-bash 179 / virtual-fs 159 / just-bash 67 / sandbox-cloudflare 48 / sandbox-vercel 40 / sandbox-e2b 33 / sdk 28）。coverage lines 97.89%（门槛 ≥ 90%）。

### P10 真机验证

- **契约冒烟（2026-07-12 主线程亲测，用户授权凭证）**：examples 之外独立冒烟——scratchpad 脚本直连**真实** E2B microVM 与 Vercel Sandbox，对 `e2bWorkspace`/`vercelWorkspace` 逐条跑 20 项契约断言（FS 七方法含二进制 0x00 往返/mtime 抬升/glob/NotFoundError/DirectoryNotEmptyError、exec 含 P6-1 非零 resolve/onOutput 分片/stderr/timeoutMs→124 及时返回/bash 旁路写同源可见/describe/defaultApproval）。**两家均 20/20 全过**——fake 契约测试承载的全部假设经真机证实。**成本纪律**：创建均带 5min 超时保险 + try/finally kill()/stop()；收尾用 list API 审计——E2B 零残留；Vercel 用 `persistent:false` 并 `delete()` 清理意外遗留的持久快照，最终 `Sandbox.list()` 为 0。随手改进：examples/10 的 `Sandbox.create` 增加 `persistent:false`。
- **examples 09/10 真机段（2026-07-12 意外触发）**：P10-4 执行期间用户往 `examples/.env` 追加真实 `E2B_API_KEY`/`VERCEL_TOKEN`+`VERCEL_TEAM_ID`+`VERCEL_PROJECT_ID`（工单未触碰该文件），09/10 复测自然进入真机状态：真实创建 E2B/Vercel 沙盒，DeepSeek 真实驱动「写文件 + bash 验证」任务，`finalResponse` 与写入一致，`sandbox.kill()`/`sandbox.stop()` 正常收尾——两个适配器的真机路径均**真实验证通过**。
- **examples 11（Cloudflare）真机段**：**待用户部署网关后回填**——需自备 CF 环境（Workers Paid，用户决策是否开通），部署独立 workspace 成员 `apps/cloudflare-worker-server`（原 BYO 参考料 `examples/cloudflare-gateway-ref/` 已并入此项目，见 2026-07-20 变更记录），配好 secret `NIMBO_GATEWAY_TOKEN` 后其 `ALL /gateway/*` 路由即为对外网关端点；再填 `examples/.env.template` 「Cloudflare Sandbox gateway」节的 `NIMBO_CF_GATEWAY_URL`（需带 `/gateway` 前缀）与 `NIMBO_CF_GATEWAY_TOKEN`。确定性段（client→网关→fake 沙盒完整协议进程内往返）已实测通过。

**09–11 云沙盒适配器验证矩阵（三态 gate：模型 + 云凭证）**：

| 状态 | 触发条件 | 预期 | 结论 |
|---|---|---|---|
| A. 模型未配置 | 无 DeepSeek 等凭证 | 确定性段照常打印后指引退出 | ✅ |
| B. 模型已配置、云凭证未配置 | 缺 `E2B_API_KEY`/`VERCEL_*`/`NIMBO_CF_GATEWAY_*` | 确定性段打印（describe()/一次 exec()/一次文件读写），云凭证检查未过则指引 + 干净 `return`，全程不创建沙盒/不发起模型调用 | ✅ 三者首次实测通过 |
| C. 模型 + 云凭证齐全（真机） | 环境变量齐全 | 创建/连接真实云沙盒接入 `createSession`，模型写文件 + bash 验证，收尾 kill/stop | ✅ 09/10 真实通过；11 待网关部署 |

> ⚠️ **09–11 的验证要求与 01–08 相反**：01–08 回归前必须临时移开 `examples/.env`（`.env` 在场时「缺 env」模拟会失真并意外发起真实计费调用；此陷阱已被三次独立踩中）；09–11 恰恰**不移开** `.env`——真机段就是要用真实凭证跑通。

## P11 · 真实项目端到端示例：设计优化 + Git 工作流

**拆单**：

- **P11-1**（单工单）：`examples/12-vercel-sandbox-real-project.e2e.test.ts` 本体 + `.env.template` 三变量（主线程先行）+ examples/README/根 README 行 + docs/misc/plans/verification.md 用例行。离线段即时验证，真机段待 `GITHUB_PAT`/`GITHUB_REPO` 就位后执行。
- **P11-2 增强**（2026-07-12 主线程，用户两次追加指示）：真机段 `session.send()` → `session.stream()` + 手动 `.next()` 驱动（agent 执行实时打印）；新增 `examples/shared/transcript-store.ts`（零新依赖 `node:sqlite`，runs+events 两表，按 `(run_id, seq)` 序落库）。

**依赖**：P10（✅）。

### 验收结论

- **P11-1（2026-07-12 验收通过，P11 ✅）**：确定性段（URL 规范化纯函数自测 / 初始化命令清单 / `Skill.fromFS` 对 fake 装载）本工单实测通过；全仓 885 用例零回归（12 号未被 vitest 误收集实证）。**裁量与发现（接受）**：① `npx skills` 会在仓库根写 `skills-lock.json`（不在 `.agents`/`.skills` 下，逃过 `.git/info/exclude`）+ `next build` 重写 `next-env.d.ts`——两个无害连带文件进了 PR，docs/host/contract/tech/sandbox.md §2.3 排除范围未预见，**留待 PR review 人工处置，后续同类工单应把 `skills-lock.json` 加入 exclude**；② `loadEnvFile` 逻辑本地复制不新增 shared 耦合；③ 初始化命令只引用沙盒内 `$GH_TOKEN`，宿主字符串零 token 字面量。PR 未合并未关闭，待用户 review；PAT 用后建议 revoke。
- **DeepSeek 模型 id**：经唯一允许的只读端点 `GET {DEEPSEEK_API_BASE_URL}/models` 实测确认为 `deepseek-v4-pro`（清单仅两项：`deepseek-v4-flash`/`deepseek-v4-pro`），已设为本例默认值（`NIMBO_MODEL` 可覆盖）。

### P11 真机验证

- **P11-1 真机段（2026-07-12，意外触发但真实完整）**：本工单开工时 `examples/.env` 只有 DeepSeek + Vercel 三变量（无 `GITHUB_REPO`/`GITHUB_PAT`），预期停在状态 B；执行期间用户追加真实 `GITHUB_REPO=git@github.com:ludafa/Schulte-Grid.git`/`GITHUB_PAT`（工单全程未触碰该文件），复测进入四项 gate 全过的真机路径：`Sandbox.create` 真实克隆 `ludafa/Schulte-Grid`（`runtime:node24`/`persistent:false`）→ host 侧六步初始化全绿（`npx skills` 主路径装出 `frontend-design`，未触发 clone fallback；`git symbolic-ref` 探测默认分支 `main`）→ `Skill.fromFS` 装载真实官方 skill（name/description 与 anthropics/skills 一致）→ DeepSeek（`deepseek-v4-pro`）驱动 agent 读代码 → 一处聚焦设计优化（色彩体系粉→冷蓝青、网格单元格去阴影改描边、计时器 `tabular-nums`）→ `next build` 通过 → `git checkout -b nimbo/design-2026-07-12T03-18-01-631Z` → commit → push → `curl` 建 PR 成功；`finalResponse` 含改动清单 + 设计意图、分支名、PR 链接三项俱全；`sandbox.stop()` 正常收尾（`Sandbox.list()` 复核 `stopped`/`persistent:false`，无残留）。**PR 用 GitHub API 独立核实真实存在**：`https://github.com/ludafa/Schulte-Grid/pull/2`（`state: open`，`head: nimbo/design-2026-07-12T03-18-01-631Z`，`base: main`）——**真实、留在用户仓库待人工 review 的 PR，本工单未合并/关闭**。核实的真实 diff：`app/globals.css`（+19-19）、`components/schulte-grid.tsx`（+19-16）与 agent 回复改动清单一致；另两处无害连带改动：`next-env.d.ts`（+1-1，`next build` 自动重写）+ 新增 `skills-lock.json`（+11，`npx skills` 落仓库根未被 exclude 挡住）。
- **P11-2 增强真机段（2026-07-12，用户授权）**：`session.stream()` 实时驱动 + `transcript-store.ts` 落库自动验证通过——完整一轮 5.5 分钟，SQLite 落 1 run（completed）+ **9861 事件**（session.started 1 / turn 2 / item.started 81 / item.completed 95 / item.updated 9682），终块 usage 完整（inputTokens 989k）；产出真实 PR `ludafa/Schulte-Grid#4`；沙盒 finally 回收 + 主线程审计 delete 至 `Sandbox.list()` = 0。
- **未重测项说明**：状态 B（仍缺 `GITHUB_*`）未在一次干净 `.env` 下重新单独验证——复现需改动 `.env`，与硬性约束冲突；该 gate 是与 09/10/11 同构的简单早退分支，且本次真机运行已证明其前后 gate 在「已配置」一侧被正确执行到底，未在任何 gate 提前 return。

## 12 号真实项目端到端验证矩阵（四级 gate：模型 + GitHub 仓库 + PAT + Vercel 凭证）

| 状态 | 触发条件 | 预期 | 结论 |
|---|---|---|---|
| A. DeepSeek 未配置 | 无模型凭证 | 指引退出 | ✅ |
| B. DeepSeek 已配置，后三项任一缺失 | 缺 `GITHUB_REPO`/`GITHUB_PAT`/Vercel 三变量之一 | 确定性段打印后在对应 gate 指引 + 干净 `return`，`exit 0`，不创建沙盒/不发起模型调用 | 开工时真实状态；确定性段独立实测通过；后被用户追加凭证跨越，未在该确切留空组合下单独复测（见上「未重测项说明」） |
| C. 四项齐全（真机） | DeepSeek + `GITHUB_REPO` + `GITHUB_PAT` + 三个 `VERCEL_*` | git source 建沙盒 → 六步初始化 → `Skill.fromFS` 装真实 skill → 设计优化 + 完整 Git 工作流 → 开 PR → `finalResponse` 三项俱全 → `sandbox.stop()` | ✅ 真实验证通过，产出 `ludafa/Schulte-Grid#2` |

## 立项定案（施工依据）

### docs/host/contract/tech/sandbox.md §8 定案（2026-07-11 用户 review 结论）

用户裁定：**三家全做**。目标形态：agent（nimbo）跑在任意 Node 机器上，fs/bash 落在对应提供商的云沙盒里。真机验证延后——examples 留 `.env.template`，用户填凭证后触发（施工期先以进程内 fake 跑契约测试）。

对 §6 六项决策点的裁定：① 范围 = 三家（Cloudflare 走**网关形态**，因为「agent 跑在任意电脑」排除了 nimbo-on-Workers 形态）；② 三个独立包；③ 公共逻辑——`NotFoundError` 走 `instanceof`（类同一性硬约束），glob 工具（`globToRegExp`/`matchesGlob`/`normalizePath`）已是 `@nimbo/virtual-fs` 公共导出——三包直接把 `@nimbo/virtual-fs` 收为运行时依赖，不复制不另建 kit 包；④ BYO 实例维持（E2B/Vercel；CF client 是配置对象，无实例可 BYO）；⑤ 沙盒过期 v1 = 报错指导。

**依赖策略**：E2B/Vercel 适配器不在运行时 import provider SDK，只 `import type` 并对实际触碰的方法面定义结构化子集接口（`E2bSandboxLike`/`VercelSandboxLike`）；错误识别一律结构判别不用 `instanceof`；`e2b`/`@vercel/sandbox` 只进 devDependencies。`@nimbo/sandbox-cloudflare` 客户端连类型依赖都没有（纯 fetch 协议），其 `./worker` 子路径把 `@cloudflare/sandbox` 声明为 peerDependency。

### docs/host/contract/tech/sandbox.md §8 定案（2026-07-12 用户 review 结论）

§6 六项决策全部落定：① **认证** v1 用 fine-grained PAT（权限：仅目标仓库 Contents RW + Pull requests RW + Metadata Read；建议短有效期、跑完 revoke）；② **环境变量** `GITHUB_PAT`（用户线下签发）；③ **仓库** `GITHUB_REPO`，用户提供 SSH 格式，example 必须做 **SSH→HTTPS 规范化**（clone 与 push remote 均用 HTTPS+PAT；两种格式都接受，解析失败给指导性报错）；部署走 Git 集成主路径（PR 后人工在 Vercel 确认 preview，agent 汇总只给 PR 链接不承诺部署 URL）；④ **模型** DeepSeek 直连，本例默认用 deepseek v4 pro 档（设计任务用更强档位，`NIMBO_MODEL` 可覆盖）；⑤ **审批门** 不加（bash 维持沙盒实现 `defaultApproval`，隔离即边界）；⑥ **文件名** `examples/12-vercel-sandbox-real-project.e2e.test.ts`（node 直跑，root vitest 只收 `packages/*`，`.test.ts` 后缀不会被误收集）。

## 已知取舍与观察项（保留）

- **Cloudflare v1 网关形态、需 Workers Paid**（无免费层）；真机验证待用户部署网关后回填。触发重评 nimbo-on-Workers 直连的条件：官方开放外部访问通道，或 nimbo 决定支持 edge runtime。
- **`skills-lock.json` 逃过 exclude**：`npx skills` 在仓库根写清单文件，不在 `.agents`/`.skills` 下，被 `git add -A` 一并提交；docs/host/contract/tech/sandbox.md §2.3 排除范围未预见，后续同类工单应补进 `.git/info/exclude`。
- **bash 绝对路径 vs FS 锚定路径不同源**：三家通用现象（E2B `/home/user`、Vercel `/vercel/sandbox`、CF `/workspace`），属「真实 FS + root 锚定」固有语义，模式 A 的 bash 旁路本就不产生 `file_change`；三包 README 统一披露「共享文件用相对路径」。
- **PAT 对模型可见**（env + remote URL，bash 可读）：fine-grained 单仓库 + 短有效期是够用缓解；根治靠 GitHub App 1h token（v2）。demo 场景风险可控，README 如实声明。
- **审批默认值已随全局审批 API 重构**：`defaultApproval` 由旧 `"never"` 改为三值语义的 `"allow"`（P13-5-2c，见 docs/10）——本功能文档以当前代码为准，[技术方案](../tech/sandbox.md) §3 有映射说明。

## 变更记录

| 日期 | 阶段 / 执行者 | 变更 | 结论 |
|---|---|---|---|
| 2026-07-11 | P10 开工（用户立项，docs/host/contract/tech/sandbox.md §8 定案） | 三沙盒接入包；provider SDK 仅类型依赖；CF 网关形态；真机验证待用户凭证（.env.template 先行） | — |
| 2026-07-11 | P10-1 coder | `@nimbo/sandbox-e2b` + 33 用例 + 四项裁量 | 验收通过 |
| 2026-07-11 | P10-2 coder | `@nimbo/sandbox-vercel` + 40 用例 + 两处实测勘误回填 06 + 四项裁量 | 验收通过 |
| 2026-07-12 | P10-3 coder | `@nimbo/sandbox-cloudflare` 客户端 + 网关 + 48 用例 + 五项裁量 | 验收通过；全仓回归 885 用例全绿 |
| 2026-07-12 | P10-4 coder（亲自执行） | examples 09/10/11 + wrangler 模板 + README 五处 + docs/misc/plans/verification.md 三态矩阵 + 基线 72 文件 885 用例 lines 97.89% | 全部通过含真机部分；用户追加 E2B/Vercel 凭证，09/10 真机段意外触发并通过；11 待网关部署 |
| 2026-07-12 | P10 真机契约冒烟（主线程，亲自执行） | scratchpad 脚本直连真实 E2B/Vercel，逐条 20 项契约断言 | 两家 20/20 全过；成本纪律双确认零残留 |
| 2026-07-12 | P11 开工（用户立项，docs/host/contract/tech/sandbox.md §8 定案） | 真实项目设计优化 e2e 示例；PAT v1 / npx skills+fromFS / Git 集成部署 / DeepSeek v4 pro / 无审批门 | — |
| 2026-07-12 | P11-1 coder（亲自执行） | `examples/12-vercel-sandbox-real-project.e2e.test.ts` + 用例 4-6 + §3.2 四态矩阵 | 全部通过含真机部分；真实克隆 ludafa/Schulte-Grid → 设计优化 → 真实 PR #2；沙盒 stop 回收至 list()=0 |
| 2026-07-19 | 主线程（用户提问触发重构） | 把 Cloudflare 网关从「可部署模板」重新定性为 example 11 的 **BYO 参考料**：`examples/cloudflare-gateway/` → `examples/cloudflare-gateway-ref/`，删掉 `package.json`/`tsconfig.json`（连带 `file:..` 自引用）、扁平化 `src/index.ts`→`index.ts`，README 改写为「自备 CF 环境、拷进你自己的 wrangler 项目部署」；同步 examples/包 README、11 号脚本注释、tsconfig/pnpm-workspace、docs features·tech·plan 全部引用 | 定性澄清：包对外交付且被测的是纯函数 `createSandboxGateway`（`./worker`），wrapper 只是测不了的 BYO 连接料，不由包发布/维护；包自足测试能力（约 48 用例，零 wrangler/真机）不受影响 |
| 2026-07-12 | P11-2 主线程（用户两次追加指示） | 真机段 `session.stream()` 实时驱动 + `examples/shared/transcript-store.ts`（node:sqlite 零新依赖） | 真机自动验证通过：一轮 5.5min，SQLite 9861 事件，真实 PR #4，回收至 list()=0 |
| 2026-07-20 | 主线程 | 上一条（2026-07-19）「BYO 参考料」定性被取代：`examples/cloudflare-gateway-ref/` 已删除，能力整体并入独立 workspace 成员 `apps/cloudflare-worker-server`（原是一个 SPIKE 性质的探针项目，现已转正为正式示例并随之更名，去掉 SPIKE 定性）——同一 Worker 同时扮演「进程内直连驱动真实 CF Sandbox」与「对外 BYO 网关端点 `ALL /gateway/*`」两个角色，共用同一套 `getSandbox` 接线；顺带用 `stripAbortSignal` 修掉 `AbortSignal` 跨不过 Durable Object RPC 边界导致真机报错的缺陷 | 现状见 [tech/examples §6](../../../misc/tech/examples.md)；该 app 自己的三份文档：[features](../../cloudflare/features/cloudflare-worker-server.md)·[tech](../../cloudflare/tech/cloudflare-worker-server.md)·[plans](../../cloudflare/plans/cloudflare-worker-server.md) |

## 施工基线（当前）

- **测试**：全包 vitest 72 文件 885 用例（新增 sandbox 三包 9 文件 121 用例：e2b 3/33、vercel 3/40、cloudflare 3/48）。
- **覆盖率**：根聚合 lines 97.89%（门槛 ≥ 90%）。
- **真机产物**：`ludafa/Schulte-Grid#2`（P11-1）、`#4`（P11-2），均 open、留用户 review。
